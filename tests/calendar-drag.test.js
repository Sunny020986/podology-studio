// Перенесення запису в адмінці (і перетягуванням у календарі): точний час із кроком 5 хв,
// перевірка зайнятості, робочих годин і минулого часу.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster } = require('./helpers');

let srv, M, serviceId, day, open;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toHHMM = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const local = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const move = (id, body) => srv.req('PATCH', `/api/admin/appointments/${id}/move`, { token: srv.ADMIN, body });
async function create(time, name) {
  const r = await srv.req('POST', '/api/admin/appointments', { token: srv.ADMIN, body: { serviceId, date: day, time, name, phone: '+38067' + String(Math.floor(1000000 + Math.random() * 8999999)), masterId: M.id } });
  assert.equal(r.status, 201, r.text);
  return r.body.id;
}
const startOf = async (id) => (await srv.req('GET', `/api/admin/appointments?from=${day}&to=${day}`, { token: srv.ADMIN })).body.find((a) => a.id === id);

before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  M = await makeMaster(srv, 'dragm', 'Майстер Перетяг');
  // Перший день від завтра, коли майстер працює: перший вільний час — початок робочого дня
  for (let i = 1; i <= 14 && !day; i++) {
    const date = local(new Date(Date.now() + i * 86400000));
    const r = await srv.req('GET', `/api/admin/slots?serviceId=${serviceId}&date=${date}&masterId=${M.id}`, { token: srv.ADMIN });
    if (r.body?.slots?.length) { day = date; open = toMin(r.body.slots[0]); }
  }
  assert.ok(day, 'знайдено робочий день майстра');
});
after(() => srv && srv.stop());

test('перенесення на час поза сіткою 30 хв (крок 15 хв) — дозволено, якщо вільно', async () => {
  const id = await create(toHHMM(open), 'Перетяг Один');
  const r = await move(id, { date: day, time: toHHMM(open + 15) });
  assert.equal(r.status, 200, r.text);
  assert.equal((await startOf(id)).start_time, toHHMM(open + 15));
});

test('перетин з іншим записом, поза робочими годинами, не кратно 5 хв, минулий час — відмова', async () => {
  const a = await create(toHHMM(open + 180), 'Перетяг Два');
  const b = await create(toHHMM(open + 300), 'Перетяг Три');
  let r = await move(a, { date: day, time: toHHMM(open + 300 + 15) });
  assert.equal(r.status, 409, 'перетин із записом «Перетяг Три»');
  assert.match(r.body.error, /недоступний/);
  r = await move(a, { date: day, time: '23:30' });
  assert.equal(r.status, 409, 'поза робочими годинами');
  r = await move(a, { date: day, time: toHHMM(open + 187) });
  assert.equal(r.status, 400, 'час не кратний 5 хв');
  r = await move(b, { date: local(new Date()), time: '00:00' });
  assert.equal(r.status, 400, 'сьогодні о 00:00 — уже минуло');
  assert.equal((await startOf(a)).start_time, toHHMM(open + 180), 'запис не змінився');
});

test('майстер переносить лише свої записи', async () => {
  const id = await create(toHHMM(open + 420), 'Перетяг Чотири');
  const other = await makeMaster(srv, 'dragx', 'Інший Майстер');
  const r = await srv.req('PATCH', `/api/admin/appointments/${id}/move`, { token: other.token, body: { date: day, time: toHHMM(open + 435) } });
  assert.equal(r.status, 403);
  const own = await srv.req('PATCH', `/api/admin/appointments/${id}/move`, { token: M.token, body: { date: day, time: toHHMM(open + 435), masterId: other.id } });
  assert.equal(own.status, 200, own.text);
  const after = await startOf(id);
  assert.equal(after.start_time, toHHMM(open + 435));
  assert.equal(after.master_id, M.id, 'майстер не може передати запис іншому');
});
