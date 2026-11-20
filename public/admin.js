(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  const STATUS = { new: 'Нова', confirmed: 'Підтверджено', cancelled: 'Скасовано' };
  const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'];

  let token = sessionStorage.getItem('adminToken') || '';
  let ws = null;
  let currentConv = null;
  let blockDate = today();
  let clientQuery = '';
  let clientsArchived = false; // вкладка «Клієнти»: показувати архів замість активних
  let currentClient = null;
  const fmtDate = (d) => (d ? d.split('-').reverse().join('.') : '—');

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
    clients: renderClients,
    chat: renderChat,
    schedule: renderSchedule,
    blocks: renderBlocks,
    services: renderServices,
    studio: renderStudio,
    reviews: renderReviews,
  };

  function show(name) {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'clients') currentClient = null; // вкладка завжди відкривається зі списку
    views[name]().catch((e) => notify(e.message, true));
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  // ----- Записи -----
  // Вкладка показує поточні й майбутні записи. Минулі не видаляються: вони в архіві
  let apptArchive = false;
  const shiftDay = (s, n) => {
    const d = new Date(s + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };

  async function renderAppointments() {
    const [from, to] = apptArchive ? ['2000-01-01', shiftDay(today(), -1)] : [today(), '2999-12-31'];
    $('#view').innerHTML = `
      <div class="toolbar">
        <button class="btn ${apptArchive ? 'btn-ghost' : 'btn-primary'} small" type="button" id="apptUpcoming">Поточні і майбутні</button>
        <button class="btn ${apptArchive ? 'btn-primary' : 'btn-ghost'} small" type="button" id="apptArchiveBtn">Архів</button>
      </div>
      <table>
        <thead><tr><th>Дата</th><th>Час</th><th>Послуга</th><th>Клієнт</th><th>Телефон</th><th>Коментар клієнта</th><th>Статус</th></tr></thead>
        <tbody id="apptRows"></tbody>
      </table>`;
    let rows = await api(`/api/admin/appointments?from=${from}&to=${to}`);
    if (apptArchive) rows = rows.slice().reverse(); // в архіві найновіші зверху
    $('#apptRows').innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtDate(r.date)}</td>
          <td>${r.start_time}–${r.end_time}</td>
          <td>${esc(r.service)}</td>
          <td>${esc(r.client_name)}</td>
          <td>${esc(r.client_phone)}</td>
          <td>${esc(r.client_comment || '—')}</td>
          <td><select data-appt="${r.id}">${Object.entries(STATUS)
            .map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v}</option>`).join('')}</select>${apptArchive && r.status !== 'cancelled' ? ` <button class="btn btn-ghost small" type="button" data-review-link="${r.id}" title="Скопіювати посилання на форму відгуку">Відгук</button>` : ''}</td>
        </tr>`).join('')
      : `<tr><td colspan="6" class="muted">${apptArchive ? 'В архіві поки немає записів.' : 'Поточних і майбутніх записів немає.'}</td></tr>`;
  }

  // ----- Клієнти -----
  async function renderClients() {
    const arch = await api('/api/admin/archive-months');
    const archiveOpts = arch.options.map((m) => '<option value="' + m + '"' + (m === arch.months ? ' selected' : '') + '>' + m + ' міс.</option>').join('');
    $('#view').innerHTML = `
      <div class="toolbar">
        <input type="search" id="clientSearch" placeholder="Пошук: імʼя або телефон" value="${esc(clientQuery)}" style="flex:1;max-width:340px">
        <button class="btn btn-ghost small" type="button" id="clientsCsv">Вивантажити в CSV</button>
      </div>
      <div class="toolbar">
        <button class="btn ${clientsArchived ? 'btn-ghost' : 'btn-primary'} small" type="button" id="clientsActiveBtn">Активні</button>
        <button class="btn ${clientsArchived ? 'btn-primary' : 'btn-ghost'} small" type="button" id="clientsArchiveBtn">Архів</button>
        <label class="muted" style="margin-left:auto">В архів, якщо без змін понад <select id="archiveMonths">${archiveOpts}</select></label>
      </div>
      <table>
        <thead><tr><th>Імʼя</th><th>Телефон</th><th>Візитів</th><th>Останній візит</th><th>Наступний запис</th><th>Нотатка</th><th></th></tr></thead>
        <tbody id="clientRows"></tbody>
      </table>`;
    let timer = null;
    $('#clientSearch').addEventListener('input', (e) => {
      clientQuery = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(() => loadClients().catch((err) => notify(err.message, true)), 250);
    });
    await loadClients();
  }

  async function loadClients() {
    const q = clientQuery;
    const list = await api('/api/admin/clients?q=' + encodeURIComponent(q) + (clientsArchived ? '&archived=1' : ''));
    if (q !== clientQuery || !$('#clientRows')) return; // запит застарів або вкладку вже змінено
    $('#clientRows').innerHTML = list.length
      ? list.map((c) => `<tr>
          <td><button class="link" type="button" data-client="${c.key}">${esc(c.name)}</button></td>
          <td>${esc(c.phone)}</td>
          <td>${c.visits}</td>
          <td>${fmtDate(c.last_visit)}</td>
          <td>${fmtDate(c.next_visit)}</td>
          <td>${c.has_note ? 'є' : '—'}</td>
          <td>${c.archived ? '<button class="btn btn-ghost small" type="button" data-restore="' + c.key + '">Повернути</button>' : ''}</td>
        </tr>`).join('')
      : `<tr><td colspan="7" class="muted">${q ? 'Нікого не знайдено.' : clientsArchived ? 'В архіві нікого немає.' : 'Клієнтів ще немає: вони зʼявляться після першого запису.'}</td></tr>`;
  }

  async function renderClient(key) {
    const c = await api('/api/admin/clients/' + key);
    currentClient = key;
    const done = c.appointments.filter((a) => a.status !== 'cancelled' && a.date < today()).length;
    $('#view').innerHTML = `
      <button class="btn btn-ghost small" type="button" id="clientBack">← До списку клієнтів</button>
      <h3 style="margin:16px 0 4px">${esc(c.name)}</h3>
      <div class="muted">${esc(c.phone)} · візитів: ${done} · усього записів: ${c.appointments.length}</div>

      <label class="step-label" for="clientNote" style="margin-top:20px">Загальна нотатка про клієнта</label>
      <textarea id="clientNote" class="input" rows="4" maxlength="5000" placeholder="Особливості, рекомендації, домовленості">${esc(c.note)}</textarea>
      <button class="btn btn-primary small" type="button" id="saveClientNote">Зберегти нотатку</button>

      <h3 style="margin:28px 0 8px">Історія записів</h3>
      <table>
        <thead><tr><th>Дата</th><th>Час</th><th>Послуга</th><th>Статус</th><th style="width:38%">Нотатка до візиту</th><th></th></tr></thead>
        <tbody>${c.appointments.map((a) => `<tr>
          <td>${fmtDate(a.date)}</td>
          <td>${a.start_time}–${a.end_time}</td>
          <td>${esc(a.service)}</td>
          <td>${STATUS[a.status] || esc(a.status)}</td>
          <td><input type="text" maxlength="5000" value="${esc(a.note)}" placeholder="Що робили" aria-label="Нотатка до візиту ${fmtDate(a.date)}"></td>
          <td><button class="btn btn-ghost small" type="button" data-save-visit-note="${a.id}">Зберегти</button></td>
        </tr>`).join('')}</tbody>
      </table>`;
  }

  async function downloadClientsCsv() {
    const r = await fetch('/api/admin/clients.csv', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Не вдалося вивантажити файл');
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `clients-${today()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ----- Чат -----
  // База зберігає час за UTC ("2026-11-18 10:05:00"); показуємо його за часом комп'ютера, тобто за Києвом
  const localTime = (s) => {
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return s;
    const sameDay = d.toDateString() === new Date().toDateString();
    return d.toLocaleString('uk-UA', sameDay ? { hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const bubbleHtml = (m) => `<div class="bubble ${m.sender === 'operator' ? 'mine' : 'theirs'}"><div class="who">${m.sender === 'operator' ? 'Ви' : 'Клієнт'} · ${esc(localTime(m.created_at))}</div>${esc(m.body)}</div>`;

  async function renderChat() {
    $('#view').innerHTML = `
      <div class="chat-admin">
        <div class="conv-list" id="convList"></div>
        <div class="thread">
          <div class="thread-head" id="threadHead" hidden>
            <b id="threadTitle"></b>
            <button class="btn btn-ghost small danger" type="button" id="deleteConv">Видалити діалог</button>
          </div>
          <div class="thread-body" id="threadBody"><div class="muted">Оберіть діалог у списку.</div></div>
          <form class="reply-form" id="replyForm" hidden>
            <input class="input" id="replyInput" maxlength="1000" placeholder="Відповідь клієнту" autocomplete="off">
            <button class="btn btn-primary" type="submit">Надіслати</button>
          </form>
        </div>
      </div>`;
    await refreshConvList();
    if (currentConv) await openConv(currentConv);
  }

  async function refreshConvList() {
    const convs = await api('/api/admin/conversations');
    if (!$('#convList')) return;
    $('#convList').innerHTML = convs.length
      ? convs.map((c) => `<button class="conv ${c.id === currentConv ? 'active' : ''}" type="button" data-conv="${c.id}">
          <b>Діалог ${esc(c.id.slice(0, 6))}</b><span>${esc(c.last_body || '')}</span></button>`).join('')
      : '<div class="muted" style="padding:12px">Звернень ще немає.</div>';
  }

  async function openConv(id) {
    currentConv = id;
    const msgs = await api(`/api/admin/conversations/${id}/messages`);
    $('#threadBody').innerHTML = msgs.length ? msgs.map(bubbleHtml).join('') : '<div class="muted">Повідомлень ще немає.</div>';
    $('#replyForm').hidden = false;
    $('#threadHead').hidden = false;
    $('#threadTitle').textContent = 'Діалог ' + id.slice(0, 6);
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
        // Новий діалог або нове повідомлення: оновлюємо список зліва, якщо вкладка чату відкрита
        if ($('#convList')) refreshConvList().catch(() => {});
      }
      if (m.type === 'conversation_deleted') {
        // Діалог видалено (можливо, з іншого вікна адмінки): оновлюємо список, якщо вкладка чату відкрита
        if (m.conversationId === currentConv) currentConv = null;
        if ($('#convList')) renderChat().catch((e) => notify(e.message, true));
      }
      if (m.type === 'error') notify(m.error, true);
    };
    ws.onclose = () => { if (token) setTimeout(connectWs, 3000); };
  }

  // ----- Розклад -----
  async function renderSchedule() {
    const rows = await api('/api/admin/schedule');
    const { minutes: bufferMin } = await api('/api/admin/buffer');
    const { hours: changeHours, options: changeOptions } = await api('/api/admin/change-hours');
    const changeOpts = changeOptions.map((h) => `<option value="${h}" ${h === changeHours ? 'selected' : ''}>${h} год</option>`).join('');
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
      <button class="btn btn-primary" id="saveSchedule" type="button">Зберегти розклад</button>

      <h3 style="margin:32px 0 6px">Прибирання між клієнтами</h3>
      <div class="muted">Цей час резервується після кожного візиту, щоб лишився час прибрати робоче місце. Клієнти на нього не запишуться.</div>
      <form class="inline-form" id="bufferForm">
        <label>Після кожного візиту <select name="minutes" id="bufferMinutes">${[0, 15, 30, 45, 60].map((m) => `<option value="${m}" ${m === bufferMin ? 'selected' : ''}>${m ? m + ' хв' : 'не резервувати'}</option>`).join('')}</select></label>
        <button class="btn btn-primary small" type="submit">Зберегти прибирання</button>
      </form>

      <h3 style="margin:32px 0 6px">Скасування і перенесення клієнтом</h3>
      <div class="muted">За скільки годин до візиту клієнт може сам скасувати чи перенести запис у своєму кабінеті. Пізніше він має писати оператору в чат.</div>
      <form class="inline-form" id="changeHoursForm">
        <label>Не пізніше ніж за <select name="hours" id="changeHoursSelect">${changeOpts}</select></label>
        <button class="btn btn-primary small" type="submit">Зберегти</button>
      </form>

      <h3 style="margin:32px 0 6px">Перерви</h3>
      <div class="muted">Перерва повторюється щотижня у позначені дні. На цей час клієнти записатися не зможуть.</div>
      <form class="inline-form" id="breakForm">
        <span class="day-checks">${rows.map((r) => `<label><input type="checkbox" name="wd" value="${r.weekday}" ${r.start_time ? 'checked' : ''}> ${DAYS_SHORT[r.weekday]}</label>`).join('')}</span>
        <label>з <input type="time" name="start_time" value="13:00" required></label>
        <label>до <input type="time" name="end_time" value="14:00" required></label>
        <input name="note" value="Обід" placeholder="Назва" maxlength="60">
        <button class="btn btn-primary small" type="submit">Додати перерву</button>
      </form>
      <ul class="list" id="breakList"></ul>`;
    await renderBreaks();
    $('#changeHoursForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/change-hours', { method: 'PUT', body: { hours: Number($('#changeHoursSelect').value) } });
        notify('Збережено');
      } catch (err) {
        notify(err.message, true);
      }
    });
    $('#bufferForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/buffer', { method: 'PUT', body: { minutes: Number($('#bufferMinutes').value) } });
        notify('Прибирання збережено');
      } catch (err) {
        notify(err.message, true);
      }
    });
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

  // Список перерв. Однакові перерви в різні дні показуються одним рядком.
  async function renderBreaks() {
    const list = await api('/api/admin/breaks');
    const groups = new Map();
    for (const b of list) {
      const key = `${b.start_time}|${b.end_time}|${b.note}`;
      if (!groups.has(key)) groups.set(key, { ...b, days: [], ids: [] });
      groups.get(key).days.push(b.weekday);
      groups.get(key).ids.push(b.id);
    }
    $('#breakList').innerHTML = groups.size
      ? [...groups.values()].map((g) => `<li>
          <span><b>${g.start_time}–${g.end_time}</b> ${esc(g.note)} <span class="muted">· ${g.days.sort().map((d) => DAYS_SHORT[d]).join(', ')}</span></span>
          <button class="btn btn-ghost small" type="button" data-del-break="${g.ids.join(',')}">Видалити</button></li>`).join('')
      : '<li class="muted">Перерв ще немає.</li>';
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
    <td><input type="text" class="f-note" maxlength="60" value="${esc(s.price_note)}" placeholder="напр. від 1380 грн"></td>
    <td><input type="checkbox" class="f-active" ${s.active ? 'checked' : ''}></td>
    <td><button class="btn btn-ghost small" type="button" data-save-service="${s.id}">Зберегти</button></td>
  </tr>`;

  const readServiceRow = (row) => ({
    name: row.querySelector('.f-name').value,
    description: row.querySelector('.f-desc').value,
    duration_min: Number(row.querySelector('.f-dur').value),
    price_uah: Number(row.querySelector('.f-price').value),
    price_note: row.querySelector('.f-note').value,
    active: row.querySelector('.f-active').checked ? 1 : 0,
  });

  async function renderServices() {
    const list = await api('/api/admin/services');
    $('#view').innerHTML = `
      <table>
        <thead><tr><th>Назва</th><th>Опис</th><th>Хв</th><th>Ціна, грн</th><th>Орієнтовна ціна (текст)</th><th>Активна</th><th></th></tr></thead>
        <tbody>${list.map(serviceRow).join('')}</tbody>
      </table>
      <h3 style="margin-bottom:8px">Нова послуга</h3>
      <form class="inline-form" id="serviceForm">
        <input name="name" placeholder="Назва" required maxlength="80">
        <input name="description" placeholder="Опис" maxlength="300">
        <input name="duration_min" type="number" min="5" max="480" step="5" placeholder="Хв" required>
        <input name="price_uah" type="number" min="0" step="10" placeholder="Ціна, грн" required>
        <input name="price_note" maxlength="60" placeholder="Орієнтовна ціна (необов'язково)">
        <button class="btn btn-primary small" type="submit">Додати</button>
      </form>`;
  }

  // ----- Відгуки -----
  const REVIEW_STATUS = { pending: 'Чекає схвалення', approved: 'На сайті', hidden: 'Приховано' };
  async function renderReviews() {
    const list = await api('/api/admin/reviews');
    const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
    $('#view').innerHTML =
      '<p class="muted">Наступного дня після візиту бот надсилає клієнту посилання на відгук (якщо клієнт підключив Telegram). ' +
      'На сайті видно лише відгуки зі статусом «На сайті». Посилання можна взяти й самому: «Записи» → «Архів» → «Відгук».</p>' +
      '<table><thead><tr><th>Дата</th><th>Клієнт</th><th>Послуга</th><th>Оцінка</th><th style="width:38%">Текст</th><th>Статус</th><th></th></tr></thead><tbody>' +
      (list.length ? list.map((r) => '<tr>' +
        '<td>' + fmtDate(r.date) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.service) + '</td>' +
        '<td class="review-stars" aria-label="' + r.rating + ' з 5">' + stars(r.rating) + '</td>' +
        '<td>' + (esc(r.text) || '<span class="muted">без тексту</span>') + '</td>' +
        '<td><select data-review-status="' + r.id + '">' + Object.entries(REVIEW_STATUS).map(([k, v]) => '<option value="' + k + '"' + (k === r.status ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></td>' +
        '<td><button class="btn btn-ghost small danger" type="button" data-del-review="' + r.id + '">Видалити</button></td></tr>').join('')
        : '<tr><td colspan="7" class="muted">Відгуків поки немає.</td></tr>') +
      '</tbody></table>';
  }

  // ----- Кабінет: назва, адреса, телефон для сайту -----
  async function renderStudio() {
    const s = await api('/api/admin/studio');
    const field = (name, label, max, hint = '') => `
      <label class="studio-field">
        <span>${label}</span>
        <input name="${name}" value="${esc(s[name])}" maxlength="${max}" ${name === 'name' ? 'required' : ''}>
        ${hint ? `<small class="muted">${hint}</small>` : ''}
      </label>`;
    const area = (name, label, max, rows, hint = '') => `
      <label class="studio-field">
        <span>${label}</span>
        <textarea name="${name}" maxlength="${max}" rows="${rows}">${esc(s[name])}</textarea>
        ${hint ? `<small class="muted">${hint}</small>` : ''}
      </label>`;
    const PROMO_HINT = 'Перший рядок це заголовок, далі опис. Порожнє поле ховає картку на сайті.';
    $('#view').innerHTML = `
      <form id="studioForm" class="studio-form">
        <h3 class="studio-group">Основне</h3>
        ${field('name', 'Назва кабінету', 80)}
        ${field('tagline', 'Підзаголовок над головним заголовком', 120)}
        <h3 class="studio-group">Контакти й карта</h3>
        ${field('city', 'Місто', 80, 'Потрібне, щоб карта знайшла правильну вулицю')}
        ${field('address', 'Адреса', 200)}
        ${field('phone', 'Телефон', 40, 'На сайті стає посиланням: з телефона по ньому можна одразу подзвонити')}
        ${field('site_url', 'Адреса сайту, наприклад https://podology.example.ua', 200, 'Потрібна для посилань у Telegram: відгуки, повторний візит, список очікування')}
        ${field('review_url', 'Посилання «Залишити відгук у Google»', 300, 'Google Профіль компанії → «Попросити відгуки» → скопіювати посилання. Порожнє поле ховає кнопку.')}
        <h3 class="studio-group">Акції</h3>
        ${area('promo_first', 'Знижка на перший візит', 400, 3, PROMO_HINT + ' Заголовок також показується плашкою на початку сторінки.')}
        ${area('promo_friend', '«Приведи друга»', 400, 3, PROMO_HINT)}
        ${area('promo_gift', 'Подарункові сертифікати', 400, 3, PROMO_HINT)}
        ${area('partners', 'Для лікарів і салонів (співпраця)', 600, 3, PROMO_HINT)}
        <h3 class="studio-group">Про майстра</h3>
        ${field('master_name', "Ім'я майстра", 80, 'Порожнє поле разом з порожнім описом ховає блок')}
        ${area('master_about', 'Про майстра: досвід, навчання, сертифікати', 2000, 5)}
        ${field('stat_years', 'Років досвіду (лише число)', 6, 'Порожнє поле ховає лічильник на сайті')}
        ${field('stat_clients', 'Задоволених клієнтів (лише число)', 6, 'Порожнє поле ховає лічильник на сайті')}
        <h3 class="studio-group">Питання й відповіді</h3>
        ${area('faq', 'Питання й відповіді', 6000, 14, 'Кожне питання окремим блоком через порожній рядок. Перший рядок блоку це питання, далі відповідь.')}
        <button class="btn btn-primary small" type="submit">Зберегти</button>
      </form>
      <h3 class="tg-title">Сповіщення в Telegram</h3>
      <div id="tgBox"></div>`;
    await renderTelegram();
  }

  async function renderTelegram() {
    const t = await api('/api/admin/telegram');
    $('#tgBox').innerHTML = `
      <p class="tg-state ${t.configured ? 'ok' : ''}">${t.configured
        ? 'Увімкнено: бот пише вам про кожен новий запис і нове питання в чаті.'
        : 'Вимкнено. Налаштування займає близько 3 хвилин.'}</p>
      <ol class="tg-steps">
        <li>У Telegram відкрийте <b>@BotFather</b>, надішліть <code>/newbot</code>, придумайте боту назву й ім'я, що закінчується на <code>bot</code>. BotFather надішле токен: довгий рядок на зразок <code>1234567890:AAH…</code></li>
        <li>Вставте токен нижче.</li>
        <li>Знайдіть свого нового бота в Telegram і натисніть «Start» (або напишіть йому будь-що).</li>
        <li>Натисніть «Знайти мій чат», потім «Зберегти» і «Надіслати тест».</li>
      </ol>
      <form id="tgForm" class="studio-form">
        <label class="studio-field"><span>Токен бота</span>
          <input name="token" autocomplete="off" spellcheck="false" placeholder="${t.hasToken ? 'Збережено: ' + esc(t.tokenHint) + ' (залиште порожнім, щоб не змінювати)' : '1234567890:AAH…'}">
        </label>
        <label class="studio-field"><span>Номер чату</span>
          <input name="chatId" value="${esc(t.chatId)}" inputmode="numeric" placeholder="Заповниться кнопкою «Знайти мій чат»">
          <small class="muted" id="tgFound"></small>
        </label>
        <div class="tg-actions">
          <button class="btn btn-ghost small" type="button" id="tgDetect">Знайти мій чат</button>
          <button class="btn btn-primary small" type="submit">Зберегти</button>
          <button class="btn btn-ghost small" type="button" id="tgTest" ${t.configured ? '' : 'disabled'}>Надіслати тест</button>
          ${t.hasToken ? '<button class="btn btn-ghost small danger" type="button" id="tgOff">Вимкнути</button>' : ''}
        </div>
      </form>`;
  }

  // ----- Делегування подій для вкладок -----
  const view = $('#view');

  view.addEventListener('change', async (e) => {
    try {
      if (e.target.id === 'archiveMonths') {
        await api('/api/admin/archive-months', { method: 'PUT', body: { months: Number(e.target.value) } });
        notify('Збережено');
        return await loadClients();
      }
      if (e.target.dataset.reviewStatus) {
        await api('/api/admin/reviews/' + e.target.dataset.reviewStatus, { method: 'PATCH', body: { status: e.target.value } });
        return notify('Статус відгуку змінено');
      }
      if (e.target.id === 'blockDate') {
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
      if (e.target.id === 'apptUpcoming' || e.target.id === 'apptArchiveBtn') {
        apptArchive = e.target.id === 'apptArchiveBtn';
        return await renderAppointments();
      }
      const conv = e.target.closest('[data-conv]');
      if (conv) return await openConv(conv.dataset.conv);

      if (e.target.dataset.client) return await renderClient(e.target.dataset.client);

      if (e.target.id === 'clientBack') {
        currentClient = null;
        return await renderClients();
      }

      if (e.target.id === 'clientsCsv') return await downloadClientsCsv();
      if (e.target.dataset.delReview) {
        if (!confirm('Видалити відгук назавжди?')) return;
        await api('/api/admin/reviews/' + e.target.dataset.delReview, { method: 'DELETE' });
        return await renderReviews();
      }
      if (e.target.dataset.reviewLink) {
        const { link } = await api('/api/admin/appointments/' + e.target.dataset.reviewLink + '/review-link');
        try {
          await navigator.clipboard.writeText(link);
          return notify('Посилання на відгук скопійовано');
        } catch (err) {
          return prompt('Скопіюйте посилання на відгук:', link);
        }
      }
      if (e.target.id === 'clientsActiveBtn' || e.target.id === 'clientsArchiveBtn') {
        clientsArchived = e.target.id === 'clientsArchiveBtn';
        return await renderClients();
      }
      if (e.target.dataset.restore) {
        await api('/api/admin/clients/' + e.target.dataset.restore + '/restore', { method: 'POST' });
        notify('Клієнта повернуто з архіву');
        return await loadClients();
      }

      if (e.target.id === 'saveClientNote') {
        await api(`/api/admin/clients/${currentClient}/note`, { method: 'PUT', body: { note: $('#clientNote').value } });
        return notify('Нотатку збережено');
      }

      if (e.target.dataset.saveVisitNote) {
        const input = e.target.closest('tr').querySelector('input');
        await api(`/api/admin/appointments/${e.target.dataset.saveVisitNote}/note`, { method: 'PUT', body: { note: input.value } });
        return notify('Нотатку до візиту збережено');
      }

      if (e.target.id === 'tgDetect') {
        e.target.disabled = true;
        try {
          const { chats } = await api('/api/admin/telegram/detect', { method: 'POST', body: { token: $('#tgForm [name=token]').value } });
          if (!chats.length) return notify('Бот ще не отримав жодного повідомлення. Напишіть йому в Telegram і натисніть ще раз', true);
          const last = chats[chats.length - 1];
          $('#tgForm [name=chatId]').value = last.id;
          $('#tgFound').textContent = `Знайдено чат: ${last.name}. Тепер натисніть «Зберегти».`;
          return;
        } finally {
          e.target.disabled = false;
        }
      }

      if (e.target.id === 'tgTest') {
        e.target.disabled = true;
        try {
          await api('/api/admin/telegram/test', { method: 'POST' });
          return notify('Тест надіслано. Перевірте Telegram');
        } finally {
          e.target.disabled = false;
        }
      }

      if (e.target.id === 'tgOff') {
        if (!confirm('Вимкнути сповіщення й видалити збережений токен бота?')) return;
        await api('/api/admin/telegram', { method: 'DELETE' });
        notify('Сповіщення вимкнено');
        return await renderTelegram();
      }

      if (e.target.id === 'deleteConv') {
        if (!currentConv) return;
        if (!confirm('Видалити цей діалог і всі його повідомлення? Відновити їх буде неможливо.')) return;
        const id = currentConv;
        currentConv = null;
        await api(`/api/admin/conversations/${id}`, { method: 'DELETE' });
        notify('Діалог видалено');
        return await renderChat();
      }

      if (e.target.dataset.delBlock) {
        await api(`/api/admin/blocks/${e.target.dataset.delBlock}`, { method: 'DELETE' });
        notify('Блок видалено');
        return await renderBlocks();
      }

      if (e.target.dataset.delBreak) {
        for (const id of e.target.dataset.delBreak.split(',')) {
          await api(`/api/admin/breaks/${id}`, { method: 'DELETE' });
        }
        notify('Перерву видалено');
        return await renderBreaks();
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
      if (form.id === 'breakForm') {
        const weekdays = [...form.querySelectorAll('input[name="wd"]:checked')].map((x) => Number(x.value));
        const r = await api('/api/admin/breaks', {
          method: 'POST',
          body: { weekdays, start_time: data.start_time, end_time: data.end_time, note: data.note },
        });
        await renderBreaks();
        if (!r.added) return notify('Така перерва вже є');
        if (r.clashes > 0) {
          return notify(`Перерву додано. Увага: на цей час уже є записів: ${r.clashes}. Вони залишаються чинними, перевірте їх у вкладці «Записи».`, true);
        }
        return notify('Перерву додано');
      }

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
            price_note: data.price_note || '',
          },
        });
        notify('Послугу додано');
        return await renderServices();
      }

      if (form.id === 'studioForm') {
        await api('/api/admin/studio', { method: 'PUT', body: data });
        notify('Збережено. На сайті зміни видно після оновлення сторінки');
        return await renderStudio();
      }

      if (form.id === 'tgForm') {
        await api('/api/admin/telegram', { method: 'PUT', body: data });
        notify('Збережено. Натисніть «Надіслати тест», щоб перевірити');
        return await renderTelegram();
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
