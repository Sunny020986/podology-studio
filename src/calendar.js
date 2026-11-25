// Календар майстра в телефоні: секретне посилання на файл .ics, на яке підписується
// календар Google чи iPhone. Календар сам періодично перечитує його й бачить нові записи.
//
// - Посилання містить випадковий ключ; у базі зберігається лише його відбиток (sha256),
//   тому саме посилання показується один раз — при створенні. Нове посилання скасовує старе.
// - У подію йде лише послуга й ім'я клієнта, без телефону: календарі Google і Apple
//   зберігають події на своїх серверах.
// - Google Calendar перечитує посилання зі свого сервера, тому потрібна публічна адреса сайту.
//   iPhone у тій самій мережі бачить і локальну адресу.
const crypto = require('crypto');

const PAST_DAYS = 30;     // скільки днів назад показувати
const FUTURE_DAYS = 120;  // і скільки вперед
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Місцевий час Києва → UTC (з урахуванням переходу на літній час)
function kyivToUtc(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const wall = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  };
  let utc = guess - (wall(guess) - guess);
  utc = guess - (wall(utc) - utc);
  return new Date(utc);
}
const icsTime = (dt) => dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Рядки довші за 75 байтів переносяться (вимога формату)
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

const STATUS_NOTE = { new: 'нова, ще не підтверджена', confirmed: 'підтверджено', done: 'відбувся', no_show: 'клієнт не прийшов' };

function setupCalendar({ app, db, todayStr, addDays }) {
  const cols = db.prepare('PRAGMA table_info(masters)').all().map((c) => c.name);
  if (!cols.includes('cal_token_hash')) db.exec('ALTER TABLE masters ADD COLUMN cal_token_hash TEXT');

  // Адреса з налаштувань «Кабінет → Адреса сайту»; якщо не задана — та, з якої відкрита адмінка
  const linkFor = (req, token) => {
    const configured = db.prepare("SELECT value FROM settings WHERE key = 'site_url'").get()?.value || '';
    const base = (configured || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const url = `${base}/cal/${token}.ics`;
    return { url, webcal: url.replace(/^https?:/, 'webcal:'), public: /^https:\/\//.test(configured) };
  };
  const issue = (req, masterId) => {
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('UPDATE masters SET cal_token_hash = ? WHERE id = ?').run(sha(token), masterId);
    return linkFor(req, token);
  };
  const disable = (masterId) => db.prepare('UPDATE masters SET cal_token_hash = NULL WHERE id = ?').run(masterId);
  const enabled = (masterId) => !!db.prepare('SELECT cal_token_hash FROM masters WHERE id = ?').get(masterId)?.cal_token_hash;

  // Сам календар — без входу, за секретним ключем у посиланні
  app.get('/cal/:token.ics', (req, res) => {
    const token = String(req.params.token || '');
    const m = token.length >= 20 && db.prepare("SELECT id, name FROM masters WHERE cal_token_hash = ? AND status = 'active'").get(sha(token));
    if (!m) return res.status(404).type('text/plain').send('Календар не знайдено');
    const today = todayStr();
    const rows = db.prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.status, a.client_name, a.updated_at, COALESCE(a.services_label, s.name) AS service
      FROM appointments a JOIN services s ON s.id = a.service_id
      WHERE a.master_id = ? AND a.status != 'cancelled' AND a.date BETWEEN ? AND ? ORDER BY a.date, a.start_time`)
      .all(m.id, addDays(today, -PAST_DAYS), addDays(today, FUTURE_DAYS));
    const studio = db.prepare("SELECT value FROM settings WHERE key = 'name'").get()?.value || 'Подологічний кабінет';
    const now = icsTime(new Date());
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//podology-studio//calendar//UK', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsText(studio + ' · ' + m.name)}`, 'X-WR-TIMEZONE:Europe/Kyiv', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    ];
    for (const a of rows) {
      const first = String(a.client_name).trim().split(/\s+/)[0];
      lines.push(
        'BEGIN:VEVENT',
        `UID:appt-${a.id}@podology-studio`,
        `DTSTAMP:${now}`,
        `DTSTART:${icsTime(kyivToUtc(a.date, a.start_time))}`,
        `DTEND:${icsTime(kyivToUtc(a.date, a.end_time))}`,
        `SUMMARY:${icsText((a.status === 'no_show' ? '[не прийшов] ' : '') + a.service + ' · ' + first)}`,
        `DESCRIPTION:${icsText('Статус: ' + (STATUS_NOTE[a.status] || a.status) + '. Телефон і деталі — в адмінці.')}`,
        `STATUS:${a.status === 'new' ? 'TENTATIVE' : 'CONFIRMED'}`,
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');
    res.set('Cache-Control', 'no-cache, private');
    res.type('text/calendar; charset=utf-8').send(lines.map(fold).join('\r\n') + '\r\n');
  });

  // Майстер — своє посилання
  app.get('/api/admin/me/calendar', (req, res) => {
    if (req.role !== 'master') return res.status(400).json({ error: 'Це налаштування для майстра' });
    res.json({ enabled: enabled(req.masterId) });
  });
  app.post('/api/admin/me/calendar', (req, res) => {
    if (req.role !== 'master') return res.status(400).json({ error: 'Це налаштування для майстра' });
    res.json({ enabled: true, ...issue(req, req.masterId) });
  });
  app.delete('/api/admin/me/calendar', (req, res) => {
    if (req.role !== 'master') return res.status(400).json({ error: 'Це налаштування для майстра' });
    disable(req.masterId);
    res.json({ enabled: false });
  });

  // Суперадмін — посилання для будь-якого майстра (маршрути лише для суперадміна)
  app.get('/api/admin/masters/:id/calendar', (req, res) => res.json({ enabled: enabled(Number(req.params.id)) }));
  app.post('/api/admin/masters/:id/calendar', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare("SELECT 1 FROM masters WHERE id = ? AND status != 'deleted'").get(id)) return res.status(404).json({ error: 'Майстра не знайдено' });
    res.json({ enabled: true, ...issue(req, id) });
  });
  app.delete('/api/admin/masters/:id/calendar', (req, res) => {
    disable(Number(req.params.id));
    res.json({ enabled: false });
  });
}

module.exports = { setupCalendar, kyivToUtc };
