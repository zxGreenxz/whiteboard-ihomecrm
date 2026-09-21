import type { SettlementChronologyLane } from '@/lib/contractSettlementTimeline';
import type { SettlementFinancialContext } from '@/lib/contractSettlementFinancialContext';
import type { SettlementMoneyFact } from '@/lib/contractSettlementFinancialFacts';
import type { SettlementTimelineLaneView } from './ContractSettlementTimelineView';
const money = (fact: SettlementMoneyFact | undefined) => fact?.state === 'verified' ? `${fact.amount.toLocaleString('vi-VN')}đ` : 'Chưa xác minh';
const day = (value: string | null | undefined) => value ? value.split('-').reverse().join('/') : 'Chưa xác minh';
const labels: Record<string, string> = { ACTIVE: 'Đang thuê', TERMINATED: 'Đã thanh lý', EXPIRED: 'Hết hạn', DRAFT: 'Nháp', PENDING: 'Chờ xử lý', CANCELLED: 'Đã hủy' };

/** Cash belongs to an exact contract. A required deposit or legacy room event is never a received amount. */
export function settlementTimelineLane(lane: SettlementChronologyLane, context?: SettlementFinancialContext): SettlementTimelineLaneView {
  const contract = lane.contract;
  const facts = context?.targetContractId === contract.id ? context : undefined;
  const termination = facts?.termination && ['APPROVED', 'COMPLETED'].includes(facts.termination.status) ? facts.termination : null;
  return {
    id: contract.id, role: lane.role, code: contract.number ?? 'Chưa có mã hợp đồng', customer: contract.tenantName ?? 'Chưa có tên khách',
    status: labels[contract.status] ?? 'Cần đối chiếu trạng thái',
    steps: [
      { label: 'Ký hợp đồng', value: day(contract.signedDate), detail: `Thuê ${day(contract.startDate)} — ${day(contract.endDate)}` },
      { label: 'Cọc thực thu', value: money(facts?.depositReceived), detail: `Phải đóng: ${money(facts?.depositRequired)}` },
      { label: 'Tiền khác thực thu', value: money(facts?.otherReceived), detail: `Công nợ hiện tại: ${money(facts?.currentDebt)}${facts?.today ? ` · ${day(facts.today)}` : ''}` },
      { label: 'Thanh lý / hoàn khách', value: day(termination?.date),
        detail: termination ? `Nghĩa vụ hoàn: ${money(facts?.refundOwed)} · Đã hoàn: ${money(facts?.refunded)} · Còn hoàn: ${money(facts?.refundRemaining)}`
          : 'Chưa có hồ sơ thanh lý được xác minh cho lần đối chiếu này.' },
    ],
  };
}
