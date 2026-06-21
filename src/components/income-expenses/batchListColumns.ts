import { useCallback, useEffect, useState } from 'react';

// Cột bảng "Phiếu tổng (gom nhóm)" có thể ẩn/hiện. "Thao tác" và "Tên đợt" luôn
// hiển thị (cốt lõi) nên không nằm trong danh sách này.
export type BatchColumnKey =
  | 'code'
  | 'amount'
  | 'building'
  | 'room'
  | 'date'
  | 'payer'
  | 'account'
  | 'count';

export interface BatchColumnDef {
  key: BatchColumnKey;
  label: string;
  defaultVisible: boolean;
}

export const BATCH_COLUMNS: BatchColumnDef[] = [
  // Mặc định ẩn mã phiếu (Đợt) — trạng thái đã chuyển sang cột Thao tác.
  { key: 'code', label: 'Mã phiếu (Đợt)', defaultVisible: false },
  { key: 'amount', label: 'Tổng tiền', defaultVisible: true },
  { key: 'building', label: 'Tòa nhà', defaultVisible: true },
  { key: 'room', label: 'Phòng', defaultVisible: true },
  { key: 'date', label: 'Ngày', defaultVisible: true },
  { key: 'payer', label: 'Người nhận/nộp', defaultVisible: true },
  { key: 'account', label: 'Sổ quỹ', defaultVisible: true },
  { key: 'count', label: 'Số phiếu', defaultVisible: true },
];

export type BatchColumnVisibility = Record<BatchColumnKey, boolean>;

const STORAGE_KEY = 'ie-batch-list-column-visibility-v1';

const buildDefaults = (): BatchColumnVisibility =>
  BATCH_COLUMNS.reduce((acc, col) => {
    acc[col.key] = col.defaultVisible;
    return acc;
  }, {} as BatchColumnVisibility);

export function useBatchColumnVisibility() {
  const [visibility, setVisibility] = useState<BatchColumnVisibility>(() => {
    const defaults = buildDefaults();
    if (typeof window === 'undefined') return defaults;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw) as Partial<BatchColumnVisibility>;
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

  const toggle = useCallback((key: BatchColumnKey) => {
    setVisibility((v) => ({ ...v, [key]: !v[key] }));
  }, []);

  const reset = useCallback(() => {
    setVisibility(buildDefaults());
  }, []);

  return { visibility, toggle, reset };
}
