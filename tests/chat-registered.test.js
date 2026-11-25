// Чат з оператором — лише для зареєстрованих клієнтів. Клієнт може змінити чи видалити своє повідомлення протягом 15 хвилин;
// адмінка бачить зміну («змінено») та ім'я й телефон клієнта в списку діалогів.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { startServer } = require('./helpers');

let srv, cookieA, cookieB;
before(async () => {
  srv = await startServer();
  const reg = async (name, phone) => {
    const r = await srv.req('POST', '/api/account/register', { body: { name, phone, password: 'cabinet-pass-1' } });
    assert.equal(r.status, 201, r.text);
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };
  cookieA = await reg('Оксана Чат', '+380671112201');
  cookieB = await reg('Борис Чат', '+380671112202');
});
after(() => srv && srv.stop());

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
function open(p, cookie) {
  const ws = new WebSocket(srv.base.replace('http', 'ws') + p, cookie ? { headers: { Cookie: cookie } } : undefined);
  const c = { ws, msgs: [], send: (o) => ws.send(JSON.stringify(o)) };
  ws.on('message', (d) => c.msgs.push(JSON.parse(String(d))));
  ws.on('error', () => {});
  c.ready = new Promise((ok) => ws.once('open', ok));
  return c;
}
async function waitFor(fn, what) {
  for (let i = 0; i < 150; i++) { const v = fn(); if (v) return v; await sleep(20); }
  throw new Error('Не дочекались: ' + what);
}

test('без входу: hello auth:false, повідомлення не приймається', async () => {
  const v = open('/ws');
  await v.ready;
  v.send({ type: 'hello', conversationId: 'щось' });
  const h = await waitFor(() => v.msgs.find((m) => m.type === 'hello'), 'hello');
  assert.equal(h.auth, false);
  v.send({ type: 'message', body: 'Привіт' });
  const e = await waitFor(() => v.msgs.find((m) => m.type === 'error'), 'помилка');
  assert.match(e.error, /зареєстрованих/);
  assert.equal((await srv.req('GET', '/api/admin/conversations', { token: srv.ADMIN })).body.length, 0, 'діалог не створено');
  v.ws.close();
});

test('після входу: діалог за кабінетом, з іншої вкладки — той самий; адмінка бачить ім’я й телефон', async () => {
  const v = open('/ws', cookieA);
  await v.ready;
  v.send({ type: 'hello' });
  const h = await waitFor(() => v.msgs.find((m) => m.type === 'hello'), 'hello');
  assert.equal(h.auth, true);
  assert.equal(h.editMinutes, 15);
  v.send({ type: 'message', body: 'Чи можна в суботу?' });
  const msg = await waitFor(() => v.msgs.find((m) => m.type === 'message'), 'повідомлення');

  const v2 = open('/ws', cookieA);
  await v2.ready;
  v2.send({ type: 'hello', conversationId: 'чужий' });
  const h2 = await waitFor(() => v2.msgs.find((m) => m.type === 'hello'), 'hello 2');
  assert.equal(h2.conversationId, msg.message.conversation_id);
  assert.deepEqual(h2.messages.map((m) => m.body), ['Чи можна в суботу?']);

  const list = (await srv.req('GET', '/api/admin/conversations', { token: srv.ADMIN })).body;
  const c = list.find((x) => x.id === msg.message.conversation_id);
  assert.equal(c.client_name, 'Оксана Чат');
  assert.equal(c.client_phone, '+380671112201');
  v.ws.close(); v2.ws.close();
});

test('змінити й видалити своє: адмінка отримує зміну з позначкою; чуже й старше 15 хв — ні', async () => {
  const v = open('/ws', cookieA);
  await v.ready;
  v.send({ type: 'hello' });
  await waitFor(() => v.msgs.find((m) => m.type === 'hello'), 'hello');
  v.send({ type: 'message', body: 'Помилкаа' });
  const msg = (await waitFor(() => v.msgs.find((m) => m.type === 'message' && m.message.body === 'Помилкаа'), 'нове')).message;
  const admin = open('/ws?admin=' + encodeURIComponent(srv.ADMIN));
  await admin.ready;

  v.send({ type: 'edit', id: msg.id, body: 'Помилка' });
  const ed = await waitFor(() => admin.msgs.find((m) => m.type === 'message_edited'), 'адмінка — зміна');
  assert.equal(ed.message.body, 'Помилка');
  assert.ok(ed.message.edited_at, 'позначка «змінено»');
  await waitFor(() => v.msgs.find((m) => m.type === 'message_edited'), 'клієнт — зміна');
  const msgs = (await srv.req('GET', `/api/admin/conversations/${msg.conversation_id}/messages`, { token: srv.ADMIN })).body;
  assert.ok(msgs.find((m) => m.id === msg.id).edited_at);

  // Інший клієнт не може змінити чуже
  const b = open('/ws', cookieB);
  await b.ready;
  b.send({ type: 'hello' });
  await waitFor(() => b.msgs.find((m) => m.type === 'hello'), 'hello Б');
  b.send({ type: 'edit', id: msg.id, body: 'Злам' });
  b.send({ type: 'delete', id: msg.id });
  await waitFor(() => b.msgs.filter((m) => m.type === 'error').length === 2, 'відмови Б');

  // Повідомлення старше 15 хвилин — не змінюється
  const db = new Database(path.join(srv.dir, 'studio.db'));
  db.prepare("UPDATE messages SET created_at = datetime('now', '-16 minutes') WHERE id = ?").run(msg.id);
  db.close();
  v.send({ type: 'delete', id: msg.id });
  const late = await waitFor(() => v.msgs.find((m) => m.type === 'error'), 'відмова за часом');
  assert.match(late.error, /15 хв/);

  // Свіже — видаляється
  v.send({ type: 'message', body: 'Зайве' });
  const m2 = (await waitFor(() => v.msgs.find((m) => m.type === 'message' && m.message.body === 'Зайве'), 'зайве')).message;
  v.send({ type: 'delete', id: m2.id });
  await waitFor(() => admin.msgs.find((m) => m.type === 'message_deleted' && m.messageId === m2.id), 'адмінка — видалення');
  const left = (await srv.req('GET', `/api/admin/conversations/${msg.conversation_id}/messages`, { token: srv.ADMIN })).body.map((m) => m.body);
  assert.ok(!left.includes('Зайве'));
  assert.ok(left.includes('Помилка'));
  v.ws.close(); admin.ws.close(); b.ws.close();
});
