// Нагадування про повторний візит. Для послуги в адмінці задається «повторити через N тижнів».
// Через цей час бот пропонує клієнту записатися знову, якщо він сам ще не записався.
const SEND_FROM_HOUR = 10;  // повідомлення лише вдень, з 10:00 до 20:00
const SEND_TO_HOUR = 20;
const LATE_WINDOW_DAYS = 14; // якщо нагадування запізнилось більше ніж на стільки днів, уже не надсилаємо

function createRepeatColumns(db) {
  const svc = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
  if (!svc.includes('repeat_weeks')) db.exec('ALTER TABLE services ADD COLUMN repeat_weeks INTEGER NOT NULL DEFAULT 0');
  const appt = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  // 0 — ще не перевіряли, 1 — нагадали, 2 — не потрібно (клієнт уже записався знову або немає Telegram)
  if (!appt.includes('repeat_sent')) db.exec('ALTER TABLE appointments ADD COLUMN repeat_sent INTEGER NOT NULL DEFAULT 0');
}

function setupRepeatReminders({ db, telegram, todayStr, siteUrl, last9 }) {
  const chatFor = (a) => a.tg_chat_id
    || db.prepare('SELECT tg_chat_id FROM accounts WHERE phone_key = ?').get(last9(a.client_phone))?.tg_chat_id
    || null;

  async function sendRepeatReminders() {
    const hour = new Date().getHours();
    if (hour < SEND_FROM_HOUR || hour >= SEND_TO_HOUR) return;
    const base = siteUrl();
    if (!base) return;
    const today = todayStr();
    const due = db.prepare(`SELECT a.*, COALESCE(a.services_label, s.name) AS service, s.repeat_weeks FROM appointments a JOIN services s ON s.id = a.service_id
      WHERE s.repeat_weeks > 0 AND a.status NOT IN ('cancelled', 'no_show') AND a.repeat_sent = 0
        AND a.date <= date(?, '-' || (s.repeat_weeks * 7) || ' day')
        AND a.date >= date(?, '-' || (s.repeat_weeks * 7 + ${LATE_WINDOW_DAYS}) || ' day')`).all(today, today);
    if (!due.length) return;
    const all = db.prepare("SELECT client_phone, date FROM appointments WHERE status != 'cancelled'").all();
    const mark = db.prepare('UPDATE appointments SET repeat_sent = ? WHERE id = ?');
    for (const a of due) {
      const key = last9(a.client_phone);
      const bookedAgain = all.some((x) => last9(x.client_phone) === key && x.date > a.date);
      const chat = chatFor(a);
      if (bookedAgain || !chat) { mark.run(2, a.id); continue; }
      mark.run(1, a.id); // спершу позначка: двічі не нагадаємо
      const name = String(a.client_name).trim().split(/\s+/)[0];
      await telegram.sendToClient(chat,
        `Вітаємо, ${name}! Минуло ${a.repeat_weeks} тиж. після процедури «${a.service}». ` +
        `Саме час для повторного візиту.\nОберіть зручний час: ${base.replace(/\/+$/, '')}/#booking`);
    }
  }
  setInterval(() => sendRepeatReminders().catch((e) => console.error('Повторний візит:', e.message)), 60 * 60 * 1000).unref();
  setTimeout(() => sendRepeatReminders().catch(() => {}), 25000).unref();
  return { sendRepeatReminders };
}

module.exports = { createRepeatColumns, setupRepeatReminders };
