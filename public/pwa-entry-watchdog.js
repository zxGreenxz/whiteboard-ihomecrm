(function () {
  var standalone = false;
  try {
    standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  } catch (e) {}
  if (!standalone) return;

  document.documentElement.classList.add('pwa-standalone');

  var T = window.__ihomeWdT || {};
  var retryKey = 'ihome:pwa-entry-retry';
  var retryWindowMs = T.retryWindow || 120000;
  var softTimeoutMs = T.soft || 12000;
  var hardTimeoutMs = T.hard || 30000;
  var navTimeoutMs = T.nav || 6000;
  var probeIntervalMs = T.probe || 5000;
  var probeAbortMs = T.probeAbort || 4000;
  var autoKey = 'ihome:pwa-auto-reloads';
  var autoReloadDone = false;
  var failedShown = false;
  var retryBound = false;
  var timers = [];

  function armTimer(fn, ms) { timers.push(window.setTimeout(fn, ms)); }
  function clearTimers() {
    for (var i = 0; i < timers.length; i++) window.clearTimeout(timers[i]);
    timers = [];
  }

  armTimer(function () {
    showRecovery(false, 'Mạng chậm, ứng dụng vẫn đang tải…');
  }, softTimeoutMs);
  armTimer(autoReload, hardTimeoutMs);

  function onEntryError(event) {
    var target = event.target;
    if (target && target.tagName === 'SCRIPT' && target.type === 'module') autoReload();
  }
  window.addEventListener('error', onEntryError, true);

  window.__ihomePwaEntryReady = function () {
    clearTimers();
    stopProbing();
    window.removeEventListener('error', onEntryError, true);
    var splash = document.getElementById('app-splash');
    if (splash) {
      splash.classList.remove('as-slow', 'as-failed');
      splash.setAttribute('aria-hidden', 'true');
    }
    try {
      window.sessionStorage.removeItem(retryKey);
      window.sessionStorage.removeItem(autoKey);
    } catch (e) {}
    try {
      var cleanUrl = new URL(window.location.href);
      if (cleanUrl.searchParams.has('_ihome_boot')) {
        cleanUrl.searchParams.delete('_ihome_boot');
        window.history.replaceState(window.history.state, '', cleanUrl.toString());
      }
    } catch (e) {}
  };

  function cacheBustedUrl() {
    var url = new URL(window.location.href);
    url.searchParams.set('_ihome_boot', String(Date.now()));
    return url.toString();
  }

  function startReload() {
    clearTimers();
    armTimer(function () {
      showRecovery(true, budgetLeft()
        ? 'Mất kết nối máy chủ. Sẽ tự tải lại ngay khi có mạng — hoặc bấm tải lại.'
        : 'Không thể kết nối máy chủ. Kiểm tra mạng rồi bấm tải lại.');
    }, navTimeoutMs);
    window.location.replace(cacheBustedUrl());
  }

  function autoReload() {
    if (autoReloadDone) return;
    autoReloadDone = true;
    var shouldReload = false;
    var now = Date.now();
    try {
      var lastRetry = Number(window.sessionStorage.getItem(retryKey) || 0);
      if (!lastRetry || now - lastRetry > retryWindowMs) {
        window.sessionStorage.setItem(retryKey, String(now));
        shouldReload = true;
      }
    } catch (e) {}
    if (shouldReload) { startReload(); return; }
    clearTimers();
    showRecovery(true, 'Ứng dụng chưa thể khởi động. Hãy kiểm tra kết nối rồi tải lại.');
  }

  var probing = false;
  var probeInFlight = false;
  var probeIval = null;
  var probeListenersBound = false;

  function budgetLeft() {
    try { return Number(window.sessionStorage.getItem(autoKey) || 0) < 3; }
    catch (e) { return false; }
  }
  function stopProbing() {
    probing = false;
    if (probeIval) { window.clearInterval(probeIval); probeIval = null; }
  }
  function kickProbe() { if (probing) doProbe(); }
  function startProbing() {
    if (probing || !budgetLeft()) return;
    probing = true;
    if (!probeListenersBound) {
      probeListenersBound = true;
      window.addEventListener('online', kickProbe);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') kickProbe();
      });
    }
    probeIval = window.setInterval(doProbe, probeIntervalMs);
    doProbe();
  }
  function doProbe() {
    if (probeInFlight) return;
    probeInFlight = true;
    var done = false;
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) {}
    function settle(ok) {
      if (done) return;
      done = true;
      probeInFlight = false;
      if (ok && probing) { stopProbing(); autoReloadViaProbe(); }
    }
    window.setTimeout(function () {
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      settle(false);
    }, probeAbortMs);
    try {
      fetch('/manifest.webmanifest?_probe=' + Date.now(), {
        cache: 'no-store', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined,
      }).then(function (res) { settle(!!res && res.ok); }, function () { settle(false); });
    } catch (e) { settle(false); }
  }
  function autoReloadViaProbe() {
    if (!budgetLeft()) {
      showRecovery(true, 'Ứng dụng chưa thể khởi động. Hãy kiểm tra kết nối rồi bấm tải lại.');
      return;
    }
    try {
      var n = Number(window.sessionStorage.getItem(autoKey) || 0);
      window.sessionStorage.setItem(autoKey, String(n + 1));
    } catch (e) {}
    startReload();
  }

  function showRecovery(failed, message) {
    if (failed) startProbing();
    function reveal() {
      if (!failed && failedShown) return;
      var splash = document.getElementById('app-splash');
      var msg = document.getElementById('app-splash-msg');
      var retry = document.getElementById('app-splash-reload');
      if (!splash || !msg || !retry) return;
      if (failed) failedShown = true;
      msg.textContent = message;
      splash.classList.add(failed ? 'as-failed' : 'as-slow');
      splash.setAttribute('aria-hidden', 'false');
      if (!retryBound) {
        retryBound = true;
        retry.addEventListener('click', function () {
          try {
            window.sessionStorage.removeItem(retryKey);
            window.sessionStorage.removeItem(autoKey);
          } catch (e) {}
          autoReloadDone = true;
          startReload();
        });
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', reveal, { once: true });
    } else {
      reveal();
    }
  }
})();
