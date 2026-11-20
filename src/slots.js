// Логіка вільного часу. Усі дати "YYYY-MM-DD", час "HH:MM", час береться з комп'ютера, де запущено сервер.

const STEP_MIN = 30;      // крок, з яким пропонуються початки прийомів
const MIN_LEAD_MIN = 60;  // не раніше ніж через стільки хвилин від зараз

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

// 0 = Понеділок ... 6 = Неділя
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Неділя
  return (jsDay + 6) % 7;
}

// Дата має існувати в календарі: "2027-02-31" не проходить.
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function fmtLocal(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function todayStr() {
  return fmtLocal(new Date());
}

// Остання дата, на яку можна записатися: сьогодні + days
function maxDateStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtLocal(d);
}

// Дата, на яку клієнт може записатися: існує, не в минулому і не далі горизонту
function isBookableDate(s, horizonDays) {
  return isValidDate(s) && s >= todayStr() && s <= maxDateStr(horizonDays);
}

function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Час на прибирання після кожного візиту, хв (налаштовується в адмінці, за замовчуванням 0)
function bufferMin(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'buffer_min'").get();
  const n = Number(row?.value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function freeSlots(db, dateStr, durationMin) {
  const hours = db.prepare('SELECT start_time, end_time FROM work_hours WHERE weekday = ?').get(weekdayOf(dateStr));
  if (!hours || !hours.start_time) return [];

  const dayStart = toMin(hours.start_time);
  const dayEnd = toMin(hours.end_time);
  const buffer = bufferMin(db);

  const busy = [
    ...db.prepare("SELECT start_time AS s, end_time AS e FROM appointments WHERE date = ? AND status != 'cancelled'").all(dateStr)
      .map((r) => ({ s: r.s, e: toHHMM(toMin(r.e) + buffer) })), // після візиту лишається час на прибирання
    ...db.prepare('SELECT start_time AS s, end_time AS e FROM blocks WHERE date = ?').all(dateStr),
    ...db.prepare('SELECT start_time AS s, end_time AS e FROM breaks WHERE weekday = ?').all(weekdayOf(dateStr)),
  ].map((r) => ({ s: toMin(r.s), e: toMin(r.e) }));

  const earliest = dateStr === todayStr() ? nowMin() + MIN_LEAD_MIN : 0;

  const slots = [];
  for (let t = dayStart; t + durationMin <= dayEnd; t += STEP_MIN) {
    if (t < earliest) continue;
    const end = t + durationMin;
    if (busy.some((b) => t < b.e && end > b.s)) continue;
    slots.push(toHHMM(t));
  }
  return slots;
}

// Дата, зсунута на n днів (працює з рядком YYYY-MM-DD)
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

module.exports = { freeSlots, bufferMin, isValidDate, isBookableDate, maxDateStr, todayStr, toMin, toHHMM, weekdayOf, addDays, STEP_MIN };
