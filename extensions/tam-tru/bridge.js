// Cầu nối trên trang CRM (ptcrm.vercel.app / localhost): báo hiệu extension có mặt
// và chuyển gói TamTruPayload cho service worker. Không đọc gì khác từ trang.
(() => {
  const SOURCE_CRM = 'ihome-crm';
  const SOURCE_EXT = 'ihome-tamtru-ext';
  const version = chrome.runtime.getManifest().version;
  const mark = () => document.documentElement.setAttribute('data-ihome-tamtru-ext', version);
  mark();
  document.addEventListener('DOMContentLoaded', mark);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== SOURCE_CRM || data.type !== 'TAM_TRU_PAYLOAD') return;
    const reply = (ok, error) => window.postMessage(
      { source: SOURCE_EXT, type: 'TAM_TRU_ACK', requestId: data.requestId, ok, error },
      location.origin,
    );
    try {
      chrome.runtime.sendMessage({ type: 'TAM_TRU_PAYLOAD', payload: data.payload }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) reply(false, 'Extension chưa sẵn sàng, tải lại trang CRM rồi thử lại.');
        else reply(!!(resp && resp.ok), resp && resp.error);
      });
    } catch (e) {
      reply(false, 'Extension chưa sẵn sàng, tải lại trang CRM rồi thử lại.');
    }
  });
})();
