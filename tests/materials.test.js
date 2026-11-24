// Облік матеріалів: списання при «Відбувся», повернення, прихід і списання вручну, мінімум, права.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, insertAppt, daysAgo } = require('./helpers');

let srv, A, serviceId, matId;
before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
});
after(() => srv && srv.stop());

const qty = async () => (await srv.req('GET', '/api/admin/materials', { token: srv.ADMIN })).body.find((m) => m.id === matId);
const setStatus = (id, status, token = srv.ADMIN) => srv.req('PATCH', `/api/admin/appointments/${id}`, { token, body: { status } });

test('матеріал додається з початковим залишком; некоректні дані — 400', async () => {
  assert.equal((await srv.req('POST', '/api/admin/materials', { token: srv.ADMIN, body: { name: 'Я' } })).status, 400);
  assert.equal((await srv.req('POST', '/api/admin/materials', { token: srv.ADMIN, body: { name: 'Скоба', qty: -1 } })).status, 400);
  const r = await srv.req('POST', '/api/admin/materials', { token: srv.ADMIN, body: { name: 'Скоба Фрезера', unit: 'шт', qty: 10, min_qty: 7 } });
  assert.equal(r.status, 201);
  matId = r.body.id;
  const m = await qty();
  assert.equal(m.qty, 10);
  assert.equal(m.low, false);
});

test('«Відбувся» списує витрату послуги один раз; зміна статусу повертає', async () => {
  assert.equal((await srv.req('PUT', `/api/admin/services/${serviceId}/materials`, { token: srv.ADMIN, body: { items: [{ material_id: matId, amount: 2 }] } })).status, 200);
  const id = insertAppt(srv, { date: daysAgo(2), phone: '+380691000001', masterId: A.id, serviceId });
  assert.equal((await setStatus(id, 'done', A.token)).status, 200, 'майстер ставить «Відбувся»');
  assert.equal((await qty()).qty, 8);
  await setStatus(id, 'done');
  assert.equal((await qty()).qty, 8, 'повторне «Відбувся» не списує вдруге');
  await setStatus(id, 'confirmed');
  assert.equal((await qty()).qty, 10, 'списання повернулось');
  await setStatus(id, 'no_show');
  assert.equal((await qty()).qty, 10, 'неявка не списує');
});

test('межа мінімуму: позначка «закінчується»', async () => {
  const id = insertAppt(srv, { date: daysAgo(1), phone: '+380691000002', masterId: A.id, serviceId });
  await setStatus(id, 'done'); // 10 → 8
  const id2 = insertAppt(srv, { date: daysAgo(1), start: '12:00', end: '12:45', phone: '+380691000003', masterId: A.id, serviceId });
  await setStatus(id2, 'done'); // 8 → 6, нижче мінімуму 7
  const m = await qty();
  assert.equal(m.qty, 6);
  assert.equal(m.low, true);
});

test('прихід і ручне списання; нуль — 400; історія рухів', async () => {
  assert.equal((await srv.req('POST', `/api/admin/materials/${matId}/move`, { token: srv.ADMIN, body: { delta: 5 } })).body.qty, 11);
  assert.equal((await srv.req('POST', `/api/admin/materials/${matId}/move`, { token: srv.ADMIN, body: { delta: -1, note: 'брак' } })).body.qty, 10);
  assert.equal((await srv.req('POST', `/api/admin/materials/${matId}/move`, { token: srv.ADMIN, body: { delta: 0 } })).status, 400);
  const moves = (await srv.req('GET', '/api/admin/materials/moves', { token: srv.ADMIN })).body;
  assert.ok(moves.some((m) => m.reason === 'writeoff' && m.note === 'брак'));
  assert.ok(moves.some((m) => m.reason === 'visit'));
});

test('матеріали — лише для адміністратора', async () => {
  assert.equal((await srv.req('GET', '/api/admin/materials', { token: A.token })).status, 403);
  assert.equal((await srv.req('POST', `/api/admin/materials/${matId}/move`, { token: A.token, body: { delta: 5 } })).status, 403);
  assert.equal((await srv.req('GET', '/api/admin/materials')).status, 401);
});
