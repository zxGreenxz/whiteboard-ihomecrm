import { describe, expect, it } from "vitest";
import {
  reservationSettlementListArgs,
  reservationSettlementErrorMessage,
  createReservationIdempotencyStore,
  reservationSettlementListSchema,
  reservationSettlementPreviewSchema,
  reservationSettlementSchema,
  reservationSettlementSummarySchema,
  invokeReservationSettlementRpc,
} from "../reservationSettlementRpc";
import { bindReservationSettlementLegTable, SETTLEMENT_LEG_SELECT } from "@/hooks/useReservationSettlement";

const settlement = {
  id: "00000000-0000-4000-8000-000000000001",
  sourceVoucherId: "00000000-0000-4000-8000-000000000002",
  depositAmount: 3_000_000,
  retainedAmount: 2_000_000,
  refundAmount: 1_000_000,
  refundedAmount: 0,
  refundRemaining: 1_000_000,
  refundState: "PENDING",
  roomReleased: true,
  roomBlockers: [],
  revenueVoucherId: null,
  offsetVoucherId: null,
  refundVoucherId: null,
} as const;

describe("reservation settlement RPC DTOs", () => {
  it("accepts a blocked preview with zero eligible deposit but never a usable zero deposit", () => {
    const preview = { voucherId: settlement.sourceVoucherId, depositAmount: 0, fingerprint: "basis:v1",
      canSettle: false, canRefundNow: false, blockers: ["NOT_RECEIVED"], roomBlockers: [],
      voucherCode: null, payerName: null, roomName: null, buildingName: null, voucherDate: "2026-09-01" };
    expect(reservationSettlementPreviewSchema.safeParse(preview).success).toBe(true);
    expect(reservationSettlementPreviewSchema.safeParse({ ...preview, canSettle: true, blockers: [] }).success).toBe(false);
  });
  it("binds the leg-table client and selects persisted columns only", () => {
    const client = { marker: "bound", from(this: { marker: string }, table: string) { return `${this.marker}:${table}`; } };
    const from = bindReservationSettlementLegTable(client);
    expect(from("reservation_settlement_vouchers") as unknown).toBe("bound:reservation_settlement_vouchers");
    expect(SETTLEMENT_LEG_SELECT).toBe("settlement:reservation_deposit_settlements!inner(sourceVoucherId:source_voucher_id)");
    expect(SETTLEMENT_LEG_SELECT).not.toMatch(/refund_remaining|refund_state|room_blockers|room_released/);
  });
  it("hides response validation internals from users", async () => {
    const rpc = async () => ({ data: { invalid_field: true }, error: null });
    await expect(invokeReservationSettlementRpc(rpc, "get_reservation_settlement_summary_v1", {}, reservationSettlementSummarySchema))
      .rejects.toThrow("Dữ liệu xử lý cọc chưa hợp lệ. Hãy tải lại và thử lại.");
  });
  it.each([
    [{ message: "Không có quyền xử lý phiếu cọc này", code: "42501" }, "Bạn chưa đủ quyền thực hiện thao tác này."],
    [{ message: "Không có quyền xem chứng từ", code: "42501" }, "Bạn chưa đủ quyền thực hiện thao tác này."],
    [{ message: "Đường dẫn ảnh chứng từ không hợp lệ", code: "22023" }, "Chứng từ hoàn tiền chưa hợp lệ. Hãy tải lại tệp bằng tài khoản đang xử lý trong công ty này (tối đa 10 tệp)."],
    [{ message: "Phiếu cọc đã thay đổi; hãy tải lại trước khi xử lý", code: "40001" }, "Phiếu đã thay đổi. Hãy tải lại trước khi xử lý."],
    [{ message: "Phiếu cọc chưa nhận tiền, đã được dùng hoặc đang ở kỳ khóa; hãy tải lại", details: '["NOT_RECEIVED"]' }, "Phiếu chưa có bằng chứng tiền đã vào quỹ."],
    [{ message: "internal ledger failure", details: '["PERIOD_LOCKED"]' }, "Ngày đã chọn nằm trong kỳ sổ quỹ đã khóa."],
    [{ message: "Sổ quỹ đã chốt tới sau ngày 10/09/2026 — không ghi sổ được. Mở lại kỳ hoặc chọn ngày khác." }, "Ngày đã chọn nằm trong kỳ sổ quỹ đã khóa."],
    [{ message: "Kỳ ghi nhận 09/2026 đã khoá — không ghi sổ được." }, "Ngày đã chọn nằm trong kỳ sổ quỹ đã khóa."],
  ])("maps safe server errors without exposing technical text", (error, expected) => {
    expect(reservationSettlementErrorMessage(error)).toBe(expected);
  });
  it("sends the source voucher filter before pagination", () => {
    expect(reservationSettlementListArgs({
      sourceVoucherId: settlement.sourceVoucherId,
      refundState: "PENDING",
    })).toEqual({
      p_building_ids: null,
      p_refund_state: "PENDING",
      p_cursor: null,
      p_limit: 50,
      p_source_voucher_id: settlement.sourceVoucherId,
    });
  });

  it("turns server codes into a short business message", () => {
    expect(reservationSettlementErrorMessage("[PERIOD_LOCKED] cashbook_closed_through_v1 failed"))
      .toBe("Ngày đã chọn nằm trong kỳ sổ quỹ đã khóa.");
    expect(reservationSettlementErrorMessage("select * from private_table"))
      .toBe("Không thể xử lý cọc giữ chỗ. Vui lòng thử lại.");
  });

  it("keeps a key for ambiguous retry and retires it after confirmed success", () => {
    const generated = ["uuid-1", "uuid-2"];
    const store = createReservationIdempotencyStore("refund", () => generated.shift()!);
    const payload = { settlementId: "s1", accountId: "a1", paidOn: "2026-09-10" };
    expect(store.keyFor(payload)).toBe("refund:uuid-1");
    expect(store.keyFor(payload)).toBe("refund:uuid-1");
    store.retire(payload);
    expect(store.keyFor(payload)).toBe("refund:uuid-2");
  });
  it("rejects a settlement whose retained and refund amounts exceed the deposit", () => {
    expect(() => reservationSettlementSchema.parse({
      ...settlement,
      retainedAmount: 2_500_000,
    })).toThrow();
  });

  it("rejects a paid settlement that still has a refund balance", () => {
    expect(() => reservationSettlementSchema.parse({
      ...settlement,
      refundState: "PAID",
    })).toThrow();
  });

  it("keeps nullable source labels and voucher date in the preview", () => {
    expect(reservationSettlementPreviewSchema.parse({
      voucherId: settlement.sourceVoucherId,
      depositAmount: 3_000_000,
      fingerprint: "basis:v1",
      canSettle: true,
      canRefundNow: false,
      blockers: [],
      roomBlockers: ["OTHER_DEPOSIT"],
      voucherCode: null,
      payerName: "Nguyễn Văn A",
      roomName: null,
      buildingName: "Tòa A",
      voucherDate: "2026-09-01",
    })).toMatchObject({ voucherCode: null, voucherDate: "2026-09-01" });
  });

  it("rejects unsafe numeric summary values instead of coercing them to zero", () => {
    expect(() => reservationSettlementSummarySchema.parse({
      retainedAmount: "not-a-number",
      retainedCount: 1,
      refundPendingAmount: 0,
      refundPendingCount: 0,
      refundPaidAmount: 0,
      refundPaidCount: 0,
    })).toThrow();
  });

  it("validates list history fields and its keyset cursor", () => {
    const parsed = reservationSettlementListSchema.parse({
      rows: [{
        ...settlement,
        createdAt: "2026-09-10T08:00:00Z",
        settlementDate: "2026-09-10",
        reasonCode: "CHANGED_MIND",
        reasonText: "",
        buildingId: "00000000-0000-4000-8000-000000000003",
        buildingName: "Tòa A",
        roomId: null,
        roomName: null,
        payerName: "Nguyễn Văn A",
        voucherCode: "PT-001",
      }],
      nextCursor: { createdAt: "2026-09-10T08:00:00Z", id: settlement.id },
    });
    expect(parsed.rows[0].settlementDate).toBe("2026-09-10");
  });
});
