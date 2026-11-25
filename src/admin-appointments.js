// Робота з записами в адмінці: ручний запис (наприклад, клієнт подзвонив), перенесення,
// вільний час для адміна і дані для календаря дня й тижня.
// Майстер працює лише зі своїми записами; суперадмін — з усіма й може змінити майстра.
function setupAdminAppointments(ctx) {
  const {
    app, db, telegram, bookTx, masterFreeAt, nowMin, freeSlots, masterOffers, isValidDate, isTime,
    toMin, toHHMM, todayStr, addDays, masterParam, ownsAppt, notifyMasterOf, last9, live = () => {},
    clientChat = (a) => a.tg_chat_id,
  } = ctx;
  const ADMIN_HORIZON_DAYS = 365; // адмін може записати на рік уперед
  const fmt = (d) => d.split('-').reverse().join('.');
  const inRange = (date) => isValidDate(date) && date >= todayStr() && date <= addDays(todayStr(), ADMIN_HORIZON_DAYS);
  const masterName = (id) => db.prepare('SELECT name FROM masters WHERE id = ?').get(id)?.name || '';

  // Вільний час для форм адмінки; excludeId — запис, який переносимо (його власний час не зайнятий)
  app.get('/api/admin/slots', (req, res) => {
    const service = db.prepare('SELECT id, duration_min FROM services WHERE id = ?').get(Number(req.query.serviceId));
    const date = String(req.query.date || '');
    if (!service) return res.status(400).json({ error: 'Невідома послуга' });
    if (!inRange(date)) return res.status(400).json({ error: 'Некоректна дата' });
    const masterId = req.role === 'master' ? req.masterId : masterParam(req.query.masterId);
    const excludeId = Number(req.query.excludeId) || 0;
    // Перенесення: тривалість — самого запису (кілька послуг в одному візиті тривають довше за основну)
    const moving = excludeId ? db.prepare('SELECT start_time, end_time, service_id, extra_services FROM appointments WHERE id = ?').get(excludeId) : null;
    const duration = moving ? toMin(moving.end_time) - toMin(moving.start_time) : service.duration_min;
    let ids = [service.id];
    if (moving) { try { ids = [moving.service_id, ...JSON.parse(moving.extra_services || '[]')]; } catch { /* старий запис */ } }
    res.json({ date, slots: freeSlots(db, date, duration, { masterId, serviceId: ids, excludeId }) });
  });

  // Ручний запис: перевіряє вільний час, але не обмежує кількість записів на телефон
  app.post('/api/admin/appointments', (req, res) => {
    const b = req.body || {};
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(b.serviceId));
    if (!service) return res.status(400).json({ error: 'Оберіть послугу' });
    if (!inRange(b.date)) return res.status(400).json({ error: 'Оберіть дату від сьогодні' });
    if (!isTime(b.time)) return res.status(400).json({ error: 'Оберіть час' });
    const name = String(b.name ?? '').trim();
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "Вкажіть ім'я клієнта (від 2 до 60 символів)" });
    const phone = String(b.phone ?? '').trim();
    const digits = phone.replace(/\D/g, '');
    if (!/^\+?[\d\s()-]+$/.test(phone) || digits.length < 9 || digits.length > 15) return res.status(400).json({ error: 'Вкажіть коректний телефон' });
    const masterId = req.role === 'master' ? req.masterId : masterParam(b.masterId);
    if (masterId && !masterOffers(db, masterId, service.id)) return res.status(400).json({ error: 'Цей майстер не виконує обрану послугу або заблокований' });
    try {
      const r = bookTx({
        service, date: b.date, time: b.time, name, phone, comment: String(b.comment ?? '').trim().slice(0, 500),
        masterId, skipPhoneLimit: true, status: 'confirmed',
      });
      const mName = masterName(r.masterId);
      telegram.notifyMaster(`🗓 Запис додано в адмінці\n${service.name} · майстер: ${mName}\n${fmt(b.date)} о ${b.time}\n${name}, ${phone}`);
      if (req.role !== 'master') notifyMasterOf(r.masterId, `🗓 Новий запис до вас\n${service.name}\n${fmt(b.date)} о ${b.time}\n${name}, ${phone}`);
      live('changed', { id: Number(r.id), master_id: r.masterId, date: b.date, start_time: b.time, client_name: name, service: service.name, master: mName });
      res.status(201).json({ id: Number(r.id), master: mName });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // Перенесення: інший день, час або (для суперадміна) інший майстер.
  // Будь-який час із кроком 5 хв (у календарі запис перетягують із кроком 15 хв), не раніше ніж зараз:
  // персонал може посунути запис і за кілька хвилин до початку (клієнт запізнюється).
  const moveTx = db.transaction((a, date, time, masterId) => {
    if (!masterFreeAt(db, date, time, a.duration_min, masterId, a.id, 0)) {
      throw Object.assign(new Error('Цей час недоступний: зайнятий іншим записом, перерва, блокування або поза робочими годинами майстра'), { status: 409 });
    }
    db.prepare('UPDATE appointments SET date = ?, start_time = ?, end_time = ?, master_id = ?, reminded = 0, client_confirmed_at = NULL, client_declined_at = NULL WHERE id = ?')
      .run(date, time, toHHMM(toMin(time) + a.duration_min), masterId, a.id);
  });
  app.patch('/api/admin/appointments/:id/move', (req, res) => {
    const id = Number(req.params.id);
    // Тривалість — з самого запису (кілька послуг в одному візиті тривають довше за основну послугу)
    const a = db.prepare(`SELECT a.*, (CAST(substr(a.end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(a.end_time, 4, 2) AS INTEGER)) - (CAST(substr(a.start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(a.start_time, 4, 2) AS INTEGER)) AS duration_min, COALESCE(a.services_label, s.name) AS service FROM appointments a JOIN services s ON s.id = a.service_id WHERE a.id = ?`).get(id);
    if (!a) return res.status(404).json({ error: 'Запис не знайдено' });
    if (!ownsAppt(req, id)) return res.status(403).json({ error: 'Це запис іншого майстра' });
    if (a.status === 'cancelled') return res.status(400).json({ error: 'Запис скасовано. Спершу поверніть йому статус' });
    const { date, time } = req.body || {};
    if (!inRange(date)) return res.status(400).json({ error: 'Оберіть дату від сьогодні' });
    if (!isTime(time) || toMin(time) % 5) return res.status(400).json({ error: 'Оберіть час' });
    if (date === todayStr() && toMin(time) < nowMin()) return res.status(400).json({ error: 'Цей час уже минув' });
    const target = req.role === 'master' ? a.master_id : (masterParam(req.body?.masterId) || a.master_id);
    if (target !== a.master_id && !masterOffers(db, target, a.service_id)) {
      return res.status(400).json({ error: 'Цей майстер не виконує цю послугу або заблокований' });
    }
    try {
      moveTx(a, date, time, target);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    const newName = masterName(target);
    const text = `${a.service}\n${fmt(date)} о ${time}${target !== a.master_id ? '\nмайстер: ' + newName : ''}`;
    const chat = clientChat(a);
    if (chat) {
      telegram.sendToClient(chat, `🔁 Ваш запис перенесено: ${a.service}, ${fmt(date)} о ${time}` +
        (target !== a.master_id ? `, майстер ${newName}` : '') + '. Якщо час не підходить, напишіть нам.');
    }
    telegram.notifyMaster(`🔁 Запис перенесено в адмінці\n${text}\n${a.client_name}, ${a.client_phone}`);
    if (target !== a.master_id) {
      notifyMasterOf(a.master_id, `↪️ Запис передано іншому майстру\n${a.service}, ${fmt(a.date)} о ${a.start_time}\n${a.client_name}`);
      notifyMasterOf(target, `🗓 Вам передано запис\n${a.service}\n${fmt(date)} о ${time}\n${a.client_name}, ${a.client_phone}`);
    } else if (req.role !== 'master') {
      notifyMasterOf(target, `🔁 Ваш запис перенесено\n${a.service}\n${fmt(date)} о ${time}\n${a.client_name}, ${a.client_phone}`);
    }
    live('changed', { id, master_id: target, date, start_time: time, client_name: a.client_name, service: a.service, master: newName }, [a.master_id, target]);
    res.json({ ok: true, date, time, master: newName });
  });

  // Дані для календаря: майстри, їхні години, перерви, блокування і записи за період (до 14 днів)
  app.get('/api/admin/calendar', (req, res) => {
    const from = isValidDate(req.query.from) ? req.query.from : todayStr();
    let to = isValidDate(req.query.to) ? req.query.to : from;
    if (to < from) to = from;
    if (to > addDays(from, 13)) to = addDays(from, 13);
    const only = req.role === 'master' ? req.masterId : masterParam(req.query.masterId);
    const masters = db.prepare("SELECT id, name, status FROM masters WHERE status != 'deleted' ORDER BY id").all()
      .filter((m) => (only ? m.id === only : m.status === 'active'));
    const ids = masters.map((m) => m.id);
    if (!ids.length) return res.json({ from, to, masters: [], hours: [], breaks: [], blocks: [], holidays: [], appointments: [] });
    const inList = `(${ids.map(() => '?').join(',')})`;
    res.json({
      from, to, masters,
      hours: db.prepare(`SELECT master_id, weekday, start_time, end_time FROM master_hours WHERE master_id IN ${inList}`).all(...ids),
      breaks: db.prepare(`SELECT master_id, weekday, start_time, end_time, note FROM breaks WHERE master_id IN ${inList}`).all(...ids),
      blocks: db.prepare(`SELECT master_id, date, start_time, end_time, note FROM blocks WHERE master_id IN ${inList} AND date BETWEEN ? AND ?`).all(...ids, from, to),
      holidays: db.prepare('SELECT date, note FROM studio_holidays WHERE date BETWEEN ? AND ?').all(from, to),
      appointments: db.prepare(`SELECT a.id, a.master_id, a.date, a.start_time, a.end_time, a.status, a.client_name, a.client_phone, a.client_comment, a.service_id,
          a.client_confirmed_at, a.client_declined_at, COALESCE(a.services_label, s.name) AS service
        FROM appointments a JOIN services s ON s.id = a.service_id
        WHERE a.master_id IN ${inList} AND a.date BETWEEN ? AND ? AND a.status != 'cancelled' ORDER BY a.date, a.start_time`).all(...ids, from, to),
    });
  });
}

module.exports = { setupAdminAppointments };
