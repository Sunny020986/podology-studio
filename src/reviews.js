// Відгуки клієнтів. Наступного дня після візиту бот надсилає клієнту посилання на коротку форму відгуку.
// Новий відгук чекає на схвалення майстра в адмінці; на сайті видно лише схвалені.
const crypto = require('crypto');

const ASK_WITHIN_DAYS = 7;          // про відгук питаємо не пізніше ніж через стільки днів після візиту
const ASK_FROM_HOUR = 10;           // повідомлення надсилаються лише вдень, з 10:00 до 20:00
const ASK_TO_HOUR = 20;
const TEXT_MAX = 1000;
const STATUSES = ['pending', 'approved', 'hidden'];
const isCode = (c) => /^[A-Za-z0-9_-]{8,40}$/.test(String(c));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Клієнт';

function createReviewTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id INTEGER UNIQUE REFERENCES appointments(id) ON DELETE SET NULL,
      name           TEXT NOT NULL,
      service        TEXT NOT NULL DEFAULT '',
      rating         INTEGER NOT NULL,
      text           TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL DEFAULT 'pending',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const cols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  if (!cols.includes('review_code')) db.exec('ALTER TABLE appointments ADD COLUMN review_code TEXT');
  if (!cols.includes('review_asked')) db.exec('ALTER TABLE appointments ADD COLUMN review_asked INTEGER NOT NULL DEFAULT 0');
}

function setupReviews({ app, db, telegram, todayStr, siteUrl, last9 }) {
  const apptByCode = (code) => db.prepare(`SELECT a.*, COALESCE(a.services_label, s.name) AS service FROM appointments a
    JOIN services s ON s.id = a.service_id WHERE a.review_code = ?`).get(code);

  function ensureCode(a) {
    if (a.review_code) return a.review_code;
    const code = crypto.randomBytes(9).toString('base64url');
    db.prepare('UPDATE appointments SET review_code = ? WHERE id = ?').run(code, a.id);
    return code;
  }
  const linkFor = (code) => {
    const base = siteUrl();
    return base ? `${base.replace(/\/+$/, '')}/review.html?c=${code}` : null;
  };
  // Куди писати клієнту: чат із нагадування про запис або чат, прив'язаний до його кабінету
  const chatFor = (a) => a.tg_chat_id
    || db.prepare('SELECT tg_chat_id FROM accounts WHERE phone_key = ?').get(last9(a.client_phone))?.tg_chat_id
    || null;

  async function sendReviewRequests() {
    const hour = new Date().getHours();
    if (hour < ASK_FROM_HOUR || hour >= ASK_TO_HOUR || !siteUrl()) return;
    const rows = db.prepare(`SELECT a.*, COALESCE(a.services_label, s.name) AS service FROM appointments a JOIN services s ON s.id = a.service_id
      WHERE a.status NOT IN ('cancelled', 'no_show') AND a.review_asked = 0 AND a.date < ? AND a.date >= date(?, '-${ASK_WITHIN_DAYS} day')
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id)`).all(todayStr(), todayStr());
    for (const a of rows) {
      const chat = chatFor(a);
      if (!chat) continue;
      const link = linkFor(ensureCode(a));
      if (!link) return;
      db.prepare('UPDATE appointments SET review_asked = 1 WHERE id = ?').run(a.id); // спершу позначка: двічі не питаємо
      await telegram.sendToClient(chat,
        `⭐ Дякуємо, що були у нас! Як вам візит (${a.service})?\n` +
        `Будемо вдячні за короткий відгук, це займе хвилину: ${link}`);
    }
  }
  setInterval(() => sendReviewRequests().catch((e) => console.error('Відгуки:', e.message)), 30 * 60 * 1000).unref();
  setTimeout(() => sendReviewRequests().catch(() => {}), 20000).unref();

  // ----- Форма відгуку для клієнта -----
  app.get('/api/review/:code', (req, res) => {
    if (!isCode(req.params.code)) return res.status(404).json({ error: 'Посилання недійсне' });
    const a = apptByCode(req.params.code);
    if (!a) return res.status(404).json({ error: 'Посилання недійсне або застаріле' });
    const done = !!db.prepare('SELECT 1 FROM reviews WHERE appointment_id = ?').get(a.id);
    res.json({ name: firstName(a.client_name), service: a.service, date: a.date, done });
  });

  app.post('/api/review/:code', (req, res) => {
    if (!isCode(req.params.code)) return res.status(404).json({ error: 'Посилання недійсне' });
    const a = apptByCode(req.params.code);
    if (!a) return res.status(404).json({ error: 'Посилання недійсне або застаріле' });
    if (a.status === 'cancelled') return res.status(400).json({ error: 'Цей запис скасовано' });
    if (a.status === 'no_show') return res.status(400).json({ error: 'Цей візит не відбувся' });
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Оберіть оцінку від 1 до 5 зірок' });
    const text = String(req.body?.text ?? '').trim().slice(0, TEXT_MAX);
    if (db.prepare('SELECT 1 FROM reviews WHERE appointment_id = ?').get(a.id)) {
      return res.status(409).json({ error: 'Ви вже залишили відгук про цей візит. Дякуємо!' });
    }
    const name = firstName(a.client_name);
    db.prepare('INSERT INTO reviews (appointment_id, name, service, rating, text) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, name, a.service, rating, text);
    telegram.notifyMaster(`⭐ Новий відгук: ${rating} з 5\n${a.service}\n${name}${text ? ': ' + text : ''}\n` +
      'Схваліть його в адмінці, вкладка «Відгуки», щоб він з\'явився на сайті.');
    res.status(201).json({ ok: true });
  });

  // ----- Схвалені відгуки на сайті -----
  app.get('/api/reviews', (req, res) => {
    res.json(db.prepare(`SELECT name, service, rating, text, date(created_at) AS date FROM reviews
      WHERE status = 'approved' ORDER BY created_at DESC LIMIT 12`).all());
  });

  // ----- Адмінка (маршрути реєструються після перевірки доступу адміна) -----
  app.get('/api/admin/reviews', (req, res) => {
    res.json(db.prepare(`SELECT id, name, service, rating, text, status, date(created_at) AS date
      FROM reviews ORDER BY created_at DESC`).all());
  });
  app.patch('/api/admin/reviews/:id', (req, res) => {
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Некоректний статус' });
    const n = db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, Number(req.params.id)).changes;
    if (!n) return res.status(404).json({ error: 'Відгук не знайдено' });
    res.json({ ok: true });
  });
  app.delete('/api/admin/reviews/:id', (req, res) => {
    db.prepare('DELETE FROM reviews WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });
  // Посилання на форму відгуку для запису: майстер може надіслати його клієнту сам (наприклад, у Viber)
  app.get('/api/admin/appointments/:id/review-link', (req, res) => {
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(req.params.id));
    if (!a) return res.status(404).json({ error: 'Запис не знайдено' });
    if (req.role === 'master' && a.master_id !== req.masterId) return res.status(403).json({ error: 'Це запис іншого майстра' });
    const link = linkFor(ensureCode(a));
    if (!link) return res.status(400).json({ error: 'Спершу вкажіть адресу сайту в адмінці, вкладка «Кабінет»' });
    res.json({ link });
  });

  return { sendReviewRequests };
}

module.exports = { createReviewTables, setupReviews };
