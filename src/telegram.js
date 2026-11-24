// Сповіщення майстру в Telegram: новий запис і нове питання в чаті.
// Токен бота й номер чату зберігаються в таблиці settings (ключі tg_token, tg_chat_id)
// і задаються в адмінці, вкладка «Кабінет».

const API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,50}$/;
const CHAT_RE = /^-?\d{1,20}$/;
const CHAT_REPEAT_MS = 5 * 60 * 1000; // про той самий діалог повідомляємо не частіше ніж раз на 5 хв
const POLL_TIMEOUT_S = 25; // довге опитування Telegram: сервер чекає нових повідомлень до 25 с

function createTelegram(db) {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const set = (k, v) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

  async function call(token, method, body, timeoutMs = 10000) {
    const r = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
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
    const changed = token && token !== get('tg_token');
    if (token) set('tg_token', token); // порожнє поле означає «залишити збережений токен»
    set('tg_chat_id', chatId);
    if (changed || !poll) startPolling();
  }

  function clear() {
    set('tg_token', '');
    set('tg_chat_id', '');
    stopPolling();
    recentChats.clear();
  }

  // ----- Опитування бота: клієнти натискають «Start» за посиланням із сайту -----
  // Поки бот увімкнений, сервер сам забирає повідомлення боту (getUpdates). Тому «Знайти мій чат»
  // бере чати з пам'яті, а не напряму з Telegram.
  const recentChats = new Map(); // id → { id, name }, останні 50 чатів, що писали боту
  let poll = null; // { token, stop }
  let botUsername = '';
  let startHandler = () => null; // (код зі /start, чат) → текст відповіді або null

  function remember(chat) {
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id);
    recentChats.delete(String(chat.id));
    recentChats.set(String(chat.id), { id: String(chat.id), name });
    while (recentChats.size > 50) recentChats.delete(recentChats.keys().next().value);
  }

  async function handleUpdate(token, u) {
    const m = u.message;
    if (!m?.chat || m.chat.type !== 'private') return;
    remember(m.chat);
    const chatId = String(m.chat.id);
    const text = String(m.text || '').trim();
    const code = (text.match(/^\/start\s+(\S+)/) || [])[1];
    let reply = code ? startHandler(code, chatId) : null;
    if (!reply && chatId !== get('tg_chat_id')) {
      const name = get('name') || 'кабінет';
      reply = `Привіт! Цей бот надсилає нагадування про запис у «${name}». Щоб увімкнути нагадування, ` +
        'запишіться на сайті й натисніть кнопку «Нагадати в Telegram» під підтвердженням запису.';
    }
    if (reply) await call(token, 'sendMessage', { chat_id: chatId, text: reply }).catch(() => {});
  }

  function startPolling() {
    stopPolling();
    const token = get('tg_token');
    if (!token) return;
    const state = { token, stopped: false, ctrl: null };
    poll = state;
    (async () => {
      try {
        botUsername = (await call(token, 'getMe')).username || '';
      } catch (e) {
        console.error('Telegram:', explain(e));
      }
      let offset = 0;
      while (!state.stopped) {
        try {
          const updates = await call(token, 'getUpdates',
            { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] }, (POLL_TIMEOUT_S + 10) * 1000);
          for (const u of updates) {
            offset = u.update_id + 1;
            await handleUpdate(token, u);
          }
          if (!botUsername) botUsername = (await call(token, 'getMe').catch(() => ({}))).username || '';
        } catch (e) {
          if (state.stopped) break;
          console.error('Telegram (опитування):', explain(e));
          await new Promise((r) => setTimeout(r, 30000)); // пауза перед наступною спробою
        }
      }
    })();
  }

  function stopPolling() {
    if (poll) poll.stopped = true;
    poll = null;
    botUsername = '';
  }

  // Шукає чати, які нещодавно писали боту: так майстер дізнається свій номер чату
  async function detect(tokenFromForm) {
    const formToken = String(tokenFromForm || '').trim();
    if (poll && (!formToken || formToken === poll.token)) return [...recentChats.values()];
    const token = formToken || get('tg_token');
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

  async function send(text, toChat) {
    const token = get('tg_token');
    const chatId = toChat || get('tg_chat_id');
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

  function newAppointment({ service, date, time, name, phone, comment, master, warn = '' }) {
    fire(`🗓 Новий запис\n${service}${master ? ' · майстер: ' + master : ''}\n${fmtDate(date)} о ${time}\n${name}, ${phone}${comment ? '\nКоментар: ' + comment : ''}${warn}`);
  }

  const lastChatNotice = new Map();
  function newChatMessage(conversationId, body) {
    const now = Date.now();
    if (now - (lastChatNotice.get(conversationId) || 0) < CHAT_REPEAT_MS) return;
    lastChatNotice.set(conversationId, now);
    const preview = body.length > 300 ? body.slice(0, 300) + '…' : body;
    fire(`💬 Нове питання в чаті (діалог ${conversationId.slice(0, 6)})\n\n${preview}\n\nВідповісти: адмінка → вкладка «Чат»`);
  }

  // Повідомлення клієнту (нагадування, скасування). Повертає true, якщо надіслано.
  const sendToClient = (chatId, text) => send(text, chatId).catch((e) => {
    console.error('Telegram (клієнт):', explain(e));
    return false;
  });

  // Посилання для клієнта: відкриває бота з кодом запису. null, якщо бот не налаштований.
  const remindLink = (code) => (botUsername && status().configured ? `https://t.me/${botUsername}?start=${code}` : null);

  const onStart = (fn) => { startHandler = fn; };

  startPolling();

  return {
    status, save, clear, detect, test, newAppointment, newChatMessage,
    sendToClient, remindLink, onStart, fmtDate, notifyMaster: (text) => fire(text),
  };
}

module.exports = { createTelegram };
