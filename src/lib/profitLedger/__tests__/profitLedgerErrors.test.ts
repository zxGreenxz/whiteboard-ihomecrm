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
  it('22023 ADVANCE_CONFIRM đọc số từ DETAIL', () => {
    const info = profitLedgerErrorMessage(err('22023', 'PROFIT_LEDGER_ADVANCE_CONFIRM: số tiền vượt số còn phải trả — phần vượt là tạm ứng lợi nhuận, cần xác nhận', '{"balance": 12345678, "within": 12345678, "advance": 1000}'), 'payout');
    expect(info).toMatchObject({ kind: 'ADVANCE_CONFIRM', code: 'PROFIT_LEDGER_ADVANCE_CONFIRM', sqlstate: '22023', reload: false });
    expect(info.detail).toEqual({ balance: 12345678, within: 12345678, advance: 1000 });
    expect(info.message).toContain('12.345.678');
    expect(info.message).toContain('1.000');
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
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xem lại — xác nhận số trước khi chi lợi nhuận', '{"count": 2, "suggested": 7}'), 'payout'))
      .toMatchObject({ kind: 'SALARY_REVIEW_PENDING', message: expect.stringContaining('2 phiếu lương') });
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_ROUTE_OFF: sổ tổng lợi nhuận đang tắt ở công ty này — chưa dùng được lệnh này', '{"route": "LEGACY", "allowed": ["CANONICAL"]}'), 'payout'))
      .toMatchObject({ kind: 'ROUTE_OFF', detail: { route: 'LEGACY', allowed: ['CANONICAL'] } });
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_FROZEN: sổ tổng lợi nhuận đang đóng băng — tạm dừng lập phiếu chi và đặt mốc (huỷ phiếu vẫn làm được)', '{"route":"FROZEN"}'), 'payout'))
      .toMatchObject({ kind: 'FROZEN' });
    expect(profitLedgerErrorMessage(err('55000', 'PROFIT_LEDGER_TYPE_NOT_FORCED: hạng mục "Chia lợi nhuận cổ đông" phải bật "Bắt buộc duyệt" mới lập được phiếu'), 'payout').kind).toBe('CONFIG');
    expect(profitLedgerErrorMessage(err('55000', 'Tổ chức chưa có toà ảo để hạch toán chia lợi nhuận'), 'payout').kind).toBe('CONFIG');
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
    expect(profitLedgerErrorMessage(err('40P01', 'deadlock detected'), 'payout').kind).toBe('BUSY');
    expect(profitLedgerErrorMessage(err('40001', 'could not serialize access'), 'marker').kind).toBe('BUSY');
  });
  it('42501: mã máy có câu riêng; câu tiếng Việt thô của máy chủ giữ nguyên', () => {
    expect(profitLedgerErrorMessage(err('42501', 'PROFIT_LEDGER_MAKER_SELF_APPROVE: x'), 'approve')).toMatchObject({ kind: 'FORBIDDEN', message: expect.stringMatching(/chủ khác duyệt/) });
    expect(profitLedgerErrorMessage(err('42501', 'PROFIT_LEDGER_ADVANCE_CASHBOOK: quyền tạm ứng chỉ chi từ sổ quỹ bạn đang giữ'), 'payout').message).toMatch(/sổ quỹ bạn đang giữ/);
    expect(profitLedgerErrorMessage(err('42501', 'Không có quyền chi lợi nhuận cổ đông'), 'payout')).toMatchObject({ kind: 'FORBIDDEN', message: 'Không có quyền chi lợi nhuận cổ đông' });
    expect(profitLedgerErrorMessage(err('42501', 'permission denied for function shareholder_profit_ledger_v1'), 'read').message).not.toMatch(/function|shareholder_profit/);
  });
  it('23505 ⇒ khoá dùng lại khác nội dung', () => {
    expect(profitLedgerErrorMessage(err('23505', 'idempotency_key đã dùng với nội dung khác'), 'payout').kind).toBe('KEY_REUSED');
    expect(profitLedgerErrorMessage(err('23505', 'PROFIT_LEDGER_IDEMPOTENCY_REUSED: khoá chống gửi trùng đã dùng cho lệnh huỷ khác nội dung'), 'cancel').kind).toBe('KEY_REUSED');
  });
  it('lượt đối chiếu chứng minh lần trước đã ghi ⇒ PRIOR_WRITTEN, không khoá', () => {
    const info = profitLedgerErrorMessage(new ProfitLedgerPriorWrittenError('payout'), 'payout');
    expect(info).toMatchObject({ kind: 'PRIOR_WRITTEN', reload: true });
    expect(info.message).toMatch(/^Yêu cầu trước đó đã được ghi; tải lại để xem\./);
  });
  it('mất mạng: ghi ⇒ chưa rõ kết quả; đọc ⇒ báo mất kết nối', () => {
    const net = { code: '', message: 'FetchError: Failed to fetch', details: '', hint: '' };
    expect(profitLedgerErrorMessage(net, 'payout').kind).toBe('UNKNOWN_OUTCOME');
    expect(profitLedgerErrorMessage(net, 'read').kind).toBe('OTHER');
    expect(profitLedgerErrorMessage(new FinancialWorkflowError('Chưa xác nhận…', 'unknown', []), 'cancel').kind).toBe('UNKNOWN_OUTCOME');
    expect(profitLedgerErrorMessage(new ProfitLedgerPayloadError('E5.amount'), 'payout').kind).toBe('UNKNOWN_OUTCOME');
    expect(profitLedgerErrorMessage(new ProfitLedgerPayloadError('E1.balance'), 'read').kind).toBe('SYSTEM');
  });
  it('lỗi đã chắc chắn bọc trong luồng ⇒ phân loại theo lỗi gốc', () => {
    const wrapped = new FinancialWorkflowError('x', 'failure', [], err('55000', 'PROFIT_LEDGER_FROZEN: y'));
    expect(profitLedgerErrorMessage(wrapped, 'payout').kind).toBe('FROZEN');
  });
  it('XX000 sổ lệch ⇒ lỗi hệ thống', () => {
    expect(profitLedgerErrorMessage(err('XX000', 'PROFIT_LEDGER_ENTRIES_DRIFT: các dòng sổ chi tiết không cộng ra đúng số dư sổ tổng — báo bộ phận kỹ thuật'), 'read').kind).toBe('SYSTEM');
  });
  it.each<[ProfitLedgerOperation, ReturnType<typeof err>]>([
    ['payout', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: x', '{"route":"SHADOW"}')],
    ['marker', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: x')],
    ['resolve', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: sổ tổng lợi nhuận chưa bật cho công ty này')],
    ['approve', err('55000', 'PROFIT_LEDGER_ROUTE_OFF: x')],
    ['payout', err('22023', 'PROFIT_LEDGER_ADVANCE_CONFIRM: x')],
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

describe('isLedgerIdempotencyConflict — đúng câu 23505 "khoá đã dùng" của từng lệnh', () => {
  const E5_E9 = 'idempotency_key đã dùng với nội dung khác';
  const E6 = 'PROFIT_LEDGER_IDEMPOTENCY_REUSED: khoá chống gửi trùng đã dùng cho lệnh huỷ khác nội dung';
  const E16 = 'SALARY_PROFIT_IDEMPOTENCY_CONFLICT: khoá idempotency đã dùng với nội dung khác';
  it.each([
    ['payout', E5_E9], ['marker', E5_E9], ['cancel', E6], ['resolve', E16],
  ] as const)('%s nhận câu của chính nó', (op, message) => {
    expect(isLedgerIdempotencyConflict(err('23505', message), op)).toBe(true);
  });
  it.each([
    ['payout', E6], ['payout', E16], ['marker', E6], ['cancel', E5_E9], ['cancel', E16], ['resolve', E5_E9], ['resolve', E6],
  ] as const)('%s không nhận câu của lệnh khác (%s)', (op, message) => {
    expect(isLedgerIdempotencyConflict(err('23505', message), op)).toBe(false);
  });
  it('23505 khác, hay đúng câu mà khác SQLSTATE ⇒ không phải', () => {
    expect(isLedgerIdempotencyConflict(err('23505', 'duplicate key value violates unique constraint "income_expenses_code_key"'), 'payout')).toBe(false);
    expect(isLedgerIdempotencyConflict(err('23505', `${E5_E9} (x)`), 'payout')).toBe(false);
    expect(isLedgerIdempotencyConflict(err('P0001', E5_E9), 'payout')).toBe(false);
    expect(isLedgerIdempotencyConflict(err('22023', 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'), 'payout')).toBe(false);
    expect(isLedgerIdempotencyConflict(new Error(E5_E9), 'payout')).toBe(false);
  });
});
