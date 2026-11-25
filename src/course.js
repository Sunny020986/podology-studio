// Курс лікування. У послузі задається: скільки повторних візитів, через скільки днів кожен
// і яка послуга для повторних (наприклад: «Встановлення скоби» → 4 × «Корекція скоби» кожні 21 день).
// За замовчуванням курсу немає (0 візитів): інтервали задає власник, сайт їх не вигадує.
//
// План рахується від запису, з якого курс почався. Кожен крок шукає запис клієнта на послугу
// для повторних у вікні ± половина інтервалу навколо запланованої дати.
// Бот нагадує клієнтові за REMIND_DAYS днів, якщо на крок ще немає запису.
const REMIND_DAYS = 3;
const SEND_FROM_HOUR = 10;
const SEND_TO_HOUR = 20;
const PLAN_LOOKBACK_DAYS = 365; // курси, що почались раніше, вже не показуємо

function createCourseColumns(db) {
  const svc = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
  if (!svc.includes('course_visits')) db.exec('ALTER TABLE services ADD COLUMN course_visits INTEGER NOT NULL DEFAULT 0');
  if (!svc.includes('course_interval_days')) db.exec('ALTER TABLE services ADD COLUMN course_interval_days INTEGER NOT NULL DEFAULT 0');
  if (!svc.includes('course_next_service_id')) db.exec('ALTER TABLE services ADD COLUMN course_next_service_id INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS course_reminders (
    start_appt_id INTEGER NOT NULL,
    step          INTEGER NOT NULL,
    sent_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (start_appt_id, step)
  )`);
}

// Перевірка налаштувань курсу (для створення й редагування послуги)
function validateCourse(body, out, partial) {
  if (!partial || body.course_visits !== undefined) {
    const n = Number(body.course_visits ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 20) return 'Курс: від 0 до 20 повторних візитів (0 — без курсу)';
    out.course_visits = n;
  }
  if (!partial || body.course_interval_days !== undefined) {
    const d = Number(body.course_interval_days ?? 0);
    if (!Number.isInteger(d) || d < 0 || d > 180) return 'Курс: інтервал від 0 до 180 днів';
    out.course_interval_days = d;
  }
  if (!partial || body.course_next_service_id !== undefined) {
    const v = body.course_next_service_id;
    out.course_next_service_id = v === null || v === '' || v === undefined || Number(v) === 0 ? null : Number(v);
    if (out.course_next_service_id !== null && !Number.isInteger(out.course_next_service_id)) return 'Курс: некоректна послуга для повторних візитів';
  }
  if (out.course_visits > 0 && out.course_interval_days === 0) return 'Курс: вкажіть, через скільки днів повторні візити';
  return null;
}

const addDaysStr = (d, n) => {
  const t = new Date(d + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);

function setupCourse({ app, db, telegram, todayStr, siteUrl, last9, canSeeClient }) {
  // План усіх курсів клієнта. masterId — лише курси, які починались у цього майстра
  function plansFor(key, masterId = null) {
    const today = todayStr();
    const appts = db.prepare(`SELECT a.id, a.date, a.start_time, a.status, a.service_id, a.master_id, a.client_name, a.client_phone, COALESCE(a.services_label, s.name) AS service
                              FROM appointments a JOIN services s ON s.id = a.service_id ORDER BY a.date, a.start_time`).all()
      .filter((a) => last9(a.client_phone) === key);
    const services = new Map(db.prepare('SELECT id, name, course_visits, course_interval_days, course_next_service_id FROM services').all().map((s) => [s.id, s]));
    const starts = appts.filter((a) => {
      const s = services.get(a.service_id);
      return s && s.course_visits > 0 && s.course_interval_days > 0
        && !['cancelled', 'no_show'].includes(a.status)
        && daysBetween(a.date, today) <= PLAN_LOOKBACK_DAYS
        && (!masterId || a.master_id === masterId);
    });
    const used = new Set(starts.map((a) => a.id));
    return starts.map((start) => {
      const svc = services.get(start.service_id);
      const nextId = svc.course_next_service_id || svc.id;
      const nextName = services.get(nextId)?.name || svc.name;
      const tol = Math.max(2, Math.floor(svc.course_interval_days / 2));
      const steps = [];
      for (let k = 1; k <= svc.course_visits; k++) {
        const planned = addDaysStr(start.date, k * svc.course_interval_days);
        const match = appts.find((a) => !used.has(a.id) && a.service_id === nextId && a.status !== 'cancelled'
          && Math.abs(daysBetween(planned, a.date)) <= tol && a.date > start.date);
        let state;
        if (match) {
          used.add(match.id);
          state = match.status === 'no_show' ? 'missed' : match.date < today || match.status === 'done' ? 'done' : 'booked';
        } else {
          state = daysBetween(today, planned) < -tol ? 'missed' : 'todo';
        }
        steps.push({ step: k, planned, state, appt: match ? { id: match.id, date: match.date, time: match.start_time } : null });
      }
      return {
        start: { id: start.id, date: start.date, service: start.service, master_id: start.master_id },
        next_service_id: nextId, next_service: nextName, interval_days: svc.course_interval_days,
        client: { name: start.client_name, phone: start.client_phone }, steps,
      };
    });
  }

  app.get('/api/admin/clients/:key/course', (req, res) => {
    const key = req.params.key;
    if (!/^\d{9}$/.test(key)) return res.status(400).json({ error: 'Некоректний клієнт' });
    if (!canSeeClient(req, key)) return res.status(403).json({ error: 'Це клієнт іншого майстра' });
    res.json(plansFor(key, req.role === 'master' ? req.masterId : null));
  });

  // Нагадування клієнтам: за REMIND_DAYS днів до кроку, якщо на нього ще немає запису
  const chatFor = (a) => a.tg_chat_id
    || db.prepare('SELECT tg_chat_id FROM accounts WHERE phone_key = ?').get(last9(a.client_phone))?.tg_chat_id
    || null;
  async function sendCourseReminders() {
    const hour = new Date().getHours();
    if (hour < SEND_FROM_HOUR || hour >= SEND_TO_HOUR) return;
    const base = siteUrl();
    if (!base) return;
    const today = todayStr();
    const keys = new Set(db.prepare(`SELECT DISTINCT a.client_phone FROM appointments a JOIN services s ON s.id = a.service_id
      WHERE s.course_visits > 0 AND a.status NOT IN ('cancelled', 'no_show') AND a.date >= date(?, '-${PLAN_LOOKBACK_DAYS} day')`).all(today).map((r) => last9(r.client_phone)));
    const sent = db.prepare('SELECT 1 FROM course_reminders WHERE start_appt_id = ? AND step = ?');
    const mark = db.prepare('INSERT OR IGNORE INTO course_reminders (start_appt_id, step) VALUES (?, ?)');
    for (const key of keys) {
      for (const plan of plansFor(key)) {
        const step = plan.steps.find((s) => s.state === 'todo' && daysBetween(today, s.planned) >= 0 && daysBetween(today, s.planned) <= REMIND_DAYS);
        if (!step || sent.get(plan.start.id, step.step)) continue;
        const startAppt = db.prepare('SELECT tg_chat_id, client_phone, client_name FROM appointments WHERE id = ?').get(plan.start.id);
        const chat = chatFor(startAppt);
        mark.run(plan.start.id, step.step); // позначаємо навіть без Telegram: двічі не перевіряємо
        if (!chat) continue;
        const name = String(startAppt.client_name).trim().split(/\s+/)[0];
        await telegram.sendToClient(chat,
          `Вітаємо, ${name}! За планом курсу «${plan.start.service}» наступний візит (${plan.next_service}) — ` +
          `приблизно ${step.planned.split('-').reverse().join('.')}.\nОберіть зручний час: ${base.replace(/\/+$/, '')}/#booking`);
      }
    }
  }
  setInterval(() => sendCourseReminders().catch((e) => console.error('Курс лікування:', e.message)), 60 * 60 * 1000).unref();

  return { plansFor, sendCourseReminders };
}

module.exports = { createCourseColumns, validateCourse, setupCourse };
