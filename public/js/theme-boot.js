// Applies the chosen theme before the page paints, so dark mode never flashes white.
// Choice: 'auto' (follow the phone / computer setting, default), 'light' or 'dark'.
(function () {
  var KEY = 'aq-theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function pref() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function apply() {
    var p = pref();
    var dark = p === 'dark' || (p === 'auto' && !!mq && mq.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1b2027' : '#ffffff');
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  window.aqTheme = {
    get: pref,
    set: function (v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } apply(); },
  };
})();
