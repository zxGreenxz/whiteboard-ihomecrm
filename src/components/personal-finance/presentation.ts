import type { Entity, Snapshot } from "@/lib/personalFinance/contract";
export const money = (n: number) =>
  `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 20 }).format(n)} ₫`;
export const shiftMonth = (month: string, offset: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
export const changedFields = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) =>
  Object.fromEntries(Object.entries(after).filter(([k, v]) => v !== before[k]));
export type RecordData = Record<string, unknown> & {
  id?: string;
  version?: number;
};
export type Editor = {
  entity: Entity;
  record?: RecordData;
  defaults?: Record<string, unknown>;
  remove?: boolean;
};
export type Permissions = { create: boolean; edit: boolean; delete: boolean };
export const emptyFilters = {
  search: "",
  type: "all",
  wallet: "",
  category: "",
};
export const entityLabel: Record<Entity, string> = {
  wallet: "ví",
  category: "danh mục",
  transaction: "giao dịch",
  budget: "hạn mức",
  goal: "mục tiêu",
  transfer: "chuyển ví",
};
export function deleteReason(
  entity: Entity,
  row: RecordData,
  s: Snapshot,
): string | null {
  if (entity === "wallet") {
    if (row.is_default) return "Ví mặc định cần được giữ lại.";
    if (s.goals.some((g) => g.wallet_id === row.id))
      return "Ví đang liên kết mục tiêu.";
    if (
      s.transactions.some((t) => t.resolved_wallet_id === row.id) ||
      s.transfers.some(
        (t) => t.source_wallet_id === row.id || t.target_wallet_id === row.id,
      )
    )
      return "Ví đã có lịch sử giao dịch. Bạn có thể ẩn ví khỏi tổng quan.";
  }
  if (entity === "category") {
    if (
      !row.hidden &&
      s.categories.filter((c) => c.type === row.type && !c.hidden).length <= 1
    )
      return "Cần giữ ít nhất một danh mục hiện cho mỗi loại.";
    if (
      s.transactions.some((t) => t.resolved_category_id === row.id) ||
      s.budgets.some((b) => b.category_id === row.id)
    )
      return "Danh mục đang có giao dịch hoặc hạn mức. Bạn có thể ẩn danh mục.";
  }
  if (entity === "goal" && s.transfers.some((t) => t.goal_id === row.id))
    return "Mục tiêu đã có khoản góp, cần giữ lại lịch sử.";
  if (entity === "transfer" && row.goal_id)
    return "Khoản góp mục tiêu giữ nguyên để bảo toàn lịch sử.";
  return null;
}
