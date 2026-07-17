// Lightweight client-side i18n for the static PWA shell.
//
// Mark up HTML with:
//   data-i18n="key"            -> sets textContent
//   data-i18n-html="key"       -> sets innerHTML (for strings with markup)
//   data-i18n-attr="attr:key;…"-> sets attributes (placeholder, title, aria-label)
// and use i18n.t('key', {name: 'x'}) for strings built in JS.
//
// Translations live in /locales/<lang>.json. Language is remembered in
// localStorage, otherwise taken from the browser, falling back to English.
(function () {
  var SUPPORTED = { en: 'English', de: 'Deutsch', es: 'Español', tr: 'Türkçe' };
  var DEFAULT = 'en';
  var dict = {};
  var lang = DEFAULT;

  function detect() {
    try {
      var saved = localStorage.getItem('babylink-lang');
      if (saved && SUPPORTED[saved]) return saved;
    } catch (e) { /* private mode */ }
    var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED[nav] ? nav : DEFAULT;
  }

  function t(key, vars) {
    var s = (dict && dict[key] != null) ? dict[key] : key;
    if (vars) {
      for (var k in vars) s = s.split('{' + k + '}').join(vars[k]);
    }
    return s;
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var idx = pair.indexOf(':');
        if (idx < 0) return;
        el.setAttribute(pair.slice(0, idx).trim(), t(pair.slice(idx + 1).trim()));
      });
    });
    wireSwitcher();
  }

  // Populate + sync any <select id="langSelect"> language picker.
  function wireSwitcher() {
    var sel = document.getElementById('langSelect');
    if (!sel) return;
    if (!sel.options.length) {
      Object.keys(SUPPORTED).forEach(function (code) {
        var o = document.createElement('option');
        o.value = code;
        o.textContent = SUPPORTED[code];
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { setLang(sel.value, true); });
    }
    sel.value = lang;
  }

  function setLang(l, save) {
    if (!SUPPORTED[l]) l = DEFAULT;
    return fetch('/locales/' + l + '.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) {
        dict = d || {};
        lang = l;
        document.documentElement.lang = l;
        if (save) { try { localStorage.setItem('babylink-lang', l); } catch (e) {} }
        apply();
        document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: l } }));
      })
      .catch(function () { /* keep the HTML defaults */ });
  }

  window.i18n = {
    t: t,
    apply: apply,
    setLang: setLang,
    getLang: function () { return lang; },
    SUPPORTED: SUPPORTED,
  };

  setLang(detect(), false);
})();
