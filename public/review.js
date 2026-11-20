// Сторінка відгуку: код візиту приходить у посиланні від бота (?c=...)
(() => {
  const $ = (s) => document.querySelector(s);
  const code = new URLSearchParams(location.search).get('c') || '';
  const fmt = (d) => d.split('-').reverse().join('.');
  const thanks = (text) => {
    $('#reviewForm').hidden = true;
    $('#reviewTitle').textContent = 'Дякуємо!';
    $('#reviewSub').textContent = text;
  };

  fetch('/api/review/' + encodeURIComponent(code))
    .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
    .then(({ ok, data }) => {
      if (!ok) { $('#reviewSub').textContent = data.error || 'Посилання недійсне'; return; }
      if (data.done) return thanks('Ви вже залишили відгук про цей візит.');
      $('#reviewTitle').textContent = data.name + ', як пройшов візит?';
      $('#reviewSub').textContent = data.service + ', ' + fmt(data.date);
      $('#reviewForm').hidden = false;
    })
    .catch(() => { $('#reviewSub').textContent = 'Не вдалося завантажити. Спробуйте пізніше.'; });

  $('#reviewForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rating = Number(document.querySelector('input[name="rating"]:checked')?.value || 0);
    if (!rating) { $('#reviewMsg').textContent = 'Оберіть оцінку від 1 до 5 зірок'; return; }
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const r = await fetch('/api/review/' + encodeURIComponent(code), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, text: $('#reviewText').value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Помилка, спробуйте ще раз');
      thanks('Ваш відгук отримано. Він з\'явиться на сайті після перевірки.');
    } catch (err) {
      $('#reviewMsg').textContent = err.message;
      btn.disabled = false;
    }
  });
})();
