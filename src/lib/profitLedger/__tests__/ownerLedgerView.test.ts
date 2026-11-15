// Số và nhãn trang lợi nhuận của chủ dựng từ sổ tổng (D2.4–D2.6). Dữ liệu GIẢ, không phải số production.
import { describe, expect, it } from 'vitest';
import type { ManagerLedgerRow, ShareholderLedgerRow } from '../ledgerReaders';
import {
  canCancelLedgerEntry, cancelTargetFromManagerPayout, ledgerBalanceText, ledgerMonthLabel, managerPayBlock,
  markerText, ownerLedgerMode, previousYearMonth, shareholderPayBlock, summarizeShareholderLedger, voucherStateLabel,
} from '../ownerLedgerView';
import { profitLedgerRouteState } from '../route';

const row = (patch: Partial<ShareholderLedgerRow> = {}): ShareholderLedgerRow => ({
  shareholder_id: 's1', name: 'An', is_active: true, is_deleted: false, has_login: true, marker: null,
  allocated: 1000, payouts_approved: 300, payouts_pending: 100, salary_investment: 200, salary_advance_offset: 50,
  balance: 450, status: 'OWED', open_advance: 0, needs_review_count: 0,
  ...patch,
});

const manager = (patch: Partial<ManagerLedgerRow> = {}): ManagerLedgerRow => ({
  manager_id: 'm1', name: 'Quản lý', is_active: true, is_deleted: false, has_login: true, marker: null,
  allocated: 500, payouts_approved: 100, payouts_pending: 0, balance: 400, status: 'OWED',
  ...patch,
});

describe('ownerLedgerMode — số đầu trang theo công tắc sổ tổng', () => {
  const base = { organizationId: 'org', hasLedger: true, loading: false, forbidden: false };
  it('LEGACY (và chuỗi lạ) ⇒ giữ cách tính cũ', () => {
    expect(ownerLedgerMode({ ...base, route: 'LEGACY' })).toBe('LEGACY');
    expect(ownerLedgerMode({ ...base, route: 'CANARY' })).toBe('LEGACY');
  });
  it.each(['SHADOW', 'CANONICAL', 'FROZEN'])('%s ⇒ đọc sổ tổng', (route) => {
    expect(ownerLedgerMode({ ...base, route })).toBe('LEDGER');
  });
  it('chưa có công ty / không được xem sổ tổng ⇒ cách cũ; đang tải ⇒ chờ; lỗi khác ⇒ "—"', () => {
    expect(ownerLedgerMode({ ...base, organizationId: null, route: undefined, hasLedger: false })).toBe('LEGACY');
    expect(ownerLedgerMode({ ...base, route: undefined, hasLedger: false, forbidden: true })).toBe('LEGACY');
    expect(ownerLedgerMode({ ...base, route: undefined, hasLedger: false, loading: true })).toBe('PENDING');
    expect(ownerLedgerMode({ ...base, route: undefined, hasLedger: false })).toBe('ERROR');
  });
});

describe('summarizeShareholderLedger', () => {
  it('còn phải trả = Σ max(số dư, 0); tạm ứng = Σ open_advance; qua lương = Σ(Y − D)', () => {
    const sum = summarizeShareholderLedger([
      row(),
      row({ shareholder_id: 's2', balance: -300, status: 'ADVANCE', open_advance: 300, salary_investment: 0, salary_advance_offset: 0 }),
      row({ shareholder_id: 's3', balance: 0, status: 'SETTLED', salary_investment: 0, salary_advance_offset: 0 }),
    ]);
    expect(sum.owed).toBe(450);
    expect(sum.advance).toBe(300);
    expect(sum.viaSalary).toBe(150);
    expect(sum.approved).toBe(900);
    expect(sum.pending).toBe(300);
    expect(sum.owedCount).toBe(1);
    expect(sum.advanceCount).toBe(1);
  });
});

describe('nút Chi', () => {
  const canonical = profitLedgerRouteState('CANONICAL');
  it('chỉ chi được ở CANONICAL, cổ đông còn hiệu lực, không phiếu lương cần xem lại', () => {
    expect(shareholderPayBlock(row(), canonical)).toBeNull();
    expect(shareholderPayBlock(row(), profitLedgerRouteState('LEGACY'))).toMatch(/xem thử/);
    expect(shareholderPayBlock(row(), profitLedgerRouteState('SHADOW'))).toMatch(/chưa mở chi/);
    expect(shareholderPayBlock(row(), profitLedgerRouteState('FROZEN'))).toMatch(/đóng băng/);
    expect(shareholderPayBlock(row({ is_deleted: true }), canonical)).toMatch(/đã xoá/);
    expect(shareholderPayBlock(row({ is_active: false }), canonical)).toMatch(/ngưng/);
    expect(shareholderPayBlock(row({ needs_review_count: 2 }), canonical)).toMatch(/Còn 2 phiếu lương/);
  });
  it('lương điều hành: đóng băng / hết số còn lại / đã xoá ⇒ khoá; LEGACY vẫn chi', () => {
    expect(managerPayBlock(manager(), profitLedgerRouteState('LEGACY'))).toBeNull();
    expect(managerPayBlock(manager(), profitLedgerRouteState('FROZEN'))).toMatch(/đóng băng/);
    expect(managerPayBlock(manager({ balance: 0, status: 'SETTLED' }), profitLedgerRouteState('CANONICAL'))).toMatch(/Không còn/);
    expect(managerPayBlock(manager({ is_deleted: true }), profitLedgerRouteState('CANONICAL'))).toMatch(/đã xoá/);
  });
});

describe('huỷ phiếu', () => {
  it('người có quyền chi huỷ mọi phiếu; người lập chỉ tự huỷ phiếu còn chờ duyệt', () => {
    expect(canCancelLedgerEntry({ is_mine: false, voucher_status: 'APPROVED' }, true)).toBe(true);
    expect(canCancelLedgerEntry({ is_mine: true, voucher_status: 'UNAPPROVED' }, false)).toBe(true);
    expect(canCancelLedgerEntry({ is_mine: true, voucher_status: 'APPROVED' }, false)).toBe(false);
    expect(canCancelLedgerEntry({ is_mine: false, voucher_status: 'UNAPPROVED' }, false)).toBe(false);
  });
  it('phiếu lương điều hành: chỉ phiếu lập theo sổ tổng, trạng thái còn huỷ được', () => {
    const payout = {
      id: 'v1', code: 'PC1', total_amount: 500, approval_status: 'APPROVED', posting_status: 'POSTED',
      account_name: 'Quỹ', is_ledger_voucher: true,
    };
    expect(cancelTargetFromManagerPayout(payout, { organizationId: 'org', subjectName: 'Quản lý' })).toEqual({
      voucherId: 'v1', organizationId: 'org', kind: 'MANAGER', code: 'PC1', amount: 500,
      approvalStatus: 'APPROVED', postingStatus: 'POSTED', subjectName: 'Quản lý', accountName: 'Quỹ',
    });
    expect(cancelTargetFromManagerPayout({ ...payout, is_ledger_voucher: false }, { organizationId: 'org', subjectName: null })).toBeNull();
    expect(cancelTargetFromManagerPayout({ ...payout, approval_status: 'CANCELLED' }, { organizationId: 'org', subjectName: null })).toBeNull();
    expect(cancelTargetFromManagerPayout({ ...payout, posting_status: 'REVERSED' }, { organizationId: 'org', subjectName: null })).toBeNull();
  });
});

describe('nhãn', () => {
  it('mốc, tháng, số dư, trạng thái phiếu', () => {
    expect(markerText({ settled_through_month: '2026-09-01' })).toBe('hết T09/2026');
    expect(markerText({ settled_through_month: null })).toBeNull();
    expect(markerText(null)).toBeNull();
    expect(ledgerMonthLabel('2026-01-01')).toBe('T01/2026');
    expect(ledgerBalanceText(-1500)).toBe('tạm ứng 1.500 đ');
    expect(ledgerBalanceText(0)).toBe('0 đ');
    expect(voucherStateLabel('UNAPPROVED', null)).toBe('Chờ duyệt');
    expect(voucherStateLabel('APPROVED', 'POSTED')).toBe('Đã chi');
    expect(voucherStateLabel('APPROVED', 'UNPOSTED')).toBe('Đã duyệt, chưa chi');
    expect(voucherStateLabel('CANCELLED', null)).toBe('Đã huỷ');
    expect(voucherStateLabel('GÌ ĐÓ', null)).toBe('—');
    expect(previousYearMonth('2026-01')).toBe('2025-12');
    expect(previousYearMonth('2026-11')).toBe('2026-10');
  });
});
