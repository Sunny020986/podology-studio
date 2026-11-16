const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { openDb, DB_PATH } = require('./db');
const { freeSlots, isValidDate, todayStr, toMin, toHHMM } = require('./slots');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.dirname(DB_PATH);

const db = openDb();

// ---------- Токен адміна ----------
// Беремо з ADMIN_TOKEN, інакше з data/admin-token.txt, інакше створюємо новий.
function loadAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'admin-token.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, token);
  console.log(`Створено токен адміна і збережено у файлі: ${file}`);
  return token;
}
const ADMIN_TOKEN = loadAdminToken();

function tokenOk(t) {
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const requireAdmin = (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || !tokenOk(h.slice(7))) {
    return res.status(401).json({ error: 'Невірний токен' });
  }
  next();
};

// ---------- Валідація ----------
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function validateService(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (name.length < 2 || name.length > 80) return { error: 'Назва: від 2 до 80 символів' };
    out.name = name;
  }
  if (!partial || body.description !== undefined) out.description = String(body.description ?? '').trim().slice(0, 300);
  if (!partial || body.duration_min !== undefined) {
    const d = Number(body.duration_min);
    if (!Number.isInteger(d) || d < 5 || d > 480) return { error: 'Тривалість: від 5 до 480 хвилин' };
    out.duration_min = d;
  }
  if (!partial || body.price_uah !== undefined) {
    const p = Number(body.price_uah);
    if (!Number.isInteger(p) || p < 0 || p > 1000000) return { error: 'Ціна: ціле число від 0 до 1000000' };
    out.price_uah = p;
  }
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  return { data: out };
}

function updateRow(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  return db.prepare(sql).run(...keys.map((k) => data[k]), id).changes;
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// ---------- Публічне API ----------
app.get('/api/services', (req, res) => {
  res.json(db.prepare('SELECT id, name, description, duration_min, price_uah FROM services WHERE active = 1 ORDER BY id').all());
});

app.get('/api/slots', (req, res) => {
  const service = db.prepare('SELECT duration_min FROM services WHERE id = ? AND active = 1').get(Number(req.query.serviceId));
  const date = String(req.query.date || '');
  if (!service) return res.status(400).json({ error: 'Невідома послуга' });
  if (!isValidDate(date) || date < todayStr()) return res.status(400).json({ error: 'Некоректна дата' });
  res.json({ date, slots: freeSlots(db, date, service.duration_min) });
});

// Перевірка вільного часу і запис виконуються в одній транзакції, тому два клієнти не займуть один слот.
const bookTx = db.transaction(({ service, date, time, name, phone }) => {
  const free = freeSlots(db, date, service.duration_min);
  if (!free.includes(time)) {
    throw Object.assign(new Error('Цей час уже недоступний, оберіть інший'), { status: 409 });
  }
  const end = toHHMM(toMin(time) + service.duration_min);
  const info = db
    .prepare('INSERT INTO appointments (service_id, date, start_time, end_time, client_name, client_phone) VALUES (?, ?, ?, ?, ?, ?)')
    .run(service.id, date, time, end, name, phone);
  return info.lastInsertRowid;
});

app.post('/api/appointments', (req, res) => {
  const { serviceId, date, time, name, phone } = req.body || {};
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(Number(serviceId));
  if (!service) return res.status(400).json({ error: 'Невідома послуга' });
  if (!isValidDate(date) || date < todayStr()) return res.status(400).json({ error: 'Некоректна дата' });
  if (!isTime(time)) return res.status(400).json({ error: 'Некоректний час' });

  const cleanName = String(name ?? '').trim();
  if (cleanName.length < 2 || cleanName.length > 60) return res.status(400).json({ error: "Вкажіть ім'я (від 2 до 60 символів)" });

  const cleanPhone = String(phone ?? '').trim();
  const digits = cleanPhone.replace(/\D/g, '');
  if (!/^\+?[\d\s()-]+$/.test(cleanPhone) || digits.length < 9 || digits.length > 15) {
    return res.status(400).json({ error: 'Вкажіть коректний телефон' });
  }

  try {
    const id = bookTx({ service, date, time, name: cleanName, phone: cleanPhone });
    res.status(201).json({ id: Number(id), date, time, service: service.name });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ---------- Адмін API ----------
app.use('/api/admin', requireAdmin);

app.get('/api/admin/appointments', (req, res) => {
  const from = isValidDate(req.query.from) ? req.query.from : todayStr();
  const to = isValidDate(req.query.to) ? req.query.to : from;
  res.json(
    db
      .prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.client_name, a.client_phone, a.status, s.name AS service
                FROM appointments a JOIN services s ON s.id = a.service_id
                WHERE a.date BETWEEN ? AND ? ORDER BY a.date, a.start_time`)
      .all(from, to)
  );
});

app.patch('/api/admin/appointments/:id', (req, res) => {
  const status = req.body?.status;
  if (!['new', 'confirmed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Некоректний статус' });
  const changed = db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, Number(req.params.id)).changes;
  if (!changed) return res.status(404).json({ error: 'Запис не знайдено' });
  res.json({ ok: true });
});

app.get('/api/admin/services', (req, res) => {
  res.json(db.prepare('SELECT id, name, description, duration_min, price_uah, active FROM services ORDER BY id').all());
});

app.post('/api/admin/services', (req, res) => {
  const v = validateService(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const d = { description: '', price_uah: 0, active: 1, ...v.data };
  const info = db
    .prepare('INSERT INTO services (name, description, duration_min, price_uah, active) VALUES (?, ?, ?, ?, ?)')
    .run(d.name, d.description, d.duration_min, d.price_uah, d.active);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.patch('/api/admin/services/:id', (req, res) => {
  const v = validateService(req.body || {}, true);
  if (v.error) return res.status(400).json({ error: v.error });
  if (!updateRow('services', Number(req.params.id), v.data)) return res.status(404).json({ error: 'Послугу не знайдено' });
  res.json({ ok: true });
});

app.get('/api/admin/schedule', (req, res) => {
  res.json(db.prepare('SELECT weekday, start_time, end_time FROM work_hours ORDER BY weekday').all());
});

app.put('/api/admin/schedule/:weekday', (req, res) => {
  const wd = Number(req.params.weekday);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return res.status(400).json({ error: 'День: від 0 (Пн) до 6 (Нд)' });
  const { start_time, end_time } = req.body || {};
  if (start_time === null || start_time === undefined) {
    db.prepare('UPDATE work_hours SET start_time = NULL, end_time = NULL WHERE weekday = ?').run(wd);
    return res.json({ ok: true });
  }
  if (!isTime(start_time) || !isTime(end_time) || toMin(start_time) >= toMin(end_time)) {
    return res.status(400).json({ error: 'Початок має бути раніше за кінець' });
  }
  db.prepare('UPDATE work_hours SET start_time = ?, end_time = ? WHERE weekday = ?').run(start_time, end_time, wd);
  res.json({ ok: true });
});

app.get('/api/admin/blocks', (req, res) => {
  const date = isValidDate(req.query.date) ? req.query.date : todayStr();
  res.json(db.prepare('SELECT id, date, start_time, end_time, note FROM blocks WHERE date = ? ORDER BY start_time').all(date));
});

app.post('/api/admin/blocks', (req, res) => {
  const { date, start_time, end_time, note } = req.body || {};
  if (!isValidDate(date)) return res.status(400).json({ error: 'Некоректна дата' });
  if (!isTime(start_time) || !isTime(end_time) || toMin(start_time) >= toMin(end_time)) {
    return res.status(400).json({ error: 'Початок має бути раніше за кінець' });
  }
  const info = db
    .prepare('INSERT INTO blocks (date, start_time, end_time, note) VALUES (?, ?, ?, ?)')
    .run(date, start_time, end_time, String(note ?? '').trim().slice(0, 100));
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.delete('/api/admin/blocks/:id', (req, res) => {
  db.prepare('DELETE FROM blocks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/conversations', (req, res) => {
  res.json(listConversations());
});

app.get('/api/admin/conversations/:id/messages', (req, res) => {
  res.json(messagesOf(req.params.id));
});

// Видалення діалогу разом з усіма його повідомленнями. Дію не можна скасувати.
const deleteConversationTx = db.transaction((id) => {
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
  return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes;
});

app.delete('/api/admin/conversations/:id', (req, res) => {
  const id = req.params.id;
  if (!deleteConversationTx(id)) return res.status(404).json({ error: 'Діалог не знайдено' });

  // Відвідувача, який ще тримає цей діалог відкритим, від'єднуємо:
  // його сторінка сама перепідключиться і отримає новий порожній діалог.
  const sockets = clients.get(id);
  if (sockets) {
    clients.delete(id);
    sockets.forEach((c) => {
      c.meta.conversationId = null;
      c.close(4001, 'conversation deleted');
    });
  }
  notifyAdmins({ type: 'conversation_deleted', conversationId: id });
  res.json({ ok: true });
});

// ---------- Чат (WebSocket) ----------
function listConversations() {
  return db
    .prepare(`SELECT c.id, c.last_message_at,
                     (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body
              FROM conversations c ORDER BY c.last_message_at DESC LIMIT 200`)
    .all();
}

function messagesOf(convId) {
  return db
    .prepare('SELECT id, conversation_id, sender, body, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 50')
    .all(convId)
    .reverse();
}

function saveMessage(convId, sender, body) {
  const info = db.prepare('INSERT INTO messages (conversation_id, sender, body) VALUES (?, ?, ?)').run(convId, sender, body);
  db.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").run(convId);
  return db.prepare('SELECT id, conversation_id, sender, body, created_at FROM messages WHERE id = ?').get(info.lastInsertRowid);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const clients = new Map(); // conversationId -> Set<ws>
const admins = new Set();

const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const notifyAdmins = (obj) => admins.forEach((a) => send(a, obj));

function detach(ws) {
  const id = ws.meta.conversationId;
  if (id && clients.has(id)) clients.get(id).delete(ws);
  ws.meta.conversationId = null;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const isAdmin = tokenOk(url.searchParams.get('admin'));
  ws.meta = { role: isAdmin ? 'admin' : 'client', conversationId: null, hits: [] };

  if (isAdmin) {
    admins.add(ws);
    send(ws, { type: 'admin_ready' });
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (ws.meta.role === 'admin') handleAdmin(ws, msg);
    else handleClient(ws, msg);
  });

  ws.on('close', () => {
    admins.delete(ws);
    detach(ws);
  });
});

function handleClient(ws, msg) {
  if (msg.type === 'hello') {
    let id = typeof msg.conversationId === 'string' && /^[a-f0-9-]{36}$/.test(msg.conversationId) ? msg.conversationId : null;
    if (!id || !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) {
      id = crypto.randomUUID();
      db.prepare('INSERT INTO conversations (id) VALUES (?)').run(id);
    }
    detach(ws);
    ws.meta.conversationId = id;
    if (!clients.has(id)) clients.set(id, new Set());
    clients.get(id).add(ws);
    send(ws, { type: 'hello', conversationId: id, messages: messagesOf(id) });
    return;
  }

  if (msg.type === 'message') {
    const id = ws.meta.conversationId;
    if (!id) return;
    const body = String(msg.body ?? '').trim();
    if (!body || body.length > 1000) {
      return send(ws, { type: 'error', error: 'Повідомлення порожнє або довше 1000 символів' });
    }
    const now = Date.now();
    ws.meta.hits = ws.meta.hits.filter((t) => now - t < 10000);
    if (ws.meta.hits.length >= 5) {
      return send(ws, { type: 'error', error: 'Забагато повідомлень. Зачекайте 10 секунд' });
    }
    ws.meta.hits.push(now);
    const message = saveMessage(id, 'client', body);
    send(ws, { type: 'message', message });
    notifyAdmins({ type: 'message', conversationId: id, message });
  }
}

function handleAdmin(ws, msg) {
  if (msg.type === 'reply') {
    const convId = String(msg.conversationId ?? '');
    const body = String(msg.body ?? '').trim();
    if (!body || body.length > 1000) return send(ws, { type: 'error', error: 'Повідомлення порожнє або довше 1000 символів' });
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(convId)) return send(ws, { type: 'error', error: 'Діалог не знайдено' });
    const message = saveMessage(convId, 'operator', body);
    (clients.get(convId) || new Set()).forEach((c) => send(c, { type: 'message', message }));
    notifyAdmins({ type: 'message', conversationId: convId, message });
  }
}

server.listen(PORT, () => {
  console.log(`Сайт: http://localhost:${PORT}`);
  console.log(`Адмінка: http://localhost:${PORT}/admin`);
  console.log(`База даних: ${DB_PATH}`);
});
