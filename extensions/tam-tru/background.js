// Service worker: giữ gói dữ liệu đang chờ (storage.session), mở tab form Đăng ký
// tạm trú, và tải ảnh từ signed URL của CRM giúp content script (tránh CORS).
const FORM_URL = 'https://dichvucong.dancuquocgia.gov.vn/portal/p/home/dang-ky-tam-tru.html'
  + '?ma_thu_tuc=1.004194&TT=TAMTRU_01&TT_NAME=%C4%90%C4%83ng%20k%C3%BD%20t%E1%BA%A1m%20tr%C3%BA';
const PENDING_TTL_MS = 60 * 60 * 1000;

function toBase64(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

async function fetchAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { type, dataUrl: `data:${type};base64,${toBase64(bytes)}` };
}

async function getPending() {
  const { pending } = await chrome.storage.session.get('pending');
  if (!pending || !pending.payload) return null;
  if (Date.now() - (pending.receivedAt || 0) > PENDING_TTL_MS) {
    await chrome.storage.session.remove('pending');
    return null;
  }
  return pending;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg && msg.type;
  if (type === 'TAM_TRU_PAYLOAD') {
    (async () => {
      const payload = msg.payload;
      if (!payload || payload.version !== 1 || !payload.person || !payload.receive) {
        sendResponse({ ok: false, error: 'Gói dữ liệu không hợp lệ.' });
        return;
      }
      await chrome.storage.session.set({ pending: { payload, receivedAt: Date.now() } });
      const tab = await chrome.tabs.create({ url: FORM_URL, active: true });
      sendResponse({ ok: true, tabId: tab.id });
    })().catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (type === 'GET_PENDING') {
    getPending().then((p) => sendResponse(p)).catch(() => sendResponse(null));
    return true;
  }
  if (type === 'CLEAR_PENDING') {
    chrome.storage.session.remove('pending').then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (type === 'FETCH_FILE') {
    fetchAsDataUrl(msg.url)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  return false;
});
