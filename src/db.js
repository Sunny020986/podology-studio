const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'studio.db');

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      duration_min INTEGER NOT NULL,
      price_uah    INTEGER NOT NULL DEFAULT 0,
      active       INTEGER NOT NULL DEFAULT 1
    );

    -- weekday: 0 = Понеділок ... 6 = Неділя; start_time/end_time NULL = вихідний
    CREATE TABLE IF NOT EXISTS work_hours (
      weekday    INTEGER PRIMARY KEY,
      start_time TEXT,
      end_time   TEXT
    );

    -- Заблоковані проміжки (обідня перерва, відпустка на годину тощо)
    CREATE TABLE IF NOT EXISTS blocks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time   TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks(date);

    -- Щотижневі перерви (обід тощо): повторюються кожного вказаного дня тижня
    CREATE TABLE IF NOT EXISTS breaks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      weekday    INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time   TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      UNIQUE (weekday, start_time, end_time)
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id   INTEGER NOT NULL REFERENCES services(id),
      date         TEXT NOT NULL,
      start_time   TEXT NOT NULL,
      end_time     TEXT NOT NULL,
      client_name  TEXT NOT NULL,
      client_phone TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'new',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(date);

    CREATE TABLE IF NOT EXISTS conversations (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      sender          TEXT NOT NULL,
      body            TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);

    -- Загальна нотатка майстра про клієнта. phone_key: останні 9 цифр телефону
    CREATE TABLE IF NOT EXISTS client_notes (
      phone_key  TEXT PRIMARY KEY,
      note       TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Нотатка майстра до окремого візиту: колонка додається до баз, створених раніше
  const apptCols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  if (!apptCols.includes('note')) db.exec("ALTER TABLE appointments ADD COLUMN note TEXT NOT NULL DEFAULT ''");

  seed(db);
  return db;
}

// Стартові дані. Ціни 0 означають "ціна уточнюється": змініть в адмінці.
function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM services').get().n === 0) {
    const ins = db.prepare('INSERT INTO services (name, description, duration_min, price_uah) VALUES (?, ?, ?, ?)');
    ins.run('Первинний огляд стоп', 'Огляд стоп, оцінка стану нігтів і шкіри, рекомендації.', 45, 0);
    ins.run('Медичний педикюр', 'Обробка нігтів і шкіри стоп.', 60, 0);
    ins.run('Корекція вросклого нігтя', 'Консервативна корекція вросклого нігтя.', 45, 0);
    ins.run('Консультація подолога', 'Коротка консультація з догляду за стопами.', 30, 0);
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM work_hours').get().n === 0) {
    const ins = db.prepare('INSERT INTO work_hours (weekday, start_time, end_time) VALUES (?, ?, ?)');
    for (let wd = 0; wd <= 4; wd++) ins.run(wd, '09:00', '18:00');
    ins.run(5, '10:00', '14:00');
    ins.run(6, null, null);
  }
}

module.exports = { openDb, DB_PATH };
