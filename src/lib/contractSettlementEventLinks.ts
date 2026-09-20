import { getSettlementDisplayState, type SettlementRow, type SettlementSelection, type SettlementSourceRef } from './contractSettlement';
import { settlementSourceIdentity } from './contractSettlementReader';
import type { SettlementBusinessEvent } from './contractSettlementEventReader';
import { formatVND } from './utils';

export interface SettlementEventPaymentLink {
  id: string; label: string; amountLabel: string; statusLabel: string; selection: SettlementSelection;
}
function matchesSource(event: SettlementBusinessEvent, source: SettlementSourceRef): boolean {
  if (source.organizationId !== event.organizationId) return false;
  if (source.kind === 'broker' || source.kind === 'sale_contract') return source.contractId === event.contractId || source.contractId === event.relatedContractId;
  if (source.kind === 'sale_deposit') return source.depositVoucherId === event.sourceVoucherId;
  if (source.kind === 'termination_refund') return event.sourceKind === 'termination' && source.terminationId === event.sourceId;
  return source.sourceVoucherId === event.sourceVoucherId;
}
/** Pass the full all-period payment set, before display filters. No default/first payment selection. */
export function buildSettlementEventLinks(event: SettlementBusinessEvent, payments: readonly SettlementRow[], paymentsComplete: boolean) {
  const values: SettlementEventPaymentLink[] = event.links.vouchers.map(voucher => {
    const matching = payments.find(row => row.rowType === 'voucher' && row.voucherId === voucher.id && row.snapshot.state === 'ready'
      && row.snapshot.value.organizationId === event.organizationId && row.snapshot.value.buildingId === event.buildingId);
    const statusLabel = matching ? getSettlementDisplayState(matching).label
      : voucher.approvalStatus === 'CANCELLED' ? 'Đã hủy' : voucher.approvalStatus === 'APPROVED' ? 'Đã duyệt · đối chiếu chi'
        : voucher.reviewState === 'CHANGES_REQUESTED' ? 'Cần rà soát' : voucher.reviewState === 'PENDING' ? 'Chờ duyệt' : 'Cần đối chiếu';
    return { id: `voucher:${voucher.id}`, label: voucher.code, amountLabel: formatVND(voucher.amount), statusLabel,
      selection: { kind: 'voucher', voucherId: voucher.id } };
  });
  for (const row of payments) {
    if (row.rowType !== 'source' || row.organizationId !== event.organizationId || row.buildingId !== event.buildingId || !matchesSource(event, row.sourceRef)) continue;
    values.push({ id: `source:${settlementSourceIdentity(row.sourceRef)}`, label: row.settlementKind === 'commission' ? 'Hoa hồng' : row.settlementKind === 'bonus' ? 'Thưởng sale' : 'Hoàn khách',
      amountLabel: row.basis.amount === null ? 'Chưa xác minh số tiền' : formatVND(row.basis.amount), statusLabel: 'Chưa lập phiếu',
      selection: { kind: 'source', sourceRef: row.sourceRef } });
  }
  return { complete: event.links.complete && paymentsComplete, values };
}
export function settlementEventView(event: SettlementBusinessEvent, payments: readonly SettlementRow[], paymentsComplete: boolean) {
  const links = buildSettlementEventLinks(event, payments, paymentsComplete);
  return { ...event, links: links.complete ? { state: 'ready' as const, values: links.values }
    : { state: 'unavailable' as const, reason: 'Chưa đọc đủ khoản chi liên kết' } };
}
