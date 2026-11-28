import type { SpendCommitmentRow, SpendSwitchRow, SpendFeeKey } from '@/hooks/useSpendEngine';

interface ExpenseRuleInput {
  fee: SpendFeeKey;
  month: string;
  buildingId: string;
  route?: string;
  mode?: string;
  switches: SpendSwitchRow[];
  commitment?: SpendCommitmentRow;
  price: number | null;
  disabled: boolean;
}

export interface ExpensePolicy {
  label: string;
  amount?: number;
  limitDescription?: string;
  remaining?: number;
  note?: string;
}

// Describes a single fee in one month, not the approval of a particular voucher.
// A standalone TUNG_PHIEU line cannot activate ie_spend_gate_v1 (all_switched).
export function describeExpensePolicy(input: ExpenseRuleInput): ExpensePolicy {
  const { buildingId, month, fee, mode, route, commitment, price } = input;
  if (input.disabled) return { label: 'Đã tắt ở Thanh toán' };
  if (!route || !['CANONICAL', 'LEGACY', 'FROZEN', 'SHADOW'].includes(route)) {
    return { label: 'Chưa xác định cách duyệt' };
  }
  const enabled = route === 'CANONICAL' && input.switches.some(s =>
    s.fee_category === fee && (s.building_id === null || s.building_id === buildingId) &&
    s.period_from.slice(0, 7) <= month && (!s.period_to || s.period_to.slice(0, 7) >= month));
  const utility = fee === 'dien' || fee === 'nuoc';
  if (enabled && mode === 'CAM_KET') {
    return {
      label: 'Duyệt trong hạn mức tháng',
      amount: commitment?.amount,
      remaining: commitment?.remaining,
      note: commitment ? undefined : 'Chưa ký cam kết · phiếu chờ duyệt',
    };
  }
  if (enabled && utility && mode === 'TRAN') {
    return { label: 'Duyệt theo trần điện nước', limitDescription: 'Trần điện nước của kỳ', note: 'Thiếu trần hoặc vượt trần thì chờ duyệt' };
  }
  if (utility) return { label: 'Theo ngưỡng và trần điện nước', note: 'Áp dụng cho phiếu đóng điện, nước' };
  if (price !== null) return { label: 'Duyệt đúng giá', amount: price };
  return { label: 'Theo quy trình đóng phí', note: 'Chưa công bố giá cho kỳ này' };
}
