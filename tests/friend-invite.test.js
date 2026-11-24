// «Приведи друга»: форма запису друга після запису клієнта й у кабінеті; один відкритий запис за замовчуванням;
// після візиту друга (або скасування) можливість повертається; друг має бути новим клієнтом.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, makeMaster, nextSlot } = require('./helpers');

let srv, M, svc, n = 0;
const dbRun = (fn) => { const db = new Database(path.join(srv.dir, 'studio.db')); try { return fn(db); } finally { db.close(); } };
const setStatus = (id, st) => dbRun((db) => db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(st, id));
const phone = () => '+38067333' + String(++n).padStart(4, '0');

async function book(p, name) {
  const s = await nextSlot(srv, svc, M.id);
  const r = await srv.req('POST', '/api/appointments', { body: { serviceId: svc, date: s.date, time: s.time, name, phone: p, masterId: M.id } });
  assert.equal(r.status, 201, r.text);
  return r.body;
}
async function friendBody(code, p, name = 'Друг Іван') {
  const s = await nextSlot(srv, svc, M.id);
  return { code, serviceId: svc, date: s.date, time: s.time, name, phone: p, masterId: M.id };
}
const state = async (code) => (await srv.req('GET', '/api/friend-invite?code=' + encodeURIComponent(code))).body;
const studio = async () => (await srv.req('GET', '/api/settings')).body.studio;
const putStudio = async (patch) => srv.req('PUT', '/api/admin/studio', { token: srv.ADMIN, body: { ...(await studio()), ...patch } });

before(async () => {
  srv = await startServer();
  svc = (await srv.req('GET', '/api/services')).body[0].id;
  M = await makeMaster(srv, 'friendm', 'Майстер Друзі');
});
after(() => srv && srv.stop());

test('після запису клієнта пропонується «Приведи друга»; друга можна записати один раз', async () => {
  const b = await book(phone(), 'Олена Запрошує');
  assert.equal(b.friendInvite.available, true);
  const code = b.friendInvite.code;
  assert.deepEqual(await state(code), { enabled: true, available: true, open: 0, max: 1 });

  const f = await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, phone()) });
  assert.equal(f.status, 201, f.text);
  assert.ok(f.body.id && f.body.price, 'запис друга з ціною');
  assert.equal(f.body.next.available, false, 'друге запрошення вже недоступне');
  // Персонал бачить, хто привів
  const list = (await srv.req('GET', '/api/admin/appointments?from=2020-01-01&to=2099-12-31', { token: srv.ADMIN })).body;
  assert.match(list.find((a) => a.id === f.body.id).client_comment, /^🤝 Друг клієнта Олена Запрошує\./);

  const again = await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, phone(), 'Друг Другий') });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Ви вже записали друга/);

  // Друг прийшов: можливість повертається
  setStatus(f.body.id, 'done');
  assert.equal((await state(code)).available, true);
  const second = await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, phone(), 'Друг Третій') });
  assert.equal(second.status, 201, second.text);
});

test('скасований запис друга звільняє місце, неявка — ні', async () => {
  const b = await book(phone(), 'Ірина Запрошує');
  const code = b.friendInvite.code;
  const f1 = await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, phone()) });
  assert.equal(f1.status, 201, f1.text);
  setStatus(f1.body.id, 'cancelled');
  assert.equal((await state(code)).available, true, 'скасовано — місце вільне');
  const f2 = await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, phone(), 'Друг Не Прийшов') });
  assert.equal(f2.status, 201, f2.text);
  setStatus(f2.body.id, 'no_show');
  assert.equal((await state(code)).available, false, 'неявка друга — місце не звільняється');
});

test('друг має бути новим і іншим номером; без коду запису — 404', async () => {
  const mine = phone();
  const b = await book(mine, 'Марія Запрошує');
  const code = b.friendInvite.code;
  const self = await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, mine) });
  assert.equal(self.status, 400);
  assert.match(self.body.error, /друга, а не себе/);

  const known = phone();
  await book(known, 'Старий Клієнт');
  const old = await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, known) });
  assert.equal(old.status, 409);
  assert.match(old.body.error, /нових клієнтів/);
  assert.equal((await state(code)).available, true, 'помилка не витрачає запрошення');

  assert.equal((await srv.req('POST', '/api/friend-invite', { body: await friendBody('r-невірний', phone()) })).status, 404);
  assert.equal((await srv.req('GET', '/api/friend-invite?code=nope')).status, 404);
});

test('налаштування: ліміт 2, некоректний ліміт відхиляється, порожня акція вимикає функцію', async () => {
  const b = await book(phone(), 'Галина Запрошує');
  const code = b.friendInvite.code;
  assert.equal((await putStudio({ friend_max_open: '9' })).status, 400);
  assert.equal((await putStudio({ friend_max_open: '2' })).status, 200);
  assert.equal((await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, phone(), 'Друг А') })).status, 201);
  assert.equal((await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, phone(), 'Друг Б') })).status, 201);
  assert.equal((await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, phone(), 'Друг В') })).status, 409);

  const orig = (await studio()).promo_friend;
  assert.equal((await putStudio({ promo_friend: '' })).status, 200);
  const off = await book(phone(), 'Без Акції');
  assert.equal(off.friendInvite, undefined, 'акцію вимкнено — пропозиції немає');
  assert.equal((await srv.req('POST', '/api/friend-invite', { body: await friendBody(code, phone(), 'Друг Г') })).status, 404);
  await putStudio({ promo_friend: orig, friend_max_open: '1' });
});

test('кабінет: статус і запис друга за сесією; без входу — 401', async () => {
  const mine = phone();
  assert.equal((await srv.req('GET', '/api/account/friend-invite')).status, 401);
  const reg = await srv.req('POST', '/api/account/register', { body: { name: 'Кабінетна Клієнтка', phone: mine, password: 'cabinet-pass-1' } });
  assert.equal(reg.status, 201, reg.text);
  const Cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  const st = await srv.req('GET', '/api/account/friend-invite', { headers: { Cookie } });
  assert.deepEqual(st.body, { enabled: true, available: true, open: 0, max: 1 });
  const { code, ...body } = await friendBody('x', phone(), 'Друг З Кабінету');
  const r = await srv.req('POST', '/api/account/friend-invite', { headers: { Cookie }, body });
  assert.equal(r.status, 201, r.text);
  assert.equal((await srv.req('GET', '/api/account/friend-invite', { headers: { Cookie } })).body.available, false);
});

test('видалення запрошувача стирає його ім\'я з коментаря запису друга', async () => {
  const mine = phone();
  const b = await book(mine, 'Стерти Запрошувача');
  const f = await srv.req('POST', '/api/friend-invite', { body: await friendBody(b.friendInvite.code, phone()) });
  assert.equal(f.status, 201, f.text);
  const key = mine.replace(/\D/g, '').slice(-9);
  const del = await srv.req('DELETE', '/api/admin/clients/' + key, { token: srv.ADMIN, body: { confirm: key.slice(-4) } });
  assert.equal(del.status, 200, del.text);
  const list = (await srv.req('GET', '/api/admin/appointments?from=2020-01-01&to=2099-12-31', { token: srv.ADMIN })).body;
  const friend = list.find((a) => a.id === f.body.id);
  assert.ok(friend, 'запис друга лишився');
  assert.ok(!friend.client_comment.includes('Стерти Запрошувача'));
  assert.match(friend.client_comment, /дані видалено/);
});
