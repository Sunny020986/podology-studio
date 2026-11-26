// Особистий кабінет клієнта: реєстрація за номером і паролем, вхід, записи, скасування і перенесення,
// прив'язка Telegram-бота і відновлення пароля. Реєстрація необов'язкова: запис без неї працює як раніше.
const crypto = require('crypto');
const { isInvitedFriend } = require('./friend-invite');
const { hasVisits, discountPct, friendPct } = require('./first-discount');

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
  // Номер підтверджено через Telegram («Поділитися номером») або персоналом після дзвінка.
  // Без підтвердження кабінет не показує записи цього номера й не дає знижки на перший візит.
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
  if (!cols.includes('phone_verified_at')) db.exec('ALTER TABLE accounts ADD COLUMN phone_verified_at TEXT');
  if (!cols.includes('verified_by')) db.exec('ALTER TABLE accounts ADD COLUMN verified_by TEXT'); // telegram або хто з персоналу
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

  // Записи номера бачить лише той, хто підтвердив, що номер його: інакше хтось міг би зареєструватися на чужий номер
  const accountPhoneAppts = (acc) => (!acc.phone_verified_at ? [] : db.prepare(`
      SELECT a.id, a.date, a.start_time, a.end_time, a.client_phone, a.status, a.master_id, m.name AS master, s.id AS service_id, COALESCE(a.services_label, s.name) AS service, (CAST(substr(a.end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(a.end_time, 4, 2) AS INTEGER)) - (CAST(substr(a.start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(a.start_time, 4, 2) AS INTEGER)) AS duration_min, a.price_uah, a.price_full_uah, a.discount_pct, a.discount_kind, a.extra_services
      FROM appointments a JOIN services s ON s.id = a.service_id LEFT JOIN masters m ON m.id = a.master_id ORDER BY a.date DESC, a.start_time DESC`)
    .all().filter((a) => last9(a.client_phone) === last9(acc.phone)));

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
    // Запрошений друг, який ще не був у нас: кабінет показує його знижку на перший візит (без імені того, хто запросив:
    // номер при реєстрації не підтверджується, тож чуже ім'я не розкриваємо)
    const first = discountPct(db), extra = friendPct(db);
    const isInv = isInvitedFriend(db, acc.phone) && !hasVisits(db, acc.phone);
    const total = isInv ? Math.min(90, first + extra) : 0;
    res.json({ name: acc.name, phone: acc.phone, telegram: !!acc.tg_chat_id, verified: !!acc.phone_verified_at, invited_discount: total, invited_parts: isInv ? { first, friend: extra } : null });
  });

  // ----- Записи клієнта -----
  app.get('/api/account/appointments', requireAccount, (req, res) => {
    const today = todayStr();
    res.json(accountPhoneAppts(req.account).map((a) => ({
      id: a.id, service_id: a.service_id, master_id: a.master_id, master: a.master || '', date: a.date, start_time: a.start_time, end_time: a.end_time, status: a.status,
      service: a.service, upcoming: a.date >= today && a.status !== 'cancelled', canChange: canChange(a),
      extra: (() => { try { return JSON.parse(a.extra_services || '[]'); } catch { return []; } })(),
      price: a.price_uah > 0 ? { full: a.price_full_uah || a.price_uah, pct: a.discount_pct || 0, kind: a.discount_kind || null, final: a.price_uah } : null,
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
    const free = freeSlots(db, date, a.duration_min, { masterId: a.master_id, excludeId: a.id, client: true });
    if (!free.includes(time)) return res.status(409).json({ error: 'Цей час уже недоступний, оберіть інший' });
    const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    const endMin = toMinutes(time) + a.duration_min;
    const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    db.prepare('UPDATE appointments SET date = ?, start_time = ?, end_time = ?, reminded = 0, client_confirmed_at = NULL, client_declined_at = NULL WHERE id = ?').run(date, time, end, a.id);
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

  // ----- Підтвердження номера через Telegram -----
  // Кабінет → «Підтвердити номер у Telegram» (v_) або вкладка «Забули пароль» → «Номер зайнятий?» (c_, без входу).
  // Бот просить натиснути «Поділитися номером»; Telegram передає номер самого акаунта, тож підробити його не можна.
  const VERIFY_MINUTES = 15;
  const claimLimiter = makeLimiter(10, 60 * 60 * 1000);
  function verifyLink(prefix, value) {
    const code = crypto.randomBytes(6).toString('base64url');
    db.prepare("INSERT INTO account_codes (kind, key, value, expires_at) VALUES ('verify', ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
      .run(sha(code), value, Date.now() + VERIFY_MINUTES * 60000);
    return telegram.remindLink(`${prefix}_${code}`);
  }
  app.post('/api/account/verify/link', requireAccount, (req, res) => {
    if (req.account.phone_verified_at) return res.status(409).json({ error: 'Номер уже підтверджено' });
    const link = verifyLink('v', 'acc:' + req.account.id);
    if (!link) return res.status(503).json({ error: 'Підтвердження через Telegram поки недоступне. Напишіть оператору в чат або подзвоніть — підтвердимо після дзвінка' });
    res.json({ link, minutes: VERIFY_MINUTES });
  });
  // Справжній власник номера, на який уже хтось зареєструвався: підтверджує номер у боті й отримує код для нового пароля
  app.post('/api/account/claim/link', (req, res) => {
    if (claimLimiter.blocked(req.ip)) return res.status(429).json({ error: 'Забагато запитів. Спробуйте пізніше' });
    claimLimiter.hit(req.ip);
    const key = last9(req.body?.phone ?? '');
    if (key.length !== 9) return res.status(400).json({ error: 'Вкажіть коректний телефон' });
    const link = verifyLink('c', 'phone:' + key);
    if (!link) return res.status(503).json({ error: 'Підтвердження через Telegram поки недоступне. Напишіть оператору в чат' });
    res.json({ link, minutes: VERIFY_MINUTES });
  });

  const contactKeyboard = { keyboard: [[{ text: '📱 Поділитися номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
  const noKeyboard = { remove_keyboard: true };
  // /start v_<код> або c_<код>: запам'ятовуємо, що цей чат чекає на номер, і показуємо кнопку
  function verifyStart(code, chatId) {
    const row = db.prepare("SELECT value, expires_at FROM account_codes WHERE kind = 'verify' AND key = ?").get(sha(code));
    if (!row || row.expires_at < Date.now()) return 'Посилання застаріло. Відкрийте нове з сайту.';
    db.prepare("DELETE FROM account_codes WHERE kind = 'verify' AND key = ?").run(sha(code));
    db.prepare("INSERT INTO account_codes (kind, key, value, expires_at) VALUES ('vpend', ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
      .run(String(chatId), row.value, Date.now() + VERIFY_MINUTES * 60000);
    return { text: 'Щоб підтвердити номер, натисніть кнопку «📱 Поділитися номером» внизу. Telegram передасть лише номер вашого акаунта.', reply_markup: contactKeyboard };
  }
  // Клієнт поділився контактом. contact.user_id має збігатися з тим, хто пише: чужий переслений контакт не рахується
  function verifyContact(contact, fromId, chatId) {
    const pend = db.prepare("SELECT value, expires_at FROM account_codes WHERE kind = 'vpend' AND key = ?").get(String(chatId));
    if (!pend || pend.expires_at < Date.now()) return { text: 'Щоб підтвердити номер, відкрийте посилання з сайту ще раз.', reply_markup: noKeyboard };
    if (!contact || String(contact.user_id) !== String(fromId)) return { text: 'Потрібен саме ваш номер: натисніть кнопку «📱 Поділитися номером».', reply_markup: contactKeyboard };
    const key = last9(contact.phone_number || '');
    const [type, val] = String(pend.value).split(':');
    const acc = type === 'acc' ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(val)) : db.prepare('SELECT * FROM accounts WHERE phone_key = ?').get(val);
    const want = type === 'acc' ? acc?.phone_key : val;
    if (!want || key !== want) {
      return { text: `Номер у Telegram (закінчується на ${key.slice(-4) || '—'}) не збігається з номером на сайті. Підтвердити можна лише свій номер. Якщо на сайті помилка в номері, напишіть оператору.`, reply_markup: noKeyboard };
    }
    db.prepare("DELETE FROM account_codes WHERE kind = 'vpend' AND key = ?").run(String(chatId));
    if (!acc) return { text: 'Номер підтверджено, але кабінету на нього ще немає. Зареєструйтеся на сайті, а потім підтвердьте номер у кабінеті.', reply_markup: noKeyboard };
    if (type === 'acc') {
      db.prepare("UPDATE accounts SET phone_verified_at = datetime('now'), verified_by = 'telegram', tg_chat_id = ? WHERE id = ?").run(String(chatId), acc.id);
      return { text: '✅ Номер підтверджено. Тепер у кабінеті видно ваші записи й діє знижка на перший візит. Нагадування про записи надходитимуть сюди.', reply_markup: noKeyboard };
    }
    // Номер зайнятий: код для нового пароля. Після нього кабінет переходить до власника номера (старі входи скасовуються)
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare("INSERT INTO account_codes (kind, key, value, expires_at, attempts) VALUES ('vreset', ?, ?, ?, 0) ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, attempts = 0")
      .run(want, sha(code) + ':' + chatId, Date.now() + RESET_MINUTES * 60000);
    return { text: `✅ Номер підтверджено. Код для нового пароля: ${code}\nДійсний ${RESET_MINUTES} хв. Введіть його на сайті: «Кабінет» → «Забули пароль» → «Ввести код».`, reply_markup: noKeyboard };
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
    // Код зі звичайного відновлення (reset) або після підтвердження номера в боті (vreset: «hash:чат»)
    const vrow = db.prepare("SELECT * FROM account_codes WHERE kind = 'vreset' AND key = ?").get(key);
    const rrow = db.prepare("SELECT * FROM account_codes WHERE kind = 'reset' AND key = ?").get(key);
    const live = [vrow, rrow].filter((r) => r && r.expires_at >= Date.now());
    if (!live.length) return res.status(400).json({ error: 'Код прострочено. Запросіть новий' });
    if (live.every((r) => r.attempts >= MAX_CODE_TRIES)) return res.status(429).json({ error: 'Забагато помилкових кодів. Запросіть новий' });
    const row = live.find((r) => r.attempts < MAX_CODE_TRIES && r.value.split(':')[0] === sha(code));
    if (!row) {
      for (const r of live) db.prepare('UPDATE account_codes SET attempts = attempts + 1 WHERE kind = ? AND key = ?').run(r.kind, key);
      return res.status(400).json({ error: 'Невірний код' });
    }
    const verifiedChat = row.kind === 'vreset' ? row.value.split(':')[1] : null;
    const acc = db.prepare('SELECT id FROM accounts WHERE phone_key = ?').get(key);
    if (!acc) return res.status(400).json({ error: 'Невірний код' });
    db.transaction(() => {
      db.prepare('UPDATE accounts SET pass_hash = ? WHERE id = ?').run(hashPassword(password), acc.id);
      db.prepare('DELETE FROM account_sessions WHERE account_id = ?').run(acc.id);
      db.prepare("DELETE FROM account_codes WHERE kind IN ('reset', 'vreset') AND key = ?").run(key);
      if (verifiedChat) {
        db.prepare("UPDATE accounts SET phone_verified_at = datetime('now'), verified_by = 'telegram', tg_chat_id = ? WHERE id = ?").run(verifiedChat, acc.id);
        db.prepare("DELETE FROM account_codes WHERE kind = 'link' AND value = ?").run(String(acc.id)); // старі посилання прив'язки Telegram
      }
    })();
    res.json({ ok: true });
  });

  // Персонал підтверджує номер після дзвінка (для клієнтів без Telegram)
  function verifyByStaff(key, actor) {
    return db.prepare("UPDATE accounts SET phone_verified_at = datetime('now'), verified_by = ? WHERE phone_key = ? AND phone_verified_at IS NULL").run(String(actor || 'персонал').slice(0, 80), key).changes;
  }

  return { linkTelegram, accountFromRequest, verifyStart, verifyContact, verifyByStaff };
}

module.exports = { setupAccounts, createAccountTables, hashPassword, checkPassword, last9, CHANGE_HOUR_OPTIONS };
