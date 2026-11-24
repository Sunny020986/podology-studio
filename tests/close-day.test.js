// «Закрити день»: минулі незакриті записи, позначення за раз, права майстра.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, insertAppt, daysAgo, book } = require('./helpers');

let srv, A, B, serviceId, a1, a2, a3, aDone, bPast, future;
const status = (id) => {
  const Database = require('better-sqlite3');
  const db = new Database(require('path').join(srv.dir, 'studio.db'), { readonly: true });
  const s = db.prepare('SELECT status FROM appointments WHERE id = ?').get(id).status;
  db.close();
  return s;
};
before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
  B = await makeMaster(srv, 'masterb', 'Майстер Б');
  a1 = insertAppt(srv, { date: daysAgo(1), start: '10:00', end: '10:45', phone: '+380661110001', masterId: A.id, serviceId, status: 'new' });
  a2 = insertAppt(srv, { date: daysAgo(1), start: '11:00', end: '11:45', phone: '+380661110002', masterId: A.id, serviceId, status: 'confirmed' });
  a3 = insertAppt(srv, { date: daysAgo(70), phone: '+380661110003', masterId: A.id, serviceId, status: 'confirmed' }); // давніше за 60 днів
  aDone = insertAppt(srv, { date: daysAgo(2), phone: '+380661110004', masterId: A.id, serviceId, status: 'done' });
  bPast = insertAppt(srv, { date: daysAgo(1), phone: '+380661110005', masterId: B.id, serviceId, status: 'confirmed' });
  future = (await book(srv, { serviceId, masterId: A.id, phone: '+380661110006' })).id;
});
after(() => srv && srv.stop());

test('у списку — лише минулі незакриті записи за 60 днів; майстер бачить свої', async () => {
  const all = (await srv.req('GET', '/api/admin/close-day', { token: srv.ADMIN })).body.map((r) => r.id).sort((x, y) => x - y);
  assert.deepEqual(all, [a1, a2, bPast].sort((x, y) => x - y));
  const mine = (await srv.req('GET', '/api/admin/close-day', { token: A.token })).body.map((r) => r.id);
  assert.deepEqual(mine.sort((x, y) => x - y), [a1, a2].sort((x, y) => x - y));
  assert.equal((await srv.req('GET', '/api/admin/close-day/count', { token: A.token })).body.count, 2);
  assert.equal((await srv.req('GET', `/api/admin/close-day/count?masterId=${B.id}`, { token: srv.ADMIN })).body.count, 1);
  assert.ok(!all.includes(a3), 'старіші за 60 днів не показуються');
});

test('позначення за раз; чужі, майбутні й уже позначені — відмова', async () => {
  const r = await srv.req('POST', '/api/admin/close-day', { token: A.token, body: { items: [
    { id: a1, status: 'done' }, { id: a2, status: 'no_show' },
    { id: bPast, status: 'done' }, { id: future, status: 'done' }, { id: aDone, status: 'no_show' }, { id: a1, status: 'щось' },
  ] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.counts, { done: 1, no_show: 1, cancelled: 0, failed: 4 });
  assert.equal(status(a1), 'done');
  assert.equal(status(a2), 'no_show');
  assert.equal(status(bPast), 'confirmed', 'чужий запис не змінено');
  assert.equal(status(future), 'new', 'майбутній не змінено (запис із сайту — «Нова»)');
  assert.equal(status(aDone), 'done', 'уже позначений не змінено');
  assert.match(r.body.results.find((x) => x.id === future).error, /не почався/);
  assert.equal((await srv.req('GET', '/api/admin/close-day/count', { token: A.token })).body.count, 0);
});

test('суперадмін закриває будь-які; без входу — 401', async () => {
  const r = await srv.req('POST', '/api/admin/close-day', { token: srv.ADMIN, body: { items: [{ id: bPast, status: 'cancelled' }] } });
  assert.equal(r.body.counts.cancelled, 1);
  assert.equal(status(bPast), 'cancelled');
  assert.equal((await srv.req('GET', '/api/admin/close-day')).status, 401);
  assert.equal((await srv.req('POST', '/api/admin/close-day', { token: srv.ADMIN, body: {} })).status, 400);
});
