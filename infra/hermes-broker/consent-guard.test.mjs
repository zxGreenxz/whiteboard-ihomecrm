import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSENT_CLASSES, CONSENT_TEXT_MAX, PLAIN_REPLY_CONSENT, consentAuditText, consentClear, consentRequired, replyConsent } from './consent-guard.mjs';
import { createActionCatalog } from './action-catalog.mjs';
import { CONTRACT_ACTIONS } from './contract-action-contract.mjs';
import { EXPENSE_ACTIONS } from './expense-actions-contract.mjs';
import { INVOICE_ACTIONS } from './invoice-actions-contract.mjs';
import { TASK_ACTIONS } from './task-actions-contract.mjs';
import { ROOM_LOCK_CONSENT } from './room-lock-guard.mjs';
import { POLICY_CANCEL_CONSENT } from './policy-cancel-guard.mjs';

// Rào đồng ý ở máy chủ (lượt 12 Hợp đồng, nghiệm thu 24/10 — ghi sai thật lần 3 với contract.return). Bộ câu dưới là phép đo của rào chữ:
// mỗi đột biến của luật (khớp chuỗi con, bỏ dấu hiệu chưa đồng ý, bỏ luật đầu vế, bỏ dấu khi so) phải làm ít nhất một câu đổi kết quả.
export const CONSENT_YES = Object.freeze(['ok', 'Ok em', 'OK.', 'oke', 'okie', 'okay', 'Đồng ý', 'anh đồng ý', 'Xác nhận', 'xác nhận trả phòng', 'ừ', 'Ừm', 'uh', 'ờ',
  'Được', 'được rồi em', 'Đúng rồi', 'chốt', 'chốt đi', 'Ghi đi', 'làm đi em', 'trả phòng đi', 'Hủy đi', 'huỷ đi', 'yes', 'Có', 'Có, khách trả chìa rồi',
  'dong y', 'ghi di', 'xac nhan', 'duoc roi', 'Trả sớm, quyết toán sau. Ok ghi đi', 'ok, ghi cho anh', 'dạ vâng ạ', 'em ơi ghi đi', '👍', 'Ok em,\nghi đi',
  // 11/11: "đc" / "dc" là "được" viết tắt — cùng luật từ yếu (phải hết vế).
  'đc', 'dc em', 'Đc a']);
export const CONSENT_NO = Object.freeze(['', '   ',
  // Câu của sự cố 24/10: chỉ bổ sung chi tiết.
  'Trả sớm, quyết toán sau, khách đã trả chìa rồi',
  'ok nhưng khoan đã', 'khoan', 'chờ chút', 'cho xiu', 'không', 'ko', 'k ghi', 'chưa', 'sai rồi', 'nhầm phòng', 'sửa lại ngày', 'đổi ngày 13', 'đừng ghi', 'thôi', 'đợi anh hỏi khách',
  'ok?', 'được không', 'ok, mà phí bao nhiêu？', '👍 khoan',
  // Đồng ý / có / được / chốt nằm GIỮA câu chi tiết hay không hết vế.
  'khách đồng ý trả sớm', 'khách có trả chìa', 'khách đã xác nhận', 'chốt quyết toán sau', 'được hoàn cọc rồi', 'trả sớm nhé ok', 'Người dùng đồng ý',
  'đc hoàn cọc', 'dc không',
  // Có dấu thì dấu phải khớp: cô ≠ có, đừng ≠ đúng (gõ không dấu "dung roi" là mơ hồ ⇒ hỏi lại); không dấu: co / o là chữ khác.
  'cô Lan trả phòng rồi', 'co Lan tra phong roi', 'o phong 302', 'dung roi',
  // Ranh giới từ: không khớp chuỗi con.
  'book', 'okela', 'cokhi', 'yesterday',
  // "dừng" vẫn là chưa đồng ý với thao tác không lùi được (chỉ rào dừng chương trình nhận nó làm động từ).
  'ok dừng đi', 'dừng lại',
  'ok '.repeat(101)]);

test('rào chữ: câu đồng ý rõ qua, câu chỉ bổ sung chi tiết / có dấu hiệu chưa đồng ý / hỏi lại / vắng thì không', () => {
  for (const text of CONSENT_YES) assert.equal(consentClear(text), true, JSON.stringify(text));
  for (const text of CONSENT_NO) assert.equal(consentClear(text), false, JSON.stringify(text));
  for (const value of [undefined, null, 42, {}, ['ok'], true]) assert.equal(consentClear(value), false, String(value));
  assert.equal(consentClear('ok'.padEnd(CONSENT_TEXT_MAX, ' ')), true, 'đúng trần');
  assert.equal(consentClear('ok'.padEnd(CONSENT_TEXT_MAX + 1, ' ')), false, 'quá trần');
});

test('đột biến của luật rào chữ đều bị bộ câu bắt', () => {
  const fold = text => text.normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd').toLowerCase();
  const words = text => fold(text).split(/[^a-z0-9]+/).filter(Boolean);
  const YES = ['ok', 'oke', 'okie', 'okay', 'yes', 'dong y', 'xac nhan', 'u', 'um', 'uh', 'o', 'duoc', 'dung roi', 'chot', 'ghi di', 'lam di', 'huy di', 'co'];
  const NO = ['khong', 'khoan', 'cho', 'doi', 'thoi', 'dung', 'chua', 'sai', 'nham', 'sua lai'];
  const has = (text, phrase) => ` ${words(text).join(' ')} `.includes(` ${phrase} `);
  const mutants = {
    // Khớp chuỗi con (không ranh giới từ): "book" chứa "ok".
    substring: text => typeof text === 'string' && YES.some(phrase => fold(text).includes(phrase)) && !NO.some(phrase => fold(text).includes(phrase)),
    // Bỏ hẳn dấu hiệu chưa đồng ý.
    noNegative: text => consentClear(String(text).replace(/khoan|chờ|chưa|không|nhưng/gu, 'và')) && typeof text === 'string' && text !== '',
    // Danh sách y như đề, đúng ranh giới từ, bỏ dấu rồi so, đồng ý ở bất kỳ đâu.
    anywhere: text => typeof text === 'string' && YES.some(phrase => has(text, phrase)) && !NO.some(phrase => has(text, phrase)),
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    const wrong = [...CONSENT_YES.filter(text => !mutant(text)), ...CONSENT_NO.filter(text => mutant(text))];
    assert.ok(wrong.length > 0, `đột biến ${name} không bị bắt`);
  }
  // Câu của sự cố: luật "đồng ý ở bất kỳ đâu" cũng đã chặn được; các câu chi tiết khác thì không.
  assert.equal(mutants.anywhere('Trả sớm, quyết toán sau, khách đã trả chìa rồi'), false);
  assert.deepEqual(['khách có trả chìa', 'được hoàn cọc rồi', 'chốt quyết toán sau'].map(mutants.anywhere), [true, true, true]);
});

test('thao tác bị áp rào = lớp irreversible + thao tác reversible khai confirm: always của danh mục chạy thật (server.mjs)', () => {
  assert.deepEqual([...CONSENT_CLASSES], ['irreversible']);
  const catalog = createActionCatalog([...EXPENSE_ACTIONS, ...TASK_ACTIONS, ...INVOICE_ACTIONS, ...CONTRACT_ACTIONS]);
  // PS-K03 (lô ps08 10/11): khoá tạm phòng lùi được nhưng có sàn xác nhận trong mã ⇒ lượt xác nhận cũng đòi lời đồng ý rõ.
  assert.deepEqual(catalog.ids.filter(id => consentRequired(catalog.get(id))).sort(),
    ['contract.renew', 'contract.renew_batch', 'contract.return', 'contract.room_lock', 'expense.cancel', 'invoice.adjustment_check', 'task.cancel']);
  // Huỷ hoá đơn (money) khôi phục được bằng invoice.restore ⇒ không thuộc rào; bỏ khoá tạm (reversible, không sàn) cũng không.
  assert.equal(consentRequired(catalog.get('invoice.cancel')), false);
  assert.equal(consentRequired(catalog.get('contract.room_unlock')), false);
  assert.equal(consentRequired(null), false);
  // confirm: 'always' chỉ tính cho lớp reversible (defineAction không nhận cho lớp khác); money có khai cũng không vào rào.
  assert.equal(consentRequired({ class: 'money', confirm: 'always' }), false);
  // Câu yêu cầu ban đầu của hai bản ghi sai (PS-K03, PS-D05) và câu chọn mức / nêu lý do: không phải lời đồng ý ở cả luật cũ lẫn rào câu đáp
  // của chính thao tác đó.
  for (const [text, rule] of [['Giữ phòng 303 toà 44TL 8 tiếng cho khách xem nha em', ROOM_LOCK_CONSENT], ['12 tiếng đi em', ROOM_LOCK_CONSENT],
    ['Ngưng chương trình ưu đãi phòng 105 toà 1392QT giúp anh', POLICY_CANCEL_CONSENT], ['khách chê giá cao, anh đổi chương trình khác', POLICY_CANCEL_CONSENT]]) {
    assert.equal(consentClear(text), false, text);
    assert.equal(rule.clear(text), false, text);
  }
});

// B1 (review #416): lời đáp tự nhiên cho "anh đồng ý giữ / dừng không?" phải qua, không thì bot hỏi vòng và bị đẩy tới chỗ tự viết "ok".
// Note 1: câu ra lệnh MỞ ĐẦU bằng lời đồng ý ("Ok em, giữ phòng 303 … 8 tiếng nhé") không được là lời đồng ý của chính bản xem trước nó sinh ra.
// Luật câu đáp thuần: mọi chữ thuộc bộ từ đồng ý / xưng hô / trợ từ / cảm ơn / động từ của thao tác; có số, "phòng", tên, lý do… ⇒ không.
const LOCK_YES = Object.freeze(['ok', 'Ok em', 'OK.', 'oke', 'okay', 'yes', 'đồng ý', 'Đồng ý', 'anh đồng ý', 'xác nhận', 'đúng rồi', 'ừ', 'Ừm', 'uh',
  'vâng', 'dạ vâng ạ', 'Được', 'được rồi', 'ok rồi', 'chốt', 'chốt đi', 'ghi đi', 'làm luôn', 'ừ giữ đi', 'Ừ, giữ đi em', 'giữ đi em', 'giữ đi', 'giữ luôn',
  'giữ luôn nha', 'giữ lại đi', 'giữ giúp anh', 'giữ ngay đi', 'ok giữ đi', 'ok, giữ giúp anh nhé', 'đồng ý giữ', 'khoá đi', 'khóa luôn nha', 'khoá lại giúp em',
  'đc', 'dc em', 'Đc a', 'dạ, ok em', 'à ok', 'em ơi giữ đi', 'ok cảm ơn em', 'Ừ, giữ đi. Cảm ơn em', 'giu di em', 'ok giu luon', 'dong y', '👍', '👌 giữ đi',
  'Ok em,\ngiữ đi']);
const LOCK_NO = Object.freeze(['', ' ', '...', 'ok?', 'giữ hả?',
  // Câu ra lệnh / chọn mức (PS-K03 và Note 1): có "phòng", số, tên toà, "tiếng" + số.
  'Giữ phòng 303 toà 44TL 8 tiếng cho khách xem nha em', 'Ok em, giữ phòng 303 toà 44TL 8 tiếng nhé', 'Ok em, giữ phòng 303 toà 44TL 12 tiếng nhé',
  'ok giữ phòng 303', 'giữ phòng đi', '12 tiếng đi em', 'ok 12 tiếng', 'ok giữ 12h', 'ừ 12 tiếng', 'ok giữ tới 8h tối nha', 'ok, khách tới lúc 5h',
  // Chưa đồng ý / hỏi lại / khác ý.
  'không giữ', 'khong giu', 'ko', 'khoan đã', 'khoan', 'chờ chút', 'thôi', 'thôi khỏi giữ', 'khỏi giữ', 'đừng giữ', 'chưa', 'chưa giữ', 'để anh hỏi khách',
  'ok để mai', 'giữ à', 'ok à', 'giữ chi', 'giữ làm gì', 'giữ rồi', 'đổi giờ', 'sai phòng',
  // Động từ của thao tác KHÁC: với khoá phòng, "dừng" là chưa đồng ý, "huỷ đi" là huỷ, "trả phòng đi" không liên quan.
  'dừng luôn', 'ok dừng đi', 'huỷ đi', 'trả phòng đi',
  // Không có lời đồng ý: chỉ xưng hô / trợ từ / cảm ơn.
  'cảm ơn em', 'đi', 'luôn', 'anh ơi', 'rồi',
  'ok '.repeat(101)]);
const STOP_YES = Object.freeze(['ok', 'Ok em', 'đồng ý', 'đồng ý dừng', 'Đồng ý dừng nhé', 'ok dừng đi', 'ok, dừng giúp anh', 'ừ dừng đi em', 'dừng luôn',
  'dừng đi', 'Dừng luôn đi em', 'ừ ngưng đi', 'ngưng luôn nha', 'ngừng đi', 'vâng, dừng giúp anh', 'tắt đi em', 'tat di', 'kết thúc đi', 'ok ghi', 'đồng ý ghi',
  'đc', 'dc em', 'được rồi', 'dạ, ok em', 'ok cảm ơn em', '👍', 'Ok em,\nngưng đi']);
const STOP_NO = Object.freeze(['', 'dừng hả?', 'ok?',
  // Câu ra lệnh (PS-D05 và Note 1): có "chương trình", "ưu đãi", "phòng", số, tên toà; câu nêu lý do.
  'Ngưng chương trình ưu đãi phòng 105 toà 1392QT giúp anh', 'Vâng, ngưng chương trình ưu đãi phòng 105 giúp anh', 'Ok em, dừng chương trình ưu đãi phòng 105 nhé',
  'ok dừng chương trình đó đi', 'dừng ưu đãi đi', 'khách chê giá cao, anh đổi chương trình khác', 'khách chê giá cao', 'ok, khách chê giá cao',
  // Chưa đồng ý / hỏi lại / mơ hồ.
  'không dừng nữa', 'thôi đừng dừng', 'đừng dừng', 'khoan đã', 'chưa dừng', 'thôi', 'thôi dừng đi', 'không', 'ko dừng', 'k',
  'dừng lại', 'dừng rồi', 'dừng hả', 'dừng à', 'dung di', 'dung luon', 'huy luon', 'huỷ luôn', 'hủy đi', 'Huỷ', 'để anh xem lại', 'ok để mai',
  // Động từ của thao tác KHÁC.
  'giữ đi', 'ừ giữ đi', 'khoá đi', 'trả phòng đi']);

test('B1 + Note 1 — rào câu đáp của khoá tạm phòng: lời đáp tự nhiên qua; câu ra lệnh (kể cả mở đầu bằng "ok"), câu chọn mức, câu chưa đồng ý thì không', () => {
  for (const text of LOCK_YES) assert.equal(ROOM_LOCK_CONSENT.clear(text), true, JSON.stringify(text));
  for (const text of LOCK_NO) assert.equal(ROOM_LOCK_CONSENT.clear(text), false, JSON.stringify(text));
  for (const value of [undefined, null, 42, {}, ['ok'], true]) assert.equal(ROOM_LOCK_CONSENT.clear(value), false, String(value));
  assert.equal(ROOM_LOCK_CONSENT.clear('ok'.padEnd(CONSENT_TEXT_MAX, ' ')), true, 'đúng trần');
  assert.equal(ROOM_LOCK_CONSENT.clear('ok'.padEnd(CONSENT_TEXT_MAX + 1, ' ')), false, 'quá trần');
  assert.equal(ROOM_LOCK_CONSENT.detail, 'Chưa thấy lời đồng ý rõ cho bản xem trước này. Lời đồng ý là câu người dùng ĐÁP sau khi xem, chỉ gồm lời đồng ý ' +
    '(vd "ok", "đồng ý", "ừ giữ đi"); câu nêu lại phòng, toà, số giờ, chương trình hay lý do — kể cả câu yêu cầu ban đầu — và câu chỉ chọn giá trị ' +
    'chưa phải đồng ý. Hỏi lại người dùng có đồng ý không; không tự viết câu đồng ý thay họ.');
});

test('B1 + Note 1 — rào câu đáp của dừng chương trình: "đồng ý dừng", "ừ dừng đi", "dừng luôn" qua; "đừng", "không dừng", câu ra lệnh / nêu lý do thì không', () => {
  for (const text of STOP_YES) assert.equal(POLICY_CANCEL_CONSENT.clear(text), true, JSON.stringify(text));
  for (const text of STOP_NO) assert.equal(POLICY_CANCEL_CONSENT.clear(text), false, JSON.stringify(text));
  assert.match(POLICY_CANCEL_CONSENT.detail, /\(vd "ok", "đồng ý dừng", "ừ dừng đi"\)/);
  // Mỗi rào chỉ gỡ "dừng" cho đúng thao tác dừng: luật cũ và rào khoá phòng vẫn coi nó là chưa đồng ý.
  for (const text of ['ok dừng đi', 'dừng luôn', 'đồng ý dừng']) {
    assert.equal(POLICY_CANCEL_CONSENT.clear(text), true, text);
    assert.equal(ROOM_LOCK_CONSENT.clear(text), false, text);
    assert.equal(consentClear(text), false, text);
  }
});

test('Note 1 — câu ra lệnh mở đầu bằng lời đồng ý: rào câu đáp chặn, luật cũ của thao tác không lùi được thì KHÔNG (giới hạn đã ghi)', () => {
  for (const [text, rule] of [['Ok em, giữ phòng 303 toà 44TL 8 tiếng nhé', ROOM_LOCK_CONSENT], ['Vâng, ngưng chương trình ưu đãi phòng 105 giúp anh', POLICY_CANCEL_CONSENT],
    ['Ok, giữ phòng 303 toà 44TL 12 tiếng', ROOM_LOCK_CONSENT], ['Đồng ý, ngưng chương trình phòng 105', POLICY_CANCEL_CONSENT]]) {
    assert.equal(rule.clear(text), false, text);
    assert.equal(consentClear(text), true, `${text}: luật cũ nhận (vế đầu là "ok" / "vâng" / "đồng ý") — đúng như ghi ở đầu consent-guard.mjs`);
  }
});

test('câu đáp thuần không động từ riêng (thao tác reversible confirm: always khác) và khai báo động từ sai bị từ chối lúc nạp', () => {
  for (const text of ['ok', 'đồng ý', 'ừ', 'đc', 'vâng ạ', '👍']) assert.equal(PLAIN_REPLY_CONSENT.clear(text), true, text);
  for (const text of ['giữ đi', 'dừng luôn', 'huỷ đi', 'trả phòng đi', 'ok giữ đi', 'không', '12 tiếng']) assert.equal(PLAIN_REPLY_CONSENT.clear(text), false, text);
  assert.match(PLAIN_REPLY_CONSENT.detail, /\(vd "ok", "đồng ý"\)/);
  // Động từ trùng dấu hiệu chưa đồng ý không gỡ được (kể cả gõ không dấu trùng chữ đó), khai sai kiểu, ví dụ rỗng ⇒ không khởi động.
  for (const bad of [{ verbs: ['không'] }, { verbs: ['khong'] }, { verbs: ['dung'] }, { verbs: ['đừng giữ'] }, { verbs: ['thôi'] }, { verbs: ['chờ'] },
    { verbs: [''] }, { verbs: [42] }, { verbs: 'giữ' }, { verbs: ['giữ 12'] }, { examples: [] }, { examples: ['ok?'] }])
    assert.throws(() => replyConsent(bad), /invalid_reply_consent/, JSON.stringify(bad));
  // "dừng" có dấu khai làm động từ thì gỡ được (thao tác dừng chương trình); "đừng" vẫn chặn.
  const stop = replyConsent({ verbs: ['dừng'] });
  assert.deepEqual(['dừng đi', 'đừng dừng', 'dung di'].map(stop.clear), [true, false, false]);
});

test('bản ghi sổ audit: một dòng, không ký tự điều khiển, dãy số dài (SĐT, CCCD, số TK) bị che giữ 4 số cuối, ≤ 300 ký tự', () => {
  assert.equal(consentAuditText('Ok em,\nghi đi\t'), 'Ok em, ghi đi');
  assert.equal(consentAuditText('ok\u2028ghi'), 'ok ghi');
  assert.equal(consentAuditText('ok\u2029ghi'), 'ok ghi');
  assert.equal([...consentAuditText('đ'.repeat(400))].length, CONSENT_TEXT_MAX);
  // Note 5: câu đồng ý của thao tác không lùi được có thể kèm chi tiết khách — che dãy ≥ 9 chữ số (cho phép một dấu cách / chấm / gạch xen).
  for (const [text, audited] of [['Ok ghi đi, khách Lan 0901234567', 'Ok ghi đi, khách Lan ***4567'], ['ok, sđt 090 123 4567 nhé', 'ok, sđt ***4567 nhé'],
    ['ok +84 90.123.4567', 'ok ***4567'], ['ok, CCCD 001234567890', 'ok, CCCD ***7890'], ['ok stk 0123-456-789', 'ok stk ***6789'],
    ['ok 0901234567 và 0912345678', 'ok ***4567 và ***5678'], ['ok 150000000', 'ok ***0000'], ['ok\n0901\n234\n567', 'ok ***4567'],
    ['ok 0912  345  678', 'ok ***5678'], ['ok 0912 - 345 - 678', 'ok ***5678']])
    assert.equal(consentAuditText(text), audited, text);
  // Số ngắn (phòng, giờ, tiền ≤ 8 chữ số, hai số cách nhau bởi dấu phẩy) giữ nguyên để lần lại.
  for (const text of ['ok phòng 303 toà 1392QT 12 tiếng', 'ok 3500000', 'ok 15000000', 'ok 3500000, 15000000', 'ok 12/11/2026']) assert.equal(consentAuditText(text), text);
  // Che TRƯỚC khi cắt (đường phòng thủ: câu đã qua rào ≤ 300 ký tự): SĐT vắt qua ký tự thứ 300 không để lại nửa dãy số chưa che.
  assert.equal(consentAuditText(`${'y'.repeat(292)} 0901234567`), `${'y'.repeat(292)} ***4567`);
  assert.doesNotMatch(consentAuditText(`${'y'.repeat(292)} 0901234567`), /\d{5}/);
});
