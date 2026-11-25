// Відео від клієнта: лише з кабінету й зі згодою, перевірка формату, доступ персоналу (майстер — свої й «будь-кому»),
// одноразове посилання, відповідь майстра в кабінеті, ліміт на добу, видалення клієнтом і при повному видаленні клієнта.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeMaster } = require('./helpers');

let srv, A, B, cookie;
const PHONE = '+380671118800';
// Найменший «MP4»: заголовок ftyp + заповнення (сервер перевіряє перші байти й розмір від 1000 байт)
const mp4 = (n = 4000) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(n)]);
const mov = () => Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(3000)]);
const up = (buf, q = 'consent=1', type = 'video/mp4', c = cookie) => fetch(`${srv.base}/api/account/videos?${q}`, { method: 'POST', headers: { 'Content-Type': type, ...(c ? { Cookie: c } : {}) }, body: buf });
const acc = (url, opts = {}) => srv.req(opts.method || 'GET', url, { headers: { Cookie: cookie }, ...opts });
const videoDir = () => path.join(srv.dir, 'private', 'client-videos');

before(async () => {
  srv = await startServer();
  A = await makeMaster(srv, 'videoa', 'Майстер Відео А');
  B = await makeMaster(srv, 'videob', 'Майстер Відео Б');
  const reg = await srv.req('POST', '/api/account/register', { body: { name: 'Клієнтка Відео', phone: PHONE, password: 'cabinet-pass-1' } });
  assert.equal(reg.status, 201, reg.text);
  cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
});
after(() => srv && srv.stop());

test('без входу, без згоди й не відео — відмова; MP4 і MOV з телефона — приймаються', async () => {
  assert.equal((await up(mp4(), 'consent=1', 'video/mp4', null)).status, 401);
  assert.equal((await up(mp4(), '')).status, 400, 'без згоди');
  const notVideo = await up(Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(3000)]));
  assert.equal(notVideo.status, 400);
  assert.match((await notVideo.json()).error, /MP4, MOV/);
  const r = await up(mp4(), `consent=1&masterId=${A.id}&comment=${encodeURIComponent('Врослий ніготь, болить')}`);
  assert.equal(r.status, 201, await r.clone().text());
  const r2 = await up(mov(), 'consent=1', 'video/quicktime');
  assert.equal(r2.status, 201);
  const files = fs.readdirSync(videoDir());
  assert.equal(files.filter((f) => /\.(mp4|mov)$/.test(f)).length, 2);
  assert.ok(!files.some((f) => f.startsWith('tmp-')), 'тимчасових файлів не лишилось');
  const mine = (await acc('/api/account/videos')).body;
  assert.equal(mine.length, 2);
  assert.equal(mine[1].master, 'Майстер Відео А');
  assert.equal(mine[1].comment, 'Врослий ніготь, болить');
  assert.match(mine[1].expires_on, /^\d{4}-\d{2}-\d{2}$/);
});

test('клієнт дивиться своє відео (з перемотуванням), чуже — ні', async () => {
  const id = (await acc('/api/account/videos')).body[1].id;
  const f = await fetch(`${srv.base}/api/account/videos/${id}/file`, { headers: { Cookie: cookie, Range: 'bytes=0-99' } });
  assert.equal(f.status, 206, 'частинами — для перемотування');
  assert.equal(f.headers.get('content-type'), 'video/mp4');
  assert.equal((await fetch(`${srv.base}/api/account/videos/${id}/file`)).status, 404, 'без входу — ні');
});

test('персонал: суперадмін бачить усі, майстер — свої й «будь-кому»; посилання на 10 хв; підробка — 403', async () => {
  const all = (await srv.req('GET', '/api/admin/client-videos', { token: srv.ADMIN })).body;
  assert.equal(all.length, 2);
  const forA = all.find((v) => v.master === 'Майстер Відео А');
  const forAny = all.find((v) => !v.master_id);
  assert.equal((await srv.req('GET', '/api/admin/client-videos', { token: A.token })).body.length, 2, 'майстер А: своє + будь-кому');
  const bList = (await srv.req('GET', '/api/admin/client-videos', { token: B.token })).body;
  assert.deepEqual(bList.map((v) => v.id), [forAny.id], 'майстер Б не бачить відео для А');
  assert.equal((await srv.req('GET', `/api/admin/client-videos/${forA.id}/link`, { token: B.token })).status, 404);
  assert.equal((await srv.req('GET', '/api/admin/client-videos/new-count', { token: srv.ADMIN })).body.count, 2);

  const link = (await srv.req('GET', `/api/admin/client-videos/${forA.id}/link`, { token: A.token })).body.url;
  assert.match(link, /^\/media\/client-video\/\d+\?i=0&exp=\d+&sig=/);
  assert.equal((await fetch(srv.base + link)).status, 200);
  assert.equal((await fetch(srv.base + link.replace(/sig=.{4}/, 'sig=AAAA'))).status, 403);
  assert.equal((await fetch(srv.base + link.replace(/exp=\d+/, 'exp=1'))).status, 403, 'прострочене');
  assert.equal((await srv.req('GET', '/api/admin/client-videos/new-count', { token: srv.ADMIN })).body.count, 1, 'відкрите — «переглянуто»');
  assert.equal((await srv.req('GET', '/api/admin/client-videos')).status, 401);
});

test('відповідь майстра: клієнт бачить у кабінеті; чужий майстер не відповість; журнал дій', async () => {
  const forA = (await srv.req('GET', '/api/admin/client-videos', { token: srv.ADMIN })).body.find((v) => v.master_id === A.id);
  assert.equal((await srv.req('PUT', `/api/admin/client-videos/${forA.id}/reply`, { token: B.token, body: { reply: 'Чуже' } })).status, 404);
  assert.equal((await srv.req('PUT', `/api/admin/client-videos/${forA.id}/reply`, { token: A.token, body: { reply: '' } })).status, 400);
  const r = await srv.req('PUT', `/api/admin/client-videos/${forA.id}/reply`, { token: A.token, body: { reply: 'Можна виправити скобою. Записуйтесь на корекцію.' } });
  assert.equal(r.status, 200, r.text);
  const mine = (await acc('/api/account/videos')).body.find((v) => v.id === forA.id);
  assert.deepEqual({ s: mine.status, r: mine.reply, by: mine.reply_by }, { s: 'answered', r: 'Можна виправити скобою. Записуйтесь на корекцію.', by: 'Майстер Відео А' });
  const audit = (await srv.req('GET', '/api/admin/audit?limit=50', { token: srv.ADMIN })).body.rows;
  assert.ok(audit.some((x) => x.action === 'Фото/відео: відповідь клієнтові' && x.target === 'Клієнтка Відео'));
});

test('ліміт: не більше 3 надсилань (фото чи відео) на добу', async () => {
  const r = await up(mp4());
  assert.equal(r.status, 201);
  const over = await up(mp4());
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /не більше 3 разів/);
});

test('клієнт видаляє своє відео (і файл); повне видалення клієнта прибирає решту', async () => {
  const before = fs.readdirSync(videoDir()).length;
  const id = (await acc('/api/account/videos')).body[0].id;
  assert.equal((await acc(`/api/account/videos/${id}`, { method: 'DELETE' })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readdirSync(videoDir()).length, before - 1);
  const key = PHONE.replace(/\D/g, '').slice(-9);
  const del = await srv.req('DELETE', '/api/admin/clients/' + key, { token: srv.ADMIN, body: { confirm: key.slice(-4) } });
  assert.equal(del.status, 200, del.text);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readdirSync(videoDir()).filter((f) => !f.startsWith('.')).length, 0, 'файлів не лишилось');
  assert.equal((await srv.req('GET', '/api/admin/client-videos', { token: srv.ADMIN })).body.length, 0);
});

test('фото для майстра: до 5 JPEG за раз; персонал бачить кожне за одноразовим посиланням; клієнт — свої', async () => {
  const reg = await srv.req('POST', '/api/account/register', { body: { name: 'Клієнтка Фото', phone: '+380671118811', password: 'cabinet-pass-1' } });
  assert.equal(reg.status, 201, reg.text);
  const c2 = (reg.headers.get('set-cookie') || '').split(';')[0];
  const jpg = (n) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(1500 + n)]);
  const pack = (list) => Buffer.concat(list.flatMap((b) => { const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return [h, b]; }));
  const send = (body, q = 'consent=1') => fetch(`${srv.base}/api/account/photos?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/x-photo-pack', Cookie: c2 }, body });

  assert.equal((await send(pack([jpg(1)]), '')).status, 400, 'без згоди');
  assert.equal((await send(pack([Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(2000)])]))).status, 400, 'не JPEG');
  assert.equal((await send(pack([1, 2, 3, 4, 5, 6].map(jpg)))).status, 400, '6 фото — забагато');
  assert.equal((await fetch(`${srv.base}/api/account/photos?consent=1`, { method: 'POST', headers: { 'Content-Type': 'application/x-photo-pack' }, body: pack([jpg(1)]) })).status, 401);
  const ok = await send(pack([jpg(1), jpg(2)]), `consent=1&comment=${encodeURIComponent('Тріщини на п\'ятах')}`);
  assert.equal(ok.status, 201, await ok.clone().text());
  const { id, count } = await ok.json();
  assert.equal(count, 2);

  const mine = (await srv.req('GET', '/api/account/videos', { headers: { Cookie: c2 } })).body;
  assert.deepEqual({ k: mine[0].kind, n: mine[0].count }, { k: 'photo', n: 2 });
  const own = await fetch(`${srv.base}/api/account/videos/${id}/file?i=1`, { headers: { Cookie: c2 } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/jpeg');

  const item = (await srv.req('GET', '/api/admin/client-videos', { token: srv.ADMIN })).body.find((v) => v.id === id);
  assert.deepEqual({ k: item.kind, n: item.count }, { k: 'photo', n: 2 });
  const link = (await srv.req('GET', `/api/admin/client-videos/${id}/link`, { token: A.token })).body;
  assert.equal(link.kind, 'photo');
  assert.equal(link.urls.length, 2);
  for (const u of link.urls) assert.equal((await fetch(srv.base + u)).status, 200);
  assert.equal((await fetch(srv.base + link.urls[1].replace('i=1', 'i=0'))).status, 403, 'підпис прив\'язаний до номера фото');

  // Видалення клієнткою — обидва файли
  const files = () => fs.readdirSync(videoDir()).filter((f) => f.endsWith('.jpg')).length;
  assert.equal(files(), 2);
  assert.equal((await srv.req('DELETE', `/api/account/videos/${id}`, { headers: { Cookie: c2 } })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(files(), 0);
});
