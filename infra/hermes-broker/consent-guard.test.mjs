import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSENT_CLASSES, CONSENT_TEXT_MAX, consentAuditText, consentClear, consentRequired } from './consent-guard.mjs';
import { createActionCatalog } from './action-catalog.mjs';
import { CONTRACT_ACTIONS } from './contract-action-contract.mjs';
import { EXPENSE_ACTIONS } from './expense-actions-contract.mjs';
import { INVOICE_ACTIONS } from './invoice-actions-contract.mjs';
import { TASK_ACTIONS } from './task-actions-contract.mjs';

// Rào đồng ý ở máy chủ (lượt 12 Hợp đồng, nghiệm thu 24/10 — ghi sai thật lần 3 với contract.return). Bộ câu dưới là phép đo của rào chữ:
// mỗi đột biến của luật (khớp chuỗi con, bỏ dấu hiệu chưa đồng ý, bỏ luật đầu vế, bỏ dấu khi so) phải làm ít nhất một câu đổi kết quả.
export const CONSENT_YES = Object.freeze(['ok', 'Ok em', 'OK.', 'oke', 'okie', 'okay', 'Đồng ý', 'anh đồng ý', 'Xác nhận', 'xác nhận trả phòng', 'ừ', 'Ừm', 'uh', 'ờ',
  'Được', 'được rồi em', 'Đúng rồi', 'chốt', 'chốt đi', 'Ghi đi', 'làm đi em', 'trả phòng đi', 'Hủy đi', 'huỷ đi', 'yes', 'Có', 'Có, khách trả chìa rồi',
  'dong y', 'ghi di', 'xac nhan', 'duoc roi', 'Trả sớm, quyết toán sau. Ok ghi đi', 'ok, ghi cho anh', 'dạ vâng ạ', 'em ơi ghi đi', '👍', 'Ok em,\nghi đi']);
export const CONSENT_NO = Object.freeze(['', '   ',
  // Câu của sự cố 24/10: chỉ bổ sung chi tiết.
  'Trả sớm, quyết toán sau, khách đã trả chìa rồi',
  'ok nhưng khoan đã', 'khoan', 'chờ chút', 'cho xiu', 'không', 'ko', 'k ghi', 'chưa', 'sai rồi', 'nhầm phòng', 'sửa lại ngày', 'đổi ngày 13', 'đừng ghi', 'thôi', 'đợi anh hỏi khách',
  'ok?', 'được không', 'ok, mà phí bao nhiêu？', '👍 khoan',
  // Đồng ý / có / được / chốt nằm GIỮA câu chi tiết hay không hết vế.
  'khách đồng ý trả sớm', 'khách có trả chìa', 'khách đã xác nhận', 'chốt quyết toán sau', 'được hoàn cọc rồi', 'trả sớm nhé ok', 'Người dùng đồng ý',
  // Có dấu thì dấu phải khớp: cô ≠ có, đừng ≠ đúng (gõ không dấu "dung roi" là mơ hồ ⇒ hỏi lại); không dấu: co / o là chữ khác.
  'cô Lan trả phòng rồi', 'co Lan tra phong roi', 'o phong 302', 'dung roi',
  // Ranh giới từ: không khớp chuỗi con.
  'book', 'okela', 'cokhi', 'yesterday',
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

test('thao tác bị áp rào = đúng lớp irreversible của danh mục chạy thật (server.mjs)', () => {
  assert.deepEqual([...CONSENT_CLASSES], ['irreversible']);
  const catalog = createActionCatalog([...EXPENSE_ACTIONS, ...TASK_ACTIONS, ...INVOICE_ACTIONS, ...CONTRACT_ACTIONS]);
  assert.deepEqual(catalog.ids.filter(id => consentRequired(catalog.get(id))).sort(),
    ['contract.renew', 'contract.renew_batch', 'contract.return', 'expense.cancel', 'invoice.adjustment_check', 'task.cancel']);
  // Huỷ hoá đơn (money) khôi phục được bằng invoice.restore ⇒ không thuộc rào.
  assert.equal(consentRequired(catalog.get('invoice.cancel')), false);
  assert.equal(consentRequired(null), false);
});

test('bản ghi sổ audit: một dòng, không ký tự điều khiển, ≤ 300 ký tự', () => {
  assert.equal(consentAuditText('Ok em,\nghi đi\t'), 'Ok em, ghi đi');
  assert.equal(consentAuditText('ok ghi'), 'ok ghi');
  assert.equal([...consentAuditText('đ'.repeat(400))].length, CONSENT_TEXT_MAX);
});
