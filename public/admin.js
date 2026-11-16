(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  const STATUS = { new: 'Нова', confirmed: 'Підтверджено', cancelled: 'Скасовано' };
  const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'];

  let token = sessionStorage.getItem('adminToken') || '';
  let ws = null;
  let currentConv = null;
  let appointmentDate = today();
  let blockDate = today();

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      logout();
      throw new Error('Невірний токен');
    }
    if (!r.ok) throw new Error(data.error || 'Помилка сервера');
    return data;
  }

  function notify(text, isError) {
    const n = $('#notice');
    n.textContent = text;
    n.className = 'notice ' + (isError ? 'error' : 'ok');
    setTimeout(() => { if (n.textContent === text) n.textContent = ''; }, 4000);
  }

  // ----- Вхід -----
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('#tokenInput').value.trim();
    try {
      await api('/api/admin/services');
      sessionStorage.setItem('adminToken', token);
      start();
    } catch (err) {
      $('#loginMsg').textContent = err.message;
    }
  });

  $('#logoutBtn').addEventListener('click', logout);

  function logout() {
    token = '';
    sessionStorage.removeItem('adminToken');
    if (ws) ws.close();
    ws = null;
    $('#app').hidden = true;
    $('#login').hidden = false;
  }

  function start() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    connectWs();
    show('appointments');
  }

  // ----- Вкладки -----
  const views = {
    appointments: renderAppointments,
    chat: renderChat,
    schedule: renderSchedule,
    blocks: renderBlocks,
    services: renderServices,
  };

  function show(name) {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    views[name]().catch((e) => notify(e.message, true));
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  // ----- Записи -----
  async function renderAppointments() {
    $('#view').innerHTML = `
      <div class="toolbar"><label>Дата <input type="date" id="apptDate" value="${appointmentDate}"></label></div>
      <table>
        <thead><tr><th>Час</th><th>Послуга</th><th>Клієнт</th><th>Телефон</th><th>Статус</th></tr></thead>
        <tbody id="apptRows"></tbody>
      </table>`;
    const rows = await api(`/api/admin/appointments?from=${appointmentDate}&to=${appointmentDate}`);
    $('#apptRows').innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${r.start_time}–${r.end_time}</td>
          <td>${esc(r.service)}</td>
          <td>${esc(r.client_name)}</td>
          <td>${esc(r.client_phone)}</td>
          <td><select data-appt="${r.id}">${Object.entries(STATUS)
            .map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="muted">На цю дату записів немає.</td></tr>';
  }

  // ----- Чат -----
  const bubbleHtml = (m) => `<div class="bubble ${m.sender === 'operator' ? 'mine' : 'theirs'}">
    <div class="who">${m.sender === 'operator' ? 'Ви' : 'Клієнт'} · ${esc(m.created_at)}</div>${esc(m.body)}</div>`;

  async function renderChat() {
    $('#view').innerHTML = `
      <div class="chat-admin">
        <div class="conv-list" id="convList"></div>
        <div class="thread">
          <div class="thread-body" id="threadBody"><div class="muted">Оберіть діалог зліва.</div></div>
          <form class="reply-form" id="replyForm" hidden>
            <input class="input" id="replyInput" maxlength="1000" placeholder="Відповідь клієнту" autocomplete="off">
            <button class="btn btn-primary" type="submit">Надіслати</button>
          </form>
        </div>
      </div>`;
    const convs = await api('/api/admin/conversations');
    $('#convList').innerHTML = convs.length
      ? convs.map((c) => `<button class="conv ${c.id === currentConv ? 'active' : ''}" type="button" data-conv="${c.id}">
          <b>Діалог ${esc(c.id.slice(0, 6))}</b><span>${esc(c.last_body || '')}</span></button>`).join('')
      : '<div class="muted" style="padding:12px">Звернень ще немає.</div>';
    if (currentConv) await openConv(currentConv);
  }

  async function openConv(id) {
    currentConv = id;
    const msgs = await api(`/api/admin/conversations/${id}/messages`);
    $('#threadBody').innerHTML = msgs.length ? msgs.map(bubbleHtml).join('') : '<div class="muted">Повідомлень ще немає.</div>';
    $('#replyForm').hidden = false;
    document.querySelectorAll('.conv').forEach((b) => b.classList.toggle('active', b.dataset.conv === id));
    $('#threadBody').scrollTop = 1e9;
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?admin=${encodeURIComponent(token)}`);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'message') {
        if (m.conversationId === currentConv && $('#threadBody') && $('#replyForm') && !$('#replyForm').hidden) {
          const empty = $('#threadBody .muted');
          if (empty) empty.remove();
          $('#threadBody').insertAdjacentHTML('beforeend', bubbleHtml(m.message));
          $('#threadBody').scrollTop = 1e9;
        } else if (m.message.sender === 'client') {
          notify('Нове повідомлення в чаті');
        }
      }
      if (m.type === 'error') notify(m.error, true);
    };
    ws.onclose = () => { if (token) setTimeout(connectWs, 3000); };
  }

  // ----- Розклад -----
  async function renderSchedule() {
    const rows = await api('/api/admin/schedule');
    $('#view').innerHTML = `
      <h3 style="margin-bottom:12px">Робочі години</h3>
      <table>
        <thead><tr><th>День</th><th>Початок</th><th>Кінець</th><th>Вихідний</th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-wd="${r.weekday}">
          <td>${DAYS[r.weekday]}</td>
          <td><input type="time" class="st" value="${r.start_time || '09:00'}"></td>
          <td><input type="time" class="et" value="${r.end_time || '18:00'}"></td>
          <td><input type="checkbox" class="off" ${r.start_time ? '' : 'checked'}></td>
        </tr>`).join('')}</tbody>
      </table>
      <button class="btn btn-primary" id="saveSchedule" type="button">Зберегти розклад</button>`;
    $('#saveSchedule').addEventListener('click', async () => {
      try {
        for (const tr of document.querySelectorAll('[data-wd]')) {
          const off = tr.querySelector('.off').checked;
          await api(`/api/admin/schedule/${tr.dataset.wd}`, {
            method: 'PUT',
            body: { start_time: off ? null : tr.querySelector('.st').value, end_time: off ? null : tr.querySelector('.et').value },
          });
        }
        notify('Розклад збережено');
      } catch (err) {
        notify(err.message, true);
      }
    });
  }

  // ----- Блокування -----
  async function renderBlocks() {
    $('#view').innerHTML = `
      <div class="toolbar"><label>Дата <input type="date" id="blockDate" value="${blockDate}"></label></div>
      <form class="inline-form" id="blockForm">
        <input type="time" name="start_time" required>
        <input type="time" name="end_time" required>
        <input name="note" placeholder="Причина (необов'язково)" maxlength="100">
        <button class="btn btn-primary small" type="submit">Додати блок</button>
      </form>
      <ul class="list" id="blockList"></ul>`;
    const list = await api(`/api/admin/blocks?date=${blockDate}`);
    $('#blockList').innerHTML = list.length
      ? list.map((b) => `<li><span>${b.start_time}–${b.end_time} ${esc(b.note)}</span>
          <button class="btn btn-ghost small" type="button" data-del-block="${b.id}">Видалити</button></li>`).join('')
      : '<li class="muted">Блоків на цю дату немає.</li>';
  }

  // ----- Послуги -----
  const serviceRow = (s) => `<tr>
    <td><input type="text" class="f-name" value="${esc(s.name)}"></td>
    <td><input type="text" class="f-desc" value="${esc(s.description)}"></td>
    <td><input type="number" class="f-dur" min="5" max="480" step="5" value="${s.duration_min}"></td>
    <td><input type="number" class="f-price" min="0" step="10" value="${s.price_uah}"></td>
    <td><input type="checkbox" class="f-active" ${s.active ? 'checked' : ''}></td>
    <td><button class="btn btn-ghost small" type="button" data-save-service="${s.id}">Зберегти</button></td>
  </tr>`;

  const readServiceRow = (row) => ({
    name: row.querySelector('.f-name').value,
    description: row.querySelector('.f-desc').value,
    duration_min: Number(row.querySelector('.f-dur').value),
    price_uah: Number(row.querySelector('.f-price').value),
    active: row.querySelector('.f-active').checked ? 1 : 0,
  });

  async function renderServices() {
    const list = await api('/api/admin/services');
    $('#view').innerHTML = `
      <table>
        <thead><tr><th>Назва</th><th>Опис</th><th>Хв</th><th>Ціна, грн</th><th>Активна</th><th></th></tr></thead>
        <tbody>${list.map(serviceRow).join('')}</tbody>
      </table>
      <h3 style="margin-bottom:8px">Нова послуга</h3>
      <form class="inline-form" id="serviceForm">
        <input name="name" placeholder="Назва" required maxlength="80">
        <input name="description" placeholder="Опис" maxlength="300">
        <input name="duration_min" type="number" min="5" max="480" step="5" placeholder="Хв" required>
        <input name="price_uah" type="number" min="0" step="10" placeholder="Ціна, грн" required>
        <button class="btn btn-primary small" type="submit">Додати</button>
      </form>`;
  }

  // ----- Делегування подій для вкладок -----
  const view = $('#view');

  view.addEventListener('change', async (e) => {
    try {
      if (e.target.id === 'apptDate') {
        appointmentDate = e.target.value;
        await renderAppointments();
      } else if (e.target.id === 'blockDate') {
        blockDate = e.target.value;
        await renderBlocks();
      } else if (e.target.dataset.appt) {
        try {
          await api(`/api/admin/appointments/${e.target.dataset.appt}`, { method: 'PATCH', body: { status: e.target.value } });
        } catch (err) {
          await renderAppointments(); // повертаємо у списку справжній статус
          throw err;
        }
        notify('Статус збережено');
      }
    } catch (err) {
      notify(err.message, true);
    }
  });

  view.addEventListener('click', async (e) => {
    try {
      const conv = e.target.closest('[data-conv]');
      if (conv) return await openConv(conv.dataset.conv);

      if (e.target.dataset.delBlock) {
        await api(`/api/admin/blocks/${e.target.dataset.delBlock}`, { method: 'DELETE' });
        notify('Блок видалено');
        return await renderBlocks();
      }

      if (e.target.dataset.saveService) {
        const row = e.target.closest('tr');
        await api(`/api/admin/services/${e.target.dataset.saveService}`, { method: 'PATCH', body: readServiceRow(row) });
        notify('Послугу збережено');
      }
    } catch (err) {
      notify(err.message, true);
    }
  });

  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    try {
      if (form.id === 'blockForm') {
        await api('/api/admin/blocks', {
          method: 'POST',
          body: { date: blockDate, start_time: data.start_time, end_time: data.end_time, note: data.note },
        });
        notify('Блок додано');
        return await renderBlocks();
      }

      if (form.id === 'serviceForm') {
        await api('/api/admin/services', {
          method: 'POST',
          body: {
            name: data.name,
            description: data.description,
            duration_min: Number(data.duration_min),
            price_uah: Number(data.price_uah),
          },
        });
        notify('Послугу додано');
        return await renderServices();
      }

      if (form.id === 'replyForm') {
        const input = $('#replyInput');
        const body = input.value.trim();
        if (!body || !currentConv || !ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: 'reply', conversationId: currentConv, body }));
        input.value = '';
      }
    } catch (err) {
      notify(err.message, true);
    }
  });

  // Початковий стан: якщо токен уже є в сесії, одразу заходимо
  if (token) {
    api('/api/admin/services').then(start).catch(() => {});
  }
})();
