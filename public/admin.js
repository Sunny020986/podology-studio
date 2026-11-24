(() => {
  const $ = (s) => document.querySelector(s);
  // Телефон: кожна таблиця адмінки стає картками. Підпис клітинки береться із заголовка колонки.
  const cardifyTables = (root) => {
    root.querySelectorAll('table').forEach((t) => {
      if (t.querySelector('.hours-head') || (t.classList.contains('card-table') && !t.classList.contains('auto-cards'))) return;
      const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      if (!heads.length) return;
      t.classList.add('card-table', 'auto-cards');
      t.querySelectorAll('tbody tr').forEach((tr) => {
        [...tr.children].forEach((td, i) => {
          if (td.dataset.cv || td.colSpan > 1) return;
          td.dataset.cv = '1';
          if (!heads[i]) return;
          td.dataset.label = heads[i];
          // Вміст клітинки — в одну обгортку, щоб підпис і значення стояли поруч
          const box = document.createElement('div');
          box.className = 'cv';
          while (td.firstChild) box.appendChild(td.firstChild);
          td.appendChild(box);
        });
      });
    });
  };
  new MutationObserver(() => { const v = document.getElementById('view'); if (v) cardifyTables(v); })
    .observe(document.documentElement, { childList: true, subtree: true });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  const STATUS = { new: 'Нова', confirmed: 'Підтверджено', done: 'Відбувся', no_show: 'Не прийшов', cancelled: 'Скасовано' };
  const AFTER_START = ['done', 'no_show'];
  // Чи почався запис: «Відбувся» і «Не прийшов» доступні лише після цього
  const started = (a) => {
    const d = new Date();
    const now = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return a.date < today() || (a.date === today() && a.start_time <= now);
  };
  const statusOptions = (a) => Object.entries(STATUS)
    .filter(([k]) => started(a) || !AFTER_START.includes(k) || k === a.status)
    .map(([k, v]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${v}</option>`).join('');
  // Позначка, якщо клієнт не прийшов 2 і більше разів поспіль
  const noShowBadge = (n) => (n >= 2 ? ` <span class="badge-warn" title="Клієнт не прийшов ${n} рази поспіль">⚠ неявок поспіль: ${n}</span>` : '');
  // Відповідь клієнта кнопками під нагадуванням у Telegram
  const clientMarks = (a) => (a.client_declined_at
    ? ' <span class="badge-warn" title="Клієнт натиснув у Telegram, що не прийде. Запис не скасовано: скасуйте його, щоб звільнити час">⚠ попередив, що не прийде</span>'
    : a.client_confirmed_at ? ' <span class="badge-ok" title="Клієнт підтвердив візит кнопкою в Telegram">✓ підтвердив візит</span>' : '');
  const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'];

  let token = sessionStorage.getItem('adminToken') || '';
  let ws = null;
  let currentConv = null;
  let blockDate = today();
  let clientQuery = '';
  let clientsArchived = false; // вкладка «Клієнти»: показувати архів замість активних
  let currentClient = null;
  let currentClientData = null; // картка відкритого клієнта (для «Записати» та інших дій)
  // Хто увійшов: суперадмін (керує всім) або майстер (бачить лише своє)
  let me = { role: 'super' };
  let masters = [];          // для суперадміна: усі майстри для вибору у вкладках
  let apptMaster = '';       // «Записи»: фільтр за майстром ('' = усі)
  let schedMaster = null;    // «Розклад»: чий графік (години, перерви, блокування) редагуємо
  let statsMaster = '';      // «Статистика»: '' = увесь кабінет
  const MASTER_TABS = ['appointments', 'clients', 'schedule'];
  const isSuper = () => me.role === 'super';
  // Майстер, чий графік показуємо: для майстра це він сам, для суперадміна — обраний (або перший)
  const schedMasterId = () => (isSuper() ? (schedMaster || masters.find((m) => m.status === 'active')?.id || masters[0]?.id) : me.master.id);
  const schedQ = () => (isSuper() ? 'masterId=' + schedMasterId() : '');
  function masterSelect(id, value, allLabel) {
    if (!isSuper()) return '';
    return '<label>Майстер <select id="' + id + '">' + (allLabel ? '<option value="">' + allLabel + '</option>' : '') +
      masters.map((m) => '<option value="' + m.id + '"' + (String(m.id) === String(value) ? ' selected' : '') + '>' + esc(m.name) +
        (m.status === 'blocked' ? ' (заблоковано)' : '') + '</option>').join('') + '</select></label>';
  }
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
      await api('/api/admin/me');
      sessionStorage.setItem('adminToken', token);
      start();
    } catch (err) {
      $('#loginMsg').textContent = err.message;
    }
  });

  // Перемикач «Адміністратор / Майстер» на сторінці входу
  document.querySelectorAll('[data-login-mode]').forEach((b) => b.addEventListener('click', () => {
    const master = b.dataset.loginMode === 'master';
    document.querySelectorAll('[data-login-mode]').forEach((x) => x.classList.toggle('active', x === b));
    $('#loginForm').hidden = master;
    $('#masterLoginForm').hidden = !master;
  }));
  $('#masterLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await fetch('/api/master-login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: $('#mLogin').value, password: $('#mPass').value }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Не вдалося увійти');
      token = data.token;
      sessionStorage.setItem('adminToken', token);
      $('#mPass').value = '';
      start();
    } catch (err) {
      $('#mLoginMsg').textContent = err.message;
    }
  });

  $('#logoutBtn').addEventListener('click', () => {
    if (!isSuper()) fetch('/api/admin/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
    logout();
  });

  function logout() {
    token = '';
    sessionStorage.removeItem('adminToken');
    if (ws) ws.close();
    ws = null;
    $('#app').hidden = true;
    $('#login').hidden = false;
  }

  async function start() {
    try {
      me = await api('/api/admin/me');
      masters = isSuper() ? await api('/api/admin/masters') : [];
    } catch (err) {
      return;
    }
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#adminTitle').textContent = isSuper() ? 'Адмінка' : 'Адмінка · ' + me.master.name;
    // Майстрові показуємо лише його вкладки; чат лише для адміністратора
    document.querySelectorAll('[data-tab]').forEach((b) => { b.hidden = !(isSuper() || MASTER_TABS.includes(b.dataset.tab)); });
    connectWs(); // адміністратор: чат і записи наживо; майстер — лише події своїх записів
    renderMasterTg();
    renderMasterCal().catch(() => {});
    show('appointments');
  }

  // ----- Вкладки -----
  const views = {
    appointments: renderAppointments,
    clients: renderClients,
    chat: renderChat,
    schedule: renderSchedule,
    services: renderServices,
    materials: renderMaterials,
    certificates: renderCertificates,
    studio: renderStudio,
    reviews: renderReviews,
    stats: renderStats,
    tips: renderTips,
    masters: renderMasters,
  };

  function show(name) {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    const activeTab = document.querySelector('.tabs .active');
    if (activeTab && activeTab.parentElement.scrollWidth > activeTab.parentElement.clientWidth) activeTab.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (name === 'clients') currentClient = null; // вкладка завжди відкривається зі списку
    views[name]().catch((e) => notify(e.message, true));
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  // ----- Записи -----
  // Вкладка показує поточні й майбутні записи. Минулі не видаляються: вони в архіві
  let apptArchive = false;
  let apptWaitlist = false; // показати список очікування замість записів
  const shiftDay = (s, n) => {
    const d = new Date(s + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };

  const WAIT_STATUS = { waiting: 'Чекає', notified: 'Повідомлено' };
  async function renderWaitlist() {
    const list = await api('/api/admin/waitlist');
    $('#view').innerHTML = apptToolbar() +
      '<p class="muted">Клієнти, яким не вистачило вільного часу. Коли час звільняється, бот повідомляє першого в черзі. Якщо в клієнта немає Telegram, повідомлення приходить вам, щоб зателефонувати.</p>' +
      '<table><thead><tr><th>Дата</th><th>Послуга</th><th>Майстер</th><th>Клієнт</th><th>Телефон</th><th>Telegram</th><th>Статус</th><th></th></tr></thead><tbody>' +
      (list.length ? list.map((w) => '<tr><td>' + fmtDate(w.date) + '</td><td>' + esc(w.service) + '</td><td>' + esc(w.master || 'будь-хто') + '</td><td>' + esc(w.name) + '</td><td>' + esc(w.phone) + '</td>' +
        '<td>' + (w.telegram ? 'так' : '—') + '</td><td>' + (WAIT_STATUS[w.status] || esc(w.status)) + '</td>' +
        '<td><button class="btn btn-ghost small danger" type="button" data-del-wait="' + w.id + '">Прибрати</button></td></tr>').join('')
        : '<tr><td colspan="8" class="muted">У черзі нікого немає.</td></tr>') + '</tbody></table>';
    updateCloseDayCount();
  }
  const apptToolbar = () => `
      <div class="toolbar">
        <button class="btn btn-primary small" type="button" id="apptNew">+ Новий запис</button>
        <button class="btn btn-ghost small" type="button" id="apptCloseDay">Закрити день <span class="count-badge" id="closeDayCount" hidden></span></button>
        ${isSuper() ? '<button class="btn btn-ghost small" type="button" id="apptAbsence">Майстер не вийде</button>' : ''}
        <span class="seg" role="group" aria-label="Вигляд">
          <button class="btn ${apptView === 'table' ? 'btn-primary' : 'btn-ghost'} small" type="button" id="viewTable">Таблиця</button>
          <button class="btn ${apptView === 'day' ? 'btn-primary' : 'btn-ghost'} small" type="button" id="viewDay">День</button>
          <button class="btn ${apptView === 'week' ? 'btn-primary' : 'btn-ghost'} small" type="button" id="viewWeek">Тиждень</button>
        </span>
        ${apptView !== 'table' ? masterSelect('apptMaster', apptMaster, apptView === 'week' ? '' : 'Усі майстри') : ''}
      </div>
      ${apptView !== 'table' ? '' : `<div class="toolbar">
        <button class="btn ${!apptArchive && !apptWaitlist ? 'btn-primary' : 'btn-ghost'} small" type="button" id="apptUpcoming">Поточні і майбутні</button>
        <button class="btn ${apptArchive && !apptWaitlist ? 'btn-primary' : 'btn-ghost'} small" type="button" id="apptArchiveBtn">Архів</button>
        <button class="btn ${apptWaitlist ? 'btn-primary' : 'btn-ghost'} small" type="button" id="apptWaitBtn">Черга очікування</button>
        ${apptWaitlist ? '' : masterSelect('apptMaster', apptMaster, 'Усі майстри')}
      </div>`}`;

  let lastApptRows = [];
  async function renderAppointments() {
    if (closeDay) return renderCloseDay();
    if (absence) return renderAbsence();
    if (apptForm) return renderApptForm();
    if (apptView !== 'table') return renderCalendar();
    if (apptWaitlist) return renderWaitlist();
    const [from, to] = apptArchive ? ['2000-01-01', shiftDay(today(), -1)] : [today(), '2999-12-31'];
    $('#view').innerHTML = `${apptToolbar()}
      <table>
        <thead><tr><th>Дата</th><th>Час</th><th>Послуга</th>${isSuper() ? '<th>Майстер</th>' : ''}<th>Клієнт</th><th>Телефон</th><th>Коментар клієнта</th><th>Статус</th></tr></thead>
        <tbody id="apptRows"></tbody>
      </table>`;
    let rows = await api(`/api/admin/appointments?from=${from}&to=${to}` + (isSuper() && apptMaster ? '&masterId=' + apptMaster : ''));
    if (apptArchive) rows = rows.slice().reverse(); // в архіві найновіші зверху
    lastApptRows = rows;
    updateCloseDayCount();
    $('#apptRows').innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${fmtDate(r.date)}</td>
          <td>${r.start_time}–${r.end_time}</td>
          <td>${esc(r.service)}</td>
          ${isSuper() ? `<td>${esc(r.master || '—')}</td>` : ''}
          <td>${esc(r.client_name)}${noShowBadge(r.noshow_streak)}${r.status === 'new' || r.status === 'confirmed' ? clientMarks(r) : ''}</td>
          <td>${esc(r.client_phone)}</td>
          <td>${esc(r.client_comment || '—')}</td>
          <td><select data-appt="${r.id}">${statusOptions(r)}</select>${apptArchive && r.status !== 'cancelled' ? ` <button class="btn btn-ghost small" type="button" data-review-link="${r.id}" title="Скопіювати посилання на форму відгуку">Відгук</button>` : ''}${!apptArchive && r.status !== 'cancelled' ? ` <button class="btn btn-ghost small" type="button" data-move-appt="${r.id}">Перенести</button>` : ''}</td>
        </tr>`).join('')
      : `<tr><td colspan="8" class="muted">${apptArchive ? 'В архіві поки немає записів.' : 'Поточних і майбутніх записів немає.'}</td></tr>`;
  }

  // Кількість незакритих минулих записів на кнопці «Закрити день»
  async function updateCloseDayCount() {
    try {
      const { count } = await api('/api/admin/close-day/count' + (isSuper() && apptMaster ? '?masterId=' + apptMaster : ''));
      const b = $('#closeDayCount');
      if (b) { b.textContent = count; b.hidden = !count; }
    } catch { /* лічильник необов'язковий */ }
  }

  // ----- Друк розкладу: день (кожен майстер — окрема сторінка) або тиждень одного майстра -----
  let calPrintData = null;
  async function printSchedule() {
    const d = calPrintData;
    if (!d) return;
    const DAY_NAMES = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота', 'Неділя'];
    const studio = (await api('/api/settings')).studio;
    const days = [];
    for (let x = d.from; x <= d.to; x = shiftDay(x, 1)) days.push(x);
    const pages = d.masters.map((m) => {
      const list = d.appointments.filter((a) => a.master_id === m.id);
      const byDay = days.map((day) => ({ day, rows: list.filter((a) => a.date === day) })).filter((g) => !d.week || g.rows.length);
      const period = d.week ? fmtDate(d.from) + ' – ' + fmtDate(d.to) : DAY_NAMES[weekdayOf(d.from)] + ', ' + fmtDate(d.from);
      return `<section class="sched-print">
        <div class="sched-head"><div><strong>${esc(m.name)}</strong> · ${esc(period)}</div><div>${esc(studio.name)}</div></div>
        ${byDay.length ? byDay.map((g) => `${d.week ? `<h4>${DAY_NAMES[weekdayOf(g.day)]}, ${fmtDate(g.day)}</h4>` : ''}
          ${g.rows.length ? `<table><thead><tr><th>Час</th><th>Послуга</th><th>Клієнт</th><th>Телефон</th><th>Коментар</th><th>Позначка</th></tr></thead>
            <tbody>${g.rows.map((a) => `<tr><td>${a.start_time}–${a.end_time}</td><td>${esc(a.service)}</td><td>${esc(a.client_name)}</td>
              <td>${esc(a.client_phone)}</td><td>${esc(a.client_comment || '')}</td><td>${a.status === 'new' ? 'не підтв.' : ''}</td></tr>`).join('')}</tbody></table>`
            : '<p>Записів немає.</p>'}`).join('') : '<p>Записів на цей тиждень немає.</p>'}
        <div class="sched-foot">Надруковано ${new Date().toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })}</div>
      </section>`;
    });
    printHtml(pages.join('') || '<p>Немає майстрів для друку.</p>');
  }

  // ----- «Закрити день»: позначити минулі записи «Відбувся» / «Не прийшов» / «Скасовано» за раз -----
  let closeDay = null; // null | { rows }
  const CLOSE_OPTS = [['done', 'Відбувся'], ['no_show', 'Не прийшов'], ['cancelled', 'Скасовано'], ['keep', 'Лишити як є']];
  async function renderCloseDay() {
    closeDay.rows = await api('/api/admin/close-day' + (isSuper() && apptMaster ? '?masterId=' + apptMaster : ''));
    const rows = closeDay.rows;
    $('#view').innerHTML = `<button class="btn btn-ghost small" type="button" id="cdBack">← До записів</button>
      <h3 style="margin:14px 0 4px">Закрити день</h3>
      <p class="muted" style="margin:0 0 10px">Записи, які вже минули, але не позначені (за останні 60 днів). «Відбувся» списує матеріали й рахується у статистиці, «Не прийшов» — неявка. Клієнтам нічого не надсилається.</p>
      ${rows.length ? `<div class="toolbar"><span class="muted">Позначити всі:</span>
          <button class="btn btn-ghost small" type="button" data-cd-all="done">Відбувся</button>
          <button class="btn btn-ghost small" type="button" data-cd-all="no_show">Не прийшов</button></div>
        <table class="cd-table">
          <thead><tr><th>Коли</th><th>Послуга</th>${isSuper() ? '<th>Майстер</th>' : ''}<th>Клієнт</th><th>Статус</th></tr></thead>
          <tbody>${rows.map((r) => `<tr data-cd-row="${r.id}">
            <td>${fmtDate(r.date)}, ${r.start_time}–${r.end_time}</td>
            <td>${esc(r.service)}</td>
            ${isSuper() ? `<td>${esc(r.master || '—')}</td>` : ''}
            <td>${esc(r.client_name)}<br><small class="muted">${esc(r.client_phone)}</small></td>
            <td><select class="input cd-status" aria-label="Статус запису ${esc(r.client_name)}">${CLOSE_OPTS.map(([v, l]) => `<option value="${v}" ${v === 'done' ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          </tr>`).join('')}</tbody>
        </table>
        <div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" type="button" id="cdSave">Зберегти</button></div>`
      : '<p>Усі минулі записи вже позначені.</p>'}`;
  }

  // ----- «Майстер не вийде»: передати, перенести або скасувати його записи за раз (лише суперадмін) -----
  let absence = null; // null | { step: 'form' | 'plan' | 'done', masterId, from, to, block, note, plan, result }
  const ABS_WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  const absDay = (d) => ABS_WD[(new Date(d + 'T12:00:00').getDay() + 6) % 7] + ' ' + fmtDate(d);
  const absPeriod = (a) => (a.from === a.to ? absDay(a.from) : absDay(a.from) + ' – ' + absDay(a.to));
  const absValue = (d) => (d.type === 'master' ? 'master:' + d.master_id : d.type === 'time' ? `time:${d.date}|${d.time}|${d.master_id}` : d.type);
  function absOptions(r) {
    const sel = absValue(r.default);
    const opt = (v, label) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`;
    return (r.same_time.length ? `<optgroup label="Той самий час, інший майстер">${r.same_time.map((m) => opt('master:' + m.id, 'Передати: ' + m.name)).join('')}</optgroup>` : '') +
      (r.slots.length ? `<optgroup label="Перенести на інший час">${r.slots.map((s) => opt(`time:${s.date}|${s.time}|${s.master_id}`, s.label)).join('')}</optgroup>` : '') +
      opt('cancel', 'Скасувати й повідомити клієнта') + opt('keep', 'Лишити як є (вирішу пізніше)');
  }
  async function renderAbsence() {
    const a = absence;
    const back = '<button class="btn btn-ghost small" type="button" id="absBack">← До записів</button>';
    if (a.step === 'form') {
      const list = masters.filter((m) => m.status !== 'deleted');
      $('#view').innerHTML = back + `
        <form class="abs-form" id="absForm">
          <h3>Майстер не вийде на роботу</h3>
          <p class="muted">Покажемо записи майстра на ці дні й запропонуємо, кому їх передати на той самий час або на який час перенести. Клієнтам із Telegram бот напише сам, решті — дамо список, кому подзвонити.</p>
          <label class="step-label" for="absMaster">Майстер</label>
          <select class="input" id="absMaster" required>${list.map((m) => `<option value="${m.id}" ${m.id === a.masterId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
          <div class="abs-dates">
            <label class="step-label">З <input class="input" type="date" id="absFrom" min="${today()}" value="${a.from}" required></label>
            <label class="step-label">По <input class="input" type="date" id="absTo" min="${today()}" value="${a.to}" required></label>
          </div>
          <label class="consent-check"><input type="checkbox" id="absBlock" ${a.block ? 'checked' : ''}> Закрити запис до майстра на ці дні</label>
          <small class="muted">У «Розкладі» з'являться разові блокування на його робочі години, і клієнти не зможуть до нього записатися.</small>
          <input class="input" id="absNote" maxlength="80" value="${esc(a.note)}" placeholder="Примітка в розкладі (необов'язково), наприклад «лікарняний»">
          <div class="toolbar"><button class="btn btn-primary" type="submit">Показати записи</button></div>
        </form>`;
      return;
    }
    if (a.step === 'plan') {
      const p = a.plan;
      const withMaster = p.appointments.filter((r) => r.same_time.length).length;
      const noTg = p.appointments.filter((r) => !r.telegram).length;
      $('#view').innerHTML = `<button class="btn btn-ghost small" type="button" id="absEdit">← Змінити майстра чи дні</button>
        <h3 style="margin:14px 0 4px">${esc(p.master.name)}: ${absPeriod(p)}</h3>
        <p class="muted" style="margin:0 0 6px">${p.appointments.length ? `Записів: ${p.appointments.length}. Вільного майстра на той самий час знайдено для ${withMaster}. Без Telegram (треба подзвонити): ${noTg}.` : 'Активних записів на ці дні немає.'}</p>
        ${a.block ? `<p class="muted" style="margin:0 0 12px">${p.work_days.length === 0 ? 'Робочих днів у майстра в цей період немає — закривати нічого.'
          : p.work_days.length === 1 ? `Запис до майстра буде закрито: ${absDay(p.work_days[0].date)}, ${p.work_days[0].start_time}–${p.work_days[0].end_time}.`
            : `Запис до майстра буде закрито на ${p.work_days.length} робочих днів: з ${absDay(p.work_days[0].date)} по ${absDay(p.work_days[p.work_days.length - 1].date)}.`}</p>` : ''}
        ${p.appointments.length ? `<table class="abs-table">
          <thead><tr><th>Коли</th><th>Послуга</th><th>Клієнт</th><th>Що зробити</th></tr></thead>
          <tbody>${p.appointments.map((r) => `<tr data-abs-row="${r.id}">
            <td>${absDay(r.date)}, ${r.start_time}–${r.end_time}${r.started ? ' <span class="badge-warn">уже почався</span>' : ''}</td>
            <td>${esc(r.service)}</td>
            <td>${esc(r.client_name)}<br><a href="tel:${esc(r.client_phone.replace(/[^\d+]/g, ''))}">${esc(r.client_phone)}</a><br><small class="${r.telegram ? 'abs-tg' : 'abs-call'}">${r.telegram ? 'Telegram є — бот напише сам' : 'Telegram немає — треба подзвонити'}</small></td>
            <td><select class="input abs-action" aria-label="Що зробити із записом ${esc(r.client_name)}">${absOptions(r)}</select>${!r.same_time.length && !r.started ? '<small class="muted">Вільних майстрів на цей час немає.</small>' : ''}</td>
          </tr>`).join('')}</tbody>
        </table>` : ''}
        <div class="toolbar" style="margin-top:14px"><button class="btn btn-primary" type="button" id="absApply">${p.appointments.length ? 'Застосувати' : (a.block ? 'Закрити запис на ці дні' : 'Готово')}</button></div>`;
      return;
    }
    // step === 'done'
    const r = a.result;
    const c = r.counts;
    const failed = r.results.filter((x) => !x.ok);
    const what = (x) => (x.type === 'master' ? `тепер майстер ${x.new.master}, ${absDay(x.date)} о ${x.time} (час той самий)`
      : x.type === 'time' ? `перенесено на ${absDay(x.new.date)} о ${x.new.time}, майстер ${x.new.master} (було ${absDay(x.date)} о ${x.time})`
        : `скасовано запис ${absDay(x.date)} о ${x.time}`);
    $('#view').innerHTML = `
      <h3 style="margin:0 0 8px">Готово</h3>
      <p>Передано іншим майстрам: <strong>${c.master}</strong> · перенесено: <strong>${c.time}</strong> · скасовано: <strong>${c.cancel}</strong> · без змін: <strong>${c.keep}</strong>${c.failed ? ` · не вдалося: <strong>${c.failed}</strong>` : ''}</p>
      ${r.blocks_created ? `<p class="muted">Запис до майстра закрито на днів: ${r.blocks_created}.</p>` : ''}
      ${failed.length ? `<div class="warn-box"><strong>Не вдалося:</strong><ul class="abs-list">${failed.map((x) => `<li>${x.date ? absDay(x.date) + ' ' + x.time + ', ' : ''}${esc(x.client_name || '')}: ${esc(x.error)}</li>`).join('')}</ul>Ці записи лишились як були — змініть їх вручну.</div>` : ''}
      ${r.call_list.length ? `<h3 style="margin:18px 0 4px">Подзвоніть цим клієнтам</h3>
        <p class="muted" style="margin:0 0 8px">У них немає Telegram, тож про зміну вони ще не знають.</p>
        <ul class="abs-list call-list">${r.call_list.map((x) => `<li><a href="tel:${esc(x.client_phone.replace(/[^\d+]/g, ''))}">${esc(x.client_phone)}</a> ${esc(x.client_name)} — ${esc(x.service)}: ${esc(what(x))}</li>`).join('')}</ul>`
        : (c.master + c.time + c.cancel ? '<p>Усім клієнтам, яких це стосується, бот написав у Telegram.</p>' : '')}
      <div class="toolbar" style="margin-top:14px"><button class="btn btn-primary" type="button" id="absDone">До записів</button></div>`;
  }
  async function loadAbsencePlan() {
    const a = absence;
    a.plan = await api(`/api/admin/reassign?masterId=${a.masterId}&from=${a.from}&to=${a.to}`);
    a.step = 'plan';
    await renderAbsence();
  }
  $('#view').addEventListener('submit', async (e) => {
    if (e.target.id !== 'absForm') return;
    e.preventDefault();
    Object.assign(absence, {
      masterId: Number($('#absMaster').value), from: $('#absFrom').value, to: $('#absTo').value,
      block: $('#absBlock').checked, note: $('#absNote').value.trim(),
    });
    if (absence.to < absence.from) return notify('Кінець має бути не раніше початку', true);
    try { await loadAbsencePlan(); } catch (err) { notify(err.message, true); }
  });

  // ----- Новий запис і перенесення (форма в «Записах») -----
  let apptView = 'table';   // 'table' | 'day' | 'week'
  let calDate = today();
  let apptForm = null;      // null | { mode: 'new', preset } | { mode: 'move', appt }
  let afTime = null;        // обраний час у формі
  let afData = null;        // послуги й майстри для форми
  const weekdayOf = (d) => (new Date(d + 'T12:00:00').getDay() + 6) % 7; // 0 = понеділок
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const toHHMM = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

  async function loadFormData() {
    const [services, mastersPub] = await Promise.all([
      fetch('/api/services').then((r) => r.json()),
      fetch('/api/masters').then((r) => r.json()),
    ]);
    // Майстер бачить лише свої послуги
    const own = !isSuper() ? mastersPub.find((m) => m.id === me.master.id) : null;
    afData = { services: own ? services.filter((s) => own.services.includes(s.id)) : services, masters: mastersPub };
  }

  async function renderApptForm() {
    await loadFormData();
    const move = apptForm.mode === 'move';
    const a = move ? apptForm.appt : null;
    const preset = apptForm.preset || {};
    const serviceId = move ? a.service_id : (preset.serviceId || afData.services[0]?.id);
    const masterId = move ? a.master_id : (preset.masterId || '');
    const date = move ? a.date : (preset.date && preset.date >= today() ? preset.date : today());
    afTime = preset.time || null;
    const svcOptions = afData.services.map((s) => '<option value="' + s.id + '"' + (s.id === serviceId ? ' selected' : '') + '>' + esc(s.name) + ' · ' + s.duration_min + ' хв</option>').join('');
    $('#view').innerHTML =
      '<button class="btn btn-ghost small" type="button" id="apptFormBack">← Назад</button>' +
      '<form class="appt-form" id="apptForm">' +
      '<h3>' + (move ? 'Перенести запис' : 'Новий запис') + '</h3>' +
      (move ? '<p class="muted">' + esc(a.client_name) + ', ' + esc(a.client_phone) + ' · ' + esc(a.service) + ' · зараз: ' + fmtDate(a.date) + ' о ' + a.start_time + (a.master ? ', майстер ' + esc(a.master) : '') + '</p>' : '') +
      (move ? '<input type="hidden" id="afService" value="' + serviceId + '">'
        : '<label class="step-label" for="afService">Послуга</label><select class="input" id="afService">' + svcOptions + '</select>') +
      (isSuper() ? '<label class="step-label" for="afMaster">Майстер</label><select class="input" id="afMaster"></select>' : '') +
      '<label class="step-label" for="afDate">Дата</label><input class="input" type="date" id="afDate" min="' + today() + '" value="' + date + '">' +
      '<div class="step-label">Вільний час</div><div class="slots-grid" id="afSlots"></div>' +
      (move ? '' :
        '<div class="step-label">Клієнт</div>' +
        '<div class="combo" id="afCombo"><input class="input" id="afFind" type="search" autocomplete="off" placeholder="Знайти в базі: ім\'я або телефон"' +
        ' role="combobox" aria-expanded="false" aria-controls="afFindList" aria-autocomplete="list" aria-label="Знайти клієнта в базі">' +
        '<ul class="suggest" id="afFindList" role="listbox" hidden></ul></div>' +
        '<div class="af-picked" id="afPicked" hidden></div>' +
        '<input class="input" id="afName" maxlength="60" placeholder="Ім\'я" aria-label="Ім\'я клієнта" required value="' + esc(preset.name || '') + '">' +
        '<input class="input" id="afPhone" type="tel" maxlength="30" placeholder="Телефон" aria-label="Телефон клієнта" required value="' + esc(preset.phone || '') + '">' +
        '<small class="muted af-hint">Новий клієнт — просто впишіть ім\'я й телефон.</small>' +
        '<textarea class="input" id="afComment" rows="2" maxlength="500" placeholder="Коментар (необов\'язково)"></textarea>') +
      '<div class="toolbar"><button class="btn btn-primary" type="submit">' + (move ? 'Перенести' : 'Записати') + '</button></div>' +
      '</form>';
    fillMasterOptions(masterId);
    if (!move) setupClientFind();
    await loadFormSlots();
  }

  // Пошук клієнта з бази у формі запису: ім'я або телефон; вибір підставляє ім'я й телефон
  function showPicked(c) {
    const box = $('#afPicked');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `<span>✓ З бази: <strong>${esc(c.name)}</strong>, ${esc(c.phone)}` +
      (c.visits ? ` · візитів: ${c.visits}` : '') + '</span>' +
      (c.next_visit ? `<span class="af-note">Уже записаний на ${fmtDate(c.next_visit)}.</span>` : '') +
      (c.noshow_streak >= 2 ? `<span class="badge-warn">⚠ не прийшов ${c.noshow_streak} рази поспіль</span>` : '') +
      '<button type="button" class="btn btn-ghost small" id="afUnpick">Інший клієнт</button>';
  }
  function setupClientFind() {
    const input = $('#afFind');
    const list = $('#afFindList');
    if (!input) return;
    let items = [];
    let active = -1;
    let timer = null;
    let seq = 0;
    const meta = (c) => [c.visits ? 'візитів: ' + c.visits : 'ще не був на прийомі', c.last_visit ? 'останній ' + fmtDate(c.last_visit) : '',
      c.next_visit ? 'записаний на ' + fmtDate(c.next_visit) : ''].filter(Boolean).join(' · ');
    const close = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
    const render = () => {
      list.innerHTML = items.length
        ? items.map((c, i) => `<li role="option" id="afOpt${i}" aria-selected="${i === active}"><button type="button" tabindex="-1" class="suggest-item${i === active ? ' is-active' : ''}" data-pick="${i}">` +
          `<strong>${esc(c.name)}</strong> <span class="muted">${esc(c.phone)}</span>` +
          (c.archived ? ' <span class="cert-st cert-void">в архіві</span>' : '') +
          (c.noshow_streak >= 2 ? ` <span class="badge-warn">⚠ неявок поспіль: ${c.noshow_streak}</span>` : '') +
          `<br><small class="muted">${esc(meta(c))}</small></button></li>`).join('')
        : '<li class="suggest-empty muted">Не знайдено. Новий клієнт — впишіть ім\'я й телефон нижче.</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', 'afOpt' + active); else input.removeAttribute('aria-activedescendant');
      list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    };
    const search = async () => {
      const q = input.value.trim();
      if (q.length < 2) { items = []; close(); return; }
      const my = ++seq;
      try {
        const r = await api('/api/admin/client-search?q=' + encodeURIComponent(q));
        if (my !== seq || document.activeElement !== input) return; // прийшла застаріла відповідь або поле вже покинули
        items = r;
        active = r.length ? 0 : -1;
        render();
      } catch (err) { notify(err.message, true); }
    };
    const pick = (c) => {
      $('#afName').value = c.name;
      $('#afPhone').value = c.phone;
      input.value = '';
      close();
      showPicked(c);
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault(); // Enter у пошуку не відправляє форму
      if (e.key === 'Escape') return close();
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter' && active >= 0) pick(items[active]);
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    list.addEventListener('mousedown', (e) => e.preventDefault()); // поле не втрачає фокус до вибору
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) pick(items[Number(b.dataset.pick)]); });
    $('#afPicked').addEventListener('click', (e) => {
      if (e.target.id !== 'afUnpick') return;
      $('#afName').value = '';
      $('#afPhone').value = '';
      $('#afPicked').hidden = true;
      input.focus();
    });
    // Вписали повний телефон знайомого клієнта, а ім'я порожнє — підставляємо ім'я з бази
    let phoneTimer = null;
    $('#afPhone').addEventListener('input', () => {
      $('#afPicked').hidden = true;
      clearTimeout(phoneTimer);
      phoneTimer = setTimeout(async () => {
        const d = $('#afPhone').value.replace(/\D/g, '');
        if (d.length < 9 || $('#afName').value.trim()) return;
        const r = await api('/api/admin/client-search?q=' + encodeURIComponent(d)).catch(() => []);
        const exact = r.filter((c) => c.key === d.slice(-9));
        if (exact.length === 1 && !$('#afName').value.trim()) { $('#afName').value = exact[0].name; showPicked(exact[0]); }
      }, 300);
    });
    $('#afName').addEventListener('input', () => { $('#afPicked').hidden = true; });
  }

  function fillMasterOptions(selected) {
    const sel = $('#afMaster');
    if (!sel) return;
    const sid = Number($('#afService').value);
    const list = afData.masters.filter((m) => m.services.includes(sid));
    const move = apptForm.mode === 'move';
    sel.innerHTML = (move ? '' : '<option value="">Будь-який вільний</option>') +
      list.map((m) => '<option value="' + m.id + '"' + (String(m.id) === String(selected) ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('');
  }

  async function loadFormSlots() {
    const box = $('#afSlots');
    if (!box) return;
    const sid = $('#afService').value;
    const date = $('#afDate').value;
    const mid = $('#afMaster') ? $('#afMaster').value : '';
    const ex = apptForm.mode === 'move' ? '&excludeId=' + apptForm.appt.id : '';
    box.innerHTML = '<span class="muted">Завантажую…</span>';
    try {
      const r = await api('/api/admin/slots?serviceId=' + sid + '&date=' + date + (mid ? '&masterId=' + mid : '') + ex);
      if (afTime && !r.slots.includes(afTime)) afTime = null;
      box.innerHTML = r.slots.length
        ? r.slots.map((t) => '<button type="button" class="slot' + (t === afTime ? ' selected' : '') + '" data-af-time="' + t + '">' + t + '</button>').join('')
        : '<span class="muted slots-empty">На цю дату вільного часу немає.</span>';
    } catch (err) {
      box.innerHTML = '<span class="muted">' + esc(err.message) + '</span>';
    }
  }

  // Подання форми запису: окремий обробник, щоб не потрапити в загальну обробку форм нижче
  $('#view').addEventListener('submit', async (e) => {
    if (e.target.id !== 'apptForm') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!afTime) return notify('Оберіть вільний час', true);
    const mid = $('#afMaster') ? $('#afMaster').value : '';
    try {
      if (apptForm.mode === 'move') {
        const r = await api('/api/admin/appointments/' + apptForm.appt.id + '/move', { method: 'PATCH', body: { date: $('#afDate').value, time: afTime, masterId: mid ? Number(mid) : undefined } });
        notify('Запис перенесено: ' + fmtDate(r.date) + ' о ' + r.time + (isSuper() ? ', майстер ' + r.master : ''));
      } else {
        const r = await api('/api/admin/appointments', { method: 'POST', body: {
          serviceId: Number($('#afService').value), masterId: mid ? Number(mid) : undefined, date: $('#afDate').value, time: afTime,
          name: $('#afName').value, phone: $('#afPhone').value, comment: $('#afComment').value,
        } });
        notify('Запис додано' + (isSuper() ? ', майстер ' + r.master : ''));
      }
      apptForm = null;
      await renderAppointments();
    } catch (err) {
      notify(err.message, true);
      if (/зайнят/.test(err.message)) loadFormSlots();
    }
  });

  // ----- Календар дня й тижня -----
  const PPM = 1.4; // пікселів на хвилину: година = 84 px
  const mondayOf = (d) => shiftDay(d, -weekdayOf(d));

  async function renderCalendar() {
    const week = apptView === 'week';
    const from = week ? mondayOf(calDate) : calDate;
    const to = week ? shiftDay(from, 6) : calDate;
    // Тиждень показуємо для одного майстра; день — для обраного або всіх
    const mid = !isSuper() ? '' : (week ? (apptMaster || masters.find((m) => m.status === 'active')?.id || '') : apptMaster);
    const data = await api('/api/admin/calendar?from=' + from + '&to=' + to + (mid ? '&masterId=' + mid : ''));
    const cols = week
      ? Array.from({ length: 7 }, (_, i) => ({ date: shiftDay(from, i), master: data.masters[0] }))
      : data.masters.map((m) => ({ date: calDate, master: m }));
    const hoursOf = (c) => c.master && data.hours.find((h) => h.master_id === c.master.id && h.weekday === weekdayOf(c.date));
    // Межі сітки: від найранішого початку до найпізнішого кінця (з урахуванням записів), округлено до годин
    let start = 24 * 60, end = 0;
    for (const c of cols) {
      const h = hoursOf(c);
      if (h && h.start_time) { start = Math.min(start, toMin(h.start_time)); end = Math.max(end, toMin(h.end_time)); }
    }
    for (const a of data.appointments) { start = Math.min(start, toMin(a.start_time)); end = Math.max(end, toMin(a.end_time)); }
    if (start >= end) { start = 9 * 60; end = 18 * 60; }
    start = Math.floor(start / 60) * 60;
    end = Math.ceil(end / 60) * 60;
    const height = (end - start) * PPM;
    const y = (t) => (toMin(t) - start) * PPM;
    const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

    const axis = '<div class="cal-axis" style="height:' + height + 'px">' +
      Array.from({ length: (end - start) / 60 + 1 }, (_, i) => '<span style="top:' + (i * 60 * PPM) + 'px">' + toHHMM(start + i * 60) + '</span>').join('') + '</div>';
    const colHtml = cols.map((c) => {
      if (!c.master) return '';
      const h = hoursOf(c);
      const wd = weekdayOf(c.date);
      let inner = '';
      const hol = (data.holidays || []).find((x) => x.date === c.date);
      if (hol) {
        inner += '<div class="cal-off cal-holiday" style="top:0;height:' + height + 'px"><span>Свято' + (hol.note ? ': ' + esc(hol.note) : '') + '</span></div>';
      } else if (!h || !h.start_time) {
        inner += '<div class="cal-off" style="top:0;height:' + height + 'px"><span>Вихідний</span></div>';
      } else {
        if (toMin(h.start_time) > start) inner += '<div class="cal-off" style="top:0;height:' + y(h.start_time) + 'px"></div>';
        if (toMin(h.end_time) < end) inner += '<div class="cal-off" style="top:' + y(h.end_time) + 'px;height:' + (height - y(h.end_time)) + 'px"></div>';
      }
      for (const b of data.breaks.filter((x) => x.master_id === c.master.id && x.weekday === wd)) {
        inner += '<div class="cal-break" style="top:' + y(b.start_time) + 'px;height:' + (y(b.end_time) - y(b.start_time)) + 'px"><span>' + esc(b.note || 'Перерва') + '</span></div>';
      }
      for (const b of data.blocks.filter((x) => x.master_id === c.master.id && x.date === c.date)) {
        inner += '<div class="cal-block" style="top:' + y(b.start_time) + 'px;height:' + (y(b.end_time) - y(b.start_time)) + 'px"><span>' + esc(b.note || 'Заблоковано') + '</span></div>';
      }
      for (const a of data.appointments.filter((x) => x.master_id === c.master.id && x.date === c.date)) {
        const hgt = Math.max(22, y(a.end_time) - y(a.start_time));
        const active = a.status === 'new' || a.status === 'confirmed';
        const mark = !active ? '' : a.client_declined_at ? 'declined' : a.client_confirmed_at ? 'sure' : '';
        inner += '<button type="button" class="cal-appt st-' + a.status + (mark ? ' ' + mark : '') + '" data-cal-appt="' + a.id + '" style="top:' + y(a.start_time) + 'px;height:' + hgt + 'px" title="' +
          esc(a.start_time + '–' + a.end_time + ' ' + a.client_name + ', ' + a.client_phone + ' · ' + a.service +
            (mark === 'declined' ? ' · клієнт попередив, що не прийде' : mark === 'sure' ? ' · клієнт підтвердив візит у Telegram' : '')) + '">' +
          '<b>' + a.start_time + '</b> ' + (mark === 'declined' ? '⚠ ' : mark === 'sure' ? '✓ ' : '') + esc(a.client_name) + '<span>' + esc(a.service) + '</span></button>';
      }
      const head = week
        ? DAY_NAMES[wd] + ' ' + c.date.slice(8, 10) + '.' + c.date.slice(5, 7)
        : esc(c.master.name);
      return '<div class="cal-col"><div class="cal-head' + (c.date === today() ? ' is-today' : '') + '">' + head + '</div>' +
        '<div class="cal-body" style="height:' + height + 'px" data-cal-date="' + c.date + '" data-cal-master="' + c.master.id + '" data-cal-start="' + start + '">' + inner + '</div></div>';
    }).join('');

    const title = week
      ? 'Тиждень ' + fmtDate(from) + ' – ' + fmtDate(to) + (data.masters[0] ? ' · ' + esc(data.masters[0].name) : '')
      : DAY_NAMES[weekdayOf(calDate)] + ', ' + fmtDate(calDate);
    $('#view').innerHTML = apptToolbar() +
      '<div class="toolbar cal-nav">' +
        '<button class="btn btn-ghost small" type="button" data-cal-shift="-1" aria-label="Назад">‹</button>' +
        '<button class="btn btn-ghost small" type="button" data-cal-shift="0">Сьогодні</button>' +
        '<button class="btn btn-ghost small" type="button" data-cal-shift="1" aria-label="Вперед">›</button>' +
        '<input type="date" id="calDate" value="' + calDate + '"><b class="cal-title">' + title + '</b>' +
        '<button class="btn btn-ghost small" type="button" id="calPrint">Друк</button>' +
        '<span class="muted cal-hint">Клік по вільному місцю — новий запис, по запису — перенесення. Запис можна перетягнути: мишкою або утримавши пальцем.</span>' +
      '</div>' +
      (cols.length && cols[0].master
        ? '<div class="cal-wrap"><div class="cal-grid" style="grid-template-columns: 56px repeat(' + cols.length + ', minmax(150px, 1fr))">' +
          '<div class="cal-col cal-axis-col"><div class="cal-head"></div>' + axis + '</div>' + colHtml + '</div></div>'
        : '<p class="muted">Немає активних майстрів для показу.</p>');
    window.__calAppts = data.appointments; // для відкриття форми перенесення
    window.__calMasters = data.masters;
    calPrintData = { week, from, to, masters: data.masters, appointments: data.appointments };
    updateCloseDayCount();
  }

  // ----- Перетягування записів у календарі (день і тиждень) -----
  // Мишка: затиснути й тягнути. Телефон: утримати палець пів секунди, потім тягнути (поки тягнеш, сторінка не прокручується).
  // Час прив'язується до 15 хв, в іншій колонці — інший майстер (день) або інший день (тиждень).
  // Перед збереженням — підтвердження; що час вільний, остаточно перевіряє сервер.
  const DRAG_SNAP = 15;
  const LONG_PRESS_MS = 450;
  let calDrag = null;
  let calClickBlock = false; // після перетягування клік не має відкривати форму

  const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest && e.target.closest('#view .cal-appt');
    if (!el || e.button > 0 || calDrag) return;
    const a = (window.__calAppts || []).find((x) => String(x.id) === el.dataset.calAppt);
    if (!a || !['new', 'confirmed'].includes(a.status) || a.date < today()) return;
    calDrag = {
      el, a, pointerId: e.pointerId, touch: e.pointerType !== 'mouse', active: false, timer: null, raf: 0,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, body: el.parentElement,
      dur: toMin(a.end_time) - toMin(a.start_time),
    };
    if (calDrag.touch) calDrag.timer = setTimeout(() => { if (calDrag && !calDrag.active) dragStart(); }, LONG_PRESS_MS);
    window.addEventListener('pointermove', dragMove);
    window.addEventListener('pointerup', dragEnd);
    window.addEventListener('pointercancel', dragCancel);
  });
  // Поки запис тягнуть пальцем, браузер не прокручує сторінку і не показує меню
  document.addEventListener('touchmove', (e) => { if (calDrag && calDrag.active) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (calDrag) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    if (!calClickBlock) return;
    calClickBlock = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  function dragMove(e) {
    const d = calDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.active) {
      const moved = Math.hypot(d.x - d.x0, d.y - d.y0);
      if (d.touch) { if (moved > 10) dragCancel(); return; } // палець рушив до утримання — це прокрутка
      if (moved < 5) return;
      dragStart();
    }
    dragPlace();
  }
  function dragStart() {
    const d = calDrag;
    clearTimeout(d.timer);
    d.active = true;
    d.grab = d.y - d.el.getBoundingClientRect().top; // за яке місце тримають запис
    d.el.classList.add('dragging');
    d.label = document.createElement('div');
    d.label.className = 'drag-time';
    d.el.appendChild(d.label);
    document.body.classList.add('cal-dragging');
    if (d.touch && navigator.vibrate) navigator.vibrate(30);
    dragPlace();
    d.raf = requestAnimationFrame(dragAutoScroll);
  }
  function dragPlace() {
    const d = calDrag;
    const bodies = [...document.querySelectorAll('#view .cal-body')];
    const body = bodies.find((b) => { const r = b.getBoundingClientRect(); return d.x >= r.left && d.x < r.right; }) || d.body;
    const rect = body.getBoundingClientRect();
    const bStart = Number(body.dataset.calStart);
    const bEnd = bStart + Math.round(body.offsetHeight / PPM);
    let m = Math.round((bStart + (d.y - d.grab - rect.top) / PPM) / DRAG_SNAP) * DRAG_SNAP;
    m = Math.max(bStart, Math.min(bEnd - d.dur, m));
    if (body !== d.body) { body.appendChild(d.el); d.body = body; }
    d.el.style.top = (m - bStart) * PPM + 'px';
    d.date = body.dataset.calDate;
    d.master = Number(body.dataset.calMaster);
    d.time = toHHMM(m);
    d.label.textContent = d.time + '–' + toHHMM(m + d.dur);
    // Червона рамка: перетин з іншим записом цього майстра або минулий час (остаточно вирішує сервер)
    const clash = (window.__calAppts || []).some((x) => x.id !== d.a.id && x.master_id === d.master && x.date === d.date &&
      x.status !== 'cancelled' && toMin(x.start_time) < m + d.dur && toMin(x.end_time) > m);
    d.past = d.date < today() || (d.date === today() && m < nowMinutes());
    d.el.classList.toggle('conflict', clash || d.past);
  }
  // Біля краю екрана сторінка (і календар убік) прокручуються самі
  function dragAutoScroll() {
    const d = calDrag;
    if (!d || !d.active) return;
    const edge = 50;
    const step = 10;
    const dy = d.y < edge ? -step : d.y > window.innerHeight - edge ? step : 0;
    if (dy) window.scrollBy(0, dy);
    let dx = 0;
    const wrap = $('#view .cal-wrap');
    if (wrap && wrap.scrollWidth > wrap.clientWidth) {
      const r = wrap.getBoundingClientRect();
      dx = d.x < r.left + 40 ? -step : d.x > r.right - 40 ? step : 0;
      if (dx) wrap.scrollLeft += dx;
    }
    if (dy || dx) dragPlace();
    d.raf = requestAnimationFrame(dragAutoScroll);
  }
  function dragCleanup() {
    const d = calDrag;
    if (!d) return null;
    clearTimeout(d.timer);
    cancelAnimationFrame(d.raf);
    window.removeEventListener('pointermove', dragMove);
    window.removeEventListener('pointerup', dragEnd);
    window.removeEventListener('pointercancel', dragCancel);
    document.body.classList.remove('cal-dragging');
    if (d.label) d.label.remove();
    d.el.classList.remove('dragging', 'conflict');
    calDrag = null;
    return d;
  }
  function dragCancel(e) {
    if (e && calDrag && e.pointerId !== calDrag.pointerId) return;
    const d = dragCleanup();
    if (d && d.active) renderAppointments().catch(() => {}); // повернути запис на місце
  }
  async function dragEnd(e) {
    if (!calDrag || e.pointerId !== calDrag.pointerId) return;
    const d = dragCleanup();
    if (!d.active) return; // звичайний клік — відкриється форма перенесення
    calClickBlock = true;
    setTimeout(() => { calClickBlock = false; }, 400);
    const a = d.a;
    if (d.date === a.date && d.time === a.start_time && d.master === a.master_id) return renderAppointments();
    if (d.past) { notify('Цей час уже минув', true); return renderAppointments(); }
    const mName = (id) => (window.__calMasters || []).find((m) => m.id === id)?.name || '';
    const msg = 'Перенести запис?\n' + a.client_name + ' · ' + a.service + '\n' +
      fmtDate(a.date) + ' ' + a.start_time + ' → ' + fmtDate(d.date) + ' ' + d.time +
      (d.master !== a.master_id ? '\nМайстер: ' + mName(a.master_id) + ' → ' + mName(d.master) : '');
    if (!confirm(msg)) return renderAppointments();
    try {
      await api('/api/admin/appointments/' + a.id + '/move', { method: 'PATCH', body: { date: d.date, time: d.time, masterId: isSuper() ? d.master : undefined } });
      notify('Запис перенесено: ' + fmtDate(d.date) + ' о ' + d.time);
    } catch (err) {
      notify(err.message, true);
    }
    renderAppointments().catch((err) => notify(err.message, true));
  }

  // Рядок Telegram для майстра під вкладками
  function renderMasterTg() {
    const box = $('#masterTg');
    if (isSuper()) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = me.telegram
      ? '<span>✅ Telegram підключено: ваші нові записи, скасування й перенесення надходять у бот.</span><button class="btn btn-ghost small" type="button" id="mtgOff">Відключити</button>'
      : '<span>Підключіть Telegram, щоб отримувати свої нові записи, скасування й перенесення.</span><button class="btn btn-primary small" type="button" id="mtgOn">Підключити Telegram</button>';
  }
  // Посилання на календар: показується один раз, тому одразу пропонуємо скопіювати
  function calLinkHtml(r) {
    return '<div class="cal-link">' +
      '<input class="input" readonly value="' + esc(r.url) + '" aria-label="Посилання на календар">' +
      '<div class="toolbar"><button class="btn btn-primary small" type="button" data-cal-copy="' + esc(r.url) + '">Скопіювати</button>' +
      '<a class="btn btn-ghost small" href="' + esc(r.webcal) + '">Додати в календар iPhone</a></div>' +
      '<small class="muted">Посилання показується лише зараз — збережіть його. ' +
      (r.public ? 'У Google Календарі: «Інші календарі» → «+» → «З URL-адреси».'
        : 'Google Календар не зможе його відкрити, поки сайт працює лише в локальній мережі; iPhone у тій самій Wi-Fi мережі — зможе.') +
      ' У календар потрапляє лише послуга й ім\'я клієнта, без телефону.</small></div>';
  }
  async function renderMasterCal(fresh) {
    const box = $('#masterCal');
    if (isSuper()) { box.hidden = true; return; }
    box.hidden = false;
    const st = fresh || await api('/api/admin/me/calendar');
    box.innerHTML = fresh
      ? '<span>📅 Нове посилання на ваш календар:</span>' + calLinkHtml(fresh)
      : st.enabled
        ? '<span>📅 Календар у телефоні підключено. Загубили посилання — створіть нове, старе перестане працювати.</span><span class="toolbar"><button class="btn btn-ghost small" type="button" id="mcalNew" data-replace="1">Нове посилання</button><button class="btn btn-ghost small" type="button" id="mcalOff">Вимкнути</button></span>'
        : '<span>📅 Додайте свої записи в календар телефона: він сам оновлюватиметься.</span><button class="btn btn-primary small" type="button" id="mcalNew">Отримати посилання</button>';
  }
  $('#masterCal').addEventListener('click', async (e) => {
    try {
      if (e.target.id === 'mcalNew') {
        if (e.target.dataset.replace && !confirm('Старе посилання перестане працювати. Створити нове?')) return;
        return await renderMasterCal(await api('/api/admin/me/calendar', { method: 'POST' }));
      }
      if (e.target.id === 'mcalOff') {
        if (!confirm('Вимкнути календар? Посилання перестане працювати.')) return;
        await api('/api/admin/me/calendar', { method: 'DELETE' });
        notify('Календар вимкнено');
        return await renderMasterCal();
      }
    } catch (err) { notify(err.message, true); }
  });
  // Кнопка «Скопіювати» (і для майстра, і в картці майстра у суперадміна)
  document.addEventListener('click', async (e) => {
    const url = e.target.dataset && e.target.dataset.calCopy;
    if (!url) return;
    try { await navigator.clipboard.writeText(url); notify('Посилання скопійовано'); }
    catch { e.target.closest('.cal-link').querySelector('input').select(); notify('Виділіть і скопіюйте посилання вручну'); }
  });

  $('#masterTg').addEventListener('click', async (e) => {
    try {
      if (e.target.id === 'mtgOn') {
        const r = await api('/api/admin/me/telegram', { method: 'POST' });
        window.open(r.link, '_blank', 'noopener');
        notify('Відкрийте бота і натисніть «Старт». Посилання діє ' + r.minutes + ' хв. Потім оновіть сторінку.');
      }
      if (e.target.id === 'mtgOff') {
        await api('/api/admin/me/telegram', { method: 'DELETE' });
        me.telegram = false;
        renderMasterTg();
        notify('Telegram відключено');
      }
    } catch (err) {
      notify(err.message, true);
    }
  });

  // ----- Клієнти -----
  async function renderClients() {
    const arch = isSuper() ? await api('/api/admin/archive-months') : { options: [], months: 0 };
    const archiveOpts = arch.options.map((m) => '<option value="' + m + '"' + (m === arch.months ? ' selected' : '') + '>' + m + ' міс.</option>').join('');
    $('#view').innerHTML = `
      <div class="toolbar">
        <input type="search" id="clientSearch" placeholder="Пошук: імʼя або телефон" value="${esc(clientQuery)}" style="flex:1;max-width:340px">
        ${isSuper() ? '<button class="btn btn-ghost small" type="button" id="clientsCsv">Вивантажити в CSV</button>' : ''}
      </div>
      <div class="toolbar">
        <button class="btn ${clientsArchived ? 'btn-ghost' : 'btn-primary'} small" type="button" id="clientsActiveBtn">Активні</button>
        <button class="btn ${clientsArchived ? 'btn-primary' : 'btn-ghost'} small" type="button" id="clientsArchiveBtn">Архів</button>
        ${isSuper() ? `<label class="muted" style="margin-left:auto">В архів, якщо без змін понад <select id="archiveMonths">${archiveOpts}</select></label>` : ''}
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
          <td><button class="link" type="button" data-client="${c.key}">${esc(c.name)}</button>${noShowBadge(c.noshow_streak)}</td>
          <td>${esc(c.phone)}</td>
          <td>${c.visits}${c.no_shows ? ` <span class="muted">(не прийшов: ${c.no_shows})</span>` : ''}</td>
          <td>${fmtDate(c.last_visit)}</td>
          <td>${fmtDate(c.next_visit)}</td>
          <td>${c.has_note ? 'є' : '—'}</td>
          <td>${!isSuper() ? '' : c.archived
            ? '<button class="btn btn-ghost small" type="button" data-restore="' + c.key + '">Повернути</button>'
            : '<button class="btn btn-ghost small" type="button" data-archive-client="' + c.key + '">В архів</button>'}</td>
        </tr>`).join('')
      : `<tr><td colspan="7" class="muted">${q ? 'Нікого не знайдено.' : clientsArchived ? 'В архіві нікого немає.' : 'Активних клієнтів немає. Нові зʼявляться після запису, решта може бути в архіві.'}</td></tr>`;
  }

  async function renderClient(key) {
    const c = await api('/api/admin/clients/' + key);
    currentClient = key;
    currentClientData = c;
    const done = c.appointments.filter((a) => !['cancelled', 'no_show'].includes(a.status) && a.date < today()).length;
    const noShows = c.appointments.filter((a) => a.status === 'no_show').length;
    // неявки поспіль: від найновішого минулого запису назад, до першого візиту
    let streak = 0;
    for (const a of c.appointments) { // відсортовано від нових до старих
      if (a.status === 'cancelled' || (a.date >= today() && a.status !== 'no_show')) continue;
      if (a.status === 'no_show') streak++; else break;
    }
    $('#view').innerHTML = `
      <button class="btn btn-ghost small" type="button" id="clientBack">← До списку клієнтів</button>
      <h3 style="margin:16px 0 4px">${esc(c.name)}</h3>
      <div class="muted">${esc(c.phone)} · візитів: ${done}${noShows ? ` · не прийшов: ${noShows}` : ''} · усього записів: ${c.appointments.length}</div>
      <div class="toolbar client-actions">
        <button class="btn btn-primary small" type="button" id="clientBook">+ Записати</button>
        ${isSuper() ? '<button class="btn btn-ghost small danger" type="button" id="clientErase">Видалити клієнта</button>' : ''}
      </div>
      ${streak >= 2 ? `<div class="warn-box">⚠ Клієнт не прийшов ${streak} рази поспіль. Варто підтвердити наступний запис дзвінком.</div>` : ''}

      <label class="step-label" for="clientNote" style="margin-top:20px">Загальна нотатка про клієнта</label>
      <textarea id="clientNote" class="input" rows="4" maxlength="5000" placeholder="Особливості, рекомендації, домовленості">${esc(c.note)}</textarea>
      <button class="btn btn-primary small" type="button" id="saveClientNote">Зберегти нотатку</button>

      <div id="courseBox"></div>

      <h3 style="margin:28px 0 4px">Фото стану стоп</h3>
      <p class="muted" style="margin:0 0 10px">Бачать лише адміністратор і майстер, який веде клієнта. Фото стискається в браузері, а разом із ним прибираються метадані, зокрема місце зйомки.</p>
      <div class="consent-box">
        <label class="consent-check"><input type="checkbox" id="cpConsentBox" disabled> Клієнт дав згоду на фото стоп</label>
        <div class="muted" id="cpConsentInfo">Перевіряю…</div>
        <div class="consent-print-row"><button class="btn btn-ghost small" type="button" id="cpConsentPrint">Надрукувати згоду для підпису</button>
        <small class="muted">Текст — шаблон, варто перевірити з юристом.</small></div>
      </div>
      <div class="toolbar" id="cpTools">
        <input type="date" id="cpDate" value="${today()}" aria-label="Дата фото" style="max-width:170px">
        <input type="text" id="cpNote" maxlength="300" placeholder="Примітка, наприклад: після 2-ї процедури" aria-label="Примітка до фото" style="flex:1;min-width:200px">
        <label class="btn btn-primary small" id="cpAddBtn">Додати фото<input type="file" id="cpFile" accept="image/jpeg,image/png,image/webp,image/*" hidden disabled></label>
      </div>
      <div id="cmpBar" class="cmp-bar" hidden><span id="cmpHint">Позначте 2 фото, щоб порівняти «до і після».</span><button class="btn btn-primary small" type="button" id="cmpOpen" disabled>Порівняти</button></div>
      <div id="cpList" class="photo-grid"><span class="muted">Завантажую…</span></div>

      <h3 style="margin:28px 0 8px">Історія записів</h3>
      <table>
        <thead><tr><th>Дата</th><th>Час</th><th>Послуга</th><th>Статус</th><th style="width:38%">Нотатка до візиту</th><th></th></tr></thead>
        <tbody>${c.appointments.map((a) => `<tr>
          <td>${fmtDate(a.date)}</td>
          <td>${a.start_time}–${a.end_time}</td>
          <td>${esc(a.service)}</td>
          <td>${STATUS[a.status] || esc(a.status)}</td>
          <td><textarea class="visit-note" rows="1" maxlength="5000" placeholder="Що робили" aria-label="Нотатка до візиту ${fmtDate(a.date)}">${esc(a.note)}</textarea></td>
          <td><button class="btn btn-ghost small" type="button" data-save-visit-note="${a.id}">Зберегти</button></td>
        </tr>`).join('')}</tbody>
      </table>`;
    // наступний кадр: на телефоні таблиця вже стала картками, ширина поля остаточна
    requestAnimationFrame(() => document.querySelectorAll('.visit-note').forEach(fitNote));
    loadClientPhotos(key).catch((err) => { $('#cpList').innerHTML = '<span class="muted">' + esc(err.message) + '</span>'; });
    loadCourse(key).catch(() => {});
  }

  // Курс лікування: план дат від запису, з якого курс почався
  let currentCourses = [];
  const COURSE_STATE = { done: 'відбувся', booked: 'записано', missed: 'пропущено', todo: 'ще не записано' };
  async function loadCourse(key) {
    const plans = await api('/api/admin/clients/' + key + '/course');
    currentCourses = plans;
    const box = $('#courseBox');
    if (!box || currentClient !== key) return;
    if (!plans.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<h3 style="margin:28px 0 8px">Курс лікування</h3>' + plans.map((p, pi) => `
      <div class="course-card">
        <div class="course-title">«${esc(p.start.service)}» від ${fmtDate(p.start.date)}</div>
        <div class="muted course-sub">Далі ${p.steps.length} × «${esc(p.next_service)}», кожні ${p.interval_days} дн.</div>
        <ol class="course-steps">${p.steps.map((st, si) => `
          <li class="cs-${st.state}">
            <span class="cs-date">≈ ${fmtDate(st.planned)}</span>
            <span class="cs-state">${COURSE_STATE[st.state]}${st.appt ? ': ' + fmtDate(st.appt.date) + ' о ' + st.appt.time : ''}</span>
            ${st.state === 'todo' || st.state === 'missed' ? `<button class="btn btn-ghost small" type="button" data-course-book="${pi}:${si}">Записати</button>` : ''}
          </li>`).join('')}
        </ol>
      </div>`).join('');
  }

  // Нотатка до візиту розтягується під весь текст, щоб її можна було прочитати повністю
  function fitNote(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 2 + 'px';
  }
  $('#view').addEventListener('input', (e) => { if (e.target.classList.contains('visit-note')) fitNote(e.target); });
  window.addEventListener('resize', () => document.querySelectorAll('.visit-note').forEach(fitNote));

  // ----- Порівняння фото «до і після» -----
  let currentPhotos = [];
  let cmpPicked = [];
  $('#view').addEventListener('change', (e) => {
    if (!e.target.dataset || !e.target.dataset.cmp) return;
    const id = Number(e.target.dataset.cmp);
    if (e.target.checked) {
      cmpPicked.push(id);
      if (cmpPicked.length > 2) { // лишаємо 2 останні позначені
        const drop = cmpPicked.shift();
        const cb = document.querySelector('[data-cmp="' + drop + '"]');
        if (cb) cb.checked = false;
      }
    } else cmpPicked = cmpPicked.filter((x) => x !== id);
    $('#cmpOpen').disabled = cmpPicked.length !== 2;
    $('#cmpHint').textContent = cmpPicked.length === 2 ? 'Обрано 2 фото.' : 'Позначте 2 фото, щоб порівняти «до і після».';
  });
  function openCompare(mode = 'slider') {
    const pics = cmpPicked.map((id) => currentPhotos.find((p) => p.id === id)).filter(Boolean)
      .sort((a, b) => (a.taken_on < b.taken_on ? -1 : a.taken_on > b.taken_on ? 1 : a.id - b.id)); // раніше — «до»
    if (pics.length !== 2) return;
    const src = (p) => document.querySelector('[data-photo-img="' + p.id + '"]')?.src || '';
    const [before, after] = pics;
    const cap = (p, label) => label + ' · ' + fmtDate(p.taken_on) + (p.note ? ' · ' + esc(p.note) : '');
    document.querySelector('.cmp-overlay')?.remove();
    const el = document.createElement('div');
    el.className = 'cmp-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Порівняння фото до і після');
    el.innerHTML = `<div class="cmp-panel">
      <div class="cmp-head">
        <div class="cmp-modes">
          <button type="button" class="btn small ${mode === 'slider' ? 'btn-primary' : 'btn-ghost'}" data-cmp-mode="slider">Повзунок</button>
          <button type="button" class="btn small ${mode === 'side' ? 'btn-primary' : 'btn-ghost'}" data-cmp-mode="side">Поруч</button>
        </div>
        <button type="button" class="btn btn-ghost small" data-cmp-close aria-label="Закрити">✕ Закрити</button>
      </div>
      ${mode === 'side' ? `<div class="cmp-side">
          <figure><img src="${src(before)}" alt="До"><figcaption>${cap(before, 'До')}</figcaption></figure>
          <figure><img src="${src(after)}" alt="Після"><figcaption>${cap(after, 'Після')}</figcaption></figure>
        </div>`
      : `<div class="cmp-slider" style="--pos:50%">
          <img src="${src(before)}" alt="До">
          <img class="cmp-top" src="${src(after)}" alt="Після">
          <div class="cmp-line" aria-hidden="true"></div>
          <span class="cmp-tag cmp-tag-l">До</span><span class="cmp-tag cmp-tag-r">Після</span>
        </div>
        <input type="range" class="cmp-range" min="0" max="100" value="50" aria-label="Межа між фото до і після">
        <div class="cmp-caps"><span>${cap(before, 'До')}</span><span>${cap(after, 'Після')}</span></div>`}
    </div>`;
    document.body.appendChild(el);
    const range = el.querySelector('.cmp-range');
    if (range) range.addEventListener('input', () => el.querySelector('.cmp-slider').style.setProperty('--pos', range.value + '%'));
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('[data-cmp-close]')) return el.remove();
      const m = e.target.closest('[data-cmp-mode]');
      if (m) openCompare(m.dataset.cmpMode);
    });
    el.querySelector('[data-cmp-close]').focus();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelector('.cmp-overlay')?.remove(); });

  // Згода на фото: без неї додати фото не можна (сервер теж перевіряє)
  function applyConsent(c) {
    const box = $('#cpConsentBox');
    if (!box) return;
    box.disabled = false;
    box.checked = c.granted;
    $('#cpFile').disabled = !c.granted;
    $('#cpAddBtn').classList.toggle('is-disabled', !c.granted);
    $('#cpAddBtn').title = c.granted ? '' : 'Спершу позначте згоду клієнта';
    // changed_at у базі — UTC; показуємо дату за Києвом
    const when = c.changed_at ? new Date(c.changed_at.replace(' ', 'T') + 'Z').toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' }) : '';
    $('#cpConsentInfo').textContent = c.granted
      ? `Позначено ${when}, ${c.changed_by}.`
      : c.changed_at
        ? `Згоду відкликано ${when}, ${c.changed_by}. Нові фото додати не можна; наявні видаліть, якщо клієнт просить.`
        : 'Без згоди фото додати не можна. Спершу отримайте згоду клієнта, потім поставте позначку.';
  }

  // Фото стану стоп: список і самі зображення (з токеном, тому через fetch, а не просте посилання)
  async function loadClientPhotos(key) {
    api('/api/admin/clients/' + key + '/photo-consent').then(applyConsent)
      .catch((err) => { const i = $('#cpConsentInfo'); if (i) i.textContent = err.message; });
    const box = $('#cpList');
    const list = await api('/api/admin/clients/' + key + '/photos');
    currentPhotos = list;
    cmpPicked = [];
    if ($('#cmpBar')) $('#cmpBar').hidden = list.length < 2;
    if (!list.length) { box.innerHTML = '<span class="muted">Фото ще немає. Додайте перше, щоб бачити динаміку лікування.</span>'; return; }
    box.innerHTML = list.map((p) => `<figure class="photo-card">
        <button type="button" class="photo-open" data-open-photo="${p.id}" aria-label="Відкрити фото ${fmtDate(p.taken_on)}"><img data-photo-img="${p.id}" alt="Фото стопи ${fmtDate(p.taken_on)}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>
        <figcaption><strong>${fmtDate(p.taken_on)}</strong>${p.note ? '<br>' + esc(p.note) : ''}<br><span class="muted">${esc(p.master || 'Суперадмін')}</span></figcaption>
        <label class="cmp-pick"><input type="checkbox" data-cmp="${p.id}"> порівняти</label>
        ${p.can_delete ? `<button class="btn btn-ghost small danger" type="button" data-del-photo="${p.id}">Видалити</button>` : ''}
      </figure>`).join('');
    const bar = $('#cmpBar');
    if (bar) bar.hidden = list.length < 2;
    await Promise.all(list.map(async (p) => {
      try {
        const r = await fetch('/api/admin/client-photos/' + p.id + '/file', { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) throw new Error();
        const img = box.querySelector('[data-photo-img="' + p.id + '"]');
        if (img) img.src = URL.createObjectURL(await r.blob());
      } catch { /* картка лишиться з порожнім місцем, список працює */ }
    }));
  }

  // Позначка або відкликання згоди
  $('#view').addEventListener('change', async (e) => {
    if (e.target.id !== 'cpConsentBox' || !currentClient) return;
    const box = e.target;
    const granted = box.checked;
    if (!granted && !confirm('Відкликати згоду? Нові фото додати буде не можна. Наявні фото лишаться — видаліть їх, якщо клієнт просить.')) {
      box.checked = true;
      return;
    }
    box.disabled = true;
    try {
      applyConsent(await api('/api/admin/clients/' + currentClient + '/photo-consent', { method: 'PUT', body: { granted } }));
      notify(granted ? 'Згоду позначено' : 'Згоду відкликано');
    } catch (err) {
      box.checked = !granted;
      box.disabled = false;
      notify(err.message, true);
    }
  });

  // Завантаження: фото стискається в JPEG 1600 пікселів (це прибирає метадані), далі йде на сервер
  $('#view').addEventListener('change', async (e) => {
    if (e.target.id !== 'cpFile' || !e.target.files[0] || !currentClient) return;
    const input = e.target;
    const date = $('#cpDate').value;
    const note = $('#cpNote').value.trim();
    try {
      if (!date) throw new Error('Вкажіть дату фото');
      notify('Завантажую фото…');
      const blob = await shrinkPhoto(input.files[0], 1600);
      if (!blob) throw new Error('Не вдалося обробити фото. Спробуйте JPEG або PNG');
      const r = await fetch('/api/admin/clients/' + currentClient + '/photos?date=' + encodeURIComponent(date) + '&note=' + encodeURIComponent(note), {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + token },
        body: blob,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Не вдалося зберегти фото');
      $('#cpNote').value = '';
      notify('Фото збережено');
      await loadClientPhotos(currentClient);
    } catch (err) {
      notify(err.message, true);
    } finally {
      input.value = '';
    }
  });

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
            <div class="tpl-menu" id="tplMenu" role="menu" hidden></div>
            <button class="btn btn-ghost" type="button" id="tplBtn" aria-expanded="false" aria-controls="tplMenu">Шаблони</button>
            <input class="input" id="replyInput" maxlength="1000" placeholder="Відповідь клієнту" autocomplete="off">
            <button class="btn btn-primary" type="submit">Надіслати</button>
          </form>
        </div>
      </div>
      <details class="tpl-manage" id="tplManage">
        <summary>Шаблони відповідей</summary>
        <p class="muted">Можна вставити {адреса}, {телефон}, {назва}, {сайт} — підставиться з налаштувань кабінету.</p>
        <div id="tplList"></div>
        <form class="tpl-form" id="tplForm">
          <input class="input" name="title" maxlength="40" placeholder="Назва, наприклад «Як доїхати»" required>
          <textarea class="input" name="body" rows="3" maxlength="1000" placeholder="Текст відповіді" required></textarea>
          <div class="toolbar"><button class="btn btn-primary small" type="submit" id="tplSave">Додати шаблон</button>
          <button class="btn btn-ghost small" type="button" id="tplCancel" hidden>Скасувати</button></div>
        </form>
      </details>`;
    await loadTemplates();
    await refreshConvList();
    if (currentConv) await openConv(currentConv);
  }

  // Швидкі відповіді (шаблони) у чаті
  let chatTemplates = [];
  async function loadTemplates() {
    chatTemplates = await api('/api/admin/chat-templates');
    const list = $('#tplList');
    if (list) {
      list.innerHTML = chatTemplates.length ? '<ul class="list tpl-list">' + chatTemplates.map((t) => `<li>
          <div><strong>${esc(t.title)}</strong><div class="muted">${esc(t.text)}</div></div>
          <span class="toolbar" style="margin:0"><button class="btn btn-ghost small" type="button" data-tpl-edit="${t.id}">Змінити</button>
          <button class="btn btn-ghost small danger" type="button" data-tpl-del="${t.id}">Видалити</button></span></li>`).join('') + '</ul>'
        : '<p class="muted">Шаблонів поки немає.</p>';
    }
    const menu = $('#tplMenu');
    if (menu) {
      menu.innerHTML = chatTemplates.length
        ? chatTemplates.map((t) => `<button type="button" role="menuitem" class="tpl-item" data-tpl-use="${t.id}"><strong>${esc(t.title)}</strong><span>${esc(t.text.slice(0, 80))}${t.text.length > 80 ? '…' : ''}</span></button>`).join('')
        : '<div class="muted" style="padding:8px">Шаблонів немає — додайте їх нижче, у «Шаблони відповідей».</div>';
    }
  }
  const tplMenuOpen = (open) => {
    const m = $('#tplMenu');
    if (!m) return;
    m.hidden = !open;
    $('#tplBtn')?.setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('#tplMenu, #tplBtn')) tplMenuOpen(false); });
  $('#view').addEventListener('submit', async (e) => {
    if (e.target.id !== 'tplForm') return;
    e.preventDefault();
    const f = new FormData(e.target);
    const id = e.target.dataset.editing;
    try {
      await api('/api/admin/chat-templates' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: { title: f.get('title'), body: f.get('body') } });
      notify(id ? 'Шаблон змінено' : 'Шаблон додано');
      delete e.target.dataset.editing;
      e.target.reset();
      $('#tplSave').textContent = 'Додати шаблон';
      $('#tplCancel').hidden = true;
      await loadTemplates();
    } catch (err) { notify(err.message, true); }
  });

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

  let wsWasOpen = false;
  function connectWs() {
    if (!token || (ws && ws.readyState <= 1)) return; // уже підключено або підключається
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?admin=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      // Після обриву зв'язку могли пропустити зміни — тихо оновлюємо розклад
      if (wsWasOpen) liveRefresh();
      wsWasOpen = true;
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'appt') liveAppt(m);
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
    ws.onclose = (ev) => {
      if (!token) return;
      if (ev.code === 4003) {
        // Канал не пустив: сесія закінчилась (api виведе на сторінку входу) або забагато невдалих спроб — пробуємо пізніше
        api('/api/admin/me').then(() => setTimeout(connectWs, 60000)).catch(() => {});
        return;
      }
      setTimeout(connectWs, 3000);
    };
  }

  // ----- Записи наживо: новий запис із сайту, скасування чи перенесення клієнтом -----
  // Повідомлення внизу екрана + звук (вимикається кнопкою вгорі, вибір пам'ятає браузер).
  // Зміни, зроблені персоналом в іншому вікні ('changed'), лише тихо оновлюють розклад.
  let soundOn = true;
  try { soundOn = localStorage.getItem('adminSound') !== '0'; } catch { /* немає доступу до сховища — звук увімкнено */ }
  let audioCtx = null;
  let unseen = 0;
  const baseTitle = document.title;
  const LIVE_TEXT = {
    new: (m) => `🗓 Новий запис: ${m.client_name}, ${fmtDate(m.date)} о ${m.start_time} · ${m.service}${isSuper() && m.master ? ' · ' + m.master : ''}`,
    cancelled: (m) => `❌ Клієнт скасував запис: ${m.client_name}, ${fmtDate(m.date)} о ${m.start_time}`,
    moved: (m) => `🔁 Клієнт переніс запис: ${m.client_name}, тепер ${fmtDate(m.date)} о ${m.start_time}`,
    confirmed: (m) => `✅ Клієнт підтвердив візит: ${m.client_name}, ${fmtDate(m.date)} о ${m.start_time}`,
    declined: (m) => `⚠️ Клієнт попередив, що не прийде: ${m.client_name}, ${fmtDate(m.date)} о ${m.start_time}. Запис не скасовано`,
  };
  const LIVE_SAD = ['cancelled', 'declined'];

  function audio() {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  // Браузер дає грати звук лише після першого натискання на сторінці — готуємо його заздалегідь
  document.addEventListener('pointerdown', () => { if (soundOn) try { audio(); } catch { /* без звуку */ } }, { passive: true });
  function beep(cancel) {
    if (!soundOn) return;
    try {
      const ctx = audio();
      const t = ctx.currentTime;
      // Новий запис — два тони вгору, скасування — вниз
      (cancel ? [[880, 0], [587, 0.2]] : [[660, 0], [990, 0.2]]).forEach(([f, d]) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.3, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.18);
        o.connect(g).connect(ctx.destination);
        o.start(t + d);
        o.stop(t + d + 0.2);
      });
    } catch { /* браузер не дав звук — лишається повідомлення */ }
  }
  function renderSoundBtn() {
    const b = $('#soundBtn');
    b.textContent = soundOn ? '🔔 Звук' : '🔕 Без звуку';
    b.setAttribute('aria-pressed', String(soundOn));
    b.title = soundOn ? 'Звук нових записів увімкнено' : 'Звук нових записів вимкнено';
  }
  $('#soundBtn').addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('adminSound', soundOn ? '1' : '0'); } catch { /* вибір не збережеться після закриття */ }
    renderSoundBtn();
    if (soundOn) beep(); // одразу чути, як звучить
  });
  renderSoundBtn();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && unseen) { unseen = 0; document.title = baseTitle; }
  });

  function liveToast(m) {
    const box = $('#liveToasts');
    const el = document.createElement('div');
    el.className = 'live-toast' + (LIVE_SAD.includes(m.kind) ? ' cancel' : '');
    el.innerHTML = `<span class="live-text">${esc(LIVE_TEXT[m.kind](m))}</span>
      <span class="live-actions"><button class="btn btn-primary small" type="button" data-live-open>Відкрити</button>
      <button class="btn btn-ghost small" type="button" data-live-close aria-label="Закрити">✕</button></span>`;
    el.querySelector('[data-live-open]').addEventListener('click', () => {
      el.remove();
      closeDay = null; absence = null; apptForm = null; apptWaitlist = false; apptArchive = false;
      if (apptView !== 'table') calDate = m.date;
      show('appointments');
    });
    el.querySelector('[data-live-close]').addEventListener('click', () => el.remove());
    box.prepend(el);
    while (box.children.length > 3) box.lastElementChild.remove(); // не більше 3 одночасно
    setTimeout(() => el.remove(), 20000);
  }

  function liveAppt(m) {
    if (LIVE_TEXT[m.kind]) {
      liveToast(m);
      if (m.kind !== 'confirmed') beep(LIVE_SAD.includes(m.kind));
      if (document.hidden) { unseen += 1; document.title = `(${unseen}) ${baseTitle}`; }
    }
    liveRefresh();
  }

  // Оновити «Записи», якщо вкладка відкрита і людина зараз нічого не заповнює
  let liveTimer = null;
  function liveRefresh() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      const tab = document.querySelector('[data-tab].active')?.dataset.tab;
      const el = document.activeElement;
      const typing = el && $('#view').contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if (tab !== 'appointments' || apptForm || absence || closeDay || typing || calDrag) return updateCloseDayCount();
      const wrap = $('.cal-wrap');
      const pos = { x: window.scrollX, y: window.scrollY, l: wrap ? wrap.scrollLeft : 0, t: wrap ? wrap.scrollTop : 0 };
      renderAppointments().then(() => {
        const w = $('.cal-wrap');
        if (w) { w.scrollLeft = pos.l; w.scrollTop = pos.t; }
        window.scrollTo(pos.x, pos.y);
      }).catch(() => {});
    }, 400);
  }

  // ----- Розклад -----
  async function renderSchedule() {
    const rows = await api('/api/admin/schedule?' + schedQ());
    const { minutes: bufferMin } = isSuper() ? await api('/api/admin/buffer') : { minutes: 0 };
    const { hours: changeHours, options: changeOptions } = isSuper() ? await api('/api/admin/change-hours') : { hours: 0, options: [] };
    const changeOpts = changeOptions.map((h) => `<option value="${h}" ${h === changeHours ? 'selected' : ''}>${h} год</option>`).join('');
    $('#view').innerHTML = `
      ${isSuper() ? `<div class="toolbar">${masterSelect('schedMaster', schedMasterId())}</div>` : ''}
      <h3 style="margin-bottom:12px">Робочі години${isSuper() ? '' : ': ' + esc(me.master.name)}</h3>
      <table>
        <thead class="hours-head"><tr><th>День</th><th>Початок</th><th>Кінець</th><th>Вихідний</th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-wd="${r.weekday}">
          <td>${DAYS[r.weekday]}</td>
          <td><input type="time" class="st" value="${r.start_time || '09:00'}"></td>
          <td><input type="time" class="et" value="${r.end_time || '18:00'}"></td>
          <td><input type="checkbox" class="off" ${r.start_time ? '' : 'checked'}></td>
        </tr>`).join('')}</tbody>
      </table>
      <button class="btn btn-primary" id="saveSchedule" type="button">Зберегти розклад</button>
${isSuper() ? `
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
` : ''}

      <h3 style="margin:32px 0 6px">Перерви</h3>
      <div class="muted">Перерва повторюється щотижня у позначені дні. На цей час клієнти записатися не зможуть.</div>
      <form class="inline-form" id="breakForm">
        <span class="day-checks">${rows.map((r) => `<label><input type="checkbox" name="wd" value="${r.weekday}" ${r.start_time ? 'checked' : ''}> ${DAYS_SHORT[r.weekday]}</label>`).join('')}</span>
        <label>з <input type="time" name="start_time" value="13:00" required></label>
        <label>до <input type="time" name="end_time" value="14:00" required></label>
        <input name="note" value="Обід" placeholder="Назва" maxlength="60">
        <button class="btn btn-primary small" type="submit">Додати перерву</button>
      </form>
      <ul class="list" id="breakList"></ul>

      <h3 style="margin:32px 0 6px">Разові блокування</h3>
      <div class="muted">Закриває час на конкретну дату: лікар, особиста справа, відпустка. Щоб закрити цілий день, вкажіть увесь робочий час. Записи, що вже стоять у цей час, не скасовуються: перенесіть їх у «Записах».</div>
      <div class="toolbar" style="margin-top:10px"><label>Дата <input type="date" id="blockDate" value="${blockDate}"></label></div>
      <form class="inline-form" id="blockForm">
        <label>з <input type="time" name="start_time" required></label>
        <label>до <input type="time" name="end_time" required></label>
        <input name="note" placeholder="Причина (необов'язково)" maxlength="100">
        <button class="btn btn-primary small" type="submit">Заблокувати час</button>
      </form>
      <ul class="list" id="blockList"></ul>
      ${isSuper() ? `<h3 style="margin:32px 0 6px">Свята й вихідні кабінету</h3>
      <div class="muted">День закривається для всіх майстрів: клієнти не зможуть записатися, а перенесення його не пропонують.</div>
      <form class="inline-form" id="holForm" style="margin-top:10px">
        <label>Дата <input type="date" name="date" min="${today()}" required></label>
        <input name="note" maxlength="80" placeholder="Назва, наприклад «Новий рік»">
        <button class="btn btn-primary small" type="submit">Закрити день для всіх</button>
      </form>
      <div id="holList"></div>` : ''}`;
    await renderBreaks();
    await renderBlocks();
    if (isSuper()) await renderHolidays();
    $('#changeHoursForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/change-hours', { method: 'PUT', body: { hours: Number($('#changeHoursSelect').value) } });
        notify('Збережено');
      } catch (err) {
        notify(err.message, true);
      }
    });
    $('#bufferForm')?.addEventListener('submit', async (e) => {
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
          await api(`/api/admin/schedule/${tr.dataset.wd}?` + schedQ(), {
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
    const list = await api('/api/admin/breaks?' + schedQ());
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

  // Свята кабінету (розділ у «Розкладі», лише суперадмін)
  async function renderHolidays() {
    const box = $('#holList');
    if (!box) return;
    const list = await api('/api/admin/holidays');
    box.innerHTML = list.length ? '<ul class="list hol-list">' + list.map((h) => `<li>
        <div><strong>${DAYS[(new Date(h.date + 'T12:00:00').getDay() + 6) % 7]}, ${fmtDate(h.date)}</strong>${h.note ? ' — ' + esc(h.note) : ''}</div>
        ${h.affected.length ? `<div class="warn-box hol-warn">⚠ На цей день є записи: ${h.affected.map((a) => `${esc(a.master || 'без майстра')} — ${a.count}`).join(', ')}.
          Їх треба перенести або скасувати:
          <div class="toolbar" style="margin:6px 0 0;flex-wrap:wrap">${h.affected.filter((a) => a.master_id).map((a) => `<button class="btn btn-ghost small" type="button" data-hol-fix="${a.master_id}|${h.date}">Опрацювати записи: ${esc(a.master)}</button>`).join('')}</div></div>` : ''}
        <button class="btn btn-ghost small" type="button" data-hol-del="${h.date}">Відкрити день знову</button>
      </li>`).join('') + '</ul>' : '<p class="muted">Свят і вихідних кабінету не заплановано.</p>';
  }
  $('#view').addEventListener('submit', async (e) => {
    if (e.target.id !== 'holForm') return;
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('/api/admin/holidays', { method: 'POST', body: { date: f.get('date'), note: f.get('note') } });
      const n = r.affected.reduce((s, a) => s + a.count, 0);
      notify(n ? `День закрито. Увага: на цей день уже є записи (${n}) — їх треба перенести або скасувати` : 'День закрито для всіх майстрів', n > 0);
      e.target.reset();
      await renderHolidays();
    } catch (err) { notify(err.message, true); }
  });

  // Разові блокування на обрану дату (розділ у вкладці «Розклад»)
  async function renderBlocks() {
    if (!$('#blockList')) return;
    const list = await api(`/api/admin/blocks?date=${blockDate}&` + schedQ());
    $('#blockList').innerHTML = list.length
      ? list.map((b) => `<li><span>${b.start_time}–${b.end_time} ${esc(b.note)}</span>
          <button class="btn btn-ghost small" type="button" data-del-block="${b.id}">Видалити</button></li>`).join('')
      : '<li class="muted">Блоків на цю дату немає.</li>';
  }

  // ----- Послуги -----
  const serviceRow = (s, all = []) => `<tr>
    <td data-label="Назва" class="c-wide"><input type="text" class="f-name" value="${esc(s.name)}"></td>
    <td data-label="Опис" class="c-wide"><input type="text" class="f-desc" value="${esc(s.description)}"></td>
    <td data-label="Тривалість, хв"><input type="number" class="f-dur" min="5" max="480" step="5" value="${s.duration_min}"></td>
    <td data-label="Ціна, грн"><input type="number" class="f-price" min="0" step="10" value="${s.price_uah}"></td>
    <td data-label="Орієнтовна ціна (текст)" class="c-wide"><input type="text" class="f-note" maxlength="60" value="${esc(s.price_note)}" placeholder="напр. від 1380 грн"></td>
    <td data-label="Повтор, тижнів"><input type="number" class="f-repeat" min="0" max="52" step="1" value="${s.repeat_weeks || 0}" aria-label="Нагадати про повторний візит через, тижнів" title="0 — не нагадувати"></td>
    <td data-label="Курс лікування" class="c-wide c-course">
      <div class="course-fields">
        <label>повторних візитів <input type="number" class="f-course-visits" min="0" max="20" step="1" value="${s.course_visits || 0}"></label>
        <label>кожні, днів <input type="number" class="f-course-interval" min="0" max="180" step="1" value="${s.course_interval_days || 0}"></label>
        <label>послуга для повторних <select class="f-course-next"><option value="">та сама</option>${all.filter((x) => x.id !== s.id).map((x) => `<option value="${x.id}" ${x.id === s.course_next_service_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      </div>
    </td>
    <td data-label="Активна" class="c-check"><label><input type="checkbox" class="f-active" ${s.active ? 'checked' : ''}> <span class="m-only">Показувати на сайті</span></label></td>
    <td class="c-wide"><button class="btn btn-ghost small" type="button" data-save-service="${s.id}">Зберегти</button></td>
  </tr>`;

  const readServiceRow = (row) => ({
    name: row.querySelector('.f-name').value,
    description: row.querySelector('.f-desc').value,
    duration_min: Number(row.querySelector('.f-dur').value),
    price_uah: Number(row.querySelector('.f-price').value),
    price_note: row.querySelector('.f-note').value,
    repeat_weeks: Number(row.querySelector('.f-repeat').value || 0),
    course_visits: Number(row.querySelector('.f-course-visits').value || 0),
    course_interval_days: Number(row.querySelector('.f-course-interval').value || 0),
    course_next_service_id: row.querySelector('.f-course-next').value || null,
    active: row.querySelector('.f-active').checked ? 1 : 0,
  });

  async function renderServices() {
    const list = await api('/api/admin/services');
    $('#view').innerHTML = `
      <table class="card-table">
        <thead><tr><th>Назва</th><th>Опис</th><th>Хв</th><th>Ціна, грн</th><th>Орієнтовна ціна (текст)</th><th title="Через скільки тижнів бот нагадає про повторний візит. 0 — не нагадувати">Повтор, тижнів</th><th title="Наприклад: встановлення скоби, потім 4 корекції кожні 21 день. 0 — без курсу">Курс лікування</th><th>Активна</th><th></th></tr></thead>
        <tbody>${list.map((x) => serviceRow(x, list)).join('')}</tbody>
      </table>
      <h3 style="margin-bottom:8px">Нова послуга</h3>
      <form class="inline-form" id="serviceForm">
        <input name="name" placeholder="Назва" required maxlength="80">
        <input name="description" placeholder="Опис" maxlength="300">
        <input name="duration_min" type="number" min="5" max="480" step="5" placeholder="Хв" required>
        <input name="price_uah" type="number" min="0" step="10" placeholder="Ціна, грн" required>
        <input name="price_note" maxlength="60" placeholder="Орієнтовна ціна (необов'язково)">
        <input name="repeat_weeks" type="number" min="0" max="52" placeholder="Повтор, тижнів" title="0 або порожньо — не нагадувати">
        <button class="btn btn-primary small" type="submit">Додати</button>
      </form>`;
  }

  // ----- Матеріали (лише суперадмін) -----
  const MOVE_REASON = { visit: 'візит', restock: 'прихід', writeoff: 'списання', init: 'початковий залишок' };
  const fmtQty = (n) => Number(n).toLocaleString('uk-UA', { maximumFractionDigits: 3 });
  let matService = null;
  async function renderMaterials() {
    const [list, moves, services] = await Promise.all([
      api('/api/admin/materials'), api('/api/admin/materials/moves?limit=50'), api('/api/admin/services'),
    ]);
    const low = list.filter((m) => m.low);
    if (!matService && services.length) matService = services[0].id;
    $('#view').innerHTML = `
      ${low.length ? `<div class="warn-box" style="margin:0 0 14px">⚠ Закінчуються: ${low.map((m) => esc(m.name) + ' (' + fmtQty(m.qty) + ' ' + esc(m.unit) + ')').join(', ')}</div>` : ''}
      <h3 style="margin:0 0 8px">Залишки</h3>
      <table>
        <thead><tr><th>Назва</th><th>Одиниця</th><th>Залишок</th><th>Мінімум (попередження)</th><th>Використовується</th><th></th></tr></thead>
        <tbody>${list.length ? list.map((m) => `<tr data-mat="${m.id}" class="${m.active ? '' : 'is-muted'}">
          <td><input type="text" class="m-name" maxlength="80" value="${esc(m.name)}"></td>
          <td><input type="text" class="m-unit" maxlength="12" value="${esc(m.unit)}" style="max-width:90px"></td>
          <td><strong class="${m.low ? 'qty-low' : ''}">${fmtQty(m.qty)}</strong>${m.low ? ' <span class="badge-warn">закінчується</span>' : ''}</td>
          <td><input type="number" class="m-min" min="0" step="any" value="${m.min_qty}" style="max-width:110px"></td>
          <td><label><input type="checkbox" class="m-active" ${m.active ? 'checked' : ''}> так</label></td>
          <td><span class="toolbar" style="margin:0;flex-wrap:wrap">
            <button class="btn btn-primary small" type="button" data-mat-in="${m.id}">+ Прихід</button>
            <button class="btn btn-ghost small" type="button" data-mat-out="${m.id}">− Списати</button>
            <button class="btn btn-ghost small" type="button" data-mat-save="${m.id}">Зберегти</button></span></td>
        </tr>`).join('') : '<tr><td colspan="6" class="muted">Матеріалів ще немає. Додайте перший нижче.</td></tr>'}</tbody>
      </table>
      <h3 style="margin:22px 0 8px">Новий матеріал</h3>
      <form class="inline-form" id="matForm">
        <input name="name" placeholder="Назва, наприклад «Скоба Фрезера»" required maxlength="80">
        <input name="unit" placeholder="Одиниця (шт, мл, уп)" maxlength="12" value="шт" style="max-width:150px">
        <input name="qty" type="number" min="0" step="any" placeholder="Є зараз" style="max-width:120px">
        <input name="min_qty" type="number" min="0" step="any" placeholder="Мінімум" style="max-width:120px">
        <button class="btn btn-primary small" type="submit">Додати</button>
      </form>
      <h3 style="margin:22px 0 4px">Витрата на послугу</h3>
      <p class="muted" style="margin:0 0 8px">Скільки матеріалу йде на одну послугу. Списується автоматично, коли запис позначено «Відбувся».</p>
      <div class="toolbar"><select id="matSvc" class="input" style="max-width:420px">${services.map((s) => `<option value="${s.id}" ${s.id === matService ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div id="matSvcBox"><span class="muted">Завантажую…</span></div>
      <h3 style="margin:22px 0 8px">Історія (останні 50)</h3>
      <table>
        <thead><tr><th>Коли</th><th>Матеріал</th><th>Зміна</th><th>Причина</th><th>Примітка</th></tr></thead>
        <tbody>${moves.length ? moves.map((mv) => `<tr>
          <td>${new Date(mv.created_at.replace(' ', 'T') + 'Z').toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' })}</td>
          <td>${esc(mv.name)}</td>
          <td class="${mv.delta < 0 ? 'qty-out' : 'qty-in'}">${mv.delta > 0 ? '+' : ''}${fmtQty(mv.delta)} ${esc(mv.unit)}</td>
          <td>${MOVE_REASON[mv.reason] || esc(mv.reason)}</td>
          <td>${esc(mv.note || '—')}</td>
        </tr>`).join('') : '<tr><td colspan="5" class="muted">Рухів ще не було.</td></tr>'}</tbody>
      </table>`;
    await loadServiceMaterials();
  }
  async function loadServiceMaterials() {
    const box = $('#matSvcBox');
    if (!box || !matService) { if (box) box.innerHTML = '<span class="muted">Немає послуг.</span>'; return; }
    const rows = await api('/api/admin/services/' + matService + '/materials');
    box.innerHTML = rows.length ? `<table>
        <thead><tr><th>Матеріал</th><th>Витрата на 1 послугу</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td><input type="number" class="sm-amount" data-material="${r.material_id}" min="0" step="any" value="${r.amount || ''}" placeholder="0" style="max-width:110px"> ${esc(r.unit)}</td></tr>`).join('')}</tbody>
      </table>
      <button class="btn btn-primary small" type="button" id="matSvcSave">Зберегти витрату</button>`
      : '<span class="muted">Спершу додайте матеріали.</span>';
  }
  $('#view').addEventListener('change', (e) => {
    if (e.target.id !== 'matSvc') return;
    matService = Number(e.target.value);
    loadServiceMaterials().catch((err) => notify(err.message, true));
  });
  $('#view').addEventListener('submit', async (e) => {
    if (e.target.id !== 'matForm') return;
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/admin/materials', { method: 'POST', body: { name: f.get('name'), unit: f.get('unit'), qty: f.get('qty') || 0, min_qty: f.get('min_qty') || 0 } });
      notify('Матеріал додано');
      await renderMaterials();
    } catch (err) { notify(err.message, true); }
  });

  // ----- Друк: вміст кладеться в #printArea, яку видно лише під час друку -----
  function printHtml(html) {
    const area = $('#printArea');
    area.innerHTML = html;
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); area.innerHTML = ''; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 50);
  }

  // ----- Подарункові сертифікати (лише суперадмін) -----
  const CERT_STATE = { active: 'Діє', used: 'Використано', void: 'Скасовано', expired: 'Термін минув' };
  let certList = [];
  async function renderCertificates() {
    certList = await api('/api/admin/certificates');
    $('#view').innerHTML = `
      <h3 style="margin:0 0 8px">Перевірити код</h3>
      <form class="inline-form" id="certCheck">
        <input name="code" placeholder="Код, наприклад ABCD-2345" maxlength="12" required style="text-transform:uppercase;max-width:220px">
        <button class="btn btn-ghost small" type="submit">Перевірити</button>
        <span id="certCheckRes" class="muted"></span>
      </form>
      <h3 style="margin:18px 0 8px">Новий сертифікат</h3>
      <form class="inline-form" id="certForm">
        <input name="amount_uah" type="number" min="1" step="1" placeholder="Сума, грн" required style="max-width:140px">
        <input name="recipient" maxlength="80" placeholder="Кому (необов'язково)">
        <input name="buyer" maxlength="80" placeholder="Від кого (необов'язково)">
        <label class="muted">Діє до <input name="expires_on" type="date" min="${today()}"></label>
        <input name="note" maxlength="300" placeholder="Примітка (необов'язково)">
        <button class="btn btn-primary small" type="submit">Створити</button>
      </form>
      <p class="muted" style="margin:-8px 0 14px">Без дати сертифікат безстроковий. Сертифікат одноразовий: використовується на всю суму.</p>
      <table>
        <thead><tr><th>Код</th><th>Сума</th><th>Кому</th><th>Від кого</th><th>Діє до</th><th>Стан</th><th></th></tr></thead>
        <tbody>${certList.length ? certList.map((c) => `<tr>
          <td><strong class="cert-code">${esc(c.code)}</strong></td>
          <td>${c.amount_uah.toLocaleString('uk-UA')} грн</td>
          <td>${esc(c.recipient || '—')}</td>
          <td>${esc(c.buyer || '—')}</td>
          <td>${c.expires_on ? fmtDate(c.expires_on) : 'безстроковий'}</td>
          <td><span class="cert-st cert-${c.state}">${CERT_STATE[c.state]}</span>${c.state === 'used' && c.used_at ? `<br><small class="muted">${new Date(c.used_at.replace(' ', 'T') + 'Z').toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}${c.used_note ? ', ' + esc(c.used_note) : ''}</small>` : ''}</td>
          <td><span class="toolbar" style="margin:0;flex-wrap:wrap">
            <button class="btn btn-ghost small" type="button" data-cert-print="${c.id}">Друк</button>
            ${c.state === 'active' ? `<button class="btn btn-primary small" type="button" data-cert-use="${c.id}">Використано</button>` : ''}
            ${c.state === 'active' || c.state === 'expired' ? `<button class="btn btn-ghost small danger" type="button" data-cert-void="${c.id}">Скасувати</button>` : ''}
          </span></td>
        </tr>`).join('') : '<tr><td colspan="7" class="muted">Сертифікатів ще немає.</td></tr>'}</tbody>
      </table>`;
  }
  async function printCertificate(c) {
    const s = await api('/api/admin/studio');
    const place = [s.city, s.address].filter(Boolean).join(', ');
    printHtml(`<div class="cert-print">
      <div class="cert-studio">${esc(s.name)}</div>
      <div class="cert-title">Подарунковий сертифікат</div>
      <div class="cert-amount">${c.amount_uah.toLocaleString('uk-UA')} грн</div>
      ${c.recipient ? `<div class="cert-line">для: <strong>${esc(c.recipient)}</strong></div>` : ''}
      ${c.buyer ? `<div class="cert-line">від: ${esc(c.buyer)}</div>` : ''}
      <div class="cert-code-big">${esc(c.code)}</div>
      <div class="cert-line">${c.expires_on ? 'Діє до ' + fmtDate(c.expires_on) : 'Безстроковий'} · одноразовий</div>
      <div class="cert-small">Назвіть код під час запису або на прийомі.${place ? '<br>' + esc(place) : ''}${s.phone ? ' · ' + esc(s.phone) : ''}</div>
    </div>`);
  }
  $('#view').addEventListener('submit', async (e) => {
    if (e.target.id === 'certForm') {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const c = await api('/api/admin/certificates', { method: 'POST', body: {
          amount_uah: Number(f.get('amount_uah')), recipient: f.get('recipient'), buyer: f.get('buyer'), expires_on: f.get('expires_on'), note: f.get('note'),
        } });
        notify('Сертифікат створено: ' + c.code);
        await renderCertificates();
      } catch (err) { notify(err.message, true); }
    }
    if (e.target.id === 'certCheck') {
      e.preventDefault();
      const out = $('#certCheckRes');
      try {
        const c = await api('/api/admin/certificates/check?code=' + encodeURIComponent(new FormData(e.target).get('code')));
        out.textContent = `${c.code}: ${CERT_STATE[c.state]}, ${c.amount_uah.toLocaleString('uk-UA')} грн${c.expires_on ? ', діє до ' + fmtDate(c.expires_on) : ''}${c.recipient ? ', для ' + c.recipient : ''}`;
        out.className = c.state === 'active' ? 'cert-ok' : 'cert-bad';
      } catch (err) { out.textContent = err.message; out.className = 'cert-bad'; }
    }
  });

  // ----- Майстри (лише суперадмін) -----
  const M_STATUS = { active: 'Працює', blocked: 'Заблоковано' };
  let editingMaster = null; // null — список, 'new' — новий майстер, число — редагування
  async function renderMasters() {
    masters = await api('/api/admin/masters');
    if (editingMaster !== null) {
      const services = await api('/api/admin/services');
      const m = editingMaster === 'new'
        ? { name: '', login: '', bio: '', photo: '', services: services.filter((s) => s.active).map((s) => s.id), has_password: false }
        : masters.find((x) => x.id === editingMaster);
      if (!m) { editingMaster = null; return renderMasters(); }
      const isNew = editingMaster === 'new';
      $('#view').innerHTML =
        '<button class="btn btn-ghost small" type="button" id="masterBack">← До списку майстрів</button>' +
        '<form class="master-form" id="masterForm">' +
        '<h3>' + (isNew ? 'Новий майстер' : esc(m.name)) + '</h3>' +
        '<label class="step-label" for="mfName">Ім\'я (так його бачать клієнти)</label>' +
        '<input class="input" id="mfName" maxlength="60" required value="' + esc(m.name) + '">' +
        '<label class="step-label" for="mfLogin">Логін для входу в адмінку</label>' +
        '<input class="input" id="mfLogin" maxlength="30" required autocomplete="off" placeholder="напр. olena" value="' + esc(m.login) + '">' +
        '<label class="step-label" for="mfPass">' + (isNew ? 'Пароль (не менше 8 символів)' : 'Новий пароль' + (m.has_password ? ' (порожньо — не змінювати)' : ' — ще не задано, майстер не може увійти')) + '</label>' +
        '<input class="input" id="mfPass" type="text" minlength="8" maxlength="100" autocomplete="new-password"' + (isNew ? ' required' : '') + '>' +
        '<label class="step-label" for="mfBio">Про майстра (для блоку «Наші майстри» на сайті)</label>' +
        '<textarea class="input" id="mfBio" rows="3" maxlength="600" placeholder="Досвід, спеціалізація, чим допомагає">' + esc(m.bio || '') + '</textarea>' +
        (isNew ? '<p class="muted">Фото можна додати після збереження майстра.</p>'
          : '<div class="step-label">Фото</div><div class="mf-photo">' +
            (m.photo ? '<img src="/media/masters/' + esc(m.photo) + '" alt="Фото: ' + esc(m.name) + '" id="mfPhotoImg">' : '<div class="mf-photo-empty" id="mfPhotoImg">' + esc(m.name.slice(0, 1)) + '</div>') +
            '<label class="btn btn-ghost small">Завантажити фото<input type="file" id="mfPhoto" accept="image/*" hidden></label>' +
            (m.photo ? '<button class="btn btn-ghost small danger" type="button" id="mfPhotoDel">Прибрати фото</button>' : '') + '</div>') +
        (isNew ? '' : '<div class="step-label">Календар у телефоні</div><div id="mfCal"><button class="btn btn-ghost small" type="button" id="mfCalNew">Створити посилання для майстра</button> <small class="muted">Нове посилання скасовує попереднє.</small></div>') +
        '<fieldset class="svc-field"><legend class="step-label">Послуги, які робить майстер</legend>' +
        '<div class="toolbar"><button class="btn btn-ghost small" type="button" id="svcAll">Позначити всі</button><button class="btn btn-ghost small" type="button" id="svcNone">Зняти всі</button></div>' +
        '<div class="svc-grid">' + services.map((s) => '<label class="svc-check"><input type="checkbox" name="svc" value="' + s.id + '"' +
          (m.services.includes(s.id) ? ' checked' : '') + '> ' + esc(s.name) + (s.active ? '' : ' <span class="muted">(вимкнена)</span>') + '</label>').join('') + '</div></fieldset>' +
        '<p class="muted">Передайте майстрові логін і пароль: він входить в адмінку через «Майстер» і бачить лише свої записи, клієнтів, графік і блокування.</p>' +
        '<div class="toolbar"><button class="btn btn-primary" type="submit">' + (isNew ? 'Додати майстра' : 'Зберегти') + '</button></div>' +
        '</form>';
      return;
    }
    $('#view').innerHTML =
      '<div class="toolbar"><button class="btn btn-primary small" type="button" id="masterNew">+ Новий майстер</button>' +
      '<span class="muted">Графік кожного майстра (години, перерви, разові блокування) налаштовується у вкладці «Розклад».</span></div>' +
      '<table><thead><tr><th>Ім\'я</th><th>Логін</th><th>Статус</th><th>Telegram</th><th>Послуг</th><th>Майбутніх записів</th><th></th></tr></thead><tbody>' +
      masters.map((m) => '<tr>' +
        '<td>' + esc(m.name) + (m.has_password ? '' : '<div class="muted small-note">пароль не задано: увійти не може</div>') + '</td>' +
        '<td>' + esc(m.login) + '</td>' +
        '<td><span class="m-status m-' + m.status + '">' + (M_STATUS[m.status] || esc(m.status)) + '</span></td>' +
        '<td>' + (m.telegram ? 'підключено' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + m.services.length + '</td><td>' + m.future + '</td>' +
        '<td class="m-actions">' +
          '<button class="btn btn-ghost small" type="button" data-edit-master="' + m.id + '">Редагувати</button>' +
          '<button class="btn btn-ghost small" type="button" data-sched-master="' + m.id + '">Графік</button>' +
          (m.status === 'active'
            ? '<button class="btn btn-ghost small" type="button" data-block-master="' + m.id + '">Заблокувати</button>'
            : '<button class="btn btn-ghost small" type="button" data-unblock-master="' + m.id + '">Розблокувати</button>') +
          '<button class="btn btn-ghost small danger" type="button" data-del-master="' + m.id + '">Видалити</button>' +
        '</td></tr>').join('') +
      '</tbody></table>';
  }
  // Фото майстра: стискаємо в браузері до 600 px (JPEG), щоб не завантажувати важкі файли з телефона
  async function shrinkPhoto(file, max = 600) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  $('#view').addEventListener('change', async (e) => {
    if (e.target.id !== 'mfPhoto' || !e.target.files[0]) return;
    try {
      const blob = await shrinkPhoto(e.target.files[0]);
      const r = await fetch('/api/admin/masters/' + editingMaster + '/photo', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'image/jpeg' }, body: blob });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Не вдалося завантажити фото');
      notify('Фото оновлено');
      await renderMasters();
    } catch (err) {
      notify(err.message || 'Не вдалося прочитати фото', true);
    }
  });

  // Форма майстра: окремий обробник, щоб не потрапити в загальну обробку форм нижче
  $('#view').addEventListener('submit', async (e) => {
    if (e.target.id !== 'masterForm') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const body = {
      name: $('#mfName').value,
      login: $('#mfLogin').value,
      password: $('#mfPass').value,
      services: [...document.querySelectorAll('#masterForm input[name="svc"]:checked')].map((x) => Number(x.value)),
      bio: $('#mfBio').value,
    };
    try {
      if (editingMaster === 'new') await api('/api/admin/masters', { method: 'POST', body });
      else await api('/api/admin/masters/' + editingMaster, { method: 'PUT', body });
      notify(editingMaster === 'new' ? 'Майстра додано' : 'Збережено');
      editingMaster = null;
      await renderMasters();
    } catch (err) {
      notify(err.message, true);
    }
  });

  // ----- Поради з догляду -----
  let editingTip = null; // null — список, 'new' — нова порада, число — редагування
  async function renderTips() {
    const list = await api('/api/admin/tips');
    if (editingTip !== null) {
      const t = editingTip === 'new' ? { title: '', summary: '', body: '', published: 0 } : list.find((x) => x.id === editingTip);
      if (!t) { editingTip = null; return renderTips(); }
      $('#view').innerHTML =
        '<button class="btn btn-ghost small" type="button" id="tipBack">← До списку порад</button>' +
        '<form class="tips-editor" id="tipForm">' +
        '<label class="step-label" for="tipTitle">Заголовок</label><input class="input" id="tipTitle" maxlength="120" required value="' + esc(t.title) + '">' +
        '<label class="step-label" for="tipSummary">Короткий опис (для картки на сайті й пошуку Google)</label><input class="input" id="tipSummary" maxlength="300" value="' + esc(t.summary) + '">' +
        '<label class="step-label" for="tipBody">Текст. Абзаци розділяйте порожнім рядком</label><textarea class="input" id="tipBody" rows="14" maxlength="20000">' + esc(t.body) + '</textarea>' +
        '<label><input type="checkbox" id="tipPublished"' + (t.published ? ' checked' : '') + '> Опублікувати на сайті</label>' +
        '<div class="toolbar"><button class="btn btn-primary" type="submit">Зберегти</button>' +
        (t.slug && t.published ? '<a class="btn btn-ghost small" href="/tips/' + encodeURIComponent(t.slug) + '" target="_blank" rel="noopener">Відкрити на сайті</a>' : '') + '</div>' +
        '</form>';
      return;
    }
    $('#view').innerHTML =
      '<div class="toolbar"><button class="btn btn-primary small" type="button" id="tipNew">+ Нова порада</button>' +
      '<span class="muted">На сайті видно лише опубліковані. Кожна має окрему сторінку, яку бачить Google.</span></div>' +
      '<table><thead><tr><th>Заголовок</th><th>Статус</th><th>Оновлено</th><th></th></tr></thead><tbody>' +
      (list.length ? list.map((t) => '<tr><td>' + esc(t.title) + '</td><td>' + (t.published ? 'Опубліковано' : '<span class="muted">Чернетка</span>') + '</td>' +
        '<td>' + fmtDate(t.updated) + '</td><td><button class="btn btn-ghost small" type="button" data-edit-tip="' + t.id + '">Редагувати</button> ' +
        '<button class="btn btn-ghost small danger" type="button" data-del-tip="' + t.id + '">Видалити</button></td></tr>').join('')
        : '<tr><td colspan="4" class="muted">Порад поки немає.</td></tr>') + '</tbody></table>';
  }
  // Обробник форми порад: #view уже є в розмітці, тож вішаємо його напряму (змінну view оголошено нижче)
  $('#view').addEventListener('submit', async (e) => {
    if (e.target.id !== 'tipForm') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const body = { title: $('#tipTitle').value, summary: $('#tipSummary').value, body: $('#tipBody').value, published: $('#tipPublished').checked };
    try {
      if (editingTip === 'new') await api('/api/admin/tips', { method: 'POST', body });
      else await api('/api/admin/tips/' + editingTip, { method: 'PUT', body });
      notify('Пораду збережено');
      editingTip = null;
      await renderTips();
    } catch (err) {
      notify(err.message, true);
    }
  });

  // ----- Статистика -----
  let statsMonth = today().slice(0, 7);
  async function renderStats() {
    const s = await api('/api/admin/stats?month=' + statsMonth + (statsMaster ? '&masterId=' + statsMaster : ''));
    const tile = (value, label, hint) => '<div class="stat-tile"><div class="stat-tile-num">' + value + '</div><div class="stat-tile-label">' + label + '</div>' + (hint ? '<div class="muted stat-tile-hint">' + hint + '</div>' : '') + '</div>';
    const maxTop = Math.max(1, ...s.topServices.map((t) => t.count));
    $('#view').innerHTML =
      '<div class="toolbar"><label>Місяць <input type="month" id="statsMonth" value="' + s.month + '"></label>' + masterSelect('statsMaster', statsMaster, 'Увесь кабінет') + '</div>' +
      '<div class="stat-tiles">' +
        tile(s.active, 'записів', 'з них відбулось: ' + s.done) +
        tile(s.cancelled, 'скасовано', s.total ? Math.round((s.cancelled / s.total) * 100) + '% від усіх' : '') +
        tile(s.noShows, 'не прийшли', s.noShows ? s.noShowPercent + '% від минулих записів' : 'неявок немає') +
        tile(s.newClients, 'нових клієнтів', 'усього клієнтів: ' + s.uniqueClients) +
        tile(s.loadPercent + '%', 'заповненість розкладу', s.bookedHours.toLocaleString('uk-UA') + ' з ' + s.availableHours.toLocaleString('uk-UA') + ' год') +
        tile(s.revenue ? s.revenue.toLocaleString('uk-UA') + ' грн' : '—', 'орієнтовний дохід', s.revenue ? 'за ' + s.revenueCount + ' візитами з вказаною ціною' : 'ціни послуг не вказані') +
        tile(s.avgRating ? '★ ' + s.avgRating.toLocaleString('uk-UA') : '—', 'середня оцінка', 'відгуків: ' + s.reviews) +
        tile(s.waitlist, 'у черзі очікування', '') +
      '</div>' +
      '<h3 style="margin:24px 0 10px">Найпопулярніші послуги</h3>' +
      (s.topServices.length ? '<div class="top-services">' + s.topServices.map((t) =>
        '<div class="top-row"><span class="top-name">' + esc(t.name) + '</span><span class="top-bar"><span style="width:' + Math.round((t.count / maxTop) * 100) + '%"></span></span><span class="top-count">' + t.count + '</span></div>').join('') + '</div>'
        : '<p class="muted">У цьому місяці записів немає.</p>');
    await renderMastersReport(s.month);
  }

  // Звіт по майстрах за місяць (у «Статистиці»): для розрахунку з майстрами, з вивантаженням у CSV
  async function renderMastersReport(month) {
    const r = await api('/api/admin/reports/masters?month=' + month);
    const money = (n) => n ? n.toLocaleString('uk-UA') + ' грн' : '—';
    const row = (x, bold) => `<tr${bold ? ' class="rep-total"' : ''}><td>${esc(x.master)}</td><td>${x.visits}</td><td>${money(x.revenue)}</td><td>${money(x.avg)}</td><td>${x.no_shows}</td><td>${x.cancelled}</td><td>${x.unmarked}</td></tr>`;
    $('#view').insertAdjacentHTML('beforeend', `
      <h3 style="margin:28px 0 4px">Звіт по майстрах</h3>
      <p class="muted" style="margin:0 0 8px">Візит — запис «Відбувся» або минулий, ще не позначений. Сума — за ціною на момент запису.</p>
      ${r.total.unmarked ? `<div class="warn-box" style="margin:0 0 10px">Не позначено записів: ${r.total.unmarked}. Позначте їх у «Записи» → «Закрити день», щоб звіт був точним.</div>` : ''}
      ${r.rows.length ? `<table class="rep-table">
        <thead><tr><th>Майстер</th><th>Візитів</th><th>Сума</th><th>Середній чек</th><th>Не прийшли</th><th>Скасовано</th><th>Не позначено</th></tr></thead>
        <tbody>${r.rows.map((x) => row(x)).join('')}${r.rows.length > 1 ? row({ master: 'Усього', ...r.total }, true) : ''}</tbody>
      </table>` : '<p class="muted">У цьому місяці записів немає.</p>'}
      ${r.total.price_now ? `<p class="muted">За поточною ціною послуги пораховано візитів: ${r.total.price_now} (записи, створені до того, як сайт почав запам'ятовувати ціну).</p>` : ''}
      <div class="toolbar" style="margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-ghost small" type="button" data-csv="masters">Вивантажити звіт (CSV)</button>
        <button class="btn btn-ghost small" type="button" data-csv="appointments">Вивантажити всі записи місяця (CSV)</button>
      </div>`);
  }
  async function downloadCsv(url, filename) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Не вдалося вивантажити файл');
    const href = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
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
        ${field('owner_legal', 'Хто обробляє дані, наприклад «ФОП Іваненко Олена Петрівна»', 120, 'Показується на сторінці <a href="/privacy" target="_blank" rel="noopener">«Обробка персональних даних»</a>. Текст цієї сторінки — шаблон, варто перевірити його з юристом.')}
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
      if (e.target.id === 'apptMaster') { apptMaster = e.target.value; return await renderAppointments(); }
      if (e.target.id === 'afService') { fillMasterOptions($('#afMaster')?.value || ''); afTime = null; return await loadFormSlots(); }
      if (e.target.id === 'afMaster' || e.target.id === 'afDate') { return await loadFormSlots(); }
      if (e.target.id === 'calDate') { if (e.target.value) calDate = e.target.value; return await renderAppointments(); }
      if (e.target.id === 'schedMaster') { schedMaster = Number(e.target.value); return await renderSchedule(); }
      if (e.target.id === 'statsMaster') { statsMaster = e.target.value; return await renderStats(); }
      if (e.target.id === 'archiveMonths') {
        await api('/api/admin/archive-months', { method: 'PUT', body: { months: Number(e.target.value) } });
        notify('Збережено');
        return await loadClients();
      }
      if (e.target.id === 'statsMonth') {
        if (e.target.value) statsMonth = e.target.value;
        return await renderStats();
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
      if (e.target.id === 'calPrint') return await printSchedule();
      if (e.target.dataset.csv) {
        const kind = e.target.dataset.csv;
        const q = 'month=' + statsMonth + (kind === 'appointments' && statsMaster ? '&masterId=' + statsMaster : '');
        await downloadCsv(`/api/admin/reports/${kind}.csv?${q}`, `${kind === 'masters' ? 'zvit-maystry' : 'zapysy'}-${statsMonth}.csv`);
        return notify('Файл завантажено');
      }
      if (e.target.id === 'tplBtn') return tplMenuOpen($('#tplMenu').hidden);
      if (e.target.closest('[data-tpl-use]')) {
        const t = chatTemplates.find((x) => x.id === Number(e.target.closest('[data-tpl-use]').dataset.tplUse));
        const input = $('#replyInput');
        if (t && input) {
          input.value = input.value.trim() ? input.value.trim() + ' ' + t.text : t.text;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
        return tplMenuOpen(false);
      }
      if (e.target.dataset.tplEdit) {
        const t = chatTemplates.find((x) => x.id === Number(e.target.dataset.tplEdit));
        const f = $('#tplForm');
        if (!t || !f) return;
        f.title.value = t.title;
        f.body.value = t.body;
        f.dataset.editing = t.id;
        $('#tplSave').textContent = 'Зберегти зміни';
        $('#tplCancel').hidden = false;
        return f.title.focus();
      }
      if (e.target.id === 'tplCancel') {
        const f = $('#tplForm');
        delete f.dataset.editing;
        f.reset();
        $('#tplSave').textContent = 'Додати шаблон';
        e.target.hidden = true;
        return;
      }
      if (e.target.dataset.tplDel) {
        if (!confirm('Видалити шаблон?')) return;
        await api('/api/admin/chat-templates/' + e.target.dataset.tplDel, { method: 'DELETE' });
        notify('Шаблон видалено');
        return await loadTemplates();
      }
      if (e.target.dataset.holDel) {
        if (!confirm('Відкрити цей день знову? Клієнти зможуть записатися.')) return;
        await api('/api/admin/holidays/' + e.target.dataset.holDel, { method: 'DELETE' });
        notify('День відкрито');
        return await renderHolidays();
      }
      if (e.target.dataset.holFix) {
        // записи майстра на свято — у «Майстер не вийде» на цю дату (закривати не треба: свято вже закрите)
        const [mid, date] = e.target.dataset.holFix.split('|');
        closeDay = null;
        apptForm = null;
        absence = { step: 'form', masterId: Number(mid), from: date, to: date, block: false, note: '' };
        show('appointments');
        return await loadAbsencePlan();
      }
      if (e.target.closest('#apptCloseDay')) { closeDay = {}; return await renderCloseDay(); }
      if (e.target.id === 'cdBack') { closeDay = null; return await renderAppointments(); }
      if (e.target.dataset.cdAll) {
        document.querySelectorAll('.cd-status').forEach((s) => { s.value = e.target.dataset.cdAll; });
        return;
      }
      if (e.target.id === 'cdSave') {
        const items = [...document.querySelectorAll('[data-cd-row]')]
          .map((row) => ({ id: Number(row.dataset.cdRow), status: row.querySelector('.cd-status').value }))
          .filter((x) => x.status !== 'keep');
        if (!items.length) return notify('Нічого не обрано');
        e.target.disabled = true;
        try {
          const r = await api('/api/admin/close-day', { method: 'POST', body: { items } });
          const c = r.counts;
          notify(`Збережено: відбулось ${c.done}, не прийшли ${c.no_show}, скасовано ${c.cancelled}` + (c.failed ? `, не вдалося ${c.failed}` : ''), c.failed > 0);
          return await renderCloseDay();
        } finally { e.target.disabled = false; }
      }

      if (e.target.id === 'apptAbsence') {
        const first = masters.find((m) => m.status === 'active') || masters[0];
        absence = { step: 'form', masterId: first ? first.id : null, from: today(), to: today(), block: true, note: '' };
        return await renderAbsence();
      }
      if (e.target.id === 'absBack' || e.target.id === 'absDone') { absence = null; return await renderAppointments(); }
      if (e.target.id === 'absEdit') { absence.step = 'form'; return await renderAbsence(); }
      if (e.target.id === 'absApply') {
        const a = absence;
        const actions = [...document.querySelectorAll('[data-abs-row]')].map((row) => {
          const v = row.querySelector('.abs-action').value;
          const id = Number(row.dataset.absRow);
          if (v.startsWith('master:')) return { id, type: 'master', master_id: Number(v.slice(7)) };
          if (v.startsWith('time:')) { const [date, time, mid] = v.slice(5).split('|'); return { id, type: 'time', date, time, master_id: Number(mid) }; }
          return { id, type: v };
        });
        const n = (t) => actions.filter((x) => x.type === t).length;
        if (actions.length && !confirm(`Застосувати? Передати іншим майстрам: ${n('master')}, перенести: ${n('time')}, скасувати: ${n('cancel')}, лишити: ${n('keep')}.` +
          (a.block ? ' Запис до майстра на ці дні буде закрито.' : '') + ' Клієнтам із Telegram бот напише сам.')) return;
        e.target.disabled = true;
        try {
          a.result = await api('/api/admin/reassign', { method: 'POST', body: { masterId: a.masterId, from: a.from, to: a.to, block: a.block, note: a.note, actions } });
          a.step = 'done';
          notify('Готово');
          return await renderAbsence();
        } finally { e.target.disabled = false; }
      }

      if (e.target.id === 'apptNew') {
        apptForm = { mode: 'new', preset: { date: apptView === 'table' ? today() : calDate, masterId: isSuper() ? apptMaster : '' } };
        return await renderAppointments();
      }
      if (e.target.id === 'apptFormBack') { apptForm = null; return await renderAppointments(); }
      if (['viewTable', 'viewDay', 'viewWeek'].includes(e.target.id)) {
        apptView = { viewTable: 'table', viewDay: 'day', viewWeek: 'week' }[e.target.id];
        apptForm = null;
        return await renderAppointments();
      }
      const shiftBtn = e.target.closest('[data-cal-shift]');
      if (shiftBtn) {
        const n = Number(shiftBtn.dataset.calShift);
        calDate = n === 0 ? today() : shiftDay(calDate, n * (apptView === 'week' ? 7 : 1));
        return await renderAppointments();
      }
      const calAppt = e.target.closest('[data-cal-appt]');
      if (calAppt) {
        const a = (window.__calAppts || []).find((x) => String(x.id) === calAppt.dataset.calAppt);
        if (!a) return;
        if (a.date < today()) return notify('Минулий запис перенести не можна', true);
        apptForm = { mode: 'move', appt: { ...a, master: (window.__calMasters || []).find((m) => m.id === a.master_id)?.name || '' } };
        return await renderAppointments();
      }
      if (e.target.classList && e.target.classList.contains('cal-body')) {
        const body = e.target;
        const minute = Number(body.dataset.calStart) + Math.floor(e.offsetY / PPM / 30) * 30;
        if (body.dataset.calDate < today()) return;
        apptForm = { mode: 'new', preset: { date: body.dataset.calDate, masterId: isSuper() ? body.dataset.calMaster : '', time: toHHMM(minute) } };
        return await renderAppointments();
      }
      if (e.target.dataset.moveAppt) {
        const a = lastApptRows.find((x) => String(x.id) === e.target.dataset.moveAppt);
        if (a) { apptForm = { mode: 'move', appt: a }; return await renderAppointments(); }
        return;
      }
      if (e.target.dataset.afTime) {
        afTime = e.target.dataset.afTime;
        document.querySelectorAll('[data-af-time]').forEach((b) => b.classList.toggle('selected', b === e.target));
        return;
      }
      if (e.target.id === 'apptUpcoming' || e.target.id === 'apptArchiveBtn' || e.target.id === 'apptWaitBtn') {
        apptWaitlist = e.target.id === 'apptWaitBtn';
        apptArchive = e.target.id === 'apptArchiveBtn';
        return await renderAppointments();
      }
      if (e.target.dataset.delWait) {
        await api('/api/admin/waitlist/' + e.target.dataset.delWait, { method: 'DELETE' });
        return await renderWaitlist();
      }
      const conv = e.target.closest('[data-conv]');
      if (conv) return await openConv(conv.dataset.conv);

      if (e.target.dataset.client) return await renderClient(e.target.dataset.client);

      if (e.target.id === 'clientBack') {
        currentClient = null;
        return await renderClients();
      }

      if (e.target.id === 'clientsCsv') return await downloadClientsCsv();
      if (e.target.id === 'masterNew') { editingMaster = 'new'; return await renderMasters(); }
      if (e.target.id === 'masterBack') { editingMaster = null; return await renderMasters(); }
      if (e.target.id === 'mfCalNew') {
        if (!confirm('Створити нове посилання на календар майстра? Попереднє перестане працювати.')) return;
        const r = await api('/api/admin/masters/' + editingMaster + '/calendar', { method: 'POST' });
        $('#mfCal').innerHTML = calLinkHtml(r);
        return;
      }

      if (e.target.id === 'mfPhotoDel') {
        await api('/api/admin/masters/' + editingMaster + '/photo', { method: 'DELETE' });
        notify('Фото прибрано');
        return await renderMasters();
      }
      if (e.target.id === 'svcAll' || e.target.id === 'svcNone') {
        document.querySelectorAll('#masterForm input[name="svc"]').forEach((x) => { x.checked = e.target.id === 'svcAll'; });
        return;
      }
      if (e.target.dataset.editMaster) { editingMaster = Number(e.target.dataset.editMaster); return await renderMasters(); }
      if (e.target.dataset.schedMaster) { schedMaster = Number(e.target.dataset.schedMaster); return show('schedule'); }
      if (e.target.dataset.blockMaster) {
        if (!confirm('Заблокувати майстра? Він не зможе входити в адмінку, а клієнти не бачитимуть його вільний час. Наявні записи лишаться.')) return;
        const r = await api('/api/admin/masters/' + e.target.dataset.blockMaster + '/block', { method: 'POST' });
        notify(r.future ? 'Заблоковано. У майстра лишаються майбутні записи: ' + r.future + '. Перевірте їх у «Записах».' : 'Майстра заблоковано', !!r.future);
        return await renderMasters();
      }
      if (e.target.dataset.unblockMaster) {
        await api('/api/admin/masters/' + e.target.dataset.unblockMaster + '/unblock', { method: 'POST' });
        notify('Майстра розблоковано');
        return await renderMasters();
      }
      if (e.target.dataset.delMaster) {
        if (!confirm('Видалити майстра? Він зникне з сайту й адмінки, а історія його записів збережеться.')) return;
        await api('/api/admin/masters/' + e.target.dataset.delMaster, { method: 'DELETE' });
        notify('Майстра видалено, історію збережено');
        return await renderMasters();
      }
      if (e.target.id === 'tipNew') { editingTip = 'new'; return await renderTips(); }
      if (e.target.id === 'tipBack') { editingTip = null; return await renderTips(); }
      if (e.target.dataset.editTip) { editingTip = Number(e.target.dataset.editTip); return await renderTips(); }
      if (e.target.dataset.delTip) {
        if (!confirm('Видалити пораду назавжди?')) return;
        await api('/api/admin/tips/' + e.target.dataset.delTip, { method: 'DELETE' });
        return await renderTips();
      }
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
      if (e.target.dataset.archiveClient) {
        await api('/api/admin/clients/' + e.target.dataset.archiveClient + '/archive', { method: 'POST' });
        notify('Клієнта перенесено в архів');
        return await loadClients();
      }
      if (e.target.dataset.restore) {
        await api('/api/admin/clients/' + e.target.dataset.restore + '/restore', { method: 'POST' });
        notify('Клієнта повернуто з архіву');
        return await loadClients();
      }

      if (e.target.id === 'cmpOpen') return openCompare('slider');

      if (e.target.id === 'cpConsentPrint') {
        const [st, c] = await Promise.all([api('/api/settings'), api('/api/admin/clients/' + currentClient)]);
        const s = st.studio;
        const who = s.owner_legal ? esc(s.owner_legal) + ' (кабінет «' + esc(s.name) + '»)' : 'кабінету «' + esc(s.name) + '»';
        const place = [s.city, s.address].filter(Boolean).map(esc).join(', ');
        printHtml(`<div class="consent-print">
          <h1>Згода на фотографування стоп<br>і зберігання фото</h1>
          <p>Я, <span class="fill">${esc(c.name)}</span>, телефон <span class="fill">${esc(c.phone)}</span>,</p>
          <p>даю згоду ${who} на фотографування стану моїх стоп і зберігання цих фото, щоб вести історію лікування й бачити його результат.</p>
          <p>Мене повідомлено, що:</p>
          <ul>
            <li>фото бачать лише адміністратор кабінету і майстер, який мене веде;</li>
            <li>фото не публікуються і не передаються іншим особам без моєї окремої згоди;</li>
            <li>фото зберігаються на сервері кабінету з резервною копією;</li>
            <li>я можу відкликати згоду будь-коли: тоді нові фото не робитимуть, а наявні видалять на мою вимогу;</li>
            <li>обробка відбувається відповідно до Закону України «Про захист персональних даних».</li>
          </ul>
          <div class="consent-sign">
            <div>Дата: «____» ______________ 20___ р.</div>
            <div>Підпис: ______________ / ______________________</div>
          </div>
          ${place || s.phone ? `<p class="consent-foot">${place}${place && s.phone ? ' · ' : ''}${esc(s.phone || '')}</p>` : ''}
        </div>`);
        return;
      }

      if (e.target.dataset.certPrint) {
        const c = certList.find((x) => x.id === Number(e.target.dataset.certPrint));
        if (c) await printCertificate(c);
        return;
      }
      if (e.target.dataset.certUse) {
        const note = prompt('Позначити сертифікат використаним. Примітка (необов\'язково), наприклад «медичний педикюр, Олена»:');
        if (note === null) return;
        await api('/api/admin/certificates/' + e.target.dataset.certUse + '/use', { method: 'POST', body: { note } });
        notify('Сертифікат позначено використаним');
        return await renderCertificates();
      }
      if (e.target.dataset.certVoid) {
        if (!confirm('Скасувати сертифікат? Код перестане діяти.')) return;
        await api('/api/admin/certificates/' + e.target.dataset.certVoid + '/void', { method: 'POST' });
        notify('Сертифікат скасовано');
        return await renderCertificates();
      }

      if (e.target.dataset.matIn || e.target.dataset.matOut) {
        const id = e.target.dataset.matIn || e.target.dataset.matOut;
        const isIn = !!e.target.dataset.matIn;
        const v = prompt(isIn ? 'Скільки надійшло?' : 'Скільки списати (брак, термін придатності, інше)?');
        if (v === null) return;
        const n = Number(String(v).replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) return notify('Вкажіть додатне число', true);
        const note = isIn ? '' : (prompt('Причина списання (необов\'язково)') || '');
        await api('/api/admin/materials/' + id + '/move', { method: 'POST', body: { delta: isIn ? n : -n, note } });
        notify(isIn ? 'Прихід записано' : 'Списано');
        return await renderMaterials();
      }
      if (e.target.dataset.matSave) {
        const row = e.target.closest('tr');
        await api('/api/admin/materials/' + e.target.dataset.matSave, { method: 'PUT', body: {
          name: row.querySelector('.m-name').value, unit: row.querySelector('.m-unit').value,
          min_qty: row.querySelector('.m-min').value || 0, active: row.querySelector('.m-active').checked,
        } });
        notify('Збережено');
        return await renderMaterials();
      }
      if (e.target.id === 'matSvcSave') {
        const items = [...document.querySelectorAll('.sm-amount')].map((i) => ({ material_id: Number(i.dataset.material), amount: i.value || 0 }));
        await api('/api/admin/services/' + matService + '/materials', { method: 'PUT', body: { items } });
        return notify('Витрату збережено');
      }

      if (e.target.id === 'clientErase' && currentClient) {
        const key = currentClient;
        const p = await api('/api/admin/clients/' + key + '/erase-preview');
        const parts = [`записів — ${p.appointments}` + (p.future ? ` (з них майбутніх — ${p.future})` : ''), `фото стоп — ${p.photos}`,
          `відгуків — ${p.reviews}`, `заявок у черзі — ${p.waitlist}`, p.account ? 'кабінет клієнта' : '', p.note ? 'нотатка' : ''].filter(Boolean);
        const typed = prompt(`Видалити всі дані клієнта «${p.name}»?\n\nБуде видалено: ${parts.join(', ')}.\n` +
          'Скасувати це неможливо. У резервних копіях дані зникнуть, коли старі копії видаляться (зазвичай через 30 днів). ' +
          'Анонімний чат на сайті й імена в сертифікатах видаляються окремо.\n\nЩоб підтвердити, введіть останні 4 цифри телефону клієнта:');
        if (typed === null) return;
        if (typed.trim() !== key.slice(-4)) return notify('Цифри не збігаються — клієнта не видалено', true);
        await api('/api/admin/clients/' + key, { method: 'DELETE', body: { confirm: typed.trim() } });
        notify('Дані клієнта видалено');
        currentClient = null;
        currentClientData = null;
        return show('clients');
      }

      if (e.target.id === 'clientBook' && currentClientData) {
        const c = currentClientData;
        // суперадміну підставляємо майстра з останнього запису клієнта; майстер записує до себе
        apptForm = { mode: 'new', preset: { name: c.name, phone: c.phone, masterId: isSuper() ? (c.appointments[0]?.master_id || '') : '' } };
        return show('appointments');
      }

      if (e.target.dataset.courseBook) {
        const [pi, si] = e.target.dataset.courseBook.split(':').map(Number);
        const p = currentCourses[pi], st = p && p.steps[si];
        if (!st) return;
        apptForm = { mode: 'new', preset: {
          serviceId: p.next_service_id, date: st.planned >= today() ? st.planned : today(),
          masterId: isSuper() ? p.start.master_id : '', name: p.client.name, phone: p.client.phone,
        } };
        return show('appointments');
      }

      if (e.target.dataset.delPhoto) {
        if (!confirm('Видалити фото? Його не можна буде відновити.')) return;
        await api('/api/admin/client-photos/' + e.target.dataset.delPhoto, { method: 'DELETE' });
        notify('Фото видалено');
        return await loadClientPhotos(currentClient);
      }

      if (e.target.closest('[data-open-photo]')) {
        const img = e.target.closest('[data-open-photo]').querySelector('img');
        if (img && img.src.startsWith('blob:')) window.open(img.src, '_blank', 'noopener');
        return;
      }

      if (e.target.id === 'saveClientNote') {
        await api(`/api/admin/clients/${currentClient}/note`, { method: 'PUT', body: { note: $('#clientNote').value } });
        return notify('Нотатку збережено');
      }

      if (e.target.dataset.saveVisitNote) {
        const input = e.target.closest('tr').querySelector('.visit-note');
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
          body: { weekdays, start_time: data.start_time, end_time: data.end_time, note: data.note, master_id: isSuper() ? schedMasterId() : undefined },
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
          body: { date: blockDate, start_time: data.start_time, end_time: data.end_time, note: data.note, master_id: isSuper() ? schedMasterId() : undefined },
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
            repeat_weeks: Number(data.repeat_weeks || 0),
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
    start();
  }
})();
