// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Building, Room } from "@/pages/phong-trong/sampleData";

const m = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>, hotlines: {} as Record<string, unknown>, rooms: {} as Record<string, unknown>,
  save: vi.fn(), sheetSave: vi.fn(), retry: vi.fn(), createHotline: vi.fn(), updateHotline: vi.fn(),
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
  useCreateHotline: () => ({ mutateAsync: m.createHotline, isPending: false }),
  useUpdateHotline: () => ({ mutateAsync: m.updateHotline, isPending: false }),
}));
vi.mock("@/hooks/useMyAvailableRooms", () => ({ useMyAvailableRooms: () => m.rooms }));
vi.mock("@/hooks/useSaveRoomListSheet", async (original) => ({
  ...(await original<typeof import("@/hooks/useSaveRoomListSheet")>()),
  useSaveRoomListSheet: () => ({ mutateAsync: m.sheetSave, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import DisplaySettingsTab from "../DisplaySettingsTab";
import { RoomListSheetSaveError } from "@/hooks/useSaveRoomListSheet";
import { applySheetDraft, effectiveHotline, ownPhone, sheetChanges, sheetErrors } from "../roomListSheetDraft";
import { buildRoomListTable } from "@/pages/phong-trong/roomListTable";

const HOT = "0923 889 880";
const room = (over: Partial<Room>): Room => ({
  id: "r1", no: 502, code: "502", buildingId: "b1", buildingName: "102LVT", buildingArea: "", buildingAddr: "",
  floor: 5, type: "", price: 4, area: 20, status: "free", amenities: [], availDate: null, imgCount: 0, phClass: "",
  x: 0, y: 0, w: 0, h: 0, ...over,
});
const building = (over: Partial<Building>): Building => ({
  id: "b1", code: "", name: "102LVT", area: "", district: "", manager: "admin ihome+", phone: HOT, hotline: HOT, salePolicy: "",
  address: "102/30 Lê Văn Thọ, khu phố 6, Phường Thông Tây Hội, Thành phố Hồ Chí Minh", liftLabel: "Thang máy",
  lift: true, policy: "", floors: [], freeCount: 1, total: 1, rooms: [room({})], ...over,
});
const data = () => [
  building({ rooms: [room({}), room({ id: "r9", code: "601", floor: 6, status: "rented" })] }),
  building({ id: "b2", name: "403PVB", address: "403PVB, Phường 15, Quận Tân Bình, Hồ Chí Minh", phone: "0708 882 357",
    liftLabel: "Thang bộ", rooms: [room({ id: "r2", code: "401", buildingId: "b2", saleNote: "Ký 1 năm giảm 200k" })] }),
];
const hotlines = [
  { id: "h-old", name: "Cũ", phone_number: "0111 111 111", is_active: false, created_at: "2025-01-01" },
  { id: "h1", name: "Admin", phone_number: HOT, is_active: true, created_at: "2026-01-01" },
  { id: "h2", name: "Kho", phone_number: "0999 999 999", is_active: true, created_at: "2026-02-01" },
];
const query = (value: unknown) => ({ data: value, status: "success", fetchStatus: "idle", isLoading: false, isError: false, error: null, refetch: m.retry, dataUpdatedAt: Date.now() });

describe("roomListSheetDraft (thuần)", () => {
  it("hotline mặc định = số đang bật tạo sớm nhất; số đã chọn mà đang tắt thì không in (khớp RPC)", () => {
    expect(effectiveHotline(hotlines, null)?.id).toBe("h1");
    expect(effectiveHotline(hotlines, "h2")?.id).toBe("h2");
    expect(effectiveHotline(hotlines, "h-old")).toBeUndefined();
  });

  it("SĐT riêng = số tòa khác hotline; trùng hotline (khác cách viết) coi như dùng hotline", () => {
    expect(ownPhone(building({ phone: "0923889880" }))).toBe("");
    expect(ownPhone(building({ phone: "0708 882 357" }))).toBe("0708 882 357");
    // Có số gốc đang lưu thì hiện đúng số đó, kể cả khi trùng hotline (để còn xoá được).
    expect(ownPhone(building({ phone: HOT, contactPhone: HOT }))).toBe(HOT);
    expect(ownPhone(building({ phone: HOT, contactPhone: "" }))).toBe("");
  });

  it("đổi hotline: tòa đang lưu số = hotline cũ thì ảnh in số đó (khớp ảnh thật sau khi lưu)", () => {
    const t = buildRoomListTable(applySheetDraft([building({ phone: HOT, contactPhone: HOT })], {
      hotline: "0999 999 999", salePolicy: "", edits: { phones: {}, policies: {} },
    }));
    expect(t.groups[0].phone).toBe(HOT);
  });

  it("bản nháp chạy qua đúng bảng của ảnh: hotline mới, SĐT riêng, chính sách", () => {
    const preview = applySheetDraft(data(), {
      hotline: "0999 999 999", salePolicy: "Nước 100k/người",
      edits: { phones: { b2: "" }, policies: { r1: " Giảm 300k " } },
    });
    const t = buildRoomListTable(preview);
    expect(t.contactLines).toEqual(["LIÊN HỆ ADMIN ĐỂ MỞ CỬA", "0999 999 999"]);
    expect(t.infoLines).toEqual(["Nước 100k/người"]);
    expect(t.groups.map((g) => g.phone)).toEqual([null, null]); // b2 xoá số riêng → dùng hotline
    expect(t.groups[0].rows.map((r) => r.policy)).toEqual(["Giảm 300k"]);
  });

  it("chỉ ghi ô khác giá trị đang lưu; gõ lại như cũ thì không ghi", () => {
    const changes = sheetChanges(data(), { phones: { b1: "", b2: " 0708 882 357 " }, policies: { r1: "", r2: "Giảm 500k" } });
    expect(changes).toEqual({ buildings: [], rooms: [{ id: "r2", saleNote: "Giảm 500k" }] });
    expect(sheetChanges(data(), { phones: { b2: "" }, policies: { r2: "" } }))
      .toEqual({ buildings: [{ id: "b2", phone: null }], rooms: [{ id: "r2", saleNote: null }] });
  });

  it("SĐT sai dạng bị chặn trước khi ghi", () => {
    expect(sheetErrors({ buildings: [{ id: "b1", phone: "abc" }], rooms: [] })).toHaveProperty("phone:b1");
    expect(sheetErrors({ buildings: [{ id: "b1", phone: "((((....))))" }], rooms: [] })).toHaveProperty("phone:b1");
    expect(sheetErrors({ buildings: [{ id: "b1", phone: "(028) 3812 3456" }], rooms: [] })).toEqual({});
    expect(sheetErrors({ buildings: [{ id: "b1", phone: "+84 901.234.567" }, { id: "b2", phone: null }], rooms: [] })).toEqual({});
  });
});

describe("DisplaySettingsTab — bảng phòng trống", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.settings = query({ soon_days: 30, show_rented: true, hotline_id: null, sale_policy: null });
    m.hotlines = query(hotlines);
    m.rooms = query(data());
    m.save.mockResolvedValue({});
    m.sheetSave.mockResolvedValue([]);
    m.retry.mockResolvedValue({});
  });
  afterEach(cleanup);
  const view = () => render(<MemoryRouter><DisplaySettingsTab /></MemoryRouter>);

  it("hiện bảng như ảnh: địa chỉ tới phường, không chữ admin, chỉ phòng còn chào", () => {
    view();
    const sheet = screen.getByTestId("room-list-sheet");
    expect(within(sheet).getByText("102/30 Lê Văn Thọ, khu phố 6, Phường Thông Tây Hội")).toBeTruthy();
    expect(within(sheet).getByText("403PVB, Phường 15, Quận Tân Bình")).toBeTruthy();
    expect(sheet.textContent).not.toMatch(/Thành phố|admin ihome/i);
    expect(sheet.textContent).not.toContain("601");
    expect((screen.getByRole("textbox", { name: "SĐT riêng của nhà 102/30 Lê Văn Thọ, khu phố 6, Phường Thông Tây Hội" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("textbox", { name: "Chính sách sale phòng 401" }) as HTMLTextAreaElement).value).toBe("Ký 1 năm giảm 200k");
    expect((screen.getByLabelText("Hotline chung cho tất cả nhà") as HTMLInputElement).value).toBe(HOT);
  });

  it("chưa có hotline: ô trống báo đang in số nào; gõ số rồi Lưu → tạo hotline gắn công ty, giữ Mặc định", async () => {
    m.hotlines = query([]);
    m.rooms = query(data().map((b) => ({ ...b, hotline: "" }))); // RPC cũng không có contact khi chưa có hotline
    m.createHotline.mockResolvedValue({ id: "h-new", name: "Hotline chung" });
    view();
    const input = screen.getByLabelText("Hotline chung cho tất cả nhà") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByText(/ảnh đang in SĐT dùng nhiều nhất của các nhà \(0923 889 880\)/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "0909 000 111" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(m.save).toHaveBeenCalledOnce());
    expect(m.createHotline).toHaveBeenCalledWith({ name: "Hotline chung", phone_number: "0909 000 111", is_active: true, organization_id: "org-1" });
    expect(m.updateHotline).not.toHaveBeenCalled();
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ hotline_id: null }));
    expect(m.createHotline.mock.invocationCallOrder[0]).toBeLessThan(m.save.mock.invocationCallOrder[0]);
  });

  it("đã có hotline: gõ số mới → sửa đúng hotline đang dùng; số sai dạng thì chặn", async () => {
    m.updateHotline.mockResolvedValue({ id: "h1" });
    view();
    const input = screen.getByLabelText("Hotline chung cho tất cả nhà");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
    expect(m.updateHotline).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "0923 889 881" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(m.save).toHaveBeenCalledOnce());
    expect(m.updateHotline).toHaveBeenCalledWith({ id: "h1", updates: { phone_number: "0923 889 881" } });
    expect(m.createHotline).not.toHaveBeenCalled();
  });

  it("lưu hotline hỏng → dừng, không lưu cài đặt/ô bảng", async () => {
    m.updateHotline.mockRejectedValue({ code: "42501", message: "SQL_PRIVATE" });
    view();
    fireEvent.change(screen.getByLabelText("Hotline chung cho tất cả nhà"), { target: { value: "0923 889 881" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(m.save).not.toHaveBeenCalled();
    expect(m.sheetSave).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("SQL_PRIVATE");
  });

  it("SĐT sai → báo ngay tại ô, không ghi gì; sửa xong thì lưu cài đặt rồi mới lưu ô", async () => {
    view();
    const phone = screen.getByRole("textbox", { name: /SĐT riêng của nhà 102\/30/ });
    fireEvent.change(phone, { target: { value: "abc" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Chính sách sale phòng 502" }), { target: { value: " Giảm 300k " } });
    fireEvent.change(screen.getByLabelText("Chính sách sale chung"), { target: { value: "  Nước 100k/người\nXe free  " } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(phone.getAttribute("aria-invalid")).toBe("true"));
    expect(m.save).not.toHaveBeenCalled();
    expect(m.sheetSave).not.toHaveBeenCalled();

    fireEvent.change(phone, { target: { value: "0901 234 567" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(m.sheetSave).toHaveBeenCalledOnce());
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ sale_policy: "Nước 100k/người\nXe free", hotline_id: null }));
    expect(m.save.mock.invocationCallOrder[0]).toBeLessThan(m.sheetSave.mock.invocationCallOrder[0]);
    expect(m.sheetSave).toHaveBeenCalledWith({ buildings: [{ id: "b1", phone: "0901 234 567" }], rooms: [{ id: "r1", saleNote: "Giảm 300k" }] });
  });

  it("cài đặt lưu hỏng → không ghi ô nào của bảng", async () => {
    m.save.mockRejectedValue({ code: "42501", message: "SQL_PRIVATE" });
    view();
    fireEvent.change(screen.getByRole("textbox", { name: "Chính sách sale phòng 502" }), { target: { value: "Giảm 300k" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(m.save).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(m.sheetSave).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("SQL_PRIVATE");
  });

  it("lưu dở dang → bỏ ô đã lưu khỏi nháp, giữ ô chưa lưu và báo rõ số ô", async () => {
    m.sheetSave.mockRejectedValue(new RoomListSheetSaveError(["phone:b1"], 2, { code: "42501", message: "SQL_PRIVATE" }));
    view();
    fireEvent.change(screen.getByRole("textbox", { name: /SĐT riêng của nhà 102\/30/ }), { target: { value: "0901 234 567" } });
    const policy = screen.getByRole("textbox", { name: "Chính sách sale phòng 502" });
    fireEvent.change(policy, { target: { value: "Giảm 300k" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Đã lưu 1/2 ô"));
    expect((policy as HTMLTextAreaElement).value).toBe("Giảm 300k");
    expect((screen.getByRole("textbox", { name: /SĐT riêng của nhà 102\/30/ }) as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("SQL_PRIVATE");
  });
});
