import { describe, expect, it } from "vitest";
import { formatDayTime, parseVnDateTimeLocal, vnDate, vnDayStartMs, vnEndOfTodaySec } from "../format";
import { computeValidity, tempPasswordMessage } from "../tempPassword";

// 14:05 ngày 21/10/2026 giờ Việt Nam = 07:05 UTC.
const NOW = Date.UTC(2026, 9, 21, 7, 5, 30);
const NOW_SEC = Math.floor(NOW / 1000);

describe("giờ Việt Nam không phụ thuộc múi giờ của máy", () => {
  it("định dạng và ranh giới ngày", () => {
    expect(formatDayTime(NOW)).toBe("21/10 14:05");
    expect(vnDate(Date.UTC(2026, 9, 20, 17, 0))).toBe("2026-10-21"); // 00:00 21/10 giờ VN
    expect(vnDayStartMs("2026-10-21")).toBe(Date.UTC(2026, 9, 20, 17, 0));
    expect(vnDayStartMs("2026-02-30")).toBeNull();
    expect(parseVnDateTimeLocal("2026-10-21T14:05")).toBe(Date.UTC(2026, 9, 21, 7, 5));
    expect(parseVnDateTimeLocal("2026-10-21 14:05")).toBeNull();
    expect(vnEndOfTodaySec(NOW)).toBe(Date.UTC(2026, 9, 21, 16, 59) / 1000); // 23:59 giờ VN
  });
});

describe("Hiệu lực mật khẩu tạm", () => {
  const base = { from: "", to: "" };

  it("1 giờ, 2 giờ, hết hôm nay tính từ hiện tại (giây)", () => {
    expect(computeValidity({ ...base, preset: "1h" }, NOW)).toEqual({ ok: true, effectiveSec: NOW_SEC, invalidSec: NOW_SEC + 3600 });
    expect(computeValidity({ ...base, preset: "2h" }, NOW)).toEqual({ ok: true, effectiveSec: NOW_SEC, invalidSec: NOW_SEC + 7200 });
    expect(computeValidity({ ...base, preset: "today" }, NOW)).toEqual({
      ok: true,
      effectiveSec: NOW_SEC,
      invalidSec: Date.UTC(2026, 9, 21, 16, 59) / 1000,
    });
  });

  it("hết hôm nay mà đã 23:59 ⇒ báo chọn khác", () => {
    const late = Date.UTC(2026, 9, 21, 16, 59, 30);
    expect(computeValidity({ ...base, preset: "today" }, late)).toMatchObject({ ok: false, field: "preset" });
  });

  it("tuỳ chọn: đúng ⇒ dùng mốc người chọn", () => {
    expect(computeValidity({ preset: "custom", from: "2026-10-21T15:00", to: "2026-10-22T09:00" }, NOW)).toEqual({
      ok: true,
      effectiveSec: Date.UTC(2026, 9, 21, 8, 0) / 1000,
      invalidSec: Date.UTC(2026, 9, 22, 2, 0) / 1000,
    });
  });

  it.each([
    [{ from: "", to: "2026-10-22T09:00" }, "from", "Chọn thời điểm bắt đầu."],
    [{ from: "2026-10-21T15:00", to: "" }, "to", "Chọn thời điểm kết thúc."],
    [{ from: "2026-10-21T15:00", to: "2026-10-21T15:00" }, "to", "Kết thúc phải sau bắt đầu."],
    [{ from: "2026-10-20T08:00", to: "2026-10-21T14:00" }, "to", "Kết thúc phải sau hiện tại."],
    // Bắt đầu từ hôm qua, kết thúc vẫn trong 7 ngày kể từ bây giờ — nhưng KÉO DÀI quá 7 ngày.
    [{ from: "2026-10-20T08:00", to: "2026-10-27T09:00" }, "to", "Hiệu lực tối đa 7 ngày."],
    // Kéo dài chỉ 4 ngày nhưng hết hạn sau mốc bây giờ + 7 ngày (14:05:30 28/10).
    [{ from: "2026-10-25T08:00", to: "2026-10-29T08:00" }, "to", "Mã phải hết hạn trong 7 ngày kể từ bây giờ — muộn nhất 14:05 28/10."],
    [{ from: "2026-10-21T15:00", to: "2026-10-28T15:01" }, "to", "Mã phải hết hạn trong 7 ngày kể từ bây giờ — muộn nhất 14:05 28/10."],
  ])("tuỳ chọn sai %o ⇒ %s", (range, field, message) => {
    expect(computeValidity({ preset: "custom", ...range }, NOW)).toEqual({ ok: false, field, message });
  });

  it("đúng 7 ngày kể từ bây giờ vẫn được; quá một phút thì chặn", () => {
    expect(computeValidity({ preset: "custom", from: "2026-10-21T14:05", to: "2026-10-28T14:05" }, NOW).ok).toBe(true);
    expect(computeValidity({ preset: "custom", from: "2026-10-21T14:05", to: "2026-10-28T14:06" }, NOW)).toMatchObject({ ok: false, field: "to" });
  });

  it("chọn nhanh không bị mốc 7 ngày ảnh hưởng", () => {
    for (const preset of ["1h", "2h", "today"] as const) {
      const result = computeValidity({ preset, from: "", to: "" }, NOW);
      expect(result.ok, preset).toBe(true);
      expect((result.invalidSec ?? 0) - NOW_SEC).toBeLessThanOrEqual(7 * 86_400);
    }
  });
});

it("tin nhắn gửi khách", () => {
  expect(tempPasswordMessage("Cửa chính Tòa A", "1234567", NOW_SEC, NOW_SEC + 7200)).toBe(
    "Mật khẩu cửa Cửa chính Tòa A: 1234567. Hiệu lực từ 14:05 21/10 đến 16:05 21/10.",
  );
});
