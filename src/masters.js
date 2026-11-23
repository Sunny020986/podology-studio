// Кілька майстрів: у кожного свій графік, перерви, блокування, перелік послуг і вхід в адмінку.
// Суперадмін (токен ADMIN_TOKEN) додає, блокує і приховує майстрів. Прихований майстер зникає з сайту
// й адмінки, але його минулі записи й статистика зберігаються.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATUSES = ['active', 'blocked', 'deleted'];
const DEFAULT_HOURS = [['09:00', '18:00'], ['09:00', '18:00'], ['09:00', '18:00'], ['09:00', '18:00'], ['09:00', '18:00'], [null, null], [null, null]];

function createMasterTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS masters (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      login       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash   TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- weekday: 0 = Понеділок ... 6 = Неділя; start_time/end_time NULL = вихідний
    CREATE TABLE IF NOT EXISTS master_hours (
      master_id   INTEGER NOT NULL REFERENCES masters(id),
      weekday     INTEGER NOT NULL,
      start_time  TEXT,
      end_time    TEXT,
      PRIMARY KEY (master_id, weekday)
    );
    CREATE TABLE IF NOT EXISTS master_services (
      master_id   INTEGER NOT NULL REFERENCES masters(id),
      service_id  INTEGER NOT NULL REFERENCES services(id),
      PRIMARY KEY (master_id, service_id)
    );
    CREATE TABLE IF NOT EXISTS master_sessions (
      token_hash  TEXT PRIMARY KEY,
      master_id   INTEGER NOT NULL REFERENCES masters(id),
      expires_at  INTEGER NOT NULL
    );
  `);

  const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  db.transaction(() => {
    // Перший майстер створюється з того, що вже було на сайті: розклад, послуги й усі записи переходять до нього
    if (!db.prepare('SELECT 1 FROM masters LIMIT 1').get()) {
      const legacyName = db.prepare("SELECT value FROM settings WHERE key = 'master_name'").get()?.value;
      const id = Number(db.prepare("INSERT INTO masters (name, login) VALUES (?, 'master1')").run(legacyName || 'Майстер').lastInsertRowid);
      const hours = db.prepare('SELECT weekday, start_time, end_time FROM work_hours').all();
      const insH = db.prepare('INSERT OR IGNORE INTO master_hours (master_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
      if (hours.length) for (const h of hours) insH.run(id, h.weekday, h.start_time, h.end_time);
      else DEFAULT_HOURS.forEach(([s, e], wd) => insH.run(id, wd, s, e));
      db.prepare('INSERT OR IGNORE INTO master_services (master_id, service_id) SELECT ?, id FROM services').run(id);
    }
    const firstId = db.prepare('SELECT MIN(id) AS id FROM masters').get().id;

    for (const t of ['appointments', 'blocks', 'waitlist']) {
      if (!colsOf(t).includes('master_id')) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN master_id INTEGER REFERENCES masters(id)`);
        if (t !== 'waitlist') db.prepare(`UPDATE ${t} SET master_id = ? WHERE master_id IS NULL`).run(firstId);
      }
    }
    // У перервах була унікальність без майстра: двом майстрам не можна було б мати однаковий обід. Перебудовуємо таблицю.
    if (!colsOf('breaks').includes('master_id')) {
      db.exec(`
        CREATE TABLE breaks_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          master_id  INTEGER NOT NULL REFERENCES masters(id),
          weekday    INTEGER NOT NULL,
          start_time TEXT NOT NULL,
          end_time   TEXT NOT NULL,
          note       TEXT NOT NULL DEFAULT '',
          UNIQUE (master_id, weekday, start_time, end_time)
        );
      `);
      db.prepare('INSERT INTO breaks_new (id, master_id, weekday, start_time, end_time, note) SELECT id, ?, weekday, start_time, end_time, note FROM breaks').run(firstId);
      db.exec('DROP TABLE breaks; ALTER TABLE breaks_new RENAME TO breaks;');
    }
  })();
  db.exec('CREATE INDEX IF NOT EXISTS idx_appt_master_date ON appointments(master_id, date)');
  // Особистий Telegram майстра, опис і фото для блоку «Наші майстри»
  const mcols = colsOf('masters');
  if (!mcols.includes('tg_chat_id')) db.exec('ALTER TABLE masters ADD COLUMN tg_chat_id TEXT');
  if (!mcols.includes('bio')) db.exec("ALTER TABLE masters ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
  if (!mcols.includes('photo')) db.exec("ALTER TABLE masters ADD COLUMN photo TEXT NOT NULL DEFAULT ''");
}

// ----- Допоміжні запити -----
const activeMasters = (db, serviceId = null) => (serviceId
  ? db.prepare(`SELECT m.id, m.name FROM masters m JOIN master_services ms ON ms.master_id = m.id
      WHERE m.status = 'active' AND ms.service_id = ? ORDER BY m.id`).all(serviceId)
  : db.prepare("SELECT id, name FROM masters WHERE status = 'active' ORDER BY id").all());

const masterOffers = (db, masterId, serviceId) => !!db.prepare(`SELECT 1 FROM masters m JOIN master_services ms ON ms.master_id = m.id
  WHERE m.id = ? AND m.status = 'active' AND ms.service_id = ?`).get(masterId, serviceId);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), salt, 64);
  const want = Buffer.from(hash, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { createMasterTables, activeMasters, masterOffers, hashPassword, checkPassword, sha, STATUSES, DEFAULT_HOURS };

// ----- Керування майстрами (лише суперадмін; маршрути реєструються після перевірки ролі) -----
function setupMasterAdmin({ app, db, todayStr, dataDir, express }) {
  const LOGIN_RX = /^[A-Za-z0-9._-]{3,30}$/;
  const servicesOf = db.prepare('SELECT service_id FROM master_services WHERE master_id = ?');
  const futureCount = (id) => db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE master_id = ? AND date >= ? AND status != 'cancelled'").get(id, todayStr()).n;

  function validate(body, creating) {
    const name = String(body?.name ?? '').trim();
    const login = String(body?.login ?? '').trim();
    const password = String(body?.password ?? '');
    if (name.length < 2 || name.length > 60) return { error: "Ім'я майстра: від 2 до 60 символів" };
    if (!LOGIN_RX.test(login)) return { error: 'Логін: від 3 до 30 латинських літер, цифр, крапок, дефісів або підкреслень' };
    if ((creating || password) && (password.length < 8 || password.length > 100)) return { error: 'Пароль: від 8 до 100 символів' };
    const ids = Array.isArray(body?.services) ? [...new Set(body.services.map(Number))].filter((n) => Number.isInteger(n) && n > 0) : [];
    const known = new Set(db.prepare('SELECT id FROM services').all().map((r) => r.id));
    const bio = String(body?.bio ?? '').trim();
    if (bio.length > 600) return { error: 'Опис майстра: до 600 символів' };
    return { data: { name, login, password, bio, services: ids.filter((id) => known.has(id)) } };
  }
  const setServices = (id, services) => {
    db.prepare('DELETE FROM master_services WHERE master_id = ?').run(id);
    const ins = db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)');
    for (const s of services) ins.run(id, s);
  };
  const dropSessions = (id) => db.prepare('DELETE FROM master_sessions WHERE master_id = ?').run(id);
  const loginTaken = (login, exceptId = 0) => !!db.prepare('SELECT 1 FROM masters WHERE login = ? AND id != ?').get(login, exceptId);

  app.get('/api/admin/masters', (req, res) => {
    res.json(db.prepare("SELECT id, name, login, status, bio, photo, pass_hash != '' AS has_password, tg_chat_id IS NOT NULL AS telegram FROM masters WHERE status != 'deleted' ORDER BY id").all()
      .map((m) => ({ ...m, has_password: !!m.has_password, telegram: !!m.telegram, services: servicesOf.all(m.id).map((r) => r.service_id), future: futureCount(m.id) })));
  });

  app.post('/api/admin/masters', (req, res) => {
    const v = validate(req.body, true);
    if (v.error) return res.status(400).json({ error: v.error });
    if (loginTaken(v.data.login)) return res.status(409).json({ error: 'Такий логін уже зайнятий' });
    const id = db.transaction(() => {
      const newId = Number(db.prepare('INSERT INTO masters (name, login, pass_hash, bio) VALUES (?, ?, ?, ?)')
        .run(v.data.name, v.data.login, hashPassword(v.data.password), v.data.bio).lastInsertRowid);
      const insH = db.prepare('INSERT INTO master_hours (master_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
      DEFAULT_HOURS.forEach(([s, e], wd) => insH.run(newId, wd, s, e));
      setServices(newId, v.data.services);
      return newId;
    })();
    res.status(201).json({ id });
  });

  app.put('/api/admin/masters/:id', (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare("SELECT * FROM masters WHERE id = ? AND status != 'deleted'").get(id);
    if (!m) return res.status(404).json({ error: 'Майстра не знайдено' });
    const v = validate(req.body, false);
    if (v.error) return res.status(400).json({ error: v.error });
    if (loginTaken(v.data.login, id)) return res.status(409).json({ error: 'Такий логін уже зайнятий' });
    db.transaction(() => {
      db.prepare('UPDATE masters SET name = ?, login = ?, bio = ? WHERE id = ?').run(v.data.name, v.data.login, v.data.bio, id);
      if (v.data.password) {
        db.prepare('UPDATE masters SET pass_hash = ? WHERE id = ?').run(hashPassword(v.data.password), id);
        dropSessions(id); // після зміни пароля старі входи більше не діють
      }
      setServices(id, v.data.services);
    })();
    res.json({ ok: true });
  });

  app.post('/api/admin/masters/:id/block', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare("UPDATE masters SET status = 'blocked' WHERE id = ? AND status = 'active'").run(id).changes) {
      return res.status(404).json({ error: 'Майстра не знайдено або вже заблоковано' });
    }
    dropSessions(id);
    res.json({ ok: true, future: futureCount(id) });
  });

  app.post('/api/admin/masters/:id/unblock', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare("UPDATE masters SET status = 'active' WHERE id = ? AND status = 'blocked'").run(id).changes) {
      return res.status(404).json({ error: 'Майстра не знайдено або він не заблокований' });
    }
    res.json({ ok: true });
  });

  // ----- Фото майстра. Браузер адмінки стискає фото до 600 px; сервер приймає JPEG, PNG або WebP до 2 МБ -----
  const uploadDir = path.join(dataDir, 'uploads', 'masters');
  const KINDS = [
    { ext: 'jpg', ok: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
    { ext: 'png', ok: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) },
    { ext: 'webp', ok: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  ];
  const removePhoto = (file) => {
    if (file && /^[\w.-]+$/.test(file)) fs.rm(path.join(uploadDir, file), { force: true }, () => {});
  };
  app.put('/api/admin/masters/:id/photo', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' }), (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare("SELECT photo FROM masters WHERE id = ? AND status != 'deleted'").get(id);
    if (!m) return res.status(404).json({ error: 'Майстра не знайдено' });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const kind = buf.length > 12 && KINDS.find((k) => k.ok(buf));
    if (!kind) return res.status(400).json({ error: 'Потрібне фото у форматі JPEG, PNG або WebP до 2 МБ' });
    fs.mkdirSync(uploadDir, { recursive: true });
    const file = `${id}-${crypto.randomBytes(8).toString('hex')}.${kind.ext}`;
    fs.writeFileSync(path.join(uploadDir, file), buf);
    db.prepare('UPDATE masters SET photo = ? WHERE id = ?').run(file, id);
    removePhoto(m.photo);
    res.json({ photo: '/media/masters/' + file });
  });
  app.delete('/api/admin/masters/:id/photo', (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT photo FROM masters WHERE id = ?').get(id);
    if (!m) return res.status(404).json({ error: 'Майстра не знайдено' });
    db.prepare("UPDATE masters SET photo = '' WHERE id = ?").run(id);
    removePhoto(m.photo);
    res.json({ ok: true });
  });

  // «Видалення» ховає майстра: він зникає з сайту й адмінки, а минулі записи й статистика лишаються
  app.delete('/api/admin/masters/:id', (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare("SELECT * FROM masters WHERE id = ? AND status != 'deleted'").get(id);
    if (!m) return res.status(404).json({ error: 'Майстра не знайдено' });
    const others = db.prepare("SELECT COUNT(*) AS n FROM masters WHERE status != 'deleted' AND id != ?").get(id).n;
    if (!others) return res.status(409).json({ error: 'Не можна видалити останнього майстра. Спершу додайте іншого' });
    const future = futureCount(id);
    if (future) return res.status(409).json({ error: `У майстра є майбутні записи: ${future}. Скасуйте їх або домовтеся з клієнтами, потім видаліть майстра` });
    db.transaction(() => {
      // Логін звільняється, щоб його можна було дати новому майстрові
      db.prepare("UPDATE masters SET status = 'deleted', login = login || '~deleted~' || id WHERE id = ?").run(id);
      dropSessions(id);
    })();
    res.json({ ok: true });
  });
}

module.exports.setupMasterAdmin = setupMasterAdmin;
