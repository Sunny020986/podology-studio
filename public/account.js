// Особистий кабінет клієнта: вхід, реєстрація, записи, Telegram і відновлення пароля.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (d) => d.split('-').reverse().join('.');
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const STATUS_TEXT = { new: 'очікує підтвердження', confirmed: 'підтверджено', cancelled: 'скасовано', done: 'відбувся', no_show: 'не прийшли' };

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
    // Форма запису на сайті підставляє ім'я й телефон того, хто увійшов (app.js)
    document.dispatchEvent(new CustomEvent('account:me', { detail: state.me }));
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
      <div class="acc-hello">
        <p>Вітаю, <b>${esc(me.name)}</b>.<br><span class="muted">Телефон: ${esc(me.phone)}</span></p>
        <button class="btn btn-ghost small acc-logout" type="button" data-act="logout"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg> Вийти</button>
      </div>
      <div class="acc-tg">
        ${me.telegram
          ? '<p class="muted">Telegram підключено: нагадування про записи надходитимуть у бот.</p><button class="btn btn-ghost small" type="button" data-act="tg-unlink">Відключити Telegram</button>'
          : '<p class="muted">Підключіть Telegram: нагадування про записи і код для відновлення пароля надходитимуть у бот.</p><button class="btn btn-ghost small" type="button" data-act="tg-link">Підключити Telegram</button>'}
        <p class="acc-msg" id="tgMsg" role="status"></p>
      </div>
      <div id="accFriend"></div>
      <h3 class="acc-h">Фото й відео для майстра</h3>
      <div id="accVideos"><p class="muted">Завантажую…</p></div>
      <h3 class="acc-h">Мої записи</h3>
      <ul class="acc-list" id="apptList"><li class="muted">Завантажую…</li></ul>`;
    if (window.FriendInvite) window.FriendInvite.mount($('#accFriend'), {});
    loadVideos();
    await loadAppointments();
  }

  // ----- Відео для майстра: клієнт надсилає відео стоп, майстер відповідає, чи можна це зробити -----
  const VIDEO_MAX_MB = 150;
  const VSTATUS = { new: 'надіслано, майстер ще не дивився', seen: 'майстер переглянув', answered: 'є відповідь' };
  async function loadVideos() {
    const box = $('#accVideos');
    if (!box) return;
    let list = [], masters = [];
    try { [list, masters] = await Promise.all([api('/api/account/videos'), api('/api/masters').catch(() => [])]); } catch (e) { box.innerHTML = `<p class="acc-msg">${esc(e.message)}</p>`; return; }
    box.innerHTML = `
      <p class="muted">Сфотографуйте чи зніміть на відео (до 1 хвилини), що турбує: ніготь, шкіру стопи. Майстер подивиться й напише, чи можна це зробити і яку послугу обрати.</p>
      ${list.map((v) => `<div class="acc-video">
        <div><b>${fmt(v.created_at.slice(0, 10))}</b> · ${v.kind === 'photo' ? `📷 фото: ${v.count}` : '🎥 відео'} · ${VSTATUS[v.status] || esc(v.status)}${v.master ? ' · для майстра ' + esc(v.master) : ''}</div>
        ${v.comment ? `<div class="muted">${esc(v.comment)}</div>` : ''}
        ${v.status === 'answered' ? `<div class="vi-reply"><b>${esc(v.reply_by)}:</b> ${esc(v.reply)}</div>` : ''}
        <div class="muted">${v.kind === 'photo' ? 'Фото видаляться' : 'Відео видалиться'} ${fmt(v.expires_on)}.
          <button class="link" type="button" data-vplay="${v.id}" data-kind="${v.kind}" data-count="${v.count}">Подивитися</button> ·
          <button class="link" type="button" data-vdel="${v.id}">Видалити</button></div>
      </div>`).join('')}
      <div class="acc-actions">
        <button class="btn btn-primary small" type="button" data-act="photo-open">📷 Надіслати фото майстру</button>
        <button class="btn btn-primary small" type="button" data-act="video-open">🎥 Надіслати відео майстру</button>
      </div>
      <div id="vuBox"></div>`;
    const hideBtns = () => box.querySelectorAll('[data-act="photo-open"], [data-act="video-open"]').forEach((b) => { b.hidden = true; });
    box.querySelector('[data-act="video-open"]').addEventListener('click', () => { hideBtns(); openVideoForm(masters); });
    box.querySelector('[data-act="photo-open"]').addEventListener('click', () => { hideBtns(); openPhotoForm(masters); });
    box.querySelectorAll('[data-vplay]').forEach((b) => b.addEventListener('click', () => {
      const src = (i) => `/api/account/videos/${b.dataset.vplay}/file?i=${i}`;
      b.closest('.acc-video').insertAdjacentHTML('beforeend', b.dataset.kind === 'photo'
        ? `<div class="vi-photos">${Array.from({ length: Number(b.dataset.count) || 1 }, (_, i) => `<a href="${src(i)}" target="_blank" rel="noopener"><img src="${src(i)}" alt="Фото ${i + 1}"></a>`).join('')}</div>`
        : `<video controls playsinline preload="metadata" src="${src(0)}"></video>`);
      b.remove();
    }));
    box.querySelectorAll('[data-vdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Видалити це відео? Майстер його більше не побачить.')) return;
      try { await api(`/api/account/videos/${b.dataset.vdel}`, { method: 'DELETE' }); loadVideos(); } catch (e) { alert(e.message); }
    }));
  }
  // Фото: до 5, кожне стискаємо в браузері до 1600 px (JPEG) — так файл легкий, а метадані (зокрема місце зйомки) зникають
  const PHOTO_MAX = 5;
  async function shrink(file, max = 1600) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
    } finally { URL.revokeObjectURL(url); }
  }
  const masterSelectHtml = (masters) => (masters.length > 1 ? `<label class="step-label" for="vuMaster">Кому</label><select class="input" id="vuMaster"><option value="">Будь-якому майстру</option>${masters.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>` : '');
  function openPhotoForm(masters) {
    const box = $('#vuBox');
    box.innerHTML = `<div class="vu-form">
      <input class="input" type="file" id="vuPhotos" accept="image/*" multiple>
      <div class="muted">До ${PHOTO_MAX} фото за раз. Краще при денному світлі, зблизька й трохи збоку.</div>
      <div class="vi-photos" id="vuThumbs"></div>
      ${masterSelectHtml(masters)}
      <textarea class="input" id="vuComment" rows="2" maxlength="500" placeholder="Що турбує і як давно (необов'язково)"></textarea>
      <label class="consent-check"><input type="checkbox" id="vuConsent"> Погоджуюсь, що працівники кабінету переглянуть ці фото моїх стоп. Фото видаляться через 90 днів.</label>
      <progress class="vu-progress" id="vuProgress" max="100" value="0" hidden></progress>
      <p class="acc-msg" id="vuMsg" role="status"></p>
      <button class="btn btn-primary" type="button" id="vuSend">Надіслати фото</button>
    </div>`;
    const msg = (t, ok = false) => { const m = $('#vuMsg'); m.textContent = t; m.classList.toggle('ok', ok); };
    let blobs = [];
    $('#vuPhotos').addEventListener('change', async () => {
      const files = [...$('#vuPhotos').files];
      msg('');
      blobs = [];
      $('#vuThumbs').innerHTML = '';
      if (files.length > PHOTO_MAX) msg(`Обрано ${files.length} фото, надішлемо перші ${PHOTO_MAX}.`);
      for (const f of files.slice(0, PHOTO_MAX)) {
        try {
          const b = await shrink(f);
          if (!b) throw new Error();
          blobs.push(b);
          $('#vuThumbs').insertAdjacentHTML('beforeend', `<img src="${URL.createObjectURL(b)}" alt="Фото ${blobs.length}">`);
        } catch { msg('Одне з фото не вдалося відкрити. Оберіть фото у форматі JPEG або PNG.'); }
      }
    });
    $('#vuSend').addEventListener('click', () => {
      if (!blobs.length) return msg('Оберіть фото з телефона');
      if (!$('#vuConsent').checked) return msg('Позначте згоду на перегляд фото');
      // «Пакет»: для кожного фото 4 байти довжини, потім сам файл
      const pack = [];
      for (const b of blobs) { const n = new DataView(new ArrayBuffer(4)); n.setUint32(0, b.size); pack.push(n.buffer, b); }
      const q = new URLSearchParams({ consent: '1', comment: $('#vuComment').value.trim(), masterId: $('#vuMaster')?.value || '' });
      sendWithProgress('/api/account/photos?' + q, new Blob(pack), 'application/x-photo-pack', msg, 'Фото надіслано. Майстер подивиться й відповість тут і в Telegram, якщо його підключено.');
    });
  }
  // Надсилання з відсотками (для фото й відео)
  function sendWithProgress(url, body, type, msg, okText) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', type);
    const bar = $('#vuProgress');
    bar.hidden = false;
    $('#vuSend').disabled = true;
    msg('Завантажую…');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { bar.value = Math.round((e.loaded / e.total) * 100); msg(`Завантажую… ${bar.value}%`); } };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      if (xhr.status === 201) { msg(okText, true); setTimeout(loadVideos, 1500); }
      else { msg(data.error || 'Не вдалося надіслати. Спробуйте ще раз'); $('#vuSend').disabled = false; bar.hidden = true; }
    };
    xhr.onerror = () => { msg('Зв\'язок перервався. Спробуйте ще раз'); $('#vuSend').disabled = false; bar.hidden = true; };
    xhr.send(body);
  }
  function openVideoForm(masters) {
    const box = $('#vuBox');
    box.innerHTML = `<div class="vu-form">
      <input class="input" type="file" id="vuFile" accept="video/*">
      <div class="vu-preview" id="vuPreview"></div>
      ${masters.length > 1 ? `<label class="step-label" for="vuMaster">Кому</label><select class="input" id="vuMaster"><option value="">Будь-якому майстру</option>${masters.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>` : ''}
      <textarea class="input" id="vuComment" rows="2" maxlength="500" placeholder="Що турбує і як давно (необов'язково)"></textarea>
      <label class="consent-check"><input type="checkbox" id="vuConsent"> Погоджуюсь, що працівники кабінету переглянуть це відео моїх стоп. Відео видалиться через 90 днів.</label>
      <progress class="vu-progress" id="vuProgress" max="100" value="0" hidden></progress>
      <p class="acc-msg" id="vuMsg" role="status"></p>
      <button class="btn btn-primary" type="button" id="vuSend">Надіслати</button>
    </div>`;
    const msg = (t, ok = false) => { const m = $('#vuMsg'); m.textContent = t; m.classList.toggle('ok', ok); };
    $('#vuFile').addEventListener('change', () => {
      const f = $('#vuFile').files[0];
      $('#vuPreview').innerHTML = '';
      msg('');
      if (!f) return;
      if (f.size > VIDEO_MAX_MB * 1024 * 1024) { msg(`Відео завелике (${Math.round(f.size / 1024 / 1024)} МБ). Можна до ${VIDEO_MAX_MB} МБ: зніміть коротше, до 1 хвилини.`); return; }
      $('#vuPreview').innerHTML = `<video controls playsinline muted src="${URL.createObjectURL(f)}"></video>`;
    });
    $('#vuSend').addEventListener('click', () => {
      const f = $('#vuFile').files[0];
      if (!f) return msg('Оберіть відео з телефона');
      if (f.size > VIDEO_MAX_MB * 1024 * 1024) return msg(`Відео завелике: до ${VIDEO_MAX_MB} МБ`);
      if (!$('#vuConsent').checked) return msg('Позначте згоду на перегляд відео');
      const q = new URLSearchParams({ consent: '1', comment: $('#vuComment').value.trim(), masterId: $('#vuMaster')?.value || '' });
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/account/videos?' + q);
      xhr.setRequestHeader('Content-Type', f.type || 'video/mp4');
      const bar = $('#vuProgress');
      bar.hidden = false;
      $('#vuSend').disabled = true;
      msg('Завантажую…');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { bar.value = Math.round((e.loaded / e.total) * 100); msg(`Завантажую… ${bar.value}%`); } };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
        if (xhr.status === 201) { msg('Відео надіслано. Майстер подивиться й відповість тут і в Telegram, якщо його підключено.', true); setTimeout(loadVideos, 1500); }
        else { msg(data.error || 'Не вдалося надіслати. Спробуйте ще раз'); $('#vuSend').disabled = false; bar.hidden = true; }
      };
      xhr.onerror = () => { msg('Зв\'язок перервався. Спробуйте ще раз'); $('#vuSend').disabled = false; bar.hidden = true; };
      xhr.send(f);
    });
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
        <li class="acc-appt" data-appt="${a.id}" data-sid="${a.service_id}" data-mid="${a.master_id || ''}">
          <div><b>${esc(a.service)}</b></div>
          <div class="muted">${fmt(a.date)} о ${a.start_time}–${a.end_time}${a.master ? ' · майстер ' + esc(a.master) : ''} · ${STATUS_TEXT[a.status] || esc(a.status)}</div>
          ${a.price ? `<div class="acc-price">${a.price.pct ? `Ціна: ${a.price.full} грн − ${a.price.kind === 'friend' ? 'знижка за друга' : 'знижка'} ${a.price.pct}% (${a.price.full - a.price.final} грн) = <b>${a.price.final} грн</b>` : `Ціна: <b>${a.price.final} грн</b>`}</div>` : ''}
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
      const mid = li?.dataset.mid;
      const r = await api(`/api/slots?serviceId=${sid}&date=${input.value}` + (mid ? '&masterId=' + mid : ''));
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
