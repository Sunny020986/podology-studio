// Налаштування бота власником: відповідь на перше повідомлення, «Знайти мій чат» після перезапуску сервера,
// попередження в адмінці, коли сповіщення не доходять, ім'я клієнта в сповіщенні про чат.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { startServer } = require('./helpers');

const TOKEN = '1234567890:' + 'A'.repeat(35);
const OWNER = { id: 777001, type: 'private', first_name: 'Санні' };
const CLIENT = { id: 777002, type: 'private', first_name: 'Клієнтка' };

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

let tg, srv, srv2, keep;
after(async () => { if (srv) await srv.stop(); if (srv2) await srv2.stop(); if (tg) await tg.close(); if (keep) fs.rmSync(keep, { recursive: true, force: true }); });

test('налаштування: власник пише боту, «Знайти мій чат» працює й після перезапуску; помилка видна в адмінці; ім’я в сповіщенні про чат', async () => {
  tg = fakeTelegram();
  const port = await tg.listen();
  srv = await startServer({ TELEGRAM_API: `http://127.0.0.1:${port}` });
  const put = await srv.req('PUT', '/api/admin/telegram', { token: srv.ADMIN, body: { token: TOKEN, chatId: '' } });
  assert.equal(put.status, 200, put.text);

  // Власник пише боту, поки чат кабінету не збережено: відповідь — підказка про адмінку, а не текст для клієнтів
  tg.push({ message: { message_id: 1, chat: OWNER, text: '/start' } });
  const hint = await waitFor(() => tg.calls.find((c) => c.method === 'sendMessage' && c.data.chat_id === String(OWNER.id)), 'відповідь власнику');
  assert.match(hint.data.text, /Знайти мій чат/);
  // Клієнт за посиланням з кодом до списку «Знайти мій чат» не потрапляє
  tg.push({ message: { message_id: 2, chat: CLIENT, text: '/start abc123' } });
  await sleep(400);
  const found = (await srv.req('POST', '/api/admin/telegram/detect', { token: srv.ADMIN, body: {} })).body.chats;
  assert.deepEqual(found, [{ id: String(OWNER.id), name: 'Санні' }]);

  // Перезапуск сервера з тією самою базою: чат власника все ще знаходиться
  keep = fs.mkdtempSync(path.join(os.tmpdir(), 'podology-tg-'));
  await sleep(200);
  for (const f of ['studio.db', 'studio.db-wal', 'studio.db-shm']) {
    if (fs.existsSync(path.join(srv.dir, f))) fs.copyFileSync(path.join(srv.dir, f), path.join(keep, f));
  }
  await srv.stop(); srv = null;
  srv2 = await startServer({ TELEGRAM_API: `http://127.0.0.1:${port}`, DB_PATH: path.join(keep, 'studio.db') });
  const found2 = (await srv2.req('POST', '/api/admin/telegram/detect', { token: srv2.ADMIN, body: {} })).body.chats;
  assert.deepEqual(found2, [{ id: String(OWNER.id), name: 'Санні' }], 'після перезапуску');

  // Зберегли чат і тест пройшов — помилки немає
  assert.equal((await srv2.req('PUT', '/api/admin/telegram', { token: srv2.ADMIN, body: { chatId: String(OWNER.id) } })).status, 200);
  assert.equal((await srv2.req('POST', '/api/admin/telegram/test', { token: srv2.ADMIN })).status, 200);
  assert.equal((await srv2.req('GET', '/api/admin/telegram', { token: srv2.ADMIN })).body.lastError, null);

  // Бот заблоковано: сповіщення про запис не дійшло — адмінка показує причину
  tg.failSend = true;
  const svc = (await srv2.req('GET', '/api/services')).body[0].id;
  const next = (await srv2.req('GET', `/api/next-slot?serviceId=${svc}`)).body;
  const b = await srv2.req('POST', '/api/appointments', { body: { serviceId: svc, date: next.date, time: next.slots[0], name: 'Тест Помилка', phone: '+380671119911' } });
  assert.equal(b.status, 201, b.text);
  const st = await waitFor(async () => { const r = (await srv2.req('GET', '/api/admin/telegram', { token: srv2.ADMIN })).body; return r.lastError && r; }, 'помилка в статусі');
  assert.match(st.lastError.text, /не може писати/);
  // Виправили — тест прибирає попередження
  tg.failSend = false;
  assert.equal((await srv2.req('POST', '/api/admin/telegram/test', { token: srv2.ADMIN })).status, 200);
  assert.equal((await srv2.req('GET', '/api/admin/telegram', { token: srv2.ADMIN })).body.lastError, null);

  // Повідомлення в чаті сайту: у сповіщенні — ім'я й телефон клієнта з кабінету
  const reg = await srv2.req('POST', '/api/account/register', { body: { name: 'Олена Чат', phone: '+380671119922', password: 'cabinet-pass-1' } });
  assert.equal(reg.status, 201, reg.text);
  const ws = new WebSocket(srv2.base.replace('http', 'ws') + '/ws', { headers: { Cookie: (reg.headers.get('set-cookie') || '').split(';')[0] } });
  await new Promise((ok) => ws.once('open', ok));
  ws.send(JSON.stringify({ type: 'message', body: 'Чи є час у суботу?' }));
  const note = await waitFor(() => tg.calls.find((c) => c.method === 'sendMessage' && /Нове питання в чаті/.test(c.data.text)), 'сповіщення про чат');
  assert.match(note.data.text, /від Олена Чат, \+380671119922/);
  ws.close();

  // Вимкнули бота — збережені чати теж стерто
  assert.equal((await srv2.req('DELETE', '/api/admin/telegram', { token: srv2.ADMIN })).status, 200);
  assert.equal((await srv2.req('GET', '/api/admin/telegram', { token: srv2.ADMIN })).body.hasToken, false);
});
