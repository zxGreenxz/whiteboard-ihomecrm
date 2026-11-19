// Hai nguồn phiếu của sổ tổng lợi nhuận (Đợt 1): thiếu dòng trong VOUCHER_SOURCES thì Thu chi gọi phiếu
// là "Nhập tay" và bộ lọc nhóm không tìm thấy.
import { describe, expect, it } from 'vitest';
import {
  VOUCHER_GROUPS, VOUCHER_SOURCES, isInternalSource, voucherLayer, voucherSourceGroup, voucherSourceLabel,
} from '../voucherSources';

const sourcesOfGroup = (group: string) => Object.entries(VOUCHER_SOURCES).filter(([, m]) => m.group === group).map(([k]) => k);

describe('nguồn phiếu sổ tổng lợi nhuận', () => {
  it('profit.ledger_payout: "Chia lợi nhuận cổ đông", nhóm "Chia lợi nhuận", không nội bộ', () => {
    expect(voucherSourceLabel('profit.ledger_payout')).toBe('Chia lợi nhuận cổ đông');
    expect(voucherSourceGroup('profit.ledger_payout')).toBe('Chia lợi nhuận');
    expect(isInternalSource('profit.ledger_payout')).toBe(false);
  });
  it('profit.manager_salary: "Lương điều hành", nhóm "Lương" (cùng nhóm phiếu lương điều hành cũ), không nội bộ', () => {
    expect(voucherSourceLabel('profit.manager_salary')).toBe('Lương điều hành');
    expect(voucherSourceGroup('profit.manager_salary')).toBe('Lương');
    expect(voucherSourceGroup('profit.manager_salary')).toBe(voucherSourceGroup('salary.manager'));
    expect(isInternalSource('profit.manager_salary')).toBe(false);
  });
  it('bộ lọc nhóm tìm được phiếu mới cùng phiếu cũ', () => {
    expect(sourcesOfGroup('Chia lợi nhuận')).toEqual(expect.arrayContaining(['profit.distribution', 'profit.ledger_payout']));
    expect(sourcesOfGroup('Lương')).toEqual(expect.arrayContaining(['salary.manager', 'profit.manager_salary']));
    expect(VOUCHER_GROUPS).toEqual(expect.arrayContaining(['Chia lợi nhuận', 'Lương']));
  });
  it('phiếu đã duyệt trên sổ thật là TIỀN THẬT (không nhập tay, không nội bộ)', () => {
    for (const source of ['profit.ledger_payout', 'profit.manager_salary']) {
      expect(voucherLayer({ approval_status: 'APPROVED', account_id: 'a1', system_source: source, account_is_virtual: false }), source).toBe('CASH');
      expect(voucherLayer({ approval_status: 'UNAPPROVED', account_id: 'a1', system_source: source, account_is_virtual: false }), source).toBe('PENDING');
      expect(voucherSourceLabel(source)).not.toBe('Nhập tay');
    }
  });
});
