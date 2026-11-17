(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const priceText = (p) => (p > 0 ? `${p} грн` : 'ціна уточнюється');
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
  }
  applyStudio(window.STUDIO || {});
  const settingsReady = fetch('/api/settings').then((x) => x.json()).catch(() => ({}));
  settingsReady.then((cfg) => { if (cfg.studio) applyStudio(cfg.studio); });

  // ----- Стан запису -----
  const state = { services: [], serviceId: null, date: today(), time: null, reqId: 0 };

  async function loadServices() {
    const r = await fetch('/api/services');
    state.services = await r.json();
    $('#serviceSelect').innerHTML = state.services
      .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    $('#servicesList').innerHTML = state.services.map((s) => `
      <button class="service" type="button" data-id="${s.id}">
        <span class="service-name">${esc(s.name)}</span>
        <span class="service-meta">${s.duration_min} хв · ${priceText(s.price_uah)}</span>
        <span class="service-desc">${esc(s.description)}</span>
      </button>`).join('');
    state.serviceId = state.services[0]?.id ?? null;
    $('#serviceSelect').value = state.serviceId ?? '';
    $('#dateInput').min = today();
    settingsReady.then((cfg) => { if (cfg.maxDate) $('#dateInput').max = cfg.maxDate; });
    $('#dateInput').value = state.date;
    refreshSlots();
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
      ? `${s.name}, ${state.date}, о ${state.time}`
      : 'Оберіть час, щоб продовжити.';
    $('#submitBtn').disabled = !state.time;
  }

  $('#servicesList').addEventListener('click', (e) => {
    const card = e.target.closest('[data-id]');
    if (!card) return;
    state.serviceId = Number(card.dataset.id);
    $('#serviceSelect').value = state.serviceId;
    refreshSlots();
    $('#booking').scrollIntoView({ behavior: 'smooth' });
  });

  $('#serviceSelect').addEventListener('change', (e) => {
    state.serviceId = Number(e.target.value);
    refreshSlots();
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
    const body = {
      serviceId: Number(state.serviceId),
      date: state.date,
      time: state.time,
      name: $('#nameInput').value,
      phone: $('#phoneInput').value,
    };
    const r = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      msg.className = 'msg error';
      msg.textContent = data.error;
      if (r.status === 409) refreshSlots();
      return;
    }
    msg.className = 'msg ok';
    msg.textContent = `Дякуємо! Ви записані: ${data.service}, ${data.date} о ${data.time}. Номер запису: ${data.id}.`;
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
        localStorage.setItem('convId', chat.convId);
        $('#chatBody').innerHTML = '';
        if (!m.messages.length) addSystem('Напишіть питання, і оператор відповість тут.');
        m.messages.forEach(addMsg);
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
  loadServices().catch(() => {
    $('#slotsHint').textContent = 'Не вдалося завантажити послуги. Перевірте, чи запущено сервер.';
  });
})();
