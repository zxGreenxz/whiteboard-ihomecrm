// Sổ quỹ được chọn trong hộp Chi lợi nhuận.
//   OWNER (chủ, quyền chi lợi nhuận): mọi sổ TIỀN THẬT của đúng công ty cổ đông.
//   SELF_ADVANCE (chỉ có quyền tạm ứng): giao thêm với sổ người dùng đang GIỮ (CUSTODIAN) —
//     list_my_cashbook_access_v2 không lọc công ty, nên lọc công ty bằng danh sách sổ (accounts).
// Máy chủ (E4/E5) kiểm lại cả hai luật; lọc ở đây để không mời người dùng chọn sổ sẽ bị từ chối.

export type ProfitPayoutMode = 'OWNER' | 'SELF_ADVANCE';

export interface PayoutAccountLike {
  id: string;
  name: string;
  code?: string | null;
  organization_id?: string | null;
  is_virtual?: boolean | null;
}

export interface CashbookAccessLike {
  cashbook_id: string;
  possession_kind: string;
}

export function profitPayoutAccounts<T extends PayoutAccountLike>(input: {
  mode: ProfitPayoutMode;
  organizationId: string | null;
  accounts: readonly T[];
  /** Bắt buộc ở SELF_ADVANCE; thiếu (đang tải / lỗi) ⇒ không có sổ nào. */
  access?: readonly CashbookAccessLike[] | null;
}): T[] {
  const { mode, organizationId, accounts, access } = input;
  if (!organizationId) return [];
  // Sổ ảo (CỌC giữ hộ, cấn trừ…) không có két tiền thật — không bao giờ chi lợi nhuận từ đó.
  const real = accounts.filter((account) => !account.is_virtual).filter((account) => account.organization_id === organizationId);
  if (mode === 'OWNER') return real;
  if (!access) return [];
  const held = new Set(access.filter((row) => row.possession_kind === 'CUSTODIAN').map((row) => row.cashbook_id));
  return real.filter((account) => held.has(account.id));
}
