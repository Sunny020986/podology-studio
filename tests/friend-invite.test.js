// «Приведи друга» (друга версія): друг додається прямо у формі запису (записати одразу або лише контакт),
// нове запрошення — лише після того, як друг прийшов; запрошувач отримує знижку на наступний запис.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, makeMaster } = require('./helpers');

let srv, M, svc, n = 0;
const dbRun = (fn) => { const db = new Database(path.join(srv.dir, 'studio.db')); try { return fn(db); } finally { db.close(); } };
const setStatus = (id, st) => dbRun((db) => db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(st, id));
const count = () => dbRun((db) => db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n);
const phone = () => '+38067444' + String(++n).padStart(4, '0');

// Два різні вільні часи в майстра (для клієнта й друга)
// Час для друга не перетинається з часом клієнта (щонайменше на 60 хв пізніше); якщо такого сьогодні немає — наступний день
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
async function twoSlots() {
  const first = (await srv.req('GET', `/api/next-slot?serviceId=${svc}&masterId=${M.id}`)).body;
  const a = first.slots[0];
  const later = first.slots.find((t) => toMin(t) >= toMin(a) + 60);
  if (later) return { date: first.date, a, bDate: first.date, b: later };
  for (let i = 1; i <= 14; i++) {
    const d = new Date(first.date + 'T12:00:00'); d.setDate(d.getDate() + i);
    const ds = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
    const sl = (await srv.req('GET', `/api/slots?serviceId=${svc}&date=${ds}&masterId=${M.id}`)).body.slots || [];
    if (sl.length) return { date: first.date, a, bDate: ds, b: sl[0] };
  }
  throw new Error('Немає часу для друга');
}
async function book(p, name, friend) {
  const s = await twoSlots();
  const body = { serviceId: svc, date: s.date, time: s.a, name, phone: p, masterId: M.id };
  const withSlot = (f) => (f.mode === 'book' ? { serviceId: svc, date: s.bDate, time: s.b, masterId: M.id, ...f } : f);
  if (Array.isArray(friend)) body.friends = friend.map(withSlot);
  else if (friend) body.friend = withSlot(friend);
  return srv.req('POST', '/api/appointments', { body });
}
const quote = async (p) => (await srv.req('GET', `/api/first-discount?serviceId=${svc}&phone=${encodeURIComponent(p)}`)).body;
const studio = async () => (await srv.req('GET', '/api/settings')).body.studio;
const putStudio = async (patch) => srv.req('PUT', '/api/admin/studio', { token: srv.ADMIN, body: { ...(await studio()), ...patch } });
const adminList = async () => (await srv.req('GET', '/api/admin/friend-invites', { token: srv.ADMIN })).body;

before(async () => {
  srv = await startServer();
  svc = (await srv.req('GET', '/api/services')).body[0].id;
  M = await makeMaster(srv, 'friendm', 'Майстер Друзі');
  assert.equal((await srv.req('PATCH', `/api/admin/services/${svc}`, { token: srv.ADMIN, body: { price_uah: 1000 } })).status, 200);
  assert.equal((await putStudio({ first_discount_pct: '20', friend_max_open: '1' })).status, 200); // більшість тестів — з лімітом 1
});
after(() => srv && srv.stop());

test('запис разом із другом; поки друг не прийшов — нове запрошення недоступне, навіть після скасування чи неявки', async () => {
  const me = phone();
  assert.equal((await quote(me)).friend.available, true, 'у формі є «Приведи друга»');
  const r = await book(me, 'Олена Запрошує', { mode: 'book', name: 'Друг Іван', phone: phone() });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.friends[0].ok, true, JSON.stringify(r.body.friends[0]));
  const fid = r.body.friends[0].id;
  const appts = (await srv.req('GET', '/api/admin/appointments?from=2020-01-01&to=2099-12-31', { token: srv.ADMIN })).body;
  assert.match(appts.find((a) => a.id === fid).client_comment, /^🤝 Друг клієнта Олена Запрошує\./);
  assert.equal(r.body.friends[0].price.kind, 'invited', 'друг — новий клієнт: знижка на перший візит + від друга');
  assert.equal((await quote(me)).friend.available, false);

  // Друге запрошення: помилка, і не записується ніхто
  const before = count();
  const again = await book(me, 'Олена Запрошує', { mode: 'lead', name: 'Друг Другий', phone: phone() });
  assert.equal(again.status, 409);
  assert.equal(again.body.friendError, true);
  assert.equal(count(), before, 'клієнта теж не записано');

  setStatus(fid, 'cancelled');
  assert.equal((await quote(me)).friend.available, false, 'скасування друга місце не звільняє');
  setStatus(fid, 'no_show');
  assert.equal((await quote(me)).friend.available, false, 'неявка друга місце не звільняє');
});

test('друг прийшов: запрошувач отримує знижку на наступний запис (той самий відсоток), один раз; скасування повертає знижку', async () => {
  const me = phone();
  const r = await book(me, 'Ірина Запрошує', { mode: 'book', name: 'Друг Петро', phone: phone() });
  assert.equal(r.status, 201, r.text);
  setStatus(r.body.id, 'done'); // сама запрошувачка вже була
  assert.equal((await quote(me)).kind, null, 'поки друг не прийшов — знижки немає');
  setStatus(r.body.friends[0].id, 'done');
  const q = await quote(me);
  assert.deepEqual({ kind: q.kind, pct: q.pct, final: q.final, friend: q.friend.available }, { kind: 'friend', pct: 20, final: 800, friend: true });

  const b1 = await book(me, 'Ірина Запрошує');
  assert.equal(b1.status, 201, b1.text);
  assert.deepEqual({ kind: b1.body.price.kind, final: b1.body.price.final }, { kind: 'friend', final: 800 });
  assert.equal((await quote(me)).kind, null, 'знижку використано');
  const b2 = await book(me, 'Ірина Запрошує');
  assert.equal(b2.body.price.final, 1000, 'наступний запис — за повною ціною');

  // Адмін замінив знижку за друга своєю — знижка за друга повертається клієнтові
  const man = await srv.req('PATCH', `/api/admin/appointments/${b1.body.id}/discount`, { token: srv.ADMIN, body: { pct: 30 } });
  assert.deepEqual(man.body, { full: 1000, pct: 30, final: 700 });
  assert.equal((await quote(me)).kind, 'friend', 'знижка за друга повернулась після ручної');
  setStatus(b2.body.id, 'cancelled'); // ліміт активних записів на номер — 3
  const b3 = await book(me, 'Ірина Запрошує');
  assert.equal(b3.status, 201, b3.text);
  assert.equal(b3.body.price.kind, 'friend');
  setStatus(b3.body.id, 'cancelled');
  assert.equal((await quote(me)).kind, 'friend', 'запис зі знижкою скасовано — знижка повернулась');
  const list = await adminList();
  assert.equal(list.find((x) => x.friend === 'Друг Петро').reward, 'available');
});

test('лише контакт друга: список в адмінці, адмін записує друга сам; прибрати можна лише невідбуте', async () => {
  const me = phone();
  const friendPhone = phone();
  const r = await book(me, 'Марія Запрошує', { mode: 'lead', name: 'Друг Контакт', phone: friendPhone });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.friends, [{ ok: true, mode: 'lead', name: 'Друг Контакт', pct: 20, regPct: 20 }]); // 20% від друга; ще 20% на перший візит — якщо друг зареєструється
  let row = (await adminList()).find((x) => x.friend === 'Друг Контакт');
  assert.deepEqual({ kind: row.kind, referrer: row.referrer, came: row.came, reward: row.reward }, { kind: 'lead', referrer: 'Марія Запрошує', came: false, reward: 'none' });

  // Адміністратор записав друга й візит відбувся: запрошення виконане
  const s = await twoSlots();
  const a = await srv.req('POST', '/api/admin/appointments', { token: srv.ADMIN, body: { serviceId: svc, date: s.date, time: s.a, name: 'Друг Контакт', phone: friendPhone, masterId: M.id } });
  assert.equal(a.status, 201, a.text);
  setStatus(a.body.id, 'done');
  row = (await adminList()).find((x) => x.friend === 'Друг Контакт');
  assert.equal(row.came, true);
  assert.equal((await srv.req('DELETE', `/api/admin/friend-invites/${row.id}`, { token: srv.ADMIN })).status, 409, 'виконане не прибирається');

  // Інший запрошувач: друг відмовився, адмін прибирає — місце звільняється без знижки
  const me2 = phone();
  await book(me2, 'Галина Запрошує', { mode: 'lead', name: 'Друг Відмовився', phone: phone() });
  const row2 = (await adminList()).find((x) => x.friend === 'Друг Відмовився');
  assert.equal((await quote(me2)).friend.available, false);
  assert.equal((await srv.req('DELETE', `/api/admin/friend-invites/${row2.id}`, { token: srv.ADMIN })).status, 200);
  assert.equal((await quote(me2)).friend.available, true);
  assert.equal((await quote(me2)).kind, null);
  assert.equal((await srv.req('GET', '/api/admin/friend-invites', { token: M.token })).status, 403, 'майстрові — ні');
  assert.equal((await srv.req('GET', '/api/admin/friend-invites')).status, 401, 'без входу — ні');
});

test('час друга перетинається з часом клієнта: не записується ніхто, сповіщень немає', async () => {
  await putStudio({ friend_max_open: '5' });
  const me = phone();
  const s = await twoSlots();
  const before = count();
  const r = await srv.req('POST', '/api/appointments', { body: { serviceId: svc, date: s.date, time: s.a, name: 'Перетин Час', phone: me, masterId: M.id,
    friends: [{ mode: 'lead', name: 'Друг Ок', phone: phone() }, { mode: 'book', name: 'Друг Перетин', phone: phone(), serviceId: svc, date: s.date, time: s.a, masterId: M.id }] } });
  assert.equal(r.status, 409, r.text);
  assert.match(r.body.error, /^Друг 2: .*Нікого не записано/);
  assert.equal(count(), before, 'клієнта не записано');
  assert.ok(!(await adminList()).some((x) => x.friend === 'Друг Ок'), 'запрошення першого друга теж відкочено');
  assert.equal((await quote(me)).friend.available, true);
  await putStudio({ friend_max_open: '1' });
});

test('друг лише за контактом: знижка на перший візит на будь-яку послугу, коли запишеться сам; звичайному новому клієнтові на непозначену — ні', async () => {
  const other = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body.find((x) => !x.first_discount);
  assert.equal((await srv.req('PATCH', `/api/admin/services/${other.id}`, { token: srv.ADMIN, body: { price_uah: 500 } })).status, 200);
  const q = async (p) => (await srv.req('GET', `/api/first-discount?serviceId=${other.id}&phone=${encodeURIComponent(p)}`)).body;
  const stranger = phone();
  assert.equal((await q(stranger)).kind, null, 'новий клієнт без запрошення: послуга без позначки — без знижки');
  const friendPhone = phone();
  const r = await book(phone(), 'Контакт Запрошує', { mode: 'lead', name: 'Друг Сам Запишеться', phone: friendPhone });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual({ k: (await q(friendPhone)).kind, f: (await q(friendPhone)).final, r: (await q(friendPhone)).regPct }, { k: 'invited', f: 400, r: 20 }); // без кабінету: лише 20% від друга
  await srv.register(friendPhone, 'Друг Сам Запишеться');
  assert.deepEqual({ k: (await q(friendPhone)).kind, f: (await q(friendPhone)).final }, { k: 'invited', f: 300 }); // з кабінетом: 500 − (20% + 20%)
  // Друг записується сам на сайті — знижка в записі
  const s = (await srv.req('GET', `/api/next-slot?serviceId=${other.id}&masterId=${M.id}`)).body;
  const b = await srv.req('POST', '/api/appointments', { body: { serviceId: other.id, date: s.date, time: s.slots[0], name: 'Друг Сам Запишеться', phone: friendPhone, masterId: M.id } });
  assert.equal(b.status, 201, b.text);
  assert.deepEqual({ k: b.body.price.kind, f: b.body.price.final }, { k: 'invited', f: 300 });
  // Друга записують одразу на непозначену послугу — теж зі знижкою
  const s2 = (await srv.req('GET', `/api/next-slot?serviceId=${other.id}&masterId=${M.id}`)).body;
  const r2 = await srv.req('POST', '/api/appointments', { body: { serviceId: svc, date: (await twoSlots()).date, time: (await twoSlots()).a, name: 'Ще Запрошує', phone: phone(), masterId: M.id,
    friend: { mode: 'book', name: 'Друг Одразу', phone: phone(), serviceId: other.id, date: s2.date, time: s2.slots[s2.slots.length - 1], masterId: M.id } } });
  assert.equal(r2.status, 201, r2.text);
  assert.equal(r2.body.friends[0].price.kind, 'invited');
});

test('перевірки друга: не свій номер, новий клієнт, не запрошений іншим; нічого не записується при помилці', async () => {
  const me = phone();
  const before = count();
  const self = await book(me, 'Тест Запрошує', { mode: 'lead', name: 'Я Сам', phone: me });
  assert.equal(self.status, 400);
  assert.match(self.body.error, /номер друга, а не свій/);
  const known = phone();
  assert.equal((await book(known, 'Старий Клієнт')).status, 201);
  const old = await book(me, 'Тест Запрошує', { mode: 'lead', name: 'Старий', phone: known });
  assert.equal(old.status, 409);
  assert.match(old.body.error, /нових клієнтів/);
  const taken = phone();
  assert.equal((await book(phone(), 'Перший Запрошувач', { mode: 'lead', name: 'Спільний Друг', phone: taken })).status, 201);
  const dup = await book(me, 'Тест Запрошує', { mode: 'lead', name: 'Спільний Друг', phone: taken });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /вже запросив інший наш клієнт/);
  // Той самий клієнт запрошує того самого друга вдруге — зрозуміле пояснення
  const me2 = phone(), fr2 = phone();
  assert.equal((await book(me2, 'Повтор Запрошує', { mode: 'lead', name: 'Друг Повтор', phone: fr2 })).status, 201);
  await putStudio({ friend_max_open: '5' });
  const again = await book(me2, 'Повтор Запрошує', { mode: 'lead', name: 'Друг Повтор', phone: fr2 });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Ви вже запросили цього друга \d\d\.\d\d\.\d{4}/);
  await putStudio({ friend_max_open: '1' });
  assert.equal((await book(me, 'Тест Запрошує', { mode: 'щось', name: 'Друг', phone: phone() })).status, 400);
  assert.equal(count(), before + 3, 'записано лише трьох клієнтів з успішних кроків, жодного з помилкових');
});

test('до 5 друзів за один запис (за замовчуванням ліміт 5); 6-й — уже ні; повтор номера у формі — помилка', async () => {
  assert.equal((await putStudio({ friend_max_open: '5' })).status, 200);
  const me = phone();
  const before = count();
  const dupPhone = phone();
  const dup = await book(me, 'П\'ять Друзів', [{ mode: 'lead', name: 'Друг Один', phone: dupPhone }, { mode: 'lead', name: 'Друг Два', phone: dupPhone }]);
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /Друг 2: цей номер уже вказано вище/);
  const six = await book(me, 'П\'ять Друзів', [1, 2, 3, 4, 5, 6].map((i) => ({ mode: 'lead', name: 'Друг ' + i, phone: phone() })));
  assert.equal(six.status, 400);
  assert.match(six.body.error, /не більше 5 друзів/);
  assert.equal(count(), before, 'при помилці не записано нікого');
  const r = await book(me, 'П\'ять Друзів', [
    { mode: 'book', name: 'Друг Запис', phone: phone() },
    ...[1, 2, 3, 4].map((i) => ({ mode: 'lead', name: 'Друг Контакт ' + i, phone: phone() })),
  ]);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.friends.map((f) => [f.ok, f.mode]), [[true, 'book'], [true, 'lead'], [true, 'lead'], [true, 'lead'], [true, 'lead']]);
  assert.equal(count(), before + 2, 'клієнт і записаний друг');
  assert.equal((await quote(me)).friend.available, false, 'п\'ятеро ще не прийшли — більше не можна');
  setStatus(r.body.friends[0].id, 'done');
  assert.equal((await quote(me)).friend.available, true, 'один прийшов — одне місце звільнилось');
  const more = await book(me, 'П\'ять Друзів', [{ mode: 'lead', name: 'Друг Х', phone: phone() }, { mode: 'lead', name: 'Друг У', phone: phone() }]);
  assert.equal(more.status, 409, 'вільне лише одне місце');
  assert.match(more.body.error, /Друг 2: Запрошених друзів, які ще не прийшли: 4 з 5/);
  await putStudio({ friend_max_open: '1' });
});

test('налаштування: ліміт 2; порожній текст акції вимикає запрошення', async () => {
  const me = phone();
  assert.equal((await putStudio({ friend_max_open: '2' })).status, 200);
  assert.equal((await book(me, 'Ліміт Два', { mode: 'lead', name: 'Друг А', phone: phone() })).status, 201);
  assert.equal((await book(me, 'Ліміт Два', { mode: 'lead', name: 'Друг Б', phone: phone() })).status, 201);
  assert.equal((await book(me, 'Ліміт Два', { mode: 'lead', name: 'Друг В', phone: phone() })).status, 409);
  assert.equal((await putStudio({ friend_max_open: '7' })).status, 400);
  const orig = (await studio()).promo_friend;
  assert.equal((await putStudio({ promo_friend: '', friend_max_open: '1' })).status, 200);
  const other = phone();
  assert.equal((await quote(other)).friend.available, false);
  assert.equal((await book(other, 'Без Акції', { mode: 'lead', name: 'Друг Г', phone: phone() })).status, 404);
  await putStudio({ promo_friend: orig });
});

test('кабінет: стан і запрошення за сесією; без входу — 401', async () => {
  const me = phone();
  assert.equal((await srv.req('GET', '/api/account/friend-invite')).status, 401);
  const reg = await srv.req('POST', '/api/account/register', { body: { name: 'Кабінетна Клієнтка', phone: me, password: 'cabinet-pass-1' } });
  assert.equal(reg.status, 201, reg.text);
  const Cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  const st = (await srv.req('GET', '/api/account/friend-invite', { headers: { Cookie } })).body;
  assert.deepEqual({ available: st.available, rewards: st.rewards, pct: st.pct }, { available: true, rewards: 0, pct: 20 });
  const un = await srv.req('POST', '/api/account/friend-invite', { headers: { Cookie }, body: { friends: [{ mode: 'lead', name: 'Друг Рано', phone: phone() }] } });
  assert.equal(un.status, 403, 'номер не підтверджено — запрошувати не можна');
  await srv.verify(me);
  const r = await srv.req('POST', '/api/account/friend-invite', { headers: { Cookie }, body: { friends: [{ mode: 'lead', name: 'Друг З Кабінету', phone: phone() }] } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.friends[0].ok, true);
  assert.equal((await srv.req('GET', '/api/account/friend-invite', { headers: { Cookie } })).body.available, false);
});

test('видалення запрошувача: ім\'я зникає з коментаря запису друга, запрошення видаляються', async () => {
  const me = phone();
  const r = await book(me, 'Стерти Запрошувача', { mode: 'book', name: 'Друг Лишається', phone: phone() });
  assert.equal(r.status, 201, r.text);
  const key = me.replace(/\D/g, '').slice(-9);
  const del = await srv.req('DELETE', '/api/admin/clients/' + key, { token: srv.ADMIN, body: { confirm: key.slice(-4) } });
  assert.equal(del.status, 200, del.text);
  const friend = (await srv.req('GET', '/api/admin/appointments?from=2020-01-01&to=2099-12-31', { token: srv.ADMIN })).body.find((a) => a.id === r.body.friends[0].id);
  assert.ok(friend && !friend.client_comment.includes('Стерти Запрошувача'));
  assert.ok(!(await adminList()).some((x) => x.referrer === 'Стерти Запрошувача'));
});

test('сценарій: Сашуліна запросила Арамчика контактом → Арамчик реєструється в кабінеті й одразу бачить знижку; у ціні «вас запросив друг»', async () => {
  const friendPhone = '0930525824';
  const r = await book(phone(), 'Сашуліна', { mode: 'lead', name: 'Арамчик', phone: friendPhone });
  assert.equal(r.status, 201, r.text);
  const reg = await srv.req('POST', '/api/account/register', { body: { name: 'Арамчик', phone: friendPhone, password: 'cabinet-pass-1' } });
  assert.equal(reg.status, 201, reg.text);
  await srv.verify(friendPhone);
  const Cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  const me = (await srv.req('GET', '/api/account/me', { headers: { Cookie } })).body;
  assert.equal(me.invited_discount, 40, 'кабінет показує знижку запрошеного: 20% + 20%');
  assert.deepEqual(me.invited_parts, { first: 20, friend: 20 });
  const other = (await srv.req('GET', '/api/admin/services', { token: srv.ADMIN })).body.find((x) => !x.first_discount);
  const q = (await srv.req('GET', `/api/first-discount?serviceId=${other.id}&phone=${friendPhone}`)).body;
  assert.deepEqual({ k: q.kind, inv: q.invited, pct: q.pct }, { k: 'invited', inv: true, pct: 40 });
  // Звичайний новий клієнт без запрошення — без плашки
  const reg2 = await srv.req('POST', '/api/account/register', { body: { name: 'Просто Новий', phone: phone(), password: 'cabinet-pass-1' } });
  const me2 = (await srv.req('GET', '/api/account/me', { headers: { Cookie: (reg2.headers.get('set-cookie') || '').split(';')[0] } })).body;
  assert.equal(me2.invited_discount, 0);
});

test('знижки разом: 10% на перший візит + 20% від друга = 30% запрошеному; той, хто привів, — 20% після візиту друга', async () => {
  assert.equal((await putStudio({ first_discount_pct: '10', friend_discount_pct: '20' })).status, 200);
  assert.equal((await putStudio({ friend_discount_pct: '95' })).status, 400);
  const me = phone(), fr = phone();
  const r = await book(me, 'Привела Подругу', { mode: 'lead', name: 'Подруга', phone: fr });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.friends[0].pct, 20, 'подруга ще без кабінету: лише знижка від друга');
  assert.equal(r.body.friends[0].regPct, 10);
  await srv.register(fr, 'Подруга');
  const q1 = (await srv.req('GET', `/api/first-discount?serviceId=${svc}&phone=${fr}`)).body;
  assert.deepEqual({ k: q1.kind, p: q1.pct, a: q1.pctFirst, b: q1.pctFriend, f: q1.final }, { k: 'invited', p: 30, a: 10, b: 20, f: 700 });
  // Подруга прийшла → тій, хто привела, 20% на наступний запис
  const s = await twoSlots();
  const fb = await srv.req('POST', '/api/appointments', { body: { serviceId: svc, date: s.date, time: s.a, name: 'Подруга', phone: fr, masterId: M.id } });
  assert.equal(fb.status, 201, fb.text);
  assert.equal(fb.body.price.final, 700);
  setStatus(fb.body.id, 'done');
  setStatus(r.body.id, 'done');
  const q2 = (await srv.req('GET', `/api/first-discount?serviceId=${svc}&phone=${encodeURIComponent(me)}`)).body;
  assert.deepEqual({ k: q2.kind, p: q2.pct, f: q2.final }, { k: 'friend', p: 20, f: 800 });
  await putStudio({ first_discount_pct: '20' });
});
