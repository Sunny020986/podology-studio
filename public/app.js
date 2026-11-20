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

    const first = splitBlock(S.promo_first);
    $('#promoPill').hidden = !first.title;
    $('#promoPill').textContent = first.title ? `🎁 ${first.title}` : '';

    const offers = [
      ['🎁', S.promo_first], ['🤝', S.promo_friend], ['💝', S.promo_gift], ['🩺', S.partners],
    ].map(([icon, t]) => ({ icon, ...splitBlock(t) })).filter((o) => o.title);
    $('#offers').hidden = !offers.length;
    $('#offersList').innerHTML = offers.map((o) => `
      <div class="card offer"><div class="offer-icon">${o.icon}</div>
        <div class="offer-title">${esc(o.title)}</div><div class="offer-text">${esc(o.text)}</div></div>`).join('');

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
  const state = { services: [], serviceId: null, date: today(), time: null, reqId: 0 };

  async function loadServices() {
    const r = await fetch('/api/services');
    state.services = await r.json();
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
    settingsReady.then((cfg) => { if (cfg.maxDate) $('#dateInput').max = cfg.maxDate; });
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

  // Клієнт одразу бачить найближчий день з вільним часом, а не порожню дату
  async function pickNearestDate() {
    if (!state.serviceId) return refreshSlots();
    try {
      const r = await fetch(`/api/next-slot?serviceId=${state.serviceId}`);
      const data = r.ok ? await r.json() : null;
      if (data?.date) {
        state.date = data.date;
        $('#dateInput').value = data.date;
      }
    } catch (e) { /* без мережі лишається поточна дата */ }
    return refreshSlots();
  }

  async function refreshSlots() {
    state.time = null;
    updateSummary();
    const grid = $('#slotsGrid');
    grid.innerHTML = '';
    if (!state.serviceId || !state.date) return;

    const reqId = ++state.reqId;
    $('#slotsHint').textContent = 'Завантажую вільний час…';
    const r = await fetch(`/api/slots?serviceId=${state.serviceId}&date=${state.date}`);
    const data = await r.json();
    if (reqId !== state.reqId) return; // відповідь застаріла, вже вибрано іншу дату або послугу
    if (!r.ok) {
      $('#slotsHint').textContent = data.error;
      return;
    }
    if (!data.slots.length) {
      $('#slotsHint').textContent = 'На цю дату вільного часу немає. Оберіть іншу дату.';
      return;
    }
    $('#slotsHint').textContent = '';
    grid.innerHTML = data.slots.map((t) => `<button type="button" class="slot" data-time="${t}">${t}</button>`).join('');
  }

  function updateSummary() {
    const s = state.services.find((x) => x.id == state.serviceId);
    $('#summary').textContent = state.time && s
      ? `${s.name}, ${fmtDate(state.date)}, ${state.time}–${addMin(state.time, s.duration_min)} (триває ${durText(s.duration_min)})`
      : s ? `Процедура триває ${durText(s.duration_min)}. Оберіть час, щоб продовжити.` : 'Оберіть час, щоб продовжити.';
    $('#submitBtn').disabled = !state.time;
  }

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
    };
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
    const svc = state.services.find((x) => x.name === data.service);
    const span = svc ? `${data.time}–${addMin(data.time, svc.duration_min)} (триває ${durText(svc.duration_min)})` : `о ${data.time}`;
    msg.textContent = `Дякуємо! Ви записані: ${data.service}, ${fmtDate(data.date)}, ${span}. Номер запису: ${data.id}.`;
    if (data.remindLink) {
      $('#remindBtn').href = data.remindLink;
      $('#remindBtn').hidden = false;
    }
    $('#nameInput').value = '';
    $('#phoneInput').value = '';
    document.dispatchEvent(new CustomEvent('booking:success'));
    refreshSlots();
  });

  // ----- Чат з оператором -----
  const chat = { ws: null, convId: localStorage.getItem('convId') };

  function addMsg(m) {
    const div = document.createElement('div');
    div.className = `bubble ${m.sender === 'client' ? 'mine' : 'theirs'}`;
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
