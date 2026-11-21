// Dịch lỗi sổ tổng: rẽ theo SQLSTATE + mã máy đầu MESSAGE + DETAIL JSON — KHÔNG theo HTTP.
import { describe, expect, it } from 'vitest';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import {
  isLedgerIdempotencyConflict, isProfitLedgerForbidden, profitLedgerErrorMessage, ProfitLedgerPriorWrittenError,
  type ProfitLedgerOperation,
} from '../errors';
import { ProfitLedgerPayloadError } from '../readPrimitives';

const err = (code: string, message: string, details: unknown = null) => ({ code, message, details, hint: null });

describe('profitLedgerErrorMessage', () => {
  it('mã của lệnh chi cũ (web không còn gọi) không có câu riêng ⇒ theo SQLSTATE, giữ câu tiếng Việt của máy chủ + DETAIL', () => {
    // 18/11/2026: hộp tạm ứng không còn ô "xác nhận tạm ứng" — ứng vượt chỉ cảnh báo. Mã này chỉ còn ở lệnh cũ.
    const info = profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_ADVANCE_CONFIRM: số tiền vượt số còn phải trả — phần vượt là tạm ứng lợi nhuận, cần xác nhận', '{"balance": 12345678, "within": 12345678, "advance": 1000}'), 'advance');
    expect(info).toMatchObject({ kind: 'VALIDATION', code: 'PROFIT_LEDGER_ADVANCE_CONFIRM', sqlstate: '22023', reload: false });
    expect(info.detail).toEqual({ balance: 12345678, within: 12345678, advance: 1000 });
    expect(info.message).toBe('Số tiền vượt số còn phải trả — phần vượt là tạm ứng lợi nhuận, cần xác nhận');
  });
  it('22023 ba loại: tạm ứng, vượt lương điều hành, mốc xoá tạm ứng', () => {
    expect(profitLedgerErrorMessage(err('22023', 'PROFIT_MANAGER_LEDGER_OVERDRAW: số tiền vượt lương điều hành còn lại — không chi quá, không tạm ứng', '{"over":1000,"amount":2001000,"balance":2000000}'), 'manager_payout'))
      .toMatchObject({ kind: 'MANAGER_OVERDRAW', message: expect.stringContaining('2.000.000') });
    expect(profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_MARKER_ERASES_ADVANCE: mốc này xoá dấu một khoản tạm ứng — cần xác nhận riêng', '{"advance_erased": 5000, "balance_now": -5000, "balance_after": 0}'), 'marker'))
      .toMatchObject({ kind: 'MARKER_ERASES_ADVANCE', message: expect.stringContaining('5.000') });
    expect(profitLedgerErrorMessage(err('22023', 'SALARY_PROFIT_SETTLED_BY_MARKER: kỳ lương nằm trong mốc "đã trả đủ", không trả lại phần đầu tư qua lương', '{"marker_through": "2026-09-01"}'), 'salary_quote'))
      .toMatchObject({ kind: 'SALARY_SETTLED_BY_MARKER', message: expect.stringContaining('09/2026') });
  });
  it('55000 bốn loại: phiếu lương chờ xem lại, route tắt, đóng băng, cài đặt', () => {
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xem lại — xác nhận số trước khi chi lợi nhuận', '{"count": 2, "suggested": 7}'), 'settle'))
      .toMatchObject({ kind: 'SALARY_REVIEW_PENDING', message: expect.stringContaining('2 phiếu lương') });
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_ROUTE_OFF: sổ tổng lợi nhuận đang tắt ở công ty này — chưa dùng được lệnh này', '{"route": "LEGACY", "allowed": ["CANONICAL"]}'), 'settle'))
      .toMatchObject({ kind: 'ROUTE_OFF', detail: { route: 'LEGACY', allowed: ['CANONICAL'] } });
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_FROZEN: sổ tổng lợi nhuận đang đóng băng — tạm dừng lập phiếu chi và đặt mốc (huỷ phiếu vẫn làm được)', '{"route":"FROZEN"}'), 'settle'))
      .toMatchObject({ kind: 'FROZEN' });
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_TYPE_NOT_FORCED: hạng mục "Chia lợi nhuận cổ đông" phải bật "Bắt buộc duyệt" mới lập được phiếu'), 'settle').kind).toBe('CONFIG');
    expect(profitLedgerErrorMessage(err('55000', 'Tổ chức chưa có toà ảo để hạch toán chia lợi nhuận'), 'settle').kind).toBe('CONFIG');
  });
  it('55000 phiếu sổ tổng đã khoá (chặn sửa / huỷ duyệt / hoàn tác…)', () => {
    for (const code of ['PROFIT_LEDGER_CANCEL_ONLY', 'PROFIT_LEDGER_LOCKED', 'PROFIT_LEDGER_ACCOUNT_LOCKED', 'PROFIT_LEDGER_V2_ONLY', 'PROFIT_LEDGER_VOUCHER_DEAD']) {
      expect(profitLedgerErrorMessage(err('55000', `${code}: x`), 'approve').kind, code).toBe('LEDGER_LOCKED');
    }
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_CANCEL_ONLY: muốn bỏ phiếu thì dùng Huỷ có lý do'), 'cancel').message).toMatch(/Huỷ/);
  });
  it('PT409: mốc đổi, trạng thái phiếu đổi, báo giá lương đổi ⇒ tải lại', () => {
    expect(profitLedgerErrorMessage(err('PT409', 'PROFIT_LEDGER_MARKER_CHANGED: mốc vừa được người khác đổi — tải lại rồi xem trước lần nữa', '{"current_marker_id":"m2","expected_marker_id":null}'), 'marker'))
      .toMatchObject({ kind: 'MARKER_CONFLICT', reload: true, detail: { current_marker_id: 'm2' } });
    expect(profitLedgerErrorMessage(err('PT409', 'PROFIT_LEDGER_CANCEL_STATE_CHANGED: phiếu vừa đổi trạng thái (lúc mở: PENDING, bây giờ: APPROVED_UNPOSTED) — tải lại phiếu rồi mới quyết định huỷ', '{"expected":"PENDING","actual":"APPROVED_UNPOSTED"}'), 'cancel'))
      .toMatchObject({ kind: 'CANCEL_STATE_CHANGED', reload: true, message: expect.stringContaining('đã duyệt, chưa chi tiền') });
    expect(profitLedgerErrorMessage(err('PT409', 'SALARY_PROFIT_QUOTE_CHANGED: phần lợi nhuận / trừ tạm ứng của tháng đã đổi, tải lại bảng lương', '{"investment_month":40}'), 'salary_quote'))
      .toMatchObject({ kind: 'SALARY_QUOTE_CHANGED', reload: true });
  });
  it('40P01 / 40001 ⇒ hệ thống bận', () => {
    expect(profitLedgerErrorMessage(err('40P01', 'deadlock detected'), 'settle').kind).toBe('BUSY');
    expect(profitLedgerErrorMessage(err('40001', 'could not serialize access'), 'marker').kind).toBe('BUSY');
  });
  it('42501: mã máy có câu riêng; câu tiếng Việt thô của máy chủ giữ nguyên', () => {
    expect(profitLedgerErrorMessage(err('42501', 'PROFIT_LEDGER_MAKER_SELF_APPROVE: x'), 'approve')).toMatchObject({ kind: 'FORBIDDEN', message: expect.stringMatching(/người được chỉ định/) });
    expect(profitLedgerErrorMessage(err('42501', 'PROFIT_LEDGER_ADVANCE_CASHBOOK: quyền tạm ứng chỉ chi từ sổ quỹ bạn đang giữ'), 'advance').message).toMatch(/sổ quỹ bạn đang giữ/);
    expect(profitLedgerErrorMessage(err('42501', 'Không có quyền chi lợi nhuận cổ đông'), 'settle')).toMatchObject({ kind: 'FORBIDDEN', message: 'Không có quyền chi lợi nhuận cổ đông' });
    expect(profitLedgerErrorMessage(err('42501', 'permission denied for function shareholder_profit_ledger_v1'), 'read').message).not.toMatch(/function|shareholder_profit/);
  });
  it('23505 ⇒ khoá dùng lại khác nội dung', () => {
    expect(profitLedgerErrorMessage(err('23505', 'idempotency_key đã dùng với nội dung khác'), 'settle').kind).toBe('KEY_REUSED');
    expect(profitLedgerErrorMessage(err('23505', 'PROFIT_LEDGER_IDEMPOTENCY_REUSED: khoá chống gửi trùng đã dùng cho lệnh huỷ khác nội dung'), 'cancel').kind).toBe('KEY_REUSED');
  });
  it('lượt đối chiếu chứng minh lần trước đã ghi ⇒ PRIOR_WRITTEN, không khoá', () => {
    const info = profitLedgerErrorMessage(new ProfitLedgerPriorWrittenError('settle'), 'settle');
    expect(info).toMatchObject({ kind: 'PRIOR_WRITTEN', reload: true });
    expect(info.message).toMatch(/^Yêu cầu trước đó đã được ghi; tải lại để xem\./);
  });
  it('mất mạng: ghi ⇒ chưa rõ kết quả; đọc ⇒ báo mất kết nối', () => {
    const net = { code: '', message: 'FetchError: Failed to fetch', details: '', hint: '' };
    expect(profitLedgerErrorMessage(net, 'settle').kind).toBe('UNKNOWN_OUTCOME');
    expect(profitLedgerErrorMessage(net, 'read').kind).toBe('OTHER');
    expect(profitLedgerErrorMessage(new FinancialWorkflowError('Chưa xác nhận…', 'unknown', []), 'cancel').kind).toBe('UNKNOWN_OUTCOME');
    expect(profitLedgerErrorMessage(new ProfitLedgerPayloadError('E5.amount'), 'settle').kind).toBe('UNKNOWN_OUTCOME');
    expect(profitLedgerErrorMessage(new ProfitLedgerPayloadError('E1.balance'), 'read').kind).toBe('SYSTEM');
  });
  it('lỗi đã chắc chắn bọc trong luồng ⇒ phân loại theo lỗi gốc', () => {
    const wrapped = new FinancialWorkflowError('x', 'failure', [], err('55000', 'PROFIT_LEDGER_FROZEN: y'));
    expect(profitLedgerErrorMessage(wrapped, 'settle').kind).toBe('FROZEN');
  });
  it('XX000 sổ lệch ⇒ lỗi hệ thống', () => {
    expect(profitLedgerErrorMessage(err('XX000', 'PROFIT_LEDGER_ENTRIES_DRIFT: các dòng sổ chi tiết không cộng ra đúng số dư sổ tổng — báo bộ phận kỹ thuật'), 'read').kind).toBe('SYSTEM');
  });
  it.each<[ProfitLedgerOperation, ReturnType<typeof err>]>([
    ['settle', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: x', '{"route":"SHADOW"}')],
    ['marker', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: x')],
    ['resolve', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: sổ tổng lợi nhuận chưa bật cho công ty này')],
    ['approve', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: x')],
    ['advance', err('22023', 'PROFIT_LEDGER_ADVANCE_CONFIRM: x')],
    ['cancel', err('42501', 'PROFIT_LEDGER_CANCEL_CUSTODIAN: x', '{"account_id":"a1"}')],
  ])('câu cho người dùng không lộ tên kỹ thuật (%s)', (op, e) => {
    const { message } = profitLedgerErrorMessage(e, op);
    expect(message).not.toMatch(/PROFIT_LEDGER|route|SHADOW|LEGACY|CANONICAL|RPC|_v1|idempotency/);
    expect(message.length).toBeGreaterThan(10);
  });
  it('isProfitLedgerForbidden chỉ nhận 42501 PROFIT_LEDGER_FORBIDDEN', () => {
    expect(isProfitLedgerForbidden(err('42501', 'PROFIT_LEDGER_FORBIDDEN: bạn chưa xem được lợi nhuận của mình'))).toBe(true);
    expect(isProfitLedgerForbidden(err('42501', 'permission denied for function x'))).toBe(false);
    expect(isProfitLedgerForbidden(err('55000', 'PROFIT_LEDGER_SHAREHOLDER_AMBIGUOUS: x'))).toBe(false);
  });
});

describe('tạm ứng cổ đông + chốt chi lợi nhuận theo tháng (mã của migration 20261118041911)', () => {
  it('PT409 SETTLE_CHANGED ⇒ tải lại xem trước, không phải lỗi hệ thống', () => {
    const info = profitLedgerErrorMessage(err('PT409', 'PROFIT_LEDGER_SETTLE_CHANGED: số liệu vừa đổi so với lúc xem trước — tải lại rồi xem trước lần nữa', '{"cash_amount": 60.00, "expected_cash": 100, "through_month": "2026-10-01", "recognized_amount": 100.00, "expected_recognized": 100, "advance_offset_amount": 40.00}'), 'settle');
    expect(info).toMatchObject({ kind: 'SETTLE_CHANGED', code: 'PROFIT_LEDGER_SETTLE_CHANGED', sqlstate: 'PT409', reload: true });
    expect(info.message).toMatch(/Số liệu vừa đổi so với lúc xem trước/);
    expect(info.detail).toMatchObject({ expected_cash: 100, cash_amount: 60 });
  });
  it('22023 tháng không chốt được: nêu khoảng tháng chốt được từ DETAIL', () => {
    const info = profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là tháng đã chốt lợi nhuận của cổ đông, sau mốc "đã trả đủ" và không trước lần chốt chi gần nhất', '{"max": "2026-10-01", "min": "2026-09-01", "through_month": "2026-08-01"}'), 'settle');
    expect(info).toMatchObject({ kind: 'SETTLE_MONTH', reload: true });
    expect(info.message).toContain('từ 09/2026 đến 10/2026');
    expect(profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là ngày đầu tháng'), 'preview').kind).toBe('SETTLE_MONTH');
  });
  it('22023 không còn gì để chốt / thiếu sổ quỹ', () => {
    expect(profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_SETTLE_NOTHING: không còn lợi nhuận chưa chi đến hết tháng 10/2026 để chốt', '{"through_month": "2026-10-01", "unpaid_through": 0.00}'), 'settle'))
      .toMatchObject({ kind: 'SETTLE_NOTHING', reload: true, message: 'Không còn lợi nhuận chưa chi đến hết 10/2026 để chốt.' });
    expect(profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_SETTLE_ACCOUNT: lần chốt này có tiền thực chi — cần sổ quỹ và ngày chi', '{"cash_amount": 60.00}'), 'settle'))
      .toMatchObject({ kind: 'SETTLE_ACCOUNT', message: expect.stringMatching(/chọn sổ quỹ và ngày chi/) });
    expect(profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_SETTLE_EXPECTED: thiếu hoặc sai phần lợi nhuận ghi nhận đã xem trước'), 'settle')).toMatchObject({ kind: 'VALIDATION', reload: true });
  });
  it('55000 tự kiểm sau khi ghi không khớp ⇒ chưa chốt, tải lại', () => {
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_SETTLE_MISMATCH: x'), 'settle')).toMatchObject({ kind: 'STALE', reload: true, message: expect.stringMatching(/chưa chốt gì/) });
  });
  it('huỷ lần chốt: có phiếu tiền / đã huỷ từ trước / lý do sai độ dài', () => {
    expect(profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_SETTLE_HAS_VOUCHER: bản ghi chốt này có phiếu tiền — huỷ phiếu tiền bằng lệnh huỷ phiếu chi theo sổ tổng, bản ghi chốt tự hết hiệu lực', '{"cash_voucher_id": "v1"}'), 'settle_void'))
      .toMatchObject({ kind: 'VALIDATION', message: expect.stringMatching(/huỷ phiếu chi đó/) });
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_SETTLE_NOT_ACTIVE: bản ghi chốt này đã huỷ từ trước', '{"state": "VOID"}'), 'settle_void'))
      .toMatchObject({ kind: 'STALE', reload: true });
    expect(profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_BAD_REASON: x'), 'settle_void').message).toBe('Lý do phải từ 8 đến 1000 ký tự.');
  });
  it('đặt mốc sớm hơn tháng đã chốt chi: nêu tháng đã chốt', () => {
    const info = profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT: đã chốt chi lợi nhuận đến hết tháng 10/2026 — mốc "đã trả đủ" phải từ tháng đó trở đi, hoặc huỷ lần chốt đó trước', '{"settled_through_month": "2026-09-01", "last_settled_through_month": "2026-10-01"}'), 'marker');
    expect(info).toMatchObject({ kind: 'MARKER_BEFORE_SETTLEMENT', reload: false });
    expect(info.message).toContain('đến hết 10/2026');
    expect(info.message).toMatch(/huỷ lần chốt đó trước/);
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT: x'), 'marker').message).toMatch(/từ tháng đã chốt chi trở đi/);
  });
  it('lập tạm ứng: không giữ sổ, người nhận chưa có quyền, trùng tên hạng mục', () => {
    expect(profitLedgerErrorMessage(err('42501', 'PROFIT_LEDGER_ADVANCE_CASHBOOK: chỉ lập phiếu tạm ứng từ sổ quỹ bạn đang giữ'), 'advance'))
      .toMatchObject({ kind: 'FORBIDDEN', message: 'Chỉ lập phiếu tạm ứng từ sổ quỹ bạn đang giữ.' });
    expect(profitLedgerErrorMessage(err('42501', 'PROFIT_LEDGER_ADVANCE_PAYEE_NO_RIGHT: người nhận chưa được cấp quyền tạm ứng'), 'advance'))
      .toMatchObject({ kind: 'FORBIDDEN', message: expect.stringMatching(/chưa được cấp quyền tạm ứng/) });
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_TYPE_NAME_TAKEN: công ty đã có hạng mục chi tên "Tạm Ứng" dùng cho việc khác — đổi tên hạng mục đó rồi lập lại', '{"income_expense_type_id": "t1"}'), 'advance'))
      .toMatchObject({ kind: 'CONFIG', message: expect.stringMatching(/đổi tên hạng mục đó ở danh mục Thu chi/) });
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_TYPE_NOT_FORCED: x'), 'advance').message).toContain('"Tạm Ứng"');
  });
  it('còn phiếu lương cần xem lại: người lập hộ không nhận DETAIL ⇒ câu không kèm số phiếu, không bịa số', () => {
    const forPayee = profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xem lại — xác nhận số trước khi tạm ứng lợi nhuận'), 'advance');
    expect(forPayee).toMatchObject({ kind: 'SALARY_REVIEW_PENDING' });
    expect(forPayee.message).toBe('Cổ đông còn phiếu lương cần chủ xem lại phần lợi nhuận. Chủ công ty xác nhận phần lương trước rồi mới tạm ứng được.');
    expect(forPayee.detail).toBeUndefined();
    const self = profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xem lại — xác nhận số trước khi tạm ứng lợi nhuận', '{"count": 1, "suggested": 7.00}'), 'advance');
    expect(self.message).toContain('còn 1 phiếu lương');
  });
  it('XX000 lệch vị thế ⇒ lỗi hệ thống, không hiện số', () => {
    expect(profitLedgerErrorMessage(err('XX000', 'PROFIT_LEDGER_POSITION_DRIFT: lợi nhuận chưa chi và tạm ứng không cộng ra đúng số dư sổ tổng — báo bộ phận kỹ thuật', '{"balance": 1}'), 'read'))
      .toMatchObject({ kind: 'SYSTEM', message: expect.stringMatching(/không cộng ra đúng số dư sổ tổng/) });
  });
  it('42501 không mã (một câu cho "không có cổ đông" và "không thuộc công ty") giữ câu của máy chủ', () => {
    expect(profitLedgerErrorMessage(err('42501', 'Không có quyền lập phiếu tạm ứng cổ đông, hoặc không tìm thấy cổ đông trong tổ chức hợp lệ'), 'advance'))
      .toMatchObject({ kind: 'FORBIDDEN', message: 'Không có quyền lập phiếu tạm ứng cổ đông, hoặc không tìm thấy cổ đông trong tổ chức hợp lệ' });
    expect(profitLedgerErrorMessage(err('42501', 'Không có quyền chi lợi nhuận cổ đông, hoặc không tìm thấy bản ghi chốt'), 'settle_void').kind).toBe('FORBIDDEN');
  });
  it.each<[ProfitLedgerOperation, ReturnType<typeof err>]>([
    ['advance', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: x', '{"route":"SHADOW","allowed":["CANONICAL"]}')],
    ['settle', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: x')],
    ['settle', err('PT409', 'PROFIT_LEDGER_SETTLE_CHANGED: x')],
    ['settle', err('22023', 'PROFIT_LEDGER_SETTLE_MONTH: x')],
    ['settle_void', err('22023', 'PROFIT_LEDGER_SETTLE_HAS_VOUCHER: x', '{"cash_voucher_id":"v1"}')],
    ['marker', err('55000', 'PROFIT_LEDGER_MARKER_BEFORE_SETTLEMENT: x')],
    ['advance', err('55000', 'PROFIT_LEDGER_TYPE_NAME_TAKEN: x')],
    ['read', err('XX000', 'PROFIT_LEDGER_POSITION_DRIFT: x')],
  ])('câu cho người dùng không lộ tên kỹ thuật (%s)', (op, e) => {
    const { message } = profitLedgerErrorMessage(e, op);
    expect(message).not.toMatch(/PROFIT_LEDGER|route|SHADOW|LEGACY|CANONICAL|RPC|_v1|idempotency|rule_key/);
    expect(message.length).toBeGreaterThan(10);
  });
});

describe('isLedgerIdempotencyConflict — đúng câu 23505 "khoá đã dùng" của từng lệnh', () => {
  it.each(['advance', 'settle', 'settle_void'] as const)('%s (không mã máy) nhận câu của chính nó, không nhận câu của lệnh huỷ', (op) => {
    expect(isLedgerIdempotencyConflict(err('23505', 'idempotency_key đã dùng với nội dung khác'), op)).toBe(true);
    expect(isLedgerIdempotencyConflict(err('23505', 'PROFIT_LEDGER_IDEMPOTENCY_REUSED: khoá chống gửi trùng đã dùng cho lệnh huỷ khác nội dung'), op)).toBe(false);
    expect(isLedgerIdempotencyConflict(err('23505', 'duplicate key value violates unique constraint "profit_ledger_payout_settlements_seq_uq"'), op)).toBe(false);
  });
  const W_E9 = 'idempotency_key đã dùng với nội dung khác';
  const E6 = 'PROFIT_LEDGER_IDEMPOTENCY_REUSED: khoá chống gửi trùng đã dùng cho lệnh huỷ khác nội dung';
  const E16 = 'SALARY_PROFIT_IDEMPOTENCY_CONFLICT: khoá idempotency đã dùng với nội dung khác';
  it.each([
    ['advance', W_E9], ['settle', W_E9], ['settle_void', W_E9], ['marker', W_E9], ['cancel', E6], ['resolve', E16],
  ] as const)('%s nhận câu của chính nó', (op, message) => {
    expect(isLedgerIdempotencyConflict(err('23505', message), op)).toBe(true);
  });
  it.each([
    ['advance', E6], ['advance', E16], ['settle', E16], ['marker', E6], ['cancel', W_E9], ['cancel', E16], ['resolve', W_E9], ['resolve', E6],
  ] as const)('%s không nhận câu của lệnh khác (%s)', (op, message) => {
    expect(isLedgerIdempotencyConflict(err('23505', message), op)).toBe(false);
  });
  it('23505 khác, hay đúng câu mà khác SQLSTATE ⇒ không phải', () => {
    expect(isLedgerIdempotencyConflict(err('23505', 'duplicate key value violates unique constraint "income_expenses_code_key"'), 'advance')).toBe(false);
    expect(isLedgerIdempotencyConflict(err('23505', `${W_E9} (x)`), 'advance')).toBe(false);
    expect(isLedgerIdempotencyConflict(err('P0001', W_E9), 'settle')).toBe(false);
    expect(isLedgerIdempotencyConflict(err('22023', 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'), 'settle')).toBe(false);
    expect(isLedgerIdempotencyConflict(new Error(W_E9), 'advance')).toBe(false);
  });
});
