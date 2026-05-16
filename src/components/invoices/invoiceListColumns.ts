import { useCallback, useEffect, useState } from 'react';

export type InvoiceColumnKey =
  | 'tien_thue'
  | 'dien'
  | 'nuoc'
  | 'pdv'
  | 'giam_tru'
  | 'tong_tien'
  | 'da_thanh_toan'
  | 'con_no'
  | 'no_cong_don'
  | 'han_tt'
  | 'nguoi_tao';

export interface InvoiceColumnDef {
  key: InvoiceColumnKey;
  label: string;
  defaultVisible: boolean;
}

export const INVOICE_COLUMNS: InvoiceColumnDef[] = [
  { key: 'tien_thue', label: 'Tiền thuê', defaultVisible: true },
  { key: 'dien', label: 'Điện', defaultVisible: true },
  { key: 'nuoc', label: 'Nước', defaultVisible: true },
  { key: 'pdv', label: 'PDV', defaultVisible: true },
  { key: 'giam_tru', label: 'Giảm trừ', defaultVisible: true },
  { key: 'tong_tien', label: 'Tổng tiền', defaultVisible: true },
  { key: 'da_thanh_toan', label: 'Đã thanh toán', defaultVisible: true },
  { key: 'con_no', label: 'Còn nợ', defaultVisible: true },
  { key: 'no_cong_don', label: 'Nợ cộng dồn', defaultVisible: false },
  { key: 'han_tt', label: 'Hạn TT', defaultVisible: false },
  { key: 'nguoi_tao', label: 'Người tạo', defaultVisible: false },
];

export type InvoiceColumnVisibility = Record<InvoiceColumnKey, boolean>;

const STORAGE_KEY = 'invoice-list-column-visibility-v1';

const buildDefaults = (): InvoiceColumnVisibility =>
  INVOICE_COLUMNS.reduce((acc, col) => {
    acc[col.key] = col.defaultVisible;
    return acc;
  }, {} as InvoiceColumnVisibility);

export function useInvoiceColumnVisibility() {
  const [visibility, setVisibility] = useState<InvoiceColumnVisibility>(() => {
    const defaults = buildDefaults();
    if (typeof window === 'undefined') return defaults;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw) as Partial<InvoiceColumnVisibility>;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility));
    } catch {
      // ignore
    }
  }, [visibility]);

  const toggle = useCallback((key: InvoiceColumnKey) => {
    setVisibility((v) => ({ ...v, [key]: !v[key] }));
  }, []);

  const reset = useCallback(() => {
    setVisibility(buildDefaults());
  }, []);

  return { visibility, toggle, reset };
}
