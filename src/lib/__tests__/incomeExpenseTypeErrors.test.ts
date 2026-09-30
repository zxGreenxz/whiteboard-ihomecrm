import { describe, expect, it } from "vitest";
import { incomeExpenseTypeErrorMessage } from "../incomeExpenseTypeErrors";

describe("incomeExpenseTypeErrorMessage", () => {
  it("turns a database uniqueness violation into a clear organization message", () => {
    expect(
      incomeExpenseTypeErrorMessage(
        { code: "23505", message: "duplicate key value violates unique constraint" },
        "Không thể tạo loại thu chi",
      ),
    ).toBe("Hạng mục này đã tồn tại trong tổ chức");
  });

  it("does not expose an unrelated database message", () => {
    expect(
      incomeExpenseTypeErrorMessage(
        { code: "42501", message: "DB unavailable" },
        "fallback",
      ),
    ).toBe("fallback");
  });

  it("uses the operation fallback when the database has no useful message", () => {
    expect(incomeExpenseTypeErrorMessage({}, "fallback")).toBe("fallback");
  });
});
