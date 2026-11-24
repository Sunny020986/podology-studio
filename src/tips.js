// Поради з догляду за стопами: статті, які майстер пише в адмінці.
// Кожна опублікована порада має окрему сторінку /tips/<адреса>, яку бачать пошукові системи.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', "'": '', 'ʼ': '', '’': '',
};
function slugify(title) {
  const s = String(title).toLowerCase().split('').map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  return s || 'porada';
}

// Чернетки для старту: загальні правила догляду. Неопубліковані, майстер перевіряє і публікує сам.
const DRAFTS = [
  ['Як правильно підстригати нігті на ногах',
    'Проста звичка, яка допомагає уникнути врослого нігтя.',
    'Нігті на ногах підстригайте прямо, не заокруглюючи кути. Саме заокруглені кути найчастіше починають вростати в шкіру.\n\n' +
    'Не підстригайте занадто коротко: край нігтя має бути на рівні кінчика пальця.\n\n' +
    'Якщо ніготь уже почервонів, болить або під ним з\'явився набряк, не намагайтеся вирізати його самостійно. Запишіться до подолога.'],
  ['Щоденний догляд за стопами',
    'Кілька хвилин на день, щоб шкіра стоп залишалась здоровою.',
    'Після душу ретельно витирайте стопи, особливо між пальцями: волога там сприяє грибковим інфекціям.\n\n' +
    'Користуйтеся зволожувальним кремом для п\'ят, але не наносьте його між пальцями.\n\n' +
    'Носіть шкарпетки з натуральних тканин і щодня їх міняйте.'],
  ['Коли варто звернутися до подолога',
    'Ознаки, з якими краще не зволікати.',
    'Зверніться до подолога, якщо ніготь вростає, потовщується або змінює колір, якщо з\'явились болючі мозолі чи тріщини на п\'ятах, які не загоюються.\n\n' +
    'Людям з цукровим діабетом варто регулярно оглядати стопи у фахівця, навіть якщо нічого не турбує: дрібні пошкодження можуть бути непомітними.\n\n' +
    'Якщо є ознаки запалення, висока температура чи сильний біль, спершу зверніться до лікаря.'],
];

function createTipsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tips (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT NOT NULL UNIQUE,
      title       TEXT NOT NULL,
      summary     TEXT NOT NULL DEFAULT '',
      body        TEXT NOT NULL DEFAULT '',
      published   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'tips_drafts_v1'").get()) {
    db.transaction(() => {
      const ins = db.prepare('INSERT OR IGNORE INTO tips (slug, title, summary, body, published) VALUES (?, ?, ?, ?, 0)');
      for (const [title, summary, body] of DRAFTS) ins.run(slugify(title), title, summary, body);
      db.prepare("INSERT INTO settings (key, value) VALUES ('tips_drafts_v1', '1')").run();
    })();
  }
}

function validateTip(body) {
  const title = String(body?.title ?? '').trim();
  const summary = String(body?.summary ?? '').trim();
  const text = String(body?.body ?? '').trim();
  if (title.length < 3 || title.length > 120) return { error: 'Заголовок: від 3 до 120 символів' };
  if (summary.length > 300) return { error: 'Короткий опис: до 300 символів' };
  if (text.length > 20000) return { error: 'Текст: до 20000 символів' };
  return { data: { title, summary, body: text, published: body?.published ? 1 : 0 } };
}

function setupTips({ app, db, siteUrl, readStudio }) {
  const uniqueSlug = (title, exceptId = 0) => {
    const base = slugify(title);
    let slug = base, n = 2;
    while (db.prepare('SELECT 1 FROM tips WHERE slug = ? AND id != ?').get(slug, exceptId)) slug = `${base}-${n++}`;
    return slug;
  };

  // ----- Сайт -----
  app.get('/api/tips', (req, res) => {
    res.json(db.prepare('SELECT slug, title, summary FROM tips WHERE published = 1 ORDER BY created_at DESC').all());
  });

  app.get('/tips/:slug', (req, res, next) => {
    const t = db.prepare('SELECT * FROM tips WHERE slug = ? AND published = 1').get(String(req.params.slug));
    if (!t) return next();
    const s = readStudio();
    const base = (siteUrl() || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const url = `${base}/tips/${t.slug}`;
    const paragraphs = t.body.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('\n');
    const ld = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Article', headline: t.title, description: t.summary,
      datePublished: t.created_at.replace(' ', 'T') + 'Z', dateModified: t.updated_at.replace(' ', 'T') + 'Z',
      mainEntityOfPage: url, publisher: { '@type': 'Organization', name: s.name },
    }).replace(/</g, '\\u003c');
    res.type('html').send(`<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)} | ${esc(s.name)}</title>
<meta name="description" content="${esc(t.summary || t.title)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(t.title)}">
<meta property="og:description" content="${esc(t.summary)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(base + '/img/og.jpg')}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/styles.css">
<script type="application/ld+json">${ld}</script>
</head>
<body>
<main class="tip-page">
  <a class="review-home" href="/#tips">← ${esc(s.name)}</a>
  <article class="card tip-article">
    <h1>${esc(t.title)}</h1>
    ${t.summary ? `<p class="tip-lead">${esc(t.summary)}</p>` : ''}
    ${paragraphs}
  </article>
  <div class="tip-cta"><a class="btn btn-primary" href="/#booking">Записатися до подолога</a></div>
</main>
</body>
</html>`);
  });

  // ----- Адмінка (маршрути реєструються після перевірки доступу адміна) -----
  app.get('/api/admin/tips', (req, res) => {
    res.json(db.prepare('SELECT id, slug, title, summary, body, published, date(updated_at) AS updated FROM tips ORDER BY created_at DESC').all());
  });
  app.post('/api/admin/tips', (req, res) => {
    const v = validateTip(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const info = db.prepare('INSERT INTO tips (slug, title, summary, body, published) VALUES (?, ?, ?, ?, ?)')
      .run(uniqueSlug(v.data.title), v.data.title, v.data.summary, v.data.body, v.data.published);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  app.put('/api/admin/tips/:id', (req, res) => {
    const id = Number(req.params.id);
    const v = validateTip(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const n = db.prepare(`UPDATE tips SET title = ?, summary = ?, body = ?, published = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(v.data.title, v.data.summary, v.data.body, v.data.published, id).changes;
    if (!n) return res.status(404).json({ error: 'Пораду не знайдено' });
    res.json({ ok: true });
  });
  app.delete('/api/admin/tips/:id', (req, res) => {
    db.prepare('DELETE FROM tips WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });
}

module.exports = { createTipsTable, setupTips, slugify };
