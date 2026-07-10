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
   *            cảnh báo "Chưa có hoá đơn".
   */
  kind: "vacant" | "active";
  /** Nhãn lý do trống: "Bỏ cọc" / "Thanh lý HĐ" / "Chuyển phòng" / … (chỉ 'vacant'). */
  reason?: string;
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
