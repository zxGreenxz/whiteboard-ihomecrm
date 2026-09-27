// Báo cáo cơ cấu quỹ lương vận hành — hàm thuần (testable).
//
// Đọc SalManager (useManagerSalary) và tách phần "lương vận hành" — phần trả từ
// quỹ lương — khỏi HH Sale và Thu nhập đồng hành (hai nhóm này có nguồn chịu
// tiền riêng, brief 26/09/2026 §2.1). Không đổi công thức lương: mọi con số ở
// đây là tổng hợp lại từ các thành phần salCalc/snapshot đã có.
import type { SalManager } from "@/lib/managerSalary";

export type FundGroupKey = "base" | "work" | "extra";

export interface FundLine {
  key: string;
  label: string;
  group: FundGroupKey;
  amount: number;
  /** Lương QL bổ sung — khoản cố định chủ cấp thêm, tách riêng được khi bật công tắc. */
  supplementary: boolean;
  /** Căn cứ của từng người (vd "11 việc × 100.000", nhãn khoản nhập tay). */
  note?: string | null;
}

export interface FundPerson {
  id: string;
  name: string;
  lines: FundLine[];
  total: number;
}

export const FUND_GROUPS: { key: FundGroupKey; label: string; desc: string; color: string }[] = [
  { key: "base", label: "Lương cứng", desc: "Trả theo ngày công", color: "#3d4a57" },
  { key: "work", label: "Thưởng theo công việc", desc: "Trả theo việc đã làm", color: "#188552" },
  { key: "extra", label: "Phụ cấp & lương bổ sung", desc: "Khoản nhập tay / cố định hàng tháng", color: "#1561c1" },
];

export const SUPPLEMENTARY_COLOR = "#7c8da0";

// "Bonus QL" và "lương (QL) bổ sung" hiện được nhập tay trong Thưởng (brief §2.3.1).
// Chưa có cột phân loại nên nhận diện theo nhãn; khoản khác nằm ở Phụ cấp.
export function isSupplementaryLabel(label: string): boolean {
  const n = (label || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
  return /bonus\s*ql\b/.test(n) || /luong\s*(ql\s*|quan\s*ly\s*)?bo\s*sung/.test(n);
}

const WORK_ICON_KEY: Record<string, { key: string; label?: string }> = {
  Flame: { key: "streak", label: "Thưởng chuỗi ngày có việc" },
  CalendarCheck: { key: "ot", label: "Tăng ca CN / lễ có sửa chữa" },
  FileClock: { key: "contract", label: "Ký hợp đồng ngoài giờ" },
};

// Lương cứng của kỳ. Kỳ đã chốt: m.base là cấu hình HIỆN TẠI (v5 còn đổi base
// thành chuyên cần), nên suy ngược từ số đã đóng băng cho khớp gross_total.
export function baseOf(m: SalManager): number {
  if (m.status !== "LOCKED" || !m.calc) return m.base;
  return Math.max(0, m.calc.gross - m.calc.bonus - m.investment - m.commission);
}

export function fundLinesOf(m: SalManager): FundLine[] {
  const out: FundLine[] = [{ key: "base", label: "Lương cứng · chuyên cần", group: "base", amount: baseOf(m), supplementary: false, note: `${m.workdays} ngày công` }];

  let workSum = 0;
  for (const b of m.bonusAuto || []) {
    const mapped = WORK_ICON_KEY[b.icon];
    const key = mapped ? mapped.key : "job:" + b.label;
    const label = mapped?.label ?? "Thưởng việc · " + b.label;
    out.push({ key, label, group: "work", amount: b.amount, supplementary: false, note: b.note });
    workSum += b.amount;
  }

  let adjSum = 0;
  for (const a of m.adjustments || []) {
    if (a.amount < 0) {
      out.push({ key: "deduction", label: "Khoản trừ nhập tay", group: "extra", amount: a.amount, supplementary: false, note: a.label });
    } else {
      const sup = isSupplementaryLabel(a.label);
      out.push({ key: sup ? "supplementary" : "allow:" + a.label, label: sup ? "Lương QL bổ sung" : a.label, group: "extra", amount: a.amount, supplementary: sup, note: a.note ? `${a.label} · ${a.note}` : a.label });
    }
    adjSum += a.amount;
  }

  // Kỳ đã chốt: số chốt là căn cứ. Dòng chi tiết đọc lại từ snapshot/bảng khoản
  // có thể lệch (vd thưởng chuỗi v5 không có trong snapshot) → phần lệch hiện
  // thành một dòng riêng thay vì âm thầm làm tổng sai.
  if (m.status === "LOCKED" && m.calc) {
    const workLocked = m.calc.bonus - m.calc.adjSum;
    if (Math.round(workLocked - workSum) !== 0) {
      out.push({ key: "work-locked", label: "Thưởng khác (theo số đã chốt)", group: "work", amount: workLocked - workSum, supplementary: false });
    }
    if (Math.round(m.calc.adjSum - adjSum) !== 0) {
      out.push({ key: "extra-locked", label: "Thưởng/trừ khác (theo số đã chốt)", group: "extra", amount: m.calc.adjSum - adjSum, supplementary: false });
    }
  }
  return out.filter((l) => Math.round(l.amount) !== 0 || l.key === "base");
}

export function fundPeopleOf(managers: SalManager[]): FundPerson[] {
  return managers.map((m) => {
    const lines = fundLinesOf(m);
    return { id: m.id, name: m.name, lines, total: lines.reduce((s, l) => s + l.amount, 0) };
  });
}

/** Gộp dòng cùng key của nhiều người thành một dòng cho cả kỳ. */
export function mergeLines(people: FundPerson[], excludeSupplementary = false): FundLine[] {
  const map = new Map<string, FundLine>();
  for (const p of people) {
    for (const l of p.lines) {
      if (excludeSupplementary && l.supplementary) continue;
      const cur = map.get(l.key);
      if (cur) cur.amount += l.amount;
      else map.set(l.key, { ...l });
    }
  }
  return [...map.values()];
}

export function groupTotals(lines: FundLine[]): Record<FundGroupKey, number> {
  const t: Record<FundGroupKey, number> = { base: 0, work: 0, extra: 0 };
  for (const l of lines) t[l.group] += l.amount;
  return t;
}

export function supplementaryTotal(people: FundPerson[]): number {
  return people.reduce((s, p) => s + p.lines.filter((l) => l.supplementary).reduce((x, l) => x + l.amount, 0), 0);
}

/**
 * "Cứ 100 đồng trả lương thì …": làm tròn theo phần dư lớn nhất để tổng luôn
 * đúng 100. Phần âm (khoản trừ lớn hơn phụ cấp) coi như 0 trong câu này.
 */
export function per100(values: number[]): number[] {
  const pos = values.map((v) => Math.max(0, v));
  const total = pos.reduce((s, v) => s + v, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = pos.map((v) => (v / total) * 100);
  const floor = raw.map(Math.floor);
  let rest = 100 - floor.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (const o of order) {
    if (rest <= 0) break;
    floor[o.i] += 1;
    rest -= 1;
  }
  return floor;
}

/** Tổng lương vận hành (lương cứng + thưởng + thưởng/trừ nhập tay) của cả kỳ. */
export function operationalTotal(managers: SalManager[]): number {
  return fundPeopleOf(managers).reduce((s, p) => s + p.total, 0);
}

/** Số tiền "triệu" gọn cho báo cáo: 21.900.000 → "21,9tr". */
export function fmtMillion(n: number): string {
  return (Math.round(n / 1e5) / 10).toLocaleString("vi-VN") + "tr";
}
