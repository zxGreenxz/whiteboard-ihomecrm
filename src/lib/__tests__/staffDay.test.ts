import { describe, expect, it } from "vitest";
import {
  addDays, addMonths, calendarSchema, dayBadge, daysBetween, eventRow, gpsDaySchema, gpsMockText, journeyPath, journeyStops,
  journeyTotals, mondayIndex, monthLastDay, outOfRangePoints, pathDistanceMeters, photoCounts, slotStrip,
  staffEventSchema, summarySchema, teamSchema, timelineRows, vnDateOf, vnTime,
  type GpsSlot, type SessionPhoto, type StaffEvent,
} from "@/lib/staffDay";

const at = (hhmm: string) => `2026-11-07T${hhmm}:00+07:00`;
const slot = (hhmm: string, status: GpsSlot["status"], extra: Partial<GpsSlot> = {}): GpsSlot => ({
  at: at(hhmm), status, is_mock: false, ...extra,
});
const photo = (geofence_status: string, extra: Partial<SessionPhoto> = {}): SessionPhoto => ({
  path: `p-${Math.random()}`, geofence_status, ...extra,
});

const open: StaffEvent = {
  kind: "session_open", at: at("08:41"), session_id: "s1", building_id: "b1", building_name: "Toà A",
  lat: 10.1, lng: 106.1, type: "FULL", status: "passed", prev_full_date: "2026-07-01",
};
const done: StaffEvent = {
  kind: "session_done", at: at("09:02"), session_id: "s1", building_id: "b1", building_name: "Toà A",
  lat: 10.1, lng: 106.1, type: "FULL", status: "passed", dwell_seconds: 1260, condition_note: "OK",
  fail_reasons: null, spawned_job_id: null, counted: true,
};
const job: StaffEvent = {
  kind: "job_done", at: at("09:20"), job_id: "j1", title: "Thông cống", building_id: "b2", building_name: "Toà B",
  lat: 10.2, lng: 106.2, distance_m: 18, geofence_status: "ok", photo_count: 2, counted: false,
};
const pay = (id: string, hhmm: string, building = "b2", room = "P.203"): StaffEvent => ({
  kind: "payment", at: at(hhmm), collection_id: id, building_id: building, building_name: "Toà B", room_name: room,
  methods: ["TM"], lat: null, lng: null, distance_m: null, geofence_status: null,
});

describe("ngày giờ theo giờ Việt Nam", () => {
  it("đổi múi giờ đúng khi UTC còn là hôm trước", () => {
    expect(vnDateOf("2026-11-06T18:30:00Z")).toBe("2026-11-07");
    expect(vnTime("2026-11-06T18:30:00Z")).toBe("01:30");
  });
  it("cộng ngày và tháng qua ranh giới", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthLastDay("2026-02")).toBe("2026-02-28");
    expect(daysBetween("2026-07-01", "2026-11-07")).toBe(129);
  });
  it("lịch bắt đầu từ Thứ Hai", () => {
    expect(mondayIndex("2026-11-02")).toBe(0);
    expect(mondayIndex("2026-11-01")).toBe(6);
  });
});

describe("nhãn ngày công", () => {
  it("không gọi ngày chưa tick là có công", () => {
    expect(dayBadge({ status: "pending" }).label).toBe("Chưa có ngày công");
    expect(dayBadge({ status: "ticked" }).tone).toBe("success");
    expect(dayBadge({ status: "flagged" }).tone).toBe("danger");
  });
});

describe("dòng sự kiện", () => {
  it("tính số ngày chưa FULL từ phiên trước", () => {
    expect(eventRow(open, "2026-11-07").sub).toBe("toà 129 ngày chưa kiểm tra FULL");
  });
  it("gắn nhãn ngày công đúng sự kiện làm nên ngày công", () => {
    expect(eventRow(done, "2026-11-07").badge?.text).toContain("Ngày công");
    expect(eventRow(job, "2026-11-07").badge).toBeNull();
  });
  it("không in chữ OK vô nghĩa của tình trạng nhà", () => {
    expect(eventRow(done, "2026-11-07").sub).toBeNull();
  });
  it("phiên chưa đủ điều kiện không ghi là ĐẠT", () => {
    const presence = { ...done, status: "presence" } as StaffEvent;
    const row = eventRow(presence, "2026-11-07");
    expect(row.title).not.toContain("ĐẠT");
    expect(row.tone).toBe("warn");
  });
  it("phiên đã bấm hoàn tất mà chưa đủ điều kiện không còn là đang làm", () => {
    const row = eventRow({ ...open, status: "presence" } as StaffEvent, "2026-11-07");
    expect(row.title).not.toContain("đang làm");
    expect(row.tone).toBe("inspect");
    expect(eventRow({ ...open, status: "open" } as StaffEvent, "2026-11-07").title).toContain("đang làm");
  });
  it("thu tiền không có GPS phải nói rõ", () => {
    expect(eventRow(pay("p1", "11:05"), "2026-11-07").sub).toBe("tiền mặt · không có GPS");
  });
});

describe("dòng thời gian gộp", () => {
  it("gộp thu tiền liền nhau cùng toà, không gộp khi có việc xen giữa", () => {
    const rows = timelineRows([pay("a", "09:00"), pay("b", "09:05", "b2", "P.204"), job, pay("c", "11:00")], [], "2026-11-07");
    expect(rows.map((r) => r.title)).toEqual([
      "Thu tiền 2 phòng · Toà B",
      expect.stringContaining("Hoàn thành việc"),
      "Thu tiền P.203 · Toà B",
    ]);
  });
  it("không hiện mốc chưa tới, gộp mốc liền nhau cùng chỗ, tách mốc mất tín hiệu", () => {
    const near = { nearest_building_id: "b1", nearest_building_name: "Toà A", nearest_distance_m: 20 };
    const rows = timelineRows([], [
      slot("09:00", "ok", near), slot("09:30", "ok", near), slot("10:00", "missing", { reason: "location_off" }),
      slot("10:30", "future"),
    ], "2026-11-07");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toContain("09:00–09:30 (2 mốc)");
    expect(rows[1]?.title).toContain("MẤT TÍN HIỆU");
    expect(rows[1]?.sub).toBe("máy tắt định vị");
  });
  it("mốc có dấu nhưng đã hết hạn lưu vị trí không ghi là đang di chuyển", () => {
    const rows = timelineRows([], [slot("09:00", "ok")], "2026-11-07");
    expect(rows[0]?.sub).toContain("vị trí đã hết hạn lưu");
    const moving = timelineRows([], [slot("09:00", "ok", { lat: 10.2, lng: 106.2 })], "2026-11-07");
    expect(moving[0]?.sub).toContain("đang di chuyển");
  });
  it("nêu rõ dấu nghi vị trí giả", () => {
    const rows = timelineRows([], [slot("09:00", "ok", { is_mock: true })], "2026-11-07");
    expect(rows[0]?.sub).toContain("nghi vị trí giả");
  });
});

describe("điểm dừng và quãng đường", () => {
  it("gộp sự kiện liền nhau cùng toà thành một ghim", () => {
    const stops = journeyStops([open, done, job]);
    expect(stops.map((s) => s.seq)).toEqual([1, 2]);
    expect(stops[0]?.buildingId).toBe("b1");
    expect(stops[0]?.lastAt).toBe(done.at);
  });
  it("thu tiền không có GPS không thành điểm dừng trên bản đồ", () => {
    expect(journeyStops([pay("p1", "11:05")])).toEqual([]);
  });
  it("phiên đang làm giữ trạng thái đang làm", () => {
    const running = { ...open, status: "open" } as StaffEvent;
    expect(journeyStops([running])[0]?.state).toBe("open");
  });
  it("ghim mang kết quả phiên mới nhất; việc cùng toà không đổi màu", () => {
    const presence = { ...done, status: "presence" } as StaffEvent;
    expect(journeyStops([{ ...open, status: "presence" } as StaffEvent, presence])[0]?.state).toBe("presence");
    const sameBuildingJob = { ...job, building_id: "b1", at: at("09:30") } as StaffEvent;
    expect(journeyStops([open, presence, sameBuildingJob])[0]?.state).toBe("presence");
    expect(journeyStops([presence, { ...done, at: at("10:00") }])[0]?.state).toBe("passed");
  });
  it("điểm đường đi sắp theo giờ và tính được quãng đường", () => {
    const stops = journeyStops([open, job]);
    const points = journeyPath(stops, [slot("09:00", "ok", { lat: 10.15, lng: 106.15, recorded_at: at("09:00") })]);
    expect(points.map((p) => p.kind)).toEqual(["stop", "gps", "stop"]);
    expect(pathDistanceMeters(points)).toBeGreaterThan(10_000);
  });
  it("không lấy toạ độ của mốc mất tín hiệu", () => {
    expect(journeyPath([], [slot("09:00", "missing", { lat: 10.2, lng: 106.2 })])).toEqual([]);
  });
  it("điểm ảnh ngoài bán kính chỉ tính ảnh có toạ độ", () => {
    const event: StaffEvent = {
      kind: "session_photos", at: at("08:47"), session_id: "s1", building_id: "b1", building_name: "x", lat: 1, lng: 1,
      photos: [photo("out_of_range", { lat: 10.5, lng: 106.5, distance_m: 142 }), photo("out_of_range"), photo("ok")],
    };
    expect(outOfRangePoints([event])).toEqual([{ lat: 10.5, lng: 106.5, distance: 142 }]);
  });
  it("tổng kết đếm đúng từng loại", () => {
    const totals = journeyTotals([open, done, job, pay("p", "11:00")]);
    expect(totals).toMatchObject({ sessionsPassed: 1, jobs: 1, payments: 1, dwellMinutes: 21 });
  });
  it("phiên có mặt không tính là đang mở", () => {
    expect(journeyTotals([{ ...open, status: "presence" } as StaffEvent]).sessionsOpen).toBe(0);
    expect(journeyTotals([{ ...open, status: "open" } as StaffEvent]).sessionsOpen).toBe(1);
  });
  it("đếm ảnh theo GPS", () => {
    expect(photoCounts([photo("ok"), photo("gps_denied"), photo("out_of_range", { distance_m: 142 })])).toMatchObject({
      ok: 1, denied: 1, outOfRange: 1, maxOutOfRange: 142,
    });
  });
});

describe("dải mốc", () => {
  const gps = {
    interval_min: 30,
    windows: [{ from: "08:00", to: "09:00" }, { from: "10:00", to: "10:30" }],
    slots: [slot("08:00", "ok"), slot("08:30", "missing"), slot("09:00", "future"), slot("10:00", "future"), slot("10:30", "future")],
  };
  it("đánh dấu ngoài khung giờ giữa hai khung", () => {
    expect(slotStrip(gps).map((c) => `${c.label}:${c.state}`)).toEqual([
      "08:00:ok", "08:30:missing", "09:00:future", "09:30:off", "10:00:future", "10:30:future",
    ]);
  });
  it("đổi tần suất giữa ngày vẫn giữ các mốc đã qua theo bản cũ", () => {
    const changed = {
      interval_min: 60,
      windows: [{ from: "08:00", to: "10:00" }],
      slots: [slot("08:00", "ok"), slot("08:30", "missing"), slot("09:00", "ok"), slot("10:00", "future")],
    };
    expect(slotStrip(changed).map((c) => `${c.label}:${c.state}`)).toEqual([
      "08:00:ok", "08:30:missing", "09:00:ok", "10:00:future",
    ]);
  });
  it("mốc cũ lệch lưới được chèn thêm, không kéo lệch cả lưới của khung mới", () => {
    const moved = {
      interval_min: 60,
      windows: [{ from: "08:00", to: "10:00" }],
      slots: [slot("07:30", "ok"), slot("08:00", "ok"), slot("09:00", "future"), slot("10:00", "future")],
    };
    expect(slotStrip(moved).map((c) => `${c.label}:${c.state}`)).toEqual([
      "07:30:ok", "08:00:ok", "09:00:future", "10:00:future",
    ]);
  });
  it("đánh dấu mốc nghi vị trí giả", () => {
    const cells = slotStrip({ ...gps, slots: [slot("08:00", "ok", { is_mock: true })] });
    expect(cells[0]?.mock).toBe(true);
    expect(cells[1]?.mock).toBe(false);
    expect(gpsMockText({ mock: 2 })).toBe("nghi vị trí giả 2 mốc");
    expect(gpsMockText({ mock: 0 })).toBeNull();
    expect(gpsMockText(null)).toBeNull();
  });
  it("không vẽ gì khi chưa có cài đặt", () => {
    expect(slotStrip({ interval_min: null, windows: [], slots: [] })).toEqual([]);
  });
});

describe("biên nhận từ máy chủ", () => {
  it("từ chối sự kiện lạ", () => {
    expect(() => staffEventSchema.parse({ kind: "nope", at: at("08:00") })).toThrow();
  });
  it("từ chối mốc GPS trạng thái lạ", () => {
    expect(() => gpsDaySchema.parse({
      enabled: true, interval_min: 30, late_tolerance_min: 10, windows: [], paired: true,
      slots: [{ at: at("08:00"), status: "weird" }],
      counts: { ok: 0, stationary: 0, missing: 0, paused: 0, pending: 0, future: 0, mock: 0 },
    })).toThrow();
  });
  it("thiếu số mốc nghi giả thì báo lỗi", () => {
    expect(() => gpsDaySchema.parse({
      enabled: true, interval_min: 30, late_tolerance_min: 10, windows: [], paired: true, slots: [],
      counts: { ok: 0, stationary: 0, missing: 0, paused: 0, pending: 0, future: 0 },
    })).toThrow();
  });
  it("thiếu khối bắt buộc thì báo lỗi, không coi là 0", () => {
    expect(() => teamSchema.parse({ date: "2026-11-07", is_today: true, as_of: at("08:00"), organization_id: "o" })).toThrow();
    expect(() => summarySchema.parse({ date: "2026-11-07" })).toThrow();
    expect(() => calendarSchema.parse({ month: "2026-11-01", days: [] })).toThrow();
  });
});
