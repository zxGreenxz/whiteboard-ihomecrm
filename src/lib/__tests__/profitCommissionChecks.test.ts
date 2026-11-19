import { describe, expect, it } from 'vitest';
import { buildProfitCommissionChecks, commissionVoucherPeriods, type CommissionCheckContract, type CommissionCheckVoucher } from '@/lib/profitCommissionChecks';
import type { ContractCommissionFollowup } from '@/lib/contractCommissionFollowup';

const contract: CommissionCheckContract = {
  id: 'contract-a', organization_id: 'org-a', contract_number: 'DEMO-HD-01', start_date: '2026-11-03', signed_date: '2026-10-25',
  status: 'ACTIVE', room_id: 'room-a', room: { id: 'room-a', name: '101', building_id: 'building-a', building: { name: 'Tòa thử' } },
};
const voucher = (patch: Partial<CommissionCheckVoucher> = {}): CommissionCheckVoucher => ({
  id: 'voucher-a', organization_id: 'org-a', code: 'DEMO-PC-01', contract_id: contract.id, room_id: contract.room_id,
  building_id: contract.room.building_id, type: 'EXPENSE', deleted_at: null, total_amount: 500_000, voucher_date: '2026-10-25',
  commission_kind: 'broker', system_source: null, approval_status: 'APPROVED', posting_status: 'POSTED',
  active_posting_id_v2: 'posting-a', business_result_accounting: null, invoice_id: null, invoice: null,
  items: [{ id: 'item-a', start_date: '2026-11-01', end_date: '2026-12-31', accounting_class: 'PNL', income_expense_type_id: 'type-a',
    expense_type: { name: 'Hoa hồng môi giới', category: 'Hoa hồng', is_deposit: false } }], ...patch,
});
const followup = (patch: Partial<ContractCommissionFollowup> = {}): ContractCommissionFollowup => ({
  contract_id: contract.id, contract_number: contract.contract_number, building_id: contract.room.building_id,
  building_name: 'Tòa thử', room_name: '101', kind: 'broker', state: 'PENDING', last_reason: null, last_at: null, last_actor: null,
  attempted_amount: null, can_manage: true, voucher_id: null, voucher_code: null, voucher_status: null, events: [], ...patch,
});
const check = (vouchers: CommissionCheckVoucher[], override: Partial<Parameters<typeof buildProfitCommissionChecks>[0]> = {}) =>
  buildProfitCommissionChecks({ organizationId: 'org-a', contracts: [contract], vouchers, followups: [followup()],
    completeVisibility: true, postedOn: new Map([['posting-a', '2026-12-02']]), ...override })[0];

describe('contract-level commission reconciliation', () => {
  it('finds payment from another month and keeps all three period axes separate', () => {
    const row = check([voucher()]);
    expect(row.state).toBe('ONE'); expect(row.vouchers[0].status).toBe('paid');
    expect(row.vouchers[0].voucher.voucher_date).toBe('2026-10-25');
    expect(row.vouchers[0].periods).toEqual(['11/2026 – 12/2026']);
    expect(row.vouchers[0].postedOn).toBe('2026-12-02');
  });
  it('counts voucher IDs, never accounting lines or duplicate query results', () => {
    const v = voucher(); v.items.push({ ...v.items[0], id: 'item-b' });
    expect(check([v, v]).state).toBe('ONE');
    const duplicate = check([v, voucher({ id: 'voucher-b', code: v.code, voucher_date: '2026-09-01', total_amount: 900_000 })]);
    expect(duplicate.state).toBe('DUPLICATE'); expect(duplicate.vouchers).toHaveLength(2);
  });
  it('includes legacy manual HHMG and does not combine a Sale bonus with broker commission', () => {
    const legacy = voucher({ id: 'manual', commission_kind: null, items: [{ ...voucher().items[0], expense_type: { name: 'HHMG', category: null, is_deposit: false } }] });
    const sale = voucher({ id: 'sale', commission_kind: 'sale', items: [{ ...voucher().items[0], expense_type: { name: 'Thưởng nóng Sale', category: 'Hoa hồng', is_deposit: false } }] });
    expect(check([voucher(), legacy, sale]).vouchers).toHaveLength(2);
    expect(check([voucher(), sale]).state).toBe('ONE');
  });
  it('does not reuse the previous tenant contract, room-only link, or another org', () => {
    expect(check([voucher({ contract_id: 'previous-contract' }), voucher({ contract_id: null }), voucher({ organization_id: 'org-b' })]).state).toBe('MISSING');
  });
  it('excludes cancelled/deleted vouchers but still flags two live reversed/pending vouchers', () => {
    expect(check([voucher({ approval_status: 'CANCELLED' }), voucher({ deleted_at: '2026-11-01' })]).state).toBe('MISSING');
    expect(check([voucher({ posting_status: 'REVERSED' }), voucher({ id: 'new', approval_status: 'UNAPPROVED' })]).state).toBe('DUPLICATE');
  });
  it.each(['NOT_APPLICABLE', 'SETTLED_BY_SUPPORT'] as const)('honors server decision %s without inventing a cash payment', state => {
    expect(check([], { followups: [followup({ state })] }).state).toBe(state);
    expect(check([voucher(), voucher({ id: 'second' })], { followups: [followup({ state })] }).state).toBe('DUPLICATE');
  });
  it('never turns missing permissions or a hidden server voucher into a missing/one assertion', () => {
    expect(check([], { completeVisibility: false }).state).toBe('UNVERIFIED');
    expect(check([voucher()], { completeVisibility: false }).state).toBe('UNVERIFIED');
    expect(check([], { followups: [] }).state).toBe('UNVERIFIED');
    expect(check([], { followups: [followup({ state: 'VOUCHER_CREATED', voucher_id: 'hidden' })] }).state).toBe('UNVERIFIED');
    expect(check([voucher(), voucher({ id: 'second' })], { completeVisibility: false }).state).toBe('DUPLICATE');
  });
  it('a missing type or conflicting metadata prevents a clean verdict', () => {
    expect(check([voucher({ commission_kind: null, items: [{ ...voucher().items[0], expense_type: null }] })]).state).toBe('UNVERIFIED');
    expect(check([voucher({ commission_kind: 'sale' })]).state).toBe('UNVERIFIED');
  });
  it.each([
    ['UNAPPROVED', 'UNPOSTED', 'pending'], ['APPROVED', 'UNPOSTED', 'approved'],
    ['APPROVED', 'REVERSED', 'reversed'], ['APPROVED', 'NOT_APPLICABLE', 'noncash'],
  ])('keeps %s / %s distinct from paid', (approval_status, posting_status, expected) => {
    expect(check([voucher({ approval_status, posting_status })]).vouchers[0].status).toBe(expected);
  });
  it('requires an active posting and never substitutes voucher date for payment date', () => {
    expect(check([voucher({ active_posting_id_v2: null })]).vouchers[0].status).toBe('unknown');
    expect(check([voucher()], { postedOn: new Map() }).vouchers[0].postedOn).toBeNull();
  });
  it('does not change any input financial values', () => {
    const input = [voucher()]; const before = JSON.stringify(input); check(input); expect(JSON.stringify(input)).toBe(before);
  });
});

describe('declared profit periods', () => {
  it('uses invoice month before item period and preserves unreadable invoice state', () => {
    expect(commissionVoucherPeriods(voucher({ invoice_id: 'invoice', invoice: { billing_month: '2027-01' } }))).toEqual(['01/2027']);
    expect(commissionVoucherPeriods(voucher({ invoice_id: 'hidden', invoice: null }))).toEqual(['Chưa đọc được kỳ hóa đơn']);
  });
  it('does not label non-PNL invoice items as a profit period unless explicitly overridden', () => {
    const v = voucher({ invoice_id: 'invoice', invoice: { billing_month: '2027-01' },
      items: [{ ...voucher().items[0], accounting_class: 'DEPOSIT' }] });
    expect(commissionVoucherPeriods(v)).toEqual(['Không tính vào lợi nhuận']);
    expect(commissionVoucherPeriods({ ...v, business_result_accounting: true })).toEqual(['01/2027']);
  });
  it('uses voucher month for missing periods, supports reverse periods, and excludes non-PNL items', () => {
    const v = voucher(); const item = v.items[0];
    expect(commissionVoucherPeriods(voucher({ items: [{ ...item, start_date: null }] }))).toEqual(['10/2026']);
    expect(commissionVoucherPeriods(voucher({ items: [{ ...item, end_date: '2026-09-01' }] }))).toEqual(['11/2026']);
    expect(commissionVoucherPeriods(voucher({ items: [{ ...item, accounting_class: 'DEPOSIT' }] }))).toEqual(['Không tính vào lợi nhuận']);
    expect(commissionVoucherPeriods(voucher({ business_result_accounting: false }))).toEqual(['Không tính vào lợi nhuận']);
    expect(commissionVoucherPeriods(voucher({ business_result_accounting: true, items: [{ ...item, accounting_class: 'DEPOSIT' }] }))).toEqual(['11/2026 – 12/2026']);
  });
});
