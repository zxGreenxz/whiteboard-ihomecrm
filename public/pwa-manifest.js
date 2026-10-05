/* Runs before React so Add to Home Screen sees the correct installation. */
(function () {
  'use strict';

  function isPersonalPath(pathname) {
    return /^\/finance\/personal-wallet\/?$/i.test(pathname);
  }

  function personalEntry() {
    if (isPersonalPath(window.location.pathname)) return true;
    if (!/^\/login\/?$/i.test(window.location.pathname)) return false;
    var next = new URLSearchParams(window.location.search).get('next');
    if (!next || !next.startsWith('/') || next.startsWith('//')) return false;
    if (/[\\\u0000-\u0020\u007f]|%(?:25)*(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(next)) return false;
    try {
      var url = new URL(next, window.location.origin);
      return url.origin === window.location.origin && isPersonalPath(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function syncManifest() {
    var personal = personalEntry();
    var manifest = document.querySelector('link[rel="manifest"]');
    var title = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    var href = personal ? '/personal-wallet.webmanifest' : '/manifest.webmanifest';
    if (manifest && manifest.getAttribute('href') !== href) manifest.setAttribute('href', href);
    if (title) title.setAttribute('content', personal ? 'Ví cá nhân' : 'CRM');
  }

  syncManifest();
  window.addEventListener('pwa-route-change', syncManifest);
})();
