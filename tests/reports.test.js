// Звіт по майстрах: ціна на момент запису, підрахунок візитів і сум, CSV, права.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer, makeMaster, insertAppt, book } = require('./helpers');

let srv, A, B, s1, s2, prev;
const dbRun = (fn) => { const db = new Database(path.join(srv.dir, 'studio.db')); try { return fn(db); } finally { db.close(); } };
const setPrice = (id, price) => srv.req('PATCH', `/api/admin/services/${id}`, { token: srv.ADMIN, body: { price_uah: price } });

before(async () => {
  srv = await startServer();
  [s1, s2] = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
  B = await makeMaster(srv, 'masterb', 'Майстер Б');
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  prev = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; // минулий місяць: усі записи вже минули
});
after(() => srv && srv.stop());

test('ціна запам’ятовується на момент запису й не змінюється разом із прайсом', async () => {
  await setPrice(s1.id, 500);
  await srv.register('+380631000001'); // знижка на перший візит — лише з кабінетом
  const a = await book(srv, { serviceId: s1.id, masterId: A.id, phone: '+380631000001' });
  await setPrice(s1.id, 600);
  // Перший візит: 500 грн мінус знижка 10% = 450; повна ціна за прайсом теж запам'ятана
  assert.deepEqual(dbRun((db) => db.prepare('SELECT price_uah, price_full_uah FROM appointments WHERE id = ?').get(a.id)), { price_uah: 450, price_full_uah: 500 });
  // Той самий клієнт вдруге: без знижки, за прайсом на цей момент (600)
  const again = await book(srv, { serviceId: s1.id, masterId: A.id, phone: '+380631000001' });
  assert.equal(dbRun((db) => db.prepare('SELECT price_uah FROM appointments WHERE id = ?').get(again.id).price_uah), 600);
});

test('звіт: візити, неявки, скасовані, не позначені; суми за ціною запису або поточною', async () => {
  await setPrice(s2.id, 800); // s1 = 600 з попереднього тесту
  insertAppt(srv, { date: `${prev}-10`, phone: '+380631000010', masterId: A.id, serviceId: s1.id, status: 'done' });
  insertAppt(srv, { date: `${prev}-11`, phone: '+380631000011', masterId: A.id, serviceId: s2.id, status: 'done' });
  insertAppt(srv, { date: `${prev}-12`, phone: '+380631000012', masterId: A.id, serviceId: s1.id, status: 'confirmed' }); // не позначено, але візит
  insertAppt(srv, { date: `${prev}-13`, phone: '+380631000013', masterId: A.id, serviceId: s1.id, status: 'no_show' });
  insertAppt(srv, { date: `${prev}-14`, phone: '+380631000014', masterId: A.id, serviceId: s1.id, status: 'cancelled' });
  const bId = insertAppt(srv, { date: `${prev}-15`, phone: '=HYPERLINK("x")', name: '=СУМ(1)', masterId: B.id, serviceId: s2.id, status: 'done' });
  dbRun((db) => db.prepare('UPDATE appointments SET price_uah = 1000 WHERE id = ?').run(bId));
  const r = (await srv.req('GET', `/api/admin/reports/masters?month=${prev}`, { token: srv.ADMIN })).body;
  const a = r.rows.find((x) => x.master_id === A.id);
  const b = r.rows.find((x) => x.master_id === B.id);
  assert.deepEqual({ v: a.visits, rev: a.revenue, ns: a.no_shows, c: a.cancelled, u: a.unmarked, now: a.price_now }, { v: 3, rev: 600 + 800 + 600, ns: 1, c: 1, u: 1, now: 3 });
  assert.equal(a.avg, Math.round(2000 / 3));
  assert.deepEqual({ v: b.visits, rev: b.revenue, now: b.price_now }, { v: 1, rev: 1000, now: 0 });
  assert.equal(r.total.revenue, 3000);
  assert.equal(r.rows[0].master_id, A.id, 'спершу майстер з більшою сумою');
});

test('CSV: звіт і записи місяця для Excel; захист від формул', async () => {
  const m = await srv.req('GET', `/api/admin/reports/masters.csv?month=${prev}`, { token: srv.ADMIN });
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /text\/csv/);
  // fetch().text() прибирає BOM, тож перевіряємо перші байти напряму
  const raw = Buffer.from(await (await fetch(srv.base + `/api/admin/reports/masters.csv?month=${prev}`, { headers: { Authorization: 'Bearer ' + srv.ADMIN } })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM для Excel');
  assert.ok(m.text.startsWith('"Майстер";"Візитів"'), 'заголовок');
  assert.match(m.text, /"Усього";"4";"3000"/);
  const ap = await srv.req('GET', `/api/admin/reports/appointments.csv?month=${prev}&masterId=${B.id}`, { token: srv.ADMIN });
  const lines = ap.text.trim().split('\r\n');
  assert.equal(lines.length, 2, 'заголовок + 1 запис майстра Б');
  assert.match(lines[1], /"'=СУМ\(1\)"/, 'ім’я, схоже на формулу, з апострофом');
  assert.match(lines[1], /"'=HYPERLINK/);
  assert.match(lines[1], /"Відбувся";"1000"$/);
});

test('помилки й права', async () => {
  assert.equal((await srv.req('GET', '/api/admin/reports/masters?month=2026-13', { token: srv.ADMIN })).status, 400);
  assert.equal((await srv.req('GET', `/api/admin/reports/masters?month=${prev}`, { token: A.token })).status, 403);
  assert.equal((await srv.req('GET', `/api/admin/reports/appointments.csv?month=${prev}`, { token: A.token })).status, 403);
  assert.equal((await srv.req('GET', `/api/admin/reports/masters?month=${prev}`)).status, 401);
});
