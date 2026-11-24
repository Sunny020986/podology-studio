// «Приведи друга»: клієнт, який записався (або зайшов у кабінет), може записати нового друга.
// Одночасно відкритих запрошень — не більше friend_max_open (за замовчуванням 1). Запрошення відкрите, поки запис друга
// не «Відбувся» або не скасований: після візиту друга можливість з'являється в клієнта знову.
// Друг має бути новим клієнтом (без попередніх візитів) і не тим самим номером, що в запрошувача.
// Порожній текст акції promo_friend у «Кабінеті» вимикає функцію. Знижку за друга тут не нараховуємо: записується лише зв'язок.
//
// Хто запрошує, доводить кодом запису (remind_code, його бачить лише той, хто записувався) або входом у кабінет.

function createFriendTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS friend_invites (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_key   TEXT NOT NULL,
    referrer_name  TEXT NOT NULL,
    friend_appt_id INTEGER NOT NULL UNIQUE,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_friend_invites_ref ON friend_invites(referrer_key)`);
}

// Позначка в коментарі запису друга: персонал бачить, хто привів. Телефон запрошувача не пишемо.
const PREFIX = (name) => `🤝 Друг клієнта ${name}.`;

function setupFriendInvite({ app, db, last9, publicBook, hasVisits, accountFromRequest, readStudio }) {
  const enabled = () => !!String(readStudio().promo_friend || '').trim();
  const maxOpen = () => {
    const n = Number(db.prepare("SELECT value FROM settings WHERE key = 'friend_max_open'").get()?.value);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
  };
  const openCount = (key) => db.prepare(`SELECT COUNT(*) AS n FROM friend_invites fi JOIN appointments a ON a.id = fi.friend_appt_id
    WHERE fi.referrer_key = ? AND a.status NOT IN ('done', 'cancelled')`).get(key).n;
  const state = (key) => {
    if (!enabled()) return { enabled: false, available: false, open: 0, max: 0 };
    const open = openCount(key), max = maxOpen();
    return { enabled: true, available: open < max, open, max };
  };

  const byCode = (code) => {
    const a = code ? db.prepare("SELECT client_phone, client_name FROM appointments WHERE remind_code = ? AND status != 'cancelled'").get(String(code)) : null;
    return a ? { phone: a.client_phone, name: a.client_name } : null;
  };

  function invite(ref, body, ip) {
    const key = last9(ref.phone);
    const st = state(key);
    if (!st.enabled) return { status: 404, body: { error: 'Акція «Приведи друга» зараз не діє' } };
    if (!st.available) return { status: 409, body: { error: 'Ви вже записали друга. Нового друга можна буде записати, коли він прийде на візит' } };
    const r = publicBook(body, ip, {
      commentPrefix: `${PREFIX(ref.name)} `,
      ownerCheck: (friendPhone) => {
        if (last9(friendPhone) === key) return { error: 'Запишіть друга, а не себе: вкажіть його номер телефону' };
        if (hasVisits(db, friendPhone)) return { status: 409, error: 'Цей номер уже є в нашій базі. «Приведи друга» діє для нових клієнтів' };
        return null;
      },
    });
    if (r.status === 201) {
      db.prepare('INSERT INTO friend_invites (referrer_key, referrer_name, friend_appt_id) VALUES (?, ?, ?)').run(key, ref.name, r.body.id);
      r.body.next = state(key);
    }
    return { status: r.status, body: r.body };
  }

  // Після запису клієнта сайт питає, чи показувати пропозицію
  const offerFor = (code, phone) => (state(last9(phone)).available ? { available: true, code } : null);

  app.get('/api/friend-invite', (req, res) => {
    const ref = byCode(req.query.code);
    if (!ref) return res.status(404).json({ error: 'Запис не знайдено' });
    res.json(state(last9(ref.phone)));
  });
  app.post('/api/friend-invite', (req, res) => {
    const ref = byCode(req.body?.code);
    if (!ref) return res.status(404).json({ error: 'Запис не знайдено' });
    const r = invite(ref, req.body, req.ip);
    res.status(r.status).json(r.body);
  });
  app.get('/api/account/friend-invite', (req, res) => {
    const acc = accountFromRequest(req);
    if (!acc) return res.status(401).json({ error: 'Увійдіть в кабінет' });
    res.json(state(last9(acc.phone)));
  });
  app.post('/api/account/friend-invite', (req, res) => {
    const acc = accountFromRequest(req);
    if (!acc) return res.status(401).json({ error: 'Увійдіть в кабінет' });
    const r = invite({ phone: acc.phone, name: acc.name }, req.body, req.ip);
    res.status(r.status).json(r.body);
  });

  return { offerFor, state };
}

// Видалення клієнта на його прохання: прибираємо запрошення й ім'я з коментарів записів друзів
function eraseReferrer(db, key) {
  for (const r of db.prepare('SELECT referrer_name, friend_appt_id FROM friend_invites WHERE referrer_key = ?').all(key)) {
    db.prepare('UPDATE appointments SET client_comment = REPLACE(client_comment, ?, ?) WHERE id = ?').run(PREFIX(r.referrer_name), '🤝 Друг клієнта (дані видалено).', r.friend_appt_id);
  }
  db.prepare('DELETE FROM friend_invites WHERE referrer_key = ?').run(key);
}

module.exports = { createFriendTables, setupFriendInvite, eraseReferrer };
