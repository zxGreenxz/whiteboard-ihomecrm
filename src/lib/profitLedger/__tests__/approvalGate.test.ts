// Màn Chờ duyệt: chặn trước theo E7 đúng thứ tự chốt duyệt của máy chủ (d1_chan_interface §2.1, §7) và câu
// số dư lúc lập / bây giờ. Số trong test là dữ liệu tổng hợp.
import { describe, expect, it } from 'vitest';
import type { LedgerPayoutDetail } from '../ledgerReaders';
import { ledgerApprovalGate, ledgerApprovalNoteView, ledgerBalanceText } from '../approvalGate';

function e7(patch: Partial<LedgerPayoutDetail> = {}, voucher: Partial<LedgerPayoutDetail['voucher']> = {}): LedgerPayoutDetail {
  return {
    organization_id: 'o1', route: 'CANONICAL',
    voucher: { id: 'v1', code: 'PC-1', voucher_date: '2026-11-15', amount: 300, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED',
      system_source: 'profit.ledger_payout', account_id: 'so-a', account_name: 'Quỹ A', is_live: true, created_at: '2026-11-15T03:00:00Z', ...voucher },
    subject: { kind: 'SHAREHOLDER', id: 'sh', name: 'Cổ đông 1', is_deleted: false, has_login: true },
    at_create: { balance_before: 250, within: 250, advance: 50, warnings: [], maker_kind: 'OWNER', payee_is_maker: false },
    now: { balance_excluding_this: 1000, within: 300, advance: 0 },
    ...patch,
  };
}

describe('ledgerApprovalGate', () => {
  it('CANONICAL, phiếu chờ còn sống, người nhận còn ⇒ cho duyệt; trả sổ lúc lập', () => {
    expect(ledgerApprovalGate(e7())).toEqual({ blockReason: null, accountId: 'so-a' });
  });
  it.each([
    ['LEGACY', /chưa bật/], ['SHADOW', /chưa bật/], ['FROZEN', /đóng băng/], ['route lạ', /chưa bật/],
  ] as const)('route %s ⇒ khoá (vẫn từ chối / huỷ được)', (route, reason) => {
    const gate = ledgerApprovalGate(e7({ route: route as LedgerPayoutDetail['route'] }));
    expect(gate.blockReason).toMatch(reason);
    expect(gate.blockReason).toMatch(/vẫn từ chối hoặc huỷ được/);
  });
  it('thứ tự: route trước, rồi trạng thái, phiếu chết, người nhận, vượt số', () => {
    const dead = e7({ route: 'FROZEN', subject: { kind: 'SHAREHOLDER', id: 'sh', name: 'x', is_deleted: true, has_login: false } }, { is_live: false });
    expect(ledgerApprovalGate(dead).blockReason).toMatch(/đóng băng/);
    expect(ledgerApprovalGate(e7({}, { approval_status: 'APPROVED' })).blockReason).toMatch(/không còn chờ duyệt/);
    expect(ledgerApprovalGate(e7({}, { is_live: false })).blockReason).toMatch(/chỉ còn Huỷ/);
    expect(ledgerApprovalGate(e7({ subject: { kind: 'SHAREHOLDER', id: 'sh', name: 'x', is_deleted: true, has_login: false } })).blockReason)
      .toMatch(/Người nhận đã bị xoá/);
  });
  it('lương điều hành vượt số còn lại ⇒ khoá; cổ đông vượt (tạm ứng) thì không — máy chủ cho tạm ứng', () => {
    const over = { balance_excluding_this: 200, within: 200, advance: 100 };
    expect(ledgerApprovalGate(e7({ subject: { kind: 'MANAGER', id: 'm', name: 'QL', is_deleted: false, has_login: false }, now: over })).blockReason)
      .toMatch(/vượt lương điều hành còn lại/);
    expect(ledgerApprovalGate(e7({ now: over })).blockReason).toBeNull();
  });
});

describe('ledgerApprovalNoteView / ledgerBalanceText', () => {
  it('số dư theo dấu: còn phải trả / đang tạm ứng; lương điều hành: còn lại / đã chi quá', () => {
    expect(ledgerBalanceText(50, 'SHAREHOLDER')).toMatch(/^còn phải trả 50/);
    expect(ledgerBalanceText(-50, 'SHAREHOLDER')).toMatch(/^đang tạm ứng 50/);
    expect(ledgerBalanceText(-5, 'MANAGER')).toMatch(/^đã chi quá 5/);
  });
  it('lúc lập + bây giờ; phiếu lập trước sổ tổng không có dòng lúc lập; người giữ sổ tự tạm ứng có lưu ý', () => {
    const view = ledgerApprovalNoteView(e7());
    expect(view.title).toBe('Chi lợi nhuận cổ đông · Cổ đông 1');
    expect(view.atCreate).toMatch(/^Lúc lập: còn phải trả 250.* · trong số dư 250.* · tạm ứng 50/);
    expect(view.now).toMatch(/^Bây giờ \(không tính phiếu này\): còn phải trả 1\.000.* · duyệt thì trong số dư 300.* · tạm ứng 0/);
    expect(view.notes).toEqual(['Chỉ chi được từ sổ đã chọn lúc lập: Quỹ A.']);
    expect(ledgerApprovalNoteView(e7({ at_create: null })).atCreate).toBeNull();
    const self = ledgerApprovalNoteView(e7({ at_create: { balance_before: 0, within: 0, advance: 300, warnings: [], maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true } }));
    expect(self.notes[0]).toMatch(/tự lập phiếu tạm ứng cho chính mình/);
    expect(ledgerApprovalNoteView(e7({ subject: { kind: 'MANAGER', id: 'm', name: 'QL', is_deleted: false, has_login: false } })).title)
      .toBe('Lương điều hành · QL');
  });
});
