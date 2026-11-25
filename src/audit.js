// Журнал дій персоналу: хто (власник, адміністратор чи майстер), коли й що змінив в адмінці.
// Пишеться сам для кожного успішного запиту, що змінює дані (POST / PUT / PATCH / DELETE до /api/admin),
// а також для входів в адмінку й відповідей у чаті. Тіла запитів не зберігаються: лише назва дії
// й об'єкт (клієнт і час запису, назва послуги тощо). Паролі, тексти повідомлень і фото сюди не потрапляють.
// Строк зберігання — 365 днів. Коли клієнта видаляють повністю, його ім'я в журналі стирається (client_key).
// Переглядає й вивантажує журнал лише власник (вхід ключем ADMIN_TOKEN), вкладка «Доступ».
const { sendCsv } = require('./csv');

const KEEP_DAYS = 365;
const STATUS_UA = { new: 'Нова', confirmed: 'Підтверджено', done: 'Відбувся', no_show: 'Не прийшов', cancelled: 'Скасовано' };
const REVIEW_UA = { approved: 'опубліковано', hidden: 'приховано', pending: 'на перевірці' };
const KIND_UA = { owner: 'Власник', admin: 'Адміністратор', master: 'Майстер', unknown: 'Невідомий' };

function createAuditTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL DEFAULT (datetime('now')),
    actor_kind TEXT NOT NULL,
    actor_id   INTEGER,
    actor_name TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    client_key TEXT,
    ip         TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at);
  CREATE INDEX IF NOT EXISTS audit_log_client ON audit_log (client_key)`);
}

function setupAudit({ app, db, last9 }) {
  const prune = () => db.prepare(`DELETE FROM audit_log WHERE at < datetime('now', '-${KEEP_DAYS} days')`).run();
  prune();
  setInterval(prune, 24 * 3600 * 1000).unref();

  function log(actor, action, { target = '', clientKey = null, ip = '' } = {}) {
    db.prepare('INSERT INTO audit_log (actor_kind, actor_id, actor_name, action, target, client_key, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(actor.kind, actor.id ?? null, String(actor.name || '—').slice(0, 80), String(action).slice(0, 200),
        String(target || '').slice(0, 200), clientKey || null, String(ip || '').slice(0, 60));
  }

  // ----- Що саме сталося: назва дії й об'єкт (зчитуються ДО зміни, щоб видалене теж мало назву) -----
  const fmt = (d) => (d ? String(d).split('-').reverse().join('.') : '');
  const one = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch { return null; } };
  const appt = (id) => {
    const a = one('SELECT client_name, client_phone, date, start_time FROM appointments WHERE id = ?', Number(id));
    return a ? { target: `${a.client_name} · ${fmt(a.date)} ${a.start_time}`, clientKey: last9(a.client_phone) } : {};
  };
  // Ім'я клієнта: з останнього запису з цим телефоном (телефони збережені в різному вигляді, тому порівнюємо last9)
  const client = (key) => {
    const a = db.prepare('SELECT client_name, client_phone FROM appointments ORDER BY date DESC, start_time DESC').all()
      .find((r) => last9(r.client_phone) === key);
    const name = a?.client_name || one('SELECT name FROM accounts WHERE phone_key = ?', key)?.name || 'клієнт';
    return { target: name, clientKey: key };
  };
  const named = (table, id, col = 'name') => ({ target: one(`SELECT ${col} AS n FROM ${table} WHERE id = ?`, Number(id))?.n || '' });

  // [метод, шлях після /api/admin, назва (рядок або функція), об'єкт (функція від збігу й запиту)]
  const RULES = [
    ['POST', /^\/appointments$/, 'Записи: новий запис', (m, b) => ({ target: `${b.name || ''} · ${fmt(b.date)} ${b.time || ''}`, clientKey: b.phone ? last9(String(b.phone)) : null })],
    ['PATCH', /^\/appointments\/(\d+)$/, (b) => `Записи: статус «${STATUS_UA[b.status] || b.status}»`, (m) => appt(m[1])],
    ['PATCH', /^\/appointments\/(\d+)\/move$/, (b) => `Записи: перенесено на ${fmt(b.date)} ${b.time || ''}`, (m) => appt(m[1])],
    ['PUT', /^\/appointments\/(\d+)\/note$/, 'Записи: нотатка до візиту', (m) => appt(m[1])],
    ['POST', /^\/close-day$/, (b) => `Записи: «Закрити день» (${Array.isArray(b.items) ? b.items.length : 0})`],
    ['POST', /^\/reassign$/, (b) => `Записи: «Майстер не вийде» (${Array.isArray(b.actions) ? b.actions.length : 0})`, (m, b) => named('masters', b.masterId)],
    ['DELETE', /^\/waitlist\/(\d+)$/, 'Черга очікування: заявку прибрано'],
    // Повне видалення: ім'я не записуємо, а наявні рядки журналу про цього клієнта знеособлюємо
    ['DELETE', /^\/clients\/(\d{9})$/, 'Клієнти: видалено повністю', (m) => ({ target: '(дані клієнта видалено)', forget: m[1] })],
    ['POST', /^\/clients\/(\d{9})\/archive$/, 'Клієнти: в архів', (m) => client(m[1])],
    ['POST', /^\/clients\/(\d{9})\/restore$/, 'Клієнти: повернуто з архіву', (m) => client(m[1])],
    ['PUT', /^\/clients\/(\d{9})\/note$/, 'Клієнти: нотатка', (m) => client(m[1])],
    ['PUT', /^\/clients\/(\d{9})\/photo-consent$/, (b) => (b.granted ? 'Фото стоп: згоду позначено' : 'Фото стоп: згоду відкликано'), (m) => client(m[1])],
    ['POST', /^\/clients\/(\d{9})\/photos$/, 'Фото стоп: додано', (m) => client(m[1])],
    ['DELETE', /^\/client-photos\/(\d+)$/, 'Фото стоп: видалено', (m) => {
      const key = one('SELECT phone_key FROM client_photos WHERE id = ?', Number(m[1]))?.phone_key;
      return key ? client(key) : {};
    }],
    ['PUT', /^\/archive-months$/, 'Клієнти: строк архіву'],
    ['PUT', /^\/client-videos\/(\d+)\/reply$/, 'Відео: відповідь клієнтові', (m) => named('client_videos', m[1], 'name')],
    ['DELETE', /^\/client-videos\/(\d+)$/, 'Відео: видалено', (m) => named('client_videos', m[1], 'name')],
    ['PUT', /^\/booking-limits$/, (b) => (b.closed_today === true ? 'Розклад: запис закрито до кінця дня' : b.closed_today === false ? 'Розклад: запис на сьогодні відкрито' : `Розклад: запис щонайменше за ${b.lead_hours} год`)],
    ['PATCH', /^\/appointments\/(\d+)\/discount$/, (b) => (Number(b.pct) ? `Записи: знижка ${Number(b.pct)}%` : 'Записи: знижку прибрано'), (m) => appt(m[1])],
    ['DELETE', /^\/friend-invites\/(\d+)$/, 'Друзі клієнтів: запрошення прибрано', (m) => named('friend_invites', m[1], 'friend_name')],
    ['DELETE', /^\/conversations\/([^/]+)\/messages\/\d+$/, 'Чат: повідомлення видалено', (m) => ({ target: 'діалог ' + m[1].slice(0, 6) })],
    ['DELETE', /^\/conversations\/(.+)$/, 'Чат: діалог видалено', (m) => ({ target: 'діалог ' + m[1].slice(0, 6) })],
    ['POST', /^\/chat-templates$/, 'Чат: шаблон додано', (m, b) => ({ target: b.title })],
    ['PUT', /^\/chat-templates\/(\d+)$/, 'Чат: шаблон змінено', (m) => named('chat_templates', m[1], 'title')],
    ['DELETE', /^\/chat-templates\/(\d+)$/, 'Чат: шаблон видалено', (m) => named('chat_templates', m[1], 'title')],
    ['PUT', /^\/schedule\/(\d)$/, 'Розклад: робочі години', (m, b, q) => named('masters', q.masterId || b.master_id)],
    ['POST', /^\/breaks$/, 'Розклад: перерву додано'],
    ['DELETE', /^\/breaks\/(\d+)$/, 'Розклад: перерву видалено'],
    ['POST', /^\/blocks$/, 'Розклад: блокування додано', (m, b) => ({ target: `${fmt(b.date)} ${b.start_time || ''}–${b.end_time || ''}` })],
    ['DELETE', /^\/blocks\/(\d+)$/, 'Розклад: блокування видалено'],
    ['PUT', /^\/buffer$/, (b) => `Розклад: прибирання між записами ${Number(b.minutes) || 0} хв`],
    ['POST', /^\/holidays$/, 'Свята: день закрито', (m, b) => ({ target: fmt(b.date) + (b.note ? ` (${b.note})` : '') })],
    ['DELETE', /^\/holidays\/(.+)$/, 'Свята: день відкрито', (m) => ({ target: fmt(m[1]) })],
    ['POST', /^\/services$/, 'Послуги: додано', (m, b) => ({ target: b.name })],
    ['PATCH', /^\/services\/(\d+)$/, 'Послуги: змінено', (m) => named('services', m[1])],
    ['PUT', /^\/services\/(\d+)\/materials$/, 'Послуги: витрата матеріалів', (m) => named('services', m[1])],
    ['POST', /^\/masters$/, 'Майстри: додано', (m, b) => ({ target: b.name })],
    ['PUT', /^\/masters\/(\d+)$/, 'Майстри: змінено', (m) => named('masters', m[1])],
    ['DELETE', /^\/masters\/(\d+)$/, 'Майстри: видалено', (m) => named('masters', m[1])],
    ['POST', /^\/masters\/(\d+)\/block$/, 'Майстри: заблоковано', (m) => named('masters', m[1])],
    ['POST', /^\/masters\/(\d+)\/unblock$/, 'Майстри: розблоковано', (m) => named('masters', m[1])],
    ['PUT', /^\/masters\/(\d+)\/photo$/, 'Майстри: нове фото', (m) => named('masters', m[1])],
    ['DELETE', /^\/masters\/(\d+)\/photo$/, 'Майстри: фото видалено', (m) => named('masters', m[1])],
    ['POST', /^\/masters\/(\d+)\/calendar$/, 'Майстри: нове посилання на календар', (m) => named('masters', m[1])],
    ['DELETE', /^\/masters\/(\d+)\/calendar$/, 'Майстри: календар вимкнено', (m) => named('masters', m[1])],
    ['POST', /^\/me\/calendar$/, 'Мій календар: нове посилання'],
    ['DELETE', /^\/me\/calendar$/, 'Мій календар: вимкнено'],
    ['POST', /^\/me\/telegram$/, 'Мій Telegram: посилання для підключення'],
    ['DELETE', /^\/me\/telegram$/, 'Мій Telegram: відключено'],
    ['PUT', /^\/studio$/, 'Кабінет: дані кабінету'],
    ['PUT', /^\/change-hours$/, (b) => `Кабінет: скасування клієнтом не пізніше ніж за ${Number(b.hours) || 0} год`],
    ['PUT', /^\/telegram$/, 'Telegram: налаштування бота'],
    ['DELETE', /^\/telegram$/, 'Telegram: бота відключено'],
    ['POST', /^\/telegram\/test$/, 'Telegram: тестове повідомлення'],
    ['PATCH', /^\/reviews\/(\d+)$/, (b) => `Відгуки: ${REVIEW_UA[b.status] || b.status}`],
    ['DELETE', /^\/reviews\/(\d+)$/, 'Відгуки: видалено'],
    ['POST', /^\/tips$/, 'Поради: додано', (m, b) => ({ target: b.title })],
    ['PUT', /^\/tips\/(\d+)$/, 'Поради: змінено', (m) => named('tips', m[1], 'title')],
    ['DELETE', /^\/tips\/(\d+)$/, 'Поради: видалено', (m) => named('tips', m[1], 'title')],
    ['POST', /^\/materials$/, 'Матеріали: додано', (m, b) => ({ target: b.name })],
    ['PUT', /^\/materials\/(\d+)$/, 'Матеріали: змінено', (m) => named('materials', m[1])],
    ['POST', /^\/materials\/(\d+)\/move$/, (b) => `Матеріали: ${Number(b.delta) >= 0 ? 'прихід' : 'списання'} ${Math.abs(Number(b.delta)) || ''}`, (m) => named('materials', m[1])],
    ['POST', /^\/certificates$/, (b) => `Сертифікати: створено на ${Number(b.amount_uah) || 0} грн`, (m, b) => ({ target: b.recipient })],
    ['POST', /^\/certificates\/(\d+)\/use$/, 'Сертифікати: використано', (m) => named('gift_certificates', m[1], 'code')],
    ['POST', /^\/certificates\/(\d+)\/void$/, 'Сертифікати: скасовано', (m) => named('gift_certificates', m[1], 'code')],
    ['POST', /^\/admin-users$/, 'Доступ: адміністратора додано', (m, b) => ({ target: `${b.name || ''} (${b.login || ''})` })],
    ['PUT', /^\/admin-users\/(\d+)$/, (b) => (b.password !== undefined ? 'Доступ: пароль змінено' : b.status === 'blocked' ? 'Доступ: заблоковано'
      : b.status === 'active' ? 'Доступ: розблоковано' : 'Доступ: змінено'), (m) => named('admin_users', m[1])],
    ['DELETE', /^\/admin-users\/(\d+)$/, 'Доступ: адміністратора видалено', (m) => named('admin_users', m[1])],
  ];
  // Не дії з даними: вихід, пошук чату в Telegram
  const SKIP = /^\/(logout|telegram\/detect)$/;

  function describe(req) {
    const b = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    for (const [method, rx, label, target] of RULES) {
      if (method !== req.method) continue;
      const m = rx.exec(req.path);
      if (!m) continue;
      return { action: typeof label === 'function' ? label(b) : label, ...(target ? target(m, b, req.query) : {}) };
    }
    return { action: `Інша дія: ${req.method} ${req.path}`.slice(0, 120) };
  }

  // Реєструється одразу після перевірки ролей і до всіх маршрутів /api/admin
  app.use('/api/admin', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || SKIP.test(req.path) || !req.actor) return next();
    let info;
    try { info = describe(req); } catch (e) { info = { action: `${req.method} ${req.path}` }; }
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      try {
        log(req.actor, info.action, { target: info.target, clientKey: info.clientKey, ip: req.ip });
        if (info.forget) db.prepare("UPDATE audit_log SET target = '(дані клієнта видалено)', client_key = NULL WHERE client_key = ?").run(info.forget);
      } catch (e) {
        console.error('Журнал дій:', e.message);
      }
    });
    next();
  });

  // ----- Перегляд і вивантаження (лише власник) -----
  function query(q) {
    const where = [];
    const args = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { where.push("date(at, 'localtime') >= ?"); args.push(q.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) { where.push("date(at, 'localtime') <= ?"); args.push(q.to); }
    const who = /^(owner|admin|master|unknown)(?::(\d+))?$/.exec(String(q.actor || ''));
    if (who) {
      where.push('actor_kind = ?'); args.push(who[1]);
      if (who[2]) { where.push('actor_id = ?'); args.push(Number(who[2])); }
    }
    return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
  }
  const ownerOnly = (req, res) => {
    if (req.owner) return true;
    res.status(403).json({ error: 'Журнал дій бачить лише власник (вхід ключем доступу)' });
    return false;
  };
  app.get('/api/admin/audit', (req, res) => {
    if (!ownerOnly(req, res)) return;
    const { where, args } = query(req.query);
    const before = Number(req.query.before) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const cond = before ? (where ? `${where} AND id < ?` : 'WHERE id < ?') : where;
    const rows = db.prepare(`SELECT id, datetime(at, 'localtime') AS at, actor_kind, actor_id, actor_name, action, target, ip
      FROM audit_log ${cond} ORDER BY id DESC LIMIT ?`).all(...args, ...(before ? [before] : []), limit + 1);
    res.json({ rows: rows.slice(0, limit), more: rows.length > limit });
  });
  app.get('/api/admin/audit/actors', (req, res) => {
    if (!ownerOnly(req, res)) return;
    res.json(db.prepare(`SELECT actor_kind AS kind, actor_id AS id, MAX(actor_name) AS name FROM audit_log
      WHERE actor_kind != 'unknown' GROUP BY actor_kind, actor_id ORDER BY actor_kind, name`).all());
  });
  app.get('/api/admin/audit.csv', (req, res) => {
    if (!ownerOnly(req, res)) return;
    const { where, args } = query(req.query);
    const rows = db.prepare(`SELECT datetime(at, 'localtime') AS at, actor_kind, actor_name, action, target, ip
      FROM audit_log ${where} ORDER BY id DESC LIMIT 50000`).all(...args);
    sendCsv(res, `audit-${req.query.from || 'all'}-${req.query.to || 'now'}.csv`, [
      ['Коли', 'Хто', 'Роль', 'Дія', "Об'єкт", 'IP'],
      ...rows.map((r) => [r.at, r.actor_name, KIND_UA[r.actor_kind] || r.actor_kind, r.action, r.target, r.ip]),
    ]);
  });

  return { log };
}

module.exports = { createAuditTable, setupAudit };
