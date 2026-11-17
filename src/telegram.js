// Сповіщення майстру в Telegram: новий запис і нове питання в чаті.
// Токен бота й номер чату зберігаються в таблиці settings (ключі tg_token, tg_chat_id)
// і задаються в адмінці, вкладка «Кабінет».

const API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,50}$/;
const CHAT_RE = /^-?\d{1,20}$/;
const CHAT_REPEAT_MS = 5 * 60 * 1000; // про той самий діалог повідомляємо не частіше ніж раз на 5 хв

function createTelegram(db) {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const set = (k, v) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

  async function call(token, method, body) {
    const r = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(data.description || `Telegram відповів кодом ${r.status}`);
      err.code = r.status;
      throw err;
    }
    return data.result;
  }

  // Зрозуміле пояснення для адмінки замість технічної помилки
  function explain(e) {
    if (e.code === 401 || e.code === 404) return 'Telegram не прийняв токен. Перевірте, що скопіювали його з BotFather повністю';
    if (e.code === 400 || e.code === 403) return 'Бот не може писати в цей чат. Відкрийте бота в Telegram і натисніть «Start»';
    if (e.name === 'TimeoutError' || e.cause) return 'Сервер не може достукатися до api.telegram.org. Перевірте інтернет і DNS у контейнері';
    return e.message;
  }

  function status() {
    const token = get('tg_token');
    return {
      configured: Boolean(token && get('tg_chat_id')),
      hasToken: Boolean(token),
      tokenHint: token ? `${token.split(':')[0]}:…${token.slice(-4)}` : '',
      chatId: get('tg_chat_id'),
    };
  }

  function save({ token, chatId }) {
    token = String(token ?? '').trim();
    chatId = String(chatId ?? '').trim();
    if (token && !TOKEN_RE.test(token)) throw Object.assign(new Error('Схоже, це не токен бота. Він має вигляд 1234567890:AAH…'), { status: 400 });
    if (chatId && !CHAT_RE.test(chatId)) throw Object.assign(new Error('Номер чату складається лише з цифр (може починатися з «-»)'), { status: 400 });
    if (token) set('tg_token', token); // порожнє поле означає «залишити збережений токен»
    set('tg_chat_id', chatId);
  }

  function clear() {
    set('tg_token', '');
    set('tg_chat_id', '');
  }

  // Шукає чати, які нещодавно писали боту: так майстер дізнається свій номер чату
  async function detect(tokenFromForm) {
    const token = String(tokenFromForm || '').trim() || get('tg_token');
    if (!token) throw Object.assign(new Error('Спершу вставте токен бота'), { status: 400 });
    if (!TOKEN_RE.test(token)) throw Object.assign(new Error('Схоже, це не токен бота. Він має вигляд 1234567890:AAH…'), { status: 400 });
    let updates;
    try {
      updates = await call(token, 'getUpdates', { limit: 100, allowed_updates: ['message'] });
    } catch (e) {
      throw Object.assign(new Error(explain(e)), { status: 502 });
    }
    const chats = new Map();
    for (const u of updates) {
      const c = u.message?.chat;
      if (!c) continue;
      const name = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id);
      chats.set(String(c.id), { id: String(c.id), name });
    }
    return [...chats.values()];
  }

  async function send(text) {
    const token = get('tg_token');
    const chatId = get('tg_chat_id');
    if (!token || !chatId) return false;
    await call(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
    return true;
  }

  // Сповіщення не мають ламати запис чи чат: помилки лише пишемо в журнал
  const fire = (text) => send(text).catch((e) => console.error('Telegram:', explain(e)));

  async function test() {
    if (!status().configured) throw Object.assign(new Error('Спершу збережіть токен і номер чату'), { status: 400 });
    try {
      await send('✅ Тестове сповіщення з сайту. Якщо ви це бачите, усе налаштовано.');
    } catch (e) {
      throw Object.assign(new Error(explain(e)), { status: 502 });
    }
  }

  const fmtDate = (d) => d.split('-').reverse().join('.');

  function newAppointment({ service, date, time, name, phone }) {
    fire(`🗓 Новий запис\n${service}\n${fmtDate(date)} о ${time}\n${name}, ${phone}`);
  }

  const lastChatNotice = new Map();
  function newChatMessage(conversationId, body) {
    const now = Date.now();
    if (now - (lastChatNotice.get(conversationId) || 0) < CHAT_REPEAT_MS) return;
    lastChatNotice.set(conversationId, now);
    const preview = body.length > 300 ? body.slice(0, 300) + '…' : body;
    fire(`💬 Нове питання в чаті (діалог ${conversationId.slice(0, 6)})\n\n${preview}\n\nВідповісти: адмінка → вкладка «Чат»`);
  }

  return { status, save, clear, detect, test, newAppointment, newChatMessage };
}

module.exports = { createTelegram };
