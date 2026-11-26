// Окремі входи адміністраторів: у кожного свій логін і пароль, сесія — як у майстра (30 днів).
// Права адміністратора — як у власника, крім вкладки «Доступ»: керувати адміністраторами й дивитися
// журнал дій може лише власник (вхід ключем ADMIN_TOKEN). Так видно, хто саме що зробив (src/audit.js).
// Заблокований чи видалений адміністратор, а також після зміни пароля — одразу втрачає доступ
// (сесії видаляються, відкриті канали адмінки закриваються через onRevoke).

const SESSION_DAYS = 30;
const LOGIN_RX = /^[A-Za-z0-9._-]{3,30}$/;

function createAdminUserTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    login         TEXT NOT NULL UNIQUE,
    pass_hash     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',
    last_login_at TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id   INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Свій Telegram адміністратора: йому приходять ті самі сповіщення, що й у чат кабінету
  if (!db.prepare('PRAGMA table_info(admin_users)').all().some((c) => c.name === 'tg_chat_id')) db.exec('ALTER TABLE admin_users ADD COLUMN tg_chat_id TEXT');
}

// Активний адміністратор за токеном сесії (або null)
function adminBySession(db, sha, token) {
  return (token && db.prepare(`SELECT u.id, u.name FROM admin_sessions ss JOIN admin_users u ON u.id = ss.admin_id
    WHERE ss.token_hash = ? AND ss.expires_at > ? AND u.status = 'active'`).get(sha(token), Date.now())) || null;
}

function setupAdminUsers({ app, db, sha, crypto, hashPassword, checkPassword, loginLimiter, audit, onRevoke = () => {} }) {
  const ownerOnly = (req, res) => {
    if (req.owner) return true;
    res.status(403).json({ error: 'Керувати доступом може лише власник (вхід ключем доступу)' });
    return false;
  };
  const revoke = (id) => {
    db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(id);
    onRevoke();
  };
  const validName = (v) => { const s = String(v ?? '').trim(); return s.length >= 2 && s.length <= 60 ? s : null; };
  const validPass = (v) => { const s = String(v ?? ''); return s.length >= 8 && s.length <= 100 ? s : null; };

  // Вхід адміністратора (поза /api/admin, як і вхід майстра)
  app.post('/api/admin-login', (req, res) => {
    if (loginLimiter.blocked(req.ip)) {
      return res.status(429).json({ error: `Забагато невдалих спроб входу. Спробуйте через ${loginLimiter.minutesLeft(req.ip)} хв` });
    }
    const login = String(req.body?.login ?? '').trim();
    const u = db.prepare("SELECT * FROM admin_users WHERE login = ? AND status != 'deleted'").get(login);
    if (!u || !checkPassword(String(req.body?.password ?? ''), u.pass_hash)) {
      loginLimiter.hit(req.ip);
      audit.log({ kind: 'unknown', name: login.slice(0, 30) || '—' }, 'Вхід: невдала спроба (адміністратор)', { ip: req.ip });
      return res.status(401).json({ error: 'Невірний логін або пароль' });
    }
    if (u.status === 'blocked') return res.status(403).json({ error: 'Доступ заблоковано. Зверніться до власника' });
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)')
      .run(sha(token), u.id, Date.now() + SESSION_DAYS * 86400 * 1000);
    db.prepare("UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?").run(u.id);
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now()); // прибираємо прострочені
    audit.log({ kind: 'admin', id: u.id, name: u.name }, 'Вхід в адмінку', { ip: req.ip });
    res.json({ token, name: u.name });
  });

  app.get('/api/admin/admin-users', (req, res) => {
    if (!ownerOnly(req, res)) return;
    res.json(db.prepare(`SELECT id, name, login, status, datetime(last_login_at, 'localtime') AS last_login_at FROM admin_users
      WHERE status != 'deleted' ORDER BY id`).all());
  });

  app.post('/api/admin/admin-users', (req, res) => {
    if (!ownerOnly(req, res)) return;
    const name = validName(req.body?.name);
    const login = String(req.body?.login ?? '').trim();
    const password = validPass(req.body?.password);
    if (!name) return res.status(400).json({ error: "Ім'я: від 2 до 60 символів" });
    if (!LOGIN_RX.test(login)) return res.status(400).json({ error: 'Логін: від 3 до 30 латинських літер, цифр, крапок, дефісів чи підкреслень' });
    if (!password) return res.status(400).json({ error: 'Пароль: від 8 до 100 символів' });
    if (db.prepare('SELECT 1 FROM admin_users WHERE login = ?').get(login)) return res.status(409).json({ error: 'Такий логін уже є' });
    const id = Number(db.prepare('INSERT INTO admin_users (name, login, pass_hash) VALUES (?, ?, ?)').run(name, login, hashPassword(password)).lastInsertRowid);
    res.status(201).json({ id });
  });

  // Змінити ім'я, пароль або статус (active / blocked)
  app.put('/api/admin/admin-users/:id', (req, res) => {
    if (!ownerOnly(req, res)) return;
    const u = db.prepare("SELECT * FROM admin_users WHERE id = ? AND status != 'deleted'").get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'Адміністратора не знайдено' });
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = validName(b.name);
      if (!name) return res.status(400).json({ error: "Ім'я: від 2 до 60 символів" });
      db.prepare('UPDATE admin_users SET name = ? WHERE id = ?').run(name, u.id);
    }
    if (b.password !== undefined) {
      const password = validPass(b.password);
      if (!password) return res.status(400).json({ error: 'Пароль: від 8 до 100 символів' });
      db.prepare('UPDATE admin_users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
      revoke(u.id); // старі входи більше не діють
    }
    if (b.status !== undefined) {
      if (!['active', 'blocked'].includes(b.status)) return res.status(400).json({ error: 'Некоректний статус' });
      db.prepare('UPDATE admin_users SET status = ? WHERE id = ?').run(b.status, u.id);
      if (b.status === 'blocked') revoke(u.id);
    }
    res.json({ ok: true });
  });

  // Видалення: запис лишається з позначкою (щоб у журналі дій було видно ім'я), вхід неможливий
  app.delete('/api/admin/admin-users/:id', (req, res) => {
    if (!ownerOnly(req, res)) return;
    const u = db.prepare("SELECT id, login FROM admin_users WHERE id = ? AND status != 'deleted'").get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'Адміністратора не знайдено' });
    // логін звільняється для нового адміністратора
    db.prepare("UPDATE admin_users SET status = 'deleted', login = ? WHERE id = ?").run(`deleted-${u.id}-${u.login}`, u.id);
    revoke(u.id);
    res.json({ ok: true });
  });
}

module.exports = { createAdminUserTables, adminBySession, setupAdminUsers };
