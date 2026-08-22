import { describe, expect, it } from "vitest";
import {
  DUE_SOON_DAYS,
  buildDepositWorkQueue,
  countTasks,
  formatMoneyShort,
  type DepositTaskKind,
} from "../depositWorkQueue";
import type { HeldDepositRow } from "@/hooks/useDepositDashboard";
import type { ReservationDepositRow } from "@/hooks/useDeposits";

const TODAY = "2026-08-21";

function heldRow(over: Partial<HeldDepositRow> = {}): HeldDepositRow {
  return {
    contract_id: "c1",
    contract_number: "HD-001",
    building_id: "b1",
    building_name: "78 Cách Mạng Tháng 8",
    room_name: "311",
    customer_name: "Lê Quốc Bảo",
    total_deposit: 8_000_000,
    deposit_paid: 5_000_000,
    deposit_remaining: 3_000_000,
    deposit_debt_mode: null,
    deposit_topup_due_date: "2026-08-18",
    state: "SHORT",
    ...over,
  };
}

function resvRow(over: Partial<ReservationDepositRow> = {}): ReservationDepositRow {
  return {
    id: "v1",
    code: "PT-2608",
    name: "Cọc giữ chỗ phòng 309",
    payer_name: "Nguyễn Thị Kim Chi",
    total_amount: 2_000_000,
    voucher_date: "2026-08-14",
    approval_status: "APPROVED",
    building_id: "b1",
    building_name: "78 Cách Mạng Tháng 8",
    room_id: "r1",
    room_name: "309",
    ...over,
  };
}

const kinds = (groups: ReturnType<typeof buildDepositWorkQueue>): DepositTaskKind[] =>
  groups.map((g) => g.kind);

describe("buildDepositWorkQueue — nợ cọc theo ngày hẹn", () => {
  it("trễ hẹn vào QUÁ HẠN, đúng dấu ngày âm", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [heldRow({ deposit_topup_due_date: "2026-08-18" })],
      reservations: [],
    });
    expect(kinds(groups)).toEqual(["TOPUP_OVERDUE"]);
    const t = groups[0].tasks[0];
    expect(t.daysToDue).toBe(-3);
    expect(t.amount).toBe(3_000_000);
    expect(t.paidAmount).toBe(5_000_000);
    expect(t.expectedAmount).toBe(8_000_000);
  });

  it("hẹn đúng HÔM NAY là SẮP ĐẾN HẠN, không phải quá hạn", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [heldRow({ deposit_topup_due_date: TODAY })],
      reservations: [],
    });
    expect(kinds(groups)).toEqual(["TOPUP_DUE_SOON"]);
    expect(groups[0].tasks[0].daysToDue).toBe(0);
  });

  it("biên cửa sổ: đúng ngày thứ DUE_SOON_DAYS còn trong hàng đợi, hôm sau thì không", () => {
    const inWindow = buildDepositWorkQueue({
      today: TODAY,
      held: [heldRow({ deposit_topup_due_date: "2026-08-28" })], // +7
      reservations: [],
    });
    expect(DUE_SOON_DAYS).toBe(7);
    expect(kinds(inWindow)).toEqual(["TOPUP_DUE_SOON"]);

    const outOfWindow = buildDepositWorkQueue({
      today: TODAY,
      held: [heldRow({ deposit_topup_due_date: "2026-08-29" })], // +8
      reservations: [],
    });
    expect(outOfWindow).toEqual([]);
  });

  it("thu đủ cọc thì không vào hàng đợi dù có ngày hẹn", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [heldRow({ state: "FULL", deposit_remaining: 0 })],
      reservations: [],
    });
    expect(groups).toEqual([]);
  });

  it("thiếu cọc mà KHÔNG có ngày hẹn thì không vào hàng đợi", () => {
    // Không có hẹn thì không trễ hẹn nào cả — chỗ của nó là sổ cọc đầy đủ.
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [heldRow({ deposit_topup_due_date: null })],
      reservations: [],
    });
    expect(groups).toEqual([]);
  });

  it("nợ cọc kiểu FIRST_INVOICE vẫn được xếp hàng khi có hẹn", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [heldRow({ state: "FIRST_INVOICE", deposit_debt_mode: "FIRST_INVOICE" })],
      reservations: [],
    });
    expect(kinds(groups)).toEqual(["TOPUP_OVERDUE"]);
  });

  it("deposit_remaining âm không tạo ra số tiền âm trên thẻ", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [heldRow({ deposit_remaining: -500_000 })],
      reservations: [],
    });
    expect(groups[0].tasks[0].amount).toBe(0);
  });
});

describe("buildDepositWorkQueue — phiếu giữ chỗ", () => {
  it("chờ duyệt luôn vào CHỜ DUYỆT dù hạn làm HĐ đã qua", () => {
    // Phiếu chưa duyệt thì việc cần làm là DUYỆT, không phải đi ký hợp đồng.
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [],
      reservations: [resvRow({ approval_status: "UNAPPROVED" })],
      holdTerms: { v1: { holdUntil: "2026-08-19", topupDueDate: null, depositTarget: null } },
    });
    expect(kinds(groups)).toEqual(["PENDING_APPROVAL"]);
  });

  it("phiếu đã huỷ bị loại khỏi hàng đợi", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [],
      reservations: [resvRow({ approval_status: "CANCELLED" })],
    });
    expect(groups).toEqual([]);
  });

  it("KHÔNG biết hạn thì KHÔNG được kết luận là quá hạn", () => {
    // Đây là bất biến quan trọng nhất của nhánh giữ chỗ: 23/24 phiếu đang chạy
    // trên prod không có hạn nào cả (đo 21/08/2026). Suy "không hạn = quá hạn"
    // sẽ tô đỏ toàn bộ sổ cọc thật.
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [],
      reservations: [resvRow()],
      holdTerms: {},
    });
    expect(kinds(groups)).toEqual(["HOLD_READY"]);
    expect(groups[0].tasks[0].daysToDue).toBeNull();
  });

  it("quá hạn làm HĐ khi hạn đã lùi về quá khứ", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [],
      reservations: [resvRow()],
      holdTerms: { v1: { holdUntil: "2026-08-19", topupDueDate: null, depositTarget: null } },
    });
    expect(kinds(groups)).toEqual(["HOLD_OVERDUE"]);
    expect(groups[0].tasks[0].daysToDue).toBe(-2);
  });

  it("hạn đúng hôm nay vẫn là SẴN SÀNG KÝ, chưa trễ", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [],
      reservations: [resvRow()],
      holdTerms: { v1: { holdUntil: TODAY, topupDueDate: null, depositTarget: null } },
    });
    expect(kinds(groups)).toEqual(["HOLD_READY"]);
    expect(groups[0].tasks[0].daysToDue).toBe(0);
  });

  it("đếm đúng số ngày đã giữ phòng", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [],
      reservations: [resvRow({ voucher_date: "2026-08-08" })],
    });
    expect(groups[0].tasks[0].heldDays).toBe(13);
  });
});

describe("buildDepositWorkQueue — hạn BỔ SUNG CỌC của phiếu giữ chỗ", () => {
  // Ca chủ nêu 22/08/2026, dựng nguyên văn:
  //   phòng 5tr · thu 2tr ngày 22/08 · phải đủ 5tr trước 25/08 · nhận phòng 29/08
  const CA_CHU = {
    reservations: [
      resvRow({ id: "v1", total_amount: 2_000_000, voucher_date: "2026-08-22", room_id: "r5" }),
    ],
    terms: {
      v1: { holdUntil: "2026-08-29", topupDueDate: "2026-08-25", depositTarget: 5_000_000 },
    },
  };

  it("chưa tới hạn bổ sung: nằm ở SẮP HẾT HẠN, in số CÒN THIẾU", () => {
    const groups = buildDepositWorkQueue({
      today: "2026-08-23",
      held: [],
      reservations: CA_CHU.reservations,
      holdTerms: CA_CHU.terms,
    });
    expect(kinds(groups)).toEqual(["RESV_TOPUP_DUE_SOON"]);
    const t = groups[0].tasks[0];
    expect(t.amount).toBe(3_000_000); // 5tr − 2tr, KHÔNG phải 2tr đã thu
    expect(t.paidAmount).toBe(2_000_000);
    expect(t.expectedAmount).toBe(5_000_000);
    expect(t.daysToDue).toBe(2);
  });

  it("quá hạn bổ sung: thành nhóm ĐỎ, dù phòng vẫn còn hạn giữ", () => {
    const groups = buildDepositWorkQueue({
      today: "2026-08-26",
      held: [],
      reservations: CA_CHU.reservations,
      holdTerms: CA_CHU.terms,
    });
    // 26/08 đã quá 25/08 nhưng CHƯA quá 29/08 — mất tiền trước khi mất phòng.
    expect(kinds(groups)).toEqual(["RESV_TOPUP_OVERDUE"]);
    expect(groups[0].tasks[0].daysToDue).toBe(-1);
  });

  it("mất TIỀN xếp trên mất PHÒNG khi cả hai mốc đều đã qua", () => {
    const groups = buildDepositWorkQueue({
      today: "2026-08-30",
      held: [],
      reservations: CA_CHU.reservations,
      holdTerms: CA_CHU.terms,
    });
    expect(kinds(groups)).toEqual(["RESV_TOPUP_OVERDUE"]);
  });

  it("bổ sung bằng PHIẾU THU MỚI cùng phòng thì thẻ rời hàng đợi", () => {
    // Khách không sửa phiếu cũ — họ nộp thêm một phiếu nữa. Cộng theo PHÒNG.
    const groups = buildDepositWorkQueue({
      today: "2026-08-26",
      held: [],
      reservations: [
        ...CA_CHU.reservations,
        resvRow({ id: "v2", total_amount: 3_000_000, voucher_date: "2026-08-24", room_id: "r5" }),
      ],
      holdTerms: CA_CHU.terms,
    });
    // Đã đủ 5tr ⇒ không còn nhóm thiếu cọc nào.
    expect(kinds(groups)).not.toContain("RESV_TOPUP_OVERDUE");
    expect(kinds(groups)).not.toContain("RESV_TOPUP_DUE_SOON");
  });

  it("chênh dưới ngưỡng làm tròn coi như đã đủ", () => {
    const groups = buildDepositWorkQueue({
      today: "2026-08-26",
      held: [],
      reservations: [
        resvRow({ id: "v1", total_amount: 4_995_000, voucher_date: "2026-08-22", room_id: "r5" }),
      ],
      holdTerms: CA_CHU.terms,
    });
    expect(kinds(groups)).not.toContain("RESV_TOPUP_OVERDUE");
  });

  it("có hạn bổ sung mà KHÔNG biết cọc cần đủ thì không kết luận thiếu", () => {
    // Thiếu `depositTarget` là "chưa đo được", không phải "đã đủ" hay "còn thiếu".
    const groups = buildDepositWorkQueue({
      today: "2026-08-26",
      held: [],
      reservations: CA_CHU.reservations,
      holdTerms: {
        v1: { holdUntil: "2026-08-29", topupDueDate: "2026-08-25", depositTarget: null },
      },
    });
    expect(kinds(groups)).toEqual(["HOLD_READY"]);
  });

  it("chưa duyệt thì vẫn là CHỜ DUYỆT, không phải quá hạn bổ sung", () => {
    const groups = buildDepositWorkQueue({
      today: "2026-08-30",
      held: [],
      reservations: [
        resvRow({ id: "v1", total_amount: 2_000_000, voucher_date: "2026-08-22", room_id: "r5", approval_status: "UNAPPROVED" }),
      ],
      holdTerms: CA_CHU.terms,
    });
    expect(kinds(groups)).toEqual(["PENDING_APPROVAL"]);
  });

  it("phiếu ĐÃ HUỶ không được cộng vào số đã thu", () => {
    const groups = buildDepositWorkQueue({
      today: "2026-08-26",
      held: [],
      reservations: [
        ...CA_CHU.reservations,
        resvRow({ id: "v2", total_amount: 3_000_000, room_id: "r5", approval_status: "CANCELLED" }),
      ],
      holdTerms: CA_CHU.terms,
    });
    expect(kinds(groups)).toEqual(["RESV_TOPUP_OVERDUE"]);
    expect(groups[0].tasks[0].amount).toBe(3_000_000);
  });
});

describe("buildDepositWorkQueue — thứ tự và tổng", () => {
  it("nhóm xếp theo mức gấp, nhóm rỗng bị loại", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [
        heldRow({ contract_id: "c-late", deposit_topup_due_date: "2026-08-15" }),
        heldRow({ contract_id: "c-soon", deposit_topup_due_date: "2026-08-25" }),
      ],
      reservations: [
        resvRow({ id: "v-late" }),
        resvRow({ id: "v-wait", approval_status: "UNAPPROVED" }),
      ],
      holdTerms: {
        "v-late": { holdUntil: "2026-08-19", topupDueDate: null, depositTarget: null },
      },
    });
    expect(kinds(groups)).toEqual([
      "HOLD_OVERDUE",
      "TOPUP_OVERDUE",
      "TOPUP_DUE_SOON",
      "PENDING_APPROVAL",
    ]);
    expect(countTasks(groups)).toBe(4);
  });

  it("trong một nhóm: trễ nhiều nhất trước, cùng mức trễ thì tiền lớn trước", () => {
    const groups = buildDepositWorkQueue({
      today: TODAY,
      held: [
        heldRow({ contract_id: "a", deposit_topup_due_date: "2026-08-18", deposit_remaining: 1_000_000 }),
        heldRow({ contract_id: "b", deposit_topup_due_date: "2026-08-15", deposit_remaining: 2_000_000 }),
        heldRow({ contract_id: "c", deposit_topup_due_date: "2026-08-18", deposit_remaining: 9_000_000 }),
      ],
      reservations: [],
    });
    expect(groups[0].tasks.map((t) => t.contractId)).toEqual(["b", "c", "a"]);
  });

  it("hàng đợi rỗng khi không có gì gấp", () => {
    expect(countTasks(buildDepositWorkQueue({ today: TODAY, held: [], reservations: [] }))).toBe(0);
  });
});

describe("formatMoneyShort", () => {
  it("viết tắt theo bậc", () => {
    expect(formatMoneyShort(486_500_000)).toBe("486,5tr");
    expect(formatMoneyShort(2_000_000)).toBe("2tr");
    expect(formatMoneyShort(2_500_000)).toBe("2,5tr");
    expect(formatMoneyShort(1_200_000_000)).toBe("1,2 tỷ");
    expect(formatMoneyShort(500_000)).toBe("500k");
    expect(formatMoneyShort(0)).toBe("0");
  });

  it("giữ dấu âm và chịu được đầu vào rác", () => {
    expect(formatMoneyShort(-2_500_000)).toBe("-2,5tr");
    expect(formatMoneyShort(null)).toBe("0");
    expect(formatMoneyShort(Number.NaN)).toBe("0");
  });
});
