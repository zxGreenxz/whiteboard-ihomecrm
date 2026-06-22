// Tìm kiếm ưu tiên theo MÃ PHÒNG cho ô tìm kiếm Thu chi & Hoá đơn.
//
// Quy ước: mã phòng là token cố định ngắn — chỉ một trong các dạng:
//   - MB, MB1, MB2, MB02…   (mặt bằng, "MB" + tuỳ chọn vài chữ số)
//   - G01, G02…             (gác,  "G" + ≥1 chữ số)
//   - L01, L02…             (lửng, "L" + ≥1 chữ số)
//   - 01, 02 … 101, 102…    (số phòng 1–3 chữ số)
//
// Hành vi: nếu chuỗi tìm kiếm KHỚP dạng mã phòng VÀ thật sự có phòng tên đó →
// lọc theo phòng (room_ids). NGƯỢC LẠI (không phải mã phòng, hoặc là số nhưng
// không có phòng nào) → quay về tìm theo SỐ TIỀN (±tolerance) hoặc TÊN/MÃ phiếu
// như cũ. Vì số tiền thật luôn ≥ 4 chữ số nên cách này không phá tìm-theo-tiền.

// Sai số khi lọc theo số tiền: ±5.000đ (khớp giá trị cũ trong useIncomeExpenses).
export const AMOUNT_SEARCH_TOLERANCE = 5000;

// Dạng cố định của mã phòng (case-insensitive).
export const ROOM_CODE_REGEX = /^(?:MB\d*|G\d+|L\d+|\d{1,3})$/i;

/** Chuỗi tìm kiếm có TRÔNG GIỐNG một mã phòng hay không (chưa kiểm tra tồn tại). */
export function isRoomCodeQuery(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return ROOM_CODE_REGEX.test(raw.trim());
}

export type SearchMode = "none" | "room" | "amount" | "text";

export interface ResolvedSearch {
  /** room_ids để lọc khi tìm theo mã phòng; null = không tìm theo phòng. */
  roomIds: string[] | null;
  /** Số tiền mục tiêu (±AMOUNT_SEARCH_TOLERANCE); null = không tìm theo tiền. */
  amountTarget: number | null;
  /** Text tìm theo tên/mã phiếu; undefined = không tìm theo text. */
  text: string | undefined;
  /** Đang chờ tra cứu phòng (room lookup) → tạm coi như rỗng, hiện loading. */
  pending: boolean;
  mode: SearchMode;
}

const EMPTY: ResolvedSearch = {
  roomIds: null,
  amountTarget: null,
  text: undefined,
  pending: false,
  mode: "none",
};

// Sentinel room_id trong lúc đang tra cứu phòng → trả danh sách rỗng (tránh nháy
// kết quả tìm-theo-tiền/text rồi mới thu hẹp). PHẢI là UUID hợp lệ (cột room_id
// kiểu uuid) nhưng không phòng nào mang giá trị này → Postgres không báo lỗi 400.
export const ROOM_LOOKUP_PENDING_SENTINEL =
  "00000000-0000-0000-0000-000000000000";

/**
 * Quyết định cách tìm kiếm từ chuỗi nhập + kết quả tra cứu phòng.
 *
 * @param raw         Chuỗi người dùng gõ.
 * @param roomLookup  Kết quả useRoomIdsByCode: undefined = chưa có (đang tải hoặc
 *                    chuỗi không phải mã phòng nên hook bị disable); mảng = đã tra.
 */
export function resolveSearch(
  raw: string,
  roomLookup: string[] | undefined,
): ResolvedSearch {
  const trimmed = raw.trim();
  if (!trimmed) return EMPTY;

  if (isRoomCodeQuery(trimmed)) {
    if (roomLookup === undefined) {
      // Đang tra cứu phòng — coi như mã phòng, kết quả tạm rỗng.
      return {
        roomIds: [ROOM_LOOKUP_PENDING_SENTINEL],
        amountTarget: null,
        text: undefined,
        pending: true,
        mode: "room",
      };
    }
    if (roomLookup.length > 0) {
      return {
        roomIds: roomLookup,
        amountTarget: null,
        text: undefined,
        pending: false,
        mode: "room",
      };
    }
    // Khớp dạng mã phòng nhưng KHÔNG có phòng nào → rơi xuống tìm tiền/text.
  }

  // Số → tìm theo tiền; còn lại → tìm theo text (tên/mã phiếu).
  const cleaned = trimmed.replace(/[\s.,đdĐ]/g, "");
  if (/^\d+$/.test(cleaned)) {
    const amount = Number(cleaned);
    if (amount > 0) {
      return {
        roomIds: null,
        amountTarget: amount,
        text: undefined,
        pending: false,
        mode: "amount",
      };
    }
  }
  return {
    roomIds: null,
    amountTarget: null,
    text: trimmed,
    pending: false,
    mode: "text",
  };
}
