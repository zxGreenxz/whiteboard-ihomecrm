import { settlementStatusOf, type SettlementStatus } from '@/lib/contractSettlement';
import { resolveSettlementKind, settlementTypeMatches } from '@/lib/settlementTypes';
import type { ContractCommissionFollowup } from '@/lib/contractCommissionFollowup';

export interface CommissionCheckContract {
  id: string;
  organization_id: string;
  contract_number: string | null;
  start_date: string;
  signed_date: string | null;
  status: string;
  room_id: string;
  room: { id: string; name: string; building_id: string; building: { name: string } | null };
}

export interface CommissionCheckItem {
  id: string;
  start_date: string | null;
  end_date: string | null;
  accounting_class: string | null;
  income_expense_type_id: string | null;
  expense_type: { name: string; category: string | null; is_deposit: boolean | null } | null;
}

export interface CommissionCheckVoucher {
  id: string;
  organization_id: string;
  code: string | null;
  contract_id: string | null;
  room_id: string | null;
  building_id: string | null;
  type: string;
  deleted_at: string | null;
  total_amount: number;
  voucher_date: string | null;
  commission_kind: string | null;
  system_source: string | null;
  approval_status: string;
  posting_status: string | null;
  active_posting_id_v2: string | null;
  business_result_accounting: boolean | null;
  invoice_id: string | null;
  invoice: { billing_month: string } | null;
  items: CommissionCheckItem[];
}

export type CommissionCheckState = 'MISSING' | 'DUPLICATE' | 'ONE' | 'NOT_APPLICABLE' | 'SETTLED_BY_SUPPORT' | 'UNVERIFIED';
export interface CommissionVoucherCheck {
  voucher: CommissionCheckVoucher;
  status: SettlementStatus;
  postedOn: string | null;
  periods: string[];
  conflict: boolean;
}
export interface ProfitCommissionCheck {
  contract: CommissionCheckContract;
  state: CommissionCheckState;
  vouchers: CommissionVoucherCheck[];
  reason: string | null;
  complete: boolean;
}

export const commissionMonthLabel = (value: string | null): string =>
  value && /^\d{4}-\d{2}/.test(value) ? `${value.slice(5, 7)}/${value.slice(0, 4)}` : 'chưa xác minh';

/** Same month axes as useAccrualMonthReport: invoice month, item period, then voucher date.
 * These are declared periods, not a claim that a locked profit report includes the voucher. */
export function commissionVoucherPeriods(v: CommissionCheckVoucher): string[] {
  if (v.business_result_accounting === false) return ['Không tính vào lợi nhuận'];
  const profitItems = v.items.filter(item => v.business_result_accounting === true ||
    (item.accounting_class ? item.accounting_class === 'PNL' : !item.expense_type?.is_deposit));
  if (v.items.length && !profitItems.length) return ['Không tính vào lợi nhuận'];
  if (v.invoice_id) return [v.invoice ? commissionMonthLabel(v.invoice.billing_month) : 'Chưa đọc được kỳ hóa đơn'];
  if (!v.items.length) return [commissionMonthLabel(v.voucher_date)];
  const periods = profitItems.map(item => {
      if (!item.start_date || !item.end_date) return commissionMonthLabel(v.voucher_date);
      const start = item.start_date.slice(0, 7);
      const end = item.end_date.slice(0, 7);
      return end > start ? `${commissionMonthLabel(start)} – ${commissionMonthLabel(end)}` : commissionMonthLabel(start);
    });
  return [...new Set(periods.length ? periods : ['Không tính vào lợi nhuận'])];
}

export function commissionVoucherKind(v: CommissionCheckVoucher) {
  return resolveSettlementKind({ commissionKind: v.commission_kind, systemSource: v.system_source,
    itemKinds: v.items.map(item => settlementTypeMatches(item.expense_type?.category, item.expense_type?.name)) });
}

export const isLiveCommissionVoucher = (v: CommissionCheckVoucher): boolean =>
  v.type === 'EXPENSE' && v.deleted_at === null && v.approval_status !== 'CANCELLED';

/** Count distinct live vouchers across ALL periods, never accounting items or rooms.
 * Missing/one are conclusive only with full financial visibility and a matching server follow-up. */
export function buildProfitCommissionChecks(input: {
  organizationId: string;
  contracts: readonly CommissionCheckContract[];
  vouchers: readonly CommissionCheckVoucher[];
  followups: readonly ContractCommissionFollowup[];
  completeVisibility: boolean;
  postedOn: ReadonlyMap<string, string>;
}): ProfitCommissionCheck[] {
  const vouchers = [...new Map(input.vouchers.filter(v => v.organization_id === input.organizationId && isLiveCommissionVoucher(v))
    .map(v => [v.id, v])).values()];
  return input.contracts.filter(c => c.organization_id === input.organizationId && c.status !== 'DRAFT').map(contract => {
    const linked = vouchers.filter(v => v.contract_id === contract.id);
    const recognized = linked.filter(v => commissionVoucherKind(v).kind === 'commission');
    const rows = recognized.map(voucher => ({ voucher,
      status: voucher.posting_status === 'POSTED' && !voucher.active_posting_id_v2 ? 'unknown' as const
        : settlementStatusOf(voucher.approval_status, voucher.posting_status),
      postedOn: voucher.active_posting_id_v2 ? input.postedOn.get(voucher.active_posting_id_v2) ?? null : null,
      periods: commissionVoucherPeriods(voucher),
      conflict: commissionVoucherKind(voucher).conflict || voucher.building_id !== contract.room.building_id,
    }));
    const followup = input.followups.find(f => f.contract_id === contract.id && f.kind === 'broker');
    const hiddenType = linked.some(v => v.items.some(item => item.income_expense_type_id && !item.expense_type));
    const conflict = linked.some(v => {
      const kind = commissionVoucherKind(v);
      return kind.conflict && (kind.kind === 'commission' || kind.itemKinds.includes('commission'));
    });
    const serverVoucherMatches = followup?.state !== 'VOUCHER_CREATED' ||
      rows.some(row => row.voucher.id === followup.voucher_id);
    const complete = input.completeVisibility && !!followup && !hiddenType && !conflict && serverVoucherMatches;
    let state: CommissionCheckState;
    if (rows.length > 1) state = 'DUPLICATE';
    else if (!complete) state = 'UNVERIFIED';
    else if (rows.length === 1) state = 'ONE';
    else if (followup?.state === 'NOT_APPLICABLE') state = 'NOT_APPLICABLE';
    else if (followup?.state === 'SETTLED_BY_SUPPORT') state = 'SETTLED_BY_SUPPORT';
    else state = 'MISSING';
    return { contract, state, vouchers: rows, complete, reason: followup?.state === 'NOT_APPLICABLE' ? followup.last_reason : null };
  });
}

export const commissionCheckLabel = (row: ProfitCommissionCheck): string => ({
  MISSING: 'Chưa có phiếu hoa hồng', DUPLICATE: `Có ${row.complete ? '' : 'ít nhất '}${row.vouchers.length} phiếu hoa hồng — cần rà soát trùng`,
  ONE: 'Đã có 1 phiếu hoa hồng', NOT_APPLICABLE: 'Đã xác nhận không phát sinh hoa hồng',
  SETTLED_BY_SUPPORT: 'Đã xử lý bằng hỗ trợ tiền thuê', UNVERIFIED: 'Chưa đủ dữ liệu để kết luận số phiếu hoa hồng',
})[row.state];

export const commissionPaymentLabel: Record<SettlementStatus, string> = {
  pending: 'Chờ duyệt', approved: 'Đã duyệt · chưa chi', paid: 'Đã chi · đã ghi sổ',
  reversed: 'Đã hoàn tác ghi sổ · cần đối chiếu', noncash: 'Sổ ảo · không phải đã chi tiền',
  cancelled: 'Đã hủy', unknown: 'Chưa xác minh trạng thái thanh toán',
};
