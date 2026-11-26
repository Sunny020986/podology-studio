// Окремі входи адміністраторів і журнал дій: права, вхід, блокування, хто що зробив, знеособлення при видаленні клієнта.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer, makeMaster, book } = require('./helpers');

let srv, serviceId, M, adminId, adminToken;
const PASS = 'admin-pass-123';
const login = (l, p) => srv.req('POST', '/api/admin-login', { body: { login: l, password: p } });
const auditRows = async (q = '') => {
  const r = await srv.req('GET', '/api/admin/audit?limit=500' + q, { token: srv.ADMIN });
  assert.equal(r.status, 200, r.text);
  return r.body.rows;
};

before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  M = await makeMaster(srv, 'auditm', 'Майстер Журнал');
});
after(() => srv && srv.stop());

test('власник додає адміністратора; той входить і має права суперадміна, крім «Доступу»', async () => {
  const c = await srv.req('POST', '/api/admin/admin-users', { token: srv.ADMIN, body: { name: 'Оксана Адмін', login: 'oksana', password: PASS } });
  assert.equal(c.status, 201, c.text);
  adminId = c.body.id;
  assert.equal((await srv.req('POST', '/api/admin/admin-users', { token: srv.ADMIN, body: { name: 'Дубль', login: 'oksana', password: PASS } })).status, 409);
  assert.equal((await srv.req('POST', '/api/admin/admin-users', { token: srv.ADMIN, body: { name: 'Короткий', login: 'kor', password: '123' } })).status, 400);

  const r = await login('oksana', PASS);
  assert.equal(r.status, 200, r.text);
  adminToken = r.body.token;
  const me = (await srv.req('GET', '/api/admin/me', { token: adminToken })).body;
  assert.deepEqual(me, { role: 'super', owner: false, admin: { id: adminId, name: 'Оксана Адмін' }, telegram: false });
  assert.equal((await srv.req('GET', '/api/admin/me', { token: srv.ADMIN })).body.owner, true);
  assert.equal((await srv.req('GET', '/api/admin/masters', { token: adminToken })).status, 200, 'бачить майстрів');
  assert.equal((await srv.req('GET', '/api/admin/admin-users', { token: adminToken })).status, 403);
  assert.equal((await srv.req('POST', '/api/admin/admin-users', { token: adminToken, body: { name: 'Хтось', login: 'someone', password: PASS } })).status, 403);
  assert.equal((await srv.req('GET', '/api/admin/audit', { token: adminToken })).status, 403);
  assert.equal((await srv.req('GET', '/api/admin/audit.csv', { token: adminToken })).status, 403);
  assert.equal((await srv.req('GET', '/api/admin/audit', { token: M.token })).status, 403, 'майстрові теж ні');

  const bad = await login('oksana', 'wrong-password');
  assert.equal(bad.status, 401);
  const rows = await auditRows();
  assert.ok(rows.some((x) => x.action === 'Вхід в адмінку' && x.actor_name === 'Оксана Адмін'), 'вхід записано');
  assert.ok(rows.some((x) => x.action === 'Вхід: невдала спроба (адміністратор)' && x.actor_name === 'oksana'), 'невдалу спробу записано');
  assert.ok(rows.some((x) => x.action === 'Доступ: адміністратора додано' && x.actor_kind === 'owner'), 'власник додав адміністратора');
});

test('журнал: хто, що й з ким; невдалі дії й паролі не потрапляють', async () => {
  const s = (await srv.req('GET', `/api/next-slot?serviceId=${serviceId}&masterId=${M.id}`)).body;
  const c = await srv.req('POST', '/api/admin/appointments', { token: adminToken, body: { serviceId, date: s.date, time: s.slots[0], name: 'Віра Журнал', phone: '+380671119911', masterId: M.id } });
  assert.equal(c.status, 201, c.text);
  assert.equal((await srv.req('PATCH', `/api/admin/appointments/${c.body.id}`, { token: M.token, body: { status: 'confirmed' } })).status, 200);
  assert.equal((await srv.req('PATCH', `/api/admin/appointments/${c.body.id}`, { token: M.token, body: { status: 'nonsense' } })).status, 400);
  assert.equal((await srv.req('POST', '/api/admin/services', { token: adminToken, body: { name: '' } })).status, 400);

  const rows = await auditRows();
  const made = rows.find((x) => x.action === 'Записи: новий запис' && x.target.includes('Віра Журнал'));
  assert.ok(made, 'новий запис');
  assert.equal(made.actor_name, 'Оксана Адмін');
  assert.equal(made.actor_kind, 'admin');
  const st = rows.find((x) => x.action === 'Записи: статус «Підтверджено»');
  assert.ok(st, 'зміна статусу');
  assert.equal(st.actor_name, 'Майстер Журнал');
  assert.match(st.target, /Віра Журнал · \d\d\.\d\d\.\d{4} \d\d:\d\d/);
  assert.ok(!rows.some((x) => /nonsense/.test(x.action)), 'невдала дія не записана');
  assert.ok(!rows.some((x) => x.action.startsWith('Послуги')), 'невдале додавання послуги не записане');
  assert.ok(!JSON.stringify(rows).includes(PASS), 'пароль ніде не збережено');

  // Фільтр за людиною
  const onlyAdmin = await auditRows(`&actor=admin:${adminId}`);
  assert.ok(onlyAdmin.length >= 2);
  assert.ok(onlyAdmin.every((x) => x.actor_kind === 'admin' && x.actor_id === adminId));
  const actors = (await srv.req('GET', '/api/admin/audit/actors', { token: srv.ADMIN })).body;
  assert.ok(actors.some((a) => a.kind === 'master' && a.name === 'Майстер Журнал'));

  // Вивантаження для Excel
  const csv = await fetch(srv.base + '/api/admin/audit.csv', { headers: { Authorization: 'Bearer ' + srv.ADMIN } });
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM для Excel');
  assert.match(bytes.toString('utf8'), /"Коли";"Хто";"Роль";"Дія"/);
  assert.match(bytes.toString('utf8'), /Віра Журнал/);
});

test('блокування, новий пароль і видалення одразу закривають доступ, зокрема канал адмінки', async () => {
  // Відкритий канал адмінки адміністратора
  const ws = new WebSocket(srv.base.replace('http', 'ws') + '/ws?admin=' + encodeURIComponent(adminToken));
  const closed = new Promise((ok) => ws.on('close', (code) => ok(code)));
  await new Promise((ok) => ws.once('open', ok));

  assert.equal((await srv.req('PUT', `/api/admin/admin-users/${adminId}`, { token: srv.ADMIN, body: { status: 'blocked' } })).status, 200);
  assert.equal((await srv.req('GET', '/api/admin/me', { token: adminToken })).status, 401, 'старий вхід не діє');
  assert.equal(await closed, 4003, 'канал закрито');
  assert.equal((await login('oksana', PASS)).status, 403, 'заблокований не входить');

  assert.equal((await srv.req('PUT', `/api/admin/admin-users/${adminId}`, { token: srv.ADMIN, body: { status: 'active' } })).status, 200);
  const t1 = (await login('oksana', PASS)).body.token;
  assert.equal((await srv.req('PUT', `/api/admin/admin-users/${adminId}`, { token: srv.ADMIN, body: { password: 'new-pass-456' } })).status, 200);
  assert.equal((await srv.req('GET', '/api/admin/me', { token: t1 })).status, 401, 'після зміни пароля старий вхід не діє');
  assert.equal((await login('oksana', PASS)).status, 401);
  const t2 = (await login('oksana', 'new-pass-456')).body.token;
  assert.equal((await srv.req('POST', '/api/admin/logout', { token: t2 })).status, 200);
  assert.equal((await srv.req('GET', '/api/admin/me', { token: t2 })).status, 401, 'після виходу сесія закрита');

  const t3 = (await login('oksana', 'new-pass-456')).body.token;
  assert.equal((await srv.req('DELETE', `/api/admin/admin-users/${adminId}`, { token: srv.ADMIN })).status, 200);
  assert.equal((await srv.req('GET', '/api/admin/me', { token: t3 })).status, 401);
  assert.equal((await login('oksana', 'new-pass-456')).status, 401);
  const list = (await srv.req('GET', '/api/admin/admin-users', { token: srv.ADMIN })).body;
  assert.ok(!list.some((u) => u.id === adminId), 'видаленого немає в списку');
  assert.equal((await srv.req('POST', '/api/admin/admin-users', { token: srv.ADMIN, body: { name: 'Нова Оксана', login: 'oksana', password: PASS } })).status, 201, 'логін звільнився');
  assert.ok((await auditRows()).some((x) => x.actor_name === 'Оксана Адмін'), 'дії видаленого лишились у журналі');
});

test('повне видалення клієнта стирає його ім\'я з журналу', async () => {
  const b = await book(srv, { serviceId, masterId: M.id, name: 'Стерти Мене', phone: '+380671119922' });
  assert.equal((await srv.req('PATCH', `/api/admin/appointments/${b.id}`, { token: srv.ADMIN, body: { status: 'confirmed' } })).status, 200);
  assert.equal((await srv.req('PUT', '/api/admin/clients/671119922/note', { token: srv.ADMIN, body: { note: 'алергія на йод' } })).status, 200);
  assert.ok(JSON.stringify(await auditRows()).includes('Стерти Мене'));
  const del = await srv.req('DELETE', '/api/admin/clients/671119922', { token: srv.ADMIN, body: { confirm: '9922' } });
  assert.equal(del.status, 200, del.text);
  const rows = await auditRows();
  assert.ok(!JSON.stringify(rows).includes('Стерти Мене'), "ім'я клієнта зникло з журналу");
  assert.ok(rows.some((x) => x.action === 'Клієнти: видалено повністю' && x.target === '(дані клієнта видалено)'));
  assert.ok(rows.filter((x) => x.target === '(дані клієнта видалено)').length >= 3, 'старі рядки знеособлено');
});
