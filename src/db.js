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

    -- Дані кабінету, які майстер змінює в адмінці: назва, підзаголовок, адреса, телефон
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  // Нотатка майстра до окремого візиту: колонка додається до баз, створених раніше
  const apptCols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  if (!apptCols.includes('note')) db.exec("ALTER TABLE appointments ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  // Нагадування в Telegram: код для посилання, чат клієнта, чи вже нагадали
  if (!apptCols.includes('remind_code')) db.exec('ALTER TABLE appointments ADD COLUMN remind_code TEXT');
  if (!apptCols.includes('tg_chat_id')) db.exec('ALTER TABLE appointments ADD COLUMN tg_chat_id TEXT');
  if (!apptCols.includes('reminded')) db.exec('ALTER TABLE appointments ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0');

  seed(db);
  seedSettings(db);
  migrateServicesV2(db);
  return db;
}

// Стартові дані. Ціни 0 означають "ціна уточнюється": змініть в адмінці.
function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM services').get().n === 0) {
    const ins = db.prepare('INSERT INTO services (name, description, duration_min, price_uah) VALUES (?, ?, ?, ?)');
    ins.run('Первинний огляд стоп', 'Огляд стоп, оцінка стану нігтів і шкіри, рекомендації.', 45, 0);
    ins.run('Медичний педикюр', 'Обробка нігтів і шкіри стоп.', 60, 0);
    ins.run('Корекція врослого нігтя скобою або пластиною', 'Консервативна корекція врослого нігтя без операції.', 45, 0);
    ins.run('Консультація подолога', 'Коротка консультація з догляду за стопами.', 30, 0);
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM work_hours').get().n === 0) {
    const ins = db.prepare('INSERT INTO work_hours (weekday, start_time, end_time) VALUES (?, ?, ?)');
    for (let wd = 0; wd <= 4; wd++) ins.run(wd, '09:00', '18:00');
    ins.run(5, '10:00', '14:00');
    ins.run(6, null, null);
  }
}

// Розширений перелік послуг. Виконується один раз (позначка services_v2 у settings),
// тож послуги, які майстер потім вимкне або перейменує, повторно не з'являться.
const EXTRA_SERVICES = [
  ['Обробка врослого нігтя', 'Безболісне вивільнення врослого краю нігтя, антисептична обробка.', 45],
  ['Обробка потовщених нігтів', 'Апаратне стоншення потовщеної нігтьової пластини.', 45],
  ['Обробка нігтів, уражених грибком', 'Апаратне видалення уражених ділянок нігтя, рекомендації з лікування.', 60],
  ['Видалення мозолів і натоптишів', 'Апаратне видалення огрубілої шкіри стоп.', 45],
  ['Видалення стрижневої мозолі', 'Видалення мозолі разом зі стрижнем.', 45],
  ["Обробка тріщин на п'ятах", "Обробка країв тріщин і огрубілої шкіри, догляд для загоєння.", 45],
  ['Видалення бородавок', 'Видалення бородавок на стопах.', 30],
  ['Протезування нігтьової пластини', 'Відновлення форми нігтя спеціальним матеріалом.', 60],
  ['Педикюр при цукровому діабеті', 'Делікатна обробка стоп і нігтів з урахуванням діабетичної стопи.', 60],
  ['Індивідуальні силіконові ортези', 'Виготовлення розвантажувальних вкладок для пальців.', 45],
  ['Тейпування стопи', 'Накладання тейпів для розвантаження й підтримки стопи.', 30],
  ['Повторний огляд, заміна або зняття скоби', 'Контроль корекції врослого нігтя, заміна або зняття скоби.', 30],
  ['Дитячий подологічний прийом', 'Огляд і обробка стоп і нігтів у дітей.', 45],
];
function migrateServicesV2(db) {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'services_v2'").get()) return;
  db.transaction(() => {
    db.prepare(`UPDATE services SET name = 'Корекція врослого нігтя скобою або пластиною',
                  description = REPLACE(description, 'вросклого', 'врослого')
                WHERE name = 'Корекція вросклого нігтя'`).run();
    const exists = db.prepare('SELECT 1 FROM services WHERE name = ?');
    const ins = db.prepare('INSERT INTO services (name, description, duration_min, price_uah) VALUES (?, ?, ?, 0)');
    for (const [name, desc, dur] of EXTRA_SERVICES) if (!exists.get(name)) ins.run(name, desc, dur);
    db.prepare("INSERT INTO settings (key, value) VALUES ('services_v2', '1')").run();
  })();
}

// Стартові дані кабінету. Додаються лише ті ключі, яких ще немає в базі.
const STUDIO_DEFAULTS = {
  name: 'Подологічний кабінет',
  tagline: 'Подологія · запис онлайн',
  address: 'Вулиця Новаторів, 21/1',
  phone: '+38 063 116 71 96',
  city: '',
  review_url: '',
  // Акції: перший рядок це заголовок, решта це опис. Порожнє поле ховає картку.
  promo_first: 'Знижка 10% на перший візит\nДля нових клієнтів на первинну консультацію й огляд стоп. Скажіть про знижку під час запису або напишіть у чат.',
  promo_friend: 'Приведи друга\nПорадьте нас знайомим: і вам, і другові знижка 10% на наступний візит. Другу достатньо назвати ваше ім\'я під час запису.',
  promo_gift: 'Подарунковий сертифікат\nСертифікат на будь-яку послугу або суму. Гарний подарунок рідним, особливо перед святами. Замовити можна в чаті або телефоном.',
  partners: '',
  master_name: '',
  master_about: '',
  // Питання й відповіді: блоки через порожній рядок, перший рядок блоку це питання
  faq: [
    'Чи боляче?\nБільшість процедур безболісні: подолог працює апаратом і стерильними інструментами. Якщо процедура може бути чутливою, майстер попередить заздалегідь.',
    'Як підготуватися до візиту?\nОкремої підготовки не треба. Не зрізайте й не обробляйте проблемний ніготь чи мозоль самостійно за 2–3 дні до візиту. Якщо маєте висновки лікаря чи аналізи, візьміть їх із собою.',
    'Скільки триває процедура?\nТривалість кожної послуги вказана в переліку послуг: від 30 хвилин до 1 години.',
    'Чи можна прийти з цукровим діабетом?\nТак. Для людей з діабетом є окрема послуга з делікатною обробкою. Скажіть про діабет під час запису або на початку прийому.',
    'Як скасувати або перенести запис?\nПодзвоніть або напишіть у чат на сайті, бажано щонайменше за добу до візиту.',
    'Як обробляються інструменти?\nПісля кожного клієнта інструменти проходять очищення й стерилізацію в автоклаві.',
  ].join('\n\n'),
};
function seedSettings(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(STUDIO_DEFAULTS)) ins.run(k, v);
}

module.exports = { openDb, DB_PATH, STUDIO_DEFAULTS };
