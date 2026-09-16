// @vitest-environment jsdom
//
// Màn Tài sản với danh sách dài: DOM chỉ được chứa MỘT CỬA SỔ dòng (ảo hoá),
// nhưng mọi con số tổng vẫn phải tính trên TOÀN BỘ danh sách, và lọc / mở
// dialog sửa vẫn hoạt động như cũ.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Fragment, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demDongTrongBang, giaLapKichThuocKhungCuon } from "@/components/ui/__tests__/giaLapKichThuoc";
import { formatCurrency } from "@/lib/utils";

const fx = vi.hoisted(() => ({ assets: [] as unknown[] }));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useCopilotPageContext", () => ({ useCopilotPageContext: () => {} }));
vi.mock("@/components/layout/MainLayout", () => ({
  default: ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>,
}));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock("@/lib/permissionPages", () => ({ canUse: () => true }));
vi.mock("@/hooks/usePersistedState", () => ({
  usePersistedState: <T,>(_key: string, initial: T | (() => T)) =>
    useState<T>(typeof initial === "function" ? (initial as () => T)() : initial),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
  useMutation: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/useBuildings", () => ({ useBuildings: () => ({ data: [] }) }));
vi.mock("@/hooks/useRooms", () => ({ useRooms: () => ({ data: [] }) }));
vi.mock("@/hooks/useAssets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useAssets")>()),
  useAssets: () => ({ data: fx.assets, isLoading: false }),
  useAssetMovements: () => ({ data: [] }),
  useAssetMaintenance: () => ({ data: [] }),
}));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: () => null }));
vi.mock("@/components/assets/CreateAssetDialog", () => ({ CreateAssetDialog: () => null }));
vi.mock("@/components/assets/AssetHandoverDialog", () => ({ AssetHandoverDialog: () => null }));
vi.mock("@/components/assets/AssetMovementDialog", () => ({ AssetMovementDialog: () => null }));
vi.mock("@/components/assets/AssetMaintenanceDialog", () => ({ AssetMaintenanceDialog: () => null }));
vi.mock("@/components/assets/EditAssetDialog", () => ({
  EditAssetDialog: ({ open, asset }: { open: boolean; asset: { name: string } }) =>
    open ? <div data-testid="edit-dialog">{asset.name}</div> : null,
}));

const { default: AssetsPage } = await import("../AssetsPage");

/** Giá trị của thẻ tóm tắt có nhãn `nhan` (thẻ = tổ tiên gần nhất mang lớp Card). */
function giaTriThe(nhan: string): string {
  const the = screen.getByText(nhan).closest(".rounded-lg");
  if (!the) throw new Error(`không tìm thấy thẻ "${nhan}"`);
  return within(the as HTMLElement).getByText((_t, el) => el?.tagName === "DIV" && /font-bold/.test(el.className)).textContent ?? "";
}

/** Intl vi-VN chèn NBSP trước ₫; DOM đọc qua testing-library được chuẩn hoá thành khoảng trắng thường. */
const chuanHoa = (s: string) => s.replace(/\s+/g, " ").trim();

function taiSan(i: number) {
  return {
    id: `ts-${i}`,
    name: i % 100 === 7 ? `Máy lạnh số ${i}` : `Tài sản ${i}`,
    code: `TS${String(i).padStart(4, "0")}`,
    room_id: null,
    purchase_price: 1_000 * (i + 1),
    quantity: (i % 3) + 1,
    condition: i % 5 === 0 ? "BROKEN" : "GOOD",
    category: { id: "c1", name: "Nội thất" },
  };
}

giaLapKichThuocKhungCuon();
afterEach(() => cleanup());

describe("AssetsPage · danh sách dài", () => {
  it("500 tài sản → DOM chỉ chứa một cửa sổ nhỏ dòng, không phải cả 500", () => {
    fx.assets = Array.from({ length: 500 }, (_, i) => taiSan(i));
    const { container } = render(<AssetsPage />);
    const soDong = demDongTrongBang(container);
    // eslint-disable-next-line no-console
    console.log(`[đo DOM] AssetsPage 500 tài sản → ${soDong} <tr> trong tbody`);
    expect(soDong, `tbody đang chứa ${soDong} dòng`).toBeLessThan(50);
    expect(soDong).toBeGreaterThan(0);
  });

  it("tổng số / tổng giá trị tính trên TOÀN BỘ danh sách, không chỉ cửa sổ", () => {
    fx.assets = Array.from({ length: 500 }, (_, i) => taiSan(i));
    render(<AssetsPage />);
    const tong = (fx.assets as Array<{ purchase_price: number; quantity: number }>).reduce(
      (s, a) => s + a.purchase_price * a.quantity,
      0,
    );
    expect(giaTriThe("Tổng số tài sản")).toBe("500");
    expect(chuanHoa(giaTriThe("Giá trị tổng"))).toBe(chuanHoa(formatCurrency(tong)));
  });

  it("gõ tìm kiếm lọc bảng và cập nhật tổng theo kết quả lọc", () => {
    fx.assets = Array.from({ length: 500 }, (_, i) => taiSan(i));
    const { container } = render(<AssetsPage />);
    fireEvent.change(screen.getByPlaceholderText(/Tìm kiếm theo tên/), { target: { value: "máy lạnh" } });
    // i % 100 === 7 → 5 tài sản (7, 107, 207, 307, 407)
    expect(demDongTrongBang(container)).toBe(5);
    expect(giaTriThe("Tổng số tài sản")).toBe("5");
    const tongLoc = [7, 107, 207, 307, 407].reduce((s, i) => s + 1_000 * (i + 1) * ((i % 3) + 1), 0);
    expect(chuanHoa(giaTriThe("Giá trị tổng"))).toBe(chuanHoa(formatCurrency(tongLoc)));
  });

  it("bấm Sửa mở dialog đúng tài sản của dòng đó", () => {
    fx.assets = Array.from({ length: 500 }, (_, i) => taiSan(i));
    render(<AssetsPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Sửa" })[0]!);
    expect(screen.getByTestId("edit-dialog").textContent).toBe("Tài sản 0");
  });

  it("dưới ngưỡng ảo hoá (20 dòng) → render đủ 20 dòng như cũ", () => {
    fx.assets = Array.from({ length: 20 }, (_, i) => taiSan(i));
    const { container } = render(<AssetsPage />);
    expect(demDongTrongBang(container)).toBe(20);
  });
});
