// Sổ quỹ mặc định cho thẻ "Báo chi nhanh" — CHỈ trong các sổ người dùng đang giữ tiền
// (list_cashbooks_for_expense_v2). Chọn sổ khác thì create_income_expense_v1 từ chối 42501 và phiếu
// rơi sang đường compat luôn Chờ duyệt, không qua bộ máy chi.
// Thứ tự: sổ gắn sẵn cho toà (`accounts.quick_default_building_id`, như Tạo phiếu nhanh) → sổ dùng
// lần trước → sổ mặc định → sổ đầu tiên.

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
