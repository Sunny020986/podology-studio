// Кнопки «Буду» / «Скасувати» під нагадуванням у Telegram. Замість Telegram — локальний фальшивий сервер.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { startServer, makeMaster } = require('./helpers');

const CABINET_CHAT = '-100500';
let srv, tg, A, serviceId, adminWs;
const liveEvents = [];

// Фальшивий Telegram: getMe, довге опитування getUpdates з черги, решта викликів записується
function fakeTelegram() {
  const calls = [];
  const queue = [];
  let wake = null;
  let nextUpdate = 1;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const data = body ? JSON.parse(body) : {};
      const reply = (result) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'getMe') return reply({ username: 'test_bot' });
      if (method === 'getUpdates') {
        if (queue.length) return reply(queue.splice(0));
        const t = setTimeout(() => { wake = null; reply([]); }, 300);
        wake = () => { clearTimeout(t); wake = null; reply(queue.splice(0)); };
        return undefined;
      }
      calls.push({ method, data });
      return reply(method === 'sendMessage' ? { message_id: calls.length } : true);
    });
  });
  return {
    calls,
    listen: () => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port))),
    close: () => new Promise((ok) => server.close(ok)),
    push(update) { queue.push({ update_id: nextUpdate++, ...update }); if (wake) wake(); },
  };
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function waitFor(fn, what, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('Не дочекались: ' + what);
}
const sent = (chat) => tg.calls.filter((c) => c.method === 'sendMessage' && String(c.data.chat_id) === String(chat));
const btnData = (markup) => (markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
const btnText = (markup) => (markup?.inline_keyboard || []).flat().map((b) => b.text);

const db = () => new Database(path.join(srv.dir, 'studio.db'));
const local = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
// Запис через hours годин (у межах доби — тож нагадування надсилається одразу)
function insertSoon(hours, { chat = null, phone, name }) {
  const t = new Date(Date.now() + hours * 3600000);
  const start = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const e = Math.min(23 * 60 + 59, t.getHours() * 60 + t.getMinutes() + 45); // звичайний візит на 45 хв
  const end = `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
  const d = db();
  const id = d.prepare(`INSERT INTO appointments (service_id, date, start_time, end_time, client_name, client_phone, remind_code, master_id, status, tg_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`).run(serviceId, local(t), start, end, name, phone, 'r' + Math.random().toString(36).slice(2), A.id, chat).lastInsertRowid;
  d.close();
  return Number(id);
}
const row = (id) => { const d = db(); const r = d.prepare('SELECT * FROM appointments WHERE id = ?').get(id); d.close(); return r; };

// Натискання кнопки: повертає спливаючу відповідь і нове повідомлення (якщо бот його змінив)
let qn = 0;
async function press(chat, data, messageId = 1) {
  const id = 'q' + (++qn);
  tg.push({ callback_query: { id, from: { id: Number(chat) }, data, message: { message_id: messageId, chat: { id: Number(chat), type: 'private' } } } });
  const answer = await waitFor(() => tg.calls.find((c) => c.method === 'answerCallbackQuery' && c.data.callback_query_id === id), 'відповідь на кнопку ' + data);
  const from = tg.calls.indexOf(answer);
  await sleep(150);
  const edit = tg.calls.slice(from).find((c) => c.method === 'editMessageText' && c.data.message_id === messageId) || null;
  return { answer: answer.data.text, edit: edit && edit.data };
}

before(async () => {
  tg = fakeTelegram();
  const port = await tg.listen();
  srv = await startServer({ TELEGRAM_API: `http://127.0.0.1:${port}`, REMINDER_DELAY_MS: '200', REMINDER_INTERVAL_MS: '300' });
  serviceId = (await srv.req('GET', '/api/services')).body[0].id;
  A = await makeMaster(srv, 'tgbtn', 'Майстер Кнопка');
  const r = await srv.req('PUT', '/api/admin/telegram', { token: srv.ADMIN, body: { token: '123456789:' + 'A'.repeat(35), chatId: CABINET_CHAT } });
  assert.equal(r.status, 200, r.text);
  adminWs = new WebSocket(srv.base.replace('http', 'ws') + '/ws?admin=' + srv.ADMIN);
  adminWs.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'appt') liveEvents.push(m); });
  await new Promise((ok) => adminWs.once('open', ok));
});
after(async () => {
  if (adminWs) adminWs.terminate();
  if (srv) await srv.stop();
  if (tg) await tg.close();
});

test('нагадування за добу приходить із кнопками «Буду» і «Скасувати», зокрема в чат кабінету клієнта', async () => {
  const id = insertSoon(5, { chat: '501', phone: '+380671230501', name: 'Олена Кнопка' });
  const msg = await waitFor(() => sent('501')[0], 'нагадування в чат запису');
  assert.match(msg.data.text, /Нагадування/);
  assert.deepEqual(btnData(msg.data.reply_markup), [`c:${id}`, `x:${id}`]);
  assert.deepEqual(btnText(msg.data.reply_markup), ['✅ Буду', '❌ Скасувати']);
  assert.equal(row(id).reminded, 1);

  // Клієнт підключив Telegram у кабінеті, а окремо запис до бота не прив'язував — нагадування теж має прийти
  const reg = await srv.req('POST', '/api/account/register', { body: { name: 'Ірина Кабінет', phone: '+380671230502', password: 'parol-12345' } });
  assert.equal(reg.status, 201, reg.text);
  const d = db();
  d.prepare("UPDATE accounts SET tg_chat_id = '502' WHERE phone_key = '671230502'").run();
  d.close();
  const id2 = insertSoon(6, { phone: '0671230502', name: 'Ірина Кабінет' });
  const msg2 = await waitFor(() => sent('502')[0], 'нагадування в чат кабінету');
  assert.deepEqual(btnData(msg2.data.reply_markup), [`c:${id2}`, `x:${id2}`]);
});

test('«Буду»: запис підтверджено, позначка в адмінці, під повідомленням лишається «Скасувати»', async () => {
  const id = insertSoon(7, { chat: '503', phone: '+380671230503', name: 'Марія Буду' });
  const r = await press('503', `c:${id}`);
  assert.equal(r.answer, 'Дякуємо! Чекаємо на вас');
  assert.match(r.edit.text, /Ви підтвердили візит/);
  assert.deepEqual(btnData(r.edit.reply_markup), [`x:${id}`]);
  assert.equal(row(id).status, 'confirmed');
  assert.ok(row(id).client_confirmed_at, 'позначка підтвердження');
  const list = (await srv.req('GET', `/api/admin/appointments?from=${row(id).date}&to=${row(id).date}`, { token: srv.ADMIN })).body;
  assert.ok(list.find((a) => a.id === id).client_confirmed_at, 'адмінка бачить позначку');
  await waitFor(() => liveEvents.find((m) => m.id === id && m.kind === 'confirmed'), 'подія в адмінці');
});

test('кнопка з чужого чату нічого не змінює; застаріла кнопка — пояснення', async () => {
  const id = insertSoon(8, { chat: '504', phone: '+380671230504', name: 'Чужа Кнопка' });
  const r = await press('999', `c:${id}`);
  assert.equal(r.answer, 'Запис не знайдено');
  assert.equal(row(id).status, 'new');
  assert.equal(row(id).client_confirmed_at, null);
  assert.equal((await press('504', 'zzz:1')).answer, 'Ця кнопка вже не діє');
});

test('«Скасувати» з перепитуванням: «Ні, залишити» повертає нагадування, «Так, скасувати» скасовує', async () => {
  assert.equal((await srv.req('PUT', '/api/admin/change-hours', { token: srv.ADMIN, body: { hours: 2 } })).status, 200);
  const id = insertSoon(5, { chat: '505', phone: '+380671230505', name: 'Ганна Скасую' });
  let r = await press('505', `x:${id}`);
  assert.match(r.edit.text, /Скасувати цей запис\?/);
  assert.deepEqual(btnData(r.edit.reply_markup), [`xy:${id}`, `xn:${id}`]);
  r = await press('505', `xn:${id}`);
  assert.equal(r.answer, 'Запис залишається');
  assert.deepEqual(btnData(r.edit.reply_markup), [`c:${id}`, `x:${id}`]);
  assert.equal(row(id).status, 'new');

  await press('505', `x:${id}`);
  r = await press('505', `xy:${id}`);
  assert.equal(r.answer, 'Запис скасовано');
  assert.match(r.edit.text, /Запис скасовано/);
  assert.deepEqual(btnData(r.edit.reply_markup), [], 'кнопок більше немає');
  assert.equal(row(id).status, 'cancelled');
  await waitFor(() => sent(CABINET_CHAT).find((c) => /скасував запис через Telegram/.test(c.data.text) && c.data.text.includes('Ганна Скасую')), 'повідомлення в чат кабінету');
  await waitFor(() => liveEvents.find((m) => m.id === id && m.kind === 'cancelled'), 'подія в адмінці');
  // Повторне натискання на старе повідомлення
  assert.equal((await press('505', `c:${id}`)).answer, 'Запис уже скасовано');
  assert.equal(row(id).status, 'cancelled');
});

test('пізно для скасування: клієнт лише попереджає, запис лишається, персонал отримує повідомлення', async () => {
  assert.equal((await srv.req('PUT', '/api/admin/change-hours', { token: srv.ADMIN, body: { hours: 24 } })).status, 200);
  const id = insertSoon(3, { chat: '506', phone: '+380671230506', name: 'Софія Пізно' });
  let r = await press('506', `x:${id}`);
  assert.match(r.edit.text, /менше ніж 24 год/);
  assert.deepEqual(btnText(r.edit.reply_markup), ['Так, передати', 'Ні, я прийду']);
  r = await press('506', `xl:${id}`);
  assert.equal(r.answer, 'Передали майстру');
  assert.match(r.edit.text, /Передали майстру/);
  assert.equal(row(id).status, 'new', 'запис не скасовано');
  assert.ok(row(id).client_declined_at, 'позначка «не прийде»');
  await waitFor(() => sent(CABINET_CHAT).find((c) => /не прийде/.test(c.data.text) && c.data.text.includes('Софія Пізно')), 'повідомлення в чат кабінету');
  await waitFor(() => liveEvents.find((m) => m.id === id && m.kind === 'declined'), 'подія в адмінці');
  // «Так, скасувати», натиснуте вже пізно, теж лише попереджає
  assert.equal((await press('506', `xy:${id}`)).answer, 'Ми вже передали майстру');
  assert.equal(row(id).status, 'new');
});

test('перенесення запису скидає позначки клієнта', async () => {
  const id = insertSoon(9, { chat: '507', phone: '+380671230507', name: 'Перенесу Пізніше' });
  await press('507', `c:${id}`);
  assert.ok(row(id).client_confirmed_at);
  let target = null;
  // Від післязавтра: перенесення на завтра може потрапити у вікно нагадування (24 год), і воно піде одразу
  for (let i = 2; i <= 20 && !target; i++) {
    const date = local(new Date(Date.now() + i * 86400000));
    const r = await srv.req('GET', `/api/admin/slots?serviceId=${serviceId}&date=${date}&masterId=${A.id}&excludeId=${id}`, { token: srv.ADMIN });
    if (r.body?.slots?.length) target = { date, time: r.body.slots[0] };
  }
  assert.ok(target, 'є вільний час для перенесення');
  const mv = await srv.req('PATCH', `/api/admin/appointments/${id}/move`, { token: srv.ADMIN, body: target });
  assert.equal(mv.status, 200, mv.text);
  assert.equal(row(id).client_confirmed_at, null);
  assert.equal(row(id).reminded, 0, 'нагадування надійде знову');
});
