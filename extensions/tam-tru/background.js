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

const ALLOWED_FILE_HOSTS = new Set(['tryymsxyyckgbrmmvozx.supabase.co']);
const ALLOWED_SENDER_ORIGINS = new Set(['https://ptcrm.vercel.app']);

function allowedFileUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ALLOWED_FILE_HOSTS.has(u.hostname);
  } catch (e) {
    return false;
  }
}

function senderAllowed(sender) {
  const origin = sender && sender.origin;
  if (!origin) return false;
  return ALLOWED_SENDER_ORIGINS.has(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
}

/** Gói từ trang CRM: chỉ nhận đúng hình dạng đã biết và URL ảnh thuộc host Supabase của dự án. */
function payloadProblem(payload) {
  if (!payload || payload.version !== 1 || !payload.person || !payload.receive) return 'Gói dữ liệu không hợp lệ.';
  if (!Array.isArray(payload.attachments) || payload.attachments.length === 0) return 'Gói dữ liệu thiếu ảnh đính kèm.';
  if (payload.attachments.length > 30) return 'Gói dữ liệu có quá nhiều ảnh.';
  if (!payload.attachments.every((a) => a && allowedFileUrl(a.url))) return 'Đường dẫn ảnh không thuộc kho của CRM.';
  return null;
}

// Trang CRM gửi thẳng qua externally_connectable; các tin nội bộ (panel) đi onMessage.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!senderAllowed(sender)) { sendResponse({ ok: false, error: 'Trang gửi không được phép.' }); return false; }
  // CRM hỏi "có mã hồ sơ nào vừa nộp chưa ghi sổ không" và báo lại khi đã ghi xong.
  if (msg && msg.type === 'TAM_TRU_LAY_KET_QUA') {
    docKetQua().then((ds) => sendResponse({ ok: true, ketQua: ds })).catch(() => sendResponse({ ok: false, ketQua: [] }));
    return true;
  }
  if (msg && msg.type === 'TAM_TRU_DA_GHI_SO') {
    xoaKetQua(msg.maDaLuu).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (!msg || msg.type !== 'TAM_TRU_PAYLOAD') { sendResponse({ ok: false, error: 'Tin không hợp lệ.' }); return false; }
  const problem = payloadProblem(msg.payload);
  if (problem) { sendResponse({ ok: false, error: problem }); return false; }
  (async () => {
    await chrome.storage.session.set({ pending: { payload: msg.payload, receivedAt: Date.now() } });
    const tab = await chrome.tabs.create({ url: FORM_URL, active: true });
    sendResponse({ ok: true, tabId: tab.id });
  })().catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

/** Kết quả nộp chờ CRM lấy về. Dùng storage.local (không phải session) vì người
 * dùng có thể đóng tab CRM, thậm chí đóng trình duyệt, trước khi quay lại ghi sổ. */
const KHOA_KET_QUA = 'ketQuaNop';
const KET_QUA_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function docKetQua() {
  const kho = await chrome.storage.local.get(KHOA_KET_QUA);
  const ds = Array.isArray(kho[KHOA_KET_QUA]) ? kho[KHOA_KET_QUA] : [];
  const con = ds.filter((x) => Date.now() - Date.parse(x.submittedAt || 0) < KET_QUA_TTL_MS);
  if (con.length !== ds.length) await chrome.storage.local.set({ [KHOA_KET_QUA]: con });
  return con;
}

async function themKetQua(ketQua) {
  const ds = await docKetQua();
  if (ds.some((x) => x.submCode === ketQua.submCode)) return;
  ds.push(ketQua);
  await chrome.storage.local.set({ [KHOA_KET_QUA]: ds.slice(-50) });
  await danhThucCRM();
}

/** Gõ cửa mọi tab CRM đang mở để chúng ghi mã vào sổ ngay, kể cả khi đang ở nền.
 * Chỉ là tiếng gõ cửa — dữ liệu thật thì trang tự hỏi lại qua kênh riêng. */
async function danhThucCRM() {
  const tabs = await chrome.tabs.query({ url: ['https://ptcrm.vercel.app/*', 'http://localhost/*'] });
  await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'TAM_TRU_CO_KET_QUA' }).catch(() => {})));
}

async function xoaKetQua(maDaLuu) {
  const bo = new Set(Array.isArray(maDaLuu) ? maDaLuu : []);
  const ds = (await docKetQua()).filter((x) => !bo.has(x.submCode));
  await chrome.storage.local.set({ [KHOA_KET_QUA]: ds });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg && msg.type;
  if (type === 'TAM_TRU_DA_NOP') {
    const k = msg.ketQua;
    if (!k || !k.submCode || !k.customerId) { sendResponse({ ok: false }); return false; }
    themKetQua(k).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
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
    if (!allowedFileUrl(msg.url)) { sendResponse({ ok: false, error: 'Đường dẫn ảnh không thuộc kho của CRM.' }); return false; }
    fetchAsDataUrl(msg.url)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  return false;
});
