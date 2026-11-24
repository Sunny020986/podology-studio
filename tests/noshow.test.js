// Облік неявок: статуси «Відбувся» / «Не прийшов», серія неявок, статистика.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, book, insertAppt, daysAgo } = require('./helpers');

let srv, A, serviceId;
before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
});
after(() => srv && srv.stop());

const setStatus = (id, status, token = srv.ADMIN) => srv.req('PATCH', `/api/admin/appointments/${id}`, { token, body: { status } });

test('«Не прийшов» і «Відбувся» не можна поставити майбутньому запису', async () => {
  const future = await book(srv, { serviceId, masterId: A.id, phone: '+380631000001' });
  assert.equal((await setStatus(future.id, 'no_show')).status, 400);
  assert.equal((await setStatus(future.id, 'done')).status, 400);
  assert.equal((await setStatus(future.id, 'confirmed')).status, 200);
});

test('минулому запису можна поставити «Не прийшов» і «Відбувся»', async () => {
  const id = insertAppt(srv, { date: daysAgo(3), phone: '+380631000002', masterId: A.id, serviceId });
  assert.equal((await setStatus(id, 'no_show')).status, 200);
  assert.equal((await setStatus(id, 'done', A.token)).status, 200, 'майстер — свій запис');
  assert.equal((await setStatus(id, 'щось')).status, 400);
});

test('2 неявки поспіль: позначка в списку клієнтів і в новому записі, а візит обнуляє серію', async () => {
  const phone = '+380632000003', key = '632000003';
  insertAppt(srv, { date: daysAgo(20), phone, masterId: A.id, serviceId, status: 'done' });
  insertAppt(srv, { date: daysAgo(10), phone, masterId: A.id, serviceId, status: 'no_show' });
  insertAppt(srv, { date: daysAgo(5), phone, masterId: A.id, serviceId, status: 'no_show' });
  const clients = (await srv.req('GET', '/api/admin/clients', { token: srv.ADMIN })).body;
  const c = clients.find((x) => x.key === key);
  assert.equal(c.no_shows, 2);
  assert.equal(c.noshow_streak, 2);
  assert.equal(c.visits, 1, 'неявка — не візит');
  const fresh = await book(srv, { serviceId, masterId: A.id, phone });
  const list = (await srv.req('GET', `/api/admin/appointments?from=${fresh.date}&to=${fresh.date}`, { token: srv.ADMIN })).body;
  assert.equal(list.find((a) => a.id === fresh.id).noshow_streak, 2);
  insertAppt(srv, { date: daysAgo(1), phone, masterId: A.id, serviceId, status: 'done' });
  const after = (await srv.req('GET', '/api/admin/clients', { token: srv.ADMIN })).body.find((x) => x.key === key);
  assert.equal(after.noshow_streak, 0, 'візит після неявок обнуляє серію');
  assert.equal(after.no_shows, 2, 'загальна кількість лишається');
});

test('статистика рахує неявки окремо', async () => {
  const month = daysAgo(0).slice(0, 7);
  const before = (await srv.req('GET', `/api/admin/stats?month=${month}`, { token: srv.ADMIN })).body;
  // вчорашній запис може бути в минулому місяці, тому беремо сьогодні 00:00 — він уже почався
  insertAppt(srv, { date: daysAgo(0), start: '00:00', end: '00:30', phone: '+380633000004', masterId: A.id, serviceId, status: 'no_show' });
  const s = (await srv.req('GET', `/api/admin/stats?month=${month}`, { token: srv.ADMIN })).body;
  assert.equal(s.noShows, before.noShows + 1);
  assert.equal(typeof s.noShowPercent, 'number');
});
