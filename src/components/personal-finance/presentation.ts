import type {
  Entity,
  Snapshot,
  PersonalTransaction,
} from "@/lib/personalFinance/contract";
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
export type CategoryFilter =
  | { kind: "all" }
  | { kind: "id"; id: string }
  | { kind: "legacy"; name: string }
  | { kind: "unclassified" };
export type Filters = {
  search: string;
  type: string;
  wallet: string;
  category: CategoryFilter;
};
export function categoryFilterFor(
  categoryId: string | null,
  legacyName: string | null,
): CategoryFilter {
  if (categoryId !== null) return { kind: "id", id: categoryId };
  return legacyName === null
    ? { kind: "unclassified" }
    : { kind: "legacy", name: legacyName };
}
/** ID values remain UUIDs for native filters; legacy labels cannot collide with them or with all. */
export function categoryFilterValue(filter: CategoryFilter): string {
  if (filter.kind === "all") return "";
  if (filter.kind === "id") return filter.id;
  return filter.kind === "unclassified"
    ? "unclassified"
    : `legacy:${JSON.stringify(filter.name)}`;
}
export function matchesCategoryFilter(
  row: Pick<PersonalTransaction, "resolved_category_id" | "category">,
  filter: CategoryFilter,
): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "id") return row.resolved_category_id === filter.id;
  if (row.resolved_category_id !== null) return false;
  return filter.kind === "unclassified"
    ? row.category === null
    : row.category === filter.name;
}
export const emptyFilters: Filters = {
  search: "",
  type: "all",
  wallet: "",
  category: { kind: "all" },
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
    if (row.seed_key != null)
      return "Danh mục mặc định cần được giữ lại. Bạn có thể ẩn danh mục thay vì xóa.";
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
