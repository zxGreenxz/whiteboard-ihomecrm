import { useEffect, useMemo } from 'react';
import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import {
  computeEntryTotals,
  diffEntryValues,
  findDepositIndex,
  type EntryCustomItem,
  type EntryDiff,
  type EntryTotals,
  type InvoiceEntryValues,
} from '@/lib/invoiceEntry';
import type { InvoiceEntryPricing } from './types';

export type ExtraKind = 'SERVICE' | 'OTHER';

export interface InvoiceEntrySetters {
  billingMonth: (v: string) => void;
  issueDate: (v: string) => void;
  dueDate: (v: string) => void;
  rent: (n: number) => void;
  occupants: (n: number) => void;
  stepOccupants: (delta: number) => void;
  prev: (n: number) => void;
  curr: (n: number | null) => void;
  electric: (n: number) => void;
  water: (n: number) => void;
  pdv: (n: number) => void;
  depositToggle: (on: boolean, defaultAmount: number) => void;
  depositNote: (s: string) => void;
  depositAmount: (n: number) => void;
  addExtra: () => void;
  removeExtra: (index: number) => void;
  extraKind: (index: number, kind: ExtraKind) => void;
  extraDescription: (index: number, s: string) => void;
  extraQuantity: (index: number, n: number) => void;
  extraPrice: (index: number, n: number) => void;
  discount: (n: number) => void;
  discountNotes: (s: string) => void;
  debt: (n: number) => void;
  notes: (s: string) => void;
  periodStart: (v: string) => void;
  periodEnd: (v: string) => void;
  clearPeriod: () => void;
}

export interface ExtraRow {
  /** Vị trí thật trong custom_items (dùng cho setter). */
  index: number;
  key: string;
  item: EntryCustomItem;
}

export interface InvoiceEntryController {
  v: InvoiceEntryValues;
  totals: EntryTotals;
  diff: EntryDiff;
  kwh: number;
  depositIndex: number;
  deposit: EntryCustomItem | null;
  extras: ExtraRow[];
  set: InvoiceEntrySetters;
}

interface Options {
  /** Giá trị gốc để đánh dấu ô đã đổi. */
  baseline: InvoiceEntryValues;
  pricing: InvoiceEntryPricing;
  /** false khi chưa có hợp đồng (luồng tạo): không tự tính điện/nước lên form trống. */
  active?: boolean;
}

/**
 * Nối react-hook-form với bộ nhập liệu chung. Form có thể mang thêm trường
 * (vd contract_id ở luồng tạo) — chỉ các khoá của InvoiceEntryValues được đụng.
 */
export function useInvoiceEntry<T extends InvoiceEntryValues>(
  form: UseFormReturn<T>,
  { baseline, pricing, active = true }: Options,
): InvoiceEntryController {
  const f = form as unknown as UseFormReturn<InvoiceEntryValues>;
  const { setValue, watch, control } = f;
  const { fields, append, remove } = useFieldArray({ control, name: 'custom_items' });

  const v = watch();
  const items = v.custom_items ?? [];

  const occupants = v.occupants || 0;
  const prev = v.prev_reading || 0;
  const curr = v.current_reading;
  const electricOverridden = v.electric_overridden;
  const waterOverridden = v.water_overridden;
  const electricAmount = v.electric_amount || 0;
  const waterAmount = v.water_amount || 0;

  // Tiền điện theo chỉ số khi người dùng chưa gõ tay số tiền.
  useEffect(() => {
    if (!active || electricOverridden) return;
    const consumption = Math.max(0, (Number(curr) || 0) - prev);
    const next = consumption * pricing.elec;
    if (next !== electricAmount) setValue('electric_amount', next);
  }, [active, curr, prev, pricing.elec, electricOverridden, electricAmount, setValue]);

  // Tiền nước theo số người khi chưa gõ tay; HĐ không đăng ký nước → giữ 0.
  useEffect(() => {
    if (!active || waterOverridden) return;
    const next = pricing.waterApplicable ? occupants * pricing.water : 0;
    if (next !== waterAmount) setValue('water_amount', next);
  }, [active, occupants, pricing.water, pricing.waterApplicable, waterOverridden, waterAmount, setValue]);

  const totals = useMemo(() => computeEntryTotals(v), [v]);
  const diff = useMemo(() => diffEntryValues(v, baseline), [v, baseline]);
  const depositIndex = findDepositIndex(items);
  const deposit = depositIndex >= 0 ? items[depositIndex] : null;
  const extras: ExtraRow[] = items
    .map((item, index) => ({ item, index, key: fields[index]?.id ?? String(index) }))
    .filter((row) => row.index !== depositIndex);

  const patchItem = (index: number, patch: Partial<EntryCustomItem>) => {
    const next = [...items];
    next[index] = { ...next[index], ...patch };
    setValue('custom_items', next, { shouldDirty: true });
  };

  const set: InvoiceEntrySetters = {
    billingMonth: (val) => setValue('billing_month', val, { shouldValidate: true, shouldDirty: true }),
    issueDate: (val) => setValue('issue_date', val, { shouldValidate: true, shouldDirty: true }),
    dueDate: (val) => setValue('due_date', val, { shouldValidate: true, shouldDirty: true }),
    rent: (n) => setValue('rent_price', n, { shouldDirty: true }),
    occupants: (n) => {
      setValue('occupants', n, { shouldDirty: true });
      setValue('water_overridden', false);
    },
    stepOccupants: (delta) => {
      const n = Math.max(1, (v.occupants || 1) + delta);
      setValue('occupants', n, { shouldDirty: true });
      setValue('water_overridden', false);
    },
    prev: (n) => {
      setValue('prev_reading', n ?? 0, { shouldDirty: true });
      setValue('prev_reading_overridden', true);
      setValue('electric_overridden', false);
    },
    curr: (n) => {
      setValue('current_reading', n, { shouldDirty: true });
      setValue('electric_overridden', false);
    },
    electric: (n) => {
      setValue('electric_amount', n, { shouldDirty: true });
      setValue('electric_overridden', true);
    },
    water: (n) => {
      setValue('water_amount', n, { shouldDirty: true });
      setValue('water_overridden', true);
    },
    pdv: (n) => setValue('pdv_amount', n, { shouldDirty: true }),
    depositToggle: (on, defaultAmount) => {
      if (on && depositIndex < 0) {
        append({
          type: 'OTHER',
          accounting_class: 'DEPOSIT',
          description: 'Tiền cọc',
          quantity: 1,
          unit_price: defaultAmount || 0,
        });
      } else if (!on && depositIndex >= 0) {
        remove(depositIndex);
      }
    },
    depositNote: (s) => {
      if (depositIndex >= 0) patchItem(depositIndex, { description: s });
    },
    depositAmount: (n) => {
      if (depositIndex >= 0) patchItem(depositIndex, { unit_price: n, quantity: 1 });
    },
    addExtra: () =>
      append({ type: 'OTHER', accounting_class: 'REVENUE', description: '', quantity: 1, unit_price: 0 }),
    removeExtra: (index) => remove(index),
    // Chỉ đổi loại; phân loại kế toán là mặc định của hạng mục, không đụng vào.
    extraKind: (index, kind) => patchItem(index, { type: kind }),
    extraDescription: (index, s) => patchItem(index, { description: s }),
    extraQuantity: (index, n) => patchItem(index, { quantity: n }),
    extraPrice: (index, n) => patchItem(index, { unit_price: n }),
    discount: (n) => setValue('discount_amount', n, { shouldDirty: true }),
    discountNotes: (s) => setValue('discount_notes', s, { shouldDirty: true }),
    debt: (n) => {
      setValue('previous_debt', n, { shouldDirty: true });
      setValue('previous_debt_overridden', true);
    },
    notes: (s) => setValue('notes', s, { shouldDirty: true }),
    periodStart: (val) => setValue('period_start_date', val || null, { shouldDirty: true }),
    periodEnd: (val) => setValue('period_end_date', val || null, { shouldDirty: true }),
    clearPeriod: () => {
      setValue('period_start_date', null, { shouldDirty: true });
      setValue('period_end_date', null, { shouldDirty: true });
    },
  };

  return {
    v,
    totals,
    diff,
    kwh: Math.max(0, (Number(curr) || 0) - prev),
    depositIndex,
    deposit,
    extras,
    set,
  };
}
