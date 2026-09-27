// Hoa hồng quản lý đi sổ ảo, trả qua lương (migration 20260927155251, phương án A).
import { describe, expect, it } from "vitest";
import {
  classifyCommissionVouchers,
  commissionFlaggedNote,
  commissionItemNote,
  commissionPaidElsewhere,
  salCalc,
  type CommissionVoucherMeta,
  type CommissionVoucherRow,
  type SalManager,
} from "@/lib/managerSalary";
import { applySalaryExtras, type SalLineOverride } from "@/lib/salaryOverrides";

const NATHAN = "df8d1df5-1c24-4723-9733-4640c43c382b";
const JOEY = "d45a7506-5250-4d99-ac94-9f73cbd4df17";
const NGOAI = "9b3f7c10-0000-4000-8000-00000000000a"; // quản lý không có trong danh sách tháng
const KY = "2026-09-01";

const row = (id: string, p: Partial<CommissionVoucherRow> = {}): CommissionVoucherRow =>
  ({ id, name: "Hoa hồng " + id, status: "UNAPPROVED", amount: 1_000_000, payerName: "nathan", ...p });
const meta = (id: string, p: Partial<CommissionVoucherMeta> = {}): CommissionVoucherMeta => ({
  voucher_id: id, manager_id: null, account_id: "acc-tk939", account_name: "TK939", on_manager_book: false,
  included_staff_id: null, included_period: null, ...p,
});

const alias = new Map([["nathan", NATHAN], ["joey", JOEY]]);
const staff = new Set([NATHAN, JOEY]);
const chia = (rows: CommissionVoucherRow[], metas: CommissionVoucherMeta[]) =>
  classifyCommissionVouchers(rows, new Map(metas.map((x) => [x.voucher_id, x])), alias, staff, KY);

describe("classifyCommissionVouchers", () => {
  it("sổ ảo quản lý → trả qua lương (paidElsewhere 0), cả đã duyệt", () => {
    const r = chia([row("v1", { status: "APPROVED" })], [meta("v1", { manager_id: NATHAN, on_manager_book: true, account_name: "Hoa hồng QL chờ trả lương" })]);
    const it0 = r.get(NATHAN)!.items[0];
    expect(it0).toMatchObject({ approved: true, assigned: true, paidElsewhere: 0, paidFrom: null });
  });

  it("phương án A: phiếu ĐÃ duyệt ở sổ thật vẫn vào thu nhập, nhưng đánh dấu đã chi từ sổ đó", () => {
    const r = chia([row("v2", { status: "APPROVED", amount: 1_620_000 })], [meta("v2")]);
    expect(r.get(NATHAN)!.items[0]).toMatchObject({ approved: true, assigned: false, paidElsewhere: 1_620_000, paidFrom: "TK939" });
    expect(r.get(NATHAN)!.flagged).toEqual([]);
  });

  it("liên kết ô QL thắng khớp tên người nhận", () => {
    const r = chia([row("v3", { payerName: "nathan" })], [meta("v3", { manager_id: JOEY, on_manager_book: true })]);
    expect(r.get(JOEY)!.items.map((x) => x.voucherId)).toEqual(["v3"]);
    expect(r.get(NATHAN)).toBeUndefined();
  });

  it("đã gán cho quản lý NGOÀI danh sách → không rơi về khớp tên", () => {
    const r = chia([row("v4", { payerName: "nathan" })], [meta("v4", { manager_id: NGOAI, on_manager_book: true })]);
    expect(r.size).toBe(0);
  });

  it("không liên kết, không khớp tên → bỏ qua", () => {
    expect(chia([row("v5", { payerName: "khách lẻ" })], [meta("v5")]).size).toBe(0);
  });

  it("lưới an toàn: meta trả nhầm dấu kỳ KHÁC → vẫn flagged, không cộng", () => {
    const r = chia([row("v6")], [meta("v6", { manager_id: NATHAN, on_manager_book: true, included_staff_id: NATHAN, included_period: "2026-08-01" })]);
    expect(r.get(NATHAN)!.items).toEqual([]);
    expect(r.get(NATHAN)!.flagged[0].includedElsewhere).toEqual({ staffId: NATHAN, period: "2026-08-01" });
  });

  it("đã tính cho NGƯỜI khác cùng kỳ → flagged", () => {
    const r = chia([row("v7")], [meta("v7", { included_staff_id: JOEY, included_period: KY })]);
    expect(r.get(NATHAN)!.flagged.map((x) => x.voucherId)).toEqual(["v7"]);
  });

  it("dấu của chính người + chính kỳ (tháng đã chốt) → vẫn là khoản của kỳ", () => {
    const r = chia([row("v8", { status: "APPROVED" })], [meta("v8", { manager_id: NATHAN, on_manager_book: true, included_staff_id: NATHAN, included_period: KY })]);
    expect(r.get(NATHAN)!.items.map((x) => x.voucherId)).toEqual(["v8"]);
  });

  it("thiếu meta (không có dòng) → coi là sổ thật, không phải trả qua lương", () => {
    const r = classifyCommissionVouchers([row("v9")], new Map(), alias, staff, KY);
    expect(r.get(NATHAN)!.items[0]).toMatchObject({ paidElsewhere: 1_000_000, paidFrom: null, assigned: false });
  });
});

describe("salCalc trừ hoa hồng đã chi từ sổ thật", () => {
  const base = { base: 6_000_000, investment: 0, advance: 500_000, roomRent: 2_000_000 };
  it("sổ ảo: cả gross lẫn thực nhận đều có", () => {
    const c = salCalc({ ...base, commission: 1_000_000, commissionItems: [{ label: "a", amount: 1_000_000, approved: true, paidElsewhere: 0 }] });
    expect(c.gross).toBe(7_000_000);
    expect(c.takehome).toBe(7_000_000 - 500_000 - 2_000_000);
  });
  it("sổ thật: gross có, thực nhận không (không chuyển lần hai)", () => {
    const c = salCalc({ ...base, commission: 1_000_000, commissionItems: [{ label: "a", amount: 1_000_000, approved: true, paidElsewhere: 1_000_000 }] });
    expect(c.gross).toBe(7_000_000);
    expect(c.takehome).toBe(6_000_000 - 500_000 - 2_000_000);
  });
  it("không truyền commissionItems → như cũ", () => {
    expect(salCalc({ ...base, commission: 0 }).takehome).toBe(6_000_000 - 2_500_000);
    expect(commissionPaidElsewhere(undefined)).toBe(0);
  });
});

describe("ghi đè số tiền dòng hoa hồng sổ thật", () => {
  const VID = "0e0f3c2a-1111-4222-8333-944455556666";
  const m = (): SalManager => ({
    id: "s1", name: "NATHAN", short: "Nathan", alias: "", role: "QL", initials: "N", tone: "primary",
    workdays: 25, base: 6_000_000, roomRent: 0, incomeGoal: 0, bonusAuto: [], adjustments: [],
    investment: 0, investmentBy: [], investmentLocked: true,
    commission: 1_000_000,
    commissionItems: [{ label: "HH", amount: 1_000_000, approved: true, voucherId: VID, paidElsewhere: 1_000_000, paidFrom: "TK939" }],
    commissionFlagged: [], advance: 0, advanceItems: [], roomRentItems: [], roomRentInvoice: null,
    paid: 0, stats: { jobs: 0, repairs: 0, afterHour: 0, workdays: 25, streak: 0 }, trend: [],
    status: "DRAFT", salaryMonthlyId: null, ledger: [], frozen: null, organizationId: "org",
  });
  const ovr = (amount: number): SalLineOverride =>
    ({ staffId: "s1", key: "sale:" + VID, label: "HH", computed: 1_000_000, amount, reason: "lý do", byName: "Chủ", at: "2026-09-27T08:00:00Z" });

  it("sửa về 0 không kéo tiền chuyển xuống (không thu hồi ngầm)", () => {
    const before = salCalc(m()).takehome;
    const after = applySalaryExtras(m(), [], [ovr(0)]);
    expect(after.commissionItems[0]).toMatchObject({ amount: 0, paidElsewhere: 0 });
    expect(salCalc(after).takehome).toBe(before);
  });
  it("sửa tăng chỉ đổi thu nhập, không đổi tiền chuyển", () => {
    const before = salCalc(m());
    const after = salCalc(applySalaryExtras(m(), [], [ovr(1_200_000)]));
    expect(after.gross).toBe(before.gross + 200_000);
    expect(after.takehome).toBe(before.takehome);
  });
});

describe("dòng mô tả", () => {
  it("bốn trạng thái + kỳ chốt", () => {
    expect(commissionItemNote({ label: "", amount: 1, approved: false, paidElsewhere: 0 }, false)).toBe("chờ duyệt · trả qua lương khi chốt");
    expect(commissionItemNote({ label: "", amount: 1, approved: true, paidElsewhere: 0 }, false)).toBe("đã duyệt · trả qua lương");
    expect(commissionItemNote({ label: "", amount: 1, approved: true, paidElsewhere: 1, paidFrom: "TK939" }, false)).toBe("đã chi từ sổ TK939 — không chuyển lại");
    expect(commissionItemNote({ label: "", amount: 1, approved: false, paidElsewhere: 1, paidFrom: "ATam" }, false)).toBe("chưa gán QL — khi duyệt chi từ sổ ATam");
    expect(commissionItemNote({ label: "", amount: 1, approved: true, paidElsewhere: 1, paidFrom: "TK939" }, true)).toBe("đã chốt · đã chi từ sổ TK939");
    expect(commissionFlaggedNote({ label: "", amount: 1, approved: true, includedElsewhere: { staffId: "x", period: "2026-08-01" } })).toBe("đã tính vào lương người khác kỳ 08/2026 — không cộng lại");
  });
});
