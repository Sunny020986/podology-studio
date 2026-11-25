// Список клієнтів в адмінці: зареєстровані в кабінеті видно навіть без записів (лише суперадміну), з позначкою «кабінет».
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, book } = require('./helpers');

let srv, M, svc;
before(async () => {
  srv = await startServer();
  svc = (await srv.req('GET', '/api/services')).body[0].id;
  M = await makeMaster(srv, 'accm', 'Майстер Кабінет');
});
after(() => srv && srv.stop());

test('зареєстрований без записів: суперадмін бачить у списку й картці, майстер — ні', async () => {
  const reg = await srv.req('POST', '/api/account/register', { body: { name: 'Нова Реєстрація', phone: '+380671116601', password: 'cabinet-pass-1' } });
  assert.equal(reg.status, 201, reg.text);
  const list = (await srv.req('GET', '/api/admin/clients?q=Реєстрація', { token: srv.ADMIN })).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].key, '671116601');
  assert.equal(list[0].visits, 0);
  assert.equal(list[0].account.telegram, false);
  assert.ok(list[0].account.since);
  assert.equal((await srv.req('GET', '/api/admin/clients?q=Реєстрація', { token: M.token })).body.length, 0, 'майстрові — ні');
  const card = await srv.req('GET', '/api/admin/clients/671116601', { token: srv.ADMIN });
  assert.equal(card.status, 200, card.text);
  assert.deepEqual({ n: card.body.name, a: card.body.appointments.length, acc: !!card.body.account }, { n: 'Нова Реєстрація', a: 0, acc: true });
  assert.equal((await srv.req('GET', '/api/admin/clients/671116601', { token: M.token })).status, 404);
  const csv = await fetch(srv.base + '/api/admin/clients.csv', { headers: { Authorization: 'Bearer ' + srv.ADMIN } });
  assert.match(await csv.text(), /Нова Реєстрація.*"так"/);
});

test('клієнт із записом і кабінетом — один рядок з позначкою; без кабінету — без позначки', async () => {
  await book(srv, { serviceId: svc, masterId: M.id, name: 'Записаний Кабінет', phone: '+380671116602' });
  await srv.req('POST', '/api/account/register', { body: { name: 'Записаний Кабінет', phone: '+380671116602', password: 'cabinet-pass-1' } });
  await book(srv, { serviceId: svc, masterId: M.id, name: 'Лише Запис', phone: '+380671116603' });
  const list = (await srv.req('GET', '/api/admin/clients', { token: srv.ADMIN })).body;
  assert.equal(list.filter((c) => c.key === '671116602').length, 1, 'без дублів');
  assert.ok(list.find((c) => c.key === '671116602').account);
  assert.ok(!list.find((c) => c.key === '671116603').account);
  const mine = (await srv.req('GET', '/api/admin/clients', { token: M.token })).body;
  assert.ok(mine.find((c) => c.key === '671116602').account, 'майстер бачить позначку у свого клієнта');
});
