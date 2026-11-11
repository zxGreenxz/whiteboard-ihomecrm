// Rào lý do dừng chương trình sale (PS-D05, ma trận Phòng sale lô ps08 10/11/2026 — ghi sai thật). Người dùng nói "Ngưng chương trình ưu
// đãi phòng 105 toà 1392QT giúp anh" (không nêu lý do); mô hình gọi policy_cancel MỘT lượt với reason tự đặt ("Ngưng chương trình ưu đãi",
// "… theo yêu cầu") và chương trình bị dừng ngay, lý do bịa nằm lại trong lịch sử. Trước đây chỉ kiểm reason không rỗng, không có bản xem
// trước. Ba lớp, đều ở connector (broker tự ép, không dựa vào lời dặn cho mô hình):
//   1. reason chỉ nhắc lại lệnh dừng (không còn chữ nào ngoài động từ dừng / tên đối tượng / "theo yêu cầu" / tên phòng toà) ⇒ needs_input
//      reason_required "hỏi người dùng vì sao": không cấp token, không tới dịch vụ. Áp cho cả lượt kèm token.
//   2. mọi lượt dừng không token ⇒ confirmation_required kèm nguyên văn reason + confirmToken (một lần, 10 phút, gắn kết nối + đúng
//      policyId + toàn bộ input). Chỉ lượt gọi lại kèm đúng token với y nguyên input mới tới dịch vụ ⇒ một lượt gọi không bao giờ dừng
//      được chương trình, và lý do được lưu luôn là lý do đã hiện trong bản xem trước (đổi reason ⇒ confirmation_invalid).
//   3. lượt kèm token phải kèm consentText = NGUYÊN VĂN câu người dùng vừa đáp, là lời đồng ý rõ (consent-guard.mjs consentClear); không
//      ⇒ needs_input consent_unclear, token CHƯA tiêu. Câu yêu cầu ban đầu không phải lời đồng ý ⇒ mô hình trích đúng lời người dùng thì
//      không tự xác nhận được bản xem trước trong chính lượt ra lệnh. Câu đã qua rào vào sổ audit của host (broker.mjs).
// Giới hạn nói thẳng: HTTP MCP không có phiên / lượt người dùng (mcp-http.mjs) nên connector KHÔNG biết consentText có thật là lời người
// dùng hay không — mô hình bịa "ok" vẫn qua lớp 3 (để lại vết audit); lớp 1 không bắt được lý do bịa mà "có nghĩa" (người dùng chỉ thấy
// nó ở bản xem trước, và phải đồng ý mới dừng).
// Thuần ngoài sổ token trong bộ nhớ (confirm-guard.mjs): khởi động lại chỉ làm mất token chờ, không mở đường ghi thẳng.
import { confirmBinding, createConfirmStore, splitConfirmField } from './confirm-guard.mjs';
import { CONSENT_UNCLEAR_PREVIEW_DETAIL, consentAuditText, consentClear } from './consent-guard.mjs';
import { foldVn } from './vn-relative-date.mjs';

export const POLICY_CANCEL_TOOL = 'crm_sale_policy_cancel';
// Mã thao tác ghi vào dòng audit prepared của lượt xác nhận (khuôn trang.thao_tác của host-ownership.mjs; không phải mã danh mục crm_action_*).
export const POLICY_CANCEL_AUDIT_ACTION = 'sale.policy_cancel';
// Trần phong bì của consentText (bằng crm_action_run, action-contract.mjs); dài hơn trần 300 của lời đồng ý ⇒ consent_unclear, không phải lỗi.
const CONSENT_ENVELOPE_MAX = 4000;

// Cụm / chữ CHỈ nhắc lại lệnh (đã bỏ dấu, foldVn). Cụm đi trước để chữ ghép không bị xét rời ("khuyến mãi" là đối tượng, "chị Mai" thì
// không). Danh sách cố ý hẹp: thà để lọt một lý do yếu sang bản xem trước (người dùng còn đọc được và phải đồng ý) hơn là chặn lời thật của
// người dùng ("hết chương trình", "khách chê giá cao", "chủ nhà yêu cầu", "không có lý do" đều qua).
const COMMAND_PHRASES = Object.freeze(['chuong trinh', 'uu dai', 'khuyen mai', 'chinh sach', 'ket thuc', 'cham dut', 'tam ngung', 'tam dung',
  'ap dung', 'yeu cau', 'de nghi', 'ly do', 'nguoi dung']);
const COMMAND_WORDS = new Set([
  'ngung', 'dung', 'huy', 'tat', 'bo', 'thoi', 'xoa', 'go', 'ngat', 'dong', 'stop', 'cancel', // động từ dừng
  'ct', 'ctkm', 'km', 'sale', 'policy', 'promo', // đối tượng bị dừng
  'phong', 'toa', 'nha', 'p', // nơi (kèm mọi chữ có số: 105, 1392qt, p105)
  'theo', 'lenh', 'cua', 'anh', 'chi', 'em', 'toi', 'user', // "theo yêu cầu của anh / chị"
  'giup', 'nhe', 'a', 'di', 'luon', 'nay', 'do', 'cho', 'voi', 'la', 'vi', 'tai', 'da', 'roi', 'nua', 'lai', 'va', 'can', 'cai', 'viec', // chữ đệm
]);
const PHRASES = new RegExp(`(^| )(${COMMAND_PHRASES.join('|')})(?= |$)`, 'g');

/** reason không nói VÌ SAO: bỏ cụm / chữ nhắc lại lệnh và chữ có số, không còn chữ nào (≥ 2 chữ cái). */
export function restatesStopCommand(reason) {
  if (typeof reason !== 'string') return true;
  const left = foldVn(reason).replace(/[^a-z0-9]+/g, ' ').trim().replace(PHRASES, ' ');
  return !left.split(' ').some(word => word.length >= 2 && !/[0-9]/.test(word) && !COMMAND_WORDS.has(word));
}

const REASON_DETAIL = 'Lý do gửi lên chỉ nhắc lại lệnh dừng, chưa nói VÌ SAO dừng chương trình.';
const REASON_GUIDANCE = 'CHƯA dừng. Hỏi người dùng vì sao dừng chương trình rồi gọi lại với reason = nguyên văn câu họ trả lời; ' +
  'không tự đặt lý do, không ghi "theo yêu cầu". Người dùng nói không có lý do ⇒ ghi đúng lời họ.';
const CONFIRM_GUIDANCE = 'CHƯA dừng. reason trong preview sẽ lưu làm lý do dừng và phải là lời NGƯỜI DÙNG đã nói; họ chưa nói vì sao dừng ⇒ ' +
  'hỏi họ, không dùng token này. Đọc lại lý do cho người dùng và chờ họ đồng ý rõ ở tin SAU; khi đó gọi lại đúng lệnh này (giữ requestId, ' +
  'y nguyên input) kèm confirmToken và consentText = NGUYÊN VĂN câu đồng ý đó (câu yêu cầu ban đầu không phải lời đồng ý). Token dùng một ' +
  'lần, hết hạn sau 10 phút, chỉ khớp đúng nội dung này. Lỗi confirmation_invalid: gọi lại không kèm confirmToken để lấy bản xem trước mới.';
const CONSENT_GUIDANCE = 'CHƯA dừng; token xác nhận chưa dùng, còn hạn thì dùng lại được. Đọc lại lý do trong bản xem trước, hỏi người dùng ' +
  'có đồng ý dừng không; họ đồng ý rõ thì gọi lại y nguyên input (giữ requestId) kèm confirmToken và consentText = nguyên văn câu trả lời ' +
  'đó. Họ nêu lý do khác ⇒ gọi lại không kèm confirmToken với reason mới.';

// consentText: chuỗi; null / trống = không gửi. Giữ nguyên descriptor của mọi khoá còn lại (accessor vẫn tới validator và bị từ chối ở đó).
function splitConsentField(args) {
  if (args === null || typeof args !== 'object') return { args, consentText: undefined, invalid: false };
  try {
    const descriptors = Object.getOwnPropertyDescriptors(args);
    if (!Object.hasOwn(descriptors, 'consentText')) return { args, consentText: undefined, invalid: false };
    const supplied = descriptors.consentText;
    delete descriptors.consentText;
    const rest = Object.defineProperties(Object.create(Object.getPrototypeOf(args)), descriptors);
    if (!supplied.enumerable || !Object.hasOwn(supplied, 'value')) return { args: rest, consentText: undefined, invalid: true };
    const value = supplied.value;
    if (value === null || value === '') return { args: rest, consentText: undefined, invalid: false };
    if (typeof value !== 'string' || value.length > CONSENT_ENVELOPE_MAX) return { args: rest, consentText: undefined, invalid: true };
    return { args: rest, consentText: value, invalid: false };
  } catch { return { args, consentText: undefined, invalid: true }; }
}

/** Tách confirmToken + consentText của tool dừng chương trình TRƯỚC validator (salePolicyInput không bao giờ thấy hai trường này);
 * undefined với tool khác (người gọi dùng đường tách sẵn có của tool đó). */
export function splitPolicyCancelFields(name, args) {
  if (name !== POLICY_CANCEL_TOOL) return undefined;
  const token = splitConfirmField(args), consent = splitConsentField(token.args);
  return { args: consent.args, confirmToken: token.confirmToken, consentText: consent.consentText, invalid: token.invalid || consent.invalid };
}

export function createPolicyCancelGuard({ clock }) {
  if (typeof clock !== 'function') throw new TypeError('invalid_policy_cancel_clock');
  const store = createConfirmStore({ clock });
  return Object.freeze({
    // input = đầu vào ĐÃ qua validator (salePolicyInput). Trả { allow, consent? } (consent = câu đồng ý đã qua rào, cho sổ audit) |
    // { confirmation } (kết quả CHƯA ghi cho mô hình: needs_input hoặc confirmation_required) | { refused } — cùng khuôn với rào chữ công
    // khai để broker xử lý chung.
    review(connectionId, name, input, confirmToken, consentText) {
      if (name !== POLICY_CANCEL_TOOL) return { allow: true };
      if (restatesStopCommand(input.reason)) return { confirmation: { outcome: 'needs_input', applied: false, tool: name, policyId: input.policyId,
        reason: 'reason_required', detail: REASON_DETAIL, huongDan: REASON_GUIDANCE } };
      const now = clock(), bound = confirmBinding([connectionId, name, input.policyId, input]);
      if (confirmToken !== undefined) {
        // Lớp 3 TRƯỚC khi đổi token: lời đồng ý chưa rõ thì token chưa tiêu (người dùng đáp "ok" ⇒ dùng lại được trong hạn).
        if (!consentClear(consentText)) return { confirmation: { outcome: 'needs_input', applied: false, tool: name, policyId: input.policyId,
          reason: 'consent_unclear', detail: CONSENT_UNCLEAR_PREVIEW_DETAIL, huongDan: CONSENT_GUIDANCE } };
        return store.redeem(confirmToken, bound, now).ok ? { allow: true, consent: consentAuditText(consentText) } : { refused: true };
      }
      const issued = store.issue(bound, null, now);
      return { confirmation: { outcome: 'confirmation_required', applied: false, tool: name, policyId: input.policyId,
        preview: { reason: input.reason }, confirmToken: issued.token, expiresAt: issued.expiresAt, huongDan: CONFIRM_GUIDANCE } };
    },
  });
}
