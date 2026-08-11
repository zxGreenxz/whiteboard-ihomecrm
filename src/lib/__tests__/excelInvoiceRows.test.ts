// Characterization test cho excelInvoiceRows (Phase 9C) — CHỐT hành vi logic
// inline cũ của ExcelInvoiceDialog TRƯỚC khi UI chuyển sang dùng lib. Mọi giá
// trị kỳ vọng ở đây trace tay từ code cũ (commit trước 9C) — nếu test này đỏ
// sau refactor nghĩa là behavior ĐÃ ĐỔI, phải soi lại.
import { describe, expect, it } from "vitest";
import {
  resolveBuildingDefaults,
  dedupeContractsByRoom,
  buildLastReadingByMeter,
  buildCreditByContract,
  buildPreviousDebtByContract,
  buildInvoiceCountByContract,
  buildExcelRows,
  reresolveRowPricing,
  computeExcelRowTotal,
  buildInvoiceItems,
  buildInvoiceFormData,
  type ExcelRowData,
  type RawContract,
  type SubmitContext,
} from "@/lib/excelInvoiceRows";
import { PREVIOUS_DEBT_ROUND_THRESHOLD } from "@/lib/invoiceHelpers";

const DEFAULTS = {
  elec: 3500, water: 100000, pdv: 150000,
  elecServiceId: "svc-e", waterServiceId: "svc-w", pdvServiceId: "svc-p",
};

const baseRow = (over: Partial<ExcelRowData> = {}): ExcelRowData => ({
  contract_id: "c1", room_id: "r1", room_name: "101",
  rent_price: 3000000, occupants: 2,
  meter_id: "m1", prev_reading: 100, prev_reading_overridden: false,
  current_reading: 150,
  electric_amount: 175000, electric_overridden: false,
  water_amount: 200000, water_overridden: false,
  pdv_amount: 150000, pdv_overridden: false,
  elec_rate: 3500, elec_service_id: "svc-e",
  water_rate: 100000, water_service_id: "svc-w", water_applicable: true,
  pdv_rate: 150000, pdv_service_id: "svc-p", pdv_applicable: true,
  services_raw: [],
  discount: 0, discount_notes: "", applied_credit: 0, credit_balance: 0,
  previous_debt: 0, previous_debt_sources: [], previous_debt_overridden: false,
  period_start_date: null, period_end_date: null, selected: true,
  ...over,
});

const CTX: SubmitContext = {
  buildingId: "b1", billingMonth: "2026-07",
  issueDate: "2026-07-10", dueDate: "2026-08-10",
  periodStart: new Date(2026, 6, 1),
  fromDate: "2026-07-01", toDate: "2026-07-31",
};

describe("resolveBuildingDefaults", () => {
  it("chỉ lấy dịch vụ is_active; ưu tiên unit_price_override; nhận diện điện/nước/PDV theo tên", () => {
    const d = resolveBuildingDefaults([
      { is_active: true, service_id: "e1", unit_price_override: 3800, service: { name: "Điện 3k8", unit_price: 3500 } },
      { is_active: false, service_id: "e2", unit_price_override: null, service: { name: "Điện cũ", unit_price: 9999 } },
      { is_active: true, service_id: "w1", unit_price_override: null, service: { name: "Nước", unit_price: 120000 } },
      { is_active: true, service_id: "p1", unit_price_override: null, service: { name: "Phí dịch vụ", unit_price: 180000 } },
    ]);
    expect(d).toEqual({
      elec: 3800, elecServiceId: "e1",
      water: 120000, waterServiceId: "w1",
      pdv: 180000, pdvServiceId: "p1",
    });
  });
  it("không có dịch vụ nào → fallback hardcode 3500/100000/150000, serviceId null", () => {
    expect(resolveBuildingDefaults([])).toEqual({
      elec: 3500, water: 100000, pdv: 150000,
      elecServiceId: null, waterServiceId: null, pdvServiceId: null,
    });
  });
});

describe("dedupeContractsByRoom — phòng 2 HĐ ACTIVE giữ HĐ mới nhất", () => {
  const mk = (id: string, room: string, start: string, created: string) => ({
    id, rent_price: 1, room_id: room, start_date: start, created_at: created,
    room: { id: room, name: `P${room}`, building_id: "b1" },
  });
  it("start_date khác → lấy start mới hơn; báo tên phòng trùng", () => {
    const { contracts, dupRoomNames } = dedupeContractsByRoom([
      mk("old", "r1", "2025-01-01", "2025-01-01"),
      mk("new", "r1", "2026-01-01", "2025-06-01"),
      mk("only", "r2", "2025-01-01", "2025-01-01"),
    ]);
    expect(contracts.map((c) => c.id).sort()).toEqual(["new", "only"]);
    expect(dupRoomNames).toEqual(["Pr1"]);
  });
  it("start_date bằng nhau → tie-break created_at mới hơn", () => {
    const { contracts } = dedupeContractsByRoom([
      mk("a", "r1", "2026-01-01", "2026-01-01"),
      mk("b", "r1", "2026-01-01", "2026-03-01"),
    ]);
    expect(contracts[0].id).toBe("b");
  });
});

describe("buildLastReadingByMeter — nhiều reading lấy dòng ĐẦU (đã sort desc)", () => {
  it("giữ reading đầu tiên gặp cho mỗi meter", () => {
    const m = buildLastReadingByMeter([
      { meter_id: "m1", current_reading: 500 }, // mới nhất (sort desc từ query)
      { meter_id: "m1", current_reading: 450 },
      { meter_id: "m2", current_reading: null }, // null → 0
    ]);
    expect(m.get("m1")).toBe(500);
    expect(m.get("m2")).toBe(0);
  });
});

describe("buildCreditByContract", () => {
  it("bỏ credit có source invoice đã xoá; cộng dồn phần còn lại", () => {
    const m = buildCreditByContract([
      { contract_id: "c1", amount: 50000, source_invoice: { deleted_at: null } },
      { contract_id: "c1", amount: 20000, source_invoice: { deleted_at: "2026-01-01" } },
      { contract_id: "c1", amount: 30000 },
    ]);
    expect(m.get("c1")).toBe(80000);
  });
});

describe("buildPreviousDebtByContract — nợ cũ + carry-over", () => {
  const inv = (id: string, contract: string, total: number, paid: number, srcs: unknown[] = []) => ({
    id, contract_id: contract, total_amount: total, paid_amount: paid,
    billing_month: "2026-06",
    previous_debt_sources: srcs as never,
    room: { id: "r", name: "101" }, building: { id: "b", name: "B" },
  });
  it("HĐ đã bị HĐ khác carry-over thì KHÔNG tính nữa", () => {
    const m = buildPreviousDebtByContract([
      inv("i1", "c1", 500000, 0),
      // i2 carry i1 → i1 bị loại, chỉ còn i2
      inv("i2", "c1", 800000, 100000, [{ type: "invoice", id: "i1", amount: 500000 }]),
    ]);
    expect(m.get("c1")!.total).toBe(700000);
    expect(m.get("c1")!.sources.map((s) => s.id)).toEqual(["i2"]);
  });
  it("phần còn lại dưới ngưỡng làm tròn thì bỏ", () => {
    const m = buildPreviousDebtByContract([
      inv("i1", "c1", 100000, 100000 - (PREVIOUS_DEBT_ROUND_THRESHOLD - 1)),
    ]);
    expect(m.get("c1")).toBeUndefined();
  });

  // Án lệ 203/65NTG (31/07/2026): HĐ tháng 7 có nợ cũ NHẬP TAY (sources rỗng)
  // → mất link carry-over → prefill tháng 8 cộng đúp cả nợ tháng 6 lẫn tháng 7
  // (1.234.000 thay vì 733.500). Fallback dedup: HĐ có previous_debt > 0 mà
  // sources rỗng thì coi mọi HĐ cũ hơn cùng contract đã được nó gánh.
  it("nợ cũ NHẬP TAY (sources rỗng) vẫn dedup được HĐ cũ hơn — không cộng đúp", () => {
    const withMonth = (
      id: string, month: string, total: number, paid: number,
      prevDebt: number, srcs: unknown[] = [],
    ) => ({
      ...inv(id, "c1", total, paid, srcs),
      billing_month: month,
      previous_debt: prevDebt,
    });
    const m = buildPreviousDebtByContract([
      // Tháng 6: còn nợ 500.500
      withMonth("i6", "2026-06", 4534500, 4034000, 0),
      // Tháng 7: nợ cũ 500.000 nhập tay (sources rỗng) → đã gánh tháng 6
      withMonth("i7", "2026-07", 4733500, 4000000, 500000),
    ]);
    expect(m.get("c1")!.total).toBe(733500);
    expect(m.get("c1")!.sources.map((s) => s.id)).toEqual(["i7"]);
  });

  it("HĐ cũ hơn KHÔNG bị dedup oan khi HĐ sau không có nợ cũ", () => {
    const withMonth = (id: string, month: string, total: number, paid: number) => ({
      ...inv(id, "c1", total, paid, []),
      billing_month: month,
      previous_debt: 0,
    });
    const m = buildPreviousDebtByContract([
      withMonth("i6", "2026-06", 500000, 0),
      withMonth("i7", "2026-07", 300000, 0),
    ]);
    expect(m.get("c1")!.total).toBe(800000);
    expect(m.get("c1")!.sources.map((s) => s.id).sort()).toEqual(["i6", "i7"]);
  });

  it("fallback dedup KHÔNG rò sang contract khác", () => {
    const row = (
      id: string, contract: string, month: string, total: number, prevDebt: number,
    ) => ({
      ...inv(id, contract, total, 0, []),
      billing_month: month,
      previous_debt: prevDebt,
    });
    const m = buildPreviousDebtByContract([
      row("a6", "c1", "2026-06", 500000, 0),
      row("a7", "c1", "2026-07", 700000, 500000), // gánh a6
      row("b6", "c2", "2026-06", 400000, 0), // contract khác — phải giữ nguyên
    ]);
    expect(m.get("c1")!.sources.map((s) => s.id)).toEqual(["a7"]);
    expect(m.get("c2")!.total).toBe(400000);
  });
});

describe("buildExcelRows — ghép contract-room-meter + promo/credit/nợ", () => {
  const contract: RawContract = {
    id: "c1", rent_price: 3000000, room_id: "r1",
    discounts: { months: 2, amount_per_month: 200000 },
    room: { id: "r1", name: "101", building_id: "b1" },
    contract_customers: [{ id: "cc1" }, { id: "cc2" }],
    contract_services: [],
  };
  const build = (used: number, credit = 0) =>
    buildExcelRows({
      contracts: [contract],
      meterByRoom: new Map([["r1", "m1"]]),
      lastReading: new Map([["m1", 500]]),
      creditByContract: new Map(credit ? [["c1", credit]] : []),
      invoiceCountByContract: new Map(used ? [["c1", used]] : []),
      previousDebtByContract: new Map(),
      defaults: DEFAULTS,
    })[0];

  it("slot khuyến mãi trong hạn (used=1, months=2 → slot 2/2): áp 200k + ghi chú", () => {
    const r = build(1);
    expect(r.discount).toBe(200000);
    expect(r.discount_notes).toContain("tháng 2/2");
    // legacy không có contract_services → fallback giá toà, prefill nước theo người
    expect(r.water_amount).toBe(2 * 100000);
    expect(r.pdv_amount).toBe(150000);
    expect(r.prev_reading).toBe(500);
  });
  it("hết slot khuyến mãi (used=2, months=2 → slot 3): không áp", () => {
    const r = build(2);
    expect(r.discount).toBe(0);
    expect(r.discount_notes).toBe("");
  });
  it("credit cộng vào giảm trừ + note Tiền Thối; credit âm bị kẹp 0", () => {
    const r = build(2, 70000);
    expect(r.discount).toBe(70000);
    expect(r.applied_credit).toBe(70000);
    expect(r.discount_notes).toContain("Tiền Thối");
    const rNeg = build(2, -50000);
    expect(rNeg.discount).toBe(0);
    expect(rNeg.applied_credit).toBe(0);
  });
});

describe("reresolveRowPricing — tôn trọng override tay", () => {
  it("user đã override nước → giữ nguyên; chưa override → tính lại theo giá mới", () => {
    const row = baseRow({ water_overridden: true, water_amount: 123456 });
    const out = reresolveRowPricing(row, { ...DEFAULTS, water: 130000 });
    expect(out.water_amount).toBe(123456);
    const row2 = baseRow({ water_overridden: false });
    const out2 = reresolveRowPricing(row2, { ...DEFAULTS, water: 130000 });
    expect(out2.water_amount).toBe(2 * 130000);
  });
});

describe("computeExcelRowTotal", () => {
  it("không prorate: rent + điện + nước + pdv - giảm + nợ cũ", () => {
    const r = baseRow({ discount: 100000, previous_debt: 250000 });
    expect(computeExcelRowTotal(r)).toBe(3000000 + 175000 + 200000 + 150000 - 100000 + 250000);
  });
  it("có prorate (15 ngày): rent/nước/pdv chia 30 nhân ngày; điện + nợ giữ nguyên", () => {
    const r = baseRow({
      period_start_date: "2026-07-01", period_end_date: "2026-07-15",
      previous_debt: 90000,
    });
    const p = (n: number) => Math.round((n / 30) * 15);
    expect(computeExcelRowTotal(r)).toBe(p(3000000) + 175000 + p(200000) + p(150000) - 0 + 90000);
  });
});

describe("buildInvoiceItems — thứ tự + công thức cũ", () => {
  it("đủ 4 items đúng thứ tự RENT→điện→nước→PDV; điện unit_price = amount/consumption", () => {
    const items = buildInvoiceItems(baseRow(), CTX);
    expect(items.map((i) => i.type)).toEqual(["RENT", "SERVICE", "SERVICE", "SERVICE"]);
    expect(items[0].description).toBe("Tiền thuê phòng 101 (07/2026)");
    // điện: 175000đ / 50 kWh
    expect(items[1].unit_price).toBe(3500);
    expect(items[1].quantity).toBe(50);
    expect(items[1].previous_reading).toBe(100);
    expect(items[1].current_reading).toBe(150);
    expect(items[2].description).toBe("Tiền nước (2 người)");
    expect(items[3].description).toBe("Phí dịch vụ");
    expect(items.map((i) => i.sort_order)).toEqual([0, 1, 2, 3]);
  });
  it("consumption = 0 → điện quantity 1, unit_price = full amount", () => {
    const items = buildInvoiceItems(
      baseRow({ current_reading: 100, electric_amount: 99000 }), CTX,
    );
    const elec = items[1];
    expect(elec.quantity).toBe(1);
    expect(elec.unit_price).toBe(99000);
  });
  it("nước/PDV = 0 → không sinh item; điện 0 cũng bỏ", () => {
    const items = buildInvoiceItems(
      baseRow({ electric_amount: 0, water_amount: 0, pdv_amount: 0 }), CTX,
    );
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("RENT");
  });
  it("prorate: label (n/30 ngày) + from/to theo period; item điện vẫn theo kỳ đủ", () => {
    const items = buildInvoiceItems(
      baseRow({ period_start_date: "2026-07-01", period_end_date: "2026-07-15" }), CTX,
    );
    expect(items[0].description).toContain("(15/30 ngày)");
    expect(items[0].from_date).toBe("2026-07-01");
    expect(items[0].to_date).toBe("2026-07-15");
    expect(items[0].unit_price).toBe(Math.round((3000000 / 30) * 15));
    // item điện KHÔNG prorate — giữ from/to kỳ đủ (hành vi cũ)
    expect(items[1].from_date).toBe("2026-07-01");
    expect(items[1].to_date).toBe("2026-07-31");
  });
});

describe("buildInvoiceFormData", () => {
  it("applied_credit kẹp min(credit, discount); sources giữ khi CHƯA chỉnh tay", () => {
    const fd = buildInvoiceFormData(
      baseRow({
        applied_credit: 300000, discount: 120000,
        previous_debt: 500000,
        previous_debt_sources: [{ type: "invoice", id: "i1", amount: 500000, label: "x" }],
      }), CTX,
    );
    expect(fd.applied_credit).toBe(120000);
    expect(fd.previous_debt).toBe(500000);
    expect(fd.previous_debt_sources).toHaveLength(1);
    expect(fd.billing_month).toBe("2026-07");
    expect(fd.prepaid_amount).toBe(0);
  });
  it("user chỉnh tay nợ cũ → CLEAR sources (tránh cascade-paid sai)", () => {
    const fd = buildInvoiceFormData(
      baseRow({
        previous_debt: 111111, previous_debt_overridden: true,
        previous_debt_sources: [{ type: "invoice", id: "i1", amount: 500000, label: "x" }],
      }), CTX,
    );
    expect(fd.previous_debt_sources).toEqual([]);
    expect(fd.previous_debt).toBe(111111);
  });
});

describe("buildInvoiceCountByContract", () => {
  it("đếm theo contract", () => {
    const m = buildInvoiceCountByContract([
      { id: "1", contract_id: "c1" },
      { id: "2", contract_id: "c1" },
      { id: "3", contract_id: "c2" },
    ]);
    expect(m.get("c1")).toBe(2);
    expect(m.get("c2")).toBe(1);
  });
});
