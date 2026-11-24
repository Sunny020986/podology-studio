// Свята й вихідні всього кабінету: у такий день не працює жоден майстер (і ті, кого додадуть пізніше).
// Перевірка вбудована у workHours (src/slots.js), тому свято враховують запис клієнтів, перенесення,
// «Майстер не вийде» і календар адмінки. Наявні записи на цей день не скасовуються автоматично:
// адмінка показує, скільки їх у кожного майстра, і пропонує опрацювати через «Майстер не вийде».
// Розділ лише для суперадміна (маршрутів немає в MASTER_ROUTES).

function createHolidayTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_holidays (
    date       TEXT PRIMARY KEY,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function setupHolidays({ app, db, todayStr, isValidDate, addDays }) {
  // Активні записи на дату по майстрах
  const affected = (date) => db.prepare(`SELECT a.master_id, m.name AS master, COUNT(*) AS count
    FROM appointments a LEFT JOIN masters m ON m.id = a.master_id
    WHERE a.date = ? AND a.status IN ('new', 'confirmed') GROUP BY a.master_id ORDER BY m.name`).all(date);

  app.get('/api/admin/holidays', (req, res) => {
    const rows = db.prepare('SELECT date, note FROM studio_holidays WHERE date >= ? ORDER BY date').all(todayStr());
    res.json(rows.map((h) => ({ ...h, affected: affected(h.date) })));
  });

  app.post('/api/admin/holidays', (req, res) => {
    const date = String(req.body?.date || '');
    const note = String(req.body?.note ?? '').trim().slice(0, 80);
    if (!isValidDate(date) || date < todayStr()) return res.status(400).json({ error: 'Оберіть дату від сьогодні' });
    if (date > addDays(todayStr(), 730)) return res.status(400).json({ error: 'Не далі ніж на 2 роки вперед' });
    db.prepare('INSERT INTO studio_holidays (date, note) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET note = excluded.note').run(date, note);
    res.status(201).json({ date, note, affected: affected(date) });
  });

  app.delete('/api/admin/holidays/:date', (req, res) => {
    const n = db.prepare('DELETE FROM studio_holidays WHERE date = ?').run(String(req.params.date)).changes;
    if (!n) return res.status(404).json({ error: 'Такого свята немає' });
    res.json({ ok: true });
  });
}

module.exports = { createHolidayTable, setupHolidays };
