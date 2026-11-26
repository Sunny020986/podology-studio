// Сповіщення персоналу кожному адміністраторові (свій Telegram) і вечірнє нагадування «Закрити день».
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer, makeMaster, insertAppt } = require('./helpers');

const TOKEN = '1234567890:' + 'C'.repeat(35);
const CABINET = '-100700';
// Фальшивий Telegram: getMe, getUpdates з черги, решта записується; failSend — sendMessage у чат кабінету відповідає 403
function fakeTelegram() {
  const calls = [], queue = [];
  let wake = null, next = 1;
  const t = { calls, failSend: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const data = body ? JSON.parse(body) : {};
      const reply = (result) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'getMe') return reply({ username: 'test_bot' });
      if (method === 'getUpdates') {
        if (queue.length) return reply(queue.splice(0));
        const tm = setTimeout(() => { wake = null; reply([]); }, 300);
        wake = () => { clearTimeout(tm); wake = null; reply(queue.splice(0)); };
        return undefined;
      }
      calls.push({ method, data });
      if (method === 'sendMessage' && t.failSend) {
        res.statusCode = 403; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
      }
      return reply({ message_id: calls.length });
    });
  });
  t.listen = () => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
  t.close = () => new Promise((ok) => server.close(ok));
  t.push = (u) => { queue.push({ update_id: next++, ...u }); if (wake) wake(); };
  return t;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function waitFor(fn, what, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(30); }
  throw new Error('Не дочекались: ' + what);
}

let tg, srv, A, adminToken, serviceId;
const pad = (n) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const to = (chat) => tg.calls.filter((c) => c.method === 'sendMessage' && c.data.chat_id === String(chat));

before(async () => {
  tg = fakeTelegram();
  const port = await tg.listen();
  // Нагадування «Закрити день» — уже з 00:00, перевірка кожні 300 мс
  srv = await startServer({ TELEGRAM_API: `http://127.0.0.1:${port}`, CLOSE_DAY_REMIND_AT: '00:00', REMINDER_INTERVAL_MS: '300' });
  assert.equal((await srv.req('PUT', '/api/admin/telegram', { token: srv.ADMIN, body: { token: TOKEN, chatId: CABINET } })).status, 200);
  await sleep(300);
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'closem', 'Майстер Вечір');
  assert.equal((await srv.req('POST', '/api/admin/admin-users', { token: srv.ADMIN, body: { name: 'Адмін Оля', login: 'olya', password: 'admin-pass-1' } })).status, 201);
  adminToken = (await srv.req('POST', '/api/admin-login', { body: { login: 'olya', password: 'admin-pass-1' } })).body.token;
});
after(async () => { if (srv) await srv.stop(); if (tg) await tg.close(); });

test('адміністратор підключає свій Telegram і отримує сповіщення персоналу; власникові — підказка про чат кабінету', async () => {
  assert.equal((await srv.req('POST', '/api/admin/me/telegram', { token: srv.ADMIN })).status, 400, 'власник — через «Кабінет»');
  const r = await srv.req('POST', '/api/admin/me/telegram', { token: adminToken });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.link, /start=a_/);
  tg.push({ message: { message_id: 1, chat: { id: 6001, type: 'private' }, from: { id: 6001 }, text: '/start ' + r.body.link.split('?start=')[1] } });
  await waitFor(() => to(6001).some((c) => /Готово/.test(c.data.text)), 'підтвердження прив’язки');
  assert.equal((await srv.req('GET', '/api/admin/me', { token: adminToken })).body.telegram, true);

  // Новий запис із сайту: і в чат кабінету, і адміністраторові
  const next = (await srv.req('GET', `/api/next-slot?serviceId=${serviceId}&masterId=${A.id}`)).body;
  const b = await srv.req('POST', '/api/appointments', { body: { serviceId, masterId: A.id, date: next.date, time: next.slots[0], name: 'Новий Клієнт', phone: '+380671240001' } });
  assert.equal(b.status, 201, b.text);
  await waitFor(() => to(CABINET).some((c) => /Новий запис/.test(c.data.text)), 'чат кабінету');
  await waitFor(() => to(6001).some((c) => /Новий запис/.test(c.data.text)), 'адміністратор');

  // Заблокований адміністратор більше нічого не отримує; відключений — теж
  assert.equal((await srv.req('DELETE', '/api/admin/me/telegram', { token: adminToken })).status, 200);
  assert.equal((await srv.req('GET', '/api/admin/me', { token: adminToken })).body.telegram, false);
});

test('«Закрити день»: раз на день — персоналу загальна кількість, майстрові — його записи; якщо все позначено — тиша', async () => {
  const db = new Database(path.join(srv.dir, 'studio.db'));
  db.prepare("UPDATE masters SET tg_chat_id = '6100' WHERE id = ?").run(A.id);
  db.prepare("DELETE FROM settings WHERE key = 'close_day_reminded'").run();
  db.close();
  const before = to(CABINET).filter((c) => /Не позначено/.test(c.data.text)).length;
  insertAppt(srv, { date: localToday(), start: '00:00', end: '00:30', phone: '+380671240002', masterId: A.id, serviceId, status: 'confirmed' });
  insertAppt(srv, { date: localToday(), start: '00:00', end: '00:30', phone: '+380671240003', masterId: null, serviceId, status: 'new' });
  const db2 = new Database(path.join(srv.dir, 'studio.db'));
  db2.prepare("DELETE FROM settings WHERE key = 'close_day_reminded'").run();
  db2.close();
  const msg = await waitFor(() => to(CABINET).filter((c) => /Не позначено/.test(c.data.text))[before], 'нагадування персоналу');
  assert.match(msg.data.text, /за сьогодні — 2 записи/);
  assert.match(msg.data.text, /Закрити день/);
  const m = await waitFor(() => to(6100).find((c) => /Не позначено/.test(c.data.text)), 'нагадування майстрові');
  assert.match(m.data.text, /за сьогодні — 1 запис\./);
  await sleep(900);
  assert.equal(to(CABINET).filter((c) => /Не позначено/.test(c.data.text)).length, before + 1, 'лише раз на день');

  // Наступного «дня» все позначено — нагадування немає
  const db3 = new Database(path.join(srv.dir, 'studio.db'));
  db3.prepare("UPDATE appointments SET status = 'done' WHERE date = ?").run(localToday());
  db3.prepare("DELETE FROM settings WHERE key = 'close_day_reminded'").run();
  db3.close();
  await sleep(900);
  assert.equal(to(CABINET).filter((c) => /Не позначено/.test(c.data.text)).length, before + 1, 'усе позначено — тиша');
});
