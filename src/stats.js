// Статистика для адмінки за обраний місяць.
function setupStats({ app, db, toMin, weekdayOf, last9 }) {
  const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));
  const pad = (n) => String(n).padStart(2, '0');

  // Скільки хвилин за день доступно для запису в одного майстра: робочі години мінус перерви й блокування
  function availableMinutes(date, masterId) {
    if (db.prepare('SELECT 1 FROM studio_holidays WHERE date = ?').get(date)) return 0; // свято кабінету
    const wd = weekdayOf(date);
    const h = db.prepare('SELECT start_time, end_time FROM master_hours WHERE master_id = ? AND weekday = ?').get(masterId, wd);
    if (!h || !h.start_time) return 0;
    const s = toMin(h.start_time), e = toMin(h.end_time);
    const busy = [
      ...db.prepare('SELECT start_time, end_time FROM breaks WHERE master_id = ? AND weekday = ?').all(masterId, wd),
      ...db.prepare('SELECT start_time, end_time FROM blocks WHERE master_id = ? AND date = ?').all(masterId, date),
    ].map((b) => [Math.max(s, toMin(b.start_time)), Math.min(e, toMin(b.end_time))]).filter(([a, z]) => z > a)
      .sort((x, y) => x[0] - y[0]);
    let taken = 0, cursor = s; // перетини перерв і блокувань не рахуємо двічі
    for (const [a, z] of busy) {
      const from = Math.max(a, cursor);
      if (z > from) { taken += z - from; cursor = z; }
    }
    return Math.max(0, e - s - taken);
  }

  app.get('/api/admin/stats', (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const from = `${month}-01`, to = `${month}-${pad(days)}`;
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })();

    // masterId: статистика одного майстра; без нього — по всьому кабінету
    const masterId = Number(req.query.masterId) > 0 ? Number(req.query.masterId) : null;
    const appts = db.prepare(`SELECT a.date, a.start_time, a.end_time, a.status, a.client_phone, a.master_id, COALESCE(a.services_label, s.name) AS service, COALESCE(a.price_uah, s.price_uah) AS price_uah
      FROM appointments a JOIN services s ON s.id = a.service_id WHERE a.date BETWEEN ? AND ?`).all(from, to)
      .filter((a) => !masterId || a.master_id === masterId);
    const active = appts.filter((a) => a.status !== 'cancelled');
    const noShows = active.filter((a) => a.status === 'no_show');
    const done = active.filter((a) => a.date < today && a.status !== 'no_show');

    // Нові клієнти: перший запис за всю історію припадає на цей місяць
    const firstSeen = new Map();
    const firstRows = masterId
      ? db.prepare('SELECT client_phone, MIN(date) AS first FROM appointments WHERE master_id = ? GROUP BY client_phone').all(masterId)
      : db.prepare('SELECT client_phone, MIN(date) AS first FROM appointments GROUP BY client_phone').all();
    for (const r of firstRows) {
      const k = last9(r.client_phone);
      if (!firstSeen.has(k) || r.first < firstSeen.get(k)) firstSeen.set(k, r.first);
    }
    const newClients = [...firstSeen.values()].filter((d) => d >= from && d <= to).length;
    const uniqueClients = new Set(active.map((a) => last9(a.client_phone))).size;

    const byService = new Map();
    for (const a of active) byService.set(a.service, (byService.get(a.service) || 0) + 1);
    const topServices = [...byService.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

    const masterIds = masterId ? [masterId] : db.prepare("SELECT id FROM masters WHERE status = 'active'").all().map((r) => r.id);
    let available = 0;
    for (let d = 1; d <= days; d++) for (const id of masterIds) available += availableMinutes(`${month}-${pad(d)}`, id);
    const booked = active.reduce((sum, a) => sum + (toMin(a.end_time) - toMin(a.start_time)), 0);

    const priced = done.filter((a) => a.price_uah > 0);
    const review = db.prepare(`SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE date(created_at) BETWEEN ? AND ?`).get(from, to);

    res.json({
      month,
      total: appts.length,
      active: active.length,
      done: done.length,
      cancelled: appts.length - active.length,
      noShows: noShows.length,
      noShowPercent: done.length + noShows.length ? Math.round((noShows.length / (done.length + noShows.length)) * 100) : 0,
      newClients,
      uniqueClients,
      topServices,
      loadPercent: available ? Math.round((booked / available) * 100) : 0,
      bookedHours: Math.round(booked / 6) / 10,
      availableHours: Math.round(available / 6) / 10,
      revenue: priced.reduce((s, a) => s + a.price_uah, 0),
      revenueCount: priced.length,
      reviews: review.n,
      avgRating: review.avg ? Math.round(review.avg * 10) / 10 : null,
      waitlist: db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE date BETWEEN ? AND ?").get(from, to).n,
    });
  });
}

module.exports = { setupStats };
