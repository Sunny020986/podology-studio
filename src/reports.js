// Звіт по майстрах за місяць і вивантаження в CSV (для розрахунку з майстрами). Лише для суперадміна.
// Візит — запис зі статусом «Відбувся» або минулий запис, який ще не позначили (так само рахує «Статистика»).
// Сума — за ціною на момент запису (колонка appointments.price_uah, заповнюється з цієї версії);
// для старіших записів, де її немає, береться поточна ціна послуги — звіт показує, скільки таких.
const { sendCsv } = require('./csv');

function createReportColumns(db) {
  const cols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  if (!cols.includes('price_uah')) db.exec('ALTER TABLE appointments ADD COLUMN price_uah INTEGER');
}

const STATUS_UA = { new: 'Нова', confirmed: 'Підтверджено', done: 'Відбувся', no_show: 'Не прийшов', cancelled: 'Скасовано' };

function setupReports({ app, db, todayStr, hasStarted }) {
  const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
  const range = (month) => {
    const [y, m] = month.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${month}-01`, `${month}-${String(days).padStart(2, '0')}`];
  };
  const rowsOf = (month, masterId = null) => {
    const [from, to] = range(month);
    return db.prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.status, a.client_name, a.client_phone, a.master_id,
        m.name AS master, COALESCE(a.services_label, s.name) AS service, COALESCE(a.price_uah, s.price_uah) AS price, a.price_uah IS NULL AS price_now
      FROM appointments a JOIN services s ON s.id = a.service_id LEFT JOIN masters m ON m.id = a.master_id
      WHERE a.date BETWEEN ? AND ? AND (? IS NULL OR a.master_id = ?) ORDER BY a.date, a.start_time`).all(from, to, masterId, masterId);
  };
  const isVisit = (a) => a.status === 'done' || (['new', 'confirmed'].includes(a.status) && a.date < todayStr());
  const unmarked = (a) => ['new', 'confirmed'].includes(a.status) && hasStarted(a);

  function report(month) {
    const by = new Map();
    for (const a of rowsOf(month)) {
      const k = a.master_id || 0;
      if (!by.has(k)) by.set(k, { master_id: a.master_id, master: a.master || 'Без майстра', visits: 0, revenue: 0, priced: 0, price_now: 0, no_shows: 0, cancelled: 0, unmarked: 0 });
      const r = by.get(k);
      if (isVisit(a)) {
        r.visits++;
        if (a.price > 0) { r.revenue += a.price; r.priced++; if (a.price_now) r.price_now++; }
      }
      if (a.status === 'no_show') r.no_shows++;
      if (a.status === 'cancelled') r.cancelled++;
      if (unmarked(a)) r.unmarked++;
    }
    const rows = [...by.values()].map((r) => ({ ...r, avg: r.priced ? Math.round(r.revenue / r.priced) : 0 }))
      .sort((x, y) => y.revenue - x.revenue || x.master.localeCompare(y.master, 'uk'));
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    const total = { visits: sum('visits'), revenue: sum('revenue'), priced: sum('priced'), price_now: sum('price_now'), no_shows: sum('no_shows'), cancelled: sum('cancelled'), unmarked: sum('unmarked') };
    total.avg = total.priced ? Math.round(total.revenue / total.priced) : 0;
    return { month, rows, total };
  }

  app.get('/api/admin/reports/masters', (req, res) => {
    const month = String(req.query.month || '');
    if (!isMonth(month)) return res.status(400).json({ error: 'Оберіть місяць' });
    res.json(report(month));
  });

  app.get('/api/admin/reports/masters.csv', (req, res) => {
    const month = String(req.query.month || '');
    if (!isMonth(month)) return res.status(400).json({ error: 'Оберіть місяць' });
    const r = report(month);
    const lines = [['Майстер', 'Візитів', 'Сума, грн', 'Середній чек, грн', 'Не прийшли', 'Скасовано', 'Не позначено']];
    for (const x of r.rows) lines.push([x.master, x.visits, x.revenue, x.avg, x.no_shows, x.cancelled, x.unmarked]);
    lines.push(['Усього', r.total.visits, r.total.revenue, r.total.avg, r.total.no_shows, r.total.cancelled, r.total.unmarked]);
    if (r.total.price_now) lines.push([`За поточною ціною послуги пораховано візитів: ${r.total.price_now} (записи до запам'ятовування ціни)`]);
    sendCsv(res, `masters-${month}.csv`, lines);
  });

  app.get('/api/admin/reports/appointments.csv', (req, res) => {
    const month = String(req.query.month || '');
    if (!isMonth(month)) return res.status(400).json({ error: 'Оберіть місяць' });
    const mid = Number(req.query.masterId) > 0 ? Number(req.query.masterId) : null;
    const lines = [['Дата', 'Час', 'Майстер', 'Послуга', 'Клієнт', 'Телефон', 'Статус', 'Ціна, грн']];
    for (const a of rowsOf(month, mid)) {
      lines.push([a.date.split('-').reverse().join('.'), `${a.start_time}–${a.end_time}`, a.master || '', a.service, a.client_name, a.client_phone, STATUS_UA[a.status] || a.status, a.price]);
    }
    sendCsv(res, `appointments-${month}.csv`, lines);
  });
}

module.exports = { createReportColumns, setupReports };
