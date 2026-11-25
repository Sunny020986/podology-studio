// Список очікування. Якщо на обрану дату немає вільного часу, клієнт лишає заявку.
// Коли час звільняється (скасування, перенесення), бот повідомляє першого в черзі на цю дату.
// Якщо в клієнта немає Telegram, повідомлення отримує майстер, щоб зателефонувати самому.
const crypto = require('crypto');

const NEXT_AFTER_MS = 2 * 60 * 60 * 1000; // якщо час досі вільний через 2 год після сповіщення, повідомляємо наступного
const MAX_PER_PHONE = 3;                    // активних заявок на один телефон
const CHECK_EVERY_MS = 5 * 60 * 1000;

function createWaitlistTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id  INTEGER NOT NULL REFERENCES services(id),
      date        TEXT NOT NULL,
      name        TEXT NOT NULL,
      phone       TEXT NOT NULL,
      code        TEXT NOT NULL UNIQUE,
      tg_chat_id  TEXT,
      status      TEXT NOT NULL DEFAULT 'waiting',  -- waiting, notified, removed, expired
      notified_at INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_waitlist_date ON waitlist(date, status);
  `);
}

function setupWaitlist({ app, db, telegram, freeSlots, isBookableDate, horizonDays, todayStr, siteUrl, makeLimiter, last9 }) {
  const limiter = makeLimiter(5, 60 * 60 * 1000);
  const fmt = (d) => d.split('-').reverse().join('.');

  app.post('/api/waitlist', (req, res) => {
    const { serviceId, date } = req.body || {};
    const masterId = Number.isInteger(Number(req.body?.masterId)) && Number(req.body.masterId) > 0 ? Number(req.body.masterId) : null;
    const name = String(req.body?.name ?? '').trim();
    const phone = String(req.body?.phone ?? '').trim();
    const service = db.prepare('SELECT id, name FROM services WHERE id = ? AND active = 1').get(Number(serviceId));
    if (!service) return res.status(400).json({ error: 'Невідома послуга' });
    if (!isBookableDate(date, horizonDays)) return res.status(400).json({ error: 'Некоректна дата' });
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "Вкажіть ім'я (від 2 до 60 символів)" });
    const digits = phone.replace(/\D/g, '');
    if (!/^\+?[\d\s()-]+$/.test(phone) || digits.length < 9 || digits.length > 15) return res.status(400).json({ error: 'Вкажіть коректний телефон' });
    if (limiter.blocked(req.ip)) return res.status(429).json({ error: 'Забагато заявок. Спробуйте пізніше або напишіть оператору' });
    const mine = db.prepare("SELECT phone, service_id, date FROM waitlist WHERE status = 'waiting' AND date >= ?").all(todayStr())
      .filter((w) => last9(w.phone) === last9(phone));
    if (mine.some((w) => w.service_id === service.id && w.date === date)) return res.status(409).json({ error: 'Ви вже в списку очікування на цю дату' });
    if (mine.length >= MAX_PER_PHONE) return res.status(429).json({ error: `Можна мати не більше ${MAX_PER_PHONE} заявок одночасно` });
    limiter.hit(req.ip);
    const code = crypto.randomBytes(8).toString('base64url');
    db.prepare('INSERT INTO waitlist (service_id, date, name, phone, code, master_id) VALUES (?, ?, ?, ?, ?, ?)').run(service.id, date, name, phone, code, masterId);
    telegram.notifyMaster(`⏳ Новий запит у списку очікування\n${service.name}, ${fmt(date)}\n${name}, ${phone}`);
    res.status(201).json({ ok: true, telegramLink: telegram.remindLink(`w_${code}`) });
  });

  // Клієнт натиснув посилання в боті: прив'язуємо його чат до заявки
  function linkTelegram(code, chatId) {
    const w = db.prepare(`SELECT w.*, s.name AS service FROM waitlist w JOIN services s ON s.id = w.service_id WHERE w.code = ?`).get(code);
    if (!w || w.status !== 'waiting') return 'Цю заявку вже не знайдено. Перевірте вільний час на сайті.';
    db.prepare('UPDATE waitlist SET tg_chat_id = ? WHERE id = ?').run(chatId, w.id);
    return `✅ Готово! Щойно на ${fmt(w.date)} звільниться час для «${w.service}», ми напишемо сюди.`;
  }

  // Перевірка: чи звільнився час для когось у черзі
  async function checkWaitlist() {
    const today = todayStr();
    db.prepare("UPDATE waitlist SET status = 'expired' WHERE status IN ('waiting', 'notified') AND date < ?").run(today);
    const dates = db.prepare("SELECT DISTINCT date FROM waitlist WHERE status = 'waiting' AND date >= ? ORDER BY date").all(today);
    const base = siteUrl();
    for (const { date } of dates) {
      const recent = db.prepare("SELECT MAX(notified_at) AS t FROM waitlist WHERE date = ? AND status = 'notified'").get(date).t;
      if (recent && Date.now() - recent < NEXT_AFTER_MS) continue; // попередній у черзі ще має час записатися
      const queue = db.prepare(`SELECT w.*, s.name AS service, s.duration_min FROM waitlist w JOIN services s ON s.id = w.service_id
        WHERE w.date = ? AND w.status = 'waiting' ORDER BY w.id`).all(date);
      const first = queue.find((w) => freeSlots(db, date, w.duration_min, { masterId: w.master_id, serviceId: w.service_id, client: true }).length > 0);
      if (!first) continue;
      db.prepare("UPDATE waitlist SET status = 'notified', notified_at = ? WHERE id = ?").run(Date.now(), first.id);
      const where = base ? `${base.replace(/\/+$/, '')}/#booking` : 'на сайті';
      if (first.tg_chat_id) {
        await telegram.sendToClient(first.tg_chat_id,
          `🔔 Звільнився час на ${fmt(date)} для «${first.service}»! Встигніть записатися: ${where}`);
      } else {
        telegram.notifyMaster(`🔔 Звільнився час на ${fmt(date)} («${first.service}»). У списку очікування: ${first.name}, ${first.phone}. ` +
          'Telegram не підключено, зателефонуйте клієнту.');
      }
    }
  }
  setInterval(() => checkWaitlist().catch((e) => console.error('Список очікування:', e.message)), CHECK_EVERY_MS).unref();

  // ----- Адмінка (маршрути реєструються після перевірки доступу адміна) -----
  app.get('/api/admin/waitlist', (req, res) => {
    // Майстер бачить заявки до себе і заявки «до будь-кого»
    const mine = req.role === 'master' ? req.masterId : null;
    res.json(db.prepare(`SELECT w.id, w.date, w.name, w.phone, w.status, (w.tg_chat_id IS NOT NULL) AS telegram, s.name AS service,
        w.master_id, m.name AS master
      FROM waitlist w JOIN services s ON s.id = w.service_id LEFT JOIN masters m ON m.id = w.master_id
      WHERE w.status IN ('waiting', 'notified') AND w.date >= ? AND (? IS NULL OR w.master_id IS NULL OR w.master_id = ?)
      ORDER BY w.date, w.id`).all(todayStr(), mine, mine));
  });
  app.delete('/api/admin/waitlist/:id', (req, res) => {
    if (req.role === 'master') db.prepare("UPDATE waitlist SET status = 'removed' WHERE id = ? AND master_id = ?").run(Number(req.params.id), req.masterId);
    else db.prepare("UPDATE waitlist SET status = 'removed' WHERE id = ?").run(Number(req.params.id));
    res.json({ ok: true });
  });

  return { linkTelegram, checkWaitlist };
}

module.exports = { createWaitlistTable, setupWaitlist };
