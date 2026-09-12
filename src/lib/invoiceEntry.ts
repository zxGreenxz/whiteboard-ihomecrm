/**
 * Bộ nhập liệu hoá đơn dùng chung cho hai luồng "Sửa hoá đơn" (nháp) và
 * "Tạo hoá đơn lẻ". Module thuần (không React) để test được từng công thức:
 *  - tổng tiền khớp save-side (useCreateInvoice / useUpdateInvoice),
 *  - dựng invoice_items từ form (kể cả prorate theo ngày thuê thực tế),
 *  - tách hoá đơn hiện có ngược về form (decompose) và giữ nguyên số tiền
 *    đã lưu khi người dùng không đụng vào ô đó.
 */
import { format, isValid, parse, startOfMonth, endOfMonth } from 'date-fns';
import * as z from 'zod';
import type { InvoiceFormData, InvoiceWithRelations } from '@/types/invoice';
import { roundInvoiceTotal } from '@/lib/invoiceUtils';
import { calcProratedDays, prorateAmount } from '@/lib/prorateCalculation';

export const PRORATE_MONTH_DAYS = 30;

export type EntryItemType = 'RENT' | 'SERVICE' | 'PENALTY' | 'DISCOUNT' | 'OTHER';
export type EntryAccountingClass = 'REVENUE' | 'DEPOSIT' | 'NON_PNL';

export interface EntryCustomItem {
  /** id dòng đã lưu (luồng điều chỉnh) — null/undefined là dòng mới. */
  id?: string | null;
  type: EntryItemType;
  accounting_class?: EntryAccountingClass;
  description: string;
  quantity: number;
  unit_price: number;
  /** Hệ số đã lưu; mặc định 1. Form không cho sửa, chỉ giữ nguyên. */
  coefficient?: number;
  service_id?: string | null;
}

export const entryCustomItemSchema = z.object({
  id: z.string().nullable().optional(),
  type: z.enum(['RENT', 'SERVICE', 'PENALTY', 'DISCOUNT', 'OTHER']),
  accounting_class: z.enum(['REVENUE', 'DEPOSIT', 'NON_PNL']).optional(),
  description: z.string().min(1, 'Vui lòng nhập mô tả'),
  quantity: z.number().min(0.0001, 'Số lượng phải > 0'),
  unit_price: z.number().min(0),
  coefficient: z.number().min(0).optional(),
  service_id: z.string().nullable().optional(),
});

export const invoiceEntrySchema = z.object({
  billing_month: z.string().regex(/^\d{4}-\d{2}$/, 'Định dạng YYYY-MM'),
  issue_date: z.string().min(1, 'Vui lòng chọn ngày phát hành'),
  due_date: z.string().min(1, 'Vui lòng chọn hạn thanh toán'),
  rent_price: z.number().min(0).default(0),
  occupants: z.number().min(1).default(1),
  prev_reading: z.number().min(0).default(0),
  prev_reading_overridden: z.boolean().default(false),
  current_reading: z.number().nullable().default(null),
  electric_amount: z.number().min(0).default(0),
  electric_overridden: z.boolean().default(false),
  water_amount: z.number().min(0).default(0),
  water_overridden: z.boolean().default(false),
  pdv_amount: z.number().min(0).default(0),
  custom_items: z.array(entryCustomItemSchema).default([]),
  notes: z.string().optional(),
  discount_amount: z.number().min(0).default(0),
  discount_notes: z.string().nullable().optional(),
  applied_credit: z.number().min(0).optional(),
  previous_debt: z.number().min(0).default(0),
  previous_debt_overridden: z.boolean().default(false),
  period_start_date: z.string().nullable().optional(),
  period_end_date: z.string().nullable().optional(),
});

export interface InvoiceEntryValues {
  billing_month: string;
  issue_date: string;
  due_date: string;
  rent_price: number;
  occupants: number;
  prev_reading: number;
  prev_reading_overridden: boolean;
  current_reading: number | null;
  electric_amount: number;
  electric_overridden: boolean;
  water_amount: number;
  water_overridden: boolean;
  pdv_amount: number;
  custom_items: EntryCustomItem[];
  notes?: string;
  discount_amount: number;
  discount_notes?: string | null;
  applied_credit?: number;
  previous_debt: number;
  previous_debt_overridden: boolean;
  period_start_date?: string | null;
  period_end_date?: string | null;
}

/** Giá trị rỗng có đủ khoá — dùng để tạo defaultValues rồi phủ lên. */
export function makeEntryValues(patch: Partial<InvoiceEntryValues> = {}): InvoiceEntryValues {
  return {
    billing_month: '',
    issue_date: '',
    due_date: '',
    rent_price: 0,
    occupants: 1,
    prev_reading: 0,
    prev_reading_overridden: false,
    current_reading: null,
    electric_amount: 0,
    electric_overridden: false,
    water_amount: 0,
    water_overridden: false,
    pdv_amount: 0,
    custom_items: [],
    notes: '',
    discount_amount: 0,
    discount_notes: '',
    applied_credit: 0,
    previous_debt: 0,
    previous_debt_overridden: false,
    period_start_date: null,
    period_end_date: null,
    ...patch,
  };
}

/** Thành tiền một dòng khoản thu thêm: đơn giá × số lượng × hệ số (mặc định 1). */
export function customLineAmount(it: EntryCustomItem): number {
  return (it.quantity || 0) * (it.unit_price || 0) * (it.coefficient ?? 1);
}

/** Dòng "Tiền cọc" chuẩn của ô Tiền cọc: loại Khác + hạch toán DEPOSIT. */
export function isDepositItem(item: EntryCustomItem): boolean {
  return item.type === 'OTHER' && item.accounting_class === 'DEPOSIT';
}

export function findDepositIndex(items: readonly EntryCustomItem[]): number {
  return items.findIndex(isDepositItem);
}

export interface EntryTotals {
  days: number;
  isProrated: boolean;
  rent: number;
  electric: number;
  water: number;
  pdv: number;
  /** Khoản thu thêm (mọi dòng custom trừ dòng cọc chuẩn). */
  extras: number;
  /** Dòng cọc chuẩn — vẫn nằm trong tạm tính như hai hộp thoại cũ. */
  deposit: number;
  subtotal: number;
  total: number;
}

/** Số ngày thuê thực tế của form (0 = không prorate). */
export function calcProratedDaysOf(v: InvoiceEntryValues): number {
  return calcProratedDays(v.period_start_date, v.period_end_date);
}

export function computeEntryTotals(v: InvoiceEntryValues): EntryTotals {
  const days = calcProratedDaysOf(v);
  const isProrated = days > 0;
  const rent = isProrated ? prorateAmount(v.rent_price, days) : v.rent_price;
  const water = isProrated ? prorateAmount(v.water_amount, days) : v.water_amount;
  const pdv = isProrated ? prorateAmount(v.pdv_amount, days) : v.pdv_amount;
  const electric = v.electric_amount || 0;
  let extras = 0;
  let deposit = 0;
  for (const it of v.custom_items ?? []) {
    const line = customLineAmount(it);
    if (isDepositItem(it)) deposit += line;
    else extras += line;
  }
  const subtotal = rent + electric + water + pdv + extras + deposit;
  // total = tạm tính − giảm trừ + nợ cũ — KHỚP công thức save-side; làm tròn
  // phần lẻ: <900đ → xuống, ≥900đ → lên bội số 1000.
  const total = roundInvoiceTotal(
    Math.max(0, subtotal - (v.discount_amount || 0) + (v.previous_debt || 0)),
  );
  return { days, isProrated, rent, electric, water, pdv, extras, deposit, subtotal, total };
}

/** Số tiền đã lưu của hoá đơn đang sửa — để không làm lệch tiền khi không đụng ô. */
export interface EntryBaselineAmounts {
  rent_price: number;
  water_amount: number;
  pdv_amount: number;
  days: number;
  rentAmount: number;
  waterAmount: number;
  pdvAmount: number;
}

export interface BuildItemsContext {
  elecServiceId: string | null;
  waterServiceId: string | null;
  pdvServiceId: string | null;
  /** Mô tả dòng tiền phòng (không kèm nhãn prorate cũng được — sẽ chuẩn hoá). */
  rentDescription?: string;
  baseline?: EntryBaselineAmounts;
}

const PRORATE_LABEL_RE = /\s*\(\d+\/\d+ ngày\)\s*$/;

function stripProrateLabel(desc: string): string {
  return desc.replace(PRORATE_LABEL_RE, '').trim();
}

/** Đầu/cuối tháng của kỳ; kỳ không hợp lệ (vd luồng điều chỉnh không gửi kỳ) → không gắn ngày. */
function monthBounds(billingMonth: string): { fromDate: string | undefined; toDate: string | undefined } {
  const periodStart = startOfMonth(parse((billingMonth || '') + '-01', 'yyyy-MM-dd', new Date()));
  if (!isValid(periodStart)) return { fromDate: undefined, toDate: undefined };
  return {
    fromDate: format(periodStart, 'yyyy-MM-dd'),
    toDate: format(endOfMonth(periodStart), 'yyyy-MM-dd'),
  };
}

export type EntryStructuredRole = 'rent' | 'electric' | 'water' | 'pdv';

export interface EntryStructuredLine {
  role: EntryStructuredRole;
  item: InvoiceFormData['items'][number];
}

/**
 * Dựng các dòng cấu trúc (phòng / điện / nước / PDV) từ form, chưa đánh sort_order.
 * Với hoá đơn đang sửa, ô nào (và kỳ prorate) không đổi so với baseline thì giữ
 * đúng số tiền đã lưu để lần lưu "không đụng gì" tái tạo nguyên hoá đơn.
 */
export function buildStructuredLines(
  v: InvoiceEntryValues,
  ctx: BuildItemsContext,
): EntryStructuredLine[] {
  const { fromDate, toDate } = monthBounds(v.billing_month);
  const days = calcProratedDays(v.period_start_date, v.period_end_date);
  const useProrate = days > 0;
  const itemFrom = useProrate ? v.period_start_date! : fromDate;
  const itemTo = useProrate ? v.period_end_date! : toDate;
  const label = useProrate ? ` (${days}/${PRORATE_MONTH_DAYS} ngày)` : '';
  const b = ctx.baseline;
  const keep = (field: keyof Pick<EntryBaselineAmounts, 'rent_price' | 'water_amount' | 'pdv_amount'>) =>
    !!b && b.days === days && b[field] === v[field];

  const rentAmount = keep('rent_price') ? b!.rentAmount : useProrate ? prorateAmount(v.rent_price, days) : v.rent_price;
  const waterAmount = keep('water_amount') ? b!.waterAmount : useProrate ? prorateAmount(v.water_amount, days) : v.water_amount;
  const pdvAmount = keep('pdv_amount') ? b!.pdvAmount : useProrate ? prorateAmount(v.pdv_amount, days) : v.pdv_amount;

  const lines: EntryStructuredLine[] = [];
  const periodFields = useProrate ? { from_date: itemFrom, to_date: itemTo } : { from_date: undefined, to_date: undefined };

  lines.push({ role: 'rent', item: {
    type: 'RENT',
    accounting_class: 'REVENUE',
    description: stripProrateLabel(ctx.rentDescription || 'Tiền thuê') + label,
    unit_price: rentAmount,
    quantity: 1,
    coefficient: 1,
    ...periodFields,
    sort_order: 0,
  } });

  const prev = Number(v.prev_reading) || 0;
  const curr = v.current_reading == null ? null : Number(v.current_reading);
  const consumption = Math.max(0, (curr ?? prev) - prev);
  if (v.electric_amount > 0) {
    // Ghi số lượng = kWh chỉ khi tiền điện chia hết cho kWh (đơn giá nguyên đồng);
    // không thì 1 dòng đúng số tiền — tránh đơn giá lẻ làm amount = u×q lệch xu.
    const perKwh = consumption > 0 && v.electric_amount % consumption === 0;
    lines.push({ role: 'electric', item: {
      service_id: ctx.elecServiceId,
      type: 'SERVICE',
      accounting_class: 'REVENUE',
      description: `Tiền điện (${prev} → ${curr ?? prev})`,
      unit_price: perKwh ? v.electric_amount / consumption : v.electric_amount,
      quantity: perKwh ? consumption : 1,
      coefficient: 1,
      previous_reading: prev,
      current_reading: curr ?? prev,
      from_date: fromDate,
      to_date: toDate,
      sort_order: 0,
    } });
  }
  if (waterAmount > 0) {
    const occ = v.occupants || 1;
    // Chia theo đầu người chỉ khi chia hết — tránh đơn giá lẻ làm amount lệch xu.
    const perHead = occ > 1 && waterAmount % occ === 0;
    lines.push({ role: 'water', item: {
      service_id: ctx.waterServiceId,
      type: 'SERVICE',
      accounting_class: 'REVENUE',
      description: `Tiền nước (${occ} người)` + label,
      unit_price: perHead ? waterAmount / occ : waterAmount,
      quantity: perHead ? occ : 1,
      coefficient: 1,
      ...periodFields,
      sort_order: 0,
    } });
  }
  if (pdvAmount > 0) {
    lines.push({ role: 'pdv', item: {
      service_id: ctx.pdvServiceId,
      type: 'SERVICE',
      accounting_class: 'REVENUE',
      description: 'Phí dịch vụ' + label,
      unit_price: pdvAmount,
      quantity: 1,
      coefficient: 1,
      ...periodFields,
      sort_order: 0,
    } });
  }
  return lines;
}

/** Dựng toàn bộ invoice_items (cấu trúc + khoản thu thêm) với sort_order tuần tự. */
export function buildInvoiceItems(
  v: InvoiceEntryValues,
  ctx: BuildItemsContext,
): InvoiceFormData['items'] {
  let order = 0;
  const items: InvoiceFormData['items'] = buildStructuredLines(v, ctx).map(({ item }) => ({
    ...item,
    sort_order: order++,
  }));
  for (const ci of v.custom_items ?? []) {
    items.push({
      service_id: ci.service_id || null,
      type: ci.type,
      accounting_class: ci.accounting_class,
      description: ci.description,
      unit_price: ci.unit_price,
      quantity: ci.quantity,
      coefficient: ci.coefficient ?? 1,
      sort_order: order++,
    });
  }
  return items;
}

export type InvoiceSourceItem = NonNullable<InvoiceWithRelations['invoice_items']>[number];

export interface DecomposedInvoice {
  values: InvoiceEntryValues;
  baseline: EntryBaselineAmounts;
  rentDescription: string;
  /** Dòng gốc của từng ô cấu trúc — luồng điều chỉnh dùng để giữ nguyên dòng không đụng. */
  sources: Partial<Record<EntryStructuredRole, InvoiceSourceItem>>;
  /** Toàn bộ dòng gốc theo sort_order (tra theo id khi điều chỉnh). */
  allItems: InvoiceSourceItem[];
}

type LooseItem = InvoiceSourceItem;

function itemAmount(it: LooseItem): number {
  const coef = it.coefficient == null ? 1 : Number(it.coefficient);
  return (Number(it.unit_price) || 0) * (Number(it.quantity) || 1) * (Number.isFinite(coef) ? coef : 1);
}

/** Suy ngược giá trọn tháng từ số tiền đã prorate: amount / days × 30. */
function fullFromProrated(amount: number, days: number): number {
  return days > 0 ? Math.round((amount * PRORATE_MONTH_DAYS) / days) : amount;
}

/**
 * Tách invoice_items của hoá đơn đang sửa về các ô cấu trúc (phòng/điện/nước/
 * PDV) + phần còn lại là khoản thu thêm. Dòng ngoài doanh thu (DEPOSIT/NON_PNL)
 * không bao giờ bị ép vào ô cấu trúc — giữ nguyên metadata.
 */
export function decomposeInvoice(invoice: InvoiceWithRelations): DecomposedInvoice {
  let rentAmount = 0;
  let rentDescription = 'Tiền thuê';
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let electric = 0;
  let prev = 0;
  let curr: number | null = null;
  let waterAmount = 0;
  let occupants = 1;
  let pdvAmount = 0;
  const custom: EntryCustomItem[] = [];
  const sources: DecomposedInvoice['sources'] = {};

  const ordered = (invoice.invoice_items ?? [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.id).localeCompare(String(b.id)));
  for (const it of ordered) {
    const desc = (it.description || '').toLowerCase();
    const isRevenue = !it.accounting_class || it.accounting_class === 'REVENUE';
    if (isRevenue && it.type === 'RENT' && !sources.rent) {
      sources.rent = it;
      rentAmount = itemAmount(it);
      rentDescription = it.description || rentDescription;
      if (it.from_date && it.to_date) {
        periodStart = it.from_date;
        periodEnd = it.to_date;
      }
      continue;
    }
    if (isRevenue && it.type === 'SERVICE') {
      if (desc.includes('điện') && !sources.electric) {
        sources.electric = it;
        electric = itemAmount(it);
        prev = Number(it.previous_reading) || 0;
        curr = it.current_reading == null ? null : Number(it.current_reading);
        continue;
      }
      if (desc.includes('nước') && !sources.water) {
        sources.water = it;
        waterAmount = itemAmount(it);
        const qty = Number(it.quantity) || 1;
        const fromDesc = /\((\d+)\s*người\)/.exec(it.description || '');
        occupants = qty > 1 ? qty : fromDesc ? Number(fromDesc[1]) || 1 : 1;
        continue;
      }
      if (desc.includes('dịch vụ') && !sources.pdv) {
        sources.pdv = it;
        pdvAmount = itemAmount(it);
        continue;
      }
    }
    const coef = it.coefficient == null ? 1 : Number(it.coefficient);
    custom.push({
      id: it.id ?? null,
      type: (['RENT', 'SERVICE', 'PENALTY', 'DISCOUNT'] as string[]).includes(it.type) ? it.type : 'OTHER',
      accounting_class: it.accounting_class,
      description: it.description,
      quantity: Number(it.quantity) || 1,
      unit_price: Number(it.unit_price) || 0,
      ...(coef !== 1 ? { coefficient: coef } : {}),
      service_id: it.service_id ?? undefined,
    });
  }

  const days = calcProratedDays(periodStart, periodEnd);
  const rentPrice = fullFromProrated(rentAmount, days);
  const waterFull = fullFromProrated(waterAmount, days);
  const pdvFull = fullFromProrated(pdvAmount, days);

  const values = makeEntryValues({
    billing_month: invoice.billing_month,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    rent_price: rentPrice,
    occupants,
    prev_reading: prev,
    prev_reading_overridden: !!invoice.electricity_prev_overridden,
    current_reading: curr,
    electric_amount: electric,
    electric_overridden: true, // sửa hoá đơn: tôn trọng số đã lưu cho tới khi đổi chỉ số
    water_amount: waterFull,
    water_overridden: true,
    pdv_amount: pdvFull,
    custom_items: custom,
    notes: invoice.notes || '',
    discount_amount: invoice.discount_amount || 0,
    discount_notes: invoice.discount_notes || '',
    applied_credit: 0,
    previous_debt: invoice.previous_debt || 0,
    previous_debt_overridden: false,
    period_start_date: periodStart,
    period_end_date: periodEnd,
  });

  return {
    values,
    baseline: {
      rent_price: rentPrice,
      water_amount: waterFull,
      pdv_amount: pdvFull,
      days,
      rentAmount,
      waterAmount,
      pdvAmount,
    },
    rentDescription,
    sources,
    allItems: ordered,
  };
}

export type EntryStructuredField =
  | 'rent_price'
  | 'occupants'
  | 'prev_reading'
  | 'current_reading'
  | 'electric_amount'
  | 'water_amount'
  | 'pdv_amount';

const STRUCTURED_FIELDS: EntryStructuredField[] = [
  'rent_price',
  'occupants',
  'prev_reading',
  'current_reading',
  'electric_amount',
  'water_amount',
  'pdv_amount',
];

export interface EntryDiff {
  fields: Set<EntryStructuredField>;
  extrasChanged: boolean;
  otherChanged: boolean;
  count: number;
}

const sameItems = (a: EntryCustomItem[], b: EntryCustomItem[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return (
      x.type === y.type &&
      (x.accounting_class ?? 'REVENUE') === (y.accounting_class ?? 'REVENUE') &&
      x.description === y.description &&
      x.quantity === y.quantity &&
      x.unit_price === y.unit_price &&
      (x.coefficient ?? 1) === (y.coefficient ?? 1)
    );
  });

/** So form với giá trị gốc: từng ô cấu trúc, khoản thu thêm, và phần còn lại. */
export function diffEntryValues(v: InvoiceEntryValues, base: InvoiceEntryValues): EntryDiff {
  const fields = new Set<EntryStructuredField>();
  for (const f of STRUCTURED_FIELDS) {
    if ((v[f] ?? null) !== (base[f] ?? null)) fields.add(f);
  }
  const extrasChanged = !sameItems(v.custom_items ?? [], base.custom_items ?? []);
  const otherChanged =
    (v.discount_amount || 0) !== (base.discount_amount || 0) ||
    (v.previous_debt || 0) !== (base.previous_debt || 0) ||
    v.billing_month !== base.billing_month ||
    v.issue_date !== base.issue_date ||
    v.due_date !== base.due_date ||
    (v.period_start_date || null) !== (base.period_start_date || null) ||
    (v.period_end_date || null) !== (base.period_end_date || null);
  return {
    fields,
    extrasChanged,
    otherChanged,
    count: fields.size + (extrasChanged ? 1 : 0) + (otherChanged ? 1 : 0),
  };
}

export const formatVnd = (n: number): string =>
  new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));
export const formatVndSuffix = (n: number): string => `${formatVnd(n)} đ`;

/** dd/MM từ ISO yyyy-MM-dd; '—' khi trống. */
export function shortDay(iso?: string | null): string {
  if (!iso) return '—';
  const p = iso.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}` : iso;
}
/** dd/MM/yyyy từ ISO; '—' khi trống. */
export function fullDay(iso?: string | null): string {
  if (!iso) return '—';
  const p = iso.split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}
/** MM/yyyy từ yyyy-MM. */
export function monthLabel(ym?: string | null): string {
  if (!ym) return '—';
  const p = ym.split('-');
  return p.length >= 2 ? `${p[1]}/${p[0]}` : ym;
}

/** Đơn giá mặc định của toà từ building_services (dùng chung Sửa / Tạo lẻ / Excel). */
export interface BuildingServiceRow {
  is_active?: boolean | null;
  service_id: string;
  unit_price_override?: number | string | null;
  service?: { name?: string | null; unit_price?: number | string | null } | null;
}

export function resolveBuildingDefaults(rows: readonly BuildingServiceRow[] | undefined) {
  let elec = 3500;
  let water = 100000;
  let pdv = 150000;
  let elecServiceId: string | null = null;
  let waterServiceId: string | null = null;
  let pdvServiceId: string | null = null;
  for (const bs of (rows ?? []).filter((b) => b.is_active)) {
    const name = bs.service?.name?.toLowerCase() ?? '';
    const price = bs.unit_price_override ?? bs.service?.unit_price ?? 0;
    if (name.includes('điện')) {
      elec = Number(price) || elec;
      elecServiceId = bs.service_id;
    } else if (name.includes('nước')) {
      water = Number(price) || water;
      waterServiceId = bs.service_id;
    } else if (name.includes('dịch vụ') || name.includes('phí')) {
      pdv = Number(price) || pdv;
      pdvServiceId = bs.service_id;
    }
  }
  return { elec, water, pdv, elecServiceId, waterServiceId, pdvServiceId };
}
