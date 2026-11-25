// Сигнал «новий клієнт у черзі очікування»: лічильник нових, подія наживо в адмінку, майстер — лише свої й «будь-кому»,
// після відкриття списку заявки стають переглянутими.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer, makeMaster } = require('./helpers');

let srv, A, B, svc;
const count = async (token) => (await srv.req('GET', '/api/admin/waitlist/new-count', { token })).body.count;
const day = () => { const d = new Date(); d.setDate(d.getDate() + 3); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); };
const join = (body) => srv.req('POST', '/api/waitlist', { body: { serviceId: svc, date: day(), ...body } });

before(async () => {
  srv = await startServer();
  svc = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'waita', 'Майстер Черга А');
  B = await makeMaster(srv, 'waitb', 'Майстер Черга Б');
});
after(() => srv && srv.stop());

test('нова заявка: лічильник і подія наживо; майстер Б не бачить заявку до А; відкрили список — переглянуто', async () => {
  assert.equal(await count(srv.ADMIN), 0);
  const msgs = [];
  const ws = new WebSocket(srv.base.replace('http', 'ws') + '/ws?admin=' + encodeURIComponent(srv.ADMIN));
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((ok) => ws.once('open', ok));
  const wsB = new WebSocket(srv.base.replace('http', 'ws') + '/ws?admin=' + encodeURIComponent(B.token));
  const msgsB = [];
  wsB.on('message', (d) => msgsB.push(JSON.parse(String(d))));
  await new Promise((ok) => wsB.once('open', ok));

  const r = await join({ name: 'Черга Клієнт', phone: '+380671117001', masterId: A.id });
  assert.equal(r.status, 201, r.text);
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === 'waitlist'); i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(msgs.some((m) => m.type === 'waitlist'), 'адмінка отримала подію');
  await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(!msgsB.some((m) => m.type === 'waitlist'), 'майстер Б — ні, заявка до А');
  assert.equal(await count(srv.ADMIN), 1);
  assert.equal(await count(A.token), 1);
  assert.equal(await count(B.token), 0);

  const list = (await srv.req('GET', '/api/admin/waitlist', { token: A.token })).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].is_new, 1);
  assert.equal(await count(srv.ADMIN), 0, 'після перегляду сигнал зникає');
  assert.equal((await srv.req('GET', '/api/admin/waitlist', { token: srv.ADMIN })).body[0].is_new, 0);

  // Заявка «до будь-кого» видна обом майстрам
  assert.equal((await join({ name: 'Будь Хто', phone: '+380671117002' })).status, 201);
  assert.equal(await count(B.token), 1);
  assert.equal((await srv.req('GET', '/api/admin/waitlist/new-count')).status, 401);
  ws.close(); wsB.close();
});
