// Візуальні ефекти. Файл необов'язковий: якщо прибрати його з index.html, сайт працює як раніше.
(() => {
  // Якщо в системі увімкнено "зменшити рух", ефекти не запускаються.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const root = document.documentElement;
  root.classList.add('fx');

  // ----- 1. Плавна поява блоків під час прокрутки -----
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const el = en.target;
      io.unobserve(el);
      el.classList.add('reveal-in');
      // Після анімації прибираємо класи, щоб вони не заважали іншим ефектам
      setTimeout(() => {
        el.classList.remove('reveal', 'reveal-in');
        el.style.transitionDelay = '';
      }, 900);
    });
  }, { threshold: 0.12 });

  function reveal(el, delayMs = 0) {
    el.classList.add('reveal');
    el.style.transitionDelay = delayMs + 'ms';
    io.observe(el);
  }

  document.querySelectorAll('.hero-text > *, .how, .section h2, .studio-photo, .booking-grid .card')
    .forEach((el, i) => reveal(el, Math.min(i, 5) * 70));

  // Картки послуг з'являються після завантаження з сервера, по черзі
  const servicesList = document.getElementById('servicesList');
  new MutationObserver(() => {
    servicesList.querySelectorAll('.service').forEach((el, i) => reveal(el, (i % 6) * 90));
  }).observe(servicesList, { childList: true });

  // ----- 2. Кнопки часу з'являються хвилею -----
  const slotsGrid = document.getElementById('slotsGrid');
  new MutationObserver(() => {
    slotsGrid.querySelectorAll('.slot').forEach((el, i) => {
      el.style.animationDelay = i * 25 + 'ms';
      el.classList.add('slot-in');
    });
  }).observe(slotsGrid, { childList: true });

  // ----- 3. Хвиля від натискання на кнопках -----
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn, .slot, .chat-fab');
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.width = dot.style.height = size + 'px';
    dot.style.left = e.clientX - rect.left - size / 2 + 'px';
    dot.style.top = e.clientY - rect.top - size / 2 + 'px';
    btn.appendChild(dot);
    dot.addEventListener('animationend', () => dot.remove());
  });

  // ----- 3а. Водяна хвиля на картках акцій -----
  // Через чверть секунди після наведення від курсора один раз розходиться хвиля, як від краплі на воді.
  // Наступна хвиля буде лише після того, як курсор вийде з картки й наведеться знову.
  const offersList = document.getElementById('offersList');
  if (offersList) {
    const RIPPLE_DELAY_MS = 250;
    let hovered = null;   // картка під курсором
    let timer = null;
    let lastX = 0, lastY = 0;

    function dropRipple(card, x, y) {
      const r = card.getBoundingClientRect();
      for (let i = 0; i < 2; i++) { // два кола з невеликою затримкою дають ефект хвилі
        const ring = document.createElement('span');
        ring.className = 'water-ring';
        ring.style.left = (x - r.left) + 'px';
        ring.style.top = (y - r.top) + 'px';
        ring.style.animationDelay = (i * 180) + 'ms';
        ring.addEventListener('animationend', () => ring.remove());
        card.appendChild(ring);
      }
    }

    // На телефоні наведення немає: хвиля з'являється одразу від дотику
    offersList.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const card = e.target.closest('.offer');
      if (card) dropRipple(card, e.clientX, e.clientY);
    });
    offersList.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      lastX = e.clientX;
      lastY = e.clientY;
      const card = e.target.closest('.offer');
      if (card === hovered) return;
      clearTimeout(timer);
      hovered = card;
      if (!card) return;
      timer = setTimeout(() => {
        if (hovered === card) dropRipple(card, lastX, lastY);
      }, RIPPLE_DELAY_MS);
    });
    offersList.addEventListener('pointerleave', () => {
      clearTimeout(timer);
      hovered = null;
    });
  }

  // ----- 4. Картка послуги нахиляється за курсором -----
  const MAX_TILT_DEG = 4;
  let tilted = null;

  function resetTilt() {
    if (tilted) {
      tilted.style.transform = '';
      tilted.style.removeProperty('--mx');
      tilted.style.removeProperty('--my');
    }
    tilted = null;
  }

  servicesList.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const card = e.target.closest('.service');
    if (card !== tilted) resetTilt();
    if (!card || card.classList.contains('reveal')) return;
    tilted = card;
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;  // від -0.5 до 0.5
    const y = (e.clientY - r.top) / r.height - 0.5;
    card.style.setProperty('--mx', (e.clientX - r.left) + 'px'); // світло за курсором
    card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    card.style.transform =
      `perspective(700px) rotateX(${(-y * 2 * MAX_TILT_DEG).toFixed(2)}deg) rotateY(${(x * 2 * MAX_TILT_DEG).toFixed(2)}deg) translateY(-3px)`;
  });
  servicesList.addEventListener('pointerleave', resetTilt);

  // ----- 5. Тінь під шапкою після прокрутки -----
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ----- 5а. Шапка ховається під час читання і виповзає від руху миші -----
  // Нагорі сторінки шапка видна завжди. Нижче вона ховається під час прокрутки вниз
  // і після паузи без руху миші; рух миші або прокрутка вгору повертають її.
  const HIDE_BELOW_PX = 160; // від якої прокрутки шапка може ховатися
  const IDLE_MS = 2500;      // скільки шапка лишається видною після останнього руху миші
  let hideTimer = null;
  let lastScrollY = window.scrollY;
  let lastMouse = { x: -1, y: -1 };

  // Шапку не ховаємо, поки курсор у її смузі або в ній фокус клавіатури.
  // Смугу рахуємо за координатами миші: стан :hover не оновлюється, коли шапка сама виїжджає під нерухомий курсор.
  const cursorOnNav = () => lastMouse.y >= 0 && lastMouse.y <= nav.offsetHeight;
  const mayHide = () => window.scrollY > HIDE_BELOW_PX && !cursorOnNav() && !nav.contains(document.activeElement);

  function hideNav() {
    clearTimeout(hideTimer);
    if (mayHide()) nav.classList.add('nav-hidden');
  }

  function showNav() {
    nav.classList.remove('nav-hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideNav, IDLE_MS);
  }

  window.addEventListener('pointermove', (e) => {
    // Лише справжня миша: дотик на телефоні теж породжує подію руху, і шапка «застрягала» видною
    if (e.pointerType !== 'mouse') return;
    // Після прокрутки браузер сам надсилає подію руху з тими самими координатами: її пропускаємо
    if (e.clientX === lastMouse.x && e.clientY === lastMouse.y) return;
    lastMouse = { x: e.clientX, y: e.clientY };
    showNav();
  }, { passive: true });

  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y <= HIDE_BELOW_PX || y < lastScrollY) showNav();
    else if (y > lastScrollY) hideNav();
    lastScrollY = y;
  }, { passive: true });

  nav.addEventListener('focusin', showNav);
  // Курсор вийшов за межі вікна: забуваємо його позицію, щоб шапка не лишилась видною назавжди
  document.documentElement.addEventListener('mouseleave', () => {
    lastMouse = { x: -1, y: -1 };
    showNav();
  });

  // ----- 6. Конфеті після успішного запису -----
  // Основний колір і колір тексту беруться з поточної теми, щоб частинки було видно і на темному тлі
  function confettiColors() {
    const css = getComputedStyle(root);
    return [css.getPropertyValue('--accent').trim(), '#7FB3A3', '#E4B363', css.getPropertyValue('--ink').trim()];
  }
  const PARTICLES = 90;
  const DURATION_MS = 1800;

  function confetti(originX, originY) {
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const COLORS = confettiColors();
    const parts = Array.from({ length: PARTICLES }, () => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1; // переважно вгору
      const speed = 5 + Math.random() * 9;
      return {
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 5 + Math.random() * 6,
        h: 3 + Math.random() * 4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      };
    });

    const start = performance.now();
    function frame(now) {
      const t = (now - start) / DURATION_MS;
      if (t >= 1) return canvas.remove();
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.globalAlpha = t < 0.7 ? 1 : (1 - t) / 0.3;
      for (const p of parts) {
        p.vy += 0.32;   // гравітація
        p.vx *= 0.985;  // опір повітря
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Подію booking:success надсилає app.js після успішного запису
  document.addEventListener('booking:success', () => {
    const r = document.getElementById('submitBtn').getBoundingClientRect();
    confetti(r.left + r.width / 2, r.top);
    document.getElementById('bookingMsg').classList.add('pop');
  });

  // ----- 7. Плавне розкриття питань і відповідей -----
  document.addEventListener('click', (e) => {
    const sum = e.target.closest('.faq-item > summary');
    if (!sum) return;
    const item = sum.parentElement;
    const ans = item.querySelector('.faq-answer');
    if (!ans) return;
    e.preventDefault();
    if (item.dataset.animating) return;
    item.dataset.animating = '1';
    if (!item.open) {
      item.open = true;
      const h = ans.scrollHeight;
      ans.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 300, easing: 'ease-out' })
        .onfinish = () => { delete item.dataset.animating; };
    } else {
      const h = ans.scrollHeight;
      ans.animate([{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 250, easing: 'ease-in' })
        .onfinish = () => { item.open = false; delete item.dataset.animating; };
    }
  });

  // ----- 8. Смужка прогресу запису: 4 кроки по 25% -----
  const bookingSection = document.getElementById('booking');
  const bookingCard = bookingSection && bookingSection.querySelector('.booking-grid .card');
  if (bookingCard) {
    const wrap = document.createElement('div');
    wrap.className = 'book-progress';
    wrap.setAttribute('role', 'progressbar');
    wrap.setAttribute('aria-label', 'Заповнення запису');
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '100');
    const fill = document.createElement('span');
    wrap.appendChild(fill);
    bookingCard.prepend(wrap);
    const val = (id) => (document.getElementById(id)?.value || '').trim();
    const updateProgress = () => {
      const done = [
        !!(val('serviceSearch') || val('serviceSelect')),
        !!val('dateInput'),
        !!document.querySelector('#slotsGrid .slot.selected'),
        val('nameInput').length >= 2 && val('phoneInput').replace(/\D/g, '').length >= 9,
      ].filter(Boolean).length;
      const pct = done * 25;
      fill.style.width = pct + '%';
      wrap.setAttribute('aria-valuenow', String(pct));
      wrap.classList.toggle('full', pct === 100);
    };
    ['input', 'change', 'click'].forEach((ev) => bookingSection.addEventListener(ev, () => requestAnimationFrame(updateProgress)));
    const grid = document.getElementById('slotsGrid');
    if (grid) new MutationObserver(updateProgress).observe(grid, { childList: true, subtree: true, attributes: true });
    updateProgress();
    setTimeout(updateProgress, 1500); // послуга й дата підставляються після завантаження
  }

  // ----- 9. Іскорки на головному екрані -----
  const heroEl = document.querySelector('.hero');
  if (heroEl) {
    heroEl.classList.add('has-sparkles');
    const SPARKLES = 14;
    for (let i = 0; i < SPARKLES; i++) {
      const s = document.createElement('span');
      s.className = 'sparkle' + (i % 2 ? ' lilac' : '');
      s.setAttribute('aria-hidden', 'true');
      const size = 3 + Math.random() * 4;
      s.style.width = s.style.height = size.toFixed(1) + 'px';
      s.style.left = (45 + Math.random() * 50).toFixed(1) + '%';
      s.style.top = (20 + Math.random() * 70).toFixed(1) + '%';
      s.style.animationDuration = (4 + Math.random() * 4).toFixed(1) + 's';
      s.style.animationDelay = (-Math.random() * 8).toFixed(1) + 's';
      heroEl.appendChild(s);
    }
  }

  // ----- 10. Лінія під заголовками розділів промальовується при появі -----
  const lineIo = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add('drawn');
      lineIo.unobserve(en.target);
    });
  }, { threshold: 0.6 });
  document.querySelectorAll('.section h2').forEach((h) => lineIo.observe(h));

  // ----- 11. Кнопка чату один раз привертає увагу через 20 секунд -----
  setTimeout(() => {
    const fab = document.getElementById('chatFab');
    const panel = document.getElementById('chatPanel');
    if (!fab || (panel && !panel.hidden)) return;
    fab.classList.add('nudge');
    fab.addEventListener('animationend', () => fab.classList.remove('nudge'), { once: true });
  }, 20000);

  // ----- 12. Лічильники в «Про майстра» рахують від нуля, коли блок з'являється -----
  const COUNT_MS = 1200;
  const countIo = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      countIo.unobserve(en.target);
      const el = en.target;
      const target = Number(el.dataset.count) || 0;
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / COUNT_MS);
        const eased = 1 - Math.pow(1 - k, 3);
        el.textContent = Math.round(target * eased).toLocaleString('uk-UA');
        if (k < 1) requestAnimationFrame(step);
      };
      el.textContent = '0';
      requestAnimationFrame(step);
    });
  }, { threshold: 0.6 });
  const statsBox = document.getElementById('masterStats');
  if (statsBox) {
    const watch = () => statsBox.querySelectorAll('[data-count]').forEach((el) => countIo.observe(el));
    new MutationObserver(watch).observe(statsBox, { childList: true });
    watch();
  }
})();
