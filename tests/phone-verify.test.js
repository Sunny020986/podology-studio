// Підтвердження номера кабінету: через Telegram («Поділитися номером»), «номер зайнятий» (кабінет переходить до
// власника номера) і вручну персоналом. Без підтвердження — немає записів номера, знижки й запрошень з кабінету.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startServer, makeMaster } = require('./helpers');

const TOKEN = '1234567890:' + 'B'.repeat(35);
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

let tg, srv;
before(async () => {
  tg = fakeTelegram();
  const port = await tg.listen();
  srv = await startServer({ TELEGRAM_API: `http://127.0.0.1:${port}` });
  assert.equal((await srv.req('PUT', '/api/admin/telegram', { token: srv.ADMIN, body: { token: TOKEN, chatId: '-100' } })).status, 200);
  await sleep(300); // бот дізнався своє ім'я (getMe)
});
after(async () => { if (srv) await srv.stop(); if (tg) await tg.close(); });

const lastTo = (chat) => [...tg.calls].reverse().find((c) => c.method === 'sendMessage' && c.data.chat_id === String(chat));
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
async function register(name, phone) {
  const r = await srv.req('POST', '/api/account/register', { body: { name, phone, password: 'cabinet-pass-1' } });
  assert.equal(r.status, 201, r.text);
  return cookieOf(r);
}
const startCode = (link) => link.split('?start=')[1];
async function botSays(chat, re, what) {
  return waitFor(() => { const m = lastTo(chat); return m && re.test(m.data.text) && m; }, what);
}

test('через Telegram: до підтвердження записів не видно; чужий контакт і інший номер не рахуються; після — записи, знижка, Telegram', async () => {
  const phone = '+380671230001';
  const svc = (await srv.req('GET', '/api/services')).body[0].id;
  const next = (await srv.req('GET', `/api/next-slot?serviceId=${svc}`)).body;
  const b = await srv.req('POST', '/api/appointments', { body: { serviceId: svc, date: next.date, time: next.slots[0], name: 'Справжня Ольга', phone } });
  assert.equal(b.status, 201, b.text);
  const Cookie = await register('Ольга', phone);
  assert.equal((await srv.req('GET', '/api/account/me', { headers: { Cookie } })).body.verified, false);
  assert.deepEqual((await srv.req('GET', '/api/account/appointments', { headers: { Cookie } })).body, [], 'записи номера приховані');
  assert.equal((await srv.req('POST', `/api/account/appointments/${b.body.id}/cancel`, { headers: { Cookie } })).status, 404, 'скасувати чужий запис не можна');

  const link = (await srv.req('POST', '/api/account/verify/link', { headers: { Cookie } })).body.link;
  assert.match(link, /^https:\/\/t\.me\/test_bot\?start=v_/);
  const chat = 5001, from = { id: chat, first_name: 'Ольга' };
  tg.push({ message: { message_id: 1, chat: { id: chat, type: 'private' }, from, text: '/start ' + startCode(link) } });
  const ask = await botSays(chat, /Поділитися номером/, 'кнопка «Поділитися номером»');
  assert.equal(ask.data.reply_markup.keyboard[0][0].request_contact, true);

  // Переслали чужий контакт (user_id іншої людини) — не рахується
  tg.push({ message: { message_id: 2, chat: { id: chat, type: 'private' }, from, contact: { phone_number: '380671230001', user_id: 999 } } });
  await botSays(chat, /саме ваш номер/, 'відмова: чужий контакт');
  // Свій контакт, але номер Telegram інший — не рахується
  tg.push({ message: { message_id: 3, chat: { id: chat, type: 'private' }, from, contact: { phone_number: '380509990000', user_id: chat } } });
  await botSays(chat, /не збігається/, 'відмова: інший номер');
  assert.equal((await srv.req('GET', '/api/account/me', { headers: { Cookie } })).body.verified, false);
  // Свій номер — підтверджено
  tg.push({ message: { message_id: 4, chat: { id: chat, type: 'private' }, from, contact: { phone_number: '+380671230001', user_id: chat } } });
  const ok = await botSays(chat, /Номер підтверджено/, 'підтвердження');
  assert.equal(ok.data.reply_markup.remove_keyboard, true);
  const me = (await srv.req('GET', '/api/account/me', { headers: { Cookie } })).body;
  assert.deepEqual({ v: me.verified, tg: me.telegram }, { v: true, tg: true });
  assert.equal((await srv.req('GET', '/api/account/appointments', { headers: { Cookie } })).body.length, 1, 'тепер запис видно');
  assert.equal((await srv.req('POST', '/api/account/verify/link', { headers: { Cookie } })).status, 409, 'вдруге не треба');
  const card = (await srv.req('GET', `/api/admin/clients/671230001`, { token: srv.ADMIN })).body;
  assert.deepEqual({ v: card.account.verified, by: card.account.verified_by }, { v: true, by: 'telegram' });
});

test('номер зайнятий: хтось зареєструвався на чужий номер — власник підтверджує номер у боті, задає пароль, кабінет переходить до нього', async () => {
  const phone = '+380671230002';
  const impostor = await register('Не Та Людина', phone);
  const link = (await srv.req('POST', '/api/account/claim/link', { body: { phone } })).body.link;
  assert.match(link, /start=c_/);
  const chat = 5002, from = { id: chat, first_name: 'Справжній' };
  tg.push({ message: { message_id: 1, chat: { id: chat, type: 'private' }, from, text: '/start ' + startCode(link) } });
  await botSays(chat, /Поділитися номером/, 'кнопка');
  tg.push({ message: { message_id: 2, chat: { id: chat, type: 'private' }, from, contact: { phone_number: '380671230002', user_id: chat } } });
  const msg = await botSays(chat, /Код для нового пароля: \d{6}/, 'код');
  const code = msg.data.text.match(/(\d{6})/)[1];
  assert.equal((await srv.req('POST', '/api/account/reset/confirm', { body: { phone, code: '000000', password: 'new-pass-2026' } })).status, 400);
  const r = await srv.req('POST', '/api/account/reset/confirm', { body: { phone, code, password: 'new-pass-2026' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await srv.req('GET', '/api/account/me', { headers: { Cookie: impostor } })).status, 401, 'старий вхід скасовано');
  const login = await srv.req('POST', '/api/account/login', { body: { phone, password: 'new-pass-2026' } });
  assert.equal(login.status, 200, login.text);
  const me = (await srv.req('GET', '/api/account/me', { headers: { Cookie: cookieOf(login) } })).body;
  assert.deepEqual({ v: me.verified, tg: me.telegram }, { v: true, tg: true });
  assert.equal((await srv.req('POST', '/api/account/reset/confirm', { body: { phone, code, password: 'again-pass-1' } })).status, 400, 'код одноразовий');
});

test('вручну персоналом після дзвінка: лише суперадмін; майстрові — 403; без кабінету — 404', async () => {
  const phone = '+380671230003';
  await register('Без Телеграму', phone);
  const M = await makeMaster(srv, 'verifym', 'Майстер Перевірка');
  assert.equal((await srv.req('POST', '/api/admin/clients/671230003/verify-phone', { token: M.token })).status, 403);
  assert.equal((await srv.req('POST', '/api/admin/clients/671239999/verify-phone', { token: srv.ADMIN })).status, 404);
  assert.equal((await srv.req('POST', '/api/admin/clients/671230003/verify-phone', { token: srv.ADMIN })).status, 200);
  const card = (await srv.req('GET', '/api/admin/clients/671230003', { token: srv.ADMIN })).body;
  assert.deepEqual({ v: card.account.verified, by: card.account.verified_by }, { v: true, by: 'Власник' });
  const audit = (await srv.req('GET', '/api/admin/audit?limit=20', { token: srv.ADMIN })).body.rows;
  assert.ok(audit.some((x) => /номер кабінету підтверджено/.test(x.action)), 'у журналі');
});
