// Знижка на перший візит. Пропонується лише клієнтові, який ще не мав у нас жодного запису
// (скасовані й «не прийшов» не рахуються), і лише на послуги з позначкою services.first_discount.
// Відсоток — налаштування кабінету first_discount_pct (0 — знижки немає). Ціна в записі фіксується
// в момент запису: price_full_uah (за прайсом), discount_pct і price_uah (до сплати).
// Якщо в послуги немає числової ціни (лише «від 1380 грн» текстом), знижку обіцяємо, але суму не рахуємо.
// Знижка за друга («Приведи друга», src/friend-invite.js): той самий відсоток на будь-яку послугу, один раз за кожного
// друга, який прийшов. Дві знижки не додаються: новому клієнтові — на перший візит, решті — за друга, якщо є.
// discount_kind у записі: first або friend.
// Запрошений друг (номер є в «Приведи друга») отримує знижку на перший візит на будь-яку послугу, не лише позначену.
const { rewardInvite, isInvitedFriend } = require('./friend-invite');

const DEFAULT_PCT = 10; // так було в тексті акції «Знижка 10% на перший візит», який власник уже опублікував

function createFirstDiscountColumns(db) {
  const svc = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
  if (!svc.includes('first_discount')) db.exec('ALTER TABLE services ADD COLUMN first_discount INTEGER NOT NULL DEFAULT 0');
  const appt = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  if (!appt.includes('price_full_uah')) db.exec('ALTER TABLE appointments ADD COLUMN price_full_uah INTEGER');
  if (!appt.includes('discount_pct')) db.exec('ALTER TABLE appointments ADD COLUMN discount_pct INTEGER NOT NULL DEFAULT 0');
  if (!appt.includes('discount_kind')) db.exec('ALTER TABLE appointments ADD COLUMN discount_kind TEXT');
  // Один раз: відсоток 10 і позначка на «первинних» послугах (як у тексті акції: «первинну консультацію й огляд стоп»).
  // Власник може змінити обидва в адмінці.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'first_discount_v1'").get()) {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('first_discount_pct', ?)").run(String(DEFAULT_PCT));
    db.prepare("UPDATE services SET first_discount = 1 WHERE name LIKE 'Первин%'").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('first_discount_v1', '1')").run();
  }
}

const discountPct = (db) => {
  const n = Number(db.prepare("SELECT value FROM settings WHERE key = 'first_discount_pct'").get()?.value);
  return Number.isInteger(n) && n > 0 && n <= 90 ? n : 0;
};

// Чи були в цього номера записи, окрім скасованих і «не прийшов»
function hasVisits(db, phone) {
  const key = String(phone).replace(/\D/g, '').slice(-9);
  if (key.length < 9) return false;
  return db.prepare("SELECT client_phone FROM appointments WHERE status NOT IN ('cancelled', 'no_show')").all()
    .some((r) => String(r.client_phone).replace(/\D/g, '').slice(-9) === key);
}

// Розрахунок для послуги й номера. eligible — чи є знижка; kind — first (перший візит) або friend (за друга),
// inviteId — з якого запрошення взято знижку за друга. Суми — лише якщо в послуги є числова ціна.
function quote(db, service, phone) {
  const full = service.price_uah > 0 ? service.price_uah : null;
  const out = { eligible: false, kind: null, pct: 0, full, discount: 0, final: full, inviteId: null };
  const pct = discountPct(db);
  if (!pct) return out;
  if (!hasVisits(db, phone) && (service.first_discount || isInvitedFriend(db, phone))) out.kind = 'first';
  else {
    const inv = rewardInvite(db, phone);
    if (inv) { out.kind = 'friend'; out.inviteId = inv; }
  }
  if (!out.kind) return out;
  out.eligible = true;
  out.pct = pct;
  if (full) {
    out.final = Math.round(full * (100 - pct) / 100);
    out.discount = full - out.final;
  }
  return out;
}

function setupFirstDiscount({ app, db, makeLimiter, friendState = () => null }) {
  // Щоб за цим запитом не можна було перебирати номери й дізнаватись, хто в нас був, — обмеження за адресою
  const limiter = makeLimiter(60, 60 * 60 * 1000);
  app.get('/api/first-discount', (req, res) => {
    const service = db.prepare('SELECT id, price_uah, first_discount FROM services WHERE id = ? AND active = 1').get(Number(req.query.serviceId));
    if (!service) return res.status(400).json({ error: 'Невідома послуга' });
    const digits = String(req.query.phone ?? '').replace(/\D/g, '');
    const full = service.price_uah > 0 ? service.price_uah : null;
    if (digits.length < 9 || digits.length > 15) return res.json({ eligible: false, kind: null, pct: 0, full, discount: 0, final: full, friend: { available: false } });
    if (limiter.blocked(req.ip)) return res.status(429).json({ error: 'Забагато перевірок. Спробуйте пізніше' });
    limiter.hit(req.ip);
    const { inviteId, ...q } = quote(db, service, digits);
    // Чи показувати у формі запису блок «Приведи друга» для цього номера (без подробиць)
    const fs = friendState(digits.slice(-9));
    res.json({ ...q, friend: { available: !!(fs && fs.available), left: fs ? fs.left : 0 } });
  });
}

module.exports = { createFirstDiscountColumns, setupFirstDiscount, quote, discountPct, hasVisits };
