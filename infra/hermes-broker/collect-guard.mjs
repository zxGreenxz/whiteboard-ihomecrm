// Lưới an toàn của thu tiền hoá đơn (C3j, nghiệm thu C3i 26/10/2026 — ghi sai thật TC-A03). Người dùng nói "1392: phòng 205 với 306 ck
// đủ phần còn thiếu tháng 10 rồi, L06 thì chưa nha"; mô hình gọi THÊM invoice.collect cho L06 với ghi chú "Chưa thanh toán phần còn thiếu
// tháng 10" rồi xác nhận ⇒ ghi thu 3.970.000đ cho khoản khách CHƯA trả. Máy chủ không thấy lời người dùng, nhưng thấy ghi chú: lần thu
// mà ghi chú nói "chưa thanh toán / chưa trả / chưa đóng / chưa chuyển…" là mâu thuẫn ⇒ hỏi lại, không ghi. Thêm: tên sổ nhận gửi
// nguyên nhãn ứng viên của máy chủ ("HKDHUY — thanh toán (TT)", TC-A06) ⇒ lấy phần mã trước dấu gạch để máy chủ giải được.
// Thuần (không I/O).
import { foldVn } from './vn-relative-date.mjs';

const UNPAID = /\bchua\s+(thanh\s+toan|tra|dong|chuyen|ck|nop|nhan|gui)\b|\bkhong\s+(tra|dong|chuyen)\b/;
const LABEL_TAIL = /\s+[—–-]\s+.*$/;

/** Câu hỏi lại khi ghi chú nói khoản đó chưa trả (một câu tĩnh, kèm nguyên văn ghi chú ≤ 200 ký tự). */
export const unpaidNoteDetail = note => `Ghi chú "${note}" nói khoản này CHƯA được trả — thu tiền chỉ ghi khoản khách ĐÃ trả; `
  + 'phòng khách chưa trả thì KHÔNG gọi invoice.collect. Khách trả một phần ⇒ gọi lại với amount đúng, bỏ câu "chưa…" khỏi ghi chú.';

/**
 * invoice.collect: { params (để gửi SQL), unpaid (ghi chú mâu thuẫn — hỏi lại) }. Thao tác khác ⇒ giữ nguyên.
 */
export function collectGuard(actionId, params) {
  if (actionId !== 'invoice.collect' || params === null || typeof params !== 'object') return { params, unpaid: null };
  if (typeof params.note === 'string' && UNPAID.test(foldVn(params.note))) return { params, unpaid: params.note };
  // C3l (nghiệm thu C3j TC-A07 "Toà 80 phòng MB ck 2tr796"): mô hình gửi cả roomName "MB" lẫn cashbookName "MB" ⇒ máy chủ hỏi sổ.
  // Tên sổ trùng tên một phòng của chính lệnh (kể cả items[]) là tên phòng, không phải sổ ⇒ bỏ cashbookName, máy chủ dùng sổ mặc định.
  if (typeof params.cashbookName === 'string') {
    const book = foldVn(params.cashbookName).trim();
    const rooms = [params.roomName, ...(Array.isArray(params.items) ? params.items.map(item => item?.roomName) : [])];
    if (book && rooms.some(room => typeof room === 'string' && foldVn(room).trim() === book)) {
      const { cashbookName: _room, ...rest } = params;
      return { params: rest, unpaid: null };
    }
  }
  if (typeof params.cashbookName === 'string' && LABEL_TAIL.test(params.cashbookName)) {
    const code = params.cashbookName.replace(LABEL_TAIL, '').trim();
    if (code) return { params: { ...params, cashbookName: code }, unpaid: null };
  }
  return { params, unpaid: null };
}
