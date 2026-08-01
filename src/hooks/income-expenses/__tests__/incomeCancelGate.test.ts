// ĐỢT A/C — cổng nút Huỷ của PHIẾU THU, và luật chọn cửa giữa hai đường
// thu / chi. Mã lý do đo theo can_cancel_income_voucher_v1 (migration
// 20260802100000).

import { describe, expect, it } from "vitest";

import {
  incomeCancelBlockText,
  incomeCancelGate,
  voucherCancelDecision,
  type IncomeCancelBlockCode,
  type IncomeCancelEligibility,
} from "../incomeVoucherCancel";

const ALL_CODES: IncomeCancelBlockCode[] = [
  "NOT_INCOME",
  "DELETED",
  "ALREADY_CANCELLED",
  "NOT_OWNER",
  "CASHBOOK_CLOSED",
  "HANDOVER_LOCKED",
  "PROFIT_LOCKED",
  "LIFO_ORDER",
  "CREDIT_SPENT",
  "IS_REVERSAL",
  "UNKNOWN",
];

const row = (over: Partial<IncomeCancelEligibility>): IncomeCancelEligibility => ({
  id: "v1",
  eligible: false,
  mode: "MANUAL",
  reason_code: null,
  blocking_voucher_code: null,
  ...over,
});

describe("incomeCancelBlockText", () => {
  it("mọi mã server có thể trả đều có câu tiếng Việt", () => {
    for (const code of ALL_CODES) {
      const text = incomeCancelBlockText(row({ reason_code: code }));
      expect(text.length).toBeGreaterThan(0);
      // Không được lọt placeholder chưa thay
      expect(text).not.toMatch(/\{|\}|%s/);
    }
  });

  it("mã lạ (server thêm mã mới) rơi về câu UNKNOWN thay vì undefined", () => {
    const text = incomeCancelBlockText(
      row({ reason_code: "SOMETHING_NEW" as IncomeCancelBlockCode }),
    );
    expect(text).toBe(incomeCancelBlockText(row({ reason_code: "UNKNOWN" })));
  });

  it("LIFO nêu đích danh mã phiếu phải huỷ trước", () => {
    const text = incomeCancelBlockText(
      row({ reason_code: "LIFO_ORDER", blocking_voucher_code: "PT2607125" }),
    );
    expect(text).toContain("PT2607125");
  });

  it("LIFO không có mã phiếu vẫn ra câu đọc được", () => {
    const text = incomeCancelBlockText(row({ reason_code: "LIFO_ORDER" }));
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("null");
  });
});

describe("incomeCancelGate", () => {
  it("chưa có câu trả lời (đang tải / phiếu tổ chức khác) thì KHÔNG mờ nút", () => {
    // Reader cố ý bỏ qua im lặng phiếu ngoài tổ chức. Mờ nút lúc mạng chậm là
    // chặn oan người có quyền; writer mới là chốt chặn cuối.
    for (const r of [undefined, null]) {
      const gate = incomeCancelGate(r);
      expect(gate.canCancel).toBe(true);
      expect(gate.reason).toBeNull();
    }
  });

  it("eligible thì bấm được và mang theo cách huỷ để UI hỏi cho đúng", () => {
    const gate = incomeCancelGate(row({ eligible: true, mode: "COLLECTION" }));
    expect(gate.canCancel).toBe(true);
    expect(gate.mode).toBe("COLLECTION");
    expect(gate.reason).toBeNull();
  });

  it("mọi mã chặn đều mờ nút kèm lý do — KHÔNG có mã nào cho đi tiếp", () => {
    // Khác đường phiếu chi: ở đó [STRICT_MODE]/[NOT_MANUAL] chỉ là "đổi writer"
    // nên vẫn cho bấm. Cửa phiếu thu là cửa DUY NHẤT, không còn đường lui.
    for (const code of ALL_CODES) {
      const gate = incomeCancelGate(row({ reason_code: code }));
      expect(gate.canCancel).toBe(false);
      expect(gate.reason).toBeTruthy();
    }
  });
});

describe("voucherCancelDecision — chọn cửa thu / chi", () => {
  it("phiếu THU luôn đi cửa riêng, không bao giờ chạm writer của phiếu chi", () => {
    const d = voucherCancelDecision({
      type: "INCOME",
      income: row({ eligible: true, mode: "MANUAL" }),
      // Cố tình đưa gate phiếu chi mâu thuẫn: phải bị bỏ qua hoàn toàn.
      flexGate: { canCancel: false, useFlexWriter: true, reason: "không liên quan" },
    });
    expect(d.useIncomeDoor).toBe(true);
    expect(d.useFlexWriter).toBe(false);
    expect(d.canCancel).toBe(true);
    expect(d.reason).toBeNull();
  });

  it("phiếu THU bị chặn thì mờ nút theo lý do của reader phiếu thu", () => {
    const d = voucherCancelDecision({
      type: "INCOME",
      income: row({ reason_code: "PROFIT_LOCKED" }),
      flexGate: { canCancel: true, useFlexWriter: true, reason: null },
    });
    expect(d.canCancel).toBe(false);
    expect(d.reason).toContain("lợi nhuận");
  });

  it("phiếu CHI giữ nguyên đường cũ", () => {
    const d = voucherCancelDecision({
      type: "EXPENSE",
      flexGate: { canCancel: true, useFlexWriter: true, reason: null },
    });
    expect(d.useIncomeDoor).toBe(false);
    expect(d.useFlexWriter).toBe(true);
    expect(d.mode).toBeNull();
  });

  it("phiếu CHI thiếu gate (đang tải) vẫn cho bấm, không mặc định mờ", () => {
    const d = voucherCancelDecision({ type: "EXPENSE" });
    expect(d.canCancel).toBe(true);
    expect(d.useIncomeDoor).toBe(false);
  });

  it("type chưa biết (undefined) KHÔNG được nhận nhầm là phiếu thu", () => {
    // Nhận nhầm sẽ gửi phiếu chi vào cửa phiếu thu và ăn P0001 khó hiểu.
    const d = voucherCancelDecision({ type: undefined });
    expect(d.useIncomeDoor).toBe(false);
  });
});
