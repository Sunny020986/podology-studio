(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Орієнтовна ціна текстом має пріоритет; інакше число з адмінки; 0 означає «ціна уточнюється»
  const priceText = (s) => (s.price_note ? s.price_note : s.price_uah > 0 ? `${s.price_uah} грн` : 'ціна уточнюється');
  // 45 → «45 хв», 60 → «1 год», 90 → «1 год 30 хв»
  const durText = (m) => {
    const h = Math.floor(m / 60), r = m % 60;
    return [h ? `${h} год` : '', r ? `${r} хв` : ''].filter(Boolean).join(' ');
  };
  const addMin = (hhmm, m) => {
    const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + m;
    return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const fmtDate = (d) => d.split('-').reverse().join('.');
  const today = () => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };

  // ----- Дані кабінету: спершу запасні з config.js, потім справжні з сервера (адмінка) -----
  const telHref = (p) => 'tel:' + String(p).replace(/[^\d+]/g, '');
  function applyStudio(S) {
    $('#brandName').textContent = S.name || '';
    $('#tagline').textContent = S.tagline || '';
    $('#footerName').textContent = S.name || '';
    const phoneLink = S.phone ? `<a href="${esc(telHref(S.phone))}">${esc(S.phone)}</a>` : '';
    $('#footerAddress').innerHTML = [esc(S.address), phoneLink].filter(Boolean).join(' · ');
    $('#contactLine').innerHTML = S.phone ? `Телефон для довідки: ${phoneLink}` : '';
    if (S.name) document.title = `${S.name}: онлайн-запис`;
    renderContent(S);
  }

  // Текст з адмінки: перший рядок заголовок, решта опис
  const splitBlock = (t) => {
    const [title, ...rest] = String(t || '').trim().split('\n');
    return { title: (title || '').trim(), text: rest.join('\n').trim() };
  };

  function renderContent(S) {
    if (S.promo_first === undefined) return; // запасні дані з config.js: блоків ще немає

    state.promoFriend = S.promo_friend || '';

    // Лічильники: показуються лише заповнені числа з адмінки
    const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);
    const stats = [
      [Number(S.stat_years), (n) => plural(n, 'рік досвіду', 'роки досвіду', 'років досвіду')],
      [Number(S.stat_clients), (n) => plural(n, 'задоволений клієнт', 'задоволені клієнти', 'задоволених клієнтів')],
    ].filter(([n]) => Number.isInteger(n) && n > 0);
    $('#masterStats').hidden = !stats.length;
    $('#masterStats').innerHTML = stats.map(([n, label]) => '<div class="stat"><b class="stat-num" data-count="' + n + '">' + n.toLocaleString('uk-UA') + '</b><span>' + label(n) + '</span></div>').join('');
    $('#about').hidden = !(S.master_name || S.master_about || stats.length);
    $('#masterName').textContent = S.master_name || '';
    $('#masterAbout').textContent = S.master_about || '';

    const faq = String(S.faq || '').split(/\n\s*\n/).map(splitBlock).filter((q) => q.title);
    $('#faq').hidden = !faq.length;
    $('#faqList').innerHTML = faq.map((q) => `
      <details class="faq-item"><summary>${esc(q.title)}</summary><div class="faq-answer">${esc(q.text)}</div></details>`).join('');

    const place = [S.city, S.address].filter(Boolean).join(', ');
    $('#contacts').hidden = !place;
    if (place) {
      $('#contactsAddress').textContent = `📍 ${place}`;
      $('#contactsPhone').innerHTML = S.phone ? `📞 <a href="${esc(telHref(S.phone))}">${esc(S.phone)}</a>` : '';
      $('#routeBtn').href = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(place);
      const src = 'https://maps.google.com/maps?q=' + encodeURIComponent(place) + '&z=16&output=embed';
      const frame = $('#mapWrap iframe');
      if (!frame || frame.dataset.src !== src) {
        $('#mapWrap').innerHTML = `<iframe title="Карта: ${esc(place)}" data-src="${esc(src)}" src="${esc(src)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
      }
    }
    $('#reviewBtn').hidden = !S.review_url;
    if (S.review_url) $('#reviewBtn').href = S.review_url;
  }
  applyStudio(window.STUDIO || {});
  const settingsReady = fetch('/api/settings').then((x) => x.json()).catch(() => ({}));
  settingsReady.then((cfg) => { if (cfg.studio) applyStudio(cfg.studio); });

  // ----- Стан запису -----
  const state = { services: [], serviceId: null, extra: [], date: today(), time: null, reqId: 0, masters: [], masterId: '' };
  // Майстри: вибір показується, лише коли їх більше одного. '' = «будь-який вільний»
  const addDaysStr = (d, n) => { const [y, m, dd] = d.split('-').map(Number); const t = new Date(y, m - 1, dd + n); return [t.getFullYear(), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0')].join('-'); };
  // Кілька послуг в одному візиті: основна (state.serviceId) + додаткові (state.extra). Час і ціна — сума.
  const extraQ = () => (state.extra && state.extra.length ? '&extra=' + state.extra.join(',') : '');
  const selectedServices = () => [state.serviceId, ...(state.extra || [])].map((id) => state.services.find((x) => x.id == id)).filter(Boolean);
  const totalDuration = () => selectedServices().reduce((s, x) => s + x.duration_min, 0);
  const masterQ = () => (state.masterId ? '&masterId=' + state.masterId : '');
  const masterName = (id) => state.masters.find((m) => String(m.id) === String(id))?.name || '';
  function renderMasterOptions() {
    const many = state.masters.length > 1;
    $('#masterStep').hidden = !many;
    // Номери кроків зсуваються, коли з'являється крок «Майстер»
    document.querySelectorAll('.step-num').forEach((el) => {
      el.textContent = String({ date: 2, time: 3, data: 4 }[el.dataset.step] + (many ? 1 : 0));
    });
    if (!many) { state.masterId = ''; return; }
    const list = state.masters.filter((m) => !state.serviceId || [state.serviceId, ...(state.extra || [])].every((sid) => m.services.includes(Number(sid))));
    if (state.masterId && !list.some((m) => String(m.id) === String(state.masterId))) state.masterId = '';
    $('#masterSelect').innerHTML = '<option value="">Будь-який вільний</option>' +
      list.map((m) => '<option value="' + m.id + '"' + (String(m.id) === String(state.masterId) ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('');
  }
  // «Наші майстри»: показуємо, коли майстрів двоє й більше або в майстра є фото чи опис
  function renderTeam() {
    const list = state.masters;
    const show = list.length > 1 || list.some((m) => m.photo || m.bio);
    $('#team').hidden = !show;
    if (!show) return;
    $('#teamList').innerHTML = list.map((m) => '<div class="card team-card">' +
      (m.photo ? '<img class="team-photo" src="' + esc(m.photo) + '" alt="Фото: ' + esc(m.name) + '" loading="lazy">'
        : '<div class="team-photo team-initial" aria-hidden="true">' + esc(m.name.slice(0, 1)) + '</div>') +
      '<div class="team-name">' + esc(m.name) + '</div>' +
      (m.bio ? '<div class="team-bio">' + esc(m.bio) + '</div>' : '') +
      (list.length > 1 ? '<button class="btn btn-ghost small team-book" type="button" data-book-master="' + m.id + '">Записатися до майстра</button>' : '') +
      '</div>').join('');
  }
  $('#teamList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-book-master]');
    if (!btn) return;
    const m = state.masters.find((x) => String(x.id) === btn.dataset.bookMaster);
    if (!m) return;
    // Якщо обрана послуга не в цього майстра, беремо першу з його послуг
    if (!m.services.includes(state.serviceId)) {
      const s = state.services.find((x) => m.services.includes(x.id));
      if (s) { state.serviceId = s.id; $('#serviceSearch').value = s.name; }
    }
    state.masterId = String(m.id);
    pickNearestDate();
    $('#booking').scrollIntoView({ behavior: 'smooth' });
  });

  $('#masterSelect').addEventListener('change', (e) => {
    state.masterId = e.target.value;
    pickNearestDate();
  });

  async function loadServices() {
    const r = await fetch('/api/services');
    state.services = await r.json();
    state.masters = await fetch('/api/masters').then((x) => x.json()).catch(() => []);
    renderTeam();
    $('#servicesList').innerHTML = state.services.map((s) => `
      <button class="service" type="button" data-id="${s.id}">
        <span class="service-name">${esc(s.name)}</span>
        <span class="service-meta">⏱ ${durText(s.duration_min)} · ${esc(priceText(s))}</span>
        <span class="service-desc">${esc(s.description)}</span>
      </button>`).join('');
    setupServicesMore();
    state.serviceId = state.services[0]?.id ?? null;
    $('#serviceSearch').value = state.services.find((s) => s.id === state.serviceId)?.name ?? '';
    $('#dateInput').min = today();
    settingsReady.then((cfg) => { if (cfg.maxDate) { $('#dateInput').max = cfg.maxDate; state.maxDate = cfg.maxDate; } });
    $('#dateInput').value = state.date;
    pickNearestDate();
  }

  // Перелік довгий: спершу показуємо 6 послуг, решту за кнопкою
  const SERVICES_VISIBLE = 6;
  function setupServicesMore() {
    const list = $('#servicesList');
    const btn = $('#servicesMore');
    const total = state.services.length;
    btn.hidden = total <= SERVICES_VISIBLE;
    const apply = (open) => {
      list.classList.toggle('collapsed', !open);
      btn.textContent = open ? 'Згорнути' : `Показати всі послуги (${total})`;
      btn.dataset.open = open ? '1' : '';
    };
    apply(false);
    btn.onclick = () => {
      const open = !btn.dataset.open;
      apply(open);
      if (!open) $('#services').scrollIntoView({ behavior: 'smooth' });
    };
  }

  // Вихідні дні (ніхто не працює): їх не пропонуємо для запису й черги очікування
  let daysOff = new Set();
  async function loadDaysOff() {
    try {
      const r = await fetch(`/api/days-off?serviceId=${state.serviceId || ''}` + extraQ() + masterQ());
      daysOff = new Set(r.ok ? (await r.json()).off : []);
    } catch { daysOff = new Set(); }
  }
  const nextWorkingDay = (from) => {
    for (let i = 1; i <= 120; i++) {
      const d = addDaysStr(from, i);
      if (state.maxDate && d > state.maxDate) return null;
      if (!daysOff.has(d)) return d;
    }
    return null;
  };

  // Клієнт одразу бачить найближчий день з вільним часом, а не порожню дату
  async function pickNearestDate() {
    state.extra = (state.extra || []).filter((x) => x != state.serviceId); // основна послуга не дублюється в додаткових
    if (!state.serviceId) return refreshSlots();
    try {
      renderMasterOptions(); // послуга могла змінитись: показуємо лише майстрів, які її роблять
      await loadDaysOff();
      const r = await fetch(`/api/next-slot?serviceId=${state.serviceId}` + extraQ() + masterQ());
      const data = r.ok ? await r.json() : null;
      if (data?.date) {
        state.date = data.date;
        $('#dateInput').value = data.date;
      }
    } catch (e) { /* без мережі лишається поточна дата */ }
    return refreshSlots();
  }

  // Список очікування: показується, коли на обрану дату немає вільного часу
  function showWaitBox(show) {
    $('#waitBox').hidden = !show;
    $('#waitForm').hidden = true;
    $('#waitOpen').hidden = false;
    $('#waitMsg').textContent = '';
    $('#waitTg').hidden = true;
  }
  $('#waitOpen').addEventListener('click', () => {
    $('#waitOpen').hidden = true;
    $('#waitForm').hidden = false;
    if (!$('#waitName').value) $('#waitName').value = $('#nameInput').value;
    if (!$('#waitPhone').value) $('#waitPhone').value = $('#phoneInput').value;
    $('#waitName').focus();
  });
  $('#waitForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#waitMsg');
    msg.classList.remove('ok');
    try {
      const r = await fetch('/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: state.serviceId, date: state.date, name: $('#waitName').value, phone: $('#waitPhone').value, masterId: state.masterId || undefined }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Помилка, спробуйте ще раз');
      $('#waitForm').hidden = true;
      msg.classList.add('ok');
      msg.textContent = 'Готово! Ви в списку очікування на ' + fmtDate(state.date) + '. ' +
        (data.telegramLink ? 'Щоб отримати сповіщення одразу, натисніть кнопку нижче.' : 'Якщо звільниться час, ми вам зателефонуємо.');
      if (data.telegramLink) { $('#waitTg').href = data.telegramLink; $('#waitTg').hidden = false; }
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  async function refreshSlots() {
    state.time = null;
    showWaitBox(false);
    updateSummary();
    const grid = $('#slotsGrid');
    grid.innerHTML = '';
    if (!state.serviceId || !state.date) return;
    if (daysOff.has(state.date)) {
      // Вихідний: переходимо на найближчий робочий день і кажемо про це
      const next = nextWorkingDay(state.date);
      const was = state.date;
      if (next) {
        state.date = next;
        $('#dateInput').value = next;
        state.offNotice = { date: next, text: `${fmtDate(was)} — вихідний, кабінет не працює. Показуємо ${fmtDate(next)}.` };
        await refreshSlots();
      } else {
        $('#slotsHint').textContent = `${fmtDate(was)} — вихідний, кабінет не працює. Оберіть іншу дату.`;
      }
      return;
    }

    const reqId = ++state.reqId;
    $('#slotsHint').textContent = 'Завантажую вільний час…';
    const r = await fetch(`/api/slots?serviceId=${state.serviceId}&date=${state.date}` + extraQ() + masterQ());
    const data = await r.json();
    if (reqId !== state.reqId) return; // відповідь застаріла, вже вибрано іншу дату або послугу
    if (!r.ok) {
      $('#slotsHint').textContent = data.error;
      return;
    }
    if (!data.slots.length) {
      $('#slotsHint').textContent = 'На цю дату вільного часу немає. Оберіть іншу дату або станьте в чергу.';
      showWaitBox(true);
      return;
    }
    $('#slotsHint').textContent = state.offNotice && state.offNotice.date === state.date ? state.offNotice.text : '';
    grid.innerHTML = data.slots.map((t) => `<button type="button" class="slot" data-time="${t}">${t}</button>`).join('');
  }

  function updateSummary() {
    const s = state.services.find((x) => x.id == state.serviceId);
    const names = selectedServices().map((x) => x.name).join(' + ');
    const dur = totalDuration();
    renderExtras();
    $('#summary').textContent = state.time && s
      ? `${names}${state.masterId ? ', майстер ' + masterName(state.masterId) : ''}, ${fmtDate(state.date)}, ${state.time}–${addMin(state.time, dur)} (триває ${durText(dur)})`
      : s ? `${state.extra.length ? 'Візит' : 'Процедура'} триває ${durText(dur)}. Оберіть час, щоб продовжити.` : 'Оберіть час, щоб продовжити.';
    $('#submitBtn').disabled = !state.time;
    refreshQuote();
  }

  // ----- Ціна й знижка на перший візит -----
  // Знижку пропонуємо лише тому, хто ще не мав у нас записів: сервер перевіряє за номером телефону.
  const quoteState = { key: '', data: null };
  const phoneDigits = () => $('#phoneInput').value.replace(/\D/g, '');
  const discName = (q) => (q.kind === 'friend' ? 'Знижка за друга' : q.kind === 'invited' ? (q.pctFirst ? `Знижка запрошеному другу (${q.pctFirst}% + ${q.pctFriend}%)` : 'Знижка запрошеному другу') : 'Знижка на перший візит');
  // Запрошений друг: дві знижки окремими рядками (перший візит + від друга), сума — разом
  const discRows = (q) => {
    if (q.kind !== 'invited' || !q.pctFirst) return `<div class="pc-row pc-disc"><span>${discName(q)} ${q.pct}%</span><span>− ${q.discount} грн</span></div>`;
    const a = Math.round(q.full * q.pctFirst / 100);
    return `<div class="pc-row pc-disc"><span>Знижка на перший візит ${q.pctFirst}%</span><span>− ${a} грн</span></div>
       <div class="pc-row pc-disc"><span>Знижка запрошеному другу ${q.pctFriend}%</span><span>− ${q.discount - a} грн</span></div>`;
  };
  const calcHtml = (q) => q.pct && q.full
    ? `<div class="price-calc"><div class="pc-row"><span>Ціна за прайсом</span><span>${q.full} грн</span></div>
       ${discRows(q)}
       <div class="pc-row pc-total"><span>До сплати</span><span>${q.final} грн</span></div></div>`
    : q.pct
      ? `<div class="price-calc"><div class="pc-row pc-disc"><span>${discName(q)} ${q.pct}%</span><span></span></div><div class="muted">Точну суму з урахуванням знижки назве майстер.</div></div>`
      : '';
  function renderPrice() {
    const box = $('#priceBox');
    if (!box) return;
    const s = state.services.find((x) => x.id == state.serviceId);
    if (!s) { box.innerHTML = ''; return; }
    const q = quoteState.key === quoteKey() ? quoteState.data : null;
    renderFriendInline(q);
    if (q && q.eligible) { box.innerHTML = calcHtml(q) + unpricedNote(); return; }
    const list = selectedServices();
    if (list.length > 1) {
      // Кілька послуг: кожна окремим рядком і сума
      const sum = list.reduce((t, x) => t + (x.price_uah > 0 ? x.price_uah : 0), 0);
      // Ціна текстом «від 1380 грн» — додаємо її мінімум, і тоді разом теж «від …»
      const un = list.filter((x) => !(x.price_uah > 0));
      const mins = un.map((x) => Number((String(x.price_note || '').match(/\d[\d\s]*/) || [''])[0].replace(/\s/g, '')) || 0);
      const total = !un.length ? (sum ? sum + ' грн' : 'ціна уточнюється')
        : mins.every((n) => n > 0) ? `від ${sum + mins.reduce((a, b) => a + b, 0)} грн` : sum ? `${sum} грн + уточнюється` : 'ціна уточнюється';
      box.innerHTML = `<div class="price-calc">${list.map((x) => `<div class="pc-row"><span>${esc(x.name)}</span><span>${esc(priceText(x))}</span></div>`).join('')}
        <div class="pc-row pc-total"><span>Разом</span><span>${total}</span></div></div>` + unpricedNote();
      return;
    }
    box.innerHTML = s.price_uah > 0 || s.price_note
      ? `<div class="price-calc"><div class="pc-row pc-total"><span>Ціна</span><span>${esc(priceText(s))}</span></div></div>` : '';
  }
  // «Приведи друга» прямо у формі: показуємо лише номеру, який ще може запросити друзів (сервер каже, скільки)
  let friendList = null;
  function renderFriendInline(q) {
    const box = $('#friendInline');
    if (!box) return;
    const ok = !!(q && q.friend && q.friend.available && window.FriendInvite);
    if (!ok) { box.hidden = true; $('#frOn').checked = false; $('#frList').hidden = true; $('#frList').innerHTML = ''; friendList = null; return; }
    if (box.hidden) {
      const pr = window.FriendInvite.promo(state.promoFriend);
      $('#frTitle').textContent = '🤝 ' + pr.title;
      $('#frText').textContent = pr.text;
      box.dataset.left = q.friend.left || 1;
      box.hidden = false;
    }
  }
  $('#frOn')?.addEventListener('change', (e) => {
    const on = e.target.checked;
    $('#frList').hidden = !on;
    if (on && !friendList) {
      friendList = window.FriendInvite.list($('#frList'), { services: state.services, maxDate: state.maxDate, max: Number($('#friendInline').dataset.left) || 1, defaults: { serviceId: state.serviceId, date: state.date } });
    }
  });
  const quoteKey = () => `${state.serviceId}|${(state.extra || []).join(',')}|${phoneDigits()}`;
  // Послуги без числової ціни (лише «від … грн») у суму не входять — підказка
  const unpricedNote = () => {
    const list = selectedServices();
    const un = list.filter((x) => !(x.price_uah > 0));
    return list.length > 1 && un.length ? `<div class="muted">Без точної ціни: ${un.map((x) => esc(x.name) + (x.price_note ? ' (' + esc(x.price_note) + ')' : '')).join(', ')} — суму за ${un.length > 1 ? 'них' : 'неї'} назве майстер.</div>` : '';
  };
  // Додаткові послуги: плашки з «×» і список, з якого додати ще
  function renderExtras() {
    const box = $('#extraSvcs');
    if (!box) return;
    box.innerHTML = (state.extra || []).map((id) => {
      const x = state.services.find((s) => s.id == id);
      return x ? `<span class="extra-chip">+ ${esc(x.name)} <button type="button" data-del-extra="${x.id}" aria-label="Прибрати ${esc(x.name)}">×</button></span>` : '';
    }).join('');
    const left = state.services.filter((x) => x.id != state.serviceId && !(state.extra || []).includes(x.id));
    $('#addSvcBtn').hidden = !state.serviceId || !left.length || (state.extra || []).length >= 4;
  }
  $('#addSvcBtn').addEventListener('click', () => {
    const left = state.services.filter((x) => x.id != state.serviceId && !(state.extra || []).includes(x.id));
    const sel = $('#addSvcSelect');
    sel.innerHTML = '<option value="">Оберіть послугу…</option>' + left.map((x) => `<option value="${x.id}">${esc(x.name)} · ${durText(x.duration_min)} · ${esc(priceText(x))}</option>`).join('');
    sel.hidden = false;
    $('#addSvcBtn').hidden = true;
    sel.focus();
  });
  $('#addSvcSelect').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    e.target.hidden = true;
    if (id) { state.extra = [...(state.extra || []), id]; renderMasterOptions(); pickNearestDate(); } else renderExtras();
  });
  $('#extraSvcs').addEventListener('click', (e) => {
    const id = Number(e.target.dataset.delExtra);
    if (!id) return;
    state.extra = (state.extra || []).filter((x) => x !== id);
    renderMasterOptions();
    pickNearestDate();
  });
  let quoteTimer = null;
  function refreshQuote() {
    const s = state.services.find((x) => x.id == state.serviceId);
    const d = phoneDigits();
    clearTimeout(quoteTimer);
    if (!s || d.length < 9) { quoteState.key = ''; renderPrice(); return; }
    const key = quoteKey();
    if (quoteState.key === key) { renderPrice(); return; }
    quoteTimer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/first-discount?serviceId=${s.id}&phone=${encodeURIComponent(d)}` + extraQ());
        if (!r.ok) throw new Error();
        const data = await r.json();
        if (quoteKey() !== key) return; // поки чекали, клієнт змінив дані
        quoteState.key = key; quoteState.data = data;
      } catch { quoteState.key = ''; }
      renderPrice();
    }, 400);
  }
  $('#phoneInput').addEventListener('input', refreshQuote);

  $('#servicesList').addEventListener('click', (e) => {
    const card = e.target.closest('[data-id]');
    if (!card) return;
    state.serviceId = Number(card.dataset.id);
    $('#serviceSearch').value = card.querySelector('.service-name')?.textContent ?? '';
    pickNearestDate();
    $('#booking').scrollIntoView({ behavior: 'smooth' });
  });

  // Пошук послуги в самому полі: список фільтрується за тим, що клієнт друкує
  const serviceInput = $('#serviceSearch');
  const suggest = $('#serviceSuggest');
  const currentName = () => state.services.find((x) => x.id === state.serviceId)?.name ?? '';
  const closeSuggest = () => {
    suggest.hidden = true;
    serviceInput.setAttribute('aria-expanded', 'false');
  };
  function renderSuggest(term) {
    const q = term.trim().toLowerCase();
    const list = state.services.filter((s) => !q || s.name.toLowerCase().includes(q));
    suggest.innerHTML = list.length
      ? list.map((s) => `<li role="option"><button type="button" class="suggest-item" data-id="${s.id}">${esc(s.name)} <span class="muted">· ${durText(s.duration_min)}</span></button></li>`).join('')
      : '<li class="suggest-empty muted">Такої послуги немає. Спробуйте інші слова.</li>';
    suggest.hidden = false;
    serviceInput.setAttribute('aria-expanded', 'true');
  }
  function chooseService(id) {
    closeSuggest();
    const s = state.services.find((x) => x.id === id);
    if (!s) return;
    serviceInput.value = s.name;
    if (s.id === state.serviceId) return;
    state.serviceId = s.id;
    pickNearestDate();
  }
  const touchScreen = window.matchMedia('(pointer: coarse)').matches;
  serviceInput.addEventListener('focus', () => {
    // На телефоні виділення тексту відкриває меню «Копіювати/Вставити», тож лише показуємо список
    if (!touchScreen) serviceInput.select();
    renderSuggest('');
    // Клавіатура телефона закриває пів екрана: піднімаємо поле, щоб список підказок був видно
    if (touchScreen) setTimeout(() => serviceInput.scrollIntoView({ block: 'start', behavior: 'smooth' }), 350);
  });
  serviceInput.addEventListener('input', () => renderSuggest(serviceInput.value));
  serviceInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { serviceInput.value = currentName(); closeSuggest(); } });
  suggest.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-id]');
    if (btn) chooseService(Number(btn.dataset.id));
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('.combo')) return;
    if (!suggest.hidden) { closeSuggest(); serviceInput.value = currentName(); }
  });

  // Клік по полю дати одразу відкриває календар (де браузер це підтримує)
  $('#dateInput').addEventListener('click', (e) => {
    try { e.target.showPicker?.(); } catch (err) { /* браузер сам покаже календар кнопкою праворуч */ }
  });

  $('#dateInput').addEventListener('change', (e) => {
    state.date = e.target.value;
    refreshSlots();
  });

  $('#slotsGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.slot');
    if (!btn) return;
    state.time = btn.dataset.time;
    document.querySelectorAll('.slot').forEach((x) => x.classList.toggle('selected', x === btn));
    updateSummary();
  });

  // Клієнт увійшов у кабінет (або щойно зареєструвався): його ім'я й телефон уже відомі, тож підставляємо їх у форму запису.
  // Те, що клієнт устиг ввести сам, не чіпаємо; після виходу прибираємо лише підставлене.
  let autoFilled = { name: '', phone: '' };
  document.addEventListener('account:me', (e) => {
    const me = e.detail, n = $('#nameInput'), p = $('#phoneInput');
    if (me) {
      if (!n.value || n.value === autoFilled.name) { n.value = me.name; autoFilled.name = me.name; }
      if (!p.value || p.value === autoFilled.phone) { p.value = me.phone; autoFilled.phone = me.phone; }
    } else {
      if (n.value === autoFilled.name) n.value = '';
      if (p.value === autoFilled.phone) p.value = '';
      autoFilled = { name: '', phone: '' };
    }
    p.dispatchEvent(new Event('input')); // перерахувати ціну зі знижкою для цього номера
  });

  $('#bookingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#bookingMsg');
    msg.className = 'msg';
    msg.textContent = '';
    $('#remindBtn').hidden = true;
    const body = {
      serviceId: Number(state.serviceId),
      date: state.date,
      time: state.time,
      name: $('#nameInput').value,
      phone: $('#phoneInput').value,
      comment: $('#commentInput').value,
      masterId: state.masterId ? Number(state.masterId) : undefined,
      extraServiceIds: state.extra && state.extra.length ? state.extra : undefined,
    };
    if (friendList && $('#frOn').checked && !$('#friendInline').hidden) {
      const err = friendList.error();
      if (err) { msg.className = 'msg error'; msg.textContent = err; return; }
      body.friends = friendList.data();
    }
    // Кнопка вимкнена, поки сервер не відповів: повторне натискання не надішле другий запит
    const btn = $('#submitBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    const oldLabel = btn.textContent;
    btn.textContent = 'Записуємо…';
    let r, data;
    try {
      r = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await r.json().catch(() => ({}));
    } catch {
      r = null;
    } finally {
      btn.textContent = oldLabel;
    }
    if (!r || !r.ok) {
      msg.className = 'msg error';
      msg.textContent = r ? data.error || 'Помилка сервера' : 'Немає зв\'язку із сервером. Спробуйте ще раз.';
      btn.disabled = false;
      if (r && r.status === 409) refreshSlots();
      return;
    }
    msg.className = 'msg ok';
    const dur = totalDuration();
    const span = dur ? `${data.time}–${addMin(data.time, dur)} (триває ${durText(dur)})` : `о ${data.time}`;
    msg.textContent = `Дякуємо! Ви записані: ${data.service}${data.master && state.masters.length > 1 ? ', майстер ' + data.master : ''}, ${fmtDate(data.date)}, ${span}. Номер запису: ${data.id}.`;
    const pr = data.price;
    if (pr && pr.full) {
      msg.textContent += pr.pct
        ? ` Ціна: ${pr.full} грн − ${pr.kind === 'friend' ? 'знижка за друга' : pr.kind === 'invited' ? `знижка запрошеному другу${pr.pctFirst ? ` (${pr.pctFirst}% + ${pr.pctFriend}%)` : ''}` : 'знижка на перший візит'} ${pr.pct}% (${pr.discount} грн) = ${pr.final} грн.`
        : ` Ціна: ${pr.full} грн.`;
    } else if (pr && pr.pct) {
      msg.textContent += ` ${pr.kind === 'friend' ? 'Знижка за друга' : pr.kind === 'invited' ? 'Знижка запрошеному другу' : 'Знижка на перший візит'} ${pr.pct}%: точну суму назве майстер.`;
    } else if (pr && pr.note) {
      msg.textContent += ` Ціна: ${pr.note}.`;
    }
    // «Приведи друга»: що вийшло з кожним другом
    if (data.friends && window.FriendInvite) msg.textContent += ' ' + data.friends.map((f) => window.FriendInvite.resultText(f)).join(' ');
    if (data.remindLink) {
      $('#remindBtn').href = data.remindLink;
      $('#remindBtn').hidden = false;
    }
    // Після запису поля очищаємо, але для клієнта з кабінету лишаємо його дані
    $('#nameInput').value = autoFilled.name;
    $('#phoneInput').value = autoFilled.phone;
    state.extra = []; // наступний запис — знову з однією послугою
    quoteState.key = '';
    renderPrice();
    document.dispatchEvent(new CustomEvent('booking:success'));
    refreshSlots();
  });

  // ----- Чат з оператором -----
  const chat = { ws: null, convId: localStorage.getItem('convId') };

  function addMsg(m) {
    const div = document.createElement('div');
    div.className = `bubble ${m.sender === 'client' ? 'mine' : 'theirs'}`;
    div.dataset.msg = m.id;
    div.textContent = m.body;
    $('#chatBody').appendChild(div);
    $('#chatBody').scrollTop = 1e9;
  }

  function addSystem(text) {
    const div = document.createElement('div');
    div.className = 'system';
    div.textContent = text;
    $('#chatBody').appendChild(div);
  }

  function connectChat() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    chat.ws = new WebSocket(`${proto}://${location.host}/ws`);
    chat.ws.onopen = () => chat.ws.send(JSON.stringify({ type: 'hello', conversationId: chat.convId }));
    chat.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'hello') {
        chat.convId = m.conversationId;
        if (chat.convId) localStorage.setItem('convId', chat.convId);
        else localStorage.removeItem('convId');
        $('#chatBody').innerHTML = '';
        if (!m.messages.length) addSystem('Напишіть питання, і оператор відповість тут.');
        m.messages.forEach(addMsg);
      }
      if (m.type === 'conversation') {
        chat.convId = m.conversationId;
        localStorage.setItem('convId', chat.convId);
        const hint = $('#chatBody .system');
        if (hint) hint.remove();
      }
      if (m.type === 'message') addMsg(m.message);
      if (m.type === 'message_deleted') document.querySelector(`#chatBody [data-msg="${m.messageId}"]`)?.remove();
      if (m.type === 'error') addSystem(m.error);
    };
    chat.ws.onclose = () => setTimeout(connectChat, 3000);
  }

  function openChat(open = true) {
    $('#chatPanel').hidden = !open;
    if (open) $('#chatInput').focus();
  }

  $('#chatFab').addEventListener('click', () => openChat($('#chatPanel').hidden));
  $('#chatClose').addEventListener('click', () => openChat(false));
  $('#navChat').addEventListener('click', (e) => { e.preventDefault(); openChat(true); });

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text || !chat.ws || chat.ws.readyState !== 1) return;
    chat.ws.send(JSON.stringify({ type: 'message', body: text }));
    input.value = '';
  });

  connectChat();
  // Опубліковані поради з догляду: кожна веде на окрему сторінку
  fetch('/api/tips').then((r) => r.json()).then((list) => {
    if (!Array.isArray(list) || !list.length) return;
    $('#tipsList').innerHTML = list.map((t) => '<a class="card tip-card" href="/tips/' + encodeURIComponent(t.slug) + '">' +
      '<span class="tip-title">' + esc(t.title) + '</span>' +
      (t.summary ? '<span class="tip-summary">' + esc(t.summary) + '</span>' : '') +
      '<span class="tip-more">Читати →</span></a>').join('');
    $('#tips').hidden = false;
  }).catch(() => {});

  // Схвалені відгуки клієнтів
  fetch('/api/reviews').then((r) => r.json()).then((list) => {
    if (!Array.isArray(list) || !list.length) return;
    const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
    $('#reviewsList').innerHTML = list.map((r) => '<div class="card review">' +
      '<div class="review-stars" role="img" aria-label="Оцінка ' + r.rating + ' з 5">' + stars(r.rating) + '</div>' +
      (r.text ? '<div class="review-text">' + esc(r.text) + '</div>' : '') +
      '<div class="review-meta">' + esc(r.name) + ' · ' + esc(r.service) + '</div></div>').join('');
    $('#reviews').hidden = false;
  }).catch(() => {});

  loadServices().catch(() => {
    $('#slotsHint').textContent = 'Не вдалося завантажити послуги. Перевірте, чи запущено сервер.';
  });
})();
