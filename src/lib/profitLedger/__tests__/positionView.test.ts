// Chữ và số cho hai con số của cổ đông: "Lợi nhuận chưa chi" · "Tạm ứng đang có". Dữ liệu GIẢ.
import { describe, expect, it } from 'vitest';
import type { ShareholderPosition } from '../positionReaders';
import {
  advanceOverUnpaid, advancePendingText, isUnpaidNegative, settleMonthLabel, settlementCashLabel, settlementCashPendingText,
  settlementVoidable, shouldRemindMarkerFirst, summarizePositions,
} from '../positionView';
import { cancelTargetFromSettlement } from '../vouchers';

const position = (over: Partial<ShareholderPosition> = {}): ShareholderPosition => ({
  unpaid_profit: 100, advance_outstanding: 40, advance_pending: 5, settlement_cash_pending: 0, balance: 55,
  settled: { recognized: 0, offset: 0, cash: 0 }, last_settled_through_month: null, marker_month: null,
  needs_review: { count: 0, suggested: 0 },
  components: { allocated: 100, payouts_pending: 5, payouts_approved: 40, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 100, advance_outstanding_raw: 40, advance_overoffset: 0 },
  ...over,
});
const plain = (n: number) => String(n);

describe('positionView — dòng phụ và tổng', () => {
  it('"chờ duyệt" / "đang chờ chi" chỉ hiện khi khác 0', () => {
    expect(advancePendingText(position(), plain)).toBe('chờ duyệt 5');
    expect(advancePendingText(position({ advance_pending: 0 }), plain)).toBeNull();
    expect(settlementCashPendingText(position({ settlement_cash_pending: 60 }), plain)).toBe('đang chờ chi 60');
    expect(settlementCashPendingText(position(), plain)).toBeNull();
  });
  it('tổng: lợi nhuận chưa chi giữ dấu (âm trừ vào tổng), đếm đúng người còn chưa chi / đang có tạm ứng, báo có người âm', () => {
    const sum = summarizePositions([
      position(),
      position({ unpaid_profit: -20, advance_outstanding: 0, advance_pending: 0, balance: -20 }),
      position({ unpaid_profit: 0, advance_outstanding: 0, advance_pending: 0, settlement_cash_pending: 60, balance: 0 }),
    ]);
    expect(sum).toEqual({ unpaid: 80, advance: 40, advancePending: 5, cashPending: 60, unpaidCount: 1, advanceCount: 1, hasNegativeUnpaid: true });
    expect(summarizePositions([])).toMatchObject({ unpaid: 0, advance: 0, hasNegativeUnpaid: false });
  });
  it('âm thật mới là âm (sai số đồng lẻ không tính)', () => {
    expect(isUnpaidNegative(position({ unpaid_profit: -0.001 }))).toBe(false);
    expect(isUnpaidNegative(position({ unpaid_profit: -1 }))).toBe(true);
    expect(isUnpaidNegative(position({ unpaid_profit: 0 }))).toBe(false);
  });
});

describe('positionView — ứng vượt lợi nhuận chưa chi (chỉ để cảnh báo)', () => {
  it('tổng tạm ứng (đang có + chờ duyệt sau phiếu) vượt lợi nhuận chưa chi bao nhiêu', () => {
    expect(advanceOverUnpaid(position(), 60)).toBe(0); // 40 + 60 = 100, vừa đủ
    expect(advanceOverUnpaid(position(), 80)).toBe(20);
    expect(advanceOverUnpaid(position(), 10)).toBe(0);
  });
  it('lợi nhuận chưa chi âm: mọi khoản ứng đều là vượt (không cộng phần âm vào số vượt)', () => {
    expect(advanceOverUnpaid(position({ unpaid_profit: -20, advance_outstanding: 0 }), 30)).toBe(30);
  });
});

describe('positionView — lần chốt', () => {
  const noCash = { cash_voucher_id: null, cash_voucher_code: null, cash_voucher_status: null, cash_voucher_posting_status: null, cash_amount: 0 };
  const withCash = (status: string, posting: string | null) => ({ cash_voucher_id: 'v1', cash_voucher_code: 'PC-1', cash_voucher_status: status, cash_voucher_posting_status: posting, cash_amount: 60 });
  it('trạng thái phần tiền nói bằng tiếng Việt, không lộ mã', () => {
    expect(settlementCashLabel(noCash)).toBe('Không ra tiền');
    expect(settlementCashLabel(withCash('UNAPPROVED', 'UNPOSTED'))).toBe('Phiếu chi chờ duyệt');
    expect(settlementCashLabel(withCash('APPROVED', 'UNPOSTED'))).toBe('Đã duyệt, chưa chi tiền');
    expect(settlementCashLabel(withCash('APPROVED', 'POSTED'))).toBe('Đã chi tiền');
    expect(settlementCashLabel(withCash('TRANG_THAI_LA', null))).toBe('Phiếu chi đang xử lý');
  });
  it('chỉ lần chốt KHÔNG có phiếu tiền mới "Huỷ chốt"; có phiếu thì dựng mục tiêu huỷ PHIẾU', () => {
    expect(settlementVoidable(noCash)).toBe(true);
    expect(settlementVoidable(withCash('UNAPPROVED', 'UNPOSTED'))).toBe(false);
    const context = { organizationId: 'org-a', subjectName: 'Cổ đông 1' };
    expect(cancelTargetFromSettlement(noCash, context)).toBeNull();
    expect(cancelTargetFromSettlement(withCash('APPROVED', 'POSTED'), context)).toEqual({
      voucherId: 'v1', organizationId: 'org-a', kind: 'SHAREHOLDER', code: 'PC-1', amount: 60,
      approvalStatus: 'APPROVED', postingStatus: 'POSTED', subjectName: 'Cổ đông 1', accountName: null,
    });
    // Phiếu đã đảo / trạng thái lạ: không đoán — không có nút huỷ.
    expect(cancelTargetFromSettlement(withCash('APPROVED', 'REVERSED'), context)).toBeNull();
    expect(cancelTargetFromSettlement(withCash('CANCELLED', null), context)).toBeNull();
  });
  it('nhắc đặt mốc trước: chỉ khi CHƯA có mốc VÀ chưa có lần chốt nào', () => {
    expect(shouldRemindMarkerFirst({ marker_month: null, settlements: [] })).toBe(true);
    expect(shouldRemindMarkerFirst({ marker_month: '2026-08-01', settlements: [] })).toBe(false);
    expect(shouldRemindMarkerFirst({ marker_month: null, settlements: [{}] })).toBe(false);
  });
  it('nhãn tháng MM/YYYY; chuỗi lạ giữ nguyên', () => {
    expect(settleMonthLabel('2026-10-01')).toBe('10/2026');
    expect(settleMonthLabel('thang-la')).toBe('thang-la');
  });
});
