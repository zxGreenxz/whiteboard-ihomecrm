// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Building, Room } from "@/pages/phong-trong/sampleData";
import type { HeaderAction } from "../mobile/types";

const m = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>, hotlines: {} as Record<string, unknown>, rooms: {} as Record<string, unknown>,
  save: vi.fn(), sheetSave: vi.fn(), retry: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/contexts/OrganizationContext", () => ({ useOrganization: () => ({ selectedOrganizationId: "org-1" }) }));
vi.mock("@/hooks/usePublicRoomSettings", () => ({
  usePublicRoomSettings: () => m.settings,
  useUpsertPublicRoomSettings: () => ({ mutateAsync: m.save, isPending: false }),
  PUBLIC_ROOM_SETTINGS_DEFAULTS: { soon_days: 30, show_rented: true, hotline_id: null, sale_policy: null },
}));
vi.mock("@/hooks/useHotlines", () => ({
  useHotlines: () => m.hotlines,
  useCreateHotline: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateHotline: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useMyAvailableRooms", () => ({ useMyAvailableRooms: () => m.rooms }));
vi.mock("@/hooks/useSaveRoomListSheet", async (original) => ({
  ...(await original<typeof import("@/hooks/useSaveRoomListSheet")>()),
  useSaveRoomListSheet: () => ({ mutateAsync: m.sheetSave, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import MobileDisplaySettings from "../mobile/MobileDisplaySettings";

const HOT = "0923 889 880";
const room = (over: Partial<Room>): Room => ({
  id: "r1", no: 502, code: "502", buildingId: "b1", buildingName: "102LVT", buildingArea: "", buildingAddr: "",
  floor: 5, type: "", price: 4, area: 20, status: "free", amenities: [], availDate: null, imgCount: 0, phClass: "",
  saleFactKey: "fact-key", x: 0, y: 0, w: 0, h: 0, ...over,
});
const building = (over: Partial<Building>): Building => ({
  id: "b1", code: "", name: "102LVT", area: "", district: "", manager: "", phone: HOT, hotline: HOT, salePolicy: "",
  address: "102/30 Lê Văn Thọ, khu phố 6, Phường Thông Tây Hội, Thành phố Hồ Chí Minh", liftLabel: "Thang máy",
  lift: true, policy: "", floors: [], freeCount: 1, total: 1, rooms: [room({})], ...over,
});
const data = () => [
  building({ rooms: [room({ saleNote: "Giảm 300k tháng đầu" })] }),
  building({ id: "b2", name: "403PVB", address: "403PVB, Phường 15, Quận Tân Bình, Hồ Chí Minh", phone: HOT, liftLabel: "",
    rooms: [room({ id: "r2", code: "401", buildingId: "b2", saleNote: "Ký 1 năm giảm 200k" })] }),
];
const hotlines = [
  { id: "h1", name: "Admin", phone_number: HOT, is_active: true, created_at: "2026-01-01" },
  { id: "h2", name: "Kho", phone_number: "0999 999 999", is_active: true, created_at: "2026-02-01" },
];
const query = (value: unknown) => ({ data: value, status: "success", fetchStatus: "idle", isLoading: false, isError: false, error: null, refetch: m.retry, dataUpdatedAt: Date.now() });

let header: HeaderAction | null = null;
const view = () => render(
  <MemoryRouter><div className="cm-app"><MobileDisplaySettings onHeaderAction={(a) => { header = a; }} /></div></MemoryRouter>,
);
const footerSave = () => screen.getAllByRole("button", { name: "Lưu cài đặt" })[0];

describe("MobileDisplaySettings — bảng phòng trống trên mobile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    header = null;
    m.settings = query({ soon_days: 30, show_rented: true, hotline_id: null, sale_policy: null });
    m.hotlines = query(hotlines);
    m.rooms = query(data());
    m.save.mockResolvedValue({});
    m.sheetSave.mockResolvedValue([]);
    m.retry.mockResolvedValue({});
  });
  afterEach(cleanup);

  it("mỗi nhà một thẻ (nhà đầu mở sẵn), đếm nhà/phòng; bánh răng trên app-bar mở Cài đặt chung", async () => {
    view();
    expect(screen.getByText("2 nhà · 2 phòng")).toBeTruthy();
    expect(screen.getByText("thang máy · 1 phòng · 1/1 có chính sách riêng")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Chính sách sale phòng 502" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Chính sách sale phòng 401" })).toBeNull();
    expect(header).toMatchObject({ label: "Cài đặt chung", iconOnly: true });

    act(() => header?.onClick());
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Kho/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ hotline_id: "h2" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("SĐT riêng của nhà: nhập số khác hotline → nút hiện số; Lưu ghi public_contact_phone", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /^SĐT riêng của nhà 102\/30/ }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: "SĐT riêng của nhà" });
    fireEvent.change(input, { target: { value: HOT } });
    expect(within(dialog).getByText("Trùng hotline — ảnh không in lại")).toBeTruthy();
    fireEvent.change(input, { target: { value: "0901 234 567" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Lưu số này" }));
    expect(screen.getByRole("button", { name: /^SĐT riêng của nhà 102\/30/ }).textContent).toContain("0901 234 567");
    fireEvent.click(footerSave());
    await waitFor(() => expect(m.sheetSave).toHaveBeenCalledWith({ buildings: [{ id: "b1", phone: "0901 234 567" }], rooms: [] }));
  });

  it("giá sửa bằng chạm 2 lần; tab Tình trạng gợi ý chữ tự tính; Lưu ghi thẳng vào phòng", async () => {
    view();
    const price = screen.getByRole("button", { name: /Giá phòng 502: 4\.000\.000/ });
    fireEvent.click(price);
    expect(screen.queryByRole("textbox", { name: "Giá phòng 502" })).toBeNull(); // một chạm chưa mở
    fireEvent.click(price);
    const input = screen.getByRole("textbox", { name: "Giá phòng 502" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "4800000" } });
    expect(input.value).toBe("4.800.000");
    fireEvent.blur(input);

    fireEvent.click(screen.getByRole("tab", { name: "Tình trạng" }));
    const status = screen.getByRole("textbox", { name: "Tình trạng phòng 502" }) as HTMLInputElement;
    expect(status.placeholder).toBe("Tự tính: TRỐNG SẴN");
    fireEvent.change(status, { target: { value: "Trống từ 5/11" } });
    expect(screen.getByText("TRỐNG TỪ 5/11")).toBeTruthy(); // nhãn phòng in đúng chữ ảnh sẽ in

    fireEvent.click(screen.getByRole("tab", { name: /Loại phòng/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Loại phòng phòng 502" }), { target: { value: "Gác" } });
    expect(screen.getByText(/Không thấy "Phòng Nm²" — giữ diện tích 20m²/)).toBeTruthy();

    fireEvent.click(footerSave());
    await waitFor(() => expect(m.sheetSave).toHaveBeenCalledOnce());
    expect(m.sheetSave).toHaveBeenCalledWith({ buildings: [], rooms: [{ id: "r1", rentPrice: 4800000, roomType: "Gác", saleStatusNote: "Trống từ 5/11", saleStatusKey: "fact-key" }] });
  });

  it("sao chép chính sách sang phòng khác: mặc định bổ sung xuống dòng, bật Thay thế thì ghi đè", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Sao chép chính sách phòng 502 sang phòng khác" }));
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Chọn phòng nhận" })).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /401/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sao chép cho 1 phòng" }));
    expect(screen.getByRole("status").textContent).toContain("Đã bổ sung chính sách cho 1 phòng");

    fireEvent.click(footerSave());
    await waitFor(() => expect(m.sheetSave).toHaveBeenCalledWith({
      buildings: [], rooms: [{ id: "r2", saleNote: "Ký 1 năm giảm 200k\nGiảm 300k tháng đầu" }],
    }));

    fireEvent.click(screen.getByRole("button", { name: "Sao chép chính sách phòng 502 sang phòng khác" }));
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Chọn tất cả" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Thay thế chính sách cũ/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sao chép cho 1 phòng" }));
    fireEvent.click(footerSave());
    await waitFor(() => expect(m.sheetSave).toHaveBeenLastCalledWith({ buildings: [], rooms: [{ id: "r2", saleNote: "Giảm 300k tháng đầu" }] }));
  });

  it("sao chép: phòng nhận có câu dài hơn chứa chữ nguồn vẫn được bổ sung; đã có đúng dòng thì bỏ qua", async () => {
    m.rooms = query([building({ rooms: [
      room({ saleNote: "Giảm 300k" }),
      room({ id: "r2", code: "401", saleNote: "Giảm 300k cho HĐ 1 năm" }),
      room({ id: "r3", code: "402", saleNote: "Xe free\nGiảm 300k" }),
    ] })]);
    view();
    fireEvent.click(screen.getByRole("button", { name: "Sao chép chính sách phòng 502 sang phòng khác" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Chọn tất cả" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sao chép cho 2 phòng" }));
    expect(screen.getByRole("status").textContent).toBe("Đã bổ sung chính sách cho 1 phòng · 1 phòng đã có · chưa lưu");
    fireEvent.click(footerSave());
    await waitFor(() => expect(m.sheetSave).toHaveBeenCalledWith({ buildings: [], rooms: [{ id: "r2", saleNote: "Giảm 300k cho HĐ 1 năm\nGiảm 300k" }] }));
  });

  it("ô sai → mở đúng nhà đang gập và báo tại ô, không ghi gì", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /^2\s*403PVB/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Tình trạng" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Tình trạng phòng 401" }), { target: { value: "x".repeat(121) } });
    fireEvent.click(screen.getByRole("button", { name: /^1\s*102\/30 Lê Văn Thọ/ }));
    expect(screen.queryByRole("textbox", { name: "Tình trạng phòng 401" })).toBeNull();
    fireEvent.click(footerSave());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Tình trạng phòng 401" }).getAttribute("aria-invalid")).toBe("true"));
    expect(m.save).not.toHaveBeenCalled();
    expect(m.sheetSave).not.toHaveBeenCalled();
    // Đang còn lỗi mà sang tab khác gõ: không bị kéo về ô lỗi sau mỗi phím.
    fireEvent.click(screen.getByRole("tab", { name: /Nội thất/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nội thất phòng 401" }), { target: { value: "Máy lạnh" } });
    expect(screen.getByRole("textbox", { name: "Nội thất phòng 401" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Tình trạng phòng 401" })).toBeNull();
  });

  it("Lưu trong sheet bánh răng khi có ô phòng sai → đóng sheet, mở đúng ô lỗi", async () => {
    view();
    fireEvent.click(screen.getByRole("tab", { name: "Tình trạng" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Tình trạng phòng 502" }), { target: { value: "x".repeat(121) } });
    act(() => header?.onClick());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Tình trạng phòng 502" }).getAttribute("aria-invalid")).toBe("true");
    expect(m.save).not.toHaveBeenCalled();
  });
});
