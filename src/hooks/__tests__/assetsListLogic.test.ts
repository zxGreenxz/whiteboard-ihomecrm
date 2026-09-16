// Phần logic tách được của màn Tài sản: lọc theo phòng + từ khoá, và tổng hợp
// (tổng số, tổng giá trị, đếm theo tình trạng). Trước đây hai việc này nằm
// thẳng trong thân component và chạy lại mỗi phím gõ, kể cả khi dữ liệu không
// đổi; tách ra để `useMemo` bọc được và để kiểm ngữ nghĩa bằng test thuần.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { filterAssets, summarizeAssets } = await import("@/hooks/useAssets");
type AssetWithRelations = import("@/hooks/useAssets").AssetWithRelations;

let dem = 0;
function taiSan(phan: Partial<AssetWithRelations> = {}): AssetWithRelations {
  dem += 1;
  return {
    id: `ts-${dem}`,
    name: `Tài sản ${dem}`,
    code: `TS${String(dem).padStart(3, "0")}`,
    room_id: null,
    purchase_price: 1_000_000,
    quantity: 1,
    condition: "GOOD",
    ...phan,
  } as AssetWithRelations;
}

describe("filterAssets", () => {
  it("không có bộ lọc → trả nguyên danh sách", () => {
    const ds = [taiSan(), taiSan(), taiSan()];
    expect(filterAssets(ds, {})).toHaveLength(3);
    expect(filterAssets(ds, { search: "" })).toHaveLength(3);
  });

  it("roomId chỉ giữ tài sản của đúng phòng đó", () => {
    const ds = [taiSan({ room_id: "p1" }), taiSan({ room_id: "p2" }), taiSan({ room_id: null })];
    expect(filterAssets(ds, { roomId: "p1" }).map((a) => a.room_id)).toEqual(["p1"]);
  });

  it("từ khoá khớp tên, mã hoặc tên loại — không phân biệt hoa thường", () => {
    const ds = [
      taiSan({ name: "Máy lạnh Daikin", code: "ML001" }),
      taiSan({ name: "Tủ lạnh", code: "TL001", category: { id: "c1", name: "Điện lạnh" } }),
      taiSan({ name: "Giường", code: "GI001", category: { id: "c2", name: "Nội thất" } }),
    ];
    expect(filterAssets(ds, { search: "máy LẠNH" }).map((a) => a.code)).toEqual(["ML001"]);
    expect(filterAssets(ds, { search: "tl00" }).map((a) => a.code)).toEqual(["TL001"]);
    expect(filterAssets(ds, { search: "điện lạnh" }).map((a) => a.code)).toEqual(["TL001"]);
    expect(filterAssets(ds, { search: "không có" })).toEqual([]);
  });

  it("roomId và từ khoá cùng lúc là giao (AND)", () => {
    const ds = [
      taiSan({ name: "Máy lạnh", room_id: "p1" }),
      taiSan({ name: "Máy lạnh", room_id: "p2" }),
      taiSan({ name: "Giường", room_id: "p1" }),
    ];
    const ra = filterAssets(ds, { roomId: "p1", search: "máy" });
    expect(ra).toHaveLength(1);
    expect(ra[0]?.room_id).toBe("p1");
  });

  it("tài sản thiếu tên/mã/loại không làm hàm nổ khi có từ khoá", () => {
    const ds = [taiSan({ name: null as unknown as string, code: null, category: undefined })];
    expect(filterAssets(ds, { search: "x" })).toEqual([]);
  });
});

describe("summarizeAssets", () => {
  it("rỗng → mọi số bằng 0", () => {
    expect(summarizeAssets([])).toEqual({ totalAssets: 0, totalValue: 0, byCondition: {} });
  });

  it("tổng giá trị = Σ giá × số lượng; giá null tính 0, số lượng null tính 1", () => {
    const ds = [
      taiSan({ purchase_price: 2_000_000, quantity: 3 }),
      taiSan({ purchase_price: null, quantity: 5 }),
      taiSan({ purchase_price: 500_000, quantity: null }),
    ];
    const s = summarizeAssets(ds);
    expect(s.totalAssets).toBe(3);
    expect(s.totalValue).toBe(6_000_000 + 0 + 500_000);
  });

  it("đếm theo tình trạng; tình trạng null xếp vào GOOD", () => {
    const ds = [
      taiSan({ condition: "NEW" }),
      taiSan({ condition: "BROKEN" }),
      taiSan({ condition: "BROKEN" }),
      taiSan({ condition: null }),
    ];
    expect(summarizeAssets(ds).byCondition).toEqual({ NEW: 1, BROKEN: 2, GOOD: 1 });
  });
});
