// Видалення окремого повідомлення в чаті: зникає в базі, у відвідувача й в іншому вікні адмінки; майстрові не можна.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer, makeMaster } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv && srv.stop());

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
function open(path) {
  const ws = new WebSocket(srv.base.replace('http', 'ws') + path);
  const c = { ws, msgs: [] };
  ws.on('message', (d) => c.msgs.push(JSON.parse(String(d))));
  ws.on('error', () => {});
  c.ready = new Promise((ok) => ws.once('open', ok));
  return c;
}
async function waitFor(fn, what) {
  for (let i = 0; i < 150; i++) { const v = fn(); if (v) return v; await sleep(20); }
  throw new Error('Не дочекались: ' + what);
}

test('адмін видаляє одне повідомлення: зникає в базі, у відвідувача й в адмінці', async () => {
  const visitor = open('/ws');
  await visitor.ready;
  visitor.ws.send(JSON.stringify({ type: 'message', body: 'Перше' }));
  const hello = await waitFor(() => visitor.msgs.find((m) => m.type === 'message'), 'перше повідомлення');
  const convId = hello.message.conversationId || hello.message.conversation_id;
  visitor.ws.send(JSON.stringify({ type: 'message', body: 'Друге' }));
  await waitFor(() => visitor.msgs.filter((m) => m.type === 'message').length === 2, 'друге');

  const admin = open('/ws?admin=' + encodeURIComponent(srv.ADMIN));
  await admin.ready;
  const list = (await srv.req('GET', `/api/admin/conversations/${convId}/messages`, { token: srv.ADMIN })).body;
  assert.equal(list.length, 2);
  const first = list[0];

  const del = await srv.req('DELETE', `/api/admin/conversations/${convId}/messages/${first.id}`, { token: srv.ADMIN });
  assert.equal(del.status, 200, del.text);
  const after = (await srv.req('GET', `/api/admin/conversations/${convId}/messages`, { token: srv.ADMIN })).body;
  assert.deepEqual(after.map((m) => m.body), ['Друге']);
  await waitFor(() => visitor.msgs.find((m) => m.type === 'message_deleted' && m.messageId === first.id), 'відвідувач отримав видалення');
  await waitFor(() => admin.msgs.find((m) => m.type === 'message_deleted' && m.messageId === first.id), 'адмінка отримала видалення');

  assert.equal((await srv.req('DELETE', `/api/admin/conversations/${convId}/messages/${first.id}`, { token: srv.ADMIN })).status, 404, 'вдруге — немає');
  assert.equal((await srv.req('DELETE', `/api/admin/conversations/інший/messages/${after[0].id}`, { token: srv.ADMIN })).status, 404, 'чужий діалог не чіпає');
  assert.equal((await srv.req('GET', `/api/admin/conversations/${convId}/messages`, { token: srv.ADMIN })).body.length, 1);

  const audit = (await srv.req('GET', '/api/admin/audit?limit=50', { token: srv.ADMIN })).body.rows;
  assert.ok(audit.some((x) => x.action === 'Чат: повідомлення видалено'), 'записано в журнал');
  visitor.ws.close(); admin.ws.close();
});

test('без токена — 401, майстрові — 403', async () => {
  const M = await makeMaster(srv, 'chatm', 'Майстер Чат');
  assert.equal((await srv.req('DELETE', '/api/admin/conversations/x/messages/1')).status, 401);
  assert.equal((await srv.req('DELETE', '/api/admin/conversations/x/messages/1', { token: M.token })).status, 403);
});
