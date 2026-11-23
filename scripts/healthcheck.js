// Сторож: перевіряє /healthz і пише в Telegram-чат кабінету, коли сайт ліг і коли піднявся.
// Запускається таймером systemd (deploy/podology-health.timer) кожні 2 хвилини.
// Сповіщення — після 2 невдалих перевірок поспіль, щоб не тривожити через один збій під час перезапуску.
//
// Змінні: HEALTH_URL (http://127.0.0.1:3000/healthz), DB_PATH (звідки взяти токен бота й номер чату),
// HEALTH_STATE (файл зі станом), HEALTH_FAILS (2), TG_TOKEN і TG_CHAT_ID — якщо база недоступна.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const URL_ = process.env.HEALTH_URL || `http://127.0.0.1:${process.env.PORT || 3000}/healthz`;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'studio.db');
const STATE = process.env.HEALTH_STATE || path.join(ROOT, 'data', 'health-state.json');
const FAILS_TO_ALERT = Math.max(1, Number(process.env.HEALTH_FAILS) || 2);
const API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { fails: 0, down: false }; } };
const writeState = (s) => { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch (e) { console.error('Не вдалося записати стан:', e.message); } };

// Токен і чат беремо з бази (там, де їх задають в адмінці), а якщо база не читається — зі змінних
function telegramTarget() {
  let token = process.env.TG_TOKEN || '';
  let chat = process.env.TG_CHAT_ID || '';
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
    token = get('tg_token') || token;
    chat = get('tg_chat_id') || chat;
    db.close();
  } catch { /* база недоступна — лишаються змінні середовища */ }
  return { token, chat };
}

async function notify(text) {
  const { token, chat } = telegramTarget();
  if (!token || !chat) { console.error('Telegram не налаштовано, сповіщення не надіслано:', text); return; }
  const r = await fetch(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) console.error('Telegram відповів', r.status);
}

async function check() {
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(5000) });
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.ok) return { ok: true, version: body.version };
    return { ok: false, reason: body.error ? `${r.status}: ${body.error}` : `відповідь ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' ? 'не відповідає 5 секунд' : 'не вдалося підключитися' };
  }
}

(async () => {
  const st = readState();
  const res = await check();
  const now = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  if (res.ok) {
    if (st.down) {
      const mins = st.since ? Math.round((Date.now() - st.since) / 60000) : null;
      await notify(`✅ Сайт знову працює (${now}).${mins !== null ? ` Не працював приблизно ${mins} хв.` : ''} Версія ${res.version}.`).catch((e) => console.error(e.message));
    }
    writeState({ fails: 0, down: false });
    console.log('OK', res.version);
    return;
  }
  const fails = (st.fails || 0) + 1;
  const since = st.since || Date.now();
  console.error(`Збій ${fails}: ${res.reason}`);
  if (!st.down && fails >= FAILS_TO_ALERT) {
    await notify(`⚠️ Сайт не працює (${now}): ${res.reason}. Перевірок поспіль: ${fails}.\nЩо робити: docs/runbook.md, розділ 3. Перше — systemctl status podology`).catch((e) => console.error(e.message));
    writeState({ fails, down: true, since });
  } else {
    writeState({ fails, down: st.down, since });
  }
  process.exitCode = 1;
})();
