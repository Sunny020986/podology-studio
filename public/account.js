// Особистий кабінет клієнта: вхід, реєстрація, записи, Telegram і відновлення пароля.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (d) => d.split('-').reverse().join('.');
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const STATUS_TEXT = { new: 'очікує підтвердження', confirmed: 'підтверджено', cancelled: 'скасовано' };

  const overlay = $('#accOverlay');
  const body = $('#accBody');
  const state = { me: null, maxDate: null, authTab: 'login', resetPhone: '' };

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Помилка, спробуйте ще раз');
    return data;
  }

  const setMsg = (id, text, ok = false) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('ok', ok);
  };

  function open() {
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    $('#accTitle').focus?.();
    refresh();
  }
  function close() {
    overlay.hidden = true;
    document.body.style.overflow = '';
  }
  $('#accountBtn').addEventListener('click', open);

  // Кнопка в шапці: після входу на ній світиться ім'я клієнта
  function updateHeader() {
    const btn = $('#accountBtn');
    const name = state.me ? state.me.name.trim().split(/\s+/)[0] : '';
    btn.classList.toggle('acc-logged', !!state.me);
    btn.textContent = name || 'Кабінет';
    btn.title = state.me ? 'Особистий кабінет: ' + state.me.name : '';
    btn.setAttribute('aria-label', state.me ? 'Особистий кабінет, ' + state.me.name : 'Особистий кабінет');
  }
  // Одразу після завантаження сторінки перевіряємо, чи клієнт уже увійшов
  api('/api/account/me').then((me) => { state.me = me; updateHeader(); }).catch(() => {});
  $('#accClose').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });

  async function refresh() {
    try {
      state.me = await api('/api/account/me');
    } catch (e) {
      state.me = null;
    }
    updateHeader();
    if (state.me) return renderHome();
    renderAuth();
  }

  // ----- Вхід, реєстрація, відновлення -----
  function renderAuth() {
    const tabs = [['login', 'Вхід'], ['register', 'Реєстрація'], ['reset', 'Забули пароль']];
    body.innerHTML = `
      <div class="acc-tabs">${tabs.map(([k, v]) => `<button class="acc-tab ${state.authTab === k ? 'active' : ''}" type="button" data-tab="${k}">${v}</button>`).join('')}</div>
      ${state.authTab === 'login' ? loginForm() : ''}
      ${state.authTab === 'register' ? registerForm() : ''}
      ${state.authTab === 'reset' ? resetForms() : ''}
      <p class="acc-note muted">Запис на сайті без реєстрації теж працює. Кабінет потрібен, щоб бачити свої записи й змінювати їх.</p>`;
  }

  const phoneField = (id) => `
    <label class="step-label" for="${id}">Телефон</label>
    <input class="input" id="${id}" name="phone" type="tel" autocomplete="tel" required placeholder="+380501234567" maxlength="30">`;
  const passField = (id, label, auto) => `
    <label class="step-label" for="${id}">${label}</label>
    <div class="pass-wrap">
      <input class="input" id="${id}" name="password" type="password" autocomplete="${auto}" required minlength="8" maxlength="100">
      <button class="pass-eye" type="button" data-eye="${id}" aria-label="Показати пароль" aria-pressed="false"><svg class="eye-open" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-closed" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2"/><path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg></button>
    </div>`;

  const loginForm = () => `
    <form class="acc-form" id="loginForm">
      ${phoneField('lPhone')}
      ${passField('lPass', 'Пароль', 'current-password')}
      <p class="acc-msg" id="lMsg" role="status"></p>
      <button class="btn btn-primary btn-block" type="submit">Увійти</button>
    </form>`;

  const registerForm = () => `
    <form class="acc-form" id="registerForm">
      <label class="step-label" for="rName">Імʼя</label>
      <input class="input" id="rName" name="name" required minlength="2" maxlength="60" autocomplete="name">
      ${phoneField('rPhone')}
      ${passField('rPass', 'Пароль (не менше 8 символів)', 'new-password')}
      <p class="acc-msg" id="rMsg" role="status"></p>
      <button class="btn btn-primary btn-block" type="submit">Створити кабінет</button>
    </form>`;

  const resetForms = () => `
    <form class="acc-form" id="resetRequestForm">
      <p class="muted">Введіть телефон. Якщо ваш акаунт прив'язаний до Telegram, код надійде в бот. Інакше напишіть оператору в чат.</p>
      ${phoneField('xPhone')}
      <p class="acc-msg" id="xMsg" role="status"></p>
      <button class="btn btn-ghost btn-block" type="submit">Надіслати код</button>
    </form>
    <form class="acc-form" id="resetConfirmForm">
      <label class="step-label" for="xCode">Код із Telegram</label>
      <input class="input" id="xCode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 цифр">
      ${passField('xPass', 'Новий пароль (не менше 8 символів)', 'new-password')}
      <p class="acc-msg" id="x2Msg" role="status"></p>
      <button class="btn btn-primary btn-block" type="submit">Змінити пароль</button>
    </form>`;

  // ----- Кабінет клієнта -----
  async function renderHome() {
    const me = state.me;
    body.innerHTML = `
      <p>Вітаю, <b>${esc(me.name)}</b>. Телефон: ${esc(me.phone)}</p>
      <div class="acc-tg">
        ${me.telegram
          ? '<p class="muted">Telegram підключено: нагадування про записи надходитимуть у бот.</p><button class="btn btn-ghost small" type="button" data-act="tg-unlink">Відключити Telegram</button>'
          : '<p class="muted">Підключіть Telegram: нагадування про записи і код для відновлення пароля надходитимуть у бот.</p><button class="btn btn-ghost small" type="button" data-act="tg-link">Підключити Telegram</button>'}
        <p class="acc-msg" id="tgMsg" role="status"></p>
      </div>
      <h3 class="acc-h">Мої записи</h3>
      <ul class="acc-list" id="apptList"><li class="muted">Завантажую…</li></ul>
      <div class="acc-actions"><button class="btn btn-ghost small" type="button" data-act="logout">Вийти</button></div>`;
    await loadAppointments();
  }

  async function loadAppointments() {
    const list = $('#apptList');
    if (!list) return;
    try {
      const items = await api('/api/account/appointments');
      if (!items.length) {
        list.innerHTML = '<li class="muted">Записів ще немає. Оберіть послугу на сайті.</li>';
        return;
      }
      const upcoming = items.filter((a) => a.upcoming);
      const past = items.filter((a) => !a.upcoming);
      const row = (a) => `
        <li class="acc-appt" data-appt="${a.id}" data-sid="${a.service_id}">
          <div><b>${esc(a.service)}</b></div>
          <div class="muted">${fmt(a.date)} о ${a.start_time}–${a.end_time} · ${STATUS_TEXT[a.status] || esc(a.status)}</div>
          ${a.upcoming && a.status !== 'cancelled' && a.canChange
            ? `<div class="acc-actions">
                 <button class="btn btn-ghost small" type="button" data-act="move" data-id="${a.id}">Перенести</button>
                 <button class="btn btn-ghost small" type="button" data-act="cancel" data-id="${a.id}">Скасувати</button>
               </div>`
            : (a.upcoming && a.status !== 'cancelled' ? '<p class="muted acc-note">Змінити онлайн уже не можна. Напишіть оператору в чат.</p>' : '')}
        </li>`;
      list.innerHTML =
        (upcoming.length ? upcoming.map(row).join('') : '<li class="muted">Майбутніх записів немає.</li>') +
        (past.length ? `<li class="acc-h">Історія візитів</li>${past.map(row).join('')}` : '');
    } catch (e) {
      list.innerHTML = `<li class="acc-msg">${esc(e.message)}</li>`;
    }
  }

  // Перенесення: обираємо дату і вільний час тієї ж послуги
  async function openMove(li, id) {
    document.querySelectorAll('.acc-move').forEach((m) => m.remove());
    if (!state.maxDate) {
      const s = await api('/api/settings');
      state.maxDate = s.maxDate;
    }
    const box = document.createElement('div');
    box.className = 'acc-move';
    box.innerHTML = `
      <label class="step-label">Нова дата</label>
      <input class="input" type="date" min="${todayStr()}" max="${state.maxDate || ''}" data-move-date="${id}">
      <div class="acc-slots" data-move-slots="${id}"><span class="muted">Оберіть дату, щоб побачити вільний час.</span></div>
      <p class="acc-msg" data-move-msg="${id}" role="status"></p>`;
    li.appendChild(box);
  }

  // ----- Дії (делегування подій) -----
  body.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      state.authTab = tab.dataset.tab;
      return renderAuth();
    }
    // Око в полі пароля: показати або сховати введені символи
    const eye = e.target.closest('[data-eye]');
    if (eye) {
      const input = document.getElementById(eye.dataset.eye);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? 'Сховати пароль' : 'Показати пароль');
      eye.classList.toggle('is-visible', show);
      input.focus();
      return;
    }
    const slot = e.target.closest('[data-slot]');
    if (slot) return rescheduleTo(slot);
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;
    try {
      if (a === 'logout') {
        await api('/api/account/logout', { method: 'POST' });
        state.me = null;
        updateHeader();
        return renderAuth();
      }
      if (a === 'tg-link') {
        const r = await api('/api/account/telegram/link', { method: 'POST' });
        window.open(r.link, '_blank', 'noopener');
        return setMsg('tgMsg', `Відкрийте бота і натисніть «Старт». Посилання дійсне ${r.minutes} хв. Потім оновіть сторінку.`, true);
      }
      if (a === 'tg-unlink') {
        await api('/api/account/telegram/unlink', { method: 'POST' });
        return refresh();
      }
      if (a === 'cancel') {
        if (!confirm('Скасувати цей запис?')) return;
        await api(`/api/account/appointments/${act.dataset.id}/cancel`, { method: 'POST' });
        return loadAppointments();
      }
      if (a === 'move') {
        return openMove(act.closest('[data-appt]'), act.dataset.id);
      }
    } catch (err) {
      if (a === 'tg-link') return setMsg('tgMsg', err.message);
      alert(err.message);
    }
  });

  async function rescheduleTo(btn) {
    const id = btn.dataset.id;
    try {
      await api(`/api/account/appointments/${id}/reschedule`, {
        method: 'POST', body: { date: btn.dataset.date, time: btn.dataset.time },
      });
      await loadAppointments();
    } catch (err) {
      const m = document.querySelector(`[data-move-msg="${id}"]`);
      if (m) m.textContent = err.message;
    }
  }

  // Вибрана дата: показуємо вільний час тієї самої послуги
  body.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-move-date]');
    if (!input || !input.value) return;
    const id = input.dataset.moveDate;
    const li = input.closest('[data-appt]');
    const sid = li?.dataset.sid;
    const box = document.querySelector(`[data-move-slots="${id}"]`);
    try {
      const r = await api(`/api/slots?serviceId=${sid}&date=${input.value}`);
      box.innerHTML = r.slots.length
        ? r.slots.map((t) => `<button class="slot" type="button" data-slot data-id="${id}" data-date="${input.value}" data-time="${t}">${t}</button>`).join('')
        : '<span class="muted">На цю дату вільного часу немає.</span>';
    } catch (err) {
      box.innerHTML = `<span class="acc-msg">${esc(err.message)}</span>`;
    }
  });

  // ----- Форми -----
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const v = (name) => f.querySelector(`[name="${name}"]`)?.value ?? '';
    try {
      if (f.id === 'loginForm') {
        await api('/api/account/login', { method: 'POST', body: { phone: v('phone'), password: v('password') } });
        return refresh();
      }
      if (f.id === 'registerForm') {
        await api('/api/account/register', { method: 'POST', body: { name: v('name'), phone: v('phone'), password: v('password') } });
        return refresh();
      }
      if (f.id === 'resetRequestForm') {
        state.resetPhone = v('phone');
        const r = await api('/api/account/reset/request', { method: 'POST', body: { phone: state.resetPhone } });
        return setMsg('xMsg', r.message, true);
      }
      if (f.id === 'resetConfirmForm') {
        await api('/api/account/reset/confirm', { method: 'POST', body: { phone: state.resetPhone || v('phone'), code: v('code'), password: v('password') } });
        state.authTab = 'login';
        return renderAuth();
      }
    } catch (err) {
      const msgId = { loginForm: 'lMsg', registerForm: 'rMsg', resetRequestForm: 'xMsg', resetConfirmForm: 'x2Msg' }[f.id];
      setMsg(msgId, err.message);
    }
  });
})();
