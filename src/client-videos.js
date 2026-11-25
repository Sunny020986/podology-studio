// Відео від клієнта: клієнт у кабінеті надсилає відео стоп з телефона, майстер дивиться й відповідає текстом,
// чи можна це зробити. Це медичні дані, тому:
// - лише після входу в кабінет і з позначкою згоди клієнта;
// - файли лежать у data/private/client-videos (не в public), у щоденну резервну копію не потрапляють
//   (тимчасові й важкі: scripts/backup.js їх пропускає);
// - через 90 днів відео видаляється саме (файл і запис);
// - персонал дивиться за одноразовим посиланням на 10 хвилин (підпис HMAC), клієнт — своє відео за входом у кабінет;
// - бачать: суперадмін — усі; майстер — адресовані йому або «будь-якому майстру»;
// - відповідь майстра клієнт бачить у кабінеті й отримує в Telegram, якщо підключив бота.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 150 * 1024 * 1024; // ≈ 1–2 хв відео з телефона
const KEEP_DAYS = 90;
const COMMENT_MAX = 500;
const REPLY_MAX = 1000;
const PER_DAY = 3;          // відео на один кабінет за добу
const OPEN_MAX = 5;         // ще без відповіді одночасно
const LINK_MS = 10 * 60 * 1000;

// Тип за першими байтами файлу (а не за тим, що каже браузер)
const KINDS = [
  { ext: 'mp4', type: 'video/mp4', ok: (b) => b.slice(4, 8).toString() === 'ftyp' && !/^qt  /.test(b.slice(8, 12).toString()) && !/^3g/.test(b.slice(8, 12).toString()) },
  { ext: 'mov', type: 'video/quicktime', ok: (b) => b.slice(4, 8).toString() === 'ftyp' && b.slice(8, 12).toString() === 'qt  ' },
  { ext: '3gp', type: 'video/3gpp', ok: (b) => b.slice(4, 8).toString() === 'ftyp' && /^3g/.test(b.slice(8, 12).toString()) },
  { ext: 'webm', type: 'video/webm', ok: (b) => b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3 },
];
const typeOf = (file) => KINDS.find((k) => k.ext === path.extname(file).slice(1))?.type || 'application/octet-stream';

function createClientVideoTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS client_videos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    phone_key  TEXT NOT NULL,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    master_id  INTEGER,
    comment    TEXT NOT NULL DEFAULT '',
    file       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'new',   -- new, seen, answered
    reply      TEXT NOT NULL DEFAULT '',
    reply_by   TEXT NOT NULL DEFAULT '',
    reply_at   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_client_videos_key ON client_videos(phone_key)`);
}

function setupClientVideos({ app, db, dataDir, accountFromRequest, telegram, notifyStaff = () => {}, staffName = () => 'Майстер' }) {
  const dir = path.join(dataDir, 'private', 'client-videos');
  const secret = crypto.randomBytes(32);
  const row = (id) => db.prepare('SELECT * FROM client_videos WHERE id = ?').get(id);
  const removeFile = (file) => { if (/^[\w.-]+$/.test(file)) fs.rm(path.join(dir, file), { force: true }, () => {}); };
  const expiresOn = (createdAt) => { const d = new Date(String(createdAt).replace(' ', 'T') + 'Z'); d.setUTCDate(d.getUTCDate() + KEEP_DAYS); return d.toISOString().slice(0, 10); };
  const canSee = (req, v) => req.role === 'super' || v.master_id === null || v.master_id === req.masterId;

  // Прибирання: старші за 90 днів — геть (і файли, яких немає в базі)
  function cleanup() {
    for (const v of db.prepare(`SELECT id, file FROM client_videos WHERE created_at < datetime('now', ?)`).all(`-${KEEP_DAYS} days`)) {
      db.prepare('DELETE FROM client_videos WHERE id = ?').run(v.id);
      removeFile(v.file);
    }
  }
  cleanup();
  setInterval(cleanup, 60 * 60 * 1000).unref();

  // ----- Клієнт (кабінет) -----
  // Завантаження: тіло запиту — сам файл; коментар, майстер і згода — у рядку запиту
  app.post('/api/account/videos', (req, res) => {
    const acc = accountFromRequest(req);
    if (!acc) return res.status(401).json({ error: 'Увійдіть в кабінет' });
    if (req.query.consent !== '1') return res.status(400).json({ error: 'Позначте згоду: майстер перегляне відео ваших стоп' });
    const comment = String(req.query.comment ?? '').trim();
    if (comment.length > COMMENT_MAX) return res.status(400).json({ error: `Коментар: не більше ${COMMENT_MAX} символів` });
    const mid = Number(req.query.masterId) || null;
    if (mid && !db.prepare("SELECT 1 FROM masters WHERE id = ? AND status = 'active'").get(mid)) return res.status(400).json({ error: 'Майстра не знайдено' });
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BYTES) return res.status(413).json({ error: `Відео завелике: до ${MAX_BYTES / 1024 / 1024} МБ. Зніміть коротше (до 1 хв)` });
    const key = String(acc.phone).replace(/\D/g, '').slice(-9);
    const today = db.prepare(`SELECT COUNT(*) AS n FROM client_videos WHERE account_id = ? AND created_at > datetime('now', '-1 day')`).get(acc.id).n;
    if (today >= PER_DAY) return res.status(429).json({ error: `За добу можна надіслати не більше ${PER_DAY} відео` });
    const open = db.prepare(`SELECT COUNT(*) AS n FROM client_videos WHERE account_id = ? AND status != 'answered'`).get(acc.id).n;
    if (open >= OPEN_MAX) return res.status(429).json({ error: 'Зачекайте на відповідь майстра на попередні відео' });

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `tmp-${crypto.randomBytes(12).toString('hex')}`);
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    let size = 0, head = Buffer.alloc(0), failed = null;
    const fail = (status, error) => {
      if (failed) return;
      failed = { status, error };
      req.unpipe(out); out.destroy(); fs.rm(tmp, { force: true }, () => {});
      res.status(status).json({ error });
      req.resume();
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16)]);
      if (size > MAX_BYTES) fail(413, `Відео завелике: до ${MAX_BYTES / 1024 / 1024} МБ`);
    });
    req.on('error', () => fail(400, 'Завантаження перервалось'));
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      const kind = head.length >= 12 && KINDS.find((k) => k.ok(head));
      if (!kind || size < 1000) { fs.rm(tmp, { force: true }, () => {}); return res.status(400).json({ error: 'Потрібне відео з телефона: MP4, MOV, WebM або 3GP' }); }
      const file = `${key}-${crypto.randomBytes(12).toString('hex')}.${kind.ext}`;
      fs.renameSync(tmp, path.join(dir, file));
      const id = Number(db.prepare(`INSERT INTO client_videos (account_id, phone_key, name, phone, master_id, comment, file, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(acc.id, key, acc.name, acc.phone, mid, comment, file, size).lastInsertRowid);
      const to = mid ? db.prepare('SELECT name FROM masters WHERE id = ?').get(mid)?.name : null;
      notifyStaff(`🎥 Нове відео від клієнта ${acc.name}, ${acc.phone}${to ? ` (для майстра ${to})` : ''}${comment ? `\nКоментар: ${comment}` : ''}\nПереглянути: адмінка → «Відео»`, mid);
      res.status(201).json({ id });
    });
  });

  app.get('/api/account/videos', (req, res) => {
    const acc = accountFromRequest(req);
    if (!acc) return res.status(401).json({ error: 'Увійдіть в кабінет' });
    res.json(db.prepare(`SELECT v.id, v.comment, v.status, v.reply, v.reply_by, v.reply_at, v.created_at, v.size, m.name AS master
      FROM client_videos v LEFT JOIN masters m ON m.id = v.master_id WHERE v.account_id = ? ORDER BY v.id DESC`).all(acc.id)
      .map((v) => ({ ...v, expires_on: expiresOn(v.created_at) })));
  });
  // Своє відео — за входом у кабінет (cookie), тож <video src> працює з перемотуванням
  app.get('/api/account/videos/:id/file', (req, res) => {
    const acc = accountFromRequest(req);
    const v = acc && row(Number(req.params.id));
    if (!v || v.account_id !== acc.id) return res.status(404).json({ error: 'Відео не знайдено' });
    sendVideo(res, v);
  });
  app.delete('/api/account/videos/:id', (req, res) => {
    const acc = accountFromRequest(req);
    const v = acc && row(Number(req.params.id));
    if (!v || v.account_id !== acc.id) return res.status(404).json({ error: 'Відео не знайдено' });
    db.prepare('DELETE FROM client_videos WHERE id = ?').run(v.id);
    removeFile(v.file);
    res.json({ ok: true });
  });

  function sendVideo(res, v) {
    const full = path.join(dir, v.file);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Файл відео не знайдено' });
    res.set('Cache-Control', 'private, no-store');
    res.type(typeOf(v.file));
    res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  }

  // Одноразове посилання для персоналу: /media/client-video/:id?exp=…&sig=…
  const sign = (id, exp) => crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
  app.get('/media/client-video/:id', (req, res) => {
    const id = Number(req.params.id), exp = Number(req.query.exp);
    const sig = String(req.query.sig || '');
    const good = sign(id, exp);
    if (!exp || exp < Date.now() || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) {
      return res.status(403).json({ error: 'Посилання застаріло. Відкрийте відео в адмінці ще раз' });
    }
    const v = row(id);
    if (!v) return res.status(404).json({ error: 'Відео не знайдено' });
    sendVideo(res, v);
  });

  // ----- Персонал (реєструється після перевірки входу: registerAdmin) -----
  function registerAdmin() {
    app.get('/api/admin/client-videos', (req, res) => {
      const rows = db.prepare(`SELECT v.id, v.phone_key, v.name, v.phone, v.master_id, v.comment, v.size, v.status, v.reply, v.reply_by, v.reply_at, v.created_at, m.name AS master
        FROM client_videos v LEFT JOIN masters m ON m.id = v.master_id ORDER BY (v.status = 'answered'), v.id DESC LIMIT 300`).all();
      res.json(rows.filter((v) => canSee(req, v)).map((v) => ({ ...v, expires_on: expiresOn(v.created_at) })));
    });
    app.get('/api/admin/client-videos/new-count', (req, res) => {
      const rows = db.prepare("SELECT master_id FROM client_videos WHERE status = 'new'").all();
      res.json({ count: rows.filter((v) => canSee(req, v)).length });
    });
    app.get('/api/admin/client-videos/:id/link', (req, res) => {
      const v = row(Number(req.params.id));
      if (!v || !canSee(req, v)) return res.status(404).json({ error: 'Відео не знайдено' });
      if (v.status === 'new') db.prepare("UPDATE client_videos SET status = 'seen' WHERE id = ?").run(v.id);
      const exp = Date.now() + LINK_MS;
      res.json({ url: `/media/client-video/${v.id}?exp=${exp}&sig=${sign(v.id, exp)}` });
    });
    app.put('/api/admin/client-videos/:id/reply', (req, res) => {
      const v = row(Number(req.params.id));
      if (!v || !canSee(req, v)) return res.status(404).json({ error: 'Відео не знайдено' });
      const reply = String(req.body?.reply ?? '').trim();
      if (reply.length < 2 || reply.length > REPLY_MAX) return res.status(400).json({ error: `Відповідь: від 2 до ${REPLY_MAX} символів` });
      const by = staffName(req);
      db.prepare("UPDATE client_videos SET status = 'answered', reply = ?, reply_by = ?, reply_at = datetime('now') WHERE id = ?").run(reply, by, v.id);
      const chat = db.prepare('SELECT tg_chat_id FROM accounts WHERE id = ?').get(v.account_id)?.tg_chat_id;
      if (chat) telegram.sendToClient(chat, `🎥 Відповідь щодо вашого відео від ${by}:\n\n${reply}\n\nЗаписатися можна на сайті.`);
      res.json({ ok: true, telegram: !!chat });
    });
    app.delete('/api/admin/client-videos/:id', (req, res) => {
      const v = row(Number(req.params.id));
      if (!v || !canSee(req, v)) return res.status(404).json({ error: 'Відео не знайдено' });
      db.prepare('DELETE FROM client_videos WHERE id = ?').run(v.id);
      removeFile(v.file);
      res.json({ ok: true });
    });
  }

  return { registerAdmin, cleanup };
}

// Видалення клієнта на його прохання: відео й файли
function eraseClientVideos(db, dataDir, key) {
  const dir = path.join(dataDir, 'private', 'client-videos');
  for (const v of db.prepare('SELECT id, file FROM client_videos WHERE phone_key = ?').all(key)) {
    db.prepare('DELETE FROM client_videos WHERE id = ?').run(v.id);
    if (/^[\w.-]+$/.test(v.file)) fs.rm(path.join(dir, v.file), { force: true }, () => {});
  }
}

module.exports = { createClientVideoTable, setupClientVideos, eraseClientVideos, MAX_BYTES, KEEP_DAYS };
