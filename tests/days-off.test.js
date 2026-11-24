// Сайт не пропонує вихідні: список днів, коли ніхто не працює (вихідні майстрів і свята кабінету).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster } = require('./helpers');

let srv, M, serviceId;
before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  M = await makeMaster(srv, 'offm', 'Майстер Вихідний');
});
after(() => srv && srv.stop());

test('days-off: робочий день не вихідний; свято кабінету додає день у список', async () => {
  const q = `serviceId=${serviceId}&masterId=${M.id}`;
  const off = (await srv.req('GET', `/api/days-off?${q}`)).body.off;
  assert.ok(Array.isArray(off));
  const day = (await srv.req('GET', `/api/next-slot?${q}`)).body.date;
  assert.ok(day, 'є день з вільним часом');
  assert.ok(!off.includes(day), 'день з вільним часом не вихідний');
  // Дні, коли майстер не працює за графіком, у списку є: і для них вільного часу справді немає
  const sample = off.slice(0, 3);
  assert.ok(sample.length > 0, 'у горизонті запису є вихідні');
  for (const d of sample) assert.equal((await srv.req('GET', `/api/slots?serviceId=${serviceId}&date=${d}&masterId=${M.id}`)).body.slots.length, 0);

  // Свято кабінету закриває день для всіх
  const add = await srv.req('POST', '/api/admin/holidays', { token: srv.ADMIN, body: { date: day, note: 'тест' } });
  assert.equal(add.status, 201, add.text);
  const after = (await srv.req('GET', `/api/days-off?${q}`)).body.off;
  assert.ok(after.includes(day), 'свято в списку вихідних');
});
