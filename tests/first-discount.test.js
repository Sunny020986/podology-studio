// Знижка на перший візит: пропонується лише новому клієнтові й лише на позначені послуги;
// розрахунок бачить клієнт до запису й після нього; ціна фіксується в записі.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, makeMaster, nextSlot } = require('./helpers');

let srv, M, svcDisc, svcPlain, svcNote;
const quote = (id, phone) => srv.req('GET', `/api/first-discount?serviceId=${id}&phone=${encodeURIComponent(phone)}`);
const bookReq = async (serviceId, phone, name = 'Нова Клієнтка') => {
  const s = await nextSlot(srv, serviceId, M.id);
  return srv.req('POST', '/api/appointments', { body: { serviceId, date: s.date, time: s.time, name, phone, masterId: M.id } });
};
const row = (id) => { const db = new Database(path.join(srv.dir, 'studio.db'), { readonly: true }); try { return db.prepare('SELECT price_uah, price_full_uah, discount_pct, status FROM appointments WHERE id = ?').get(id); } finally { db.close(); } };

before(async () => {
  srv = await startServer();
  M = await makeMaster(srv, 'discm', 'Майстер Знижка');
  const list = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body;
  // Міграція позначила «первинні» послуги (за текстом акції)
  const first = list.find((s) => /^Первин/.test(s.name));
  assert.ok(first && first.first_discount === 1, 'первинна послуга позначена');
  svcDisc = first.id;
  svcPlain = list.find((s) => !s.first_discount).id;
  svcNote = list.find((s) => !s.first_discount && s.id !== svcPlain).id;
  const set = (id, body) => srv.req('PATCH', `/api/admin/services/${id}`, { token: srv.ADMIN, body });
  assert.equal((await set(svcDisc, { price_uah: 1235 })).status, 200);
  assert.equal((await set(svcPlain, { price_uah: 500 })).status, 200);
  assert.equal((await set(svcNote, { price_uah: 0, first_discount: 1, price_note: 'від 1380 грн' })).status, 200);
});
after(() => srv && srv.stop());

test('новому клієнтові: ціна, знижка 10% і сума до сплати; на непозначену послугу знижки немає', async () => {
  const q = (await quote(svcDisc, '+380671110001')).body;
  assert.deepEqual(q, { eligible: true, kind: 'first', invited: false, pct: 10, pctFirst: 10, pctFriend: 0, full: 1235, discount: 123, final: 1112, friend: { available: true, left: 5 } }); // 1235 × 0,9 = 1111,5 → 1112 (округлення до більшого)
  const plain = (await quote(svcPlain, '+380671110001')).body;
  assert.equal(plain.eligible, false);
  assert.equal(plain.final, 500);
  const noNum = (await quote(svcNote, '+380671110001')).body;
  assert.equal(noNum.eligible, true);
  assert.equal(noNum.final, null, 'без числової ціни суму не вигадуємо');
  assert.equal((await quote(svcDisc, '123')).body.eligible, false, 'неповний номер — без пропозиції');
  assert.equal((await srv.req('GET', '/api/first-discount?serviceId=99999&phone=+380671110001')).status, 400);
});

test('запис: ціна зі знижкою у відповіді й у базі; другий запис того ж номера — вже за повною ціною', async () => {
  const r = await bookReq(svcDisc, '+380671110002');
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.price, { full: 1235, pct: 10, pctFirst: 10, pctFriend: 0, kind: 'first', discount: 123, final: 1112, note: '' });
  assert.deepEqual(row(r.body.id), { price_uah: 1112, price_full_uah: 1235, discount_pct: 10, status: 'new' });

  // Той самий номер в іншому записі: пропозиції вже немає (формат номера не важливий)
  assert.equal((await quote(svcDisc, '0671110002')).body.eligible, false);
  const r2 = await bookReq(svcDisc, '067 111 00 02');
  assert.equal(r2.status, 201, r2.text);
  assert.equal(r2.body.price.pct, 0);
  assert.equal(r2.body.price.final, 1235);
  assert.deepEqual(row(r2.body.id), { price_uah: 1235, price_full_uah: 1235, discount_pct: 0, status: 'new' });
});

test('скасований запис не робить клієнта «старим»: знижка лишається', async () => {
  const r = await bookReq(svcDisc, '+380671110003');
  assert.equal(r.status, 201, r.text);
  assert.equal((await srv.req('PATCH', `/api/admin/appointments/${r.body.id}`, { token: srv.ADMIN, body: { status: 'cancelled' } })).status, 200);
  assert.equal((await quote(svcDisc, '+380671110003')).body.eligible, true);
});

test('послуга без числової ціни: знижка обіцяна, сума — ні; ціна текстом у відповіді', async () => {
  const r = await bookReq(svcNote, '+380671110004');
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.price, { full: null, pct: 10, pctFirst: 10, pctFriend: 0, kind: 'first', discount: 0, final: null, note: 'від 1380 грн' });
});

test('відсоток 0 вимикає знижку; некоректний відсоток відхиляється', async () => {
  const studio = (await srv.req('GET', '/api/settings')).body.studio;
  const put = (pct) => srv.req('PUT', '/api/admin/studio', { token: srv.ADMIN, body: { ...studio, first_discount_pct: pct } });
  assert.equal((await put('95')).status, 400);
  assert.equal((await put('abc')).status, 400);
  assert.equal((await put('25')).status, 200);
  assert.equal((await quote(svcDisc, '+380671110005')).body.final, 926); // 1235 × 0,75 = 926,25
  assert.equal((await put('0')).status, 200);
  assert.equal((await quote(svcDisc, '+380671110005')).body.eligible, false);
});

test('кабінет клієнта показує ціну зі знижкою', async () => {
  await srv.req('PUT', '/api/admin/studio', { token: srv.ADMIN, body: { ...(await srv.req('GET', '/api/settings')).body.studio, first_discount_pct: '10' } });
  const phone = '+380671110006';
  const r = await bookReq(svcDisc, phone);
  assert.equal(r.status, 201, r.text);
  const reg = await srv.req('POST', '/api/account/register', { body: { name: 'Нова Клієнтка', phone, password: 'cabinet-pass-1' } });
  assert.equal(reg.status, 201, reg.text);
  const cookie = (reg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const list = (await srv.req('GET', '/api/account/appointments', { headers: { Cookie: cookie } })).body;
  assert.deepEqual(list[0].price, { full: 1235, pct: 10, kind: 'first', final: 1112 });
});

test('адмін ставить знижку на запис: ціна перераховується, 0 прибирає; майстрові й без входу — ні', async () => {
  const phone = '+380671110099';
  const r = await bookReq(svcPlain, phone, 'Знижка Від Адміна'); // послуга без знижки на перший візит, 500 грн
  assert.equal(r.status, 201, r.text);
  const id = r.body.id;
  const set = (pct, token = srv.ADMIN) => srv.req('PATCH', `/api/admin/appointments/${id}/discount`, { token, body: { pct } });
  const ok = await set(15);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body, { full: 500, pct: 15, final: 425 });
  const db = new Database(path.join(srv.dir, 'studio.db'), { readonly: true });
  try { assert.equal(db.prepare('SELECT discount_kind FROM appointments WHERE id = ?').get(id).discount_kind, 'manual'); } finally { db.close(); }
  const list = (await srv.req('GET', '/api/admin/appointments?from=2020-01-01&to=2099-12-31', { token: srv.ADMIN })).body;
  const a = list.find((x) => x.id === id);
  assert.deepEqual({ p: a.price_uah, f: a.price_full_uah, d: a.discount_pct, k: a.discount_kind }, { p: 425, f: 500, d: 15, k: 'manual' });
  assert.equal((await set(91)).status, 400);
  assert.equal((await set('abc')).status, 400);
  assert.equal((await set(10, M.token)).status, 403, 'майстрові — ні');
  assert.equal((await srv.req('PATCH', `/api/admin/appointments/${id}/discount`, { body: { pct: 5 } })).status, 401);
  assert.deepEqual((await set(0)).body, { full: 500, pct: 0, final: 500 });
  const audit = (await srv.req('GET', '/api/admin/audit?limit=50', { token: srv.ADMIN })).body.rows;
  assert.ok(audit.some((x) => x.action === 'Записи: знижка 15%'));
  assert.equal((await srv.req('PATCH', `/api/admin/appointments/${id}`, { token: srv.ADMIN, body: { status: 'cancelled' } })).status, 200);
  assert.equal((await set(5)).status, 409, 'скасований запис — ні');
});
