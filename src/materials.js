// Облік матеріалів: скоби, нитки, тампони тощо.
// - Залишок і мінімум для кожного матеріалу; усі зміни пишуться в історію рухів.
// - Для послуги задається витрата; при статусі запису «Відбувся» матеріали списуються,
//   при зміні статусу назад — списання повертається (рахується різниця, тож двічі не спише).
// - Коли залишок опускається до мінімуму, у Telegram кабінету йде попередження.
// Розділ лише для суперадміна (маршрутів немає в MASTER_ROUTES).

const round = (n) => Math.round(n * 1000) / 1000;
const num = (v) => Number(String(v ?? '').replace(',', '.'));

function setupMaterials({ app, db, notify }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS materials (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      unit       TEXT NOT NULL DEFAULT 'шт',
      qty        REAL NOT NULL DEFAULT 0,
      min_qty    REAL NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS service_materials (
      service_id  INTEGER NOT NULL,
      material_id INTEGER NOT NULL,
      amount      REAL NOT NULL,
      PRIMARY KEY (service_id, material_id)
    );
    CREATE TABLE IF NOT EXISTS material_moves (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL,
      delta       REAL NOT NULL,
      reason      TEXT NOT NULL,          -- visit (візит), restock (прихід), writeoff (списання), init (початковий залишок)
      appt_id     INTEGER,
      note        TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_material_moves_appt ON material_moves(appt_id);
  `);

  const getMat = db.prepare('SELECT * FROM materials WHERE id = ?');
  const addMove = db.prepare('INSERT INTO material_moves (material_id, delta, reason, appt_id, note) VALUES (?, ?, ?, ?, ?)');
  const setQty = db.prepare('UPDATE materials SET qty = ROUND(qty + ?, 3) WHERE id = ?');
  const warnLow = (before, m) => {
    if (m.min_qty > 0 && before > m.min_qty && m.qty <= m.min_qty) {
      setImmediate(() => notify(`⚠️ Закінчується матеріал: ${m.name} — лишилось ${round(m.qty)} ${m.unit} (мінімум ${round(m.min_qty)}).`));
    }
  };
  // Рух матеріалу з перевіркою межі мінімуму
  function move(materialId, delta, reason, apptId = null, note = '') {
    const before = getMat.get(materialId);
    if (!before || !delta) return;
    addMove.run(materialId, round(delta), reason, apptId, note);
    setQty.run(delta, materialId);
    warnLow(before.qty, getMat.get(materialId));
  }

  // Викликається в транзакції зміни статусу запису: доводить списання до потрібного
  function applyVisit(apptId, status) {
    const a = db.prepare('SELECT service_id FROM appointments WHERE id = ?').get(apptId);
    if (!a) return;
    const want = status === 'done'
      ? new Map(db.prepare('SELECT material_id, amount FROM service_materials WHERE service_id = ?').all(a.service_id).map((r) => [r.material_id, -r.amount]))
      : new Map();
    const have = new Map(db.prepare("SELECT material_id, SUM(delta) AS d FROM material_moves WHERE appt_id = ? AND reason = 'visit' GROUP BY material_id").all(apptId).map((r) => [r.material_id, r.d]));
    for (const id of new Set([...want.keys(), ...have.keys()])) {
      const diff = round((want.get(id) || 0) - (have.get(id) || 0));
      if (diff) move(id, diff, 'visit', apptId, status === 'done' ? 'візит відбувся' : 'статус візиту змінено, списання повернуто');
    }
  }

  const validate = (b, creating) => {
    const name = String(b?.name ?? '').trim();
    const unit = String(b?.unit ?? 'шт').trim() || 'шт';
    const min = num(b?.min_qty ?? 0);
    if (name.length < 2 || name.length > 80) return { error: 'Назва: від 2 до 80 символів' };
    if (unit.length > 12) return { error: 'Одиниця: до 12 символів' };
    if (!Number.isFinite(min) || min < 0 || min > 100000) return { error: 'Мінімум: число від 0' };
    const out = { name, unit, min_qty: round(min) };
    if (creating) {
      const qty = num(b?.qty ?? 0);
      if (!Number.isFinite(qty) || qty < 0 || qty > 100000) return { error: 'Залишок: число від 0' };
      out.qty = round(qty);
    }
    return { data: out };
  };

  app.get('/api/admin/materials', (req, res) => {
    const list = db.prepare('SELECT id, name, unit, qty, min_qty, active FROM materials ORDER BY active DESC, name').all()
      .map((m) => ({ ...m, low: m.active === 1 && m.min_qty > 0 && m.qty <= m.min_qty }));
    res.json(list);
  });
  app.post('/api/admin/materials', (req, res) => {
    const v = validate(req.body, true);
    if (v.error) return res.status(400).json({ error: v.error });
    const id = db.transaction(() => {
      const newId = Number(db.prepare('INSERT INTO materials (name, unit, qty, min_qty) VALUES (?, ?, 0, ?)').run(v.data.name, v.data.unit, v.data.min_qty).lastInsertRowid);
      if (v.data.qty) move(newId, v.data.qty, 'init', null, 'початковий залишок');
      return newId;
    })();
    res.status(201).json({ id });
  });
  app.put('/api/admin/materials/:id', (req, res) => {
    const v = validate(req.body, false);
    if (v.error) return res.status(400).json({ error: v.error });
    const active = req.body?.active === undefined ? 1 : (req.body.active ? 1 : 0);
    const n = db.prepare('UPDATE materials SET name = ?, unit = ?, min_qty = ?, active = ? WHERE id = ?')
      .run(v.data.name, v.data.unit, v.data.min_qty, active, Number(req.params.id)).changes;
    if (!n) return res.status(404).json({ error: 'Матеріал не знайдено' });
    res.json({ ok: true });
  });
  // Прихід (delta > 0) або ручне списання (delta < 0)
  app.post('/api/admin/materials/:id/move', (req, res) => {
    const id = Number(req.params.id);
    const delta = num(req.body?.delta);
    const note = String(req.body?.note ?? '').trim().slice(0, 200);
    if (!getMat.get(id)) return res.status(404).json({ error: 'Матеріал не знайдено' });
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100000) return res.status(400).json({ error: 'Вкажіть кількість (не 0)' });
    db.transaction(() => move(id, delta, delta > 0 ? 'restock' : 'writeoff', null, note))();
    res.json(getMat.get(id));
  });
  app.get('/api/admin/materials/moves', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(db.prepare(`SELECT mv.id, mv.delta, mv.reason, mv.note, mv.appt_id, mv.created_at, m.name, m.unit
      FROM material_moves mv JOIN materials m ON m.id = mv.material_id ORDER BY mv.id DESC LIMIT ?`).all(limit));
  });
  // Витрата матеріалів на послугу
  app.get('/api/admin/services/:id/materials', (req, res) => {
    const sid = Number(req.params.id);
    res.json(db.prepare(`SELECT m.id AS material_id, m.name, m.unit, COALESCE(sm.amount, 0) AS amount
      FROM materials m LEFT JOIN service_materials sm ON sm.material_id = m.id AND sm.service_id = ?
      WHERE m.active = 1 OR sm.amount IS NOT NULL ORDER BY m.name`).all(sid));
  });
  app.put('/api/admin/services/:id/materials', (req, res) => {
    const sid = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM services WHERE id = ?').get(sid)) return res.status(404).json({ error: 'Послугу не знайдено' });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'Немає списку матеріалів' });
    for (const it of items) {
      const amt = num(it.amount);
      if (!Number.isFinite(amt) || amt < 0 || amt > 1000) return res.status(400).json({ error: 'Витрата: число від 0 до 1000' });
      if (!getMat.get(Number(it.material_id))) return res.status(400).json({ error: 'Невідомий матеріал' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM service_materials WHERE service_id = ?').run(sid);
      const ins = db.prepare('INSERT INTO service_materials (service_id, material_id, amount) VALUES (?, ?, ?)');
      for (const it of items) if (num(it.amount) > 0) ins.run(sid, Number(it.material_id), round(num(it.amount)));
    })();
    res.json({ ok: true });
  });

  return { applyVisit };
}

module.exports = { setupMaterials };
