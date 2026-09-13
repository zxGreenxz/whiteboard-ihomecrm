/**
 * Giá thuê hiển thị của một căn hộ.
 *
 * VÌ SAO CÓ FILE NÀY
 *   `rooms.rent_price` là giá NIÊM YẾT, `contracts.rent_price` là giá THẬT đang
 *   thu. Đo trên production 13/09/2026: 129/292 hợp đồng ACTIVE có hai số lệch
 *   nhau (50 cao hơn, 79 thấp hơn) — 44%. Sơ đồ và danh mục căn hộ trước đây chỉ
 *   đọc giá niêm yết nên hiện sai gần một nửa số phòng đang thuê.
 *
 *   Luật chọn giá nằm ở đây chứ không rải trong ba màn, để ba màn không trôi
 *   khác nhau và để kiểm bằng test thay vì bằng mắt.
 */

export interface RoomPriceInput {
  /** Giá niêm yết của phòng (`rooms.rent_price`). */
  roomRentPrice: number | null | undefined;
  /** Giá trong hợp đồng đang hiệu lực; bỏ trống nếu phòng không có hợp đồng. */
  contractRentPrice: number | null | undefined;
}

export interface RoomPriceDisplay {
  /** Số hiển thị chính, in đậm. */
  primary: number;
  /**
   * Giá niêm yết in mờ bên cạnh. Chỉ khác null khi phòng đang thuê VÀ hai số
   * lệch nhau — in lại con số y hệt chỉ là nhiễu.
   */
  listed: number | null;
}

/**
 * So sánh bằng `!= null` chứ không bằng tính chân trị: giá 0 là con số thật
 * (phòng cho ở miễn phí, hợp đồng quy đổi công) chứ không phải thiếu dữ liệu.
 */
export const resolveRoomPrice = ({
  roomRentPrice,
  contractRentPrice,
}: RoomPriceInput): RoomPriceDisplay => {
  const listed = roomRentPrice ?? null;

  if (contractRentPrice == null) {
    return { primary: listed ?? 0, listed: null };
  }

  return {
    primary: contractRentPrice,
    listed: listed != null && listed !== contractRentPrice ? listed : null,
  };
};
