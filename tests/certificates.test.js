// Подарункові сертифікати: код, перевірка, використання, скасування, термін дії, права.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster } = require('./helpers');
const { normCode } = require('../src/certificates');

let srv, A;
before(async () => {
  srv = await startServer();
  A = await makeMaster(srv, 'mastera', 'Майстер А');
});
after(() => srv && srv.stop());
const create = (body) => srv.req('POST', '/api/admin/certificates', { token: srv.ADMIN, body });

test('створення: код XXXX-XXXX, некоректні сума й дата — 400', async () => {
  assert.equal((await create({ amount_uah: 0 })).status, 400);
  assert.equal((await create({ amount_uah: 500, expires_on: '2000-01-01' })).status, 400);
  const r = await create({ amount_uah: 1500, recipient: 'Марія', buyer: 'Оля' });
  assert.equal(r.status, 201);
  assert.match(r.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.doesNotMatch(r.body.code, /[01OIL]/, 'без схожих символів');
  assert.equal(r.body.state, 'active');
});

test('перевірка коду: з малими літерами й без дефіса теж знаходить', async () => {
  const c = (await create({ amount_uah: 800 })).body;
  const loose = c.code.toLowerCase().replace('-', ' ');
  const r = await srv.req('GET', '/api/admin/certificates/check?code=' + encodeURIComponent(loose), { token: srv.ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, c.id);
  assert.equal((await srv.req('GET', '/api/admin/certificates/check?code=ZZZZ-9999', { token: srv.ADMIN })).status, 404);
  assert.equal(normCode('abcd2345'), 'ABCD-2345');
});

test('використання: один раз; використаний не скасувати', async () => {
  const c = (await create({ amount_uah: 1000 })).body;
  const used = await srv.req('POST', `/api/admin/certificates/${c.id}/use`, { token: srv.ADMIN, body: { note: 'педикюр' } });
  assert.equal(used.status, 200);
  assert.equal(used.body.state, 'used');
  assert.equal((await srv.req('POST', `/api/admin/certificates/${c.id}/use`, { token: srv.ADMIN, body: {} })).status, 409);
  assert.equal((await srv.req('POST', `/api/admin/certificates/${c.id}/void`, { token: srv.ADMIN })).status, 409);
});

test('скасований і прострочений не можна використати', async () => {
  const c = (await create({ amount_uah: 700 })).body;
  await srv.req('POST', `/api/admin/certificates/${c.id}/void`, { token: srv.ADMIN });
  assert.equal((await srv.req('POST', `/api/admin/certificates/${c.id}/use`, { token: srv.ADMIN, body: {} })).status, 409);
  // прострочений: дату в минулому ставимо напряму в базу
  const d = (await create({ amount_uah: 600 })).body;
  const Database = require('better-sqlite3');
  const db = new Database(require('path').join(srv.dir, 'studio.db'));
  db.prepare("UPDATE gift_certificates SET expires_on = '2025-01-01' WHERE id = ?").run(d.id);
  db.close();
  const list = (await srv.req('GET', '/api/admin/certificates', { token: srv.ADMIN })).body;
  assert.equal(list.find((x) => x.id === d.id).state, 'expired');
  assert.equal((await srv.req('POST', `/api/admin/certificates/${d.id}/use`, { token: srv.ADMIN, body: {} })).status, 409);
});

test('сертифікати — лише для адміністратора', async () => {
  assert.equal((await srv.req('GET', '/api/admin/certificates', { token: A.token })).status, 403);
  assert.equal((await srv.req('POST', '/api/admin/certificates', { token: A.token, body: { amount_uah: 100 } })).status, 403);
  assert.equal((await srv.req('GET', '/api/admin/certificates')).status, 401);
});
