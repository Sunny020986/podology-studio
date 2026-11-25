// Кілька послуг в одному візиті: час — сума тривалостей, ціна — сума цін, знижка на перший візит — лише на позначені,
// майстер має робити всі послуги, у записі й адмінці — «Послуга 1 + Послуга 2», перенесення зберігає тривалість.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster } = require('./helpers');

let srv, A, B, s1, s2;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

before(async () => {
  srv = await startServer();
  const list = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body;
  s1 = list.find((x) => x.first_discount); // «Первинний огляд стоп», 45 хв
  s2 = list.find((x) => !x.first_discount && x.id !== s1.id);
  await srv.req('PATCH', `/api/admin/services/${s1.id}`, { token: srv.ADMIN, body: { price_uah: 650 } });
  await srv.req('PATCH', `/api/admin/services/${s2.id}`, { token: srv.ADMIN, body: { price_uah: 1380, duration_min: 60 } });
  A = await makeMaster(srv, 'multia', 'Майстер Обидві');
  // Майстер Б робить лише першу послугу
  const created = await srv.req('POST', '/api/admin/masters', { token: srv.ADMIN, body: { name: 'Майстер Одна', login: 'multib', password: 'pass-multib-123', bio: '', services: [s1.id] } });
  assert.equal(created.status, 201, created.text);
  B = { id: created.body.id };
});
after(() => srv && srv.stop());

test('вільний час і ціна для двох послуг; запис: тривалість і ціна — сума, знижка — лише на позначену', async () => {
  const next = (await srv.req('GET', `/api/next-slot?serviceId=${s1.id}&extra=${s2.id}&masterId=${A.id}`)).body;
  assert.ok(next.date, 'є вільний час');
  const sl = (await srv.req('GET', `/api/slots?serviceId=${s1.id}&extra=${s2.id}&date=${next.date}&masterId=${A.id}`)).body;
  assert.equal(sl.duration, 45 + 60);
  const q = (await srv.req('GET', `/api/first-discount?serviceId=${s1.id}&extra=${s2.id}&phone=0671112001`)).body;
  assert.deepEqual({ full: q.full, kind: q.kind, final: q.final }, { full: 2030, kind: 'first', final: 1965 }); // 10% лише від 650

  const r = await srv.req('POST', '/api/appointments', { body: { serviceId: s1.id, extraServiceIds: [s2.id], date: next.date, time: next.slots[0], name: 'Дві Послуги', phone: '0671112001', masterId: A.id } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.service, `${s1.name} + ${s2.name}`);
  assert.deepEqual({ full: r.body.price.full, final: r.body.price.final }, { full: 2030, final: 1965 });
  const a = (await srv.req('GET', `/api/admin/appointments?from=${next.date}&to=${next.date}`, { token: srv.ADMIN })).body.find((x) => x.id === r.body.id);
  assert.equal(a.service, `${s1.name} + ${s2.name}`);
  assert.equal(toMin(a.end_time) - toMin(a.start_time), 105, 'візит триває 105 хв');
  assert.deepEqual({ p: a.price_uah, f: a.price_full_uah }, { p: 1965, f: 2030 });

  // Перенесення в адмінці зберігає тривалість усього візиту
  const s = (await srv.req('GET', `/api/admin/slots?serviceId=${s1.id}&date=${next.date}&masterId=${A.id}&excludeId=${r.body.id}`, { token: srv.ADMIN })).body.slots;
  const target = s[s.length - 1];
  const mv = await srv.req('PATCH', `/api/admin/appointments/${r.body.id}/move`, { token: srv.ADMIN, body: { date: next.date, time: target } });
  assert.equal(mv.status, 200, mv.text);
  const moved = (await srv.req('GET', `/api/admin/appointments?from=${next.date}&to=${next.date}`, { token: srv.ADMIN })).body.find((x) => x.id === r.body.id);
  assert.equal(toMin(moved.end_time) - toMin(moved.start_time), 105);
});

test('майстер, який не робить усі послуги: не пропонується й не приймає такий запис', async () => {
  const off = (await srv.req('GET', `/api/next-slot?serviceId=${s1.id}&extra=${s2.id}&masterId=${B.id}`)).body;
  assert.equal(off.date, null, 'для майстра Б немає часу на обидві послуги');
  const one = (await srv.req('GET', `/api/next-slot?serviceId=${s1.id}&masterId=${B.id}`)).body;
  const r = await srv.req('POST', '/api/appointments', { body: { serviceId: s1.id, extraServiceIds: [s2.id], date: one.date, time: one.slots[0], name: 'Не Той Майстер', phone: '0671112002', masterId: B.id } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /не виконує всі обрані послуги/);
});

test('перевірки: недоступна додаткова послуга й більше 4 додаткових — відмова', async () => {
  const next = (await srv.req('GET', `/api/next-slot?serviceId=${s1.id}`)).body;
  const base = { serviceId: s1.id, date: next.date, time: next.slots[0], name: 'Перевірка', phone: '0671112003' };
  assert.equal((await srv.req('POST', '/api/appointments', { body: { ...base, extraServiceIds: [99999] } })).status, 400);
  const many = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body.map((x) => x.id).filter((id) => id !== s1.id).slice(0, 5);
  if (many.length === 5) assert.equal((await srv.req('POST', '/api/appointments', { body: { ...base, extraServiceIds: many } })).status, 400);
  assert.equal((await srv.req('GET', `/api/slots?serviceId=${s1.id}&extra=99999&date=${next.date}`)).status, 400);
});
