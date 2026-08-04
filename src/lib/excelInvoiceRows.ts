// Pure transform cho ExcelInvoiceDialog (Phase 9C) — TRÍCH NGUYÊN VĂN logic
// inline cũ của dialog, không đổi công thức. Characterization test:
// src/lib/__tests__/excelInvoiceRows.test.ts (chốt hành vi trước khi di chuyển).
//
// KHÔNG import supabase ở đây — file này thuần dữ liệu-vào/dữ-liệu-ra để test
// được không cần mock network. Phần fetch nằm ở hooks/invoices/useExcelInvoiceData.
import { format } from "date-fns";
import { calcProratedDays, prorateAmount } from "@/lib/prorateCalculation";
import {
  resolveInvoicePricing,
  type BuildingDefaults,
  type ContractServiceInput,
} from "@/lib/contractServicePricing";
import { PREVIOUS_DEBT_ROUND_THRESHOLD } from "@/lib/invoiceHelpers";
import { getInvoiceTitle } from "@/lib/invoiceUtils";
import type { InvoiceFormData, PreviousDebtSource } from "@/types/invoice";

// ── Kiểu dữ liệu ─────────────────────────────────────────────────────────────
export interface ExcelRowData {
  contract_id: string;
  room_id: string;
  room_name: string;
  rent_price: number;
  occupants: number;
  meter_id: string | null;
  prev_reading: number;
  prev_reading_overridden: boolean;
  current_reading: number | "";
  electric_amount: number;
  electric_overridden: boolean;
  water_amount: number;
  water_overridden: boolean;
  pdv_amount: number;
  pdv_overridden: boolean;
  elec_rate: number;
  elec_service_id: string | null;
  water_rate: number;
  water_service_id: string | null;
  water_applicable: boolean;
  pdv_rate: number;
  pdv_service_id: string | null;
  pdv_applicable: boolean;
  services_raw: ContractServiceInput[];
  discount: number;
  discount_notes: string;
  applied_credit: number;
  credit_balance: number;
  previous_debt: number;
  previous_debt_sources: PreviousDebtSource[];
  previous_debt_overridden: boolean;
  period_start_date: string | null;
  period_end_date: string | null;
  selected: boolean;
}

export type BuildingPriceDefaults = BuildingDefaults;

export interface RawContract {
  id: string;
  rent_price: number | null;
  room_id: string;
  status?: string;
  discounts?: { months?: number; amount_per_month?: number } | null;
  start_date?: string | null;
  created_at?: string | null;
  room?: { id: string; name: string; building_id: string } | null;
  contract_customers?: Array<{ id: string }> | null;
  contract_services?: ContractServiceInput[] | null;
}

export interface RawOldInvoice {
  id: string;
  invoice_number?: string | null;
  billing_month?: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  contract_id: string;
  status?: string;
  notes?: string | null;
  previous_debt?: number | null;
  previous_debt_sources?: PreviousDebtSource[] | null;
  room?: { id: string; name: string } | null;
  building?: { id: string; name: string } | null;
  invoice_items?: Array<{ id: string; type: string; description: string | null }>;
}

// ── 1. Đơn giá mặc định theo toà (từ building_services đang BẬT) ─────────────
// Chỉ xét dịch vụ is_active — tránh bug nhiều dịch vụ điện cùng tên ghi đè nhau
// và lấy phải cái đã tắt.
export function resolveBuildingDefaults(
  bldSvc: Array<{
    is_active?: boolean;
    service_id: string;
    unit_price_override?: number | null;
    service?: { name?: string | null; unit_price?: number | null } | null;
  }> | null | undefined,
): BuildingPriceDefaults {
  let elec = 3500;
  let water = 100000;
  let pdv = 150000;
  let elecServiceId: string | null = null;
  let waterServiceId: string | null = null;
  let pdvServiceId: string | null = null;
  for (const bs of (bldSvc ?? []).filter((b) => b.is_active)) {
    const name = bs.service?.name?.toLowerCase() ?? "";
    const price = bs.unit_price_override ?? bs.service?.unit_price ?? 0;
    if (name.includes("điện")) {
      elec = Number(price) || elec;
      elecServiceId = bs.service_id;
    } else if (name.includes("nước")) {
      water = Number(price) || water;
      waterServiceId = bs.service_id;
    } else if (name.includes("dịch vụ") || name.includes("phí")) {
      pdv = Number(price) || pdv;
      pdvServiceId = bs.service_id;
    }
  }
  return { elec, water, pdv, elecServiceId, waterServiceId, pdvServiceId };
}

// ── 2. Gom HĐ theo phòng: 1 phòng 1 HĐ (dữ liệu lỗi >1 HĐ ACTIVE → giữ HĐ
// mới nhất theo start_date desc, tie-break created_at desc) ──────────────────
export function dedupeContractsByRoom(contracts: RawContract[]): {
  contracts: RawContract[];
  dupRoomNames: string[];
} {
  const byRoom = new Map<string, RawContract>();
  const dupRoomNames = new Set<string>();
  const pickNewer = (a: RawContract, b: RawContract) => {
    const sa = a.start_date ?? "";
    const sb = b.start_date ?? "";
    if (sa !== sb) return sa > sb ? a : b;
    return (a.created_at ?? "") >= (b.created_at ?? "") ? a : b;
  };
  for (const c of contracts) {
    const existing = byRoom.get(c.room_id);
    if (!existing) {
      byRoom.set(c.room_id, c);
      continue;
    }
    dupRoomNames.add(c.room?.name ?? existing.room?.name ?? "?");
    byRoom.set(c.room_id, pickNewer(existing, c));
  }
  return {
    contracts: Array.from(byRoom.values()),
    dupRoomNames: Array.from(dupRoomNames).sort((a, b) =>
      a.localeCompare(b, "vi", { numeric: true }),
    ),
  };
}

// ── 3. Chỉ số điện mới nhất per meter (input ĐÃ sort reading_date desc,
// created_at desc — lấy dòng đầu gặp cho mỗi meter) ──────────────────────────
export function buildLastReadingByMeter(
  readings: Array<{ meter_id: string; current_reading: number | null }>,
): Map<string, number> {
  const lastReading = new Map<string, number>();
  for (const r of readings) {
    if (!lastReading.has(r.meter_id)) {
      lastReading.set(r.meter_id, Number(r.current_reading) || 0);
    }
  }
  return lastReading;
}

// ── 4. Credit (excess_amounts) per contract — bỏ dòng có source invoice đã xoá
export function buildCreditByContract(
  credits: Array<{
    contract_id: string;
    amount: number | null;
    source_invoice?: { deleted_at: string | null } | null;
  }>,
): Map<string, number> {
  const creditByContract = new Map<string, number>();
  for (const row of credits) {
    if (row.source_invoice?.deleted_at) continue;
    const prev = creditByContract.get(row.contract_id) || 0;
    creditByContract.set(row.contract_id, prev + (Number(row.amount) || 0));
  }
  return creditByContract;
}

// ── 5. Nợ cũ per contract từ HĐ APPROVED/PARTIAL_PAID/OVERDUE chưa tất toán,
// 2 pass: (1) HĐ đã bị HĐ khác carry-over thì bỏ; (2) còn lại thành sources ───
export function buildPreviousDebtByContract(
  oldInvoices: RawOldInvoice[],
): Map<string, { total: number; sources: PreviousDebtSource[] }> {
  const previousDebtByContract = new Map<string, { total: number; sources: PreviousDebtSource[] }>();
  const carriedInvoiceIdsByContract = new Map<string, Set<string>>();
  for (const inv of oldInvoices) {
    const srcs = Array.isArray(inv.previous_debt_sources) ? inv.previous_debt_sources : [];
    for (const s of srcs) {
      if (s?.type === "invoice" && s?.id) {
        const set = carriedInvoiceIdsByContract.get(inv.contract_id) || new Set<string>();
        set.add(String(s.id));
        carriedInvoiceIdsByContract.set(inv.contract_id, set);
      }
    }
  }
  // Fallback dedup: HĐ có previous_debt > 0 nhưng sources rỗng (legacy/user chỉnh
  // tay) → suy luận tất cả HĐ cùng contract có billing_month nhỏ hơn đã được carry.
  for (const inv of oldInvoices) {
    const prevDebt = Number(inv.previous_debt) || 0;
    const srcs = Array.isArray(inv.previous_debt_sources) ? inv.previous_debt_sources : [];
    if (prevDebt > 0 && srcs.length === 0) {
      const set = carriedInvoiceIdsByContract.get(inv.contract_id) || new Set<string>();
      for (const older of oldInvoices) {
        if (older.contract_id === inv.contract_id && older.id !== inv.id
            && (older.billing_month ?? '') < (inv.billing_month ?? '')) {
          set.add(String(older.id));
        }
      }
      carriedInvoiceIdsByContract.set(inv.contract_id, set);
    }
  }
  for (const inv of oldInvoices) {
    const carried = carriedInvoiceIdsByContract.get(inv.contract_id);
    if (carried?.has(String(inv.id))) continue;
    const remaining = (Number(inv.total_amount) || 0) - (Number(inv.paid_amount) || 0);
    if (remaining < PREVIOUS_DEBT_ROUND_THRESHOLD) continue;
    const label = getInvoiceTitle(inv as unknown as Parameters<typeof getInvoiceTitle>[0]);
    const entry = previousDebtByContract.get(inv.contract_id) || { total: 0, sources: [] };
    entry.sources.push({ type: "invoice", id: inv.id, amount: remaining, label });
    entry.total += remaining;
    previousDebtByContract.set(inv.contract_id, entry);
  }
  return previousDebtByContract;
}

// ── 6. Đếm HĐ (không CANCELLED, không xoá) per contract — slot khuyến mãi ────
export function buildInvoiceCountByContract(
  invoices: Array<{ id: string; contract_id: string }>,
): Map<string, number> {
  const invoiceCountByContract = new Map<string, number>();
  for (const inv of invoices) {
    invoiceCountByContract.set(
      inv.contract_id,
      (invoiceCountByContract.get(inv.contract_id) || 0) + 1,
    );
  }
  return invoiceCountByContract;
}

// ── 7. Ghép contract → RowData (kèm khuyến mãi slot, credit, nợ cũ, pricing) ─
export function buildExcelRows(args: {
  contracts: RawContract[];
  meterByRoom: Map<string, string>;
  lastReading: Map<string, number>;
  creditByContract: Map<string, number>;
  invoiceCountByContract: Map<string, number>;
  previousDebtByContract: Map<string, { total: number; sources: PreviousDebtSource[] }>;
  defaults: BuildingPriceDefaults;
}): ExcelRowData[] {
  const {
    contracts, meterByRoom, lastReading, creditByContract,
    invoiceCountByContract, previousDebtByContract, defaults,
  } = args;
  return contracts
    .map((c) => {
      const occupants = c.contract_customers?.length ?? 1;
      const meterId = meterByRoom.get(c.room_id) ?? null;
      const prev = meterId ? lastReading.get(meterId) ?? 0 : 0;
      const credit = Math.max(0, creditByContract.get(c.id) || 0);
      const debtEntry = previousDebtByContract.get(c.id);
      const previousDebt = debtEntry?.total ?? 0;
      const previousDebtSources = debtEntry?.sources ?? [];

      // Khuyến mãi HĐ (tháng X/Y): slot = số HĐ đã có + 1.
      const promoMonths = Number(c.discounts?.months) || 0;
      const promoPer = Number(c.discounts?.amount_per_month) || 0;
      const used = invoiceCountByContract.get(c.id) || 0;
      const slotIndex = used + 1;
      const promoApplicable = promoMonths > 0 && promoPer > 0 && slotIndex <= promoMonths;
      const promoAmount = promoApplicable ? promoPer : 0;
      const promoNote = promoApplicable
        ? `Khuyến mãi HĐ — tháng ${slotIndex}/${promoMonths} × ${promoPer.toLocaleString("vi-VN")}đ`
        : "";

      const totalDiscount = credit + promoAmount;
      const noteParts = [
        promoNote,
        credit > 0 ? `Nợ ${credit.toLocaleString("vi-VN")} Tiền Thối` : "",
      ].filter(Boolean);
      const combinedNotes = noteParts.join(" — ");

      const servicesRaw = (c.contract_services ?? []) as ContractServiceInput[];
      const pricing = resolveInvoicePricing(servicesRaw, defaults);

      return {
        contract_id: c.id,
        room_id: c.room_id,
        room_name: c.room?.name ?? "?",
        rent_price: Number(c.rent_price) || 0,
        occupants,
        meter_id: meterId,
        prev_reading: prev,
        prev_reading_overridden: false,
        current_reading: "" as const,
        electric_amount: 0,
        electric_overridden: false,
        water_amount: pricing.waterApplicable ? occupants * pricing.water : 0,
        water_overridden: false,
        pdv_amount: pricing.pdvApplicable ? pricing.pdv : 0,
        pdv_overridden: false,
        elec_rate: pricing.elec,
        elec_service_id: pricing.elecServiceId,
        water_rate: pricing.water,
        water_service_id: pricing.waterServiceId,
        water_applicable: pricing.waterApplicable,
        pdv_rate: pricing.pdv,
        pdv_service_id: pricing.pdvServiceId,
        pdv_applicable: pricing.pdvApplicable,
        services_raw: servicesRaw,
        discount: totalDiscount,
        discount_notes: combinedNotes,
        applied_credit: credit,
        credit_balance: credit,
        previous_debt: previousDebt,
        previous_debt_sources: previousDebtSources,
        previous_debt_overridden: false,
        period_start_date: null,
        period_end_date: null,
        selected: true,
      };
    })
    .sort((a, b) => a.room_name.localeCompare(b.room_name, "vi", { numeric: true }));
}

// ── 8. Re-resolve đơn giá khi building_services load sau (tôn trọng override) ─
export function reresolveRowPricing(
  r: ExcelRowData,
  defaults: BuildingPriceDefaults,
): ExcelRowData {
  const p = resolveInvoicePricing(r.services_raw, defaults);
  return {
    ...r,
    elec_rate: p.elec,
    elec_service_id: p.elecServiceId,
    water_rate: p.water,
    water_service_id: p.waterServiceId,
    water_applicable: p.waterApplicable,
    pdv_rate: p.pdv,
    pdv_service_id: p.pdvServiceId,
    pdv_applicable: p.pdvApplicable,
    water_amount: r.water_overridden
      ? r.water_amount
      : p.waterApplicable
        ? r.occupants * p.water
        : 0,
    pdv_amount: r.pdv_overridden ? r.pdv_amount : p.pdvApplicable ? p.pdv : 0,
  };
}

// ── 9. Tổng tiền preview 1 dòng (prorate nếu có period) ──────────────────────
export function computeExcelRowTotal(r: ExcelRowData): number {
  const days = calcProratedDays(r.period_start_date, r.period_end_date);
  const rent = days > 0 ? prorateAmount(r.rent_price, days) : r.rent_price;
  const water = days > 0 ? prorateAmount(r.water_amount, days) : r.water_amount;
  const pdv = days > 0 ? prorateAmount(r.pdv_amount, days) : r.pdv_amount;
  return rent + r.electric_amount + water + pdv - r.discount + (r.previous_debt || 0);
}

// ── 10. Build items + form data khi submit (GIỮ NGUYÊN thứ tự/threshold cũ) ──
export interface SubmitContext {
  buildingId: string;
  billingMonth: string;
  issueDate: string;
  dueDate: string;
  periodStart: Date;
  fromDate: string; // đầu kỳ yyyy-MM-dd
  toDate: string;   // cuối kỳ yyyy-MM-dd
}

export function buildInvoiceItems(
  row: ExcelRowData,
  ctx: SubmitContext,
): InvoiceFormData["items"] {
  const consumption =
    (Number(row.current_reading) || 0) - (Number(row.prev_reading) || 0);
  const itemDays = calcProratedDays(row.period_start_date, row.period_end_date);
  const useProrate = itemDays > 0;
  const itemFromDate = useProrate ? row.period_start_date! : ctx.fromDate;
  const itemToDate = useProrate ? row.period_end_date! : ctx.toDate;
  const prorateLabel = useProrate ? ` (${itemDays}/30 ngày)` : "";

  const rentAmount = useProrate ? prorateAmount(row.rent_price, itemDays) : row.rent_price;
  const waterAmount = useProrate ? prorateAmount(row.water_amount, itemDays) : row.water_amount;
  const pdvAmount = useProrate ? prorateAmount(row.pdv_amount, itemDays) : row.pdv_amount;

  const items: InvoiceFormData["items"] = [];
  let order = 0;
  items.push({
    type: "RENT",
    description:
      `Tiền thuê phòng ${row.room_name} (${format(ctx.periodStart, "MM/yyyy")})` + prorateLabel,
    unit_price: rentAmount,
    quantity: 1,
    coefficient: 1,
    from_date: useProrate ? itemFromDate : undefined,
    to_date: useProrate ? itemToDate : undefined,
    sort_order: order++,
  });
  if (row.electric_amount > 0) {
    const cons = Math.max(consumption, 0);
    items.push({
      service_id: row.elec_service_id,
      type: "SERVICE",
      description: `Tiền điện (${row.prev_reading} → ${row.current_reading || row.prev_reading})`,
      unit_price: cons > 0 ? row.electric_amount / cons : row.electric_amount,
      quantity: cons > 0 ? cons : 1,
      coefficient: 1,
      previous_reading: row.prev_reading,
      current_reading: Number(row.current_reading) || row.prev_reading,
      from_date: ctx.fromDate,
      to_date: ctx.toDate,
      sort_order: order++,
    });
  }
  if (waterAmount > 0) {
    items.push({
      service_id: row.water_service_id,
      type: "SERVICE",
      description: `Tiền nước (${row.occupants} người)` + prorateLabel,
      unit_price: waterAmount,
      quantity: 1,
      coefficient: 1,
      from_date: useProrate ? itemFromDate : undefined,
      to_date: useProrate ? itemToDate : undefined,
      sort_order: order++,
    });
  }
  if (pdvAmount > 0) {
    items.push({
      service_id: row.pdv_service_id,
      type: "SERVICE",
      description: "Phí dịch vụ" + prorateLabel,
      unit_price: pdvAmount,
      quantity: 1,
      coefficient: 1,
      from_date: useProrate ? itemFromDate : undefined,
      to_date: useProrate ? itemToDate : undefined,
      sort_order: order++,
    });
  }
  return items;
}

export function buildInvoiceFormData(
  row: ExcelRowData,
  ctx: SubmitContext,
): InvoiceFormData {
  const appliedCredit = Math.min(
    Math.max(0, row.applied_credit || 0),
    Math.max(0, row.discount || 0),
  );
  return {
    building_id: ctx.buildingId,
    room_id: row.room_id,
    contract_id: row.contract_id,
    billing_month: ctx.billingMonth,
    issue_date: ctx.issueDate,
    due_date: ctx.dueDate,
    discount_amount: row.discount,
    discount_notes: row.discount_notes?.trim() || null,
    applied_credit: appliedCredit,
    electricity_prev_overridden: row.prev_reading_overridden,
    prepaid_amount: 0,
    previous_debt: row.previous_debt || 0,
    // Nếu user đã chỉnh tay → clear sources để DB trigger KHÔNG cascade-paid
    // sai (amount không còn khớp tổng sources). User tự đánh dấu HĐ cũ nếu muốn.
    previous_debt_sources: row.previous_debt_overridden ? [] : (row.previous_debt_sources ?? []),
    notes: null,
    items: buildInvoiceItems(row, ctx),
  };
}
