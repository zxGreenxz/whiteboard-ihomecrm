(function () {
  var link = document.getElementById('app-font-preload');
  if (!link) return;
  function activate() {
    link.onload = null;
    link.rel = 'stylesheet';
  }
  link.addEventListener('load', activate, { once: true });
})();
