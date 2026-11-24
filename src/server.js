const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { openDb, DB_PATH } = require('./db');
const { createTelegram } = require('./telegram');
const { setupAccounts, CHANGE_HOUR_OPTIONS } = require('./accounts');
const { setupReviews } = require('./reviews');
const { setupRepeatReminders } = require('./repeat');
const { setupWaitlist } = require('./waitlist');
const { setupStats } = require('./stats');
const { setupTips } = require('./tips');
const { setupAdminAppointments } = require('./admin-appointments');
const { activeMasters, masterOffers, checkPassword: checkMasterPassword, sha, setupMasterAdmin } = require('./masters');
const { localBusinessJsonLd, setupSeo } = require('./seo');
const { nowMin, freeSlots, masterFreeSlots, masterFreeAt, workHours, pickMaster, bufferMin, isValidDate, isBookableDate, maxDateStr, todayStr, toMin, toHHMM, weekdayOf, addDays } = require('./slots');

const PORT = Number(process.env.PORT) || 3000;
const { securityHeaders, setupHealth } = require('./security');
const { setupClientPhotos } = require('./client-photos');
const { setupPrivacy } = require('./privacy');
const { validateCourse, setupCourse } = require('./course');
const { setupCalendar } = require('./calendar');
const { setupMaterials } = require('./materials');
const { setupCertificates } = require('./certificates');
const { setupReassign } = require('./reassign');
const { setupHolidays } = require('./holidays');
const { setupClientErase } = require('./client-erase');
const { setupReminderButtons } = require('./reminder-buttons');
const { setupChatTemplates } = require('./chat-templates');
const { setupReports } = require('./reports');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
let materialsApply = null; // списання матеріалів при «Відбувся» (src/materials.js), задається нижче
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

// Активний майстер за токеном сесії (або null)
function masterBySession(token) {
  return (token && db.prepare(`SELECT m.id, m.name FROM master_sessions ss JOIN masters m ON m.id = ss.master_id
    WHERE ss.token_hash = ? AND ss.expires_at > ? AND m.status = 'active'`).get(sha(token), Date.now())) || null;
}
// Хто відкрив канал адмінки: адміністратор (чат і всі записи) чи майстер (лише події своїх записів)
function wsStaff(token) {
  if (tokenOk(token)) return { role: 'admin', masterId: null };
  const m = masterBySession(token);
  return m ? { role: 'master', masterId: m.id } : null;
}

// Після LOGIN_MAX_FAILS невдалих спроб адреса блокується до кінця вікна, навіть із правильним токеном:
// інакше перебір паролів просто тривав би далі.
const requireAdmin = (req, res, next) => {
  if (loginLimiter.blocked(req.ip)) {
    return res.status(429).json({ error: `Забагато невдалих спроб входу. Спробуйте через ${loginLimiter.minutesLeft(req.ip)} хв` });
  }
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (tokenOk(token)) {
    req.role = 'super';
    return next();
  }
  // Майстер: токен сесії після входу за логіном і паролем; заблокований майстер одразу втрачає доступ
  const s = masterBySession(token);
  if (s) {
    req.role = 'master';
    req.masterId = s.id;
    req.masterName = s.name;
    return next();
  }
  loginLimiter.hit(req.ip);
  return res.status(401).json({ error: 'Невірний токен або сесія завершилась' });
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
  if (!partial || body.price_note !== undefined) out.price_note = String(body.price_note ?? '').trim().slice(0, 60);
  if (!partial || body.repeat_weeks !== undefined) {
    const w = Number(body.repeat_weeks ?? 0);
    if (!Number.isInteger(w) || w < 0 || w > 52) return { error: 'Повторний візит: від 0 до 52 тижнів (0 — не нагадувати)' };
    out.repeat_weeks = w;
  }
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  const courseError = validateCourse(body, out, partial);
  if (courseError) return { error: courseError };
  if (out.course_next_service_id && !db.prepare('SELECT 1 FROM services WHERE id = ?').get(out.course_next_service_id)) {
    return { error: 'Курс: послугу для повторних візитів не знайдено' };
  }
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
app.use(securityHeaders);
app.use(express.json({ limit: '100kb' }));
// Головна сторінка з тегами для прев'ю посилання (Telegram, Viber, Facebook) і пошуковиків.
// Повна адреса картинки береться із запиту, бо месенджери не розуміють відносних шляхів.
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const attr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Адреса сайту для посилань у повідомленнях бота: з налаштувань кабінету, інакше остання, з якої відкривали сайт
let lastOrigin = '';
const siteUrl = () => readStudio().site_url || lastOrigin;

app.get(['/', '/index.html'], (req, res) => {
  const s = readStudio();
  const origin = `${req.protocol}://${req.get('host')}`;
  lastOrigin = origin; // запасна адреса сайту для посилань у Telegram, якщо в адмінці її не вказано
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
  ].join('\n') +
    `\n<link rel="canonical" href="${attr((siteUrl() || origin).replace(/\/+$/, '') + '/')}">\n` +
    localBusinessJsonLd(db, s, (siteUrl() || origin).replace(/\/+$/, ''));
  res.type('html').send(INDEX_HTML.replace('<!--SEO-->', () => tags).replace('<title>Онлайн-запис до подолога</title>', `<title>${attr(title)}</title>`));
});

setupHealth({ app, db, root: path.join(__dirname, '..') });
app.use(express.static(PUBLIC_DIR));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// ---------- Публічне API ----------
app.get('/api/services', (req, res) => {
  res.json(db.prepare(`SELECT id, name, description, duration_min, price_uah, price_note FROM services s WHERE active = 1
    AND EXISTS (SELECT 1 FROM master_services ms JOIN masters m ON m.id = ms.master_id WHERE ms.service_id = s.id AND m.status = 'active')
    ORDER BY id`).all());
});

// Активні майстри для вибору на сайті і послуги, які робить кожен
app.get('/api/masters', (req, res) => {
  const svc = db.prepare('SELECT service_id FROM master_services WHERE master_id = ?');
  const extra = db.prepare('SELECT bio, photo FROM masters WHERE id = ?');
  res.json(activeMasters(db).map((m) => {
    const x = extra.get(m.id);
    return { id: m.id, name: m.name, bio: x.bio, photo: x.photo ? '/media/masters/' + x.photo : '', services: svc.all(m.id).map((r) => r.service_id) };
  }));
});
// Фото майстрів зберігаються поруч із базою (data/uploads/masters), а не в public
app.get('/media/masters/:file', (req, res) => {
  const file = String(req.params.file);
  if (!/^\d+-[a-f0-9]{16}\.(jpg|png|webp)$/.test(file)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(DATA_DIR, 'uploads', 'masters', file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});
// masterId із запиту: число або порожньо («будь-який вільний»)
const masterParam = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

// Поля кабінету й максимальна довжина кожного. name обов'язкове, решта може бути порожньою.
const STUDIO_FIELDS = {
  name: 80, tagline: 120, address: 200, phone: 40, city: 80, review_url: 300,
  promo_first: 400, promo_friend: 400, promo_gift: 400, partners: 600,
  master_name: 80, master_about: 2000, faq: 6000, stat_years: 6, stat_clients: 6, site_url: 200,
  owner_legal: 120,
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
  const service = db.prepare('SELECT id, duration_min FROM services WHERE id = ? AND active = 1').get(Number(req.query.serviceId));
  const date = String(req.query.date || '');
  if (!service) return res.status(400).json({ error: 'Невідома послуга' });
  if (!isBookableDate(date, HORIZON_DAYS)) return res.status(400).json({ error: `Запис відкрито від сьогодні до ${maxDateStr(HORIZON_DAYS)}` });
  res.json({ date, slots: freeSlots(db, date, service.duration_min, { masterId: masterParam(req.query.masterId), serviceId: service.id }) });
});

// Найближчий день з вільним часом для послуги, щоб клієнт одразу бачив записи, а не порожню дату
app.get('/api/next-slot', (req, res) => {
  const service = db.prepare('SELECT id, duration_min FROM services WHERE id = ? AND active = 1').get(Number(req.query.serviceId));
  if (!service) return res.status(400).json({ error: 'Невідома послуга' });
  const opts = { masterId: masterParam(req.query.masterId), serviceId: service.id };
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = addDays(todayStr(), i);
    if (!isBookableDate(date, HORIZON_DAYS)) break;
    const slots = freeSlots(db, date, service.duration_min, opts);
    if (slots.length) return res.json({ date, slots });
  }
  res.json({ date: null, slots: [] });
});

// Перевірка вільного часу і запис виконуються в одній транзакції, тому два клієнти не займуть один слот.
const last9 = (phone) => phone.replace(/\D/g, '').slice(-9); // номер без коду країни, щоб +380 50... і 050... збігалися

const bookTx = db.transaction(({ service, date, time, name, phone, comment, masterId, skipPhoneLimit = false, status = 'new' }) => {
  const samePhone = db
    .prepare("SELECT client_phone FROM appointments WHERE date >= ? AND status != 'cancelled'")
    .all(todayStr())
    .filter((r) => last9(r.client_phone) === last9(phone)).length;
  if (!skipPhoneLimit && samePhone >= MAX_ACTIVE_PER_PHONE) {
    throw Object.assign(
      new Error(`На цей номер уже є ${MAX_ACTIVE_PER_PHONE} активні записи. Щоб додати ще, напишіть оператору в чат`),
      { status: 429 }
    );
  }
  // Конкретний майстер або, для «будь-кого», вільний майстер з найменшою кількістю записів цього дня
  const master = pickMaster(db, date, service.duration_min, time, { masterId, serviceId: service.id });
  if (!master) {
    throw Object.assign(new Error('Цей час уже недоступний, оберіть інший'), { status: 409 });
  }
  const end = toHHMM(toMin(time) + service.duration_min);
  const remindCode = 'r' + crypto.randomBytes(9).toString('base64url');
  const info = db
    .prepare('INSERT INTO appointments (service_id, date, start_time, end_time, client_name, client_phone, remind_code, client_comment, master_id, status, price_uah) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(service.id, date, time, end, name, phone, remindCode, comment ?? '', master, status, service.price_uah ?? null); // ціна на момент запису — для звіту
  return { id: info.lastInsertRowid, remindCode, masterId: master };
});

// Особисте сповіщення майстру в його Telegram, якщо він підключив бота в адмінці
function notifyMasterOf(masterId, text) {
  const chat = masterId && db.prepare("SELECT tg_chat_id FROM masters WHERE id = ? AND status = 'active'").get(masterId)?.tg_chat_id;
  if (chat) telegram.sendToClient(chat, text);
}

// Скільки годин до візиту клієнт може сам скасувати чи перенести запис (налаштовується в адмінці)
const DEFAULT_CHANGE_HOURS = 24;
function readChangeHours() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'change_hours'").get();
  const n = Number(row?.value);
  return CHANGE_HOUR_OPTIONS.includes(n) ? n : DEFAULT_CHANGE_HOURS;
}
const accounts = setupAccounts({
  app, db, telegram, freeSlots, todayStr, isBookableDate, isTime,
  horizonDays: HORIZON_DAYS, makeLimiter, notifyMaster: (t) => telegram.notifyMaster(t), changeHours: readChangeHours, notifyMasterOf,
  live: (kind, a) => liveAppt(kind, a),
});


app.post('/api/appointments', (req, res) => {
  const { serviceId, date, time, name, phone, comment, masterId } = req.body || {};
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
    const cleanComment = String(comment ?? '').trim().slice(0, 500);
    const wantMaster = masterParam(masterId);
    if (wantMaster && !masterOffers(db, wantMaster, service.id)) return res.status(400).json({ error: 'Цей майстер не виконує обрану послугу' });
    const { id, remindCode, masterId: assigned } = bookTx({ service, date, time, name: cleanName, phone: cleanPhone, comment: cleanComment, masterId: wantMaster });
    const masterName = db.prepare('SELECT name FROM masters WHERE id = ?').get(assigned)?.name || '';
    const streak = noShowStreaks().get(last9(cleanPhone)) || 0;
    const warn = streak >= 2 ? `\n⚠️ Цей клієнт не прийшов ${streak} рази поспіль` : '';
    notifyMasterOf(assigned, `🗓 Новий запис до вас\n${service.name}\n${date.split('-').reverse().join('.')} о ${time}\n${cleanName}, ${cleanPhone}${cleanComment ? '\nКоментар: ' + cleanComment : ''}${warn}`);
    bookingLimiter.hit(req.ip);
    telegram.newAppointment({ service: service.name, date, time, name: cleanName, phone: cleanPhone, comment: cleanComment, master: masterName, warn });
    liveAppt('new', { id: Number(id), master_id: assigned, date, start_time: time, client_name: cleanName, service: service.name, master: masterName });
    res.status(201).json({ id: Number(id), date, time, service: service.name, master: masterName, remindLink: telegram.remindLink(remindCode) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ---------- Вхід майстра в адмінку ----------
const MASTER_SESSION_DAYS = 30;
app.post('/api/master-login', (req, res) => {
  if (loginLimiter.blocked(req.ip)) {
    return res.status(429).json({ error: `Забагато невдалих спроб входу. Спробуйте через ${loginLimiter.minutesLeft(req.ip)} хв` });
  }
  const m = db.prepare("SELECT * FROM masters WHERE login = ? AND status != 'deleted'").get(String(req.body?.login ?? '').trim());
  if (!m || !checkMasterPassword(String(req.body?.password ?? ''), m.pass_hash)) {
    loginLimiter.hit(req.ip);
    return res.status(401).json({ error: 'Невірний логін або пароль' });
  }
  if (m.status === 'blocked') return res.status(403).json({ error: 'Доступ заблоковано. Зверніться до адміністратора' });
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO master_sessions (token_hash, master_id, expires_at) VALUES (?, ?, ?)')
    .run(sha(token), m.id, Date.now() + MASTER_SESSION_DAYS * 86400 * 1000);
  res.json({ token, name: m.name });
});

// ---------- Адмін API ----------
app.use('/api/admin', requireAdmin);

// Майстрові доступні лише його записи, клієнти, графік, блокування й черга. Решта — тільки суперадміну.
const MASTER_ROUTES = [
  /^GET \/me$/, /^POST \/logout$/,
  /^GET \/close-day$/, /^GET \/close-day\/count$/, /^POST \/close-day$/,
  /^GET \/appointments$/, /^PATCH \/appointments\/\d+$/, /^PUT \/appointments\/\d+\/note$/, /^GET \/appointments\/\d+\/review-link$/,
  /^GET \/clients$/, /^GET \/clients\/\d{9}$/, /^PUT \/clients\/\d{9}\/note$/, /^GET \/client-search$/,
  /^GET \/clients\/\d{9}\/course$/, /^GET \/clients\/\d{9}\/photos$/, /^POST \/clients\/\d{9}\/photos$/, /^GET \/clients\/\d{9}\/photo-consent$/, /^PUT \/clients\/\d{9}\/photo-consent$/, /^GET \/client-photos\/\d+\/file$/, /^DELETE \/client-photos\/\d+$/,
  /^GET \/schedule$/, /^PUT \/schedule\/\d$/, /^GET \/breaks$/, /^POST \/breaks$/, /^DELETE \/breaks\/\d+$/,
  /^GET \/blocks$/, /^POST \/blocks$/, /^DELETE \/blocks\/\d+$/, /^GET \/waitlist$/, /^DELETE \/waitlist\/\d+$/,
  /^POST \/appointments$/, /^PATCH \/appointments\/\d+\/move$/, /^GET \/slots$/, /^GET \/calendar$/,
  /^POST \/me\/telegram$/, /^DELETE \/me\/telegram$/,
  /^GET \/me\/calendar$/, /^POST \/me\/calendar$/, /^DELETE \/me\/calendar$/,
];
app.use('/api/admin', (req, res, next) => {
  if (req.role === 'super' || MASTER_ROUTES.some((rx) => rx.test(`${req.method} ${req.path}`))) return next();
  res.status(403).json({ error: 'Недостатньо прав: це доступно лише адміністратору' });
});

// Який майстер у запиті: майстер — завжди він сам; суперадмін — обраний через masterId (або всі, якщо не обрано)
const scopeMaster = (req) => {
  if (req.role === 'master') return req.masterId;
  const v = Number(req.query.masterId ?? req.body?.master_id);
  return Number.isInteger(v) && v > 0 ? v : null;
};
const ownsAppt = (req, id) => req.role === 'super' || !!db.prepare('SELECT 1 FROM appointments WHERE id = ? AND master_id = ?').get(id, req.masterId);
// Для графіка майстер обов'язковий: суперадмін має його обрати
function scheduleMaster(req, res) {
  const id = scopeMaster(req);
  if (!id || !db.prepare("SELECT 1 FROM masters WHERE id = ? AND status != 'deleted'").get(id)) {
    res.status(400).json({ error: 'Оберіть майстра' });
    return null;
  }
  return id;
}

app.get('/api/admin/me', (req, res) => res.json(req.role === 'super'
  ? { role: 'super' }
  : { role: 'master', master: { id: req.masterId, name: req.masterName },
      telegram: !!db.prepare('SELECT tg_chat_id FROM masters WHERE id = ?').get(req.masterId)?.tg_chat_id }));

// Майстер підключає свій Telegram: бот надсилатиме йому його нові записи, скасування й перенесення
const MASTER_LINK_MINUTES = 15;
app.post('/api/admin/me/telegram', (req, res) => {
  if (req.role !== 'master') return res.status(400).json({ error: 'Це налаштування для майстра' });
  const code = crypto.randomBytes(6).toString('base64url');
  db.prepare("INSERT INTO account_codes (kind, key, value, expires_at) VALUES ('mlink', ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
    .run(sha(code), String(req.masterId), Date.now() + MASTER_LINK_MINUTES * 60000);
  const link = telegram.remindLink(`m_${code}`);
  if (!link) return res.status(503).json({ error: 'Бот Telegram ще не налаштований. Попросіть адміністратора налаштувати його у вкладці «Кабінет»' });
  res.json({ link, minutes: MASTER_LINK_MINUTES });
});
app.delete('/api/admin/me/telegram', (req, res) => {
  if (req.role === 'master') db.prepare('UPDATE masters SET tg_chat_id = NULL WHERE id = ?').run(req.masterId);
  res.json({ ok: true });
});
function linkMasterTelegram(code, chatId) {
  const row = db.prepare("SELECT value, expires_at FROM account_codes WHERE kind = 'mlink' AND key = ?").get(sha(code));
  if (!row || row.expires_at < Date.now()) return 'Посилання застаріло. Згенеруйте нове в адмінці.';
  db.prepare("DELETE FROM account_codes WHERE kind = 'mlink' AND key = ?").run(sha(code));
  db.prepare('UPDATE masters SET tg_chat_id = ? WHERE id = ?').run(chatId, Number(row.value));
  return '✅ Готово! Тепер ваші нові записи, скасування й перенесення надходитимуть сюди.';
}
app.post('/api/admin/logout', (req, res) => {
  if (req.role === 'master') db.prepare('DELETE FROM master_sessions WHERE token_hash = ?').run(sha((req.headers.authorization || '').slice(7)));
  res.json({ ok: true });
});
setupMasterAdmin({ app, db, todayStr, dataDir: DATA_DIR, express });
// Фото стану стоп: майстер бачить лише клієнтів, яких веде (та сама перевірка, що для нотаток про клієнта)
setupClientPhotos({
  app, db, dataDir: DATA_DIR,
  canSeeClient: (req, key) => req.role === 'super' || listClients(undefined, undefined, req.masterId).some((c) => c.key === key),
});
setupAdminAppointments({
  app, db, telegram, bookTx, masterFreeSlots, masterFreeAt, nowMin, freeSlots, masterOffers, isValidDate, isTime,
  toMin, toHHMM, todayStr, addDays, masterParam, ownsAppt, notifyMasterOf, last9,
  live: (kind, a, masters) => liveAppt(kind, a, masters),
  clientChat: (a) => reminders.chatFor(a), // оголошено нижче; викликається лише під час запиту
});
// «Майстер не вийде»: масова передача, перенесення чи скасування записів (лише суперадмін).
// setStatusTx і waitlist оголошені нижче, тому — через обгортки (викликаються вже під час запитів)
setupReassign({
  app, db, telegram, masterFreeSlots, masterFreeAt, workHours, bufferMin, nowMin, weekdayOf,
  toMin, toHHMM, todayStr, addDays, isValidDate, isTime, last9, notifyMasterOf,
  setStatus: (id, status) => setStatusTx(id, status),
  waitlistCheck: () => waitlist.checkWaitlist().catch(() => {}),
  studioPhone: () => readStudio().phone,
  live: (kind, a, masters) => liveAppt(kind, a, masters),
});

// Відгуки: публічні маршрути і маршрути адмінки (останні вже під перевіркою доступу)
setupReviews({ app, db, telegram, todayStr, siteUrl, last9 });
setupRepeatReminders({ db, telegram, todayStr, siteUrl, last9 });
setupCalendar({ app, db, todayStr, addDays });
setupCertificates({ app, db, todayStr, isValidDate });
setupHolidays({ app, db, todayStr, isValidDate, addDays });
setupChatTemplates({ app, db, readStudio });
setupReports({ app, db, todayStr, hasStarted: (a) => hasStarted(a) });
setupClientErase({
  app, db, dataDir: DATA_DIR, todayStr, last9, notifyMasterOf,
  waitlistCheck: () => waitlist.checkWaitlist().catch(() => {}),
  live: (kind, a, masters) => liveAppt(kind, a, masters),
});
materialsApply = setupMaterials({ app, db, notify: (t) => telegram.notifyMaster(t) }).applyVisit;
setupCourse({
  app, db, telegram, todayStr, siteUrl, last9,
  canSeeClient: (req, key) => req.role === 'super' || listClients(undefined, undefined, req.masterId).some((c) => c.key === key),
});
setupStats({ app, db, toMin, weekdayOf, last9 });
setupTips({ app, db, siteUrl, readStudio });
setupPrivacy({ app, readStudio });
setupSeo({ app, db, siteUrl });
const waitlist = setupWaitlist({
  app, db, telegram, freeSlots, isBookableDate, horizonDays: HORIZON_DAYS, todayStr, siteUrl, makeLimiter, last9,
});

// Налаштування годин для скасування й перенесення клієнтом (лише для адміна)
app.get('/api/admin/change-hours', (req, res) => res.json({ hours: readChangeHours(), options: CHANGE_HOUR_OPTIONS }));
app.put('/api/admin/change-hours', (req, res) => {
  const n = Number(req.body?.hours);
  if (!CHANGE_HOUR_OPTIONS.includes(n)) return res.status(400).json({ error: 'Оберіть один із варіантів: ' + CHANGE_HOUR_OPTIONS.join(', ') + ' год' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('change_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
  res.json({ hours: n });
});

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
  for (const k of ['stat_years', 'stat_clients']) {
    if (clean[k] && !/^\d{1,6}$/.test(clean[k])) return res.status(400).json({ error: 'Років досвіду й кількість клієнтів: лише ціле число' });
  }
  if (clean.site_url && !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(clean.site_url)) {
    return res.status(400).json({ error: 'Адреса сайту має починатися з https:// (або http://)' });
  }
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
  const streaks = noShowStreaks();
  res.json(
    db
      .prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.client_name, a.client_phone, a.status, a.client_comment,
                       a.master_id, a.service_id, a.client_confirmed_at, a.client_declined_at, m.name AS master, s.name AS service
                FROM appointments a JOIN services s ON s.id = a.service_id LEFT JOIN masters m ON m.id = a.master_id
                WHERE a.date BETWEEN ? AND ? AND (? IS NULL OR a.master_id = ?) ORDER BY a.date, a.start_time`)
      .all(from, to, scopeMaster(req), scopeMaster(req))
      .map((a) => ({ ...a, noshow_streak: streaks.get(last9(a.client_phone)) || 0 }))
  );
});

// Скасований запис можна повернути лише тоді, коли його час досі вільний від інших записів.
const setStatusTx = db.transaction((id, status) => {
  const appt = db.prepare('SELECT id, date, start_time, end_time, status, master_id FROM appointments WHERE id = ?').get(id);
  if (!appt) throw Object.assign(new Error('Запис не знайдено'), { status: 404 });
  if (appt.status === 'cancelled' && status !== 'cancelled') {
    const clash = db
      .prepare("SELECT 1 FROM appointments WHERE master_id = ? AND date = ? AND id != ? AND status != 'cancelled' AND start_time < ? AND end_time > ?")
      .get(appt.master_id, appt.date, id, appt.end_time, appt.start_time);
    if (clash) {
      throw Object.assign(new Error('Цей час уже зайнятий іншим записом. Спочатку скасуйте або перенесіть той запис'), { status: 409 });
    }
  }
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id);
  if (materialsApply) materialsApply(id, status);
});

// «Відбувся» і «Не прийшов» можна поставити лише після часу початку запису
const AFTER_START = ['done', 'no_show'];
const hasStarted = (a) => a.date < todayStr() || (a.date === todayStr() && toMin(a.start_time) <= nowMin());
app.patch('/api/admin/appointments/:id', (req, res) => {
  const status = req.body?.status;
  if (!['new', 'confirmed', 'cancelled', ...AFTER_START].includes(status)) return res.status(400).json({ error: 'Некоректний статус' });
  if (!ownsAppt(req, Number(req.params.id))) return res.status(403).json({ error: 'Це запис іншого майстра' });
  if (AFTER_START.includes(status)) {
    const a = db.prepare('SELECT date, start_time FROM appointments WHERE id = ?').get(Number(req.params.id));
    if (a && !hasStarted(a)) return res.status(400).json({ error: 'Позначити «Відбувся» чи «Не прийшов» можна лише після початку запису' });
  }
  try {
    setStatusTx(Number(req.params.id), status);
    const c = apptForClient('a.id = ?', Number(req.params.id));
    if (c) liveAppt('changed', c);
    if (status === 'cancelled') {
      notifyClientCancelled(Number(req.params.id));
      if (c && req.role !== 'master') notifyMasterOf(c.master_id, `❌ Запис скасовано\n${c.service}, ${telegram.fmtDate(c.date)} о ${c.start_time}\n${c.client_name}, ${c.client_phone}`);
      waitlist.checkWaitlist().catch(() => {}); // звільнився час: може, хтось на нього чекає
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

// «Закрити день»: записи, що вже почались, але досі «Нова» чи «Підтверджено» (за останні CLOSE_DAYS днів).
// Позначаються за раз: «Відбувся» (списує матеріали, рахується у статистиці), «Не прийшов» або «Скасовано».
// Клієнтам нічого не надсилається — це минулі записи. Майстер бачить і закриває лише свої.
const CLOSE_DAYS = 60;
function unclosedAppts(req) {
  const today = todayStr();
  const mid = scopeMaster(req);
  return db.prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.status, a.client_name, a.client_phone, a.master_id,
                            m.name AS master, s.name AS service
                     FROM appointments a JOIN services s ON s.id = a.service_id LEFT JOIN masters m ON m.id = a.master_id
                     WHERE a.status IN ('new', 'confirmed') AND a.date BETWEEN date(?, '-${CLOSE_DAYS} day') AND ?
                       AND (? IS NULL OR a.master_id = ?)
                     ORDER BY a.date, a.start_time`)
    .all(today, today, mid, mid)
    .filter(hasStarted);
}
app.get('/api/admin/close-day/count', (req, res) => res.json({ count: unclosedAppts(req).length }));
app.get('/api/admin/close-day', (req, res) => res.json(unclosedAppts(req)));
app.post('/api/admin/close-day', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'Немає списку записів' });
  if (items.length > 500) return res.status(400).json({ error: 'Забагато записів за раз' });
  const results = items.map((it) => {
    const id = Number(it?.id);
    const status = it?.status;
    if (!['done', 'no_show', 'cancelled'].includes(status)) return { id, ok: false, error: 'Некоректний статус' };
    const a = db.prepare('SELECT id, date, start_time, status, master_id FROM appointments WHERE id = ?').get(id);
    if (!a || !ownsAppt(req, id)) return { id, ok: false, error: 'Запис не знайдено' };
    if (!['new', 'confirmed'].includes(a.status)) return { id, ok: false, error: 'Запис уже позначено' };
    if (!hasStarted(a)) return { id, ok: false, error: 'Запис ще не почався' };
    try {
      setStatusTx(id, status);
      return { id, ok: true, status, master_id: a.master_id };
    } catch (e) {
      return { id, ok: false, error: e.message };
    }
  });
  const ok = results.filter((r) => r.ok);
  if (ok.length) liveAppt('changed', {}, [...new Set(ok.map((r) => r.master_id))]);
  res.json({
    results: results.map(({ master_id, ...r }) => r),
    counts: { done: ok.filter((r) => r.status === 'done').length, no_show: ok.filter((r) => r.status === 'no_show').length,
      cancelled: ok.filter((r) => r.status === 'cancelled').length, failed: results.length - ok.length },
  });
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

// Кнопки «Буду» / «Скасувати» під нагадуванням (src/reminder-buttons.js)
const reminders = setupReminderButtons({
  db, telegram, changeHours: readChangeHours, todayStr, last9, notifyMasterOf,
  setStatus: (id, status) => setStatusTx(id, status),
  live: (kind, a) => liveAppt(kind, a),
  waitlistCheck: () => waitlist.checkWaitlist().catch(() => {}),
  readStudio: () => readStudio(),
});

// Клієнт натиснув «Start» за посиланням із сайту: прив'язуємо його чат до запису
telegram.onStart((code, chatId) => {
  if (code.startsWith('acc_')) return accounts.linkTelegram(code.slice(4), chatId);
  if (code.startsWith('w_')) return waitlist.linkTelegram(code.slice(2), chatId);
  if (code.startsWith('m_')) return linkMasterTelegram(code.slice(2), chatId);
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

// Нагадування за добу: чат, прив'язаний до запису, або чат кабінету клієнта з тим самим телефоном
async function sendDueReminders() {
  const rows = db.prepare(`SELECT a.*, s.name AS service FROM appointments a JOIN services s ON s.id = a.service_id
    WHERE a.reminded = 0 AND a.status IN ('new', 'confirmed') AND a.date BETWEEN ? AND date(?, '+2 day')`)
    .all(todayStr(), todayStr());
  for (const a of rows) {
    const left = msUntil(a.date, a.start_time);
    if (left <= 0 || left > REMIND_BEFORE_MS) continue;
    const chat = reminders.chatFor(a);
    if (!chat) continue;
    db.prepare('UPDATE appointments SET reminded = 1 WHERE id = ?').run(a.id); // спершу позначка: двічі не нагадаємо
    const r = reminders.reminder(a);
    await telegram.sendToClient(chat, r.text, r.buttons);
  }
}
// Перевірка щоп'ять хвилин; REMINDER_* — лише для автотестів
setInterval(() => sendDueReminders().catch((e) => console.error('Нагадування:', e.message)), Number(process.env.REMINDER_INTERVAL_MS) || 5 * 60 * 1000).unref();
setTimeout(() => sendDueReminders().catch(() => {}), Number(process.env.REMINDER_DELAY_MS) || 15000).unref();

function notifyClientCancelled(id) {
  const a = apptForClient('a.id = ?', id);
  const chat = a && reminders.chatFor(a);
  if (!chat || msUntil(a.date, a.start_time) <= 0) return;
  telegram.sendToClient(chat,
    `Ваш запис ${a.service}, ${telegram.fmtDate(a.date)} о ${a.start_time}, скасовано.` +
    (readStudio().phone ? ` Щоб обрати інший час, запишіться на сайті або подзвоніть: ${readStudio().phone}.` : ' Щоб обрати інший час, запишіться на сайті.'));
}

// ---------- Клієнти ----------
// Клієнт визначається за останніми 9 цифрами телефону, тому +380 67 123 45 67 і 067 123 45 67 це одна людина.
const isClientKey = (k) => /^\d{9}$/.test(k);
// Скільки разів поспіль клієнт не прийшов (за всіма майстрами); обнуляється першим візитом після неявок
function noShowStreaks() {
  const today = todayStr();
  const m = new Map();
  for (const r of db.prepare("SELECT client_phone, date, status FROM appointments WHERE status != 'cancelled' ORDER BY date, start_time").all()) {
    const k = last9(r.client_phone);
    if (r.status === 'no_show') m.set(k, (m.get(k) || 0) + 1);
    else if (r.date < today) m.set(k, 0);
  }
  return m;
}
const NOTE_MAX = 5000;

// mode: 'active' — лише активні, 'archived' — лише в архіві, без параметра — усі (для вивантаження)
// masterId: лише клієнти, які були записані до цього майстра
function listClients(q, mode, masterId = null) {
  const today = todayStr();
  const rows = db
    .prepare('SELECT date, start_time, client_name, client_phone, status, updated_at, master_id FROM appointments ORDER BY date, start_time')
    .all()
    .filter((r) => !masterId || r.master_id === masterId);
  const notes = new Map(db.prepare('SELECT phone_key, note, updated_at FROM client_notes').all().map((r) => [r.phone_key, r]));
  const archive = new Map(db.prepare('SELECT phone_key, pinned, manual, archived_at FROM client_archive').all().map((r) => [r.phone_key, r]));
  const map = new Map();
  for (const r of rows) {
    const key = last9(r.client_phone);
    if (!map.has(key)) map.set(key, { key, name: '', phone: '', visits: 0, cancelled: 0, no_shows: 0, noshow_streak: 0, last_visit: null, next_visit: null, last_change: '' });
    const c = map.get(key);
    if (r.updated_at > c.last_change) c.last_change = r.updated_at;
    c.name = r.client_name;   // рядки йдуть за датою, тому залишаються ім'я і телефон з найновішого запису
    c.phone = r.client_phone;
    if (r.status === 'cancelled') {
      c.cancelled += 1;
    } else if (r.status === 'no_show') {
      c.no_shows += 1;
      c.noshow_streak += 1; // неявки поспіль: обнуляється першим візитом після них
    } else if (r.date < today) {
      c.visits += 1;
      c.noshow_streak = 0;
      c.last_visit = r.date;
    } else if (!c.next_visit) {
      c.next_visit = r.date;
    }
  }
  let list = [...map.values()].map((c) => {
    const n = notes.get(c.key);
    if (n && n.updated_at > c.last_change) c.last_change = n.updated_at;
    const a = archive.get(c.key);
    // Вручну заархівований клієнт повертається в активні одразу після нової дії з його записами
    const archived = !!a && a.pinned === 0 && !(a.manual && c.last_change > a.archived_at);
    return { ...c, has_note: !!(n && n.note), archived };
  });
  if (mode === 'active') list = list.filter((c) => !c.archived);
  if (mode === 'archived') list = list.filter((c) => c.archived);
  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    const digits = needle.replace(/\D/g, '');
    list = list.filter((c) => c.name.toLowerCase().includes(needle) || (digits && c.phone.replace(/\D/g, '').includes(digits)));
  }
  return list.sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}

app.get('/api/admin/clients', (req, res) => {
  res.json(listClients(req.query.q, req.query.archived === '1' ? 'archived' : 'active', scopeMaster(req)));
});

// Пошук клієнта для форми запису: ім'я (частина слова, без різниці великих літер) або телефон (від 3 цифр,
// у будь-якому записі: +380 50…, 050…). Шукає і в архіві. Майстер — лише серед своїх клієнтів. До 10 результатів.
const SEARCH_LIMIT = 10;
const normName = (s) => String(s || '').toLowerCase().replace(/[’ʼ`´]/g, "'").replace(/\s+/g, ' ').trim();
app.get('/api/admin/client-search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const all = listClients(undefined, undefined, req.role === 'master' ? req.masterId : null);
  let found;
  if (/^[\d\s()+-]+$/.test(q)) {
    const d = q.replace(/\D/g, '');
    if (d.length < 3) return res.json([]);
    // +380 50… і 050… — один номер: порівнюємо і повну форму, і національну (0 + останні 9 цифр)
    const variants = [d];
    if (d.startsWith('380')) variants.push(d.slice(2));
    if (d.startsWith('0')) variants.push('38' + d);
    found = all
      .map((c) => {
        const full = c.phone.replace(/\D/g, '');
        const national = '0' + c.key;
        const at = Math.min(...variants.flatMap((v) => [full.indexOf(v), national.indexOf(v)]).filter((i) => i >= 0));
        return Number.isFinite(at) ? { c, rank: at === 0 ? 0 : 1 } : null;
      })
      .filter(Boolean);
  } else {
    const needle = normName(q);
    const words = needle.split(' ');
    found = all
      .map((c) => {
        const name = normName(c.name);
        if (!words.every((w) => name.includes(w))) return null;
        const rank = name.startsWith(needle) ? 0 : name.split(' ').some((part) => part.startsWith(words[0])) ? 1 : 2;
        return { c, rank };
      })
      .filter(Boolean);
  }
  // точніші збіги вище; серед рівних — ті, хто приходив нещодавно
  found.sort((a, b) => a.rank - b.rank || String(b.c.last_visit || b.c.next_visit || '').localeCompare(String(a.c.last_visit || a.c.next_visit || '')) || a.c.name.localeCompare(b.c.name, 'uk'));
  res.json(found.slice(0, SEARCH_LIMIT).map(({ c }) => ({
    key: c.key, name: c.name, phone: c.phone, visits: c.visits, last_visit: c.last_visit, next_visit: c.next_visit,
    noshow_streak: c.noshow_streak, archived: c.archived, has_note: c.has_note,
  })));
});

// Архів клієнтів: клієнт без змін довше за обраний термін переходить в архів. Будь-яка нова зміна повертає його в активні.
const ARCHIVE_MONTH_OPTIONS = [6, 12, 24];
function readArchiveMonths() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'archive_months'").get();
  const n = Number(row?.value);
  return ARCHIVE_MONTH_OPTIONS.includes(n) ? n : 12;
}
function syncArchive() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - readArchiveMonths());
  const cutoffStr = cutoff.toISOString().replace('T', ' ').slice(0, 19); // час у базі за UTC
  const stale = listClients(undefined).filter((c) => c.last_change && c.last_change < cutoffStr);
  const staleKeys = new Set(stale.map((c) => c.key));
  db.transaction(() => {
    const add = db.prepare('INSERT OR IGNORE INTO client_archive (phone_key) VALUES (?)');
    const drop = db.prepare('DELETE FROM client_archive WHERE phone_key = ?');
    const row = db.prepare('SELECT manual, archived_at FROM client_archive WHERE phone_key = ?');
    for (const c of listClients(undefined)) {
      if (staleKeys.has(c.key)) { add.run(c.key); continue; }
      const r = row.get(c.key);
      // Ручний архів не скасовуємо, поки після нього не було нових змін
      if (r && r.manual && !(c.last_change > r.archived_at)) continue;
      drop.run(c.key);
    }
  })();
}

app.get('/api/admin/archive-months', (req, res) => res.json({ months: readArchiveMonths(), options: ARCHIVE_MONTH_OPTIONS }));
app.put('/api/admin/archive-months', (req, res) => {
  const n = Number(req.body?.months);
  if (!ARCHIVE_MONTH_OPTIONS.includes(n)) return res.status(400).json({ error: 'Оберіть один із варіантів: ' + ARCHIVE_MONTH_OPTIONS.join(', ') + ' міс.' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('archive_months', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
  syncArchive();
  res.json({ months: n });
});

// Повернути клієнта з архіву вручну: він лишається активним, доки знову не стане неактивним
app.post('/api/admin/clients/:key/restore', (req, res) => {
  const key = req.params.key;
  if (!isClientKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
  db.prepare('INSERT INTO client_archive (phone_key, pinned) VALUES (?, 1) ON CONFLICT(phone_key) DO UPDATE SET pinned = 1, manual = 0').run(key);
  res.json({ ok: true });
});

// Перенести клієнта в архів вручну. Дані не видаляються: клієнта можна повернути кнопкою «Повернути»
app.post('/api/admin/clients/:key/archive', (req, res) => {
  const key = req.params.key;
  if (!isClientKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
  db.prepare(`INSERT INTO client_archive (phone_key, pinned, manual, archived_at) VALUES (?, 0, 1, datetime('now'))
              ON CONFLICT(phone_key) DO UPDATE SET pinned = 0, manual = 1, archived_at = datetime('now')`).run(key);
  res.json({ ok: true });
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
    .prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.client_name, a.client_phone, a.status, a.note, a.master_id, m.name AS master, s.name AS service
              FROM appointments a JOIN services s ON s.id = a.service_id LEFT JOIN masters m ON m.id = a.master_id
              ORDER BY a.date DESC, a.start_time DESC`)
    .all()
    .filter((a) => last9(a.client_phone) === key && (req.role === 'super' || a.master_id === req.masterId));
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
  if (req.role === 'master' && !listClients(undefined, undefined, req.masterId).some((c) => c.key === key)) {
    return res.status(403).json({ error: 'Це клієнт іншого майстра' });
  }
  const note = String(req.body?.note ?? '').trim();
  if (note.length > NOTE_MAX) return res.status(400).json({ error: `Нотатка: не більше ${NOTE_MAX} символів` });
  db.prepare(`INSERT INTO client_notes (phone_key, note) VALUES (?, ?)
              ON CONFLICT(phone_key) DO UPDATE SET note = excluded.note, updated_at = datetime('now')`).run(key, note);
  res.json({ ok: true });
});

app.put('/api/admin/appointments/:id/note', (req, res) => {
  const note = String(req.body?.note ?? '').trim();
  if (note.length > NOTE_MAX) return res.status(400).json({ error: `Нотатка: не більше ${NOTE_MAX} символів` });
  if (!ownsAppt(req, Number(req.params.id))) return res.status(403).json({ error: 'Це запис іншого майстра' });
  const changed = db.prepare('UPDATE appointments SET note = ? WHERE id = ?').run(note, Number(req.params.id)).changes;
  if (!changed) return res.status(404).json({ error: 'Запис не знайдено' });
  res.json({ ok: true });
});

app.get('/api/admin/services', (req, res) => {
  res.json(db.prepare('SELECT id, name, description, duration_min, price_uah, price_note, repeat_weeks, course_visits, course_interval_days, course_next_service_id, active FROM services ORDER BY id').all());
});

app.post('/api/admin/services', (req, res) => {
  const v = validateService(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const d = { description: '', price_uah: 0, price_note: '', repeat_weeks: 0, active: 1, course_visits: 0, course_interval_days: 0, course_next_service_id: null, ...v.data };
  const info = db
    .prepare('INSERT INTO services (name, description, duration_min, price_uah, price_note, repeat_weeks, active, course_visits, course_interval_days, course_next_service_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(d.name, d.description, d.duration_min, d.price_uah, d.price_note, d.repeat_weeks, d.active, d.course_visits, d.course_interval_days, d.course_next_service_id);
  db.prepare("INSERT OR IGNORE INTO master_services (master_id, service_id) SELECT id, ? FROM masters WHERE status = 'active'").run(Number(info.lastInsertRowid));
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.patch('/api/admin/services/:id', (req, res) => {
  const v = validateService(req.body || {}, true);
  if (v.error) return res.status(400).json({ error: v.error });
  if (!updateRow('services', Number(req.params.id), v.data)) return res.status(404).json({ error: 'Послугу не знайдено' });
  res.json({ ok: true });
});

// Прибирання робочого місця між клієнтами: хвилини, що резервуються після кожного візиту
app.get('/api/admin/buffer', (req, res) => res.json({ minutes: bufferMin(db) }));

app.put('/api/admin/buffer', (req, res) => {
  const n = Number(req.body?.minutes);
  if (!Number.isInteger(n) || n < 0 || n > 120) return res.status(400).json({ error: 'Прибирання: від 0 до 120 хвилин' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('buffer_min', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
  res.json({ minutes: n });
});

app.get('/api/admin/schedule', (req, res) => {
  const mid = scheduleMaster(req, res);
  if (!mid) return;
  res.json(db.prepare('SELECT weekday, start_time, end_time FROM master_hours WHERE master_id = ? ORDER BY weekday').all(mid));
});

app.put('/api/admin/schedule/:weekday', (req, res) => {
  const wd = Number(req.params.weekday);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return res.status(400).json({ error: 'День: від 0 (Пн) до 6 (Нд)' });
  const mid = scheduleMaster(req, res);
  if (!mid) return;
  const { start_time, end_time } = req.body || {};
  const upsert = db.prepare(`INSERT INTO master_hours (master_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)
    ON CONFLICT(master_id, weekday) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time`);
  if (start_time === null || start_time === undefined) {
    upsert.run(mid, wd, null, null);
    return res.json({ ok: true });
  }
  if (!isTime(start_time) || !isTime(end_time) || toMin(start_time) >= toMin(end_time)) {
    return res.status(400).json({ error: 'Початок має бути раніше за кінець' });
  }
  upsert.run(mid, wd, start_time, end_time);
  res.json({ ok: true });
});

app.get('/api/admin/blocks', (req, res) => {
  const mid = scheduleMaster(req, res);
  if (!mid) return;
  const date = isValidDate(req.query.date) ? req.query.date : todayStr();
  res.json(db.prepare('SELECT id, date, start_time, end_time, note FROM blocks WHERE master_id = ? AND date = ? ORDER BY start_time').all(mid, date));
});

app.post('/api/admin/blocks', (req, res) => {
  const mid = scheduleMaster(req, res);
  if (!mid) return;
  const { date, start_time, end_time, note } = req.body || {};
  if (!isValidDate(date)) return res.status(400).json({ error: 'Некоректна дата' });
  if (!isTime(start_time) || !isTime(end_time) || toMin(start_time) >= toMin(end_time)) {
    return res.status(400).json({ error: 'Початок має бути раніше за кінець' });
  }
  const info = db
    .prepare('INSERT INTO blocks (date, start_time, end_time, note, master_id) VALUES (?, ?, ?, ?, ?)')
    .run(date, start_time, end_time, String(note ?? '').trim().slice(0, 100), mid);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.delete('/api/admin/blocks/:id', (req, res) => {
  if (req.role === 'master') db.prepare('DELETE FROM blocks WHERE id = ? AND master_id = ?').run(Number(req.params.id), req.masterId);
  else db.prepare('DELETE FROM blocks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Щотижневі перерви (обід тощо)
app.get('/api/admin/breaks', (req, res) => {
  const mid = scheduleMaster(req, res);
  if (!mid) return;
  res.json(db.prepare('SELECT id, weekday, start_time, end_time, note FROM breaks WHERE master_id = ? ORDER BY start_time, weekday').all(mid));
});

const addBreaksTx = db.transaction((masterId, weekdays, start, end, note) => {
  const ins = db.prepare('INSERT OR IGNORE INTO breaks (master_id, weekday, start_time, end_time, note) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  for (const wd of weekdays) added += ins.run(masterId, wd, start, end, note).changes;
  return added;
});

app.post('/api/admin/breaks', (req, res) => {
  const mid = scheduleMaster(req, res);
  if (!mid) return;
  const { weekdays, start_time, end_time, note } = req.body || {};
  const days = Array.isArray(weekdays) ? [...new Set(weekdays.map(Number))] : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return res.status(400).json({ error: 'Позначте хоча б один день тижня' });
  }
  if (!isTime(start_time) || !isTime(end_time) || toMin(start_time) >= toMin(end_time)) {
    return res.status(400).json({ error: 'Початок має бути раніше за кінець' });
  }
  const added = addBreaksTx(mid, days, start_time, end_time, String(note ?? '').trim().slice(0, 60));

  // Скільки вже наявних майбутніх записів потрапляє на нову перерву: вони залишаються чинними
  const clashes = db
    .prepare("SELECT date FROM appointments WHERE master_id = ? AND date >= ? AND status != 'cancelled' AND start_time < ? AND end_time > ?")
    .all(mid, todayStr(), end_time, start_time)
    .filter((a) => days.includes(weekdayOf(a.date))).length;
  res.status(201).json({ added, clashes });
});

app.delete('/api/admin/breaks/:id', (req, res) => {
  if (req.role === 'master') db.prepare('DELETE FROM breaks WHERE id = ? AND master_id = ?').run(Number(req.params.id), req.masterId);
  else db.prepare('DELETE FROM breaks WHERE id = ?').run(Number(req.params.id));
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

// Події записів наживо для адмінки: новий запис з сайту, скасування чи перенесення клієнтом, зміни персоналу.
// Адміністратор отримує всі; майстер — лише ті, що стосуються його записів (masters — кого стосується подія).
// kind: 'new' | 'cancelled' | 'moved' | 'confirmed' — від клієнта (адмінка показує й подає звук); 'changed' — тихе оновлення.
const staffSockets = new Set();
function liveAppt(kind, a, masters = [a.master_id]) {
  const payload = { type: 'appt', kind, id: a.id, date: a.date, start_time: a.start_time, client_name: a.client_name, service: a.service, master: a.master || '' };
  for (const s of staffSockets) {
    if (s.meta.role === 'master') {
      // Сесія закінчилась або майстра заблокували — канал закривається, події більше не йдуть
      if (!masterBySession(s.meta.token)) { staffSockets.delete(s); s.close(4003, 'forbidden'); continue; }
      if (!masters.map(Number).includes(s.meta.masterId)) continue;
    }
    send(s, payload);
  }
}

function detach(ws) {
  const id = ws.meta.conversationId;
  if (id && clients.has(id)) clients.get(id).delete(ws);
  ws.meta.conversationId = null;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const adminParam = url.searchParams.get('admin');
  let role = 'client';
  let masterId = null;
  if (adminParam !== null) {
    // Адміністратор (чат і всі записи) або майстер (лише події своїх записів, без чату).
    // Ті самі обмеження спроб, що й для входу через сторінку
    const ip = wsIp(req);
    const who = loginLimiter.blocked(ip) ? null : wsStaff(adminParam);
    if (!who) {
      if (!loginLimiter.blocked(ip)) loginLimiter.hit(ip);
      return ws.close(4003, 'forbidden');
    }
    role = who.role;
    masterId = who.masterId;
  }
  ws.meta = { role, masterId, token: role === 'client' ? null : adminParam, conversationId: null, hits: [] };

  if (role === 'admin') {
    admins.add(ws);
    send(ws, { type: 'admin_ready' });
  }
  if (role === 'admin' || role === 'master') staffSockets.add(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (ws.meta.role === 'admin') handleAdmin(ws, msg);
      else if (ws.meta.role === 'client') handleClient(ws, msg); // майстер у цьому каналі лише слухає події записів
    } catch (e) {
      console.error(e);
      send(ws, { type: 'error', error: 'Помилка сервера' });
    }
  });

  ws.on('close', () => {
    admins.delete(ws);
    staffSockets.delete(ws);
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
// Архів клієнтів оновлюється при старті й щогодини
syncArchive();
setInterval(syncArchive, 60 * 60 * 1000).unref();

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
