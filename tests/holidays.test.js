// Свята кабінету: день закритий для всіх майстрів (і нових), попередження про наявні записи, «Майстер не вийде».
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, insertAppt } = require('./helpers');

let srv, A, serviceId, D;
const localDate = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); };
function workday() { // найближчий Пн–Пт, починаючи з післязавтра
  for (let n = 2; n < 20; n++) { const d = localDate(n); const wd = new Date(d + 'T12:00:00Z').getUTCDay(); if (wd >= 1 && wd <= 5) return d; }
}
const slots = async (date, masterId) => (await srv.req('GET', `/api/slots?serviceId=${serviceId}&date=${date}${masterId ? '&masterId=' + masterId : ''}`)).body.slots;

before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
  D = workday();
});
after(() => srv && srv.stop());

test('свято закриває день для всіх; наявні записи показуються по майстрах', async () => {
  assert.ok((await slots(D, A.id)).length > 0, 'до свята час є');
  insertAppt(srv, { date: D, start: '10:00', end: '10:45', phone: '+380671230001', masterId: A.id, serviceId, status: 'confirmed' });
  const r = await srv.req('POST', '/api/admin/holidays', { token: srv.ADMIN, body: { date: D, note: 'Тестове свято' } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.affected.map((a) => [a.master_id, a.count]), [[A.id, 1]]);
  assert.deepEqual(await slots(D), [], 'жодного вільного часу в кабінеті');
  const s = await srv.req('POST', '/api/appointments', { body: { serviceId, date: D, time: '12:00', name: 'Тест', phone: '+380671230002' } });
  assert.equal(s.status, 409, 'записатися на свято не можна');
  const next = (await srv.req('GET', `/api/next-slot?serviceId=${serviceId}&masterId=${A.id}`)).body;
  assert.notEqual(next.date, D);
  const list = (await srv.req('GET', '/api/admin/holidays', { token: srv.ADMIN })).body;
  assert.equal(list.find((h) => h.date === D).note, 'Тестове свято');
});

test('майстер, доданий після свята, теж не працює цього дня', async () => {
  const N = await makeMaster(srv, 'mastern', 'Новий майстер');
  assert.deepEqual(await slots(D, N.id), []);
});

test('календар адмінки знає про свято; «Майстер не вийде» не пропонує святковий день', async () => {
  const cal = (await srv.req('GET', `/api/admin/calendar?from=${D}&to=${D}`, { token: srv.ADMIN })).body;
  assert.deepEqual(cal.holidays, [{ date: D, note: 'Тестове свято' }]);
  const plan = (await srv.req('GET', `/api/admin/reassign?masterId=${A.id}&from=${D}&to=${D}`, { token: srv.ADMIN })).body;
  const row = plan.appointments[0];
  assert.deepEqual(row.same_time, []);
  assert.ok(row.slots.length > 0 && row.slots.every((x) => x.date !== D), 'варіанти — в інші дні');
  assert.deepEqual(plan.work_days, [], 'робочих днів у свято немає');
});

test('відкрити день знову; помилки й права', async () => {
  assert.equal((await srv.req('DELETE', `/api/admin/holidays/${D}`, { token: srv.ADMIN })).status, 200);
  assert.ok((await slots(D, A.id)).length > 0, 'час повернувся');
  assert.equal((await srv.req('DELETE', `/api/admin/holidays/${D}`, { token: srv.ADMIN })).status, 404);
  assert.equal((await srv.req('POST', '/api/admin/holidays', { token: srv.ADMIN, body: { date: localDate(-1) } })).status, 400);
  assert.equal((await srv.req('POST', '/api/admin/holidays', { token: A.token, body: { date: D } })).status, 403);
  assert.equal((await srv.req('GET', '/api/admin/holidays')).status, 401);
});
