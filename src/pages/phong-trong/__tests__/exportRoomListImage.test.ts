// @vitest-environment jsdom
// Chạy THẬT đường vẽ ảnh (jsdom không có canvas 2D nên dùng context ghi lại lệnh vẽ).
// Có từ 10/10/2026: một lần thay chữ hàng loạt biến colW thành tự gọi chính nó — test bảng
// (roomListTable) vẫn xanh, còn nút "Tải ảnh" trên production chết vì tràn ngăn xếp.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drawRoomListImage } from "../exportRoomListImage";
import { buildRoomListTable } from "../roomListTable";
import type { Building, Room } from "../sampleData";

interface Drawn { text: string; fill: string; font: string }

function stubCanvas(): Drawn[] {
  const drawn: Drawn[] = [];
  const ctx = {
    font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "", textBaseline: "",
    measureText: (t: string) => ({ width: t.length * 8 }),
    fillText(this: { fillStyle: string; font: string }, text: string) { drawn.push({ text, fill: this.fillStyle, font: this.font }); },
    scale() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    closePath() {}, arcTo() {}, save() {}, restore() {},
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
  return drawn;
}

const room = (over: Partial<Room>): Room => ({
  id: "r1", no: 502, code: "502", buildingId: "b1", buildingName: "", buildingArea: "", buildingAddr: "",
  floor: 5, type: "", price: 4, area: 20, status: "free", amenities: [], availDate: null, imgCount: 0, phClass: "",
  x: 0, y: 0, w: 0, h: 0, ...over,
});
const building = (over: Partial<Building>): Building => ({
  id: "b1", code: "", name: "102LVT", area: "", district: "", manager: "admin ihome+", phone: "0923 889 880",
  hotline: "0923 889 880", salePolicy: "Nước 100k/người\nXe free",
  address: "102/30 Lê Văn Thọ, khu phố 6, Phường Thông Tây Hội, Thành phố Hồ Chí Minh", liftLabel: "Thang máy",
  elecRate: 3500, lift: true, policy: "", floors: [], freeCount: 1, total: 1,
  rooms: [room({ saleNote: "Ký 1 năm giảm 200k suốt HĐ" })], ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("drawRoomListImage", () => {
  it("vẽ được bảng đủ cột, đúng màu, không chữ admin", () => {
    const drawn = stubCanvas();
    const table = buildRoomListTable([
      building({}),
      building({ id: "b2", name: "403PVB", address: "403PVB, Phường 15, Quận Tân Bình, Hồ Chí Minh", phone: "0708 882 357",
        liftLabel: "Thang bộ", rooms: [room({ id: "r2", code: "401", buildingId: "b2" })] }),
    ]);
    const canvas = drawRoomListImage(table);
    expect(canvas.width).toBe(1520 * 2);
    const texts = drawn.map((d) => d.text);
    for (const h of ["ĐỊA CHỈ", "MÃ PHÒNG", "GIÁ", "CHÍNH SÁCH SALE", "LOẠI PHÒNG", "NỘI THẤT", "TÌNH TRẠNG"]) expect(texts).toContain(h);
    expect(texts).toEqual(expect.arrayContaining(["0923 889 880", "Nước 100k/người", "Xe free", "(thang máy)", "(thang bộ)", "0708 882 357"]));
    expect(drawn.find((d) => d.text === "Ký 1 năm giảm 200k suốt HĐ")?.fill).toBe("#c00000");
    // Toàn bộ chữ ô địa chỉ cùng một màu mực.
    expect(new Set(drawn.filter((d) => /Lê Văn Thọ|Thông Tây Hội|Tân Bình/.test(d.text)).map((d) => d.fill))).toEqual(new Set(["#111111"]));
    expect(texts.join(" ")).not.toMatch(/admin ihome|Thành phố|Hồ Chí Minh/i);
    // Khối đầu chỉ in chữ chủ gõ — không tự sinh "Điện 3.500đ/số" từ giá điện tòa.
    expect(texts.some((t) => /đ\/số/.test(t))).toBe(false);
  });

  it("ô rỗng/ít dữ liệu vẫn vẽ được (không địa chỉ, không thang, không hotline)", () => {
    stubCanvas();
    const table = buildRoomListTable([building({ address: "", liftLabel: null, phone: "", hotline: "", salePolicy: "", elecRate: null })]);
    expect(() => drawRoomListImage(table)).not.toThrow();
  });
});

describe("hằng số bố cục ảnh web = worker", () => {
  const ts = readFileSync("src/pages/phong-trong/exportRoomListImage.ts", "utf8");
  const js = readFileSync("worker/lib/room-list-image.js", "utf8");
  const pick = (src: string, name: string) =>
    src.match(new RegExp(`const ${name}[^=]*= \\[([^\\]]+)\\]`))?.[1]?.replace(/["']/g, "").replace(/\s+/g, " ").trim();
  it.each(["COLS", "HEADERS"])("%s khớp nhau", (name) => {
    expect(pick(ts, name)).toBeTruthy();
    expect(pick(js, name)).toBe(pick(ts, name));
  });
});
