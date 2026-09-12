/**
 * Nối bộ nhập liệu chung (invoiceEntry) với luồng ĐIỀU CHỈNH hoá đơn đã duyệt /
 * đã thanh toán (adjust_invoice_v2). Nguyên tắc: dòng nào người dùng không đụng
 * thì đi vào RPC NGUYÊN XI (id, service_id, hệ số, chỉ số, kỳ, sort_order) để
 * lịch sử điều chỉnh chỉ ghi đúng phần đã đổi.
 */
import type { AdjustmentItem } from './invoiceAdjustmentEditor';
import {
  buildStructuredLines,
  calcProratedDaysOf,
  type DecomposedInvoice,
  type EntryStructuredRole,
  type InvoiceEntryValues,
  type InvoiceSourceItem,
} from './invoiceEntry';

const DEFAULT_ELEC = 3500;
const DEFAULT_WATER = 100000;
const DEFAULT_PDV = 150000;

export interface AdjustmentPricing {
  elec: number;
  water: number;
  pdv: number;
  waterApplicable: boolean;
  pdvApplicable: boolean;
  hasContractServices: boolean;
  sourceLabel: string;
}

/**
 * Đơn giá suy từ chính hoá đơn (KHÔNG tải đơn giá toà): điện = đơn giá dòng điện
 * đã lưu, nước = tiền nước trọn tháng ÷ số người, PDV = tiền PDV trọn tháng.
 */
export function pricingFromInvoice(d: DecomposedInvoice): AdjustmentPricing {
  const { values: v, baseline: b, sources } = d;
  const consumption = Math.max(0, (v.current_reading ?? v.prev_reading) - v.prev_reading);
  const elecFromLine = sources.electric ? Number(sources.electric.unit_price) : 0;
  const elec = consumption > 0 && v.electric_amount > 0
    ? Math.round(v.electric_amount / consumption)
    : elecFromLine > 0 ? elecFromLine : DEFAULT_ELEC;
  const occ = v.occupants || 1;
  const water = b.water_amount > 0 ? Math.round(b.water_amount / occ) : DEFAULT_WATER;
  const pdv = b.pdv_amount > 0 ? b.pdv_amount : DEFAULT_PDV;
  return {
    elec,
    water,
    pdv,
    waterApplicable: true,
    pdvApplicable: true,
    hasContractServices: false,
    sourceLabel: 'Đơn giá theo hoá đơn',
  };
}

function toAdjustmentItem(src: InvoiceSourceItem): AdjustmentItem {
  return {
    id: src.id,
    service_id: src.service_id ?? null,
    type: src.type,
    accounting_class: src.accounting_class ?? 'REVENUE',
    description: src.description,
    unit_price: Number(src.unit_price) || 0,
    quantity: Number(src.quantity) || 0,
    coefficient: src.coefficient == null ? 1 : Number(src.coefficient),
    previous_reading: src.previous_reading ?? null,
    current_reading: src.current_reading ?? null,
    from_date: src.from_date ?? null,
    to_date: src.to_date ?? null,
    sort_order: src.sort_order ?? 0,
  };
}

/** Ô cấu trúc nào chưa đổi so với giá trị gốc thì giữ nguyên dòng đã lưu. */
function structuredUntouched(role: EntryStructuredRole, v: InvoiceEntryValues, base: InvoiceEntryValues): boolean {
  const sameDays = calcProratedDaysOf(v) === calcProratedDaysOf(base);
  switch (role) {
    case 'rent':
      return sameDays && v.rent_price === base.rent_price;
    case 'electric':
      return (
        v.prev_reading === base.prev_reading &&
        (v.current_reading ?? null) === (base.current_reading ?? null) &&
        v.electric_amount === base.electric_amount
      );
    case 'water':
      return sameDays && v.occupants === base.occupants && v.water_amount === base.water_amount;
    case 'pdv':
      return sameDays && v.pdv_amount === base.pdv_amount;
  }
}

/**
 * Dựng p_after_items cho adjust_invoice_v2 từ form. Dòng gốc được giữ nguyên
 * khi không đổi; dòng đổi giữ id/service_id/sort_order gốc; dòng mới id null và
 * xếp sau cùng.
 */
export function buildAdjustmentItems(v: InvoiceEntryValues, d: DecomposedInvoice): AdjustmentItem[] {
  const { sources, baseline, rentDescription, values: base } = d;
  const lines = buildStructuredLines(v, {
    elecServiceId: sources.electric?.service_id ?? null,
    waterServiceId: sources.water?.service_id ?? null,
    pdvServiceId: sources.pdv?.service_id ?? null,
    rentDescription,
    baseline,
  });

  const out: AdjustmentItem[] = [];
  const usedOrders = new Set<number>();
  let nextOrder = Math.max(-1, ...Object.values(sources).map((s) => s?.sort_order ?? 0)) + 1;
  const takeOrder = (preferred: number | undefined) => {
    let order = preferred ?? nextOrder;
    while (usedOrders.has(order)) order = nextOrder++;
    usedOrders.add(order);
    if (order >= nextOrder) nextOrder = order + 1;
    return order;
  };

  for (const { role, item } of lines) {
    const src = sources[role];
    // Hoá đơn không có dòng tiền phòng (vd hoá đơn thanh lý) → không tự sinh dòng 0đ.
    if (role === 'rent' && !src && !(item.unit_price > 0)) continue;
    if (src && structuredUntouched(role, v, base)) {
      const kept = toAdjustmentItem(src);
      kept.sort_order = takeOrder(kept.sort_order);
      out.push(kept);
      continue;
    }
    out.push({
      id: src?.id ?? null,
      service_id: src?.service_id ?? item.service_id ?? null,
      type: item.type,
      accounting_class: 'REVENUE',
      description: item.description,
      unit_price: item.unit_price,
      quantity: item.quantity,
      coefficient: 1,
      previous_reading: item.previous_reading ?? null,
      current_reading: item.current_reading ?? null,
      from_date: item.from_date ?? null,
      to_date: item.to_date ?? null,
      sort_order: takeOrder(src?.sort_order),
    });
  }

  const byId = new Map<string, InvoiceSourceItem>();
  for (const it of d.allItems) if (it.id) byId.set(it.id, it);

  for (const ci of v.custom_items ?? []) {
    const src = ci.id ? byId.get(ci.id) : undefined;
    if (src) {
      const kept = toAdjustmentItem(src);
      kept.type = ci.type;
      kept.description = ci.description;
      kept.unit_price = ci.unit_price;
      kept.quantity = ci.quantity;
      kept.coefficient = ci.coefficient ?? kept.coefficient;
      kept.sort_order = takeOrder(kept.sort_order);
      out.push(kept);
      continue;
    }
    out.push({
      id: null,
      service_id: ci.service_id ?? null,
      type: ci.type,
      accounting_class: ci.accounting_class ?? 'REVENUE',
      description: ci.description,
      unit_price: ci.unit_price,
      quantity: ci.quantity,
      coefficient: ci.coefficient ?? 1,
      previous_reading: null,
      current_reading: null,
      from_date: null,
      to_date: null,
      sort_order: takeOrder(undefined),
    });
  }
  return out;
}
