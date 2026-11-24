// Календар майстра: секретне посилання .ics, лише свої записи, без телефону, скидання посилання.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, book } = require('./helpers');
const { kyivToUtc } = require('../src/calendar');

let srv, A, B, serviceId;
before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'mastera', 'Майстер А');
  B = await makeMaster(srv, 'masterb', 'Майстер Б');
});
after(() => srv && srv.stop());

const pathOf = (url) => new URL(url).pathname;

test('час Києва правильно переводиться в UTC (зима +2, літо +3)', () => {
  assert.equal(kyivToUtc('2026-01-15', '10:00').toISOString(), '2026-01-15T08:00:00.000Z');
  assert.equal(kyivToUtc('2026-07-15', '10:00').toISOString(), '2026-07-15T07:00:00.000Z');
});

test('майстер отримує посилання; у календарі лише його записи, без телефону', async () => {
  assert.equal((await srv.req('GET', '/api/admin/me/calendar', { token: A.token })).body.enabled, false);
  const link = await srv.req('POST', '/api/admin/me/calendar', { token: A.token });
  assert.equal(link.status, 200);
  assert.match(link.body.url, /\/cal\/[\w-]{20,}\.ics$/);
  assert.match(link.body.webcal, /^webcal:/);
  await book(srv, { serviceId, masterId: A.id, phone: '+380681234567', name: 'Ірина Свого' });
  await book(srv, { serviceId, masterId: B.id, phone: '+380687654321', name: 'Марта Чужа' });
  const ics = await srv.req('GET', pathOf(link.body.url));
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  assert.match(ics.text, /BEGIN:VCALENDAR[\s\S]*BEGIN:VEVENT[\s\S]*END:VCALENDAR/);
  assert.match(ics.text, /Ірина/);
  assert.doesNotMatch(ics.text, /Марта/, 'чужого запису немає');
  assert.doesNotMatch(ics.text, /681234567/, 'телефону немає');
  assert.match(ics.text, /DTSTART:\d{8}T\d{6}Z/);
});

test('нове посилання скасовує старе; вимкнення — 404', async () => {
  const first = await srv.req('POST', '/api/admin/me/calendar', { token: A.token });
  const second = await srv.req('POST', '/api/admin/me/calendar', { token: A.token });
  assert.equal((await srv.req('GET', pathOf(first.body.url))).status, 404, 'старе не працює');
  assert.equal((await srv.req('GET', pathOf(second.body.url))).status, 200, 'нове працює');
  await srv.req('DELETE', '/api/admin/me/calendar', { token: A.token });
  assert.equal((await srv.req('GET', pathOf(second.body.url))).status, 404, 'після вимкнення');
  assert.equal((await srv.req('GET', '/cal/abc.ics')).status, 404, 'вигаданий ключ');
});

test('суперадмін створює посилання для майстра, майстер для іншого — ні', async () => {
  const r = await srv.req('POST', `/api/admin/masters/${B.id}/calendar`, { token: srv.ADMIN });
  assert.equal(r.status, 200);
  assert.match((await srv.req('GET', pathOf(r.body.url))).text, /Марта/);
  assert.equal((await srv.req('POST', `/api/admin/masters/${B.id}/calendar`, { token: A.token })).status, 403);
  assert.equal((await srv.req('POST', '/api/admin/me/calendar', { token: srv.ADMIN })).status, 400, 'суперадмін не майстер');
});
