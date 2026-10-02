import { describe, it, expect } from "vitest";
import { normalizeLoose, type BuildingRef } from "../../textMatch";
import {
  canonicalizeSpoken,
  canonicalizeSpokenRooms,
  matchLetters,
  matchSpokenNumber,
  looseTokens,
  numberPatterns,
  primaryCode,
  resolveSpokenBuilding,
  type SpokenBuildingRef,
} from "../spokenBuilding";

// Mã toà thật của công ty: "số nhà + chữ đầu tên đường". 102LVT và 417LVT CÙNG đường Lê Văn Thọ.
const buildings: BuildingRef[] = [
  { id: "b102", name: "Toà 102 Lê Văn Thọ", code: "102LVT" },
  { id: "b417", name: "417 Lê Văn Thọ", code: "417LVT" },
  { id: "b405", name: "405 Phan Văn Bảy", code: "405PVB, 405" },
  { id: "b1392", name: "1392 Quang Trung", code: "1392QT" },
  { id: "b80", name: "80 Đường số 3", code: "80DS3" },
  { id: "b15", name: "15 Kha Vạn Cân", code: "15KV" },
  { id: "b950", name: "950 Nguyễn Kiệm", code: "950NK" },
  { id: "bchung", name: "Chung", code: "CHUNG" },
];

const spoken = (text: string) => resolveSpokenBuilding(normalizeLoose(text), buildings);

describe("numberPatterns / matchSpokenNumber", () => {
  const at = (text: string, num: string) => matchSpokenNumber(looseTokens(normalizeLoose(text)), 0, num);

  it.each([
    ["một lẻ hai", "102", 3],
    ["một linh hai", "102", 3],
    ["một không hai", "102", 3],
    ["một trăm lẻ hai", "102", 4],
    ["một trăm linh hai", "102", 4],
    ["một lá hai", "102", 3],
    ["một lọ hai", "102", 3],
    ["1 L 2", "102", 3],
    ["1 lẻ 2", "102", 3],
    ["102", "102", 1],
    ["bốn một bảy", "417", 3],
    ["bốn trăm mười bảy", "417", 4],
    ["bốn trăm linh năm", "405", 4],
    ["một ba chín hai", "1392", 4],
    ["một nghìn ba trăm chín mươi hai", "1392", 7],
    ["chín trăm năm mươi", "950", 4],
    ["chín năm không", "950", 3],
    ["mười lăm", "15", 2],
    ["một năm", "15", 2],
    ["tám mươi", "80", 2],
    ["bốn bốn", "44", 2],
    ["bốn mươi tư", "44", 3],
    ["một trăm mười một", "111", 4],
  ])("%s ⇒ %s", (text, num, end) => {
    expect(at(text, num)).toBe(end);
  });

  it("không khớp số khác", () => {
    expect(at("một lẻ ba", "102")).toBe(-1);
    expect(at("hai trăm", "102")).toBe(-1);
  });

  it("số có số 0 đầu hoặc quá dài chỉ khớp đúng chữ số", () => {
    expect(numberPatterns("0102")).toEqual([[["0102"]]]);
    expect(numberPatterns("12345")).toEqual([[["12345"]]]);
  });
});

describe("matchLetters", () => {
  const letters = (text: string, l: string) => matchLetters(looseTokens(normalizeLoose(text)), 0, l);
  it.each([
    ["LVT", "lvt"],
    ["L V T", "lvt"],
    ["Lê Văn Thọ", "lvt"],
    ["Lê Vân Thọ", "lvt"],
    ["lọ VT", "lvt"],
    ["lờ vờ tờ", "lvt"],
    ["đường số ba", "ds3"],
    ["Phan Văn Bảy", "pvb"],
  ])("%s ⇒ %s", (text, l) => {
    expect(letters(text, l)).toBeGreaterThan(0);
  });

  it("chữ khác ⇒ -1", () => {
    expect(letters("sơn", "lvt")).toBe(-1);
    expect(letters("Lê Văn Tám", "lvb")).toBe(-1);
  });
});

describe("resolveSpokenBuilding — đọc số nhà + tên đường/chữ mã ⇒ chắc chắn", () => {
  it.each([
    // Đúng các câu máy chép giọng trả về trong ảnh chụp 02/10/2026.
    ["Một lá hai Lê Vân Thọ, sửa vòi", "b102"],
    ["Một lẻ hai lọ VT sơn", "b102"],
    ["1 L 2 LVT bóng đèn", "b102"],
    ["102 Lê Văn Thọ mua bóng đèn", "b102"],
    // Cách đọc quen của người Việt.
    ["một lẻ hai Lê Văn Thọ sơn ba trăm nghìn", "b102"],
    ["Nhà một lẻ hai Lê Văn Thọ, phòng 301", "b102"],
    ["một lẻ hai LVT keo hai mươi nghìn", "b102"],
    ["một trăm lẻ hai L V T", "b102"],
    ["mua bóng đèn cho một lẻ hai Lê Văn Thọ", "b102"],
    ["bốn một bảy Lê Văn Thọ thay khoá", "b417"],
    ["bốn trăm mười bảy LVT", "b417"],
    ["bốn không năm PVB tiền rác", "b405"],
    ["bốn trăm linh năm Phan Văn Bảy", "b405"],
    ["một ba chín hai Quang Trung", "b1392"],
    ["một nghìn ba trăm chín mươi hai QT", "b1392"],
    ["tám mươi đường số ba", "b80"],
    ["chín năm không Nguyễn Kiệm", "b950"],
    ["mười lăm KV", "b15"],
  ])("%s ⇒ %s", (text, want) => {
    expect(spoken(text)).toEqual({ building: want, candidates: [], guessed: false });
  });

  it("hai toà khác nhau đều chắc ⇒ để người dùng chọn", () => {
    const r = spoken("một lẻ hai LVT và bốn một bảy LVT");
    expect(r.building).toBeNull();
    expect(r.candidates.sort()).toEqual(["b102", "b417"]);
  });
});

describe("resolveSpokenBuilding — chỉ đoán (gợi ý, không tự điền)", () => {
  it("máy chép mất tên đường, còn số nhà ở đầu câu ⇒ gợi ý đúng toà có số đó", () => {
    expect(spoken("Một lá hai sơn 30 nghìn")).toEqual({ building: null, candidates: ["b102"], guessed: true });
    expect(spoken("nhà một lẻ hai thay bóng đèn")).toEqual({ building: null, candidates: ["b102"], guessed: true });
  });

  it("chỉ nói tên đường ⇒ gợi ý mọi toà trên đường đó", () => {
    const r = spoken("nhà Lê Văn Thọ thay bóng đèn 40k");
    expect(r.building).toBeNull();
    expect(r.guessed).toBe(true);
    expect(r.candidates.sort()).toEqual(["b102", "b417"]);
  });

  it("đã có số nhà + tên đường thì không kéo toà cùng đường vào ứng viên", () => {
    expect(spoken("một lẻ hai Lê Văn Thọ").candidates).toEqual([]);
  });
});

describe("resolveSpokenBuilding — không nhầm tiền, số lượng thành toà", () => {
  it.each([
    "mua 102 cái ốc 30k",
    "102 nghìn tiền rác",
    "102.000 tiền điện",
    "sơn ba trăm nghìn, keo hai mươi nghìn",
    "hai lít xăng",
    "15 bóng đèn 300k",
    "ăn trưa 50k",
  ])("%s ⇒ không toà", (text) => {
    expect(spoken(text)).toEqual({ building: null, candidates: [], guessed: false });
  });
});

describe("canonicalizeSpoken — mô tả phiếu dùng mã toà như khi gõ", () => {
  it.each([
    ["Một lẻ hai Lê Văn Thọ mua bóng đèn", "102LVT mua bóng đèn"],
    ["102 Lê Văn Thọ mua bóng đèn", "102LVT mua bóng đèn"],
    ["Bóng đèn cho 1 L 2 LVT", "Bóng đèn cho 102LVT"],
    ["bốn không năm PVB tiền rác", "405PVB tiền rác"],
  ])("%s ⇒ %s", (text, want) => {
    expect(canonicalizeSpoken(text, buildings)).toBe(want);
  });

  it("chỉ đoán ⇒ giữ nguyên chữ người nói", () => {
    expect(canonicalizeSpoken("Một lá hai sơn", buildings)).toBe("Một lá hai sơn");
    expect(canonicalizeSpoken("thay bóng đèn", buildings)).toBe("thay bóng đèn");
  });
});

// Đúng hình dạng dữ liệu thật (đo 02/10/2026): tên = mã, nhiều toà mã chỉ là số, tên đường không có ở
// đâu — tên thường gọi (bảng building_common_names) mới mang "Lê Văn Thọ".
const real: SpokenBuildingRef[] = [
  { id: "r102", name: "102LVT", code: "102LVT" },
  { id: "r417", name: "417LVT", code: "417" },
  { id: "r1392", name: "1392QT", code: "1392qt, QT, 1392" },
  { id: "r111", name: "111PVC", code: "111" },
  { id: "r950", name: "950NK", code: "950NK,950" },
  { id: "rkho", name: "Kho Văn Phòng Chung", code: "Chung, VP" },
];
const named: SpokenBuildingRef[] = real.map((b) => ({
  ...b,
  commonNames: {
    r102: ["Lê Văn Thọ", "một lẻ hai Lê Văn Thọ"],
    r417: ["Lê Văn Thọ"],
    r1392: ["Quang Trung"],
    r950: ["Gò Vấp"],
    rkho: ["kho chung"],
  }[b.id],
}));
const said = (text: string, list = named) => resolveSpokenBuilding(normalizeLoose(text), list);

describe("dữ liệu thật — tên toà viết như mã cũng là mã", () => {
  it.each([
    ["bốn một bảy LVT thay khoá", "r417"],
    ["417 LVT thay khoá", "r417"],
    ["bốn trăm mười bảy Lê Văn Thọ", "r417"],
    ["một một một PVC tiền rác", "r111"],
    ["1392 QT tiền rác", "r1392"],
  ])("%s ⇒ %s (không cần tên thường gọi)", (text, want) => {
    expect(said(text, real)).toEqual({ building: want, candidates: [], guessed: false });
  });
});

describe("tên thường gọi (building_common_names)", () => {
  it("tên không trùng chữ của mã: số nhà + tên thường gọi ⇒ chắc; thiếu tên thường gọi chỉ là đoán", () => {
    expect(said("chín năm không Gò Vấp mua sơn")).toEqual({ building: "r950", candidates: [], guessed: false });
    expect(said("chín năm không Gò Vấp mua sơn", real)).toEqual({ building: null, candidates: ["r950"], guessed: true });
  });

  it("chỉ nói tên thường gọi ⇒ đoán; hai toà cùng tên đường ⇒ cả hai là ứng viên", () => {
    expect(said("nhà Quang Trung thay bóng đèn")).toEqual({ building: null, candidates: ["r1392"], guessed: true });
    const r = said("nhà Lê Văn Thọ thay bóng đèn");
    expect(r.building).toBeNull();
    expect(r.guessed).toBe(true);
    expect(r.candidates.sort()).toEqual(["r102", "r417"]);
    expect(said("nhà Lê Văn Thọ thay bóng đèn", real)).toEqual({ building: null, candidates: [], guessed: false });
  });

  it("tên đã có cách đọc số nhà ('một lẻ hai Lê Văn Thọ') ⇒ chắc, không kéo toà cùng đường", () => {
    expect(said("một lẻ hai Lê Văn Thọ sơn")).toEqual({ building: "r102", candidates: [], guessed: false });
    expect(said("Một lá hai Lê Vân Thọ sửa vòi")).toEqual({ building: "r102", candidates: [], guessed: false });
  });

  it("toà không có số nhà: tên thường gọi đứng một mình chỉ là đoán", () => {
    expect(said("mua thùng cho kho chung")).toEqual({ building: null, candidates: ["rkho"], guessed: true });
  });

  it("tên có chữ số riêng ('Toà 45 Trần Thái Tông') ⇒ dùng số đó", () => {
    const b: SpokenBuildingRef[] = [{ id: "r45", name: "45TTT", code: "45", commonNames: ["Toà 45/3 Trần Thái Tông"] }];
    expect(said("bốn lăm Trần Thái Tông sửa cửa", b)).toEqual({ building: "r45", candidates: [], guessed: false });
  });

  it("tên rác (rỗng, chỉ chữ mở đầu, không phải chuỗi) không làm hỏng gì", () => {
    const b = [{ id: "rx", name: "102LVT", code: "102LVT", commonNames: ["", "toà", "  ", 42 as unknown as string] }];
    expect(said("một lẻ hai LVT", b)).toEqual({ building: "rx", candidates: [], guessed: false });
    expect(said("toà sơn", b)).toEqual({ building: null, candidates: [], guessed: false });
  });

  it("tiền/số lượng vẫn không thành toà dù có tên thường gọi", () => {
    for (const text of ["950 nghìn tiền rác", "mua 102 cái ốc", "chín trăm năm mươi nghìn"]) {
      expect(said(text)).toEqual({ building: null, candidates: [], guessed: false });
    }
  });

  it("mô tả phiếu ghi mã toà thay cho cụm đọc bằng tên thường gọi", () => {
    expect(canonicalizeSpoken("chín năm không Gò Vấp mua sơn", named)).toBe("950NK mua sơn");
    expect(canonicalizeSpoken("Bốn một bảy Lê Văn Thọ thay khoá", named)).toBe("417LVT thay khoá");
  });
});

describe("primaryCode — mã hiển thị", () => {
  it.each([
    [{ id: "a", name: "417LVT", code: "417" }, "417LVT"],
    [{ id: "b", name: "1392QT", code: "1392qt, QT, 1392" }, "1392qt"],
    [{ id: "c", name: "950NK", code: "950, 950NK" }, "950NK"],
    [{ id: "d", name: "Kho Văn Phòng Chung", code: "Chung, VP" }, "Chung"],
    [{ id: "e", name: "Toà 15", code: "15" }, "15"],
    [{ id: "f", name: "Nhà mới", code: null }, "Nhà mới"],
  ])("%o ⇒ %s", (b, want) => {
    expect(primaryCode(b)).toBe(want);
  });
});

describe("canonicalizeSpokenRooms — số phòng đọc bằng lời ⇒ chữ số", () => {
  const rooms = [
    { name: "301", code: null },
    { name: "P1002", code: null },
    { name: "A1", code: null },
  ];
  it.each([
    ["102LVT, phòng ba lẻ một. Sơn", "102LVT, phòng 301. Sơn"],
    ["sửa vòi phòng ba trăm linh một", "sửa vòi phòng 301"],
    ["p một không không hai thay khoá", "p 1002 thay khoá"],
  ])("%s ⇒ %s", (text, want) => {
    expect(canonicalizeSpokenRooms(text, rooms)).toBe(want);
  });

  it("phòng không có thật, hoặc một chữ số đứng riêng ⇒ giữ nguyên", () => {
    expect(canonicalizeSpokenRooms("phòng bốn lẻ năm", rooms)).toBe("phòng bốn lẻ năm");
    expect(canonicalizeSpokenRooms("phòng ba sơn", rooms)).toBe("phòng ba sơn");
    expect(canonicalizeSpokenRooms("ba lẻ một", rooms)).toBe("ba lẻ một");
  });
});
