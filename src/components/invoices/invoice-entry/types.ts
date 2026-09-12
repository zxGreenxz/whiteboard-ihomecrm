import type { ReactNode } from 'react';
import type { PreviousDebtSource } from '@/types/invoice';
import type { InvoiceEntryController } from './useInvoiceEntry';

export type InvoiceEntryMode = 'edit' | 'create';

/** Dải ngữ cảnh trên đầu form: toà/phòng · đại diện · kỳ · PH → Hạn. */
export interface InvoiceEntryHeaderInfo {
  title: string;
  /** Số hoá đơn đang sửa, hoặc "Hoá đơn mới". */
  invoiceNo: string;
  building: string;
  room: string;
  rep: string;
  lockNote: string;
}

/** Hoá đơn hiện tại (chỉ đối chiếu) — chỉ có ở luồng sửa. */
export interface InvoiceEntryCurrent {
  rentPrice: number;
  rentAmount: number;
  deposit: number;
  electric: number;
  prev: number;
  curr: number | null;
  occupants: number;
  water: number;
  pdv: number;
  total: number;
}

export interface InvoiceEntryPricing {
  elec: number;
  water: number;
  pdv: number;
  waterApplicable: boolean;
  pdvApplicable: boolean;
  hasContractServices: boolean;
}

export interface InvoiceEntryDebt {
  sources: PreviousDebtSource[];
  loading: boolean;
  canReload: boolean;
  onReload: () => void;
}

export type InvoiceEntryVariant = 'desktop' | 'mobile';

/** Ô chọn Toà / Phòng / Hợp đồng — luồng tạo lẻ tự cấp, layout chỉ xếp chỗ. */
export interface InvoiceEntrySelectors {
  building: ReactNode;
  room: ReactNode;
  contract: ReactNode;
}

/** HĐ + kỳ đã có hoá đơn đang hoạt động (luồng tạo). */
export interface InvoiceEntryDuplicate {
  period: string;
  invoiceNo: string;
}

export interface InvoiceEntrySubmit {
  label: string;
  pendingLabel: string;
  pending: boolean;
  disabled: boolean;
}

export interface InvoiceEntryProps {
  mode: InvoiceEntryMode;
  ctl: InvoiceEntryController;
  header: InvoiceEntryHeaderInfo;
  current?: InvoiceEntryCurrent;
  /** Luồng tạo: ô chọn theo biến thể (desktop nhỏ gọn, mobile 44px). */
  selectors?: (variant: InvoiceEntryVariant) => InvoiceEntrySelectors;
  /** Cảnh báo dưới ô hợp đồng (nhiều HĐ cùng phòng, lỗi validate…). */
  selectorsNotice?: string | null;
  duplicate?: InvoiceEntryDuplicate | null;
  pricing: InvoiceEntryPricing;
  meterId: string | null;
  debt: InvoiceEntryDebt;
  creditBalance: number;
  defaultDepositAmount: number;
  /** Luồng tạo: chưa chọn hợp đồng thì chưa mở phần nhập liệu. */
  ready: boolean;
  onResetAll: () => void;
  onCancel: () => void;
  footNote: string;
  submit: InvoiceEntrySubmit;
}
