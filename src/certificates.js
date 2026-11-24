// Подарункові сертифікати: код, сума, термін дії, позначка про використання.
// Сертифікат одноразовий (на всю суму); залишок не ведеться.
// Термін дії задає власник для кожного сертифіката — за замовчуванням сайт його не підставляє.
// Розділ лише для суперадміна (маршрутів немає в MASTER_ROUTES).
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без схожих символів: 0/O, 1/I/L
const makeCode = () => {
  const b = crypto.randomBytes(8);
  const s = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
  return s.slice(0, 4) + '-' + s.slice(4);
};
const normCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

function setupCertificates({ app, db, todayStr, isValidDate }) {
  db.exec(`CREATE TABLE IF NOT EXISTS gift_certificates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    amount_uah  INTEGER NOT NULL,
    recipient   TEXT NOT NULL DEFAULT '',
    buyer       TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    expires_on  TEXT,
    status      TEXT NOT NULL DEFAULT 'active',  -- active, used, void
    used_at     TEXT,
    used_note   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Стан з урахуванням терміну: active, expired, used, void
  const view = (c) => ({ ...c, state: c.status === 'active' && c.expires_on && c.expires_on < todayStr() ? 'expired' : c.status });
  const byId = (id) => db.prepare('SELECT * FROM gift_certificates WHERE id = ?').get(id);

  app.get('/api/admin/certificates', (req, res) => {
    res.json(db.prepare('SELECT * FROM gift_certificates ORDER BY id DESC').all().map(view));
  });

  app.get('/api/admin/certificates/check', (req, res) => {
    const c = db.prepare('SELECT * FROM gift_certificates WHERE code = ?').get(normCode(req.query.code));
    if (!c) return res.status(404).json({ error: 'Сертифіката з таким кодом немає' });
    res.json(view(c));
  });

  app.post('/api/admin/certificates', (req, res) => {
    const b = req.body || {};
    const amount = Number(b.amount_uah);
    if (!Number.isInteger(amount) || amount < 1 || amount > 1000000) return res.status(400).json({ error: 'Сума: ціле число від 1 грн' });
    const expires = String(b.expires_on || '');
    if (expires && (!isValidDate(expires) || expires < todayStr())) return res.status(400).json({ error: 'Термін дії: дата не раніше сьогодні' });
    const clip = (v, n) => String(v ?? '').trim().slice(0, n);
    let code;
    for (let i = 0; i < 5 && !code; i++) { const c = makeCode(); if (!db.prepare('SELECT 1 FROM gift_certificates WHERE code = ?').get(c)) code = c; }
    const id = Number(db.prepare('INSERT INTO gift_certificates (code, amount_uah, recipient, buyer, note, expires_on) VALUES (?, ?, ?, ?, ?, ?)')
      .run(code, amount, clip(b.recipient, 80), clip(b.buyer, 80), clip(b.note, 300), expires || null).lastInsertRowid);
    res.status(201).json(view(byId(id)));
  });

  app.post('/api/admin/certificates/:id/use', (req, res) => {
    const c = byId(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Сертифікат не знайдено' });
    const v = view(c);
    if (v.state !== 'active') {
      const why = { used: 'уже використано', void: 'скасовано', expired: 'термін дії минув' }[v.state];
      return res.status(409).json({ error: `Сертифікат ${why}` });
    }
    db.prepare("UPDATE gift_certificates SET status = 'used', used_at = datetime('now'), used_note = ? WHERE id = ?")
      .run(String(req.body?.note ?? '').trim().slice(0, 200), c.id);
    res.json(view(byId(c.id)));
  });

  app.post('/api/admin/certificates/:id/void', (req, res) => {
    const c = byId(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Сертифікат не знайдено' });
    if (c.status === 'used') return res.status(409).json({ error: 'Використаний сертифікат не можна скасувати' });
    db.prepare("UPDATE gift_certificates SET status = 'void' WHERE id = ?").run(c.id);
    res.json(view(byId(c.id)));
  });
}

module.exports = { setupCertificates, normCode };
