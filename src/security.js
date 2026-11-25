// Заголовки безпеки й адреса перевірки «чи сайт живий».
const fs = require('fs');
const path = require('path');

// Хеш поточного коміту — щоб після оновлення бачити, яка версія працює
function readVersion(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    const ref = head.slice(5);
    const loose = path.join(root, '.git', ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim().slice(0, 7);
    const packed = fs.readFileSync(path.join(root, '.git', 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(' ' + ref));
    return line ? line.slice(0, 7) : 'невідомо';
  } catch {
    return 'невідомо';
  }
}

// Хост для WebSocket чату. Береться лише безпечний набір символів, щоб не зламати заголовок.
const safeHost = (h) => (/^[a-z0-9.\-:[\]]+$/i.test(h || '') ? h : '');

function securityHeaders(req, res, next) {
  const host = safeHost(req.headers.host);
  const ws = host ? ` ws://${host} wss://${host}` : '';
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    // inline-стилі потрібні: адмінка й сайт задають style="" у розмітці
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // blob: — попередній перегляд фото майстра і файл CSV
    "img-src 'self' data: blob:",
    // відео від клієнта: перегляд у кабінеті й адмінці, попередній перегляд вибраного файлу (blob:)
    "media-src 'self' blob:",
    // карта Google на сайті
    'frame-src https://www.google.com https://maps.google.com',
    `connect-src 'self'${ws}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // HSTS має сенс лише за HTTPS (за Caddy з TRUST_PROXY=1)
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

// GET /healthz — 200, якщо сервер відповідає і база читається; 503, якщо база недоступна.
function setupHealth({ app, db, root }) {
  const version = readVersion(root);
  const started = Date.now();
  app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true, version, uptimeSec: Math.round((Date.now() - started) / 1000) });
    } catch {
      res.status(503).json({ ok: false, version, error: 'база недоступна' });
    }
  });
}

module.exports = { securityHeaders, setupHealth };
