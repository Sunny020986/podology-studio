// «Приведи друга» на сайті.
//   FriendInvite.list(holder, opts) — поля для 1–5 друзів (без <form>, тож працює всередині форми запису).
//     Для кожного друга: ім'я й телефон; за бажанням — галочка «одразу записати на час» (послуга, дата, час).
//     Без запису друг отримає знижку на перший візит, коли запишеться сам або коли йому передзвонить адміністратор.
//     Повертає { data(), error() }: data() — масив друзів для сервера, error() — текст помилки або null.
//   FriendInvite.mount(box) — картка в кабінеті клієнта: стан запрошень, знижка за друзів, запрошення.
window.FriendInvite = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (d) => d.split('-').reverse().join('.');
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
  const getJson = async (url) => { const r = await fetch(url); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Помилка'); return j; };
  let uid = 0;

  // Заголовок і опис акції з налаштувань кабінету (перший рядок — заголовок)
  const promo = (text) => {
    const lines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
    return { title: lines[0] || 'Приведи друга', text: lines.slice(1).join(' ') };
  };

  // Поля одного друга
  function friendBlock(n, { services, maxDate, defaults }) {
    const id = 'fr' + (++uid);
    const el = document.createElement('fieldset');
    el.className = 'fr-one';
    el.innerHTML = `<legend>Друг ${n}</legend>
      <button class="fr-del" type="button" aria-label="Прибрати друга ${n}" title="Прибрати">×</button>
      <input class="input" data-f="name" placeholder="Ім'я друга" maxlength="60" autocomplete="off">
      <input class="input" data-f="phone" placeholder="Телефон друга, наприклад +380501234567" maxlength="30" autocomplete="off" inputmode="tel">
      <label class="fr-booknow"><input type="checkbox" data-f="booknow"> Одразу записати друга на час (необов'язково)</label>
      <div class="fr-book" hidden>
        <label class="fr-label">Послуга<select class="input" data-f="serviceId">${services.map((s) => `<option value="${s.id}" ${s.id == defaults.serviceId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <div class="fr-row">
          <label class="fr-label">Дата<input class="input" type="date" data-f="date" min="${ymd(new Date())}" ${maxDate ? `max="${maxDate}"` : ''}></label>
          <label class="fr-label">Час<select class="input" data-f="time"><option value="">…</option></select></label>
        </div>
        <div class="hint" data-f="hint"></div>
      </div>`;
    const q = (f) => el.querySelector(`[data-f="${f}"]`);
    const mode = () => (q('booknow').checked ? 'book' : 'lead');
    let reqId = 0, started = false;

    async function loadSlots(date, note = '') {
      const my = ++reqId;
      q('time').innerHTML = '<option value="">…</option>';
      try {
        const d = await getJson(`/api/slots?serviceId=${q('serviceId').value}&date=${date}`);
        if (my !== reqId) return;
        q('time').innerHTML = d.slots.length ? '<option value="">Оберіть час</option>' + d.slots.map((t) => `<option>${t}</option>`).join('') : '<option value="">Немає вільного часу</option>';
        q('hint').textContent = d.slots.length ? note : 'На цю дату вільного часу немає. Оберіть іншу дату.';
      } catch (e) { q('hint').textContent = e.message; }
    }
    async function pickDate(date) {
      const off = new Set((await getJson(`/api/days-off?serviceId=${q('serviceId').value}`).catch(() => ({ off: [] }))).off);
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
      const want = defaults.date && defaults.date >= ymd(new Date()) ? defaults.date : null;
      if (want) return pickDate(want);
      try { const d = await getJson(`/api/next-slot?serviceId=${q('serviceId').value}`); await pickDate(d.date || ymd(new Date())); } catch { await pickDate(ymd(new Date())); }
    }
    q('serviceId').addEventListener('change', () => pickDate(q('date').value || ymd(new Date())));
    q('date').addEventListener('change', () => q('date').value && pickDate(q('date').value));
    q('booknow').addEventListener('change', () => {
      el.querySelector('.fr-book').hidden = mode() !== 'book';
      if (mode() === 'book' && !started) { started = true; start(); } // вільний час вантажимо лише тоді, коли він потрібен
    });

    return {
      el,
      setNumber(k) { el.querySelector('legend').textContent = 'Друг ' + k; el.querySelector('.fr-del').setAttribute('aria-label', 'Прибрати друга ' + k); },
      data() {
        const d = { mode: mode(), name: q('name').value.trim(), phone: q('phone').value.trim() };
        if (d.mode === 'book') Object.assign(d, { serviceId: Number(q('serviceId').value), date: q('date').value, time: q('time').value });
        return d;
      },
      error() {
        const d = this.data();
        if (d.name.length < 2) return "вкажіть ім'я";
        if (d.phone.replace(/\D/g, '').length < 9) return 'вкажіть телефон';
        if (d.mode === 'book' && !d.time) return 'оберіть час';
        return null;
      },
    };
  }

  // Список друзів з кнопкою «+ Ще друг» (не більше max)
  function list(holder, { services, maxDate, max = 5, defaults = {} }) {
    const items = [];
    holder.innerHTML = `<div class="fr-items"></div>
      <button class="btn btn-ghost small fr-more" type="button">+ Ще друг</button>
      <p class="consent-note">Вказуйте дані друзів лише за їхньою згодою: ви передаєте нам їхні імена й телефони. Запрошення діє для нових клієнтів. Ми зв'яжемось із другом так само, як із будь-яким клієнтом: <a href="/privacy" target="_blank" rel="noopener">обробка даних</a>.</p>`;
    const box = holder.querySelector('.fr-items');
    const more = holder.querySelector('.fr-more');
    const renumber = () => { items.forEach((it, i) => it.setNumber(i + 1)); more.hidden = items.length >= max; items.forEach((it) => { it.el.querySelector('.fr-del').hidden = items.length < 2; }); };
    const add = () => {
      if (items.length >= max) return;
      const it = friendBlock(items.length + 1, { services, maxDate, defaults });
      it.el.querySelector('.fr-del').addEventListener('click', () => { items.splice(items.indexOf(it), 1); it.el.remove(); renumber(); });
      items.push(it);
      box.appendChild(it.el);
      renumber();
    };
    more.addEventListener('click', add);
    add();
    return {
      data: () => items.map((it) => it.data()),
      error() {
        for (let i = 0; i < items.length; i++) { const e = items[i].error(); if (e) return `Друг ${i + 1}: ${e}`; }
        return null;
      },
    };
  }

  // Рядок про результат для кожного друга (після запису)
  function resultText(f) {
    if (!f.ok) return `${f.name || 'Друг'}: не вдалося — ${f.error}`;
    if (f.mode === 'lead') return `Друга ${f.name} додано${f.pct ? `: на перший візит у нього знижка ${f.pct}%` : ''}. Він може записатися сам на сайті, або ми йому зателефонуємо.`;
    const p = f.price;
    const what = p && p.kind === 'friend' ? 'знижка за друга' : p && p.kind === 'invited' ? 'знижка запрошеному другу' : 'знижка на перший візит';
    const price = p && p.full ? (p.pct ? ` Ціна: ${p.full} грн − ${what} ${p.pct}% (${p.discount} грн) = ${p.final} грн.` : ` Ціна: ${p.full} грн.`) : '';
    return `Друга записано: ${f.service}, ${fmt(f.date)} о ${f.time}.${price}`;
  }

  // Картка в кабінеті клієнта
  async function mount(box) {
    let st, cfg, services;
    try {
      [st, cfg, services] = await Promise.all([getJson('/api/account/friend-invite'), getJson('/api/settings'), getJson('/api/services')]);
    } catch { box.innerHTML = ''; return; }
    const pr = promo(cfg.studio?.promo_friend);
    const reward = st.rewards > 0 ? `<p class="fr-reward">🎁 За друзів, які прийшли, у вас знижка ${st.pct}% на наступний запис${st.rewards > 1 ? ` (знижок: ${st.rewards})` : ''}.</p>` : '';
    if (!st.enabled) { box.innerHTML = reward ? `<div class="friend-card">${reward}</div>` : ''; return; }
    const head = `<div class="fr-title">🤝 ${esc(pr.title)}</div>${pr.text ? `<div class="fr-text">${esc(pr.text)}</div>` : ''}`;
    if (!st.available) {
      box.innerHTML = `<div class="friend-card">${head}${reward}<p class="fr-note">Запрошених друзів, які ще не прийшли: ${st.open} з ${st.max}. Нових можна буде запросити, коли хтось із них прийде на візит.</p></div>`;
      return;
    }
    box.innerHTML = `<div class="friend-card">${head}${reward}<button class="btn btn-primary" type="button" data-fr-open>Запросити друзів</button><div data-fr-body></div></div>`;
    box.querySelector('[data-fr-open]').addEventListener('click', (e) => {
      e.target.hidden = true;
      const body = box.querySelector('[data-fr-body]');
      body.innerHTML = '<div data-fr-list></div><button class="btn btn-primary" type="button" data-fr-send>Запросити</button><div class="msg" data-fr-msg role="status"></div>';
      const lst = list(body.querySelector('[data-fr-list]'), { services, maxDate: cfg.maxDate, max: st.left || 1 });
      const msg = body.querySelector('[data-fr-msg]');
      body.querySelector('[data-fr-send]').addEventListener('click', async (ev) => {
        const err = lst.error();
        msg.className = 'msg';
        if (err) { msg.className = 'msg error'; msg.textContent = err; return; }
        ev.target.disabled = true;
        try {
          const r = await fetch('/api/account/friend-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friends: lst.data() }) });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || 'Помилка, спробуйте ще раз');
          body.innerHTML = `<p class="msg ok">${data.friends.map((f) => esc(resultText(f))).join('<br>')}</p>`;
        } catch (e2) { msg.className = 'msg error'; msg.textContent = e2.message; ev.target.disabled = false; }
      });
    });
  }

  return { list, mount, promo, resultText };
})();
