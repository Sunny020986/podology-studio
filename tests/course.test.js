// Курс лікування: налаштування в послузі і план кроків у картці клієнта.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, insertAppt, daysAgo } = require('./helpers');

let srv, A, B, s1, s2, svc;
before(async () => {
  srv = await startServer();
  svc = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body;
  [s1, s2] = svc;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
  B = await makeMaster(srv, 'masterb', 'Майстер Б');
});
after(() => srv && srv.stop());

const patchSvc = (id, body) => srv.req('PATCH', `/api/admin/services/${id}`, { token: srv.ADMIN, body });

test('налаштування курсу: перевірка значень', async () => {
  assert.equal((await patchSvc(s1.id, { course_visits: 3, course_interval_days: 0 })).status, 400, 'без інтервалу');
  assert.equal((await patchSvc(s1.id, { course_visits: 25, course_interval_days: 14 })).status, 400, 'забагато візитів');
  assert.equal((await patchSvc(s1.id, { course_visits: 3, course_interval_days: 14, course_next_service_id: 99999 })).status, 400, 'неіснуюча послуга');
  assert.equal((await patchSvc(s1.id, { course_visits: 3, course_interval_days: 14, course_next_service_id: s2.id })).status, 200);
  const saved = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body.find((x) => x.id === s1.id);
  assert.equal(saved.course_visits, 3);
  assert.equal(saved.course_next_service_id, s2.id);
});

test('план курсу: відбувся, ще не записано, записано', async () => {
  const phone = '+380661000001', key = '661000001';
  insertAppt(srv, { date: daysAgo(30), phone, masterId: A.id, serviceId: s1.id, status: 'done' });       // початок курсу
  insertAppt(srv, { date: daysAgo(15), phone, masterId: A.id, serviceId: s2.id, status: 'done' });       // крок 1 (план −16 дн.)
  insertAppt(srv, { date: daysAgo(-13), phone, masterId: A.id, serviceId: s2.id, status: 'confirmed' }); // крок 3 (план +12 дн.)
  const r = await srv.req('GET', `/api/admin/clients/${key}/course`, { token: srv.ADMIN });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.length, 1);
  const states = r.body[0].steps.map((s) => s.state);
  assert.deepEqual(states, ['done', 'todo', 'booked']);
  assert.equal(r.body[0].next_service_id, s2.id);
});

test('курс бачить майстер клієнта, а чужий — ні', async () => {
  const key = '661000001';
  assert.equal((await srv.req('GET', `/api/admin/clients/${key}/course`, { token: A.token })).body.length, 1);
  assert.equal((await srv.req('GET', `/api/admin/clients/${key}/course`, { token: B.token })).status, 403);
  assert.equal((await srv.req('GET', `/api/admin/clients/${key}/course`)).status, 401);
});

test('без налаштувань курсу плану немає', async () => {
  insertAppt(srv, { date: daysAgo(5), phone: '+380661000002', masterId: A.id, serviceId: s2.id, status: 'done' });
  const r = await srv.req('GET', '/api/admin/clients/661000002/course', { token: srv.ADMIN });
  assert.deepEqual(r.body, []);
});
