// «Приведи друга»: картка з формою запису друга. Працює в двох місцях:
//   після запису на сайті (mount(box, { code }) — код запису доводить, що це той самий клієнт),
//   у кабінеті клієнта (mount(box, {}) — за входом у кабінет).
window.FriendInvite = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (d) => d.split('-').reverse().join('.');
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
  const getJson = async (url) => { const r = await fetch(url); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Помилка'); return j; };

  async function mount(box, { code } = {}) {
    const api = code ? '/api/friend-invite' : '/api/account/friend-invite';
    let st, cfg;
    try {
      [st, cfg] = await Promise.all([getJson(code ? `${api}?code=${encodeURIComponent(code)}` : api), getJson('/api/settings')]);
    } catch { box.innerHTML = ''; return; }
    if (!st.enabled) { box.innerHTML = ''; return; }
    const promo = String(cfg.studio?.promo_friend || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const head = `<div class="fr-title">🤝 ${esc(promo[0] || 'Приведи друга')}</div>${promo[1] ? `<div class="fr-text">${esc(promo.slice(1).join(' '))}</div>` : ''}`;
    if (!st.available) {
      box.innerHTML = `<div class="friend-card">${head}<p class="fr-note">Друга вже записано. Нового друга можна буде записати, коли він прийде на візит.</p></div>`;
      return;
    }
    box.innerHTML = `<div class="friend-card">${head}<button class="btn btn-primary" type="button" data-fr-open>Записати друга</button><div data-fr-form></div></div>`;
    box.querySelector('[data-fr-open]').addEventListener('click', (e) => { e.target.hidden = true; openForm(box, { api, code, maxDate: cfg.maxDate }); });
  }

  async function openForm(box, { api, code, maxDate }) {
    const holder = box.querySelector('[data-fr-form]');
    const services = await getJson('/api/services').catch(() => []);
    holder.innerHTML = `<form class="fr-form" novalidate>
      <input class="input" name="name" placeholder="Ім'я друга" maxlength="60" autocomplete="off">
      <input class="input" name="phone" placeholder="Телефон друга, наприклад +380501234567" maxlength="30" autocomplete="off" inputmode="tel">
      <label class="fr-label">Послуга<select class="input" name="serviceId">${services.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label class="fr-label">Дата<input class="input" type="date" name="date" min="${ymd(new Date())}" ${maxDate ? `max="${maxDate}"` : ''}></label>
      <label class="fr-label">Час<select class="input" name="time"><option value="">Оберіть дату</option></select></label>
      <div class="hint" data-fr-hint></div>
      <textarea class="input" name="comment" rows="2" maxlength="450" placeholder="Коментар (необов'язково)"></textarea>
      <p class="consent-note">Запишіть друга лише за його згодою: ви передаєте нам його ім'я й телефон. Запис працює для нових клієнтів. Ми зв'яжемось з другом так само, як із будь-яким клієнтом: <a href="/privacy" target="_blank" rel="noopener">обробка даних</a>.</p>
      <button class="btn btn-primary" type="submit" data-fr-submit disabled>Записати друга</button>
      <div class="msg" data-fr-msg role="status"></div>
    </form>`;
    const f = holder.querySelector('form');
    const q = (n) => f.elements[n];
    const hint = holder.querySelector('[data-fr-hint]');
    const msg = holder.querySelector('[data-fr-msg]');
    const submit = holder.querySelector('[data-fr-submit]');
    let off = new Set(), reqId = 0;

    async function loadSlots(date, note = '') {
      const id = ++reqId;
      q('time').innerHTML = '<option value="">…</option>';
      submit.disabled = true;
      try {
        const sid = q('serviceId').value;
        const d = await getJson(`/api/slots?serviceId=${sid}&date=${date}`);
        if (id !== reqId) return;
        q('time').innerHTML = d.slots.length ? '<option value="">Оберіть час</option>' + d.slots.map((t) => `<option>${t}</option>`).join('') : '<option value="">Немає вільного часу</option>';
        hint.textContent = d.slots.length ? note : 'На цю дату вільного часу немає. Оберіть іншу дату.';
      } catch (e) { hint.textContent = e.message; }
    }
    async function pickDate(date) {
      const sid = q('serviceId').value;
      off = new Set((await getJson(`/api/days-off?serviceId=${sid}`).catch(() => ({ off: [] }))).off);
      let note = '';
      if (off.has(date)) {
        const was = date;
        for (let i = 0; i < 120 && off.has(date); i++) date = addDays(date, 1);
        note = `${fmt(was)} — вихідний, кабінет не працює. Показуємо ${fmt(date)}.`;
      }
      q('date').value = date;
      await loadSlots(date, note);
    }
    async function start() {
      try {
        const d = await getJson(`/api/next-slot?serviceId=${q('serviceId').value}`);
        await pickDate(d.date || ymd(new Date()));
      } catch { await pickDate(ymd(new Date())); }
    }
    q('serviceId').addEventListener('change', start);
    q('date').addEventListener('change', () => q('date').value && pickDate(q('date').value));
    q('time').addEventListener('change', () => { submit.disabled = !q('time').value; });
    start();

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      msg.className = 'msg'; msg.textContent = '';
      submit.disabled = true;
      try {
        const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          code, serviceId: Number(q('serviceId').value), date: q('date').value, time: q('time').value,
          name: q('name').value, phone: q('phone').value, comment: q('comment').value,
        }) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { msg.className = 'msg error'; msg.textContent = data.error || 'Помилка, спробуйте ще раз'; submit.disabled = false; if (r.status === 409) loadSlots(q('date').value); return; }
        const p = data.price;
        const price = p && p.full ? (p.pct ? ` Ціна: ${p.full} грн − знижка ${p.pct}% (${p.discount} грн) = ${p.final} грн.` : ` Ціна: ${p.full} грн.`)
          : p && p.pct ? ` Знижка ${p.pct}% на перший візит: точну суму назве майстер.` : p && p.note ? ` Ціна: ${p.note}.` : '';
        holder.innerHTML = `<p class="msg ok">Друга записано: ${esc(data.service)}, ${fmt(data.date)} о ${esc(data.time)}.${esc(price)} Нового друга можна буде записати, коли цей друг прийде на візит.</p>`;
        document.dispatchEvent(new CustomEvent('friend:booked'));
      } catch { msg.className = 'msg error'; msg.textContent = 'Немає зв\'язку із сервером. Спробуйте ще раз.'; submit.disabled = false; }
    });
  }

  return { mount };
})();
