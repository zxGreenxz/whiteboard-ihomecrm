// =============================================
// Resolve sổ quỹ NHẬN TIỀN MẶT (TM) cho người đang đăng nhập.
//
// Quy tắc (dùng chung cho trang Thu tiền + RecordPaymentDialog):
//   1. Sổ tên kết thúc "Thu" do CHÍNH user sở hữu — nếu user có NHIỀU sổ
//      "…Thu" thì ưu tiên sổ đánh dấu mặc định (is_default), nếu không có
//      sổ mặc định mới lấy sổ đầu danh sách (theo tên A→Z của useAccounts).
//   2. Sổ "Chung".
//   3. Sổ trùng tên toà nhà của hoá đơn.
//
// is_default cho phép user sở hữu >1 sổ "…Thu" (vd giữ sổ dành cho NV tạo
// sau) mà vẫn quyết định được sổ thu rơi vào sổ nào — không phụ thuộc thứ
// tự bảng chữ cái.
// =============================================

export interface CashAccountLite {
  id: string;
  user_id?: string | null;
  name?: string | null;
  is_default?: boolean | null;
}

const endsWithThu = (name?: string | null) => (name ?? '').trim().endsWith('Thu');

/** Sổ "…Thu" của user (ưu tiên is_default, fallback sổ đầu danh sách). '' nếu không có. */
export const ownCashAccountId = <T extends CashAccountLite>(
  accounts: T[],
  userId?: string | null,
): string => {
  if (!userId) return '';
  const own = accounts.filter((a) => a.user_id === userId && endsWithThu(a.name));
  return (own.find((a) => a.is_default) ?? own[0])?.id ?? '';
};

/** Sổ nhận TM: own "…Thu" → "Chung" → sổ trùng tên toà. '' nếu không resolve được. */
export const resolveTmAccountId = <T extends CashAccountLite>(
  accounts: T[],
  userId?: string | null,
  buildingName?: string | null,
): string => {
  const own = ownCashAccountId(accounts, userId);
  if (own) return own;
  const chung = accounts.find((a) => (a.name ?? '').trim().toLowerCase() === 'chung');
  if (chung) return chung.id;
  const bn = (buildingName ?? '').trim();
  if (bn) return accounts.find((a) => (a.name ?? '').trim() === bn)?.id ?? '';
  return '';
};
