import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  EXPORT_STATUSES,
  amenitiesCell,
  buildRoomListTable,
  exportFileName,
  fmtVndFull,
  liftCell,
  policyCell,
  samePhone,
  shortAddress,
  statusLines,
  typeCell,
} from "../roomListTable";
import { type Building, type Room, type RoomStatus } from "../sampleData";

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

describe("shortAddress (ô ĐỊA CHỈ: tới phường, bỏ thành phố)", () => {
  it("phường có tên → dừng ở phường", () => {
    expect(shortAddress("102/30 Lê Văn Thọ, khu phố 6, Phường Thông Tây Hội, Thành phố Hồ Chí Minh"))
      .toBe("102/30 Lê Văn Thọ, khu phố 6, Phường Thông Tây Hội");
    expect(shortAddress("44/8 Trung Lang, khu phố 33, phường Bảy Hiền, TP. Hồ Chí Minh"))
      .toBe("44/8 Trung Lang, khu phố 33, phường Bảy Hiền");
    expect(shortAddress("12 Lê Lợi, Phường Bến Nghé, Quận 1, Thành phố Hồ Chí Minh")).toBe("12 Lê Lợi, Phường Bến Nghé");
  });

  it("phường đánh số → giữ thêm quận ngay sau (như file Excel)", () => {
    expect(shortAddress("403PVB, Phường 15, Quận Tân Bình, Hồ Chí Minh")).toBe("403PVB, Phường 15, Quận Tân Bình");
    expect(shortAddress("403 Phạm Văn Bạch, P15, Tân Bình")).toBe("403 Phạm Văn Bạch, P15, Tân Bình");
    expect(shortAddress("1 ABC, P.11, TP HCM")).toBe("1 ABC, P.11");
  });

  it("không thấy phường → chỉ cắt thành phố/tỉnh ở cuối", () => {
    expect(shortAddress("37 Tôn Đức Thắng, Q.1, TP.HCM")).toBe("37 Tôn Đức Thắng, Q.1");
    expect(shortAddress("Số 1 Đường X")).toBe("Số 1 Đường X");
    expect(shortAddress("")).toBe("");
  });

  it("'TP X' không phải thành phố trực thuộc TW là cấp quận — giữ; số phòng 'P305' không phải phường", () => {
    expect(shortAddress("12 Võ Văn Ngân, TP Thủ Đức, TP HCM")).toBe("12 Võ Văn Ngân, TP Thủ Đức");
    expect(shortAddress("12 ABC, Phường 7, TP Vũng Tàu, Bà Rịa - Vũng Tàu")).toBe("12 ABC, Phường 7, TP Vũng Tàu");
    expect(shortAddress("Block B, P305, Phường Bến Nghé, TPHCM")).toBe("Block B, P305, Phường Bến Nghé");
    expect(shortAddress("5 Lê Lợi, Q.1, Ho Chi Minh")).toBe("5 Lê Lợi, Q.1");
    expect(shortAddress("5 Lê Lợi, XÃ BÌNH HƯNG, TỈNH LONG AN")).toBe("5 Lê Lợi, XÃ BÌNH HƯNG");
  });

  it("chữ tổ hợp dấu (NFD) vẫn nhận ra phường", () => {
    expect(shortAddress(`5 Đường A, ${"Phường".normalize("NFD")} Bảy Hiền, TP HCM`)).toBe("5 Đường A, Phường Bảy Hiền");
  });
});

describe("liftCell / samePhone / policyCell", () => {
  it("loại thang → nhãn thường trong ngoặc + loại icon", () => {
    expect(liftCell(building({ liftLabel: "Thang máy" }))).toEqual({ kind: "elevator", label: "(thang máy)" });
    expect(liftCell(building({ liftLabel: "Thang bộ" }))).toEqual({ kind: "stairs", label: "(thang bộ)" });
    expect(liftCell(building({ liftLabel: null }))).toBeNull();
  });

  it("SĐT so theo chữ số, +84 ≡ 0", () => {
    expect(samePhone("0923 889 880", "0923889880")).toBe(true);
    expect(samePhone("+84 923 889 880", "0923.889.880")).toBe(true);
    expect(samePhone("0084 923 889 880", "0923889880")).toBe(true);
    expect(samePhone("0923 889 880", "0923 889 881")).toBe(false);
  });

  it("chính sách riêng: ô khuyến mãi; phòng pass chưa ghi thì lấy chính sách khách pass", () => {
    expect(policyCell(room({ saleNote: " Ký 1 năm giảm 200k " }))).toBe("Ký 1 năm giảm 200k");
    expect(policyCell(room({ status: "pass", saleNote: null, passSalePolicy: "Giảm 300k" }))).toBe("Giảm 300k");
    expect(policyCell(room({ status: "soon", passSalePolicy: "Không phải pass" }))).toBe("");
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

  it("ô liên hệ in hotline đã chọn; tòa có SĐT riêng khác hotline thì in ở ô địa chỉ", () => {
    const bs = [
      building({ id: "b1", phone: "0923889880", hotline: "0923 889 880" }),
      building({ id: "b2", phone: "0111 111 111", hotline: "0923 889 880" }),
    ];
    const t = buildRoomListTable(bs);
    expect(t.contactLines).toEqual(["LIÊN HỆ ADMIN ĐỂ MỞ CỬA", "0923 889 880"]);
    expect(t.groups.map((g) => g.phone)).toEqual([null, "0111 111 111"]);
  });

  it("chưa chọn hotline → lấy SĐT phổ biến nhất giữa các tòa", () => {
    const bs = [
      building({ id: "b1", phone: "0923 889 880" }),
      building({ id: "b2", phone: "0923 889 880" }),
      building({ id: "b3", phone: "0111 111 111" }),
    ];
    expect(buildRoomListTable(bs).contactLines).toEqual(["LIÊN HỆ ADMIN ĐỂ MỞ CỬA", "0923 889 880"]);
  });

  it("khối đầu chỉ in chính sách chung chủ tự gõ, mỗi dòng một ý — không tự sinh dòng giá điện", () => {
    const t = buildRoomListTable([building({ elecRate: 3500, salePolicy: "Điện 3.800đ/số nhà thang máy\n\n Nước 100k/người " })]);
    expect(t.infoLines).toEqual(["Điện 3.800đ/số nhà thang máy", "Nước 100k/người"]);
    expect(buildRoomListTable([building({ elecRate: 3500, salePolicy: "" })]).infoLines).toEqual([]);
  });

  it("ô địa chỉ không còn tên quản lý/admin", () => {
    const g = buildRoomListTable([building({ manager: "admin ihome+", liftLabel: "Thang máy" })]).groups[0];
    expect(g).toMatchObject({ address: "102/30 Lê Văn Thọ, Gò Vấp", lift: { kind: "elevator", label: "(thang máy)" } });
    expect(JSON.stringify(g)).not.toContain("admin");
  });

  it("không tòa nào khai SĐT → ghi chưa có số liên hệ", () => {
    expect(buildRoomListTable([building({ phone: "" })]).contactLines).toEqual(['Chưa có số liên hệ']);
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
