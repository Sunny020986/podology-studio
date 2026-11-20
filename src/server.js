const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { openDb, DB_PATH } = require('./db');
const { createTelegram } = require('./telegram');
const { freeSlots, isValidDate, isBookableDate, maxDateStr, todayStr, toMin, toHHMM, weekdayOf, addDays } = require('./slots');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.dirname(DB_PATH);

// Межі, які можна змінити змінними середовища (опис у README.md)
const HORIZON_DAYS = Number(process.env.BOOKING_HORIZON_DAYS) || 90;  // на скільки днів уперед відкрито запис
const BOOKINGS_PER_HOUR = Number(process.env.BOOKINGS_PER_HOUR) || 10; // записів з однієї IP-адреси за годину
const MAX_ACTIVE_PER_PHONE = 3;                                        // активних майбутніх записів на один телефон
const LOGIN_MAX_FAILS = 10;                                            // невдалих входів в адмінку з однієї IP-адреси...
const LOGIN_WINDOW_MS = 15 * 60 * 1000;                                // ...за 15 хвилин, далі блокування до кінця вікна
const TRUST_PROXY = process.env.TRUST_PROXY === '1';                   // увімкнути, якщо сайт стоїть за Caddy або Nginx

const db = openDb();
const telegram = createTelegram(db);

// ---------- Токен адміна ----------
// Беремо з ADMIN_TOKEN, інакше з data/admin-token.txt, інакше створюємо новий.
function loadAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'admin-token.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, token);
  console.log(`Створено токен адміна і збережено у файлі: ${file}`);
  return token;
}
const ADMIN_TOKEN = loadAdminToken();
if (ADMIN_TOKEN.length < 12) {
  console.warn('УВАГА: токен адміна коротший за 12 символів. Для доступу з інтернету задайте довший ADMIN_TOKEN.');
}

// ---------- Обмеження частоти (лічильники в пам'яті процесу) ----------
function makeLimiter(max, windowMs) {
  const hits = new Map(); // ключ -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, 60 * 1000).unref();
  const entry = (key) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(key, e);
    }
    return e;
  };
  return {
    blocked: (key) => entry(key).count >= max,
    hit: (key) => { entry(key).count += 1; },
    minutesLeft: (key) => Math.max(1, Math.ceil((entry(key).resetAt - Date.now()) / 60000)),
  };
}
const loginLimiter = makeLimiter(LOGIN_MAX_FAILS, LOGIN_WINDOW_MS);
const bookingLimiter = makeLimiter(BOOKINGS_PER_HOUR, 60 * 60 * 1000);

// IP-адреса для WebSocket (для звичайних запитів Express сам дає req.ip)
function wsIp(req) {
  const xff = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : '';
  return xff || req.socket.remoteAddress || 'unknown';
}

function tokenOk(t) {
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Після LOGIN_MAX_FAILS невдалих спроб адреса блокується до кінця вікна, навіть із правильним токеном:
// інакше перебір паролів просто тривав би далі.
const requireAdmin = (req, res, next) => {
  if (loginLimiter.blocked(req.ip)) {
    return res.status(429).json({ error: `Забагато невдалих спроб входу. Спробуйте через ${loginLimiter.minutesLeft(req.ip)} хв` });
  }
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || !tokenOk(h.slice(7))) {
    loginLimiter.hit(req.ip);
    return res.status(401).json({ error: 'Невірний токен' });
  }
  next();
};

// ---------- Валідація ----------
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function validateService(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (name.length < 2 || name.length > 80) return { error: 'Назва: від 2 до 80 символів' };
    out.name = name;
  }
  if (!partial || body.description !== undefined) out.description = String(body.description ?? '').trim().slice(0, 300);
  if (!partial || body.duration_min !== undefined) {
    const d = Number(body.duration_min);
    if (!Number.isInteger(d) || d < 5 || d > 480) return { error: 'Тривалість: від 5 до 480 хвилин' };
    out.duration_min = d;
  }
  if (!partial || body.price_uah !== undefined) {
    const p = Number(body.price_uah);
    if (!Number.isInteger(p) || p < 0 || p > 1000000) return { error: 'Ціна: ціле число від 0 до 1000000' };
    out.price_uah = p;
  }
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  return { data: out };
}

function updateRow(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  return db.prepare(sql).run(...keys.map((k) => data[k]), id).changes;
}

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
// Головна сторінка з тегами для прев'ю посилання (Telegram, Viber, Facebook) і пошуковиків.
// Повна адреса картинки береться із запиту, бо месенджери не розуміють відносних шляхів.
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const attr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
app.get(['/', '/index.html'], (req, res) => {
  const s = readStudio();
  const origin = `${req.protocol}://${req.get('host')}`;
  const title = `${s.name}: онлайн-запис до подолога`;
  const place = [s.city, s.address].filter(Boolean).join(', ');
  const desc = ['Запис онлайн на вільний час, чат з майстром.', [place, s.phone].filter(Boolean).join(' · ')].filter(Boolean).join(' ');
  const tags = [
    `<meta name="description" content="${attr(desc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:locale" content="uk_UA">`,
    `<meta property="og:site_name" content="${attr(s.name)}">`,
    `<meta property="og:title" content="${attr(title)}">`,
    `<meta property="og:description" content="${attr(desc)}">`,
    `<meta property="og:url" content="${attr(origin + '/')}">`,
    `<meta property="og:image" content="${attr(origin + '/img/og.jpg')}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join('\n');
  res.type('html').send(INDEX_HTML.replace('<!--SEO-->', tags).replace('<title>Онлайн-запис до подолога</title>', `<title>${attr(title)}</title>`));
});

app.use(express.static(PUBLIC_DIR));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// ---------- Публічне API ----------
app.get('/api/services', (req, res) => {
  res.json(db.prepare('SELECT id, name, description, duration_min, price_uah FROM services WHERE active = 1 ORDER BY id').all());
});

// Поля кабінету й максимальна довжина кожного. name обов'язкове, решта може бути порожньою.
const STUDIO_FIELDS = {
  name: 80, tagline: 120, address: 200, phone: 40, city: 80, review_url: 300,
  promo_first: 400, promo_friend: 400, promo_gift: 400, partners: 600,
  master_name: 80, master_about: 2000, faq: 6000,
};
function readStudio() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const all = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(Object.keys(STUDIO_FIELDS).map((k) => [k, all[k] ?? '']));
}

app.get('/api/settings', (req, res) => {
  res.json({ horizonDays: HORIZON_DAYS, maxDate: maxDateStr(HORIZON_DAYS), studio: readStudio() });
});

app.get('/api/slots', (req, res) => {
  const service = db.prepare('SELECT duration_min FROM services WHERE id = ? AND active = 1').get(Number(req.query.serviceId));
  const date = String(req.query.date || '');
  if (!service) return res.status(400).json({ error: 'Невідома послуга' });
  if (!isBookableDate(date, HORIZON_DAYS)) return res.status(400).json({ error: `Запис відкрито від сьогодні до ${maxDateStr(HORIZON_DAYS)}` });
  res.json({ date, slots: freeSlots(db, date, service.duration_min) });
});

// Найближчий день з вільним часом для послуги, щоб клієнт одразу бачив записи, а не порожню дату
app.get('/api/next-slot', (req, res) => {
  const service = db.prepare('SELECT duration_min FROM services WHERE id = ? AND active = 1').get(Number(req.query.serviceId));
  if (!service) return res.status(400).json({ error: 'Невідома послуга' });
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = addDays(todayStr(), i);
    if (!isBookableDate(date, HORIZON_DAYS)) break;
    const slots = freeSlots(db, date, service.duration_min);
    if (slots.length) return res.json({ date, slots });
  }
  res.json({ date: null, slots: [] });
});

// Перевірка вільного часу і запис виконуються в одній транзакції, тому два клієнти не займуть один слот.
const last9 = (phone) => phone.replace(/\D/g, '').slice(-9); // номер без коду країни, щоб +380 50... і 050... збігалися

const bookTx = db.transaction(({ service, date, time, name, phone }) => {
  const samePhone = db
    .prepare("SELECT client_phone FROM appointments WHERE date >= ? AND status != 'cancelled'")
    .all(todayStr())
    .filter((r) => last9(r.client_phone) === last9(phone)).length;
  if (samePhone >= MAX_ACTIVE_PER_PHONE) {
    throw Object.assign(
      new Error(`На цей номер уже є ${MAX_ACTIVE_PER_PHONE} активні записи. Щоб додати ще, напишіть оператору в чат`),
      { status: 429 }
    );
  }
  const free = freeSlots(db, date, service.duration_min);
  if (!free.includes(time)) {
    throw Object.assign(new Error('Цей час уже недоступний, оберіть інший'), { status: 409 });
  }
  const end = toHHMM(toMin(time) + service.duration_min);
  const remindCode = 'r' + crypto.randomBytes(9).toString('base64url');
  const info = db
    .prepare('INSERT INTO appointments (service_id, date, start_time, end_time, client_name, client_phone, remind_code) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(service.id, date, time, end, name, phone, remindCode);
  return { id: info.lastInsertRowid, remindCode };
});

app.post('/api/appointments', (req, res) => {
  const { serviceId, date, time, name, phone } = req.body || {};
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(Number(serviceId));
  if (!service) return res.status(400).json({ error: 'Невідома послуга' });
  if (!isBookableDate(date, HORIZON_DAYS)) return res.status(400).json({ error: `Запис відкрито від сьогодні до ${maxDateStr(HORIZON_DAYS)}` });
  if (!isTime(time)) return res.status(400).json({ error: 'Некоректний час' });

  const cleanName = String(name ?? '').trim();
  if (cleanName.length < 2 || cleanName.length > 60) return res.status(400).json({ error: "Вкажіть ім'я (від 2 до 60 символів)" });

  const cleanPhone = String(phone ?? '').trim();
  const digits = cleanPhone.replace(/\D/g, '');
  if (!/^\+?[\d\s()-]+$/.test(cleanPhone) || digits.length < 9 || digits.length > 15) {
    return res.status(400).json({ error: 'Вкажіть коректний телефон' });
  }

  if (bookingLimiter.blocked(req.ip)) {
    return res.status(429).json({ error: 'Забагато записів з вашої адреси за останню годину. Спробуйте пізніше або напишіть оператору в чат' });
  }

  try {
    const { id, remindCode } = bookTx({ service, date, time, name: cleanName, phone: cleanPhone });
    bookingLimiter.hit(req.ip);
    telegram.newAppointment({ service: service.name, date, time, name: cleanName, phone: cleanPhone });
    res.status(201).json({ id: Number(id), date, time, service: service.name, remindLink: telegram.remindLink(remindCode) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ---------- Адмін API ----------
app.use('/api/admin', requireAdmin);

app.get('/api/admin/studio', (req, res) => res.json(readStudio()));

app.put('/api/admin/studio', (req, res) => {
  const body = req.body || {};
  const clean = {};
  for (const [k, max] of Object.entries(STUDIO_FIELDS)) {
    const v = String(body[k] ?? '').trim();
    if (v.length > max) return res.status(400).json({ error: `Поле «${k}» довше за ${max} символів` });
    clean[k] = v;
  }
  if (!clean.name) return res.status(400).json({ error: 'Назва кабінету не може бути порожньою' });
  if (clean.review_url && !/^https:\/\/\S+$/.test(clean.review_url)) {
    return res.status(400).json({ error: 'Посилання на відгук має починатися з https://' });
  }
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => { for (const [k, v] of Object.entries(clean)) up.run(k, v); })();
  res.json(clean);
});

// ----- Сповіщення в Telegram -----
const tgRoute = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Помилка сервера' });
  }
};
app.get('/api/admin/telegram', (req, res) => res.json(telegram.status()));
app.put('/api/admin/telegram', tgRoute((req) => { telegram.save(req.body || {}); return telegram.status(); }));
app.delete('/api/admin/telegram', tgRoute(() => { telegram.clear(); return telegram.status(); }));
app.post('/api/admin/telegram/detect', tgRoute(async (req) => ({ chats: await telegram.detect(req.body?.token) })));
app.post('/api/admin/telegram/test', tgRoute(async () => { await telegram.test(); return { ok: true }; }));

app.get('/api/admin/appointments', (req, res) => {
  const from = isValidDate(req.query.from) ? req.query.from : todayStr();
  const to = isValidDate(req.query.to) ? req.query.to : from;
  res.json(
    db
      .prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.client_name, a.client_phone, a.status, s.name AS service
                FROM appointments a JOIN services s ON s.id = a.service_id
                WHERE a.date BETWEEN ? AND ? ORDER BY a.date, a.start_time`)
      .all(from, to)
  );
});

// Скасований запис можна повернути лише тоді, коли його час досі вільний від інших записів.
const setStatusTx = db.transaction((id, status) => {
  const appt = db.prepare('SELECT id, date, start_time, end_time, status FROM appointments WHERE id = ?').get(id);
  if (!appt) throw Object.assign(new Error('Запис не знайдено'), { status: 404 });
  if (appt.status === 'cancelled' && status !== 'cancelled') {
    const clash = db
      .prepare("SELECT 1 FROM appointments WHERE date = ? AND id != ? AND status != 'cancelled' AND start_time < ? AND end_time > ?")
      .get(appt.date, id, appt.end_time, appt.start_time);
    if (clash) {
      throw Object.assign(new Error('Цей час уже зайнятий іншим записом. Спочатку скасуйте або перенесіть той запис'), { status: 409 });
    }
  }
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id);
});

app.patch('/api/admin/appointments/:id', (req, res) => {
  const status = req.body?.status;
  if (!['new', 'confirmed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Некоректний статус' });
  try {
    setStatusTx(Number(req.params.id), status);
    if (status === 'cancelled') notifyClientCancelled(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

// ---------- Нагадування клієнтам у Telegram ----------
const REMIND_BEFORE_MS = 24 * 60 * 60 * 1000; // нагадуємо за добу до візиту
const msUntil = (date, time) => new Date(`${date}T${time}:00`).getTime() - Date.now(); // за часом сервера (Київ)
const apptForClient = (where, arg) => db.prepare(`SELECT a.*, s.name AS service FROM appointments a
  JOIN services s ON s.id = a.service_id WHERE ${where}`).get(arg);
const studioLine = () => {
  const s = readStudio();
  return [[s.city, s.address].filter(Boolean).join(', '), s.phone].filter(Boolean).join(' · ');
};

// Клієнт натиснув «Start» за посиланням із сайту: прив'язуємо його чат до запису
telegram.onStart((code, chatId) => {
  const a = apptForClient('a.remind_code = ?', code);
  if (!a) return 'Не знайшли цей запис. Можливо, посилання застаріло. Запишіться на сайті ще раз або подзвоніть нам.';
  if (a.status === 'cancelled') return 'Цей запис скасовано. Щоб записатися знову, скористайтеся сайтом.';
  const left = msUntil(a.date, a.start_time);
  if (left <= 0) return 'Цей візит уже минув. Дякуємо, що були у нас!';
  // Якщо до візиту менше доби, окреме нагадування не потрібне: усе є в цьому повідомленні
  db.prepare('UPDATE appointments SET tg_chat_id = ?, reminded = ? WHERE id = ?').run(chatId, left <= REMIND_BEFORE_MS ? 1 : 0, a.id);
  const when = `${telegram.fmtDate(a.date)} о ${a.start_time}`;
  return `✅ Готово! Ваш запис: ${a.service}, ${when}.\n` +
    (left <= REMIND_BEFORE_MS ? 'Чекаємо на вас.' : 'Нагадаємо за добу до візиту.') +
    (studioLine() ? `\n${studioLine()}` : '');
});

async function sendDueReminders() {
  const rows = db.prepare(`SELECT a.*, s.name AS service FROM appointments a JOIN services s ON s.id = a.service_id
    WHERE a.tg_chat_id IS NOT NULL AND a.reminded = 0 AND a.status != 'cancelled' AND a.date BETWEEN ? AND date(?, '+2 day')`)
    .all(todayStr(), todayStr());
  for (const a of rows) {
    const left = msUntil(a.date, a.start_time);
    if (left <= 0 || left > REMIND_BEFORE_MS) continue;
    db.prepare('UPDATE appointments SET reminded = 1 WHERE id = ?').run(a.id); // спершу позначка: двічі не нагадаємо
    await telegram.sendToClient(a.tg_chat_id,
      `🔔 Нагадування: ${a.date === todayStr() ? 'сьогодні' : 'завтра'}, ${telegram.fmtDate(a.date)} о ${a.start_time}, у вас ${a.service}.\n` +
      (studioLine() ? `${studioLine()}\n` : '') + 'Якщо плани змінилися, будь ласка, повідомте нам заздалегідь.');
  }
}
setInterval(() => sendDueReminders().catch((e) => console.error('Нагадування:', e.message)), 5 * 60 * 1000).unref();
setTimeout(() => sendDueReminders().catch(() => {}), 15000).unref();

function notifyClientCancelled(id) {
  const a = apptForClient('a.id = ?', id);
  if (!a?.tg_chat_id || msUntil(a.date, a.start_time) <= 0) return;
  telegram.sendToClient(a.tg_chat_id,
    `Ваш запис ${a.service}, ${telegram.fmtDate(a.date)} о ${a.start_time}, скасовано.` +
    (readStudio().phone ? ` Щоб обрати інший час, запишіться на сайті або подзвоніть: ${readStudio().phone}.` : ' Щоб обрати інший час, запишіться на сайті.'));
}

// ---------- Клієнти ----------
// Клієнт визначається за останніми 9 цифрами телефону, тому +380 67 123 45 67 і 067 123 45 67 це одна людина.
const isClientKey = (k) => /^\d{9}$/.test(k);
const NOTE_MAX = 5000;

function listClients(q) {
  const today = todayStr();
  const rows = db
    .prepare('SELECT date, start_time, client_name, client_phone, status FROM appointments ORDER BY date, start_time')
    .all();
  const noted = new Set(db.prepare("SELECT phone_key FROM client_notes WHERE note != ''").all().map((r) => r.phone_key));
  const map = new Map();
  for (const r of rows) {
    const key = last9(r.client_phone);
    if (!map.has(key)) map.set(key, { key, name: '', phone: '', visits: 0, cancelled: 0, last_visit: null, next_visit: null });
    const c = map.get(key);
    c.name = r.client_name;   // рядки йдуть за датою, тому залишаються ім'я і телефон з найновішого запису
    c.phone = r.client_phone;
    if (r.status === 'cancelled') {
      c.cancelled += 1;
    } else if (r.date < today) {
      c.visits += 1;
      c.last_visit = r.date;
    } else if (!c.next_visit) {
      c.next_visit = r.date;
    }
  }
  let list = [...map.values()].map((c) => ({ ...c, has_note: noted.has(c.key) }));
  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    const digits = needle.replace(/\D/g, '');
    list = list.filter((c) => c.name.toLowerCase().includes(needle) || (digits && c.phone.replace(/\D/g, '').includes(digits)));
  }
  return list.sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}

app.get('/api/admin/clients', (req, res) => {
  res.json(listClients(req.query.q));
});

// Вивантаження для Excel: роздільник ";" і позначка кодування на початку файлу. Нотаток у файлі немає.
app.get('/api/admin/clients.csv', (req, res) => {
  const cell = (v) => {
    let s = String(v ?? '');
    // Значення, яке Excel сприйняв би як формулу, отримує апостроф на початку (телефони виду +380... не чіпаємо)
    if (/^[=@]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?[\d\s()-]+$/.test(s))) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [['Імʼя', 'Телефон', 'Візитів', 'Скасовано', 'Останній візит', 'Наступний запис']];
  for (const c of listClients()) lines.push([c.name, c.phone, c.visits, c.cancelled, c.last_visit, c.next_visit]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="clients.csv"');
  res.send('\uFEFF' + lines.map((l) => l.map(cell).join(';')).join('\r\n') + '\r\n');
});

app.get('/api/admin/clients/:key', (req, res) => {
  const key = req.params.key;
  if (!isClientKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
  const appointments = db
    .prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.client_name, a.client_phone, a.status, a.note, s.name AS service
              FROM appointments a JOIN services s ON s.id = a.service_id ORDER BY a.date DESC, a.start_time DESC`)
    .all()
    .filter((a) => last9(a.client_phone) === key);
  if (!appointments.length) return res.status(404).json({ error: 'Клієнта не знайдено' });
  const noteRow = db.prepare('SELECT note, updated_at FROM client_notes WHERE phone_key = ?').get(key);
  res.json({
    key,
    name: appointments[0].client_name,
    phone: appointments[0].client_phone,
    note: noteRow ? noteRow.note : '',
    appointments,
  });
});

app.put('/api/admin/clients/:key/note', (req, res) => {
  const key = req.params.key;
  if (!isClientKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
  const note = String(req.body?.note ?? '').trim();
  if (note.length > NOTE_MAX) return res.status(400).json({ error: `Нотатка: не більше ${NOTE_MAX} символів` });
  db.prepare(`INSERT INTO client_notes (phone_key, note) VALUES (?, ?)
              ON CONFLICT(phone_key) DO UPDATE SET note = excluded.note, updated_at = datetime('now')`).run(key, note);
  res.json({ ok: true });
});

app.put('/api/admin/appointments/:id/note', (req, res) => {
  const note = String(req.body?.note ?? '').trim();
  if (note.length > NOTE_MAX) return res.status(400).json({ error: `Нотатка: не більше ${NOTE_MAX} символів` });
  const changed = db.prepare('UPDATE appointments SET note = ? WHERE id = ?').run(note, Number(req.params.id)).changes;
  if (!changed) return res.status(404).json({ error: 'Запис не знайдено' });
  res.json({ ok: true });
});

app.get('/api/admin/services', (req, res) => {
  res.json(db.prepare('SELECT id, name, description, duration_min, price_uah, active FROM services ORDER BY id').all());
});

app.post('/api/admin/services', (req, res) => {
  const v = validateService(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const d = { description: '', price_uah: 0, active: 1, ...v.data };
  const info = db
    .prepare('INSERT INTO services (name, description, duration_min, price_uah, active) VALUES (?, ?, ?, ?, ?)')
    .run(d.name, d.description, d.duration_min, d.price_uah, d.active);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.patch('/api/admin/services/:id', (req, res) => {
  const v = validateService(req.body || {}, true);
  if (v.error) return res.status(400).json({ error: v.error });
  if (!updateRow('services', Number(req.params.id), v.data)) return res.status(404).json({ error: 'Послугу не знайдено' });
  res.json({ ok: true });
});

app.get('/api/admin/schedule', (req, res) => {
  res.json(db.prepare('SELECT weekday, start_time, end_time FROM work_hours ORDER BY weekday').all());
});

app.put('/api/admin/schedule/:weekday', (req, res) => {
  const wd = Number(req.params.weekday);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return res.status(400).json({ error: 'День: від 0 (Пн) до 6 (Нд)' });
  const { start_time, end_time } = req.body || {};
  if (start_time === null || start_time === undefined) {
    db.prepare('UPDATE work_hours SET start_time = NULL, end_time = NULL WHERE weekday = ?').run(wd);
    return res.json({ ok: true });
  }
  if (!isTime(start_time) || !isTime(end_time) || toMin(start_time) >= toMin(end_time)) {
    return res.status(400).json({ error: 'Початок має бути раніше за кінець' });
  }
  db.prepare('UPDATE work_hours SET start_time = ?, end_time = ? WHERE weekday = ?').run(start_time, end_time, wd);
  res.json({ ok: true });
});

app.get('/api/admin/blocks', (req, res) => {
  const date = isValidDate(req.query.date) ? req.query.date : todayStr();
  res.json(db.prepare('SELECT id, date, start_time, end_time, note FROM blocks WHERE date = ? ORDER BY start_time').all(date));
});

app.post('/api/admin/blocks', (req, res) => {
  const { date, start_time, end_time, note } = req.body || {};
  if (!isValidDate(date)) return res.status(400).json({ error: 'Некоректна дата' });
  if (!isTime(start_time) || !isTime(end_time) || toMin(start_time) >= toMin(end_time)) {
    return res.status(400).json({ error: 'Початок має бути раніше за кінець' });
  }
  const info = db
    .prepare('INSERT INTO blocks (date, start_time, end_time, note) VALUES (?, ?, ?, ?)')
    .run(date, start_time, end_time, String(note ?? '').trim().slice(0, 100));
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.delete('/api/admin/blocks/:id', (req, res) => {
  db.prepare('DELETE FROM blocks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Щотижневі перерви (обід тощо)
app.get('/api/admin/breaks', (req, res) => {
  res.json(db.prepare('SELECT id, weekday, start_time, end_time, note FROM breaks ORDER BY start_time, weekday').all());
});

const addBreaksTx = db.transaction((weekdays, start, end, note) => {
  const ins = db.prepare('INSERT OR IGNORE INTO breaks (weekday, start_time, end_time, note) VALUES (?, ?, ?, ?)');
  let added = 0;
  for (const wd of weekdays) added += ins.run(wd, start, end, note).changes;
  return added;
});

app.post('/api/admin/breaks', (req, res) => {
  const { weekdays, start_time, end_time, note } = req.body || {};
  const days = Array.isArray(weekdays) ? [...new Set(weekdays.map(Number))] : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return res.status(400).json({ error: 'Позначте хоча б один день тижня' });
  }
  if (!isTime(start_time) || !isTime(end_time) || toMin(start_time) >= toMin(end_time)) {
    return res.status(400).json({ error: 'Початок має бути раніше за кінець' });
  }
  const added = addBreaksTx(days, start_time, end_time, String(note ?? '').trim().slice(0, 60));

  // Скільки вже наявних майбутніх записів потрапляє на нову перерву: вони залишаються чинними
  const clashes = db
    .prepare("SELECT date FROM appointments WHERE date >= ? AND status != 'cancelled' AND start_time < ? AND end_time > ?")
    .all(todayStr(), end_time, start_time)
    .filter((a) => days.includes(weekdayOf(a.date))).length;
  res.status(201).json({ added, clashes });
});

app.delete('/api/admin/breaks/:id', (req, res) => {
  db.prepare('DELETE FROM breaks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/conversations', (req, res) => {
  res.json(listConversations());
});

app.get('/api/admin/conversations/:id/messages', (req, res) => {
  res.json(messagesOf(req.params.id));
});

// Видалення діалогу разом з усіма його повідомленнями. Дію не можна скасувати.
const deleteConversationTx = db.transaction((id) => {
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
  return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes;
});

app.delete('/api/admin/conversations/:id', (req, res) => {
  const id = req.params.id;
  if (!deleteConversationTx(id)) return res.status(404).json({ error: 'Діалог не знайдено' });

  // Відвідувача, який ще тримає цей діалог відкритим, від'єднуємо:
  // його сторінка сама перепідключиться і отримає новий порожній діалог.
  const sockets = clients.get(id);
  if (sockets) {
    clients.delete(id);
    sockets.forEach((c) => {
      c.meta.conversationId = null;
      c.close(4001, 'conversation deleted');
    });
  }
  notifyAdmins({ type: 'conversation_deleted', conversationId: id });
  res.json({ ok: true });
});

// ---------- Чат (WebSocket) ----------
function listConversations() {
  return db
    .prepare(`SELECT c.id, c.last_message_at,
                     (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body
              FROM conversations c ORDER BY c.last_message_at DESC LIMIT 200`)
    .all();
}

function messagesOf(convId) {
  return db
    .prepare('SELECT id, conversation_id, sender, body, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 50')
    .all(convId)
    .reverse();
}

function saveMessage(convId, sender, body) {
  const info = db.prepare('INSERT INTO messages (conversation_id, sender, body) VALUES (?, ?, ?)').run(convId, sender, body);
  db.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").run(convId);
  return db.prepare('SELECT id, conversation_id, sender, body, created_at FROM messages WHERE id = ?').get(info.lastInsertRowid);
}

// ---------- Помилки ----------
// Власний обробник: клієнт отримує коротке повідомлення, подробиці йдуть лише в журнал сервера.
app.use('/api', (req, res) => res.status(404).json({ error: 'Не знайдено' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Запит завеликий' });
  if (err.type === 'entity.parse.failed' || err.status === 400) return res.status(400).json({ error: 'Некоректний запит' });
  console.error(err);
  res.status(500).json({ error: 'Помилка сервера' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const clients = new Map(); // conversationId -> Set<ws>
const admins = new Set();

const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const notifyAdmins = (obj) => admins.forEach((a) => send(a, obj));

function detach(ws) {
  const id = ws.meta.conversationId;
  if (id && clients.has(id)) clients.get(id).delete(ws);
  ws.meta.conversationId = null;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const adminParam = url.searchParams.get('admin');
  let isAdmin = false;
  if (adminParam !== null) {
    // Спроба зайти як адмін: ті самі обмеження, що й для входу через сторінку
    const ip = wsIp(req);
    if (loginLimiter.blocked(ip) || !tokenOk(adminParam)) {
      if (!loginLimiter.blocked(ip)) loginLimiter.hit(ip);
      return ws.close(4003, 'forbidden');
    }
    isAdmin = true;
  }
  ws.meta = { role: isAdmin ? 'admin' : 'client', conversationId: null, hits: [] };

  if (isAdmin) {
    admins.add(ws);
    send(ws, { type: 'admin_ready' });
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (ws.meta.role === 'admin') handleAdmin(ws, msg);
      else handleClient(ws, msg);
    } catch (e) {
      console.error(e);
      send(ws, { type: 'error', error: 'Помилка сервера' });
    }
  });

  ws.on('close', () => {
    admins.delete(ws);
    detach(ws);
  });
});

function attach(ws, id) {
  ws.meta.conversationId = id;
  if (!clients.has(id)) clients.set(id, new Set());
  clients.get(id).add(ws);
}

// Порожні діалоги, створені старою версією сайту, прибираються при старті й далі щогодини
function purgeEmptyConversations() {
  const n = db.prepare(`DELETE FROM conversations
                        WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)
                          AND created_at < datetime('now', '-1 hour')`).run().changes;
  if (n) console.log(`Видалено порожніх діалогів: ${n}`);
}
purgeEmptyConversations();
setInterval(purgeEmptyConversations, 60 * 60 * 1000).unref();

function handleClient(ws, msg) {
  if (msg.type === 'hello') {
    // Діалог у базі створюється лише з першим повідомленням, тож просте відкриття сайту нічого не записує
    let id = typeof msg.conversationId === 'string' && /^[a-f0-9-]{36}$/.test(msg.conversationId) ? msg.conversationId : null;
    if (id && !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) id = null;
    detach(ws);
    if (id) attach(ws, id);
    send(ws, { type: 'hello', conversationId: id, messages: id ? messagesOf(id) : [] });
    return;
  }

  if (msg.type === 'message') {
    const body = String(msg.body ?? '').trim();
    if (!body || body.length > 1000) {
      return send(ws, { type: 'error', error: 'Повідомлення порожнє або довше 1000 символів' });
    }
    const now = Date.now();
    ws.meta.hits = ws.meta.hits.filter((t) => now - t < 10000);
    if (ws.meta.hits.length >= 5) {
      return send(ws, { type: 'error', error: 'Забагато повідомлень. Зачекайте 10 секунд' });
    }
    ws.meta.hits.push(now);
    let id = ws.meta.conversationId;
    if (!id) {
      id = crypto.randomUUID();
      db.prepare('INSERT INTO conversations (id) VALUES (?)').run(id);
      attach(ws, id);
      send(ws, { type: 'conversation', conversationId: id });
    }
    const message = saveMessage(id, 'client', body);
    send(ws, { type: 'message', message });
    telegram.newChatMessage(id, body);
    notifyAdmins({ type: 'message', conversationId: id, message });
  }
}

function handleAdmin(ws, msg) {
  if (msg.type === 'reply') {
    const convId = String(msg.conversationId ?? '');
    const body = String(msg.body ?? '').trim();
    if (!body || body.length > 1000) return send(ws, { type: 'error', error: 'Повідомлення порожнє або довше 1000 символів' });
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(convId)) return send(ws, { type: 'error', error: 'Діалог не знайдено' });
    const message = saveMessage(convId, 'operator', body);
    (clients.get(convId) || new Set()).forEach((c) => send(c, { type: 'message', message }));
    notifyAdmins({ type: 'message', conversationId: convId, message });
  }
}

server.listen(PORT, () => {
  console.log(`Сайт: http://localhost:${PORT}`);
  console.log(`Адмінка: http://localhost:${PORT}/admin`);
  console.log(`База даних: ${DB_PATH}`);
});
