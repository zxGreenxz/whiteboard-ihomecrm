// Cổng nút Huỷ: dịch can_flex_cancel_v1 (đo thật trên prod 30/07/2026) thành
// "bấm được / mờ + lý do / đi writer nào".

import { describe, expect, it } from "vitest";

import {
  FLEX_CANCEL_BLOCK_TEXT,
  FLEX_CANCEL_FALLBACK_CODES,
  flexCancelBlockText,
  flexCancelGate,
  type FlexCancelBlockCode,
} from "../flexMutations";

const ALL_CODES: FlexCancelBlockCode[] = [
  "STRICT_MODE",
  "NOT_MANUAL",
  "CASHBOOK_CLOSED",
  "HANDOVER_LOCKED",
  "PROFIT_LOCKED",
  "DELETED",
  "ALREADY_CANCELLED",
  "RESTRICTED",
  "NO_ACTIVE_POSTING",
  "NO_PERMISSION",
  "NOT_CUSTODIAN",
  "UNKNOWN",
];

describe("FLEX_CANCEL_BLOCK_TEXT", () => {
  it("phủ đủ mọi mã can_flex_cancel_v1 có thể trả", () => {
    for (const code of ALL_CODES) {
      expect(FLEX_CANCEL_BLOCK_TEXT[code]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("không nhắc tên sổ quỹ / tên người — reader cố ý chỉ trả MÃ", () => {
    for (const code of ALL_CODES) {
      expect(FLEX_CANCEL_BLOCK_TEXT[code]).not.toMatch(/\{|\}|%s/);
    }
  });

  it("mã lạ (server thêm mã mới) rơi về câu UNKNOWN thay vì undefined", () => {
    expect(flexCancelBlockText("SOMETHING_NEW" as FlexCancelBlockCode)).toBe(
      FLEX_CANCEL_BLOCK_TEXT.UNKNOWN,
    );
    expect(flexCancelBlockText(null)).toBe(FLEX_CANCEL_BLOCK_TEXT.UNKNOWN);
  });
});

describe("flexCancelGate", () => {
  it("chưa có câu trả lời (đang tải / server bỏ qua id) thì KHÔNG mờ nút", () => {
    // Mờ nút lúc mạng chậm là chặn oan người có quyền.
    for (const row of [undefined, null]) {
      const gate = flexCancelGate(row);
      expect(gate.canCancel).toBe(true);
      expect(gate.useFlexWriter).toBe(false);
      expect(gate.reason).toBeNull();
    }
  });

  it("eligible → bấm được và đi writer linh hoạt (đường DUY NHẤT có CAS)", () => {
    const gate = flexCancelGate({ id: "x", eligible: true, reason_code: null });
    expect(gate).toEqual({ canCancel: true, useFlexWriter: true, reason: null });
  });

  it("STRICT_MODE / NOT_MANUAL vẫn bấm được — thang tương thích cũ còn sống", () => {
    // statusMutations.useCancelIncomeExpense chỉ rơi xuống đường cũ khi thông
    // điệp chứa [STRICT_MODE] hoặc [NOT_MANUAL]; hai mã này phải khớp đúng bộ đó.
    expect([...FLEX_CANCEL_FALLBACK_CODES].sort()).toEqual([
      "NOT_MANUAL",
      "STRICT_MODE",
    ]);
    for (const code of FLEX_CANCEL_FALLBACK_CODES) {
      const gate = flexCancelGate({ id: "x", eligible: false, reason_code: code });
      expect(gate.canCancel).toBe(true);
      expect(gate.useFlexWriter).toBe(false);
      expect(gate.reason).toContain(FLEX_CANCEL_BLOCK_TEXT[code]);
      expect(gate.reason).toContain("đường huỷ cũ");
    }
  });

  it("mọi mã chặn khác → mờ nút và nêu đúng lý do", () => {
    const blocking = ALL_CODES.filter((c) => !FLEX_CANCEL_FALLBACK_CODES.has(c));
    expect(blocking).toContain("NO_PERMISSION");
    expect(blocking).toContain("NOT_CUSTODIAN");
    expect(blocking).toContain("ALREADY_CANCELLED");
    expect(blocking).toContain("NO_ACTIVE_POSTING");
    for (const code of blocking) {
      const gate = flexCancelGate({ id: "x", eligible: false, reason_code: code });
      expect(gate.canCancel).toBe(false);
      expect(gate.useFlexWriter).toBe(false);
      expect(gate.reason).toBe(FLEX_CANCEL_BLOCK_TEXT[code]);
    }
  });

  it("không eligible mà server quên gửi mã → vẫn mờ nút, không crash", () => {
    const gate = flexCancelGate({ id: "x", eligible: false, reason_code: null });
    expect(gate.canCancel).toBe(false);
    expect(gate.reason).toBe(FLEX_CANCEL_BLOCK_TEXT.UNKNOWN);
  });
});
