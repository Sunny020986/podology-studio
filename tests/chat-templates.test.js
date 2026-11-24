// Швидкі відповіді в чаті: стартові шаблони, підстановка даних кабінету, зміни, права.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster } = require('./helpers');

let srv, A;
before(async () => {
  srv = await startServer();
  A = await makeMaster(srv, 'mastera', 'Майстер А');
});
after(() => srv && srv.stop());
const list = async () => (await srv.req('GET', '/api/admin/chat-templates', { token: srv.ADMIN })).body;

test('стартові шаблони й підстановка адреси й телефону з налаштувань', async () => {
  const st = (await srv.req('GET', '/api/admin/studio', { token: srv.ADMIN })).body;
  await srv.req('PUT', '/api/admin/studio', { token: srv.ADMIN, body: { ...st, city: 'Київ', address: 'вул. Тестова, 1', phone: '' } });
  const t = await list();
  assert.equal(t.length, 3);
  const addr = t.find((x) => x.title === 'Адреса й телефон');
  assert.equal(addr.body, 'Наша адреса: {адреса}. Телефон: {телефон}.');
  assert.equal(addr.text, 'Наша адреса: Київ, вул. Тестова, 1. Телефон: [телефон не вказано в налаштуваннях].');
});

test('додати, змінити, видалити; перевірка довжини', async () => {
  assert.equal((await srv.req('POST', '/api/admin/chat-templates', { token: srv.ADMIN, body: { title: '', body: 'x' } })).status, 400);
  assert.equal((await srv.req('POST', '/api/admin/chat-templates', { token: srv.ADMIN, body: { title: 'Довга', body: 'а'.repeat(1001) } })).status, 400);
  const c = await srv.req('POST', '/api/admin/chat-templates', { token: srv.ADMIN, body: { title: 'Сайт', body: 'Наш сайт: {сайт}' } });
  assert.equal(c.status, 201);
  assert.match((await list()).find((x) => x.id === c.body.id).text, /\[сайт не вказано/);
  assert.equal((await srv.req('PUT', `/api/admin/chat-templates/${c.body.id}`, { token: srv.ADMIN, body: { title: 'Назва', body: 'Ми — {назва}' } })).status, 200);
  const changed = (await list()).find((x) => x.id === c.body.id);
  assert.equal(changed.title, 'Назва');
  assert.doesNotMatch(changed.text, /\{назва\}/);
  assert.equal((await srv.req('DELETE', `/api/admin/chat-templates/${c.body.id}`, { token: srv.ADMIN })).status, 200);
  assert.equal((await list()).length, 3);
  assert.equal((await srv.req('PUT', '/api/admin/chat-templates/99999', { token: srv.ADMIN, body: { title: 'x', body: 'y' } })).status, 404);
});

test('шаблони — лише для адміністратора', async () => {
  assert.equal((await srv.req('GET', '/api/admin/chat-templates', { token: A.token })).status, 403);
  assert.equal((await srv.req('GET', '/api/admin/chat-templates')).status, 401);
});
