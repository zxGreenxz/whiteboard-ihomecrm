// Khoản lương định kỳ (phụ cấp / lương QL bổ sung) — kiểu + hàm thuần.
//
// Nguồn thật là app_private.salary_recurring_items + _versions, đọc qua RPC
// salary_recurring_list_v1 (migration 20260927081925). Server trả sẵn số của kỳ
// đang xem (amount_for_period). Hàm `recurringAmountFor` ở đây tính lại Y HỆT
// app_private.salary_recurring_amount_v1 để vẽ khung "Tác động" của một phiên bản
// CHƯA lưu — sửa luật ở một bên thì phải sửa bên kia (test khoá cả hai hướng).
import { z } from "zod";

export type RecurringCategory = "ALLOWANCE" | "SUPPLEMENTARY";
export type RecurringKind = "CHANGE" | "ONCE" | "STOP";

export interface RecurringVersion {
  id: string;
  seq: number;
  kind: RecurringKind;
  effectiveMonth: string; // YYYY-MM-01
  amount: number | null;
  reason: string;
  createdByName: string | null;
  createdAt: string;
}

export interface RecurringItem {
  id: string;
  staffId: string;
  staffName: string | null;
  label: string;
  category: RecurringCategory;
  buildingId: string | null;
  buildingName: string | null;
  note: string | null;
  /** Số của kỳ đang xem do SERVER tính (đã xét mốc chốt kỳ). 0 = không phát sinh. */
  amountForPeriod: number;
  periodLocked: boolean;
  versions: RecurringVersion[];
}

// numeric của Postgres về dạng number hoặc chuỗi; KHÔNG dùng z.coerce (null → 0 lặng lẽ).
const soTien = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number);

const versionSchema = z.object({
  id: z.string(),
  seq: soTien,
  kind: z.enum(["CHANGE", "ONCE", "STOP"]),
  effective_month: z.string(),
  amount: soTien.nullable(),
  reason: z.string(),
  created_by_name: z.string().nullable().optional(),
  created_at: z.string(),
});

const rowSchema = z.object({
  item_id: z.string(),
  staff_id: z.string(),
  staff_name: z.string().nullable(),
  label: z.string(),
  category: z.enum(["ALLOWANCE", "SUPPLEMENTARY"]),
  building_id: z.string().nullable(),
  building_name: z.string().nullable(),
  note: z.string().nullable(),
  amount_for_period: soTien,
  period_locked: z.boolean().nullable(),
  versions: z.array(versionSchema),
});

/** Kiểm hình dạng tại biên RPC — sai hình dạng thì ném, không lặng lẽ thành 0đ. */
export function parseRecurringRows(rows: unknown): RecurringItem[] {
  return z.array(rowSchema).parse(rows ?? []).map((r) => ({
    id: r.item_id,
    staffId: r.staff_id,
    staffName: r.staff_name,
    label: r.label,
    category: r.category,
    buildingId: r.building_id,
    buildingName: r.building_name,
    note: r.note,
    amountForPeriod: r.amount_for_period,
    periodLocked: !!r.period_locked,
    versions: r.versions.map((v) => ({
      id: v.id,
      seq: v.seq,
      kind: v.kind,
      effectiveMonth: v.effective_month.slice(0, 7) + "-01",
      amount: v.amount,
      reason: v.reason,
      createdByName: v.created_by_name ?? null,
      createdAt: v.created_at,
    })),
  }));
}

/**
 * Số của khoản cho kỳ `period` (YYYY-MM-01). null = chưa có phiên bản nào phủ kỳ.
 *  - Nền: bản CHANGE/STOP có tháng hiệu lực lớn nhất ≤ kỳ (cùng tháng: seq lớn hơn).
 *  - ONCE đúng tháng thắng nền nếu seq lớn hơn nền.
 */
export function recurringAmountFor(
  versions: Pick<RecurringVersion, "seq" | "kind" | "effectiveMonth" | "amount">[],
  period: string,
): number | null {
  const p = period.slice(0, 7);
  let nen: (typeof versions)[number] | null = null;
  let motKy: (typeof versions)[number] | null = null;
  for (const v of versions) {
    const m = v.effectiveMonth.slice(0, 7);
    if (v.kind === "ONCE") {
      if (m === p && (!motKy || v.seq > motKy.seq)) motKy = v;
    } else if (m <= p) {
      const nm = nen ? nen.effectiveMonth.slice(0, 7) : "";
      if (!nen || m > nm || (m === nm && v.seq > nen.seq)) nen = v;
    }
  }
  if (motKy && (!nen || motKy.seq > nen.seq)) return motKy.amount ?? 0;
  if (!nen) return null;
  return nen.kind === "STOP" ? 0 : nen.amount ?? 0;
}

export const RECURRING_CATEGORY_LABEL: Record<RecurringCategory, string> = {
  ALLOWANCE: "Phụ cấp",
  SUPPLEMENTARY: "Lương QL bổ sung",
};

export const RECURRING_SOURCE_LABEL: Record<RecurringCategory, string> = {
  ALLOWANCE: "Quỹ lương vận hành",
  SUPPLEMENTARY: "Chủ công ty cấp",
};

/** Nguồn "Chủ công ty cấp thêm" của một kỳ: gom khoản bổ sung đang phát sinh theo toà. */
export function ownerSupplementByBuilding(items: RecurringItem[]): {
  rows: { buildingId: string; buildingName: string; amount: number; people: { name: string; label: string; amount: number }[] }[];
  total: number;
} {
  const map = new Map<string, { buildingId: string; buildingName: string; amount: number; people: { name: string; label: string; amount: number }[] }>();
  for (const it of items) {
    if (it.category !== "SUPPLEMENTARY" || it.amountForPeriod <= 0 || !it.buildingId) continue;
    const cur = map.get(it.buildingId) || { buildingId: it.buildingId, buildingName: it.buildingName || "—", amount: 0, people: [] };
    cur.amount += it.amountForPeriod;
    cur.people.push({ name: it.staffName || "—", label: it.label, amount: it.amountForPeriod });
    map.set(it.buildingId, cur);
  }
  const rows = [...map.values()].sort((a, b) => a.buildingName.localeCompare(b.buildingName, "vi"));
  return { rows, total: rows.reduce((s, r) => s + r.amount, 0) };
}
