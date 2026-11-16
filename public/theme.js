// Тема сайту: світла або темна. Файл підключено в <head>, щоб тема застосувалась до першого показу сторінки.
// Поки відвідувач не натиснув перемикач, тема повторює налаштування його системи.
(() => {
  const KEY = 'theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch {
      return null; // сховище браузера недоступне: просто йдемо за системою
    }
  }

  function updateButtons() {
    const label = root.dataset.theme === 'dark' ? 'Увімкнути світлу тему' : 'Увімкнути темну тему';
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.setAttribute('aria-label', label);
      b.title = label;
    });
  }

  function apply(theme) {
    root.dataset.theme = theme;
    updateButtons();
  }

  apply(saved() || (system.matches ? 'dark' : 'light'));

  system.addEventListener('change', (e) => {
    if (!saved()) apply(e.matches ? 'dark' : 'light');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // вибір не збережеться між відвідуваннями, але на цій сторінці спрацює
    }
    apply(next);
  });

  document.addEventListener('DOMContentLoaded', updateButtons);
})();
