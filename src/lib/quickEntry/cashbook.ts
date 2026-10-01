// Sổ quỹ mặc định cho thẻ "Báo chi nhanh" — CHỈ trong các sổ người dùng đang giữ tiền
// (list_cashbooks_for_expense_v2). Chọn sổ khác thì create_income_expense_v1 từ chối 42501 và phiếu
// rơi sang đường compat luôn Chờ duyệt, không qua bộ máy chi.
// Thứ tự: sổ gắn sẵn cho toà (`accounts.quick_default_building_id`, như Tạo phiếu nhanh) → sổ dùng
// lần trước → sổ mặc định → sổ đầu tiên.

/**
 * `list_cashbooks_for_expense_v2()` KHÔNG nhận tham số công ty — nó trả mọi sổ người dùng giữ qua mọi
 * công ty, chỉ có id + tên. Người thuộc nhiều công ty sẽ được chọn sẵn sổ của công ty khác và writer từ
 * chối. Giao với danh sách sổ có `organization_id` để chỉ giữ sổ của công ty đang chọn, bỏ sổ ảo
 * (khuôn SettlementLifecycleModal). Thiếu công ty hoặc chưa tải danh sách sổ ⇒ rỗng, không đoán.
 */
export function expenseCashbooksForOrg<T extends { id: string }>(
  custodian: readonly T[],
  accounts: readonly { id: string; organization_id?: string | null; is_virtual?: boolean | null }[] | undefined,
  orgId: string | null,
): T[] {
  if (!orgId || !accounts) return [];
  const ok = new Set(accounts.filter((a) => a.organization_id === orgId && !a.is_virtual).map((a) => a.id));
  return custodian.filter((c) => ok.has(c.id));
}

export interface AccountHint {
  id: string;
  is_default: boolean;
  quick_default_building_id: string | null;
}

export function pickDefaultAccount(opts: {
  buildingId: string | null;
  usableIds: string[];
  accounts: AccountHint[];
  lastUsedId: string | null;
}): string | null {
  const usable = new Set(opts.usableIds);
  const held = opts.accounts.filter((a) => usable.has(a.id));
  if (opts.buildingId) {
    const forBuilding = held.find((a) => a.quick_default_building_id === opts.buildingId);
    if (forBuilding) return forBuilding.id;
  }
  if (opts.lastUsedId && usable.has(opts.lastUsedId)) return opts.lastUsedId;
  return held.find((a) => a.is_default)?.id ?? opts.usableIds[0] ?? null;
}
