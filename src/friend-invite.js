// «Приведи друга». Клієнт під час запису на сайті (або в кабінеті) додає друга одним із двох способів:
//   book — одразу записує друга (послуга, дата, час);
//   lead — лишає лише ім'я й телефон: адміністратор передзвонить і запише (список «Друзі клієнтів» в адмінці).
// Друг має бути новим клієнтом (без візитів) і не тим самим номером.
// Запрошення відкрите, поки номер друга не має візиту «Відбувся» після запрошення. Скасування чи неявка друга
// місце не звільняють. Відкритих запрошень — не більше friend_max_open (1). Адміністратор може прибрати
// невідбуте запрошення (друг відмовився): тоді місце звільняється без знижки.
// Коли друг прийшов, запрошувач отримує знижку (той самий відсоток, що й на перший візит) на один наступний запис:
// її застосовує bookTx (src/first-discount.js → quote), записує reward_appt_id. Скасували той запис — знижка повертається.
// Порожній текст акції promo_friend у «Кабінеті» вимикає нові запрошення (зароблені знижки лишаються).

const DEFAULT_MAX = 5;       // до 5 друзів одночасно (за один запис чи по черзі)
const MAX_PER_BOOKING = 5;   // скільки друзів можна додати в одній формі

const key9 = (p) => String(p ?? '').replace(/\D/g, '').slice(-9);

// Позначка в коментарі запису друга: персонал бачить, хто привів. Телефон запрошувача не пишемо.
const PREFIX = (name) => `🤝 Друг клієнта ${name}.`;

const TABLE = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_key   TEXT NOT NULL,
  referrer_name  TEXT NOT NULL,
  friend_key     TEXT NOT NULL,
  friend_name    TEXT NOT NULL,
  friend_phone   TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'book',
  friend_appt_id INTEGER,
  removed        INTEGER NOT NULL DEFAULT 0,
  reward_appt_id INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
)`;

function createFriendTables(db) {
  const cols = db.prepare('PRAGMA table_info(friend_invites)').all().map((c) => c.name);
  if (cols.length && !cols.includes('friend_key')) {
    // Перша версія таблиці (лише запис друга): переносимо рядки з даними друга з його запису
    db.transaction(() => {
      db.exec('ALTER TABLE friend_invites RENAME TO friend_invites_v1');
      db.exec('DROP INDEX IF EXISTS idx_friend_invites_ref');
      db.exec(TABLE('friend_invites'));
      const ins = db.prepare(`INSERT INTO friend_invites (referrer_key, referrer_name, friend_key, friend_name, friend_phone, kind, friend_appt_id, created_at)
        VALUES (?, ?, ?, ?, ?, 'book', ?, ?)`);
      for (const r of db.prepare(`SELECT f.*, a.client_name, a.client_phone FROM friend_invites_v1 f
        LEFT JOIN appointments a ON a.id = f.friend_appt_id`).all()) {
        if (r.client_phone) ins.run(r.referrer_key, r.referrer_name, key9(r.client_phone), r.client_name, r.client_phone, r.friend_appt_id, r.created_at);
      }
      db.exec('DROP TABLE friend_invites_v1');
    })();
  } else {
    db.exec(TABLE('friend_invites'));
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_friend_invites_ref ON friend_invites(referrer_key)');
  // Друга версія: за замовчуванням до 5 друзів. Збережене раніше «1» (старе значення за замовчуванням) піднімаємо до 5 один раз.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'friend_v2'").get()) {
    db.prepare("UPDATE settings SET value = '5' WHERE key = 'friend_max_open' AND value IN ('', '1')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('friend_v2', '1')").run();
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_friend_invites_friend ON friend_invites(friend_key)');
}

// Остання дата візиту «Відбувся» для кожного номера
function doneDates(db) {
  const m = new Map();
  for (const r of db.prepare("SELECT client_phone, date FROM appointments WHERE status = 'done'").all()) {
    const k = key9(r.client_phone);
    if (!m.has(k) || m.get(k) < r.date) m.set(k, r.date);
  }
  return m;
}
// Друг прийшов: у його номера є візит «Відбувся» в день запрошення чи пізніше
const visited = (inv, done) => { const d = done.get(inv.friend_key); return !!d && d >= String(inv.created_at).slice(0, 10); };
// Знижку за цього друга ще не використано (або запис, на який її взяли, скасовано чи видалено)
const rewardFree = (inv) => !inv.reward_appt_id || !inv.reward_status || inv.reward_status === 'cancelled';

function summary(db, key) {
  const done = doneDates(db);
  const list = db.prepare(`SELECT f.*, ra.status AS reward_status FROM friend_invites f
    LEFT JOIN appointments ra ON ra.id = f.reward_appt_id WHERE f.referrer_key = ? ORDER BY f.id`).all(key);
  let open = 0;
  const rewards = [];
  for (const inv of list) {
    if (inv.removed) continue;
    if (!visited(inv, done)) { open++; continue; }
    if (rewardFree(inv)) rewards.push(inv.id);
  }
  return { open, rewards };
}

// Цей номер запросив хтось із клієнтів (запрошення не прибране): друг отримує знижку на перший візит на будь-яку послугу
const isInvitedFriend = (db, phone) => !!db.prepare('SELECT 1 FROM friend_invites WHERE friend_key = ? AND removed = 0').get(key9(phone));

// Для bookTx: з якого запрошення взяти знижку цьому номеру (або null)
const rewardInvite = (db, phone) => summary(db, key9(phone)).rewards[0] ?? null;
const useReward = (db, inviteId, apptId) => db.prepare('UPDATE friend_invites SET reward_appt_id = ? WHERE id = ?').run(apptId, inviteId);

function setupFriendInvite({ app, db, publicBook, hasVisits, accountFromRequest, readStudio, notifyStaff = () => {}, discountPct, friendPct = () => 0 }) {
  const enabled = () => !!String(readStudio().promo_friend || '').trim();
  const maxOpen = () => {
    const n = Number(db.prepare("SELECT value FROM settings WHERE key = 'friend_max_open'").get()?.value);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : DEFAULT_MAX;
  };

  function state(key) {
    const s = summary(db, key);
    const base = { rewards: s.rewards.length, pct: friendPct(db) }; // знижка того, хто привів, за кожного друга, що прийшов
    if (!enabled()) return { enabled: false, available: false, open: s.open, max: 0, left: 0, ...base };
    const max = maxOpen();
    return { enabled: true, available: s.open < max, open: s.open, max, left: Math.max(0, Math.min(max - s.open, MAX_PER_BOOKING)), ...base };
  }

  // Перевірка даних друга до будь-якого запису. Нічого не створює. Повертає { status, error } або null.
  // pending — скільки друзів з цієї ж форми вже пораховано перед цим.
  function check(ref, f, pending = 0) {
    const key = key9(ref.phone);
    if (key.length < 9) return { status: 400, error: 'Спершу вкажіть свій телефон' };
    const st = state(key);
    if (!st.enabled) return { status: 404, error: 'Акція «Приведи друга» зараз не діє' };
    if (st.open + pending >= st.max) {
      return { status: 409, error: st.open ? `Запрошених друзів, які ще не прийшли: ${st.open} з ${st.max}. Нового друга можна буде запросити, коли хтось із них прийде на візит`
        : `Одночасно можна запросити не більше ${st.max} ${st.max === 1 ? 'друга' : 'друзів'}` };
    }
    if (!f || !['book', 'lead'].includes(f.mode)) return { status: 400, error: 'Оберіть, як записати друга' };
    const name = String(f.name ?? '').trim();
    const phone = String(f.phone ?? '').trim();
    const digits = phone.replace(/\D/g, '');
    if (name.length < 2 || name.length > 60) return { status: 400, error: "Ім'я друга: від 2 до 60 символів" };
    if (!/^\+?[\d\s()-]+$/.test(phone) || digits.length < 9 || digits.length > 15) return { status: 400, error: 'Вкажіть коректний телефон друга' };
    if (key9(phone) === key) return { status: 400, error: 'Вкажіть номер друга, а не свій' };
    if (hasVisits(db, phone)) return { status: 409, error: 'Цей номер уже є в нашій базі. «Приведи друга» діє для нових клієнтів' };
    const prev = db.prepare('SELECT referrer_key, created_at FROM friend_invites WHERE friend_key = ? AND removed = 0 ORDER BY id DESC').get(key9(phone));
    if (prev) {
      const when = String(prev.created_at).slice(0, 10).split('-').reverse().join('.');
      // Свій повтор — пояснюємо, що все вже гаразд; чужий — без імені того, хто запросив (це чужі дані)
      return prev.referrer_key === key
        ? { status: 409, error: `Ви вже запросили цього друга ${when}. Йому нічого не треба робити ще раз: знижка на перший візит чекає, щойно він запишеться` }
        : { status: 409, error: 'Цього друга вже запросив інший наш клієнт. Друг однаково отримає знижку на перший візит' };
    }
    return null;
  }

  // Запросити друга від імені ref ({ phone, name }). Повертає { status, body }.
  // defer — масив для сповіщень, які треба надіслати після транзакції (див. POST /api/appointments)
  function invite(ref, f, ip, defer = null) {
    const bad = check(ref, f);
    if (bad) return { status: bad.status, body: { error: bad.error } };
    const key = key9(ref.phone);
    const name = String(f.name).trim();
    const phone = String(f.phone).trim();
    const ins = db.prepare(`INSERT INTO friend_invites (referrer_key, referrer_name, friend_key, friend_name, friend_phone, kind, friend_appt_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    if (f.mode === 'lead') {
      ins.run(key, ref.name, key9(phone), name, phone, 'lead', null);
      const msg = `🤝 Друг клієнта ${ref.name}: ${name}, ${phone}\nЗателефонуйте й запишіть (знижка на перший візит нарахується сама). Список: адмінка → «Записи» → «Друзі клієнтів»`;
      if (defer) defer.push(() => notifyStaff(msg)); else notifyStaff(msg);
      // Знижка друга на перший візит: за запрошення — завжди; ще знижка на перший візит — якщо в нього є кабінет на сайті
      const reg = !!db.prepare('SELECT 1 FROM accounts WHERE phone_key = ?').get(key9(phone));
      return { status: 201, body: { mode: 'lead', name, pct: Math.min(90, friendPct(db) + (reg ? discountPct(db) : 0)), regPct: reg ? 0 : discountPct(db) } };
    }
    // Запрошення записуємо ДО запису друга: тоді bookTx бачить, що це запрошений друг, і дає знижку на перший візит
    const inv = Number(ins.run(key, ref.name, key9(phone), name, phone, 'book', null).lastInsertRowid);
    const r = publicBook({ serviceId: f.serviceId, date: f.date, time: f.time, name, phone, comment: f.comment, masterId: f.masterId }, ip,
      { commentPrefix: `${PREFIX(ref.name)} `, defer });
    if (r.status !== 201) { db.prepare('DELETE FROM friend_invites WHERE id = ?').run(inv); return { status: r.status, body: r.body }; }
    db.prepare('UPDATE friend_invites SET friend_appt_id = ? WHERE id = ?').run(r.body.id, inv);
    return { status: 201, body: { mode: 'book', ...r.body } };
  }

  // Кілька друзів з однієї форми (до MAX_PER_BOOKING = 5). Друг або список друзів.
  const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  function checkMany(ref, list) {
    if (!list.length) return null;
    if (list.length > MAX_PER_BOOKING) return { status: 400, error: `За один раз можна запросити не більше ${MAX_PER_BOOKING} друзів` };
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const who = list.length > 1 ? `Друг ${i + 1}: ` : '';
      const k = key9(list[i]?.phone);
      if (k && seen.has(k)) return { status: 400, error: `${who}цей номер уже вказано вище` };
      seen.add(k);
      const bad = check(ref, list[i], i);
      if (bad) return { ...bad, error: who + bad.error };
    }
    return null;
  }
  function inviteMany(ref, list, ip, defer = null) {
    return list.map((f) => {
      const r = invite(ref, f, ip, defer);
      return r.status === 201 ? { ok: true, ...r.body } : { ok: false, name: String(f?.name ?? '').trim(), error: r.body.error };
    });
  }

  // ----- Кабінет клієнта -----
  app.get('/api/account/friend-invite', (req, res) => {
    const acc = accountFromRequest(req);
    if (!acc) return res.status(401).json({ error: 'Увійдіть в кабінет' });
    res.json(state(key9(acc.phone)));
  });
  app.post('/api/account/friend-invite', (req, res) => {
    const acc = accountFromRequest(req);
    if (!acc) return res.status(401).json({ error: 'Увійдіть в кабінет' });
    const list = asList(req.body?.friends ?? req.body);
    const ref = { phone: acc.phone, name: acc.name };
    const bad = list.length ? checkMany(ref, list) : { status: 400, error: 'Додайте друга' };
    if (bad) return res.status(bad.status).json({ error: bad.error });
    // Усі друзі разом або ніхто
    const effects = [];
    let friends = null;
    try {
      db.transaction(() => {
        friends = inviteMany(ref, list, req.ip, effects);
        const i = friends.findIndex((x) => !x.ok);
        if (i >= 0) throw Object.assign(new Error('friend'), { friend: true, index: i, msg: friends[i].error });
      })();
    } catch (e) {
      if (!e.friend) throw e;
      return res.status(409).json({ error: `${list.length > 1 ? `Друг ${e.index + 1}: ` : ''}${e.msg}. Нікого не записано: виправте й спробуйте ще раз` });
    }
    effects.forEach((fn) => fn());
    res.status(201).json({ friends });
  });

  // ----- Адмінка: «Друзі клієнтів» (лише суперадмін: маршрутів немає в MASTER_ROUTES) -----
  // Реєструються окремо, ПІСЛЯ перевірки входу в адмінку (server.js викликає registerAdmin), інакше були б відкриті всім.
  function registerAdmin() {
  app.get('/api/admin/friend-invites', (req, res) => {
    const done = doneDates(db);
    const rows = db.prepare(`SELECT f.*, a.date AS appt_date, a.start_time AS appt_time, a.status AS appt_status, ra.status AS reward_status, ra.date AS reward_date
      FROM friend_invites f LEFT JOIN appointments a ON a.id = f.friend_appt_id LEFT JOIN appointments ra ON ra.id = f.reward_appt_id
      ORDER BY f.id DESC LIMIT 300`).all();
    res.json(rows.map((f) => {
      const came = visited(f, done);
      return {
        id: f.id, created_at: f.created_at, kind: f.kind, referrer: f.referrer_name, friend: f.friend_name, phone: f.friend_phone,
        appt_date: f.appt_date, appt_time: f.appt_time, appt_status: f.appt_status, removed: !!f.removed, came,
        reward: !came || f.removed ? 'none' : rewardFree(f) ? 'available' : 'used', reward_date: f.reward_date || null,
      };
    }));
  });
  app.delete('/api/admin/friend-invites/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM friend_invites WHERE id = ? AND removed = 0').get(Number(req.params.id));
    if (!f) return res.status(404).json({ error: 'Запрошення не знайдено' });
    if (visited(f, doneDates(db))) return res.status(409).json({ error: 'Друг уже прийшов: запрошення виконане, прибрати не можна' });
    db.prepare('UPDATE friend_invites SET removed = 1 WHERE id = ?').run(f.id);
    res.json({ ok: true });
  });
  }

  return { state, check, invite, checkMany, inviteMany, asList, registerAdmin };
}

// Видалення клієнта на його прохання: запрошення, де він запрошувач або друг; ім'я — з коментарів записів друзів
function eraseClient(db, key) {
  for (const r of db.prepare('SELECT referrer_name, friend_appt_id FROM friend_invites WHERE referrer_key = ? AND friend_appt_id IS NOT NULL').all(key)) {
    db.prepare('UPDATE appointments SET client_comment = REPLACE(client_comment, ?, ?) WHERE id = ?').run(PREFIX(r.referrer_name), '🤝 Друг клієнта (дані видалено).', r.friend_appt_id);
  }
  db.prepare('DELETE FROM friend_invites WHERE referrer_key = ? OR friend_key = ?').run(key, key);
}

module.exports = { createFriendTables, setupFriendInvite, eraseClient, rewardInvite, useReward, isInvitedFriend };
