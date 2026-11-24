// Пошук клієнта з бази для форми запису: ім'я, телефон у будь-якому записі, архів, ліміт, права майстра.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, insertAppt, daysAgo } = require('./helpers');

let srv, A, B, serviceId;
const find = async (q, token = srv.ADMIN) => {
  const r = await srv.req('GET', '/api/admin/client-search?q=' + encodeURIComponent(q), { token });
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const names = (list) => list.map((c) => c.name);

before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
  B = await makeMaster(srv, 'masterb', 'Майстер Б');
  insertAppt(srv, { date: daysAgo(10), phone: '+380501112233', name: 'Олена Петренко', masterId: A.id, serviceId, status: 'done' });
  insertAppt(srv, { date: daysAgo(5), phone: '0671234567', name: 'Олеся Коваль', masterId: A.id, serviceId, status: 'done' });
  insertAppt(srv, { date: daysAgo(3), phone: '+380931112244', name: 'Марія Олійник', masterId: B.id, serviceId, status: 'done' });
  insertAppt(srv, { date: daysAgo(20), phone: '0509998877', name: "Ганна Ков'ях", masterId: A.id, serviceId, status: 'no_show' });
  insertAppt(srv, { date: daysAgo(15), phone: '0509998877', name: "Ганна Ков'ях", masterId: A.id, serviceId, status: 'no_show' });
});
after(() => srv && srv.stop());

test("ім'я: частина слова, великі літери, кілька слів", async () => {
  assert.deepEqual(names(await find('оле')).sort(), ['Олена Петренко', 'Олеся Коваль']);
  assert.deepEqual(names(await find('ПЕТРЕНКО')), ['Олена Петренко']);
  assert.deepEqual(names(await find('олена петр')), ['Олена Петренко']);
  assert.deepEqual(names(await find('ков')).sort(), ["Ганна Ков'ях", 'Олеся Коваль']);
  assert.deepEqual(names(await find('ков’ях')), ["Ганна Ков'ях"], 'різні апострофи — те саме');
  assert.deepEqual(await find('zzz'), []);
});

test('телефон у будь-якому записі', async () => {
  assert.deepEqual(names(await find('0501')), ['Олена Петренко']);
  assert.deepEqual(names(await find('+38067123')), ['Олеся Коваль'], 'збережено як 067…, шукаємо з +38');
  assert.deepEqual(names(await find('+380 67 123 45 67')), ['Олеся Коваль']);
  assert.deepEqual(names(await find('0931112244')), ['Марія Олійник'], 'збережено як +380…, шукаємо з 0');
  assert.deepEqual(names(await find('112')).sort(), ['Марія Олійник', 'Олена Петренко']);
});

test('замалий запит — порожньо', async () => {
  assert.deepEqual(await find('о'), []);
  assert.deepEqual(await find('12'), []);
  assert.deepEqual(await find(''), []);
});

test('у результаті є візити, неявки й архів', async () => {
  const g = (await find('ганна'))[0];
  assert.equal(g.noshow_streak, 2);
  assert.equal(g.visits, 0);
  assert.equal((await srv.req('POST', `/api/admin/clients/${g.key}/archive`, { token: srv.ADMIN })).status, 200);
  const again = (await find('ганна'))[0];
  assert.equal(again.archived, true, 'клієнтів з архіву теж знаходить');
  const o = (await find('петренко'))[0];
  assert.equal(o.visits, 1);
  assert.equal(o.key, '501112233');
});

test('не більше 10 результатів', async () => {
  for (let i = 0; i < 12; i++) insertAppt(srv, { date: daysAgo(30 + i), phone: '+38063000' + String(1000 + i), name: 'Тестова Клієнтка ' + i, masterId: A.id, serviceId, status: 'done' });
  assert.equal((await find('тестова')).length, 10);
});

test('майстер шукає лише серед своїх клієнтів', async () => {
  assert.deepEqual(await find('марія', A.token), []);
  assert.deepEqual(names(await find('марія', B.token)), ['Марія Олійник']);
  assert.deepEqual(names(await find('оле', B.token)), [], 'клієнти майстра А не видно');
  assert.equal((await srv.req('GET', '/api/admin/client-search?q=оле')).status, 401);
});
