// Записи наживо в адмінці: канал /ws для адміністратора й майстра, хто які події отримує,
// тихі оновлення після дій персоналу, закриття каналу з чужим або простроченим доступом.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer, makeMaster, book } = require('./helpers');

let srv, A, B, serviceId, admin, wsA, wsB;
const all = [];

function connect(token) {
  const ws = new WebSocket(srv.base.replace('http', 'ws') + '/ws?admin=' + encodeURIComponent(token));
  const c = { ws, msgs: [], closed: new Promise((ok) => ws.on('close', (code) => ok(code))) };
  ws.on('message', (d) => c.msgs.push(JSON.parse(String(d))));
  ws.on('error', () => {});
  all.push(c);
  return c;
}
const opened = (c) => new Promise((ok) => (c.ws.readyState === 1 ? ok() : c.ws.once('open', ok)));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function waitFor(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('Не дочекались: ' + what);
}
const appts = (c) => c.msgs.filter((m) => m.type === 'appt');
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

// Вільний час у майстра не раніше ніж за days днів (щоб клієнт міг скасувати чи перенести)
async function slotAfter(masterId, days, skip = 0) {
  for (let i = days; i < days + 30; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const date = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
    const r = await srv.req('GET', `/api/slots?serviceId=${serviceId}&date=${date}&masterId=${masterId}`);
    if (r.body?.slots?.length > skip) return { date, time: r.body.slots[skip] };
  }
  throw new Error('Немає вільного часу для тесту');
}

before(async () => {
  srv = await startServer();
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'livea', 'Майстер А');
  B = await makeMaster(srv, 'liveb', 'Майстер Б');
  admin = connect(srv.ADMIN);
  wsA = connect(A.token);
  wsB = connect(B.token);
  await Promise.all([admin, wsA, wsB].map(opened));
});
after(async () => {
  for (const c of all) c.ws.terminate();
  if (srv) await srv.stop();
});

test('новий запис із сайту: подію отримують адміністратор і майстер запису, інший майстер — ні', async () => {
  const r = await book(srv, { serviceId, masterId: A.id, name: 'Олена Наживо', phone: '+380671110001' });
  const ev = await waitFor(() => appts(admin).find((m) => m.id === r.id), 'подія в адміністратора');
  assert.equal(ev.kind, 'new');
  assert.equal(ev.client_name, 'Олена Наживо');
  assert.equal(ev.date, r.date);
  assert.equal(ev.start_time, r.time);
  assert.equal(ev.master, 'Майстер А');
  assert.ok(ev.service, 'є назва послуги');
  await waitFor(() => appts(wsA).find((m) => m.id === r.id && m.kind === 'new'), 'подія в майстра А');
  await sleep(200);
  assert.equal(appts(wsB).length, 0, 'майстер Б не бачить записів майстра А');
  assert.ok(admin.msgs.some((m) => m.type === 'admin_ready'), 'адміністраторові відкрито чат');
  assert.ok(!wsA.msgs.some((m) => m.type === 'admin_ready'), 'майстрові чат не відкривається');
});

test('зміни персоналу — тиха подія «changed», теж лише для свого майстра', async () => {
  const r = await book(srv, { serviceId, masterId: B.id, name: 'Марія Тиха', phone: '+380671110002' });
  await waitFor(() => appts(wsB).find((m) => m.id === r.id), 'новий запис у майстра Б');
  const before = { admin: appts(admin).length, a: appts(wsA).length };
  assert.equal((await srv.req('PATCH', `/api/admin/appointments/${r.id}`, { token: srv.ADMIN, body: { status: 'confirmed' } })).status, 200);
  const ev = await waitFor(() => appts(wsB).find((m) => m.id === r.id && m.kind === 'changed'), 'тиха подія в майстра Б');
  assert.equal(ev.client_name, 'Марія Тиха');
  await waitFor(() => appts(admin).length > before.admin, 'тиха подія в адміністратора');
  await sleep(200);
  assert.equal(appts(wsA).length, before.a, 'майстер А не отримує подій майстра Б');
});

test('клієнт скасовує чи переносить запис у кабінеті — події «cancelled» і «moved»', async () => {
  const reg = await srv.req('POST', '/api/account/register', { body: { name: 'Ірина Кабінет', phone: '+380671110003', password: 'parol-12345' } });
  assert.equal(reg.status, 201, reg.text);
  const Cookie = cookieOf(reg);

  // Перенесення
  const s1 = await slotAfter(A.id, 5);
  const b1 = await srv.req('POST', '/api/appointments', { body: { serviceId, date: s1.date, time: s1.time, name: 'Ірина Кабінет', phone: '+380671110003', masterId: A.id } });
  assert.equal(b1.status, 201, b1.text);
  const s2 = await slotAfter(A.id, 7, 1);
  const mv = await srv.req('POST', `/api/account/appointments/${b1.body.id}/reschedule`, { headers: { Cookie }, body: { date: s2.date, time: s2.time } });
  assert.equal(mv.status, 200, mv.text);
  const moved = await waitFor(() => appts(admin).find((m) => m.id === b1.body.id && m.kind === 'moved'), 'перенесення в адміністратора');
  assert.equal(moved.date, s2.date, 'у події нова дата');
  assert.equal(moved.start_time, s2.time, 'у події новий час');
  assert.equal(moved.client_name, 'Ірина Кабінет');
  await waitFor(() => appts(wsA).find((m) => m.id === b1.body.id && m.kind === 'moved'), 'перенесення в майстра А');

  // Скасування
  const cn = await srv.req('POST', `/api/account/appointments/${b1.body.id}/cancel`, { headers: { Cookie } });
  assert.equal(cn.status, 200, cn.text);
  await waitFor(() => appts(admin).find((m) => m.id === b1.body.id && m.kind === 'cancelled'), 'скасування в адміністратора');
  await waitFor(() => appts(wsA).find((m) => m.id === b1.body.id && m.kind === 'cancelled'), 'скасування в майстра А');
  assert.ok(!appts(wsB).some((m) => m.id === b1.body.id), 'майстер Б нічого не отримав');
});

test('канал без дійсного токена закривається з кодом 4003', async () => {
  const bad = connect('wrong-token');
  assert.equal(await bad.closed, 4003);
  const empty = connect('');
  assert.equal(await empty.closed, 4003);
});

test('заблокований майстер перестає отримувати події: канал закривається', async () => {
  assert.equal((await srv.req('POST', `/api/admin/masters/${A.id}/block`, { token: srv.ADMIN })).status, 200);
  const r = await book(srv, { serviceId, masterId: B.id, name: 'Після блокування', phone: '+380671110004' });
  assert.equal(await wsA.closed, 4003, 'канал майстра А закрито');
  assert.ok(!appts(wsA).some((m) => m.id === r.id), 'майстер А не отримав подію');
  await waitFor(() => appts(wsB).find((m) => m.id === r.id), 'майстер Б отримує свої події далі');
  // Повторне підключення з тим самим токеном теж не пускає
  const again = connect(A.token);
  assert.equal(await again.closed, 4003);
});
