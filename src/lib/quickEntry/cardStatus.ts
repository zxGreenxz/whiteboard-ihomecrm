// Trạng thái hiển thị của một thẻ nháp trên trang "Báo chi nhanh".
//   draft        — đang sửa, chưa lưu
//   reading      — AI đang đọc ảnh/chữ cho thẻ này
//   saving       — đang gửi máy chủ
//   saved        — máy chủ đã xác nhận (kèm mã phiếu + trạng thái duyệt máy chủ quyết)
//   unknown      — rớt mạng giữa chừng: KHOÁ thẻ, chỉ cho gửi lại y nguyên (cùng khoá chống trùng)
//   maybe_saved  — 23505: có thể đã lưu ở lần trước
//   rejected     — máy chủ từ chối (quyền, sổ khoá…), sửa rồi lưu lại được

export type CardStatusKind = "draft" | "reading" | "saving" | "saved" | "unknown" | "maybe_saved" | "rejected";

export interface CardStatus {
  kind: CardStatusKind;
  message?: string;
  code?: string | null;
  approvalStatus?: string | null;
}

/** Thẻ đã gửi đi (hoặc chưa rõ) thì không được sửa — gửi lại phải y nguyên. */
export const isLocked = (s: CardStatus): boolean =>
  s.kind === "saving" || s.kind === "saved" || s.kind === "unknown" || s.kind === "maybe_saved" || s.kind === "reading";
