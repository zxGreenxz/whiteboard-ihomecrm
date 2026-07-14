import { describe, it, expect } from "vitest";
import {
  resolveVacancyInfo,
  resolveVacancyReason,
  vacancyNoteText,
  VACANCY_FALLBACK_REASON,
  type VacancyEvent,
} from "../vacancyReason";

describe("resolveVacancyInfo", () => {
  it("mảng rỗng → fallback + since null", () => {
    expect(resolveVacancyInfo([])).toEqual({
      reason: VACANCY_FALLBACK_REASON,
      since: null,
    });
  });

  it("chọn sự kiện mới nhất theo ngày", () => {
    const events: VacancyEvent[] = [
      { kind: "expired", date: "2026-05-31" },
      { kind: "termination", type: "FORFEIT", date: "2026-07-02" },
    ];
    expect(resolveVacancyInfo(events)).toEqual({
      reason: "Bỏ cọc",
      since: "2026-07-02",
    });
  });

  it("cùng ngày: termination thắng transfer thắng expired", () => {
    const events: VacancyEvent[] = [
      { kind: "expired", date: "2026-07-01" },
      { kind: "transfer", type: "ROOM_CHANGE", date: "2026-07-01" },
      { kind: "termination", type: "MOVE_OUT", date: "2026-07-01" },
    ];
    const info = resolveVacancyInfo(events);
    expect(info.reason).toBe("Thanh lý HĐ");
    expect(info.since).toBe("2026-07-01");
  });

  it("resolveVacancyReason giữ tương thích (chỉ nhãn)", () => {
    expect(
      resolveVacancyReason([{ kind: "transfer", type: "TENANT_CHANGE", date: "2026-06-15" }]),
    ).toBe("Sang nhượng");
  });
});

describe("vacancyNoteText", () => {
  it("có ngày + lý do → 'Trống N ngày từ dd/mm — lý do'", () => {
    expect(vacancyNoteText("Bỏ cọc", "2026-07-02", "2026-07-14")).toBe(
      "Trống 12 ngày từ 02/07 — Bỏ cọc",
    );
  });

  it("since khác năm refDate → kèm năm", () => {
    expect(vacancyNoteText("Hết hạn HĐ", "2025-12-20", "2026-07-14")).toBe(
      "Trống 206 ngày từ 20/12/2025 — Hết hạn HĐ",
    );
  });

  it("since = refDate → 'Trống từ dd/mm' (không đếm 0 ngày)", () => {
    expect(vacancyNoteText("Thanh lý HĐ", "2026-07-14", "2026-07-14")).toBe(
      "Trống từ 14/07 — Thanh lý HĐ",
    );
  });

  it("không có ngày → giữ dạng cũ", () => {
    expect(vacancyNoteText("Bỏ cọc", null, "2026-07-14")).toBe("Trống phòng — Bỏ cọc");
    expect(vacancyNoteText(VACANCY_FALLBACK_REASON, null, "2026-07-14")).toBe("Trống phòng");
    expect(vacancyNoteText(undefined, undefined, "2026-07-14")).toBe("Trống phòng");
  });

  it("since sau refDate (dữ liệu lệch) → không hiện số ngày âm", () => {
    expect(vacancyNoteText("Bỏ cọc", "2026-07-20", "2026-07-14")).toBe(
      "Trống phòng — Bỏ cọc",
    );
  });

  it("lý do fallback nhưng CÓ ngày → vẫn hiện số ngày, không lặp 'Trống phòng'", () => {
    expect(vacancyNoteText(VACANCY_FALLBACK_REASON, "2026-07-02", "2026-07-14")).toBe(
      "Trống 12 ngày từ 02/07",
    );
  });
});
