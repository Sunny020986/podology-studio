// «Майстер не вийде»: план передачі записів, застосування, закриття днів, помилки, права.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster, insertAppt } = require('./helpers');

let srv, A, B, C, s1, s2;
// Дата за місцевим часом (як рахує сервер), зсунута на n днів
const localDate = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); };
// Робочі дні нових майстрів — Пн–Пт 09:00–18:00. k-й робочий день, починаючи з післязавтра
function workday(k) {
  let found = 0;
  for (let n = 2; n < 30; n++) {
    const d = localDate(n);
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wd >= 1 && wd <= 5 && found++ === k) return d;
  }
  throw new Error('Немає робочого дня');
}
const plan = (q, token = srv.ADMIN) => srv.req('GET', `/api/admin/reassign?${new URLSearchParams(q)}`, { token });
const apply = (body, token = srv.ADMIN) => srv.req('POST', '/api/admin/reassign', { token, body });
const appt = (id) => {
  const Database = require('better-sqlite3');
  const db = new Database(require('path').join(srv.dir, 'studio.db'), { readonly: true });
  const r = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  db.close();
  return r;
};

before(async () => {
  srv = await startServer();
  [s1, s2] = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body;
  // Стартовий майстер чистої бази (id 1) у цих тестах не потрібен — блокуємо, щоб не впливав на варіанти
  assert.equal((await srv.req('POST', '/api/admin/masters/1/block', { token: srv.ADMIN })).status, 200);
  A = await makeMaster(srv, 'mastera', 'Майстер А');
  B = await makeMaster(srv, 'masterb', 'Майстер Б');
  C = await makeMaster(srv, 'masterc', 'Майстер В');
  // В не робить послугу s1
  const r = await srv.req('PUT', `/api/admin/masters/${C.id}`, { token: srv.ADMIN, body: { name: 'Майстер В', login: 'masterc', bio: '', services: [s2.id] } });
  assert.equal(r.status, 200, r.text);
});
after(() => srv && srv.stop());

test('план: інший майстер на той самий час, черговість без накладок, інший час, якщо всі зайняті', async () => {
  const D = workday(0);
  await srv.req('PUT', '/api/admin/buffer', { token: srv.ADMIN, body: { minutes: 30 } });
  const a1 = insertAppt(srv, { date: D, start: '10:00', end: '10:45', phone: '+380501000001', masterId: A.id, serviceId: s1.id });
  const a2 = insertAppt(srv, { date: D, start: '10:45', end: '11:30', phone: '+380501000002', masterId: A.id, serviceId: s1.id });
  const a3 = insertAppt(srv, { date: D, start: '14:00', end: '14:45', phone: '+380501000003', masterId: A.id, serviceId: s1.id });
  insertAppt(srv, { date: D, start: '14:00', end: '14:45', phone: '+380501000004', masterId: B.id, serviceId: s1.id }); // Б зайнятий о 14:00
  const r = await plan({ masterId: A.id, from: D, to: D });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.work_days.length, 1);
  assert.deepEqual(r.body.work_days[0], { date: D, start_time: '09:00', end_time: '18:00' });
  const byId = new Map(r.body.appointments.map((x) => [x.id, x]));
  assert.equal(byId.size, 3);
  // 10:00 — Б вільний; В не робить цю послугу
  assert.deepEqual(byId.get(a1).same_time.map((m) => m.id), [B.id]);
  assert.deepEqual(byId.get(a1).default, { type: 'master', master_id: B.id });
  // 10:45 — Б формально вільний, але після 10:00–10:45 у нього 30 хв прибирання: рекомендація не Б
  assert.deepEqual(byId.get(a2).same_time.map((m) => m.id), [B.id]);
  assert.notDeepEqual(byId.get(a2).default, { type: 'master', master_id: B.id });
  assert.equal(byId.get(a2).default.type, 'time');
  // 14:00 — вільних майстрів немає: рекомендовано інший час
  assert.deepEqual(byId.get(a3).same_time, []);
  assert.equal(byId.get(a3).default.type, 'time');
  assert.ok(byId.get(a3).slots.length > 0);
  assert.ok(byId.get(a3).slots.every((s) => !(s.master_id === A.id && s.date === D)), 'майстра А в цей день не пропонує');
  assert.equal(byId.get(a3).telegram, false);
  await srv.req('PUT', '/api/admin/buffer', { token: srv.ADMIN, body: { minutes: 0 } });
});

test('застосування: передати, перенести, скасувати, закрити день; чужий запис — помилка; повтор не дублює блокування', async () => {
  const D = workday(1);
  const a1 = insertAppt(srv, { date: D, start: '10:00', end: '10:45', phone: '+380502000001', masterId: A.id, serviceId: s1.id });
  const a2 = insertAppt(srv, { date: D, start: '12:00', end: '12:45', phone: '+380502000002', masterId: A.id, serviceId: s1.id });
  const a3 = insertAppt(srv, { date: D, start: '15:00', end: '15:45', phone: '+380502000003', masterId: A.id, serviceId: s1.id });
  const foreign = insertAppt(srv, { date: D, start: '16:00', end: '16:45', phone: '+380502000004', masterId: B.id, serviceId: s1.id });
  // у клієнта a3 є Telegram — його не буде в списку для дзвінка
  { const Database = require('better-sqlite3'); const db = new Database(require('path').join(srv.dir, 'studio.db')); db.prepare("UPDATE appointments SET tg_chat_id = '777' WHERE id = ?").run(a3); db.close(); }
  const p = (await plan({ masterId: A.id, from: D, to: D })).body;
  const slot = p.appointments.find((x) => x.id === a3).slots[0];
  assert.ok(slot, 'є варіант іншого часу');
  assert.equal(p.appointments.find((x) => x.id === a3).telegram, true);
  const r = await apply({
    masterId: A.id, from: D, to: D, block: true, note: 'лікарняний',
    actions: [
      { id: a1, type: 'master', master_id: B.id },
      { id: a2, type: 'cancel' },
      { id: a3, type: 'time', date: slot.date, time: slot.time, master_id: slot.master_id },
      { id: foreign, type: 'cancel' },
    ],
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.counts, { master: 1, time: 1, cancel: 1, keep: 0, failed: 1 });
  assert.equal(r.body.blocks_created, 1);
  assert.equal(r.body.results.find((x) => x.id === foreign).ok, false);
  assert.deepEqual(r.body.call_list.map((x) => x.client_phone).sort(), ['+380502000001', '+380502000002']);
  // база
  assert.equal(appt(a1).master_id, B.id);
  assert.equal(appt(a1).start_time, '10:00');
  assert.equal(appt(a2).status, 'cancelled');
  assert.equal(appt(a3).date, slot.date);
  assert.equal(appt(a3).start_time, slot.time);
  assert.equal(appt(a3).master_id, slot.master_id);
  assert.equal(appt(foreign).status, 'confirmed', 'чужий запис не чіпали');
  // день закрито: вільного часу в майстра А немає, повтор не дублює блокування
  const slots = await srv.req('GET', `/api/slots?serviceId=${s1.id}&date=${D}&masterId=${A.id}`);
  assert.deepEqual(slots.body.slots, []);
  assert.equal((await apply({ masterId: A.id, from: D, to: D, block: true, actions: [] })).body.blocks_created, 0);
  // запис, який уже змінили, вдруге не обробляється
  const again = await apply({ masterId: A.id, from: D, to: D, actions: [{ id: a1, type: 'cancel' }] });
  assert.equal(again.body.results[0].ok, false);
  assert.equal(appt(a1).status, 'confirmed');
});

test('помилки: дати, період, майстер, неможливі дії', async () => {
  const D = workday(2);
  assert.equal((await plan({ masterId: A.id, from: D, to: localDate(0) })).status, 400, 'кінець раніше початку');
  assert.equal((await plan({ masterId: A.id, from: localDate(-1), to: D })).status, 400, 'початок у минулому');
  assert.equal((await plan({ masterId: A.id, from: localDate(1), to: localDate(40) })).status, 400, 'понад 31 день');
  assert.equal((await plan({ masterId: 9999, from: D, to: D })).status, 404);
  const a = insertAppt(srv, { date: D, start: '12:00', end: '12:45', phone: '+380503000001', masterId: A.id, serviceId: s1.id });
  insertAppt(srv, { date: D, start: '12:00', end: '12:45', phone: '+380503000002', masterId: B.id, serviceId: s1.id });
  const r = await apply({
    masterId: A.id, from: D, to: D,
    actions: [{ id: a, type: 'master', master_id: C.id }],
  });
  assert.match(r.body.results[0].error, /не виконує/);
  const r2 = await apply({ masterId: A.id, from: D, to: D, actions: [{ id: a, type: 'master', master_id: B.id }] });
  assert.match(r2.body.results[0].error, /зайнятий/);
  const r3 = await apply({ masterId: A.id, from: D, to: D, actions: [{ id: a, type: 'time', date: D, time: '15:00', master_id: A.id }] });
  assert.match(r3.body.results[0].error, /не працює/);
  const r4 = await apply({ masterId: A.id, from: D, to: D, actions: [{ id: a, type: 'time', date: D, time: '25:00', master_id: B.id }] });
  assert.match(r4.body.results[0].error, /час/i);
  assert.equal(appt(a).master_id, A.id, 'запис не змінився');
});

test('лише для адміністратора', async () => {
  const D = workday(0);
  assert.equal((await plan({ masterId: A.id, from: D, to: D }, A.token)).status, 403);
  assert.equal((await apply({ masterId: A.id, from: D, to: D, actions: [] }, A.token)).status, 403);
  assert.equal((await srv.req('GET', `/api/admin/reassign?masterId=${A.id}&from=${D}&to=${D}`)).status, 401);
});

test('передача на той самий час можлива й менш ніж за годину до візиту', async (t) => {
  const now = new Date();
  const startMin = Math.ceil((now.getHours() * 60 + now.getMinutes() + 20) / 5) * 5;
  if (startMin + 30 > 23 * 60 + 50) return t.skip('надто пізно сьогодні для цієї перевірки');
  const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const today = localDate(0);
  const wd = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;
  for (const m of [A, B]) {
    const r = await srv.req('PUT', `/api/admin/schedule/${wd}?masterId=${m.id}`, { token: srv.ADMIN, body: { start_time: '00:00', end_time: '23:59' } });
    assert.equal(r.status, 200, r.text);
  }
  const a = insertAppt(srv, { date: today, start: hhmm(startMin), end: hhmm(startMin + 30), phone: '+380504000001', masterId: A.id, serviceId: s1.id });
  const p = (await plan({ masterId: A.id, from: today, to: today })).body;
  const row = p.appointments.find((x) => x.id === a);
  assert.ok(row.same_time.some((m) => m.id === B.id), 'Б доступний на той самий час');
  const r = await apply({ masterId: A.id, from: today, to: today, actions: [{ id: a, type: 'master', master_id: B.id }] });
  assert.equal(r.body.results[0].ok, true, r.text);
  assert.equal(appt(a).master_id, B.id);
});
