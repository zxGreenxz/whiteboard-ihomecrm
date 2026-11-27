import { describe, expect, it } from "vitest";

import type { DoorActionLog, DoorKeyLink, DoorRecord } from "../dto";
import {
  customerKeysText,
  dateRangeText,
  deviceCountText,
  foldVi,
  groupByDay,
  historyCounts,
  historyRow,
  permissionRows,
  reconcileSections,
  recordFilterOf,
  searchDeviceGroups,
  tempPasswordCards,
  tempPasswordShareText,
  timeLeftText,
  validityWindowText,
  visibleHistoryFilters,
  visibleMobileTabs,
  vnDayTitle,
} from "../mobile";
import { reconcileKeys } from "../reconcile";
import { indexLinks } from "../records";
import { indexTempPasswordLogs } from "../tempPassword";
import { device, link } from "./fixtures";

// 14:05 thứ Tư 25/11/2026 giờ Việt Nam.
const NOW = Date.UTC(2026, 10, 25, 7, 5);
const sec = (ms: number) => Math.floor(ms / 1000);
const H = 3600_000;

function record(partial: Partial<DoorRecord>): DoorRecord {
  return { id: "r1", at: NOW, kind: "unlock", method: "fingerprint", methodCode: null, slot: 12, userId: null, userName: null, unlockName: null, ...partial };
}

function createLog(partial: Partial<DoorActionLog>): DoorActionLog {
  return {
    id: "00000000-0000-4000-8000-00000000c001",
    device_id: null,
    device_name: null,
    building_id: null,
    building_name: null,
    actor_id: null,
    actor_name: "Quản lý Thử",
    action: "TEMP_PASSWORD_CREATE",
    status: "OK",
    detail: { name: "Khách A xem phòng", purpose: "XEM_PHONG" },
    tuya_password_id: "501",
    error_code: null,
    error_message: null,
    created_at: new Date(NOW - 45 * 60_000).toISOString(),
    finished_at: null,
    ...partial,
  };
}

describe("ngày giờ trên màn điện thoại", () => {
  it("tiêu đề nhóm: hôm nay, hôm qua, thứ trong tuần — theo giờ Việt Nam", () => {
    expect(vnDayTitle(NOW, NOW)).toBe("Hôm nay, 25/11");
    expect(vnDayTitle(NOW - 24 * H, NOW)).toBe("Hôm qua, 24/11");
    expect(vnDayTitle(NOW - 48 * H, NOW)).toBe("Thứ Hai, 23/11");
    // 23:30 ngày 24/11 giờ VN = 16:30 UTC 24/11 — vẫn là hôm qua dù UTC cùng ngày với 00:30 hôm nay.
    expect(vnDayTitle(Date.UTC(2026, 10, 24, 16, 30), NOW)).toBe("Hôm qua, 24/11");
    expect(vnDayTitle(Date.UTC(2026, 10, 24, 17, 30), NOW)).toBe("Hôm nay, 25/11");
  });

  it("gom theo ngày giữ thứ tự nguồn, lượt không rõ giờ để cuối", () => {
    const groups = groupByDay([{ at: NOW }, { at: null }, { at: NOW - 60_000 }, { at: NOW - 24 * H }], NOW);
    expect(groups.map((group) => [group.title, group.rows.length])).toEqual([
      ["Hôm nay, 25/11", 2],
      ["Hôm qua, 24/11", 1],
      ["Không rõ giờ", 1],
    ]);
  });

  it("khoảng ngày ngắn gọn", () => {
    expect(dateRangeText("2026-11-24", "2026-11-25")).toBe("24/11 – 25/11");
    expect(dateRangeText("2026-11-25", "2026-11-25")).toBe("25/11");
  });
});

describe("chọn cửa", () => {
  const devices = [
    device({ id: "00000000-0000-4000-8000-0000000000d1", display_name: "Cổng chính", building_name: "Tòa A" }),
    device({ id: "00000000-0000-4000-8000-0000000000d2", display_name: "Cửa sân thượng", building_name: "Tòa A" }),
    device({ id: "00000000-0000-4000-8000-0000000000d3", display_name: "Cổng chính", building_name: "Tòa B", building_id: "00000000-0000-4000-8000-0000000000a2" }),
  ];

  it("tìm không dấu theo toà hoặc tên cửa", () => {
    expect(foldVi("Cửa Sân Thượng Đông")).toBe("cua san thuong dong");
    expect(searchDeviceGroups(devices, "san thuong").flatMap((group) => group.devices.map((d) => d.display_name))).toEqual(["Cửa sân thượng"]);
    expect(searchDeviceGroups(devices, "toa b").map((group) => group.building)).toEqual(["Tòa B"]);
    expect(searchDeviceGroups(devices, "không có")).toEqual([]);
    expect(searchDeviceGroups(devices, "  ").length).toBe(2);
  });

  it("đếm cửa và toà", () => {
    expect(deviceCountText(devices)).toBe("3 cửa ở 2 toà bạn được xem");
  });
});

describe("mã tạm", () => {
  it("khung hiệu lực gọn theo ngày", () => {
    expect(validityWindowText(sec(NOW - 45 * 60_000), sec(NOW + 15 * 60_000), NOW)).toBe("13:20 → 14:20");
    expect(validityWindowText(sec(Date.UTC(2026, 10, 26, 1, 0)), sec(Date.UTC(2026, 10, 26, 13, 0)), NOW)).toBe("08:00 → 20:00 26/11");
    expect(validityWindowText(sec(Date.UTC(2026, 10, 25, 1, 0)), sec(Date.UTC(2026, 10, 27, 11, 0)), NOW)).toBe("08:00 25/11 → 18:00 27/11");
  });

  it("thời gian còn lại", () => {
    expect(timeLeftText(sec(NOW - H), sec(NOW + 15 * 60_000), NOW)).toBe("còn 15 phút");
    expect(timeLeftText(sec(NOW - H), sec(NOW + 30_000), NOW)).toBe("còn 1 phút");
    expect(timeLeftText(sec(NOW - H), sec(NOW + 3 * H + 5 * 60_000), NOW)).toBe("còn 3 giờ");
    expect(timeLeftText(sec(NOW - H), sec(NOW + 50 * H), NOW)).toBe("còn 2 ngày");
    expect(timeLeftText(sec(NOW + 18 * H), sec(NOW + 30 * H), NOW)).toBe("bắt đầu 08:05 26/11");
    expect(timeLeftText(sec(NOW - 2 * H), sec(NOW - H), NOW)).toBe("đã hết hạn");
  });

  it("chia nhóm đang/sắp hiệu lực, kèm người tạo, mục đích, phần còn lại", () => {
    const logs = indexTempPasswordLogs([createLog({})]);
    const { active, upcoming } = tempPasswordCards(
      [
        { id: 501, name: "Khách A xem phòng", phase: 1, effectiveSec: sec(NOW - 45 * 60_000), invalidSec: sec(NOW + 15 * 60_000), deliveryStatus: 2 },
        { id: 502, name: null, phase: 1, effectiveSec: sec(NOW + 18 * H), invalidSec: sec(NOW + 30 * H), deliveryStatus: 1 },
        { id: 503, name: "Thiếu giờ", phase: null, effectiveSec: null, invalidSec: null, deliveryStatus: null },
      ],
      logs,
      NOW,
    );
    expect(active.map((card) => card.id)).toEqual([501, 503]);
    expect(upcoming.map((card) => card.id)).toEqual([502]);
    expect(active[0]).toMatchObject({
      name: "Khách A xem phòng",
      purpose: "Xem phòng",
      window: "13:20 → 14:20",
      left: "còn 15 phút",
      soon: true,
      remainingPct: 25,
      meta: "Quản lý Thử tạo lúc 13:20 · Đã gửi xuống máy",
    });
    expect(upcoming[0]).toMatchObject({ name: "Mã #502", remainingPct: 0, soon: false, deliveryPending: true, purpose: null, meta: "Đang gửi xuống máy" });
    expect(active[1]).toMatchObject({ window: null, left: null, soon: false });
  });

  it("tin gửi khách: có toà, giờ, không lộ gì ngoài mã vừa tạo", () => {
    expect(
      tempPasswordShareText({
        doorName: "Cổng chính",
        buildingName: "Tòa A",
        code: "4820915",
        effectiveSec: sec(NOW),
        invalidSec: sec(NOW + 2 * H),
        nowMs: NOW,
      }),
    ).toBe("Mã mở Cổng chính toà Tòa A: 4820915. Dùng được từ 14:05 đến 16:05 hôm nay (25/11). Nhập mã trên bàn phím ở cửa.");
    expect(
      tempPasswordShareText({
        doorName: "Cửa sau",
        buildingName: null,
        code: "123456",
        effectiveSec: sec(Date.UTC(2026, 10, 25, 1, 0)),
        invalidSec: sec(Date.UTC(2026, 10, 27, 11, 0)),
        nowMs: NOW,
      }),
    ).toBe("Mã mở Cửa sau: 123456. Dùng được từ 08:00 25/11 đến 18:00 27/11. Nhập mã trên bàn phím ở cửa.");
  });
});

describe("lịch sử ra vào", () => {
  const tenant = link({ unlock_type: "fingerprint", unlock_sn: 12, customer_name: "Khách Thử Một", room_name: "P302", linked_at: "2026-10-01T00:00:00+00:00" });
  const movedOut = link({
    id: "00000000-0000-4000-8000-0000000000f9",
    unlock_type: "fingerprint",
    unlock_sn: 9,
    customer_name: "Khách Thử Hai",
    room_name: "P204",
    tenancy: "MOVED_OUT",
    linked_at: "2026-10-01T00:00:00+00:00",
  });
  const links = indexLinks([tenant, movedOut]);
  const tempLogs = indexTempPasswordLogs([createLog({ tuya_password_id: "777", actor_name: "Nhân viên Thử" })]);
  const tempNames = new Map([["777", "Thợ sửa máy thử"]]);

  it("người, dòng phụ và nhãn cách mở", () => {
    expect(historyRow(record({}), links, tempNames, tempLogs)).toMatchObject({ time: "14:05", who: "Khách Thử Một · P302", sub: "Khách thuê", how: "Vân tay #12", tone: "fp" });
    expect(historyRow(record({ method: "temporary", slot: 777 }), links, tempNames, tempLogs)).toMatchObject({
      who: "Thợ sửa máy thử",
      sub: "Mã do Nhân viên Thử tạo",
      how: "Mật khẩu tạm",
      tone: "temp",
    });
    expect(historyRow(record({ method: "fingerprint", slot: 31, userName: "user31" }), links, tempNames, tempLogs)).toMatchObject({
      who: "user31",
      sub: "Tên trên máy · chưa gắn",
    });
    expect(historyRow(record({ method: "remote", slot: null }), links, tempNames, tempLogs)).toMatchObject({ sub: "Mở từ app hoặc CRM", tone: "remote" });
    expect(historyRow(record({ kind: "doorbell", method: "other", slot: null }), links, tempNames, tempLogs)).toMatchObject({
      who: "Có người bấm chuông",
      how: "Chuông",
    });
  });

  it("cảnh báo và khách đã trả phòng được đánh dấu để tô nổi", () => {
    const alarm = historyRow(record({ kind: "alarm", method: "other", slot: null }), links, tempNames, tempLogs);
    expect(alarm).toMatchObject({ who: "Cảnh báo từ máy cửa", alarm: true, tone: "alarm" });
    const moved = historyRow(record({ slot: 9 }), links, tempNames, tempLogs);
    expect(moved).toMatchObject({ who: "Khách Thử Hai · P204", sub: "Đã trả phòng", movedOut: true });
  });

  it("nhóm lọc và đếm; chỉ hiện chip có lượt (luôn có Tất cả và chip đang chọn)", () => {
    const records = [
      record({ id: "a" }),
      record({ id: "b", method: "card", slot: 3 }),
      record({ id: "c", method: "dynamic", slot: null }),
      record({ id: "d", method: "app", slot: null }),
      record({ id: "e", kind: "doorbell", method: "other", slot: null }),
      record({ id: "f", kind: "alarm", method: "fingerprint", slot: null }),
    ];
    expect(records.map(recordFilterOf)).toEqual(["fingerprint", "card", "temporary", "remote", null, "alarm"]);
    const counts = historyCounts(records);
    expect(counts).toMatchObject({ all: 6, fingerprint: 1, card: 1, password: 0, temporary: 1, remote: 1, alarm: 1 });
    expect(visibleHistoryFilters(counts, "all")).toEqual(["all", "fingerprint", "card", "temporary", "remote", "alarm"]);
    expect(visibleHistoryFilters(counts, "password")).toContain("password");
  });
});

describe("đối chiếu", () => {
  it("ba nhóm + nhóm đã gắn đúng, kèm tóm tắt", () => {
    const keys = {
      users: [
        { userId: "u1", name: "Khach P204", role: null, userType: 2, methods: [{ method: "fingerprint" as const, methodCode: null, sn: 9, name: null }] },
        { userId: "u2", name: "Mot", role: null, userType: 2, methods: [{ method: "fingerprint" as const, methodCode: null, sn: 12, name: null }] },
        { userId: "u3", name: "Quản lý Thử", role: null, userType: 2, methods: [{ method: "fingerprint" as const, methodCode: null, sn: 1, name: null }] },
        { userId: "u4", name: "user31", role: null, userType: 2, methods: [{ method: "fingerprint" as const, methodCode: null, sn: 31, name: null }] },
      ],
      unassigned: [{ method: "card" as const, methodCode: null, sn: 8 }],
      partial: false,
    };
    const links: DoorKeyLink[] = [
      link({ id: "00000000-0000-4000-8000-0000000000f1", unlock_sn: 9, customer_name: "Khách Thử Hai", tenancy: "MOVED_OUT" }),
      link({ id: "00000000-0000-4000-8000-0000000000f2", unlock_sn: 12, customer_name: "Khách Thử Một", tenancy: "CURRENT" }),
      link({ id: "00000000-0000-4000-8000-0000000000f3", unlock_sn: 1, customer_id: null, customer_name: null, label: "Quản lý Thử", tenancy: "STAFF" }),
      link({ id: "00000000-0000-4000-8000-0000000000f4", unlock_sn: 4, customer_name: "Khách Thử Ba", tenancy: "CURRENT" }),
    ];
    const sections = reconcileSections(reconcileKeys(keys, links));
    expect(sections).toMatchObject({ onDevice: 5, linked: 3, unlinked: 2, linkedOkSummary: "1 khách đang thuê · 1 nhân viên" });
    expect(sections.needsDelete.map((row) => row.sn)).toEqual([9]);
    expect(sections.unlinkedRows.map((row) => `${row.unlockType}:${row.sn}`)).toEqual(["fingerprint:31", "card:8"]);
    expect(sections.gone.map((row) => row.sn)).toEqual([4]);
    expect(sections.linkedOk.map((row) => row.sn)).toEqual([1, 12]);
  });

  it("số khách đang có", () => {
    const customerId = "00000000-0000-4000-8000-0000000000c1";
    const links = [
      link({ id: "00000000-0000-4000-8000-0000000000f1", customer_id: customerId, unlock_type: "card", unlock_sn: 3 }),
      link({ id: "00000000-0000-4000-8000-0000000000f2", customer_id: customerId, unlock_type: "fingerprint", unlock_sn: 12 }),
    ];
    expect(customerKeysText(links, customerId)).toBe("đã có Thẻ #3, Vân tay #12");
    expect(customerKeysText(links, "00000000-0000-4000-8000-0000000000c2")).toBe("chưa có số nào");
  });
});

describe("thanh dưới và quyền", () => {
  const can = { view: false, temp_password: false, remote_unlock: false, manage_devices: false };

  it("Cửa luôn có; mục khác ẩn khi thiếu quyền ở toà", () => {
    expect(visibleMobileTabs(can, false)).toEqual(["door"]);
    expect(visibleMobileTabs({ ...can, temp_password: true }, false)).toEqual(["door", "temp"]);
    expect(visibleMobileTabs({ ...can, view: true }, false)).toEqual(["door", "history", "manage"]);
    expect(visibleMobileTabs(can, true)).toEqual(["door", "manage"]);
    expect(visibleMobileTabs(null, false)).toEqual(["door"]);
  });

  it("danh sách quyền ở toà", () => {
    const rows = permissionRows({ ...can, remote_unlock: true });
    expect(rows.map((row) => [row.label, row.granted, row.note])).toEqual([
      ["Xem lịch sử ra vào", false, null],
      ["Tạo và xoá mã tạm", false, null],
      ["Mở cửa từ xa", true, "10 lần / 10 phút"],
      ["Quản lý máy và vân tay", false, null],
    ]);
  });
});
