// Обмеження запису клієнтів для майстра: «щонайменше за N годин» і «закрити запис до кінця сьогодні».
// Діють на сайт і кабінет; ручний запис в адмінці їх не зачіпає.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeMaster } = require('./helpers');

let srv, M, svc;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return ymd(d); };
const nowHHMM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const pub = async (date) => (await srv.req('GET', `/api/slots?serviceId=${svc}&date=${date}&masterId=${M.id}`)).body.slots;
const adm = async (date) => (await srv.req('GET', `/api/admin/slots?serviceId=${svc}&date=${date}&masterId=${M.id}`, { token: srv.ADMIN })).body.slots;
const limits = (body, token = srv.ADMIN) => srv.req('PUT', '/api/admin/booking-limits' + (token === srv.ADMIN ? `?masterId=${M.id}` : ''), { token, body });

before(async () => {
  srv = await startServer();
  svc = (await srv.req('GET', '/api/services')).body[0].id;
  M = await makeMaster(srv, 'limitm', 'Майстер Ліміт');
  // Працює щодня з 00:00 до 23:30, щоб перевірка не залежала від дня тижня й часу запуску
  for (let wd = 0; wd < 7; wd++) {
    const r = await srv.req('PUT', `/api/admin/schedule/${wd}?masterId=${M.id}`, { token: srv.ADMIN, body: { start_time: '00:00', end_time: '23:30' } });
    assert.equal(r.status, 200, r.text);
  }
});
after(() => srv && srv.stop());

test('за замовчуванням 1 год (як було); налаштування: дозволені значення, суперадміну треба обрати майстра', async () => {
  const g = await srv.req('GET', `/api/admin/booking-limits?masterId=${M.id}`, { token: srv.ADMIN });
  assert.deepEqual(g.body, { lead_hours: 1, closed_today: false, options: [1, 2, 3, 4, 6, 12, 24] });
  assert.equal((await limits({ lead_hours: 5 })).status, 400);
  assert.equal((await srv.req('PUT', '/api/admin/booking-limits', { token: srv.ADMIN, body: { lead_hours: 2 } })).status, 400, 'без майстра');
  assert.equal((await srv.req('GET', '/api/admin/booking-limits')).status, 401);
});

test('«щонайменше за 24 год»: завтра клієнт не бачить часу раніше, ніж зараз; адмінка бачить усе', async () => {
  const before24 = await pub(tomorrow());
  assert.deepEqual((await limits({ lead_hours: 24 })).body, { lead_hours: 24, closed_today: false });
  const after24 = await pub(tomorrow());
  const now = nowHHMM();
  assert.ok(after24.every((t) => t >= now), 'завтра — лише не раніше, ніж за добу від зараз');
  assert.ok(after24.length <= before24.length);
  assert.deepEqual(await pub(today()), [], 'на сьогодні за добу вже нічого');
  assert.deepEqual(await adm(tomorrow()), before24, 'адмінка — без обмеження майстра');
  const next = (await srv.req('GET', `/api/next-slot?serviceId=${svc}&masterId=${M.id}`)).body;
  assert.notEqual(next.date, today());
  // Запис з сайту на сьогодні не пройде навіть «на пряму»
  const t = (await adm(today()))[0];
  if (t) {
    const r = await srv.req('POST', '/api/appointments', { body: { serviceId: svc, date: today(), time: t, name: 'Пізній Клієнт', phone: '+380671119001', masterId: M.id } });
    assert.equal(r.status, 409, r.text);
    const a = await srv.req('POST', '/api/admin/appointments', { token: srv.ADMIN, body: { serviceId: svc, date: today(), time: t, name: 'Адмін Записав', phone: '+380671119002', masterId: M.id } });
    assert.equal(a.status, 201, 'адмін може записати ' + a.text);
  }
  await limits({ lead_hours: 1 });
});

test('«закрити запис до кінця сьогодні»: сьогодні клієнтам нічого, завтра — як завжди; майстер сам для себе', async () => {
  const tom = await pub(tomorrow());
  const r = await limits({ closed_today: true }, M.token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.closed_today, true);
  assert.deepEqual(await pub(today()), []);
  assert.deepEqual(await pub(tomorrow()), tom, 'завтра не зачеплено');
  assert.ok((await srv.req('GET', `/api/days-off?serviceId=${svc}&masterId=${M.id}`)).body.off.includes(today()), 'сайт не пропонує сьогодні');
  assert.equal((await srv.req('GET', `/api/admin/booking-limits?masterId=${M.id}`, { token: srv.ADMIN })).body.closed_today, true);
  const audit = (await srv.req('GET', '/api/admin/audit?limit=50', { token: srv.ADMIN })).body.rows;
  assert.ok(audit.some((x) => x.action === 'Розклад: запис закрито до кінця дня' && x.actor_name === 'Майстер Ліміт'));
  assert.equal((await limits({ closed_today: false }, M.token)).body.closed_today, false);
});
