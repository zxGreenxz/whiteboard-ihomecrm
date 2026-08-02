import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  EXPORT_STATUSES,
  addressLines,
  amenitiesCell,
  buildRoomListTable,
  elecLines,
  exportFileName,
  fmtVndFull,
  statusLines,
  typeCell,
} from "../roomListTable";
import { MANAGER, type Building, type Room, type RoomStatus } from "../sampleData";

/* ---- fixtures ---- */
function room(over: Partial<Room> = {}): Room {
  return {
    id: "r1", no: 302, code: "302",
    buildingId: "b1", buildingName: "Toà A", buildingArea: "Gò Vấp", buildingAddr: "1 ABC",
    floor: 3, type: "", price: 4.5, area: 20, status: "free",
    amenities: [], availDate: null, imgCount: 1, phClass: "",
    x: 0, y: 0, w: 0, h: 0,
    ...over,
  };
}
function building(over: Partial<Building> = {}): Building {
  const rooms = over.rooms ?? [room()];
  return {
    id: "b1", code: "A", name: "Toà A", area: "Gò Vấp", district: "Quận Gò Vấp",
    address: "102/30 Lê Văn Thọ, Gò Vấp", manager: "A. Hiệp", phone: "0923 889 880",
    lift: true, policy: "", floors: [], total: rooms.length,
    freeCount: rooms.filter((r) => r.status !== "rented").length,
    ...over,
    rooms,
  };
}

describe("fmtVndFull (cột GIÁ)", () => {
  it("triệu → VND đầy đủ, phân cách nghìn", () => {
    expect(fmtVndFull(4.5)).toBe("4.500.000");
    expect(fmtVndFull(5)).toBe("5.000.000");
    expect(fmtVndFull(3.7)).toBe("3.700.000");
  });

  it("không có giá → ô rỗng (không in '0')", () => {
    expect(fmtVndFull(0)).toBe("");
    expect(fmtVndFull(-1)).toBe("");
  });

  it("không bao giờ rớt bụi số thực (luôn tròn nghìn)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.1, max: 99, noNaN: true }), (p) => {
        const digits = fmtVndFull(p).replace(/\D/g, "");
        expect(Number(digits) % 1000).toBe(0);
      }),
    );
  });
});

describe("statusLines (cột TÌNH TRẠNG)", () => {
  it("phòng trống sẵn", () => {
    expect(statusLines(room({ status: "free" }))).toEqual(["TRỐNG SẴN"]);
  });

  it("sắp trống → '<ngày> TRỐNG', bỏ số 0 đứng đầu", () => {
    expect(statusLines(room({ status: "soon", availDate: "01/08" }))).toEqual(["1/8 TRỐNG"]);
    expect(statusLines(room({ status: "soon", availDate: "15/12" }))).toEqual(["15/12 TRỐNG"]);
  });

  it("sắp trống mà chưa có ngày → 'SẮP TRỐNG'", () => {
    expect(statusLines(room({ status: "soon", availDate: null }))).toEqual(["SẮP TRỐNG"]);
  });

  it("khách pass có SĐT → in SĐT kèm tên", () => {
    expect(
      statusLines(room({ status: "pass", passContactPhone: "0384607740", passContactName: "Hải Dương" })),
    ).toEqual(["KHÁCH PASS PHÒNG:", "0384607740 (Hải Dương)"]);
  });

  it("khách ẩn SĐT (contact_manager) → KHÔNG lộ số, chỉ mời liên hệ admin", () => {
    const lines = statusLines(
      room({ status: "pass", passContactManager: true, passContactPhone: "0384607740", passContactName: "Hải Dương" }),
    );
    expect(lines).toEqual(["KHÁCH PASS PHÒNG", "LIÊN HỆ ADMIN IHOME MỞ CỬA"]);
    expect(lines.join(" ")).not.toContain("0384607740");
    expect(lines.join(" ")).not.toContain("Hải Dương");
  });
});

describe("typeCell / amenitiesCell", () => {
  it("có cả diện tích lẫn loại phòng", () => {
    expect(typeCell(room({ area: 20, type: "Cửa sổ" }))).toBe("Phòng 20m², Cửa sổ");
  });

  it("thiếu loại phòng thì vẫn còn diện tích", () => {
    expect(typeCell(room({ area: 25, type: "" }))).toBe("Phòng 25m²");
  });

  it("nội thất rỗng → rơi về mô tả phòng", () => {
    expect(amenitiesCell(room({ amenities: [], description: "cửa sổ hành lang" }))).toBe("cửa sổ hành lang");
    expect(amenitiesCell(room({ amenities: ["Máy lạnh", "Tủ bếp"] }))).toBe("Máy lạnh, Tủ bếp");
  });

  it("không có gì → ô rỗng", () => {
    expect(amenitiesCell(room({ amenities: [], description: null }))).toBe("");
  });
});

describe("addressLines (ô ĐỊA CHỈ gộp)", () => {
  it("địa chỉ + loại thang + quản lý", () => {
    expect(addressLines(building({ liftLabel: "Thang máy", manager: "A. Hiệp" }))).toEqual([
      "102/30 Lê Văn Thọ, Gò Vấp",
      "(thang máy)",
      "(A. Hiệp)",
    ]);
  });

  it("thiếu loại thang thì bỏ dòng đó", () => {
    expect(addressLines(building({ liftLabel: null }))).toEqual([
      "102/30 Lê Văn Thọ, Gò Vấp",
      "(A. Hiệp)",
    ]);
  });
});

describe("elecLines (khối thông tin chung)", () => {
  it("chưa tòa nào khai giá điện → câu mặc định", () => {
    expect(elecLines([building({ elecRate: null })])).toEqual(["Điện theo định mức tòa nhà"]);
  });

  it("mọi tòa cùng giá → đúng 1 dòng", () => {
    const bs = [building({ id: "b1", elecRate: 3800 }), building({ id: "b2", elecRate: 3800 })];
    expect(elecLines(bs)).toEqual(["Điện 3.800đ/số"]);
  });

  it("lệch giá → lấy giá phổ biến làm chuẩn, liệt kê tòa ngoại lệ", () => {
    const bs = [
      building({ id: "b1", name: "Toà A", elecRate: 3800 }),
      building({ id: "b2", name: "Toà B", elecRate: 3800 }),
      building({ id: "b3", name: "102LVT", elecRate: 3900 }),
    ];
    expect(elecLines(bs)).toEqual(["Điện 3.800đ/số", "Riêng 102LVT: điện 3.900đ/số"]);
  });
});

describe("buildRoomListTable", () => {
  const passRoom = room({ id: "r2", no: 201, code: "201", floor: 2, status: "pass" });
  const rentedRoom = room({ id: "r3", no: 101, code: "101", floor: 1, status: "rented" });
  const soonRoom = room({ id: "r4", no: 405, code: "405", floor: 4, status: "soon", availDate: "01/08" });

  it("chỉ lấy phòng còn chào được, loại hẳn phòng đã thuê", () => {
    const t = buildRoomListTable([building({ rooms: [room(), passRoom, rentedRoom, soonRoom] })]);
    expect(t.totalRooms).toBe(3);
    expect(t.groups[0].rows.map((r) => r.code)).toEqual(["405", "302", "201"]); // tầng cao → thấp
  });

  it("tòa không còn phòng trống thì không xuất hiện trong ảnh", () => {
    const t = buildRoomListTable([
      building({ id: "b1", rooms: [room()] }),
      building({ id: "b2", rooms: [rentedRoom] }),
    ]);
    expect(t.groups.map((g) => g.buildingId)).toEqual(["b1"]);
  });

  it("KHÔNG áp bộ lọc màn hình — mọi tòa truyền vào đều được xuất", () => {
    const bs = [
      building({ id: "b1", rooms: [room({ price: 3 })] }),
      building({ id: "b2", rooms: [room({ id: "rx", price: 12 })] }),
    ];
    expect(buildRoomListTable(bs).totalRooms).toBe(2);
  });

  it("số liên hệ lấy theo SĐT phổ biến nhất giữa các tòa", () => {
    const bs = [
      building({ id: "b1", phone: "0923 889 880" }),
      building({ id: "b2", phone: "0923 889 880" }),
      building({ id: "b3", phone: "0111 111 111" }),
    ];
    expect(buildRoomListTable(bs).contactLines).toEqual(["LIÊN HỆ ADMIN ĐỂ MỞ CỬA", "0923 889 880"]);
  });

  it("không tòa nào khai SĐT → dùng hotline mặc định", () => {
    expect(buildRoomListTable([building({ phone: "" })]).contactLines[1]).toBe(MANAGER.phone);
  });

  it("danh sách rỗng → bảng rỗng, không nổ", () => {
    const t = buildRoomListTable([]);
    expect(t.totalRooms).toBe(0);
    expect(t.groups).toEqual([]);
    expect(t.title).toBe("DANH SÁCH PHÒNG TRỐNG");
  });

  it("mọi phòng xuất ra đều thuộc EXPORT_STATUSES (không rò phòng đã thuê)", () => {
    const statuses: RoomStatus[] = ["free", "soon", "rented", "pass"];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...statuses), { minLength: 1, maxLength: 30 }), (sts) => {
        const rooms = sts.map((s, i) => room({ id: `r${i}`, no: 100 + i, code: `${100 + i}`, status: s }));
        const t = buildRoomListTable([building({ rooms })]);
        const expected = sts.filter((s) => (EXPORT_STATUSES as readonly string[]).includes(s)).length;
        expect(t.totalRooms).toBe(expected);
      }),
    );
  });
});

describe("exportFileName", () => {
  it("giữ đúng nếp đặt tên cũ danh-sach-phong-trong-YYYYMMDD.png", () => {
    expect(exportFileName(new Date(2026, 7, 2))).toBe("danh-sach-phong-trong-20260802.png");
    expect(exportFileName(new Date(2026, 11, 25))).toBe("danh-sach-phong-trong-20261225.png");
  });
});
