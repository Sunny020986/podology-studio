// Спільне для тестів: справжній сервер на чистій тимчасовій базі.
// Кожен файл тестів піднімає свій сервер на вільному порту, тож тести не заважають одне одному
// і не чіпають робочу базу.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const ADMIN = 'test-admin-token';

const freePort = () => new Promise((ok, fail) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  s.on('error', fail);
});

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podology-test-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(dir, 'studio.db'),
      ADMIN_TOKEN: ADMIN,
      BOOKINGS_PER_HOUR: '1000',
      TELEGRAM_API: 'http://127.0.0.1:9', // жодних справжніх запитів у Telegram
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* ще стартує */ }
    if (proc.exitCode !== null) throw new Error('Сервер не стартував:\n' + log);
    await new Promise((r) => setTimeout(r, 100));
  }
  // Запит: повертає { status, body, headers }. token: рядок (Bearer) або null
  async function req(method, url, { token = null, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: r.status, body: json, text, headers: r.headers };
  }
  const stop = () => new Promise((ok) => {
    if (proc.exitCode !== null) { fs.rmSync(dir, { recursive: true, force: true }); return ok(); }
    proc.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); ok(); });
    proc.kill();
  });
  return { base, req, stop, dir, log: () => log, ADMIN };
}

// Майстер з паролем і всіма послугами; повертає { id, token }
async function makeMaster(srv, login, name) {
  const services = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body.map((s) => s.id);
  const created = await srv.req('POST', '/api/admin/masters', { token: srv.ADMIN, body: { name, login, password: 'pass-' + login + '-123', bio: '', services } });
  if (created.status !== 201) throw new Error('Майстра не створено: ' + created.text);
  const login2 = await srv.req('POST', '/api/master-login', { body: { login, password: 'pass-' + login + '-123' } });
  if (login2.status !== 200) throw new Error('Майстер не увійшов: ' + login2.text);
  return { id: created.body.id, token: login2.body.token };
}

// Найближчий вільний час для послуги (і майстра, якщо вказано)
async function nextSlot(srv, serviceId, masterId) {
  const r = await srv.req('GET', `/api/next-slot?serviceId=${serviceId}${masterId ? '&masterId=' + masterId : ''}`);
  if (!r.body?.date) throw new Error('Немає вільного часу для тесту');
  return { date: r.body.date, time: r.body.slots[0] };
}

// Записати клієнта на найближчий вільний час
async function book(srv, { serviceId, masterId, phone = '+380501112233', name = 'Тест Клієнт' }) {
  const s = await nextSlot(srv, serviceId, masterId);
  const r = await srv.req('POST', '/api/appointments', { body: { serviceId, date: s.date, time: s.time, name, phone, masterId } });
  if (r.status !== 201) throw new Error('Запис не створено: ' + r.text);
  return { ...r.body, date: s.date, time: s.time };
}

// Мінімальний «JPEG»: сервер перевіряє лише сигнатуру на початку файлу
const fakeJpeg = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 7)]);

module.exports = { startServer, makeMaster, nextSlot, book, fakeJpeg, ADMIN };

// Запис у минулому — напряму в тимчасову базу (через сайт у минуле записати не можна)
function insertAppt(srv, { date, start = '10:00', end = '10:45', phone, name = 'Тест Клієнт', masterId, serviceId, status = 'confirmed' }) {
  const Database = require('better-sqlite3');
  const db = new Database(require('path').join(srv.dir, 'studio.db'));
  const id = db.prepare(`INSERT INTO appointments (service_id, date, start_time, end_time, client_name, client_phone, remind_code, master_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(serviceId, date, start, end, name, phone, 'c' + Math.random().toString(36).slice(2), masterId, status).lastInsertRowid;
  db.close();
  return Number(id);
}
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
module.exports.insertAppt = insertAppt;
module.exports.daysAgo = daysAgo;
