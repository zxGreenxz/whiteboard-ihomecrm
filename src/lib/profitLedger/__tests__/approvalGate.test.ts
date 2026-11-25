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
  ] as const)('route %s ⇒ khoá (vẫn huỷ được)', (route, reason) => {
    const gate = ledgerApprovalGate(e7({ route: route as LedgerPayoutDetail['route'] }));
    expect(gate.blockReason).toMatch(reason);
    expect(gate.blockReason).toMatch(/\(vẫn huỷ được\)/);
    // Màn Chờ duyệt đã bỏ 25/11/2026: Thu chi không có nút Từ chối, câu khoá không được chỉ sang thao tác đó.
    expect(gate.blockReason).not.toMatch(/từ chối/i);
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
  it('số dư ròng theo dấu: cổ đông nói theo hai con số mới; lương điều hành: còn lại / đã chi quá', () => {
    expect(ledgerBalanceText(50, 'SHAREHOLDER')).toMatch(/^lợi nhuận chưa chi sau khi trừ tạm ứng 50/);
    expect(ledgerBalanceText(-50, 'SHAREHOLDER')).toMatch(/^tạm ứng đang vượt lợi nhuận chưa chi 50/);
    expect(ledgerBalanceText(5, 'MANAGER')).toMatch(/^còn lại 5/);
    expect(ledgerBalanceText(-5, 'MANAGER')).toMatch(/^đã chi quá 5/);
  });
  it('phiếu cũ lập bằng lệnh nhập tay (có tách trong số dư / tạm ứng): giữ cách nói lúc lập; phiếu lập trước sổ tổng không có dòng lúc lập', () => {
    const view = ledgerApprovalNoteView(e7());
    expect(view.title).toBe('Chi lợi nhuận cổ đông · Cổ đông 1');
    expect(view.atCreate).toMatch(/^Lúc lập: lợi nhuận chưa chi sau khi trừ tạm ứng 250.* · trong số dư 250.* · tạm ứng 50/);
    expect(view.now).toMatch(/^Bây giờ \(không tính phiếu này\): lợi nhuận chưa chi sau khi trừ tạm ứng 1\.000.* · duyệt thì không vượt lợi nhuận chưa chi$/);
    expect(view.notes).toEqual(['Chỉ chi được từ sổ đã chọn lúc lập: Quỹ A.']);
    expect(ledgerApprovalNoteView(e7({ at_create: null })).atCreate).toBeNull();
  });
  it('phiếu TẠM ỨNG tự lập: nói "tạm ứng X", vượt lợi nhuận chưa chi bao nhiêu thì nói rõ; người duyệt phải khác người lập', () => {
    const self = ledgerApprovalNoteView(e7({
      at_create: { balance_before: 100, within: 0, advance: 300, warnings: [], maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true },
      now: { balance_excluding_this: 250, within: 250, advance: 50 },
    }));
    expect(self.title).toBe('Tạm ứng lợi nhuận · Cổ đông 1');
    expect(self.atCreate).toMatch(/^Lúc lập: lợi nhuận chưa chi sau khi trừ tạm ứng 100.* · tạm ứng 300.* · vượt lợi nhuận chưa chi 200/);
    expect(self.now).toMatch(/ · duyệt thì tạm ứng 300.* · vượt lợi nhuận chưa chi 50/);
    expect(self.notes[0]).toMatch(/tự lập phiếu tạm ứng cho chính mình/);
    expect(self.notes).toContain('Tạm ứng cộng dồn; được khấu trừ khi chủ chốt chi lợi nhuận.');
    expect(`${self.atCreate} ${self.now}`).not.toMatch(/trong số dư/);
    // Số dư ròng lúc lập đã âm ⇒ cả khoản ứng là phần vượt.
    const deep = ledgerApprovalNoteView(e7({ at_create: { balance_before: -40, within: 0, advance: 300, warnings: [], maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true } }));
    expect(deep.atCreate).toMatch(/tạm ứng đang vượt lợi nhuận chưa chi 40.* · tạm ứng 300.* · vượt lợi nhuận chưa chi 300/);
  });
  it('phiếu Tạm Ứng người giữ sổ lập HỘ: lưu ý người duyệt phải khác người lập và người nhận; không vượt thì nói không vượt', () => {
    const forPayee = ledgerApprovalNoteView(e7({
      at_create: { balance_before: 900, within: 0, advance: 300, warnings: [], maker_kind: 'CUSTODIAN_FOR_PAYEE', payee_is_maker: false },
      now: { balance_excluding_this: 900, within: 300, advance: 0 },
    }));
    expect(forPayee.title).toBe('Tạm ứng lợi nhuận · Cổ đông 1');
    expect(forPayee.atCreate).toMatch(/ · tạm ứng 300[^·]*$/);
    expect(forPayee.now).toMatch(/ · duyệt thì tạm ứng 300.* · không vượt lợi nhuận chưa chi$/);
    expect(forPayee.notes[0]).toBe('Người giữ sổ lập phiếu tạm ứng cho cổ đông — người duyệt phải khác người lập và người nhận.');
    expect(forPayee.notes.some((note) => /tự lập phiếu tạm ứng cho chính mình/.test(note))).toBe(false);
  });
  it('phiếu chi lợi nhuận của chủ (phiếu tiền của lần chốt): nói rõ đã khấu trừ tạm ứng, không còn chữ "tạm ứng 0"', () => {
    const settle = ledgerApprovalNoteView(e7({
      at_create: { balance_before: 300, within: 300, advance: 0, warnings: [], maker_kind: 'OWNER', payee_is_maker: false },
      now: { balance_excluding_this: 300, within: 300, advance: 0 },
    }));
    expect(settle.title).toBe('Chi lợi nhuận cổ đông · Cổ đông 1');
    expect(settle.atCreate).toMatch(/ · chi lợi nhuận 300/);
    expect(settle.notes[0]).toMatch(/đã khấu trừ tạm ứng đã duyệt/);
    expect(`${settle.atCreate} ${settle.now}`).not.toMatch(/tạm ứng 0|trong số dư/);
  });
  it('tạm ứng do chủ lập giữ đúng loại nghiệp vụ khi vào Chờ duyệt', () => {
    const owner = { within: 0, advance: 300, balance_before: 0, warnings: [], maker_kind: 'OWNER' as const, payee_is_maker: false };
    expect(ledgerApprovalNoteView(e7({ at_create: { ...owner, payout_kind: 'ADVANCE' } })).title).toMatch(/^Tạm ứng lợi nhuận/);
    expect(ledgerApprovalNoteView(e7({ at_create: owner })).title).toMatch(/^Chi lợi nhuận cổ đông/);
  });
  it('lương điều hành: câu chữ không đổi', () => {
    const view = ledgerApprovalNoteView(e7({ subject: { kind: 'MANAGER', id: 'm', name: 'QL', is_deleted: false, has_login: false } }));
    expect(view.title).toBe('Lương điều hành · QL');
    expect(view.atCreate).toMatch(/^Lúc lập: còn lại 250.* · trong số dư 250.* · vượt 50/);
    expect(view.now).toMatch(/^Bây giờ \(không tính phiếu này\): còn lại 1\.000.* · duyệt thì trong số dư 300.* · vượt 0/);
  });
});
