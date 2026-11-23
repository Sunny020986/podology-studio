// Кілька майстрів: у кожного свій графік, перерви, блокування, перелік послуг і вхід в адмінку.
// Суперадмін (токен ADMIN_TOKEN) додає, блокує і приховує майстрів. Прихований майстер зникає з сайту
// й адмінки, але його минулі записи й статистика зберігаються.
const crypto = require('crypto');

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
