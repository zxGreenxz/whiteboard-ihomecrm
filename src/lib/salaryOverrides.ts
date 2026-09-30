// Áp khoản định kỳ + số ghi đè vào một SalManager — hàm thuần (testable).
//
// Hai nguồn đọc qua RPC (migration 20260927081925):
//   - salary_recurring_list_v1: khoản định kỳ, server tính sẵn số của kỳ.
//   - salary_line_override_list_v1: số ghi đè đang áp theo (người, khoản).
// Cả hai đã lọc mốc chốt kỳ ở server (kỳ đã chốt chỉ thấy bản ghi tạo trước
// locked_at), nên áp lại ở đây không làm lệch số đã đóng băng.
//
// Kỳ CHƯA chốt: số ghi đè thay số máy tính TRƯỚC salCalc ⇒ thực nhận, chốt kỳ và
// phiếu chi đều dùng số đã sửa (RPC chốt/chi nhận số client gửi).
// Kỳ ĐÃ chốt: calc đọc từ salary_monthly; áp ở đây chỉ để từng dòng hiển thị khớp
// tổng đã đóng băng (lương cứng lấy thẳng số đã chốt, không áp lại).
import type { SalAdjustment, SalAppliedOverride, SalBonusLine, SalCommissionItem, SalInvestBy, SalManager } from "@/lib/managerSalary";
import { z } from "zod";
import type { RecurringItem } from "@/lib/salaryRecurring";

export interface SalLineOverride {
  staffId: string;
  key: string;
  label: string;
  computed: number;
  amount: number;
  reason: string;
  byName: string | null;
  at: string;
}

// numeric của Postgres về dạng number hoặc chuỗi; KHÔNG dùng z.coerce (null → 0 lặng lẽ).
const soTien = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number);

const overrideRowSchema = z.object({
  staff_id: z.string(),
  line_key: z.string(),
  line_label: z.string(),
  computed_amount: soTien,
  amount: soTien,
  reason: z.string(),
  created_by_name: z.string().nullable(),
  created_at: z.string(),
});

/** Kiểm hình dạng hàng salary_line_override_list_v1 tại biên RPC. */
export function parseOverrideRows(rows: unknown): SalLineOverride[] {
  return z.array(overrideRowSchema).parse(rows).map((r) => ({
    staffId: r.staff_id,
    key: r.line_key,
    label: r.line_label,
    computed: r.computed_amount,
    amount: r.amount,
    reason: r.reason,
    byName: r.created_by_name,
    at: r.created_at,
  }));
}

const WORK_ICON_KEY: Record<string, string> = { Flame: "streak", CalendarCheck: "ot", FileClock: "contract" };

/** Khoá ổn định của một dòng thưởng theo việc — khớp CHECK line_key ở server. */
export function bonusLineKey(b: Pick<SalBonusLine, "icon" | "label">): string {
  return WORK_ICON_KEY[b.icon] ?? "job:" + b.label;
}

export const LINE_KEY_RE = /^(base|streak|ot|contract|job:.{1,200}|rec:[0-9a-f-]{36}|sale:[0-9a-f-]{36}|dh:.{1,200})$/;

/** Dòng có sửa được số tiền không (khoá hợp lệ ở server). Khoản trừ/ứng/tiền phòng: không. */
export function isOverridableKey(key: string): boolean {
  return LINE_KEY_RE.test(key);
}

export function recurringAdjustments(items: RecurringItem[], staffId: string): SalAdjustment[] {
  return items
    .filter((it) => it.staffId === staffId && it.amountForPeriod > 0)
    .map((it) => ({
      id: "rec:" + it.id,
      icon: "Plus",
      label: it.category === "SUPPLEMENTARY" && it.buildingName ? `${it.label} · ${it.buildingName}` : it.label,
      amount: it.amountForPeriod,
      note: it.note,
      source: "RECURRING",
      recurring: {
        itemId: it.id,
        category: it.category,
        buildingId: it.buildingId,
        buildingName: it.buildingName,
      },
    }));
}

/** Gộp phân bổ lợi nhuận theo toà: khoá ghi đè là "dh:<toà>", mỗi toà một dòng. */
function investmentByBuilding(list: SalInvestBy[]): SalInvestBy[] {
  const map = new Map<string, number>();
  for (const a of list) map.set(a.b, (map.get(a.b) || 0) + a.amount);
  return [...map.entries()].map(([b, amount]) => ({ b, amount }));
}

/**
 * Trả về bản SalManager MỚI đã gắn khoản định kỳ và số ghi đè. Không gọi salCalc —
 * người gọi tự tính lại calc cho kỳ chưa chốt.
 */
export function applySalaryExtras(
  m: SalManager,
  recurring: RecurringItem[],
  overrides: SalLineOverride[],
): SalManager {
  const locked = m.status === "LOCKED";
  const mine = new Map(overrides.filter((o) => o.staffId === m.id).map((o) => [o.key, o]));
  const applied: Record<string, SalAppliedOverride> = {};
  const take = (key: string, computed: number): number => {
    const o = mine.get(key);
    if (!o) return computed;
    applied[key] = { computed, amount: o.amount, reason: o.reason, byName: o.byName, at: o.at };
    return o.amount;
  };

  // Lương cứng: kỳ chốt dùng số đã đóng băng (đã gồm ghi đè lúc chốt).
  let base = m.base;
  if (locked) {
    const o = mine.get("base");
    if (o) applied.base = { computed: o.computed, amount: o.amount, reason: o.reason, byName: o.byName, at: o.at };
  } else {
    base = take("base", m.base);
  }

  const bonusAuto: SalBonusLine[] = m.bonusAuto.map((b) => ({ ...b, amount: take(bonusLineKey(b), b.amount) }));

  const adjustments: SalAdjustment[] = [
    ...m.adjustments,
    ...recurringAdjustments(recurring, m.id).map((a) => ({ ...a, amount: take(a.id as string, a.amount) })),
  ];

  // Dòng hoa hồng ở sổ thật: phần "đã chi từ sổ X" đi theo số đã sửa, nên sửa tay chỉ
  // đổi thu nhập, không đổi tiền chuyển (xem SalCommissionItem.paidElsewhere).
  const commissionItems: SalCommissionItem[] = m.commissionItems.map((c) => {
    if (!c.voucherId) return c;
    const amount = take("sale:" + c.voucherId, c.amount);
    return c.paidElsewhere ? { ...c, amount, paidElsewhere: amount } : { ...c, amount };
  });
  const investmentBy: SalInvestBy[] = investmentByBuilding(m.investmentBy).map((a) => ({ ...a, amount: take("dh:" + a.b, a.amount) }));

  return {
    ...m,
    base,
    bonusAuto,
    adjustments,
    commissionItems,
    investmentBy,
    // Kỳ chốt: commission/investment giữ số đang có (frozen dùng cho tiền trả).
    commission: locked ? m.commission : commissionItems.reduce((s, c) => s + c.amount, 0),
    investment: locked ? m.investment : investmentBy.reduce((s, a) => s + a.amount, 0),
    overrides: applied,
  };
}
