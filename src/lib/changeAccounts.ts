// Sổ quỹ "Thối" (ghi nhận tiền thối) gắn theo từng nhân viên.
// Mỗi staff chỉ thao tác trên sổ Thối của chính mình để tránh bấm lộn sổ của
// đồng nghiệp (hai nhân viên thấy sổ của nhau qua RLS co-staff cùng chủ).

export const JOEY_USER_ID = 'd45a7506-5250-4d99-ac94-9f73cbd4df17'; // Hiển
export const NATHAN_USER_ID = 'df8d1df5-1c24-4723-9733-4640c43c382b'; // Hiệp

// user_id → tên sổ Thối riêng của họ
const OWN_CHANGE_ACCOUNT_BY_USER: Record<string, string> = {
  [JOEY_USER_ID]: 'Hiển Thối',
  [NATHAN_USER_ID]: 'Hiệp Thối',
};

/** Tên sổ Thối riêng của user; null nếu user không nằm trong map (vd super admin). */
export const ownChangeAccountName = (userId?: string | null): string | null =>
  (userId && OWN_CHANGE_ACCOUNT_BY_USER[userId]) || null;

/**
 * Danh sách sổ hiển thị trong ô "Sổ ghi nhận tiền thối".
 * - Staff có map (Hiển/Hiệp): chỉ đúng sổ Thối của họ → hết bấm lộn.
 * - User khác (super admin, staff mới): giữ nguyên toàn bộ danh sách như cũ.
 */
export const changeAccountOptions = <T extends { name?: string | null }>(
  accounts: T[],
  userId?: string | null,
): T[] => {
  const own = ownChangeAccountName(userId);
  if (!own) return accounts;
  return accounts.filter((a) => (a.name ?? '').trim() === own);
};

/**
 * Sổ Thối mặc định khi phát sinh tiền thối.
 * - Staff có map: sổ Thối của chính họ.
 * - User khác: sổ đầu tiên có tên kết thúc "Thối" (giữ hành vi cũ).
 */
export const findOwnChangeAccount = <
  T extends { id: string; name?: string | null },
>(
  accounts: T[],
  userId?: string | null,
): T | undefined => {
  const own = ownChangeAccountName(userId);
  if (own) return accounts.find((a) => (a.name ?? '').trim() === own);
  return accounts.find((a) => (a.name ?? '').trim().endsWith('Thối'));
};
