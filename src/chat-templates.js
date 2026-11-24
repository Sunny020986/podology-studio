// Швидкі відповіді в чаті: збережені тексти, які оператор вставляє в поле відповіді й може змінити перед надсиланням.
// Підстановки беруться з налаштувань кабінету: {назва}, {адреса}, {телефон}, {сайт}.
// Стартові шаблони додаються один раз (позначка chat_templates_seeded): якщо їх видалити, вони не повертаються.
// Чат — лише для суперадміна, тож маршрутів немає в MASTER_ROUTES.

const SEED = [
  ['Вітання', 'Вітаю! Чим можу допомогти?'],
  ['Адреса й телефон', 'Наша адреса: {адреса}. Телефон: {телефон}.'],
  ['Як записатися', 'Записатися можна на сайті в розділі «Запис» — там видно вільний час. Або напишіть зручний день і час, і я запишу вас.'],
];

function setupChatTemplates({ app, db, readStudio }) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'chat_templates_seeded'").get()) {
    db.transaction(() => {
      const ins = db.prepare('INSERT INTO chat_templates (title, body) VALUES (?, ?)');
      for (const [t, b] of SEED) ins.run(t, b);
      db.prepare("INSERT INTO settings (key, value) VALUES ('chat_templates_seeded', '1')").run();
    })();
  }

  // Текст із підставленими даними кабінету; незаповнене поле — помітна позначка, щоб оператор не надіслав порожнє
  function render(body) {
    const s = readStudio();
    const map = {
      'назва': s.name, 'адреса': [s.city, s.address].filter(Boolean).join(', '),
      'телефон': s.phone, 'сайт': s.site_url,
    };
    return body.replace(/\{(назва|адреса|телефон|сайт)\}/g, (_, k) => map[k] || `[${k} не вказано в налаштуваннях]`);
  }
  const validate = (b) => {
    const title = String(b?.title ?? '').trim();
    const body = String(b?.body ?? '').trim();
    if (!title || title.length > 40) return { error: 'Назва шаблону: від 1 до 40 символів' };
    if (!body || body.length > 1000) return { error: 'Текст шаблону: від 1 до 1000 символів' };
    return { data: { title, body } };
  };

  app.get('/api/admin/chat-templates', (req, res) => {
    res.json(db.prepare('SELECT id, title, body FROM chat_templates ORDER BY id').all().map((t) => ({ ...t, text: render(t.body) })));
  });
  app.post('/api/admin/chat-templates', (req, res) => {
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    if (db.prepare('SELECT COUNT(*) AS n FROM chat_templates').get().n >= 50) return res.status(400).json({ error: 'Не більше 50 шаблонів' });
    const id = Number(db.prepare('INSERT INTO chat_templates (title, body) VALUES (?, ?)').run(v.data.title, v.data.body).lastInsertRowid);
    res.status(201).json({ id });
  });
  app.put('/api/admin/chat-templates/:id', (req, res) => {
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const n = db.prepare('UPDATE chat_templates SET title = ?, body = ? WHERE id = ?').run(v.data.title, v.data.body, Number(req.params.id)).changes;
    if (!n) return res.status(404).json({ error: 'Шаблон не знайдено' });
    res.json({ ok: true });
  });
  app.delete('/api/admin/chat-templates/:id', (req, res) => {
    db.prepare('DELETE FROM chat_templates WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });
}

module.exports = { setupChatTemplates };
