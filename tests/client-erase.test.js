// Повне видалення клієнта: усі пов'язані дані, файли фото, підтвердження, права, інші клієнти цілі.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer, makeMaster, insertAppt, daysAgo, book, fakeJpeg } = require('./helpers');

let srv, A, serviceId, pastId, otherId, photoFile;
const KEY = '671112233';
const dbRun = (fn) => { const db = new Database(path.join(srv.dir, 'studio.db')); try { return fn(db); } finally { db.close(); } };

before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
  pastId = insertAppt(srv, { date: daysAgo(10), phone: '+380671112233', name: 'Ірина Видалення', masterId: A.id, serviceId, status: 'done' });
  await book(srv, { serviceId, masterId: A.id, phone: '067 111 22 33', name: 'Ірина Видалення' }); // інший запис телефону — той самий клієнт
  otherId = insertAppt(srv, { date: daysAgo(3), phone: '+380509990000', name: 'Інша Клієнтка', masterId: A.id, serviceId, status: 'done' });
  await srv.req('PUT', `/api/admin/clients/${KEY}/note`, { token: srv.ADMIN, body: { note: 'алергія на йод' } });
  await srv.req('PUT', `/api/admin/clients/${KEY}/photo-consent`, { token: srv.ADMIN, body: { granted: true } });
  const ph = await srv.req('POST', `/api/admin/clients/${KEY}/photos?date=${daysAgo(10)}`, { token: srv.ADMIN, raw: fakeJpeg(), headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal(ph.status, 200, ph.text);
  await srv.req('POST', `/api/admin/clients/${KEY}/archive`, { token: srv.ADMIN });
  const mat = await srv.req('POST', '/api/admin/materials', { token: srv.ADMIN, body: { name: 'Скоба', qty: 5 } });
  dbRun((db) => {
    photoFile = db.prepare('SELECT file FROM client_photos WHERE phone_key = ?').get(KEY).file;
    db.prepare("INSERT INTO reviews (appointment_id, name, service, rating, text, status) VALUES (?, 'Ірина', 'Огляд', 5, 'Дякую!', 'published')").run(pastId);
    db.prepare("INSERT INTO reviews (appointment_id, name, service, rating, text, status) VALUES (?, 'Інша', 'Огляд', 4, 'Добре', 'published')").run(otherId);
    db.prepare('INSERT INTO course_reminders (start_appt_id, step) VALUES (?, 1)').run(pastId);
    db.prepare("INSERT INTO material_moves (material_id, delta, reason, appt_id, note) VALUES (?, -1, 'visit', ?, 'візит')").run(mat.body.id, pastId);
    const acc = db.prepare("INSERT INTO accounts (phone, phone_key, name, pass_hash) VALUES ('+380671112233', ?, 'Ірина', 'x')").run(KEY).lastInsertRowid;
    db.prepare('INSERT INTO account_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run('h-' + acc, acc, Date.now() + 1e9);
    db.prepare("INSERT INTO account_codes (kind, key, value, expires_at) VALUES ('link', 'k1', ?, ?)").run(String(acc), Date.now() + 1e9);
    db.prepare("INSERT INTO account_codes (kind, key, value, expires_at) VALUES ('reset', ?, 'x', ?)").run(KEY, Date.now() + 1e9);
    db.prepare("INSERT INTO waitlist (service_id, date, name, phone, code) VALUES (?, ?, 'Ірина', '0671112233', 'w1')").run(serviceId, daysAgo(-5));
  });
});
after(() => srv && srv.stop());

test('попередній підрахунок показує, що буде видалено', async () => {
  const p = (await srv.req('GET', `/api/admin/clients/${KEY}/erase-preview`, { token: srv.ADMIN })).body;
  assert.deepEqual({ ...p, name: undefined }, { name: undefined, appointments: 2, future: 1, reviews: 1, photos: 1, videos: 0, note: true, account: true, waitlist: 1 });
});

test('без правильних 4 цифр і без прав — не видаляє', async () => {
  assert.equal((await srv.req('DELETE', `/api/admin/clients/${KEY}`, { token: srv.ADMIN, body: {} })).status, 400);
  assert.equal((await srv.req('DELETE', `/api/admin/clients/${KEY}`, { token: srv.ADMIN, body: { confirm: '0000' } })).status, 400);
  assert.equal((await srv.req('DELETE', `/api/admin/clients/${KEY}`, { token: A.token, body: { confirm: '2233' } })).status, 403);
  assert.equal((await srv.req('GET', `/api/admin/clients/${KEY}/erase-preview`, { token: A.token })).status, 403);
  assert.equal((await srv.req('GET', `/api/admin/clients/${KEY}`, { token: srv.ADMIN })).status, 200, 'клієнт на місці');
});

test('видаляє все пов’язане, файл фото, лишає історію складу й інших клієнтів', async () => {
  const r = await srv.req('DELETE', `/api/admin/clients/${KEY}`, { token: srv.ADMIN, body: { confirm: '2233' } });
  assert.equal(r.status, 200, r.text);
  const left = dbRun((db) => ({
    appts: db.prepare('SELECT client_phone FROM appointments').all().filter((a) => a.client_phone.replace(/\D/g, '').endsWith(KEY)).length,
    reviews: db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE appointment_id = ?').get(pastId).n,
    otherReview: db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE appointment_id = ?').get(otherId).n,
    course: db.prepare('SELECT COUNT(*) AS n FROM course_reminders WHERE start_appt_id = ?').get(pastId).n,
    moves: db.prepare("SELECT COUNT(*) AS n FROM material_moves WHERE reason = 'visit'").get().n,
    movesLinked: db.prepare('SELECT COUNT(*) AS n FROM material_moves WHERE appt_id = ?').get(pastId).n,
    tables: ['client_notes', 'client_archive', 'client_photo_consent', 'client_photos', 'accounts']
      .map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE phone_key = ?`).get(KEY).n),
    sessions: db.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n,
    codes: db.prepare("SELECT COUNT(*) AS n FROM account_codes WHERE kind IN ('link', 'reset')").get().n,
    waitlist: db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n,
    other: db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE id = ?').get(otherId).n,
  }));
  assert.deepEqual(left, { appts: 0, reviews: 0, otherReview: 1, course: 0, moves: 1, movesLinked: 0, tables: [0, 0, 0, 0, 0], sessions: 0, codes: 0, waitlist: 0, other: 1 });
  assert.equal(fs.existsSync(path.join(srv.dir, 'private', 'client-photos', photoFile)), false, 'файл фото видалено');
  assert.equal((await srv.req('GET', `/api/admin/clients/${KEY}`, { token: srv.ADMIN })).status, 404);
  assert.deepEqual((await srv.req('GET', '/api/admin/client-search?q=ірина', { token: srv.ADMIN })).body, []);
  assert.equal((await srv.req('DELETE', `/api/admin/clients/${KEY}`, { token: srv.ADMIN, body: { confirm: '2233' } })).status, 404, 'вдруге — немає кого');
});
