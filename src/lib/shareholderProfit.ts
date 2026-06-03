// Pure helpers cho module Chia lợi nhuận cổ đông (không phụ thuộc supabase → test được).

export interface ShareholderSummaryRow {
  shareholder_id: string;
  accrued: number; // tổng được chia (luỹ kế)
  paid: number; // tổng đã ứng/đã chi
  remaining: number; // còn lại = accrued - paid
}

// Tổng hợp Được chia / Đã ứng / Còn lại cho mỗi cổ đông (luỹ kế).
export function computeShareholderSummary(
  shareholderIds: string[],
  allocations: Array<{ shareholder_id: string; amount: number }>,
  distributions: Array<{ shareholder_id: string; total_amount: number }>
): Record<string, ShareholderSummaryRow> {
  const out: Record<string, ShareholderSummaryRow> = {};
  const ensure = (id: string): ShareholderSummaryRow =>
    (out[id] ??= { shareholder_id: id, accrued: 0, paid: 0, remaining: 0 });

  for (const id of shareholderIds) ensure(id);
  for (const a of allocations) ensure(a.shareholder_id).accrued += Number(a.amount) || 0;
  for (const d of distributions) ensure(d.shareholder_id).paid += Number(d.total_amount) || 0;
  for (const id of Object.keys(out)) out[id].remaining = out[id].accrued - out[id].paid;

  return out;
}
