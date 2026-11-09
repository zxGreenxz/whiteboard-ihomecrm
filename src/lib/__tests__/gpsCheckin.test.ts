import { describe, expect, it } from "vitest";
import { deviceSilent, gpsSettingsFormSchema, pairDeepLink, relativeMinutes, slotsPerDay, type GpsDevice } from "@/lib/gpsCheckin";

const form = (windows: { from: string; to: string }[]) => ({
  enabled: true, interval_min: 30, late_tolerance_min: 10, windows,
  skip_sunday: true, skip_holidays: true, skip_approved_leave: true,
});

describe("form khung giờ", () => {
  it("nhận nhiều khung hợp lệ, không phụ thuộc thứ tự nhập", () => {
    expect(gpsSettingsFormSchema.safeParse(form([{ from: "13:30", to: "17:30" }, { from: "08:00", to: "11:30" }])).success).toBe(true);
  });
  it.each([
    ["kết thúc trước bắt đầu", [{ from: "11:00", to: "10:00" }]],
    ["hai khung chồng nhau", [{ from: "08:00", to: "10:00" }, { from: "09:00", to: "11:00" }]],
    ["hai khung chạm nhau", [{ from: "08:00", to: "10:00" }, { from: "10:00", to: "11:00" }]],
    ["không có khung nào", []],
    ["phút không phải bội 5", [{ from: "08:03", to: "10:00" }]],
    ["quá sáu khung", Array.from({ length: 7 }, (_, i) => ({ from: `0${i}:00`, to: `0${i}:30` }))],
  ])("từ chối %s", (_name, windows) => {
    expect(gpsSettingsFormSchema.safeParse(form(windows)).success).toBe(false);
  });
  it("từ chối tần suất ngoài 15/30/60", () => {
    expect(gpsSettingsFormSchema.safeParse({ ...form([{ from: "08:00", to: "09:00" }]), interval_min: 20 }).success).toBe(false);
  });
});

describe("số mốc mỗi ngày", () => {
  it("tính cả mốc đầu khung", () => {
    expect(slotsPerDay([{ from: "08:00", to: "11:30" }, { from: "13:30", to: "17:30" }], 30)).toBe(17);
  });
  it("khung lẻ không vượt quá cuối khung", () => {
    expect(slotsPerDay([{ from: "08:00", to: "08:40" }], 30)).toBe(2);
  });
});

describe("máy còn báo về không", () => {
  const device = (last: string | null): GpsDevice => ({ id: "d", paired_at: "2026-11-01T00:00:00Z", last_seen_at: last, state: {} });
  const now = new Date("2026-11-07T10:00:00Z");
  it("im lặng khi chưa từng báo hoặc quá 45 phút", () => {
    expect(deviceSilent(device(null), now)).toBe(true);
    expect(deviceSilent(device("2026-11-07T09:00:00Z"), now)).toBe(true);
  });
  it("không im lặng trong 45 phút", () => {
    expect(deviceSilent(device("2026-11-07T09:30:00Z"), now)).toBe(false);
  });
  it("mô tả thời gian tương đối", () => {
    expect(relativeMinutes("2026-11-07T09:58:00Z", now)).toBe("2 phút trước");
    expect(relativeMinutes("2026-11-07T07:00:00Z", now)).toBe("3 giờ trước");
  });
});

describe("link mở app", () => {
  it("giữ đúng scheme và mã", () => {
    expect(pairDeepLink("ABCDEFGH23")).toBe("ihomediemdanh://pair?c=ABCDEFGH23");
  });
});
