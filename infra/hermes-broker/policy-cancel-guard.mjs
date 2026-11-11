// Rào dừng chương trình sale (PS-D05, ma trận Phòng sale lô ps08 10/11/2026 — ghi sai thật). Người dùng nói "Ngưng chương trình ưu
// đãi phòng 105 toà 1392QT giúp anh" (không nêu lý do); mô hình gọi policy_cancel MỘT lượt với reason tự đặt ("Ngưng chương trình ưu đãi",
// "… theo yêu cầu") và chương trình bị dừng ngay, lý do bịa nằm lại trong lịch sử. Trước đây chỉ kiểm reason không rỗng, không có bản xem
// trước. Bốn lớp, đều ở connector (broker tự ép, không dựa vào lời dặn cho mô hình):
//   1. lưới chữ — MỀM, chỉ là lời nhắc sớm: reason CHỈ gồm chữ nhắc lại lệnh (động từ dừng, "chương trình ưu đãi", "theo yêu cầu", tên /
//      số phòng toà, chữ đệm) ⇒ needs_input reason_required "hỏi người dùng vì sao": không cấp token, không tới dịch vụ; áp cho cả lượt kèm
//      token. Nó chỉ bắt đúng dạng bot đã tự đặt ở PS-D05; lý do bịa có thêm một chữ khác ("Hết thời gian áp dụng ưu đãi", "Theo yêu cầu
//      quản lý", "anh muốn dừng") đi qua — rào thật là lớp 2–4. Lý do thật dù ngắn ("ế", "Kết thúc", "full") đi qua.
//   2. chương trình phải là chương trình kết nối này VỪA đọc qua broker (kết quả policy_observe / lưu / dừng / tra trạng thái của chính
//      kết nối, nhớ 30 phút, đúng version gửi lên): không có ⇒ needs_input observe_required, không token. Có ⇒ bản xem trước nêu tên, trạng
//      thái, thời hạn của chương trình đó cùng nguyên văn reason — người dùng thấy CÁI GÌ sẽ dừng và vì sao (tên phòng / toà KHÔNG có:
//      kết quả đọc chương trình chỉ mang roomId).
//   3. mọi lượt dừng không token ⇒ confirmation_required kèm bản xem trước đó + confirmToken (một lần, 10 phút, gắn kết nối + đúng policyId +
//      toàn bộ input). Chỉ lượt gọi lại kèm đúng token với y nguyên input mới tới dịch vụ ⇒ một lượt gọi không bao giờ dừng được chương
//      trình, và lý do được lưu luôn là lý do đã hiện trong bản xem trước (đổi reason ⇒ confirmation_invalid).
//   4. lượt kèm token phải kèm consentText = NGUYÊN VĂN câu người dùng vừa đáp, là CÂU ĐÁP THUẦN (POLICY_CANCEL_CONSENT — consent-guard.mjs
//      replyConsent: chỉ lời đồng ý / xưng hô / trợ từ / động từ dừng: "ok", "đồng ý dừng", "ừ dừng đi", "dừng luôn"); không ⇒ needs_input
//      consent_unclear, token CHƯA tiêu. Câu nêu chương trình / phòng / lý do — câu ra lệnh, kể cả "Vâng, ngưng chương trình ưu đãi phòng
//      105 giúp anh" — không bao giờ là lời đồng ý ⇒ mô hình trích đúng câu đó cũng không tự xác nhận được. Câu đã qua rào vào sổ audit.
// Giới hạn nói thẳng: HTTP MCP không có phiên / lượt người dùng (mcp-http.mjs) nên connector KHÔNG biết consentText có thật là lời người
// dùng hay không — mô hình bịa "ok" vẫn qua lớp 4 (để lại vết audit); câu ra lệnh không nêu đối tượng ("dừng luôn đi em" ngay sau khi vừa
// xem chương trình) có chữ y hệt lời đồng ý nên cũng qua. Lý do bịa mà "có nghĩa" chỉ bị chặn bởi bản xem trước + lời đồng ý.
// Thuần ngoài hai sổ trong bộ nhớ (token — confirm-guard.mjs; chương trình vừa đọc): khởi động lại chỉ làm mất token chờ / bắt đọc lại
// chương trình, không mở đường ghi thẳng.
import { confirmBinding, createConfirmStore, splitConfirmField } from './confirm-guard.mjs';
import { consentAuditText, replyConsent } from './consent-guard.mjs';
import { foldVn } from './vn-relative-date.mjs';

export const POLICY_CANCEL_TOOL = 'crm_sale_policy_cancel';
// Mã thao tác ghi vào dòng audit prepared của lượt xác nhận (khuôn trang.thao_tác của host-ownership.mjs; không phải mã danh mục crm_action_*).
export const POLICY_CANCEL_AUDIT_ACTION = 'sale.policy_cancel';
// Trần phong bì của consentText (bằng crm_action_run, action-contract.mjs); dài hơn trần 300 của lời đồng ý ⇒ consent_unclear, không phải lỗi.
const CONSENT_ENVELOPE_MAX = 4000;
/** Lời đồng ý của lượt xác nhận dừng chương trình: câu đáp thuần; "dừng" ở đây là động từ của thao tác (không còn là chưa đồng ý), "đừng"
 * vẫn là; "huỷ" phải gõ đúng dấu (gõ không dấu "huy" trùng tên người). */
export const POLICY_CANCEL_CONSENT = replyConsent({ verbs: ['dừng', 'ngưng', 'ngừng', 'tắt', '!huỷ', 'kết thúc'],
  examples: ['ok', 'đồng ý dừng', 'ừ dừng đi'] });
// Kết quả của bốn tool chính sách (đã qua salePolicyResult ở adapter) mang chương trình: observe ⇒ room.policy; lưu / dừng / trạng thái
// applied ⇒ receipt.policy. Nhớ theo kết nối, 30 phút, tối đa 16 chương trình / kết nối và 256 kết nối (bỏ cái cũ nhất).
const POLICY_TOOLS = new Set(['crm_sale_policy_observe', 'crm_sale_policy_save', POLICY_CANCEL_TOOL, 'crm_sale_policy_status']);
export const POLICY_SEEN_TTL_MS = 30 * 60 * 1000;
const POLICY_SEEN_PER_CONNECTION = 16, POLICY_SEEN_CONNECTIONS = 256;
const POLICY_STATUSES = new Set(['SCHEDULED', 'ACTIVE', 'EXPIRED', 'CANCELLED']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortText = (value, max) => typeof value === 'string' && value.trim() !== '' && [...value].length <= max;
function programOf(result) {
  const policy = result?.room?.policy ?? result?.receipt?.policy;
  if (policy === null || typeof policy !== 'object' || typeof policy.id !== 'string' || !UUID.test(policy.id) || !Number.isSafeInteger(policy.version) ||
      policy.version < 1 || !shortText(policy.title, 120) || !POLICY_STATUSES.has(policy.status) || !shortText(policy.startsAt, 40) ||
      !shortText(policy.endsAt, 40)) return null;
  return { id: policy.id.toLowerCase(), version: policy.version, title: policy.title, status: policy.status, startsAt: policy.startsAt, endsAt: policy.endsAt };
}

// Cụm / chữ CHỈ nhắc lại lệnh (đã bỏ dấu, foldVn). Cụm đi trước để chữ ghép không bị xét rời ("khuyến mãi" là đối tượng, "chị Mai" thì
// không). Danh sách cố ý hẹp: thà để lọt một lý do yếu sang bản xem trước (người dùng còn đọc được và phải đồng ý) hơn là chặn lời thật của
// người dùng ("hết chương trình", "khách chê giá cao", "chủ nhà yêu cầu", "không có lý do", "Kết thúc", "ế" đều qua).
const COMMAND_PHRASES = Object.freeze(['chuong trinh', 'uu dai', 'khuyen mai', 'chinh sach', 'cham dut', 'tam ngung', 'tam dung', 'ap dung',
  'yeu cau', 'de nghi', 'ly do', 'nguoi dung']);
const COMMAND_WORDS = new Set([
  'ngung', 'dung', 'huy', 'tat', 'bo', 'thoi', 'xoa', 'go', 'ngat', 'dong', 'stop', 'cancel', // động từ dừng
  'ct', 'ctkm', 'km', 'sale', 'policy', 'promo', // đối tượng bị dừng
  'phong', 'toa', 'nha', 'p', // nơi (kèm mọi chữ có số: 105, 1392qt, p105)
  'theo', 'lenh', 'cua', 'anh', 'chi', 'em', 'toi', 'user', // "theo yêu cầu của anh / chị"
  'giup', 'nhe', 'a', 'di', 'luon', 'nay', 'do', 'cho', 'voi', 'la', 'vi', 'tai', 'da', 'roi', 'nua', 'lai', 'va', 'can', 'cai', 'viec', // chữ đệm
]);
// Chữ một ký tự gõ KHÔNG dấu là chữ viết tắt (a = anh, e = em, c = chị, p = phòng); một ký tự CÓ dấu ("ế") là chữ thật.
const SHORT_FILLERS = new Set(['a', 'e', 'c', 'p']);

/** reason không nói VÌ SAO: bỏ cụm / chữ nhắc lại lệnh, chữ có số và chữ viết tắt một ký tự, không còn chữ nào. */
export function restatesStopCommand(reason) {
  if (typeof reason !== 'string') return true;
  const words = reason.normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean)
    .map(raw => ({ raw, folded: foldVn(raw).replace(/[^a-z0-9]/g, '') }));
  const left = [];
  for (let index = 0; index < words.length; index += 1) {
    if (index + 1 < words.length && COMMAND_PHRASES.includes(`${words[index].folded} ${words[index + 1].folded}`)) index += 1;
    else left.push(words[index]);
  }
  // Chữ không có dạng Latin (folded rỗng) là chữ thật, không đoán.
  return !left.some(({ raw, folded }) => folded === '' || (!/[0-9]/.test(folded) && !COMMAND_WORDS.has(folded) && !(raw === folded && SHORT_FILLERS.has(folded))));
}

const REASON_DETAIL = 'Lý do gửi lên chỉ nhắc lại lệnh dừng, chưa nói VÌ SAO dừng chương trình.';
const REASON_GUIDANCE = 'CHƯA dừng. Hỏi người dùng vì sao dừng chương trình rồi gọi lại với reason = nguyên văn câu họ trả lời; ' +
  'không tự đặt lý do, không ghi "theo yêu cầu". Người dùng nói không có lý do ⇒ ghi đúng lời họ.';
const OBSERVE_DETAIL = 'Kết nối chưa đọc chương trình này (đúng policyId và expectedVersion) trong 30 phút qua, nên chưa dựng được bản xem trước ' +
  'nêu đúng chương trình sẽ dừng.';
const OBSERVE_GUIDANCE = 'CHƯA dừng, chưa có token. Gọi crm_sale_action operation=policy_observe với roomId của phòng người dùng nói, rồi gọi lại ' +
  'lệnh dừng với policyId + expectedVersion vừa đọc (giữ requestId và reason); chương trình đã khác hay không còn thì báo người dùng.';
const CONFIRM_GUIDANCE = 'CHƯA dừng. reason trong preview sẽ lưu làm lý do dừng và phải là lời NGƯỜI DÙNG đã nói; họ chưa nói vì sao dừng ⇒ ' +
  'hỏi họ, không dùng token này. Đọc cho người dùng chương trình sẽ dừng (preview.program: tên, trạng thái, thời hạn) và lý do, rồi chờ họ ' +
  'đồng ý rõ ở tin SAU; khi đó gọi lại đúng lệnh này (giữ requestId, y nguyên input) kèm confirmToken và consentText = NGUYÊN VĂN câu đáp đó. ' +
  'Lời đồng ý là câu đáp chỉ gồm lời đồng ý ("ok", "đồng ý dừng", "ừ dừng đi"); câu yêu cầu ban đầu, câu nêu lại chương trình / phòng / lý do ' +
  'không phải lời đồng ý. Token dùng một lần, hết hạn sau 10 phút, chỉ khớp đúng nội dung này. Lỗi confirmation_invalid: gọi lại không kèm ' +
  'confirmToken để lấy bản xem trước mới.';
const CONSENT_GUIDANCE = 'CHƯA dừng; token xác nhận chưa dùng, còn hạn thì dùng lại được. Đọc lại chương trình và lý do trong bản xem trước, hỏi ' +
  'người dùng có đồng ý dừng không; họ đồng ý rõ thì gọi lại y nguyên input (giữ requestId) kèm confirmToken và consentText = nguyên văn câu ' +
  'trả lời đó. Họ nêu lý do khác ⇒ gọi lại không kèm confirmToken với reason mới.';

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
  // connectionId ⇒ Map(policyId ⇒ chương trình đã đọc + lúc đọc); thứ tự chèn = cũ trước.
  const seen = new Map();
  return Object.freeze({
    // Ghi nhớ chương trình trong kết quả ĐÃ trả cho kết nối (gọi sau khi tool chính sách xong, kể cả sau lệnh ghi đã gửi). Tool khác / kết
    // quả không mang chương trình ⇒ bỏ qua. Không bao giờ ném (lỗi ở đây không được biến lệnh ghi đã xong thành "chưa rõ"): chỉ phục vụ bản
    // xem trước, nuốt lỗi là an toàn — thiếu chương trình thì lượt dừng sau chỉ phải đọc lại.
    remember(connectionId, name, result) {
      try {
        if (!POLICY_TOOLS.has(name) || typeof connectionId !== 'string') return;
        const program = programOf(result);
        if (program === null) return;
        let programs = seen.get(connectionId);
        if (programs === undefined) {
          if (seen.size >= POLICY_SEEN_CONNECTIONS) seen.delete(seen.keys().next().value);
          programs = new Map();
          seen.set(connectionId, programs);
        }
        programs.delete(program.id);
        if (programs.size >= POLICY_SEEN_PER_CONNECTION) programs.delete(programs.keys().next().value);
        programs.set(program.id, Object.freeze({ ...program, at: clock() }));
      } catch { /* chỉ mất ghi nhớ, xem chú thích trên */ }
    },
    // input = đầu vào ĐÃ qua validator (salePolicyInput). Trả { allow, consent? } (consent = câu đồng ý đã qua rào, cho sổ audit) |
    // { confirmation } (kết quả CHƯA ghi cho mô hình: needs_input hoặc confirmation_required) | { refused } — cùng khuôn với rào chữ công
    // khai để broker xử lý chung.
    review(connectionId, name, input, confirmToken, consentText) {
      if (name !== POLICY_CANCEL_TOOL) return { allow: true };
      const ask = (reason, detail, huongDan) => ({ confirmation: { outcome: 'needs_input', applied: false, tool: name, policyId: input.policyId,
        reason, detail, huongDan } });
      if (restatesStopCommand(input.reason)) return ask('reason_required', REASON_DETAIL, REASON_GUIDANCE);
      const now = clock(), bound = confirmBinding([connectionId, name, input.policyId, input]);
      if (confirmToken !== undefined) {
        // Lớp 4 TRƯỚC khi đổi token: lời đồng ý chưa rõ thì token chưa tiêu (người dùng đáp "ok" ⇒ dùng lại được trong hạn).
        if (!POLICY_CANCEL_CONSENT.clear(consentText)) return ask('consent_unclear', POLICY_CANCEL_CONSENT.detail, CONSENT_GUIDANCE);
        return store.redeem(confirmToken, bound, now).ok ? { allow: true, consent: consentAuditText(consentText) } : { refused: true };
      }
      // Lớp 2: chỉ chương trình kết nối vừa đọc, đúng version — bản xem trước nêu đúng chương trình (token vẫn gắn toàn bộ input).
      const program = seen.get(connectionId)?.get(input.policyId.toLowerCase());
      if (program === undefined || now - program.at > POLICY_SEEN_TTL_MS || program.version !== input.expectedVersion)
        return ask('observe_required', OBSERVE_DETAIL, OBSERVE_GUIDANCE);
      const issued = store.issue(bound, null, now);
      return { confirmation: { outcome: 'confirmation_required', applied: false, tool: name, policyId: input.policyId,
        preview: { program: { title: program.title, status: program.status, startsAt: program.startsAt, endsAt: program.endsAt }, reason: input.reason },
        confirmToken: issued.token, expiresAt: issued.expiresAt, huongDan: CONFIRM_GUIDANCE } };
    },
  });
}
