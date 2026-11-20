// SEO: службова розмітка для Google (LocalBusiness), robots.txt і sitemap.xml.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']; // weekday 0 = Понеділок

// Розмітка schema.org про кабінет: назва, адреса, телефон, години роботи, послуги. Відвідувачі її не бачать.
function localBusinessJsonLd(db, s, base) {
  const hours = db.prepare('SELECT weekday, start_time, end_time FROM work_hours WHERE start_time IS NOT NULL ORDER BY weekday').all();
  const services = db.prepare('SELECT name, price_uah FROM services WHERE active = 1 ORDER BY id').all();
  const data = {
    '@context': 'https://schema.org',
    '@type': 'MedicalBusiness',
    medicalSpecialty: 'Podiatric',
    name: s.name,
    description: s.tagline || undefined,
    url: base + '/',
    image: base + '/img/og.jpg',
    telephone: s.phone || undefined,
    address: s.address ? {
      '@type': 'PostalAddress', streetAddress: s.address, addressLocality: s.city || undefined, addressCountry: 'UA',
    } : undefined,
    openingHoursSpecification: hours.map((h) => ({
      '@type': 'OpeningHoursSpecification', dayOfWeek: DAYS[h.weekday], opens: h.start_time, closes: h.end_time,
    })),
    makesOffer: services.map((x) => ({
      '@type': 'Offer',
      itemOffered: { '@type': 'Service', name: x.name },
      ...(x.price_uah > 0 ? { price: x.price_uah, priceCurrency: 'UAH' } : {}),
    })),
  };
  // Символ < не може з'явитися всередині <script>, тож його екрануємо
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

function setupSeo({ app, db, siteUrl }) {
  const baseOf = (req) => (siteUrl() || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
      'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /review.html\n' +
      `Sitemap: ${baseOf(req)}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', (req, res) => {
    const base = baseOf(req);
    const tips = db.prepare('SELECT slug, date(updated_at) AS d FROM tips WHERE published = 1 ORDER BY created_at DESC').all();
    const urls = [`  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
      ...tips.map((t) => `  <url><loc>${base}/tips/${t.slug}</loc><lastmod>${t.d}</lastmod><priority>0.7</priority></url>`)];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  });
}

module.exports = { localBusinessJsonLd, setupSeo };
