// Особистий кабінет клієнта: реєстрація за номером і паролем, вхід, записи, скасування і перенесення,
// прив'язка Telegram-бота і відновлення пароля. Реєстрація необов'язкова: запис без неї працює як раніше.
const crypto = require('crypto');

const SESSION_DAYS = 30;
const RESET_MINUTES = 10;
const LINK_MINUTES = 15;
const CHANGE_HOUR_OPTIONS = [2, 6, 12, 24, 48]; // скільки годин до візиту клієнт може скасувати чи перенести сам (вибирає майстер в адмінці)
const MAX_CODE_TRIES = 5;

const last9 = (phone) => String(phone).replace(/\D/g, '').slice(-9);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64);
  const want = Buffer.from(hash, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}

function createAccountTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT NOT NULL,
      phone_key   TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      pass_hash   TEXT NOT NULL,
      tg_chat_id  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash  TEXT PRIMARY KEY,
      account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at  INTEGER NOT NULL
    );
    -- одноразові коди: прив'язка Telegram (kind = link) і відновлення пароля (kind = reset)
    CREATE TABLE IF NOT EXISTS account_codes (
      kind        TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (kind, key)
    );
  `);
}

function setupAccounts({ app, db, telegram, freeSlots, todayStr, isBookableDate, isTime, horizonDays, makeLimiter, notifyMaster, changeHours, notifyMasterOf = () => {}, live = () => {} }) {
  const loginLimiter = makeLimiter(10, 15 * 60 * 1000);
  const resetLimiter = makeLimiter(5, 60 * 60 * 1000);

  const cookieOf = (req) => {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)acc=([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  };
  const setCookie = (res, token) =>
    res.setHeader('Set-Cookie', `acc=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  const clearCookie = (res) => res.setHeader('Set-Cookie', 'acc=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');

  function openSession(res, accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO account_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
      .run(sha(token), accountId, Date.now() + SESSION_DAYS * 86400 * 1000);
    setCookie(res, token);
  }

  function accountFromRequest(req) {
    const token = cookieOf(req);
    if (!token) return null;
    const row = db.prepare(`SELECT a.* FROM account_sessions s JOIN accounts a ON a.id = s.account_id
                            WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(token), Date.now());
    return row || null;
  }

  function requireAccount(req, res, next) {
    const acc = accountFromRequest(req);
    if (!acc) return res.status(401).json({ error: 'Увійдіть в кабінет' });
    req.account = acc;
    next();
  }

  // Час до візиту в годинах; від'ємний, якщо візит уже минув
  const hoursUntil = (date, time) => (new Date(`${date}T${time}:00`).getTime() - Date.now()) / 3600000;
  const canChange = (a) => a.status !== 'cancelled' && hoursUntil(a.date, a.start_time) >= changeHours();

  const accountPhoneAppts = (acc) => db.prepare(`
      SELECT a.id, a.date, a.start_time, a.end_time, a.client_phone, a.status, a.master_id, m.name AS master, s.id AS service_id, s.name AS service, s.duration_min
      FROM appointments a JOIN services s ON s.id = a.service_id LEFT JOIN masters m ON m.id = a.master_id ORDER BY a.date DESC, a.start_time DESC`)
    .all().filter((a) => last9(a.client_phone) === last9(acc.phone));

  const ownAppt = (acc, id) => accountPhoneAppts(acc).find((a) => a.id === id);

  // ----- Реєстрація, вхід, вихід -----
  app.post('/api/account/register', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const phone = String(req.body?.phone ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "Вкажіть ім'я (від 2 до 60 символів)" });
    const digits = phone.replace(/\D/g, '');
    if (!/^\+?[\d\s()-]+$/.test(phone) || digits.length < 9 || digits.length > 15) return res.status(400).json({ error: 'Вкажіть коректний телефон' });
    if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Пароль: від 8 до 100 символів' });
    const key = last9(phone);
    if (db.prepare('SELECT 1 FROM accounts WHERE phone_key = ?').get(key)) {
      return res.status(409).json({ error: 'Такий номер уже зареєстровано. Увійдіть або відновіть пароль' });
    }
    const info = db.prepare('INSERT INTO accounts (phone, phone_key, name, pass_hash) VALUES (?, ?, ?, ?)')
      .run(phone, key, name, hashPassword(password));
    openSession(res, Number(info.lastInsertRowid));
    res.status(201).json({ name, phone, telegram: false });
  });

  app.post('/api/account/login', (req, res) => {
    if (loginLimiter.blocked(req.ip)) {
      return res.status(429).json({ error: `Забагато спроб входу. Спробуйте через ${loginLimiter.minutesLeft(req.ip)} хв` });
    }
    const acc = db.prepare('SELECT * FROM accounts WHERE phone_key = ?').get(last9(req.body?.phone ?? ''));
    if (!acc || !checkPassword(String(req.body?.password ?? ''), acc.pass_hash)) {
      loginLimiter.hit(req.ip);
      return res.status(401).json({ error: 'Невірний номер або пароль' });
    }
    openSession(res, acc.id);
    res.json({ name: acc.name, phone: acc.phone, telegram: !!acc.tg_chat_id });
  });

  app.post('/api/account/logout', (req, res) => {
    const token = cookieOf(req);
    if (token) db.prepare('DELETE FROM account_sessions WHERE token_hash = ?').run(sha(token));
    clearCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/account/me', (req, res) => {
    const acc = accountFromRequest(req);
    if (!acc) return res.status(401).json({ error: 'Увійдіть в кабінет' });
    res.json({ name: acc.name, phone: acc.phone, telegram: !!acc.tg_chat_id });
  });

  // ----- Записи клієнта -----
  app.get('/api/account/appointments', requireAccount, (req, res) => {
    const today = todayStr();
    res.json(accountPhoneAppts(req.account).map((a) => ({
      id: a.id, service_id: a.service_id, master_id: a.master_id, master: a.master || '', date: a.date, start_time: a.start_time, end_time: a.end_time, status: a.status,
      service: a.service, upcoming: a.date >= today && a.status !== 'cancelled', canChange: canChange(a),
    })));
  });

  app.post('/api/account/appointments/:id/cancel', requireAccount, (req, res) => {
    const a = ownAppt(req.account, Number(req.params.id));
    if (!a) return res.status(404).json({ error: 'Запис не знайдено' });
    if (a.status === 'cancelled') return res.status(409).json({ error: 'Запис уже скасовано' });
    if (!canChange(a)) return res.status(403).json({ error: `Скасувати можна не пізніше ніж за ${changeHours()} год до візиту. Напишіть оператору в чат` });
    db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(a.id);
    live('cancelled', { ...a, client_name: req.account.name }); // адмінка наживо
    notifyMaster(`❌ Клієнт скасував запис\n${a.service}\n${a.date.split('-').reverse().join('.')} о ${a.start_time}\n${req.account.name}, ${req.account.phone}`);
    notifyMasterOf(a.master_id, `❌ Клієнт скасував запис до вас\n${a.service}\n${a.date.split('-').reverse().join('.')} о ${a.start_time}\n${req.account.name}, ${req.account.phone}`);
    res.json({ ok: true });
  });

  app.post('/api/account/appointments/:id/reschedule', requireAccount, (req, res) => {
    const a = ownAppt(req.account, Number(req.params.id));
    if (!a) return res.status(404).json({ error: 'Запис не знайдено' });
    if (!canChange(a)) return res.status(403).json({ error: `Перенести можна не пізніше ніж за ${changeHours()} год до візиту. Напишіть оператору в чат` });
    const { date, time } = req.body || {};
    if (!isBookableDate(date, horizonDays)) return res.status(400).json({ error: 'Некоректна дата' });
    if (!isTime(time)) return res.status(400).json({ error: 'Некоректний час' });
    // Перенесення до того самого майстра; власний запис не рахується як зайнятий
    const free = freeSlots(db, date, a.duration_min, { masterId: a.master_id, excludeId: a.id });
    if (!free.includes(time)) return res.status(409).json({ error: 'Цей час уже недоступний, оберіть інший' });
    const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    const endMin = toMinutes(time) + a.duration_min;
    const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    db.prepare('UPDATE appointments SET date = ?, start_time = ?, end_time = ?, reminded = 0 WHERE id = ?').run(date, time, end, a.id);
    live('moved', { ...a, date, start_time: time, client_name: req.account.name }); // адмінка наживо
    notifyMaster(`🔁 Клієнт переніс запис\n${a.service}\n${date.split('-').reverse().join('.')} о ${time}\n${req.account.name}, ${req.account.phone}`);
    notifyMasterOf(a.master_id, `🔁 Клієнт переніс запис до вас\n${a.service}\n${date.split('-').reverse().join('.')} о ${time}\n${req.account.name}, ${req.account.phone}`);
    res.json({ ok: true, date, time });
  });

  // ----- Telegram: прив'язка акаунта до бота -----
  app.post('/api/account/telegram/link', requireAccount, (req, res) => {
    const code = crypto.randomBytes(6).toString('base64url');
    db.prepare("INSERT INTO account_codes (kind, key, value, expires_at) VALUES ('link', ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
      .run(sha(code), String(req.account.id), Date.now() + LINK_MINUTES * 60000);
    const link = telegram.remindLink(`acc_${code}`);
    if (!link) return res.status(503).json({ error: 'Бот Telegram ще не налаштований. Напишіть оператору в чат' });
    res.json({ link, minutes: LINK_MINUTES });
  });

  app.post('/api/account/telegram/unlink', requireAccount, (req, res) => {
    db.prepare('UPDATE accounts SET tg_chat_id = NULL WHERE id = ?').run(req.account.id);
    res.json({ ok: true });
  });

  // Викликається з боту, коли клієнт натиснув посилання з кодом
  function linkTelegram(code, chatId) {
    const row = db.prepare("SELECT value, expires_at FROM account_codes WHERE kind = 'link' AND key = ?").get(sha(code));
    if (!row || row.expires_at < Date.now()) return 'Посилання застаріло. Згенеруйте нове в особистому кабінеті на сайті.';
    db.prepare("DELETE FROM account_codes WHERE kind = 'link' AND key = ?").run(sha(code));
    db.prepare('UPDATE accounts SET tg_chat_id = ? WHERE id = ?').run(chatId, Number(row.value));
    return '✅ Готово! Тепер ви можете входити на сайт через цей бот. Нагадування про записи надходитимуть сюди.';
  }

  // ----- Відновлення пароля -----
  // Відповідь однакова незалежно від того, чи є такий номер: нікого не можна перевірити так
  app.post('/api/account/reset/request', (req, res) => {
    if (resetLimiter.blocked(req.ip)) return res.status(429).json({ error: 'Забагато запитів. Спробуйте пізніше або напишіть оператору' });
    resetLimiter.hit(req.ip);
    const key = last9(req.body?.phone ?? '');
    const acc = db.prepare('SELECT * FROM accounts WHERE phone_key = ?').get(key);
    if (acc?.tg_chat_id) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      db.prepare("INSERT INTO account_codes (kind, key, value, expires_at, attempts) VALUES ('reset', ?, ?, ?, 0) ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, attempts = 0")
        .run(key, sha(code), Date.now() + RESET_MINUTES * 60000);
      telegram.sendToClient(acc.tg_chat_id, `Код для відновлення пароля: ${code}\nДійсний ${RESET_MINUTES} хв. Якщо це не ви, просто проігноруйте це повідомлення.`);
    }
    res.json({ ok: true, message: 'Якщо акаунт прив\'язаний до Telegram, код надійде в бот. Інакше напишіть оператору в чат.' });
  });

  app.post('/api/account/reset/confirm', (req, res) => {
    const key = last9(req.body?.phone ?? '');
    const code = String(req.body?.code ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Пароль: від 8 до 100 символів' });
    const row = db.prepare("SELECT * FROM account_codes WHERE kind = 'reset' AND key = ?").get(key);
    if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'Код прострочено. Запросіть новий' });
    if (row.attempts >= MAX_CODE_TRIES) return res.status(429).json({ error: 'Забагато помилкових кодів. Запросіть новий' });
    if (sha(code) !== row.value) {
      db.prepare("UPDATE account_codes SET attempts = attempts + 1 WHERE kind = 'reset' AND key = ?").run(key);
      return res.status(400).json({ error: 'Невірний код' });
    }
    const acc = db.prepare('SELECT id FROM accounts WHERE phone_key = ?').get(key);
    if (!acc) return res.status(400).json({ error: 'Невірний код' });
    db.transaction(() => {
      db.prepare('UPDATE accounts SET pass_hash = ? WHERE id = ?').run(hashPassword(password), acc.id);
      db.prepare('DELETE FROM account_sessions WHERE account_id = ?').run(acc.id);
      db.prepare("DELETE FROM account_codes WHERE kind = 'reset' AND key = ?").run(key);
    })();
    res.json({ ok: true });
  });

  return { linkTelegram, accountFromRequest };
}

module.exports = { setupAccounts, createAccountTables, hashPassword, checkPassword, last9, CHANGE_HOUR_OPTIONS };
