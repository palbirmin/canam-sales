// Light or dark look. "auto" follows this computer's or phone's own setting; the choice is kept
// on this device only. Loaded before the page draws, so it never flashes the wrong colors.
(function () {
  const KEY = 'canam.theme';
  const COLORS = { light: '#f9f9f7', dark: '#0d0d0d' }; // page background, also the phone's top bar
  let theme = 'auto';
  try { theme = localStorage.getItem(KEY) || 'auto'; } catch { /* storage blocked: auto */ }

  function apply() {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
    // the phone page's top bar: one color when chosen, otherwise each follows the phone
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      const own = /dark/.test(m.media) ? COLORS.dark : COLORS.light;
      m.content = theme === 'auto' ? own : COLORS[theme];
    }
  }
  apply();
  document.addEventListener('DOMContentLoaded', apply);

  window.canamTheme = {
    get: () => theme,
    systemDark: () => matchMedia('(prefers-color-scheme: dark)').matches,
    set(next) {
      theme = next;
      try { if (next === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch { /* this visit only */ }
      apply();
    },
  };
})();
