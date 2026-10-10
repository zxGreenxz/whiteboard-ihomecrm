// =============================================================
// message-card.js — tin dạng THẺ của Zalo (link có ảnh xem trước, danh thiếp,
// "bubble") → dữ liệu hiển thị. Thuần, không import gì, để test chạy được ở CI
// mà không kéo zca-js hay Supabase theo.
//
// VÌ SAO (đo production 09/10/2026): 484 tin `chat.recommended` hiện nguyên chữ
// "sendBubbleMessage". pickText lấy `content.title`, mà với loại thẻ này Zalo đặt
// title là TÊN HÀM gửi chứ không phải chữ cho người đọc. Phần có ích (mô tả, link,
// ảnh nhỏ) bị bỏ vì rawSubset chỉ giữ content dạng chuỗi.
//
// Thẻ đi vào `media_meta.card` của một tin `text`: CHECK msg_type không phải đổi,
// và web cũ (chưa biết đọc card) vẫn hiện được dòng chữ trong `body`.
// =============================================================

const LOAI_THE = new Set(['chat.recommended', 'chat.link', 'share.contact']);
const DAI_TOI_DA = 500; // ký tự mỗi trường — media_meta là jsonb, đừng để phình

/** Chuỗi máy của Zalo (tên hàm kiểu "sendBubbleMessage"), không phải chữ cho người đọc. */
export function laChuoiMay(s) {
  return /^send[A-Z][A-Za-z]*$/.test(String(s ?? '').trim());
}

function chu(v, max = DAI_TOI_DA) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && !laChuoiMay(s) ? s.slice(0, max) : null;
}

// Chỉ http(s): link trong thẻ do người gửi đặt, web sẽ bấm mở nó.
function link(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Đọc thẻ từ `msgType` + `content` của zca-js. Không phải loại thẻ thì null.
 * @returns {{kind: 'link'|'contact'|'card', action: string|null, title: string|null,
 *   description: string|null, href: string|null, thumb: string|null} | null}
 */
export function docThe(msgType, content) {
  const mt = String(msgType || '');
  if (!LOAI_THE.has(mt) || !content || typeof content !== 'object') return null;
  const action = chu(content.action, 100);
  const href = link(content.href);
  const laDanhThiep = mt === 'share.contact' || /user|contact/i.test(action || '');
  return {
    kind: laDanhThiep ? 'contact' : href ? 'link' : 'card',
    action,
    title: chu(content.title),
    description: chu(content.description),
    href,
    thumb: link(content.thumb),
  };
}

/** Một dòng chữ cho khung chat và ô xem trước trong danh sách hội thoại. */
export function chuCuaThe(the) {
  if (the.kind === 'contact') return the.title ? `[Danh thiếp] ${the.title}` : '[Danh thiếp]';
  return the.title || the.description || the.href || '[Tin dạng thẻ]';
}

/**
 * Dòng `zalo_messages` cho tin dạng thẻ, cùng hình dạng với classifyMessage.
 * Không phải tin thẻ thì null — classifyMessage xử lý tiếp như cũ.
 */
export function phanLoaiTinThe(m) {
  const d = m?.data || {};
  const the = docThe(d.msgType, d.content);
  if (!the) return null;
  return { msg_type: 'text', body: chuCuaThe(the), media_url: null, media_label: null, media_meta: { card: the } };
}
