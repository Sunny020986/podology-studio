// Основні сценарії: сайт живий, запис, права адміна й майстрів, фото стоп зі згодою.
// Запуск: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, nextSlot, book, fakeJpeg } = require('./helpers');

let srv, A, B, serviceId;

before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
  B = await makeMaster(srv, 'masterb', 'Майстер Б');
});
after(() => srv && srv.stop());

test('сайт живий: /healthz і заголовки безпеки', async () => {
  const r = await srv.req('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const home = await srv.req('GET', '/');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
});

test('є послуги для запису', async () => {
  const r = await srv.req('GET', '/api/services');
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
});

test('запис: успіх, а той самий час удруге — 409', async () => {
  const s = await nextSlot(srv, serviceId, A.id);
  const body = { serviceId, date: s.date, time: s.time, name: 'Олена Тест', phone: '+380501234567', masterId: A.id };
  const first = await srv.req('POST', '/api/appointments', { body });
  assert.equal(first.status, 201, first.text);
  const second = await srv.req('POST', '/api/appointments', { body: { ...body, phone: '+380509999999' } });
  assert.equal(second.status, 409, second.text);
});

test('запис: некоректний телефон, ім\'я й дата — 400', async () => {
  const s = await nextSlot(srv, serviceId);
  const ok = { serviceId, date: s.date, time: s.time, name: 'Тест', phone: '+380501234500' };
  assert.equal((await srv.req('POST', '/api/appointments', { body: { ...ok, phone: 'abc' } })).status, 400);
  assert.equal((await srv.req('POST', '/api/appointments', { body: { ...ok, name: 'Я' } })).status, 400);
  assert.equal((await srv.req('POST', '/api/appointments', { body: { ...ok, date: '2000-01-01' } })).status, 400);
});

test('адмінка: без токена — 401, з токеном — 200', async () => {
  assert.equal((await srv.req('GET', '/api/admin/appointments')).status, 401);
  assert.equal((await srv.req('GET', '/api/admin/appointments', { token: 'wrong-token' })).status, 401);
  assert.equal((await srv.req('GET', '/api/admin/appointments', { token: srv.ADMIN })).status, 200);
});

test('майстер: розділи лише для адміна — 403', async () => {
  assert.equal((await srv.req('GET', '/api/admin/services', { token: A.token })).status, 403);
  assert.equal((await srv.req('GET', '/api/admin/masters', { token: A.token })).status, 403);
  assert.equal((await srv.req('GET', '/api/admin/studio', { token: A.token })).status, 403);
});

test('майстер бачить і змінює лише свої записи', async () => {
  const mine = await book(srv, { serviceId, masterId: A.id, phone: '+380671000001' });
  const other = await book(srv, { serviceId, masterId: B.id, phone: '+380671000002' });
  const list = await srv.req('GET', `/api/admin/appointments?from=${mine.date}&to=${other.date > mine.date ? other.date : mine.date}`, { token: A.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((a) => a.id === mine.id), 'свій запис є');
  assert.ok(!list.body.some((a) => a.id === other.id), 'чужого запису немає');
  assert.equal((await srv.req('PATCH', `/api/admin/appointments/${other.id}`, { token: A.token, body: { status: 'confirmed' } })).status, 403);
  assert.equal((await srv.req('PATCH', `/api/admin/appointments/${mine.id}`, { token: A.token, body: { status: 'confirmed' } })).status, 200);
});

test('клієнти: майстер не бачить чужого клієнта', async () => {
  await book(srv, { serviceId, masterId: B.id, phone: '+380672000003' });
  assert.equal((await srv.req('GET', '/api/admin/clients/672000003', { token: A.token })).status, 404);
  assert.equal((await srv.req('GET', '/api/admin/clients/672000003', { token: B.token })).status, 200);
});

test('фото стоп: без згоди не можна, зі згодою можна, чужому клієнтові — ні', async () => {
  await book(srv, { serviceId, masterId: A.id, phone: '+380673000004' });
  const key = '673000004';
  const up = (token) => srv.req('POST', `/api/admin/clients/${key}/photos?date=2026-11-24`, { token, raw: fakeJpeg(), headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal((await up(A.token)).status, 403, 'без згоди');
  assert.equal((await srv.req('PUT', `/api/admin/clients/${key}/photo-consent`, { token: A.token, body: { granted: true } })).status, 200);
  const u = await up(A.token);
  assert.equal(u.status, 200, u.text);
  assert.equal((await up(B.token)).status, 403, 'чужий майстер');
  assert.equal((await srv.req('GET', `/api/admin/client-photos/${u.body.id}/file`)).status, 401, 'без токена');
  assert.equal((await srv.req('GET', `/api/admin/client-photos/${u.body.id}/file`, { token: B.token })).status, 404, 'чужий майстер');
  assert.equal((await srv.req('GET', `/api/admin/client-photos/${u.body.id}/file`, { token: A.token })).status, 200);
});

test('сторінка /privacy відкривається', async () => {
  const r = await srv.req('GET', '/privacy');
  assert.equal(r.status, 200);
  assert.match(r.text, /Обробка персональних даних/);
});
