// Кнопки під нагадуванням у Telegram: «✅ Буду» і «❌ Скасувати».
// «Буду» — запис стає «Підтверджено», в адмінці біля нього позначка «підтвердив у Telegram» (client_confirmed_at).
// «Скасувати» — з перепитуванням («Так, скасувати» / «Ні, залишити»). Скасувати самому можна не пізніше ніж
// за стільки годин до візиту, скільки задано в адмінці (те саме правило, що в кабінеті клієнта).
// Пізніше клієнт може лише повідомити, що не прийде: запис лишається, майстер і чат кабінету отримують
// повідомлення, а в адмінці біля запису позначка (client_declined_at). Скасовує тоді персонал.
// Кнопка діє лише в чаті, прив'язаному до цього запису або до кабінету клієнта з тим самим телефоном.
// Позначки скидаються, коли запис переносять на інший час (accounts.js, admin-appointments.js, reassign.js).

function createReminderColumns(db) {
  const cols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  if (!cols.includes('client_confirmed_at')) db.exec('ALTER TABLE appointments ADD COLUMN client_confirmed_at TEXT');
  if (!cols.includes('client_declined_at')) db.exec('ALTER TABLE appointments ADD COLUMN client_declined_at TEXT');
}

function setupReminderButtons({ db, telegram, changeHours, setStatus, live, notifyMasterOf, waitlistCheck, readStudio, todayStr, last9 }) {
  const appt = (id) => db.prepare(`SELECT a.*, COALESCE(a.services_label, s.name) AS service, m.name AS master FROM appointments a
    JOIN services s ON s.id = a.service_id LEFT JOIN masters m ON m.id = a.master_id WHERE a.id = ?`).get(id);
  const accountChat = (a) => db.prepare('SELECT tg_chat_id FROM accounts WHERE phone_key = ?').get(last9(a.client_phone))?.tg_chat_id || null;
  // Куди писати клієнту про запис: чат, прив'язаний до запису, або чат кабінету з тим самим телефоном
  const chatFor = (a) => a.tg_chat_id || accountChat(a);
  const chatOk = (a, chatId) => [a.tg_chat_id, accountChat(a)].filter(Boolean).map(String).includes(String(chatId));
  const hoursUntil = (a) => (new Date(`${a.date}T${a.start_time}:00`).getTime() - Date.now()) / 3600000;
  const fmt = (d) => d.split('-').reverse().join('.');
  const when = (a) => `${fmt(a.date)} о ${a.start_time}`;
  const studioLine = () => {
    const s = readStudio();
    return [[s.city, s.address].filter(Boolean).join(', '), s.phone].filter(Boolean).join(' · ');
  };
  const againLine = () => (readStudio().phone
    ? `Щоб обрати інший час, запишіться на сайті або подзвоніть: ${readStudio().phone}.`
    : 'Щоб обрати інший час, запишіться на сайті.');
  const staffLine = (a) => `${a.service}\n${when(a)}\n${a.client_name}, ${a.client_phone}`;

  // Нагадування надсилається в останню добу до візиту, тому день — «сьогодні» або «завтра»
  function head(a) {
    const day = a.date === todayStr() ? 'сьогодні' : 'завтра';
    return `🔔 Нагадування: ${day}, ${when(a)}, у вас ${a.service}.` + (studioLine() ? `\n${studioLine()}` : '');
  }
  const btn = (text, data) => ({ text, callback_data: data });
  const mainButtons = (a) => [[btn('✅ Буду', `c:${a.id}`), btn('❌ Скасувати', `x:${a.id}`)]];
  const reminder = (a) => ({
    text: `${head(a)}\nБудь ласка, підтвердіть візит або скасуйте, якщо плани змінилися.`,
    buttons: mainButtons(a),
  });
  // Поточний вигляд повідомлення: після «Буду» лишається тільки «Скасувати»
  const current = (a) => (a.client_confirmed_at
    ? { text: `${head(a)}\n✅ Ви підтвердили візит. Чекаємо на вас!`, buttons: [[btn('❌ Скасувати', `x:${a.id}`)]] }
    : reminder(a));

  function onButton(data, chatId) {
    const m = /^(c|x|xy|xn|xl):(\d{1,10})$/.exec(data);
    if (!m) return { answer: 'Ця кнопка вже не діє' };
    const [, act, id] = m;
    const a = appt(Number(id));
    if (!a || !chatOk(a, chatId)) return { answer: 'Запис не знайдено', text: 'Не знайшли цей запис. Якщо є питання, подзвоніть нам або напишіть у чат на сайті.' };
    if (a.status === 'cancelled') return { answer: 'Запис уже скасовано', text: `Запис ${a.service}, ${when(a)}, скасовано.\n${againLine()}` };
    if (hoursUntil(a) <= 0 || ['done', 'no_show'].includes(a.status)) return { answer: 'Цей візит уже минув', text: `Візит ${a.service}, ${when(a)}, уже минув. Дякуємо, що були у нас!` };
    if (a.client_declined_at) return { answer: 'Ми вже передали майстру', text: declinedText(a) };
    const late = hoursUntil(a) < changeHours();

    if (act === 'c') {
      db.prepare("UPDATE appointments SET client_confirmed_at = datetime('now') WHERE id = ?").run(a.id);
      if (a.status === 'new') setStatus(a.id, 'confirmed');
      live('confirmed', a);
      return { answer: 'Дякуємо! Чекаємо на вас', ...current(appt(a.id)) };
    }
    if (act === 'xn') return { answer: 'Запис залишається', ...current(a) };
    if (act === 'x') {
      return late
        ? { answer: '', text: `${head(a)}\nДо візиту менше ніж ${changeHours()} год, тому скасувати запис самостійно вже не можна. Передати майстру, що ви не прийдете?`,
            buttons: [[btn('Так, передати', `xl:${a.id}`), btn('Ні, я прийду', `xn:${a.id}`)]] }
        : { answer: '', text: `${head(a)}\nСкасувати цей запис?`, buttons: [[btn('Так, скасувати', `xy:${a.id}`), btn('Ні, залишити', `xn:${a.id}`)]] };
    }
    // «Так, скасувати»: якщо поки клієнт думав, час для самостійного скасування минув — лише повідомлення персоналу
    if (act === 'xy' && !late) {
      setStatus(a.id, 'cancelled');
      live('cancelled', a);
      telegram.notifyMaster(`❌ Клієнт скасував запис через Telegram\n${staffLine(a)}`);
      notifyMasterOf(a.master_id, `❌ Клієнт скасував запис до вас через Telegram\n${staffLine(a)}`);
      waitlistCheck();
      return { answer: 'Запис скасовано', text: `❌ Запис скасовано: ${a.service}, ${when(a)}.\n${againLine()}` };
    }
    // xl або запізніле xy: запис лишається, персонал вирішує
    db.prepare("UPDATE appointments SET client_declined_at = datetime('now') WHERE id = ?").run(a.id);
    live('declined', a);
    const staff = `⚠️ Клієнт повідомив у Telegram, що не прийде\n${staffLine(a)}\n` +
      `Запис не скасовано автоматично: до візиту менше ніж ${changeHours()} год. Скасуйте його в адмінці, щоб звільнити час.`;
    telegram.notifyMaster(staff);
    notifyMasterOf(a.master_id, staff);
    return { answer: 'Передали майстру', text: declinedText(a) };
  }
  const declinedText = (a) => `📨 Передали майстру, що ви не прийдете на ${a.service}, ${when(a)}. Дякуємо, що попередили!\n${againLine()}`;

  telegram.onCallback(onButton);
  return { reminder, chatFor };
}

module.exports = { createReminderColumns, setupReminderButtons };
