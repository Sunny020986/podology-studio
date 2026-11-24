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

// Вільний час одного майстра на дату: його робочі години мінус записи (з прибиранням), блокування й перерви
function masterFreeSlots(db, dateStr, durationMin, masterId, excludeId = 0) {
  const wd = weekdayOf(dateStr);
  const hours = db.prepare('SELECT start_time, end_time FROM master_hours WHERE master_id = ? AND weekday = ?').get(masterId, wd);
  if (!hours || !hours.start_time) return [];

  const dayStart = toMin(hours.start_time);
  const dayEnd = toMin(hours.end_time);
  const buffer = bufferMin(db);

  const busy = [
    ...db.prepare("SELECT start_time AS s, end_time AS e FROM appointments WHERE master_id = ? AND date = ? AND status != 'cancelled' AND id != ?")
      .all(masterId, dateStr, excludeId)
      .map((r) => ({ s: r.s, e: toHHMM(toMin(r.e) + buffer) })), // після візиту лишається час на прибирання
    ...db.prepare('SELECT start_time AS s, end_time AS e FROM blocks WHERE master_id = ? AND date = ?').all(masterId, dateStr),
    ...db.prepare('SELECT start_time AS s, end_time AS e FROM breaks WHERE master_id = ? AND weekday = ?').all(masterId, wd),
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

// Майстри, які можуть прийняти: конкретний (якщо активний і робить цю послугу) або всі такі
function candidateMasters(db, masterId, serviceId) {
  const rows = serviceId
    ? db.prepare(`SELECT m.id FROM masters m JOIN master_services ms ON ms.master_id = m.id
        WHERE m.status = 'active' AND ms.service_id = ? ORDER BY m.id`).all(serviceId)
    : db.prepare("SELECT id FROM masters WHERE status = 'active' ORDER BY id").all();
  const ids = rows.map((r) => r.id);
  return masterId ? ids.filter((id) => id === Number(masterId)) : ids;
}

// Вільний час для клієнта. masterId порожній = «будь-який вільний майстер»: об'єднання часу всіх, хто робить послугу.
function freeSlots(db, dateStr, durationMin, { masterId = null, serviceId = null, excludeId = 0 } = {}) {
  const set = new Set();
  for (const id of candidateMasters(db, masterId, serviceId)) {
    for (const t of masterFreeSlots(db, dateStr, durationMin, id, excludeId)) set.add(t);
  }
  return [...set].sort();
}

// Кому віддати запис на конкретний час. Для «будь-кого» обираємо вільного майстра з найменшою кількістю записів цього дня.
function pickMaster(db, dateStr, durationMin, time, { masterId = null, serviceId = null, excludeId = 0 } = {}) {
  const free = candidateMasters(db, masterId, serviceId)
    .filter((id) => masterFreeSlots(db, dateStr, durationMin, id, excludeId).includes(time));
  if (!free.length) return null;
  const load = (id) => db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE master_id = ? AND date = ? AND status != 'cancelled'").get(id, dateStr).n;
  return free.sort((a, b) => load(a) - load(b) || a - b)[0];
}

// Дата, зсунута на n днів (працює з рядком YYYY-MM-DD)
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

module.exports = { nowMin, freeSlots, masterFreeSlots, pickMaster, candidateMasters, bufferMin, isValidDate, isBookableDate, maxDateStr, todayStr, toMin, toHHMM, weekdayOf, addDays, STEP_MIN };
