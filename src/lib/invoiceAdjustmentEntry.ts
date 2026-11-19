/**
 * Nối bộ nhập liệu chung (invoiceEntry) với luồng ĐIỀU CHỈNH hoá đơn đã duyệt /
 * đã thanh toán (adjust_invoice_v2). Nguyên tắc: dòng nào người dùng không đụng
 * thì đi vào RPC NGUYÊN XI (id, service_id, hệ số, chỉ số, kỳ, sort_order) để
 * lịch sử điều chỉnh chỉ ghi đúng phần đã đổi. Dạng "nguyên xi" và lý do chặn
 * điều chỉnh (thanh lý, nợ cũ lệch nguồn) do hàm dùng chung
 * public.invoice_adjustment_build_v1 trả (invoiceAdjustmentBuildRpc.ts), cùng
 * luật với trợ lý Hermes — không tính lại ở trình duyệt.
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

/** Dòng máy chủ trả cho id này (luật dòng giữ nguyên của invoice_adjustment_build_v1); thiếu ⇒ hoá đơn vừa đổi, tải lại. */
export class AdjustmentKeptLineMissingError extends Error {
  constructor() {
    super('Hạng mục của hoá đơn vừa thay đổi trên máy chủ. Tải lại hoá đơn trước khi điều chỉnh.');
    this.name = 'AdjustmentKeptLineMissingError';
  }
}
function keptLine(kept: ReadonlyMap<string, AdjustmentItem>, src: InvoiceSourceItem): AdjustmentItem {
  const line = src.id ? kept.get(src.id) : undefined;
  if (!line) throw new AdjustmentKeptLineMissingError();
  return { ...line };
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
 * khi không đổi (đúng dạng máy chủ trả trong `kept`); dòng đổi giữ
 * id/service_id/sort_order gốc; dòng mới id null và xếp sau cùng.
 */
export function buildAdjustmentItems(v: InvoiceEntryValues, d: DecomposedInvoice, kept: ReadonlyMap<string, AdjustmentItem>): AdjustmentItem[] {
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
      const line = keptLine(kept, src);
      line.sort_order = takeOrder(line.sort_order);
      out.push(line);
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
      const line = keptLine(kept, src);
      line.type = ci.type;
      line.description = ci.description;
      line.unit_price = ci.unit_price;
      line.quantity = ci.quantity;
      line.coefficient = ci.coefficient ?? line.coefficient;
      line.sort_order = takeOrder(line.sort_order);
      out.push(line);
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
