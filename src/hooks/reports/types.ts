// Shared exported types cho các hook báo cáo (tách từ useReports.ts — Phase 10B,
// di chuyển nguyên văn, không đổi hành vi).

export interface VacantRoomNote {
  roomId: string;
  roomName: string;
  buildingId: string;
  buildingName: string;
  /**
   * 'vacant' = phòng KHÔNG còn HĐ (trống thật) → ghi chú "Trống phòng — <reason>".
   * 'active' = phòng CÒN HĐ ACTIVE (đã tới kỳ xuất HĐ) → nếu thiếu hoá đơn thì
   *            cảnh báo "Chưa có hoá đơn". Từ 22/10 kèm `invoiceState` (đọc bảng
   *            invoices theo contract_id) để tách "chưa có hoá đơn" với "có hoá
   *            đơn, chưa thu".
   * 'ended_unsettled' = HĐ kết thúc GIỮA tháng mà chưa có thanh lý (hoặc thanh lý
   *            chưa duyệt và thiếu hoá đơn cuối). CHỈ có khi gọi
   *            useVacantRoomNotes(..., { includeEndedContracts: true }); khoá Map
   *            là `ended:<contractId>` (không phải roomId) vì phòng có thể đã có
   *            ghi chú khác hoặc HĐ mới.
   */
  kind: "vacant" | "active" | "ended_unsettled";
  /** Nhãn lý do trống: "Bỏ cọc" / "Thanh lý HĐ" / "Chuyển phòng" / … (chỉ 'vacant'). */
  reason?: string;
  /** Ngày bắt đầu trống 'YYYY-MM-DD' — ngày khách rời (chỉ 'vacant'; null nếu không rõ). */
  vacantSince?: string | null;

  // ── 'active': hoá đơn TIỀN PHÒNG (kind MONTHLY, chưa huỷ/xoá) kỳ này của các HĐ
  //    làm phòng "còn HĐ" — khớp theo contract_id, không theo room_id. ──
  /**
   * 'none'    = chưa có hoá đơn kỳ này (nhãn cũ "Chưa có hoá đơn" chỉ đúng ở đây);
   * 'unpaid'  = có hoá đơn, chưa thu đồng nào;
   * 'partial' = đã thu một phần; 'paid' = đã thu đủ.
   */
  invoiceState?: "none" | "unpaid" | "partial" | "paid";
  invoiceIds?: string[];
  invoiceTotal?: number;
  invoicePaid?: number;
  /** Σ còn phải thu (total − paid, không âm) của các hoá đơn trên. */
  invoiceRemaining?: number;
  /** Có hoá đơn đang OVERDUE / quá hạn. */
  invoiceOverdue?: boolean;

  // ── 'ended_unsettled' ──
  contractId?: string;
  contractNumber?: string | null;
  /** Ngày HĐ kết thúc thật 'YYYY-MM-DD' (actual_end_date, không có thì end_date). */
  endedOn?: string | null;
  /** Không có bản ghi contract_terminations (chưa huỷ) nào cho HĐ. */
  missingTermination?: boolean;
  /** Có hoá đơn (mọi loại, chưa huỷ/xoá) kỳ này cho HĐ. */
  hasFinalInvoice?: boolean;
  /** Σ còn phải thu trên các hoá đơn kỳ này của HĐ. */
  finalInvoiceRemaining?: number;
}

export interface RenewalTransferRow {
  id: string;
  type: "RENEWAL" | "TRANSFER";
  contract_number: string;
  customer: string;
  building: string;
  building_id: string | null;
  room: string;
  date: string;
  rent_price: number;
}
