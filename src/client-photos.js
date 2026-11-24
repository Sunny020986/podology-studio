// Фото стану стоп клієнта для історії лікування.
// Це медичні дані, тому:
// - файли лежать у data/private/, а не в public: прямого посилання на фото немає;
// - віддаються тільки через адмінку з перевіркою доступу (суперадмін — будь-яке, майстер — клієнтів, яких він веде);
// - фото приходить уже стиснуте в JPEG з браузера: при перекодуванні зникають метадані (EXIF), зокрема GPS;
// - видаляти може суперадмін або майстер, який це фото додав;
// - нове фото приймається лише після позначки «клієнт дав згоду» (дані про здоров'я — особлива категорія).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { isValidDate } = require('./slots');

const MAX_BYTES = 3 * 1024 * 1024; // після стиснення в браузері фото — 200–600 КБ
const NOTE_MAX = 300;
const KINDS = [
  { ext: 'jpg', type: 'image/jpeg', ok: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: 'png', type: 'image/png', ok: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) },
  { ext: 'webp', type: 'image/webp', ok: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
];

const isClientKey = (k) => /^\d{9}$/.test(k);

function setupClientPhotos({ app, db, dataDir, canSeeClient }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_photos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_key  TEXT NOT NULL,
      master_id  INTEGER,
      file       TEXT NOT NULL,
      taken_on   TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_client_photos_key ON client_photos(phone_key);
    CREATE TABLE IF NOT EXISTS client_photo_consent (
      phone_key  TEXT PRIMARY KEY,
      granted    INTEGER NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      changed_by TEXT NOT NULL DEFAULT ''
    );
  `);

  const dir = path.join(dataDir, 'private', 'client-photos');
  const row = (id) => db.prepare('SELECT * FROM client_photos WHERE id = ?').get(id);
  const canDelete = (req, p) => req.role === 'super' || p.master_id === req.masterId;
  const consentRow = (key) => db.prepare('SELECT granted, changed_at, changed_by FROM client_photo_consent WHERE phone_key = ?').get(key);
  const hasConsent = (key) => !!consentRow(key)?.granted;
  const who = (req) => (req.role === 'master'
    ? (db.prepare('SELECT name FROM masters WHERE id = ?').get(req.masterId)?.name || 'Майстер')
    : 'Адміністратор');

  // Згода клієнта на фото стоп: без неї нові фото не приймаються.
  // Хто й коли позначив або відкликав — зберігається.
  app.get('/api/admin/clients/:key/photo-consent', (req, res) => {
    const key = req.params.key;
    if (!isClientKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
    if (!canSeeClient(req, key)) return res.status(403).json({ error: 'Це клієнт іншого майстра' });
    const r = consentRow(key);
    res.json(r ? { granted: !!r.granted, changed_at: r.changed_at, changed_by: r.changed_by } : { granted: false, changed_at: null, changed_by: '' });
  });
  app.put('/api/admin/clients/:key/photo-consent', (req, res) => {
    const key = req.params.key;
    if (!isClientKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
    if (!canSeeClient(req, key)) return res.status(403).json({ error: 'Це клієнт іншого майстра' });
    if (typeof req.body?.granted !== 'boolean') return res.status(400).json({ error: 'Вкажіть, чи є згода' });
    const by = who(req);
    db.prepare(`INSERT INTO client_photo_consent (phone_key, granted, changed_by) VALUES (?, ?, ?)
                ON CONFLICT(phone_key) DO UPDATE SET granted = excluded.granted, changed_by = excluded.changed_by, changed_at = datetime('now')`)
      .run(key, req.body.granted ? 1 : 0, by);
    const r = consentRow(key);
    res.json({ granted: !!r.granted, changed_at: r.changed_at, changed_by: r.changed_by });
  });

  // Список фото клієнта (найновіші зверху)
  app.get('/api/admin/clients/:key/photos', (req, res) => {
    const key = req.params.key;
    if (!isClientKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
    if (!canSeeClient(req, key)) return res.status(403).json({ error: 'Це клієнт іншого майстра' });
    const rows = db.prepare(`SELECT p.id, p.taken_on, p.note, p.master_id, p.created_at, m.name AS master
                             FROM client_photos p LEFT JOIN masters m ON m.id = p.master_id
                             WHERE p.phone_key = ? ORDER BY p.taken_on DESC, p.id DESC`).all(key);
    res.json(rows.map((p) => ({ ...p, can_delete: canDelete(req, p) })));
  });

  // Додати фото: тіло запиту — сам файл, дата й примітка в рядку запиту
  app.post('/api/admin/clients/:key/photos',
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_BYTES }),
    (req, res) => {
      const key = req.params.key;
      if (!isClientKey(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
      if (!canSeeClient(req, key)) return res.status(403).json({ error: 'Це клієнт іншого майстра' });
      if (!hasConsent(key)) return res.status(403).json({ error: 'Спершу позначте, що клієнт дав згоду на фото' });
      const taken = String(req.query.date || '');
      if (!isValidDate(taken)) return res.status(400).json({ error: 'Вкажіть дату фото' });
      const note = String(req.query.note || '').trim();
      if (note.length > NOTE_MAX) return res.status(400).json({ error: `Примітка: не більше ${NOTE_MAX} символів` });
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const kind = buf.length > 12 && KINDS.find((k) => k.ok(buf));
      if (!kind) return res.status(400).json({ error: 'Потрібне фото у форматі JPEG, PNG або WebP' });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = `${key}-${crypto.randomBytes(12).toString('hex')}.${kind.ext}`;
      fs.writeFileSync(path.join(dir, file), buf, { mode: 0o600 });
      const id = db.prepare('INSERT INTO client_photos (phone_key, master_id, file, taken_on, note) VALUES (?, ?, ?, ?, ?)')
        .run(key, req.role === 'master' ? req.masterId : null, file, taken, note).lastInsertRowid;
      res.json({ id: Number(id) });
    });

  // Саме зображення — лише для того, хто має доступ до клієнта
  app.get('/api/admin/client-photos/:id/file', (req, res) => {
    const p = row(Number(req.params.id));
    if (!p || !canSeeClient(req, p.phone_key)) return res.status(404).json({ error: 'Фото не знайдено' });
    const full = path.join(dir, p.file);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Файл фото не знайдено' });
    const kind = KINDS.find((k) => k.ext === path.extname(p.file).slice(1));
    res.set('Cache-Control', 'private, no-store');
    res.type(kind ? kind.type : 'application/octet-stream');
    res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  // Видалити фото (файл і запис)
  app.delete('/api/admin/client-photos/:id', (req, res) => {
    const p = row(Number(req.params.id));
    if (!p || !canSeeClient(req, p.phone_key)) return res.status(404).json({ error: 'Фото не знайдено' });
    if (!canDelete(req, p)) return res.status(403).json({ error: 'Видалити може адміністратор або майстер, який додав фото' });
    db.prepare('DELETE FROM client_photos WHERE id = ?').run(p.id);
    if (/^[\w.-]+$/.test(p.file)) fs.rm(path.join(dir, p.file), { force: true }, () => {});
    res.json({ ok: true });
  });
}

module.exports = { setupClientPhotos };
