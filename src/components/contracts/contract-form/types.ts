import { formatCurrency } from "@/lib/utils";
import type { CustomerBasic } from "../CustomerSelectionDialog";
import type { ServiceBasic } from "../ServiceSelectionDialog";

/**
 * Prefill khi mở form từ flow khác (Cọc giữ chỗ → HĐ, Building map → HĐ).
 * Parent PHẢI memo object này (useMemo) để tránh reset form lặp vô hạn.
 */
export interface ContractPrefill {
  buildingId?: string;
  roomId?: string;
  /** Legacy deposits row id; retained for old callers but V2 create does not flip it client-side. */
  depositId?: string;
  /** Tiền cọc đã ghi trên phiếu giữ chỗ — prefill "Đã đặt cọc". */
  depositAmount?: number;
}

// ---- Local state types for customers & services ----

export interface SelectedCustomer extends CustomerBasic {
  is_representative: boolean;
  notes: string | null;
}

export interface SelectedService extends ServiceBasic {
  initial_reading: number;
  quantity: number;
}

/**
 * Mỗi dòng = 1 lần khách đưa cọc → 1 phiếu thu hạng mục "Tiền cọc" (is_deposit)
 * ghi vào SỔ QUỸ THẬT đã chọn (sổ CỌC chỉ là sổ ảo theo dõi, không nhận tiền).
 */
export interface DepositRow {
  /** key React + phân biệt dòng; KHÔNG lưu DB. */
  uid: string;
  amount: number;
  account_id: string;
  received_date: string; // ISO yyyy-mm-dd
  images: string[];
}

let _depositUidSeq = 0;
export const nextDepositUid = () => {
  _depositUidSeq += 1;
  return `dep-${_depositUidSeq}-${Math.floor(performance.now())}`;
};

export const formatVND = (amount: number) => formatCurrency(amount);
