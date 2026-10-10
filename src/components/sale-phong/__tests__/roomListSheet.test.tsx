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
import {
  applySheetDraft, effectiveHotline, EMPTY_SHEET_EDITS, formatPriceInput, ownPhone, parseTypeCell, sheetChanges, sheetErrors,
} from "../roomListSheetDraft";
import { buildRoomListTable } from "@/pages/phong-trong/roomListTable";

const HOT = "0923 889 880";
const room = (over: Partial<Room>): Room => ({
  id: "r1", no: 502, code: "502", buildingId: "b1", buildingName: "102LVT", buildingArea: "", buildingAddr: "",
  floor: 5, type: "", price: 4, area: 20, status: "free", amenities: [], availDate: null, imgCount: 0, phClass: "",
  saleFactKey: "fact-key", x: 0, y: 0, w: 0, h: 0, ...over,
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
      hotline: "0999 999 999", salePolicy: "", edits: { ...EMPTY_SHEET_EDITS },
    }));
    expect(t.groups[0].phone).toBe(HOT);
  });

  it("bản nháp chạy qua đúng bảng của ảnh: hotline mới, SĐT riêng, chính sách", () => {
    const preview = applySheetDraft(data(), {
      hotline: "0999 999 999", salePolicy: "Nước 100k/người",
      edits: { ...EMPTY_SHEET_EDITS, phones: { b2: "" }, policies: { r1: " Giảm 300k " } },
    });
    const t = buildRoomListTable(preview);
    expect(t.contactLines).toEqual(["LIÊN HỆ ADMIN ĐỂ MỞ CỬA", "0999 999 999"]);
    expect(t.infoLines).toEqual(["Nước 100k/người"]);
    expect(t.groups.map((g) => g.phone)).toEqual([null, null]); // b2 xoá số riêng → dùng hotline
    expect(t.groups[0].rows.map((r) => r.policy)).toEqual(["Giảm 300k"]);
  });

  it("chỉ ghi ô khác giá trị đang lưu; gõ lại như cũ thì không ghi", () => {
    const changes = sheetChanges(data(), { ...EMPTY_SHEET_EDITS, phones: { b1: "", b2: " 0708 882 357 " }, policies: { r1: "", r2: "Giảm 500k" } });
    expect(changes).toEqual({ buildings: [], rooms: [{ id: "r2", saleNote: "Giảm 500k" }] });
    expect(sheetChanges(data(), { ...EMPTY_SHEET_EDITS, phones: { b2: "" }, policies: { r2: "" } }))
      .toEqual({ buildings: [{ id: "b2", phone: null }], rooms: [{ id: "r2", saleNote: null }] });
  });

  it("SĐT sai dạng bị chặn trước khi ghi", () => {
    expect(sheetErrors({ buildings: [{ id: "b1", phone: "abc" }], rooms: [] })).toHaveProperty("phone:b1");
    expect(sheetErrors({ buildings: [{ id: "b1", phone: "((((....))))" }], rooms: [] })).toHaveProperty("phone:b1");
    expect(sheetErrors({ buildings: [{ id: "b1", phone: "(028) 3812 3456" }], rooms: [] })).toEqual({});
    expect(sheetErrors({ buildings: [{ id: "b1", phone: "+84 901.234.567" }, { id: "b2", phone: null }], rooms: [] })).toEqual({});
  });

  it("ô Loại phòng: tách \"Nm²\" ra diện tích, phần còn lại là loại phòng; không có thì giữ diện tích", () => {
    expect(parseTypeCell("Phòng 20m², Ban công")).toEqual({ area: 20, roomType: "Ban công" });
    expect(parseTypeCell("Gác, phòng 25,5 m2 , cửa sổ")).toEqual({ area: 25.5, roomType: "Gác, cửa sổ" });
    expect(parseTypeCell("Gác 6m2")).toEqual({ area: null, roomType: "Gác 6m2" }); // m² đứng riêng là chữ của loại phòng
    expect(parseTypeCell("Studio")).toEqual({ area: null, roomType: "Studio" });
    expect(parseTypeCell("Phòng 30m²")).toEqual({ area: 30, roomType: "" });
    expect(formatPriceInput("4500000đ")).toBe("4.500.000");
    expect(formatPriceInput("abc")).toBe("");
  });

  it("giá/loại/nội thất/tình trạng: chỉ ghi cột đổi thật, phòng khách pass không sửa giá", () => {
    const rooms = [
      building({ rooms: [room({ type: "Ban công", amenities: ["Máy lạnh"] }), room({ id: "rp", code: "P9", status: "pass", price: 3 })] }),
    ];
    const edits = {
      ...EMPTY_SHEET_EDITS,
      prices: { r1: "4.800.000", rp: "9.000.000" },
      types: { r1: "Phòng 20m², Gác" },          // diện tích giữ nguyên 20 → chỉ ghi loại phòng
      amenities: { r1: "Máy lạnh, Tủ lạnh" },
      statuses: { r1: " 1/11 trống " },
    };
    expect(sheetChanges(rooms, edits).rooms).toEqual([
      { id: "r1", rentPrice: 4800000, roomType: "Gác", amenities: ["Máy lạnh", "Tủ lạnh"], saleStatusNote: "1/11 trống", saleStatusKey: "fact-key" },
    ]);
    // Gõ lại đúng chữ đang in thì không ghi gì.
    expect(sheetChanges(rooms, { ...EMPTY_SHEET_EDITS, prices: { r1: "4.000.000" }, types: { r1: "Phòng 20m², Ban công" },
      amenities: { r1: "Máy lạnh" }, statuses: { r1: "" } }).rooms).toEqual([]);
    // Xoá trống giá bị chặn; diện tích đổi thì ghi diện tích.
    const cleared = sheetChanges(rooms, { ...EMPTY_SHEET_EDITS, prices: { r1: "" }, types: { r1: "Phòng 22m², Ban công" } });
    expect(cleared.rooms).toEqual([{ id: "r1", rentPrice: null, area: 22 }]);
    expect(sheetErrors(cleared)).toHaveProperty("price:r1");
  });

  it("ảnh in đúng ô đang gõ: giá mới, loại phòng, nội thất, tình trạng gõ tay viết hoa", () => {
    const preview = applySheetDraft([building({ rooms: [room({ status: "soon", availDate: "01/11" })] })], {
      hotline: HOT, salePolicy: "",
      edits: { ...EMPTY_SHEET_EDITS, prices: { r1: "4.800.000" }, types: { r1: "Gác, Phòng 25m2" }, amenities: { r1: "Tủ lạnh" }, statuses: { r1: "Trống từ 5/11" } },
    });
    const [row] = buildRoomListTable(preview).groups[0].rows;
    expect(row).toMatchObject({ price: "4.800.000", type: "Phòng 25m², Gác", amenities: "Tủ lạnh", status: ["TRỐNG TỪ 5/11"] });
    // Để trống tình trạng → quay về chữ tự tính.
    const auto = applySheetDraft([building({ rooms: [room({ status: "soon", availDate: "01/11", saleStatusNote: "Cũ" })] })], {
      hotline: HOT, salePolicy: "", edits: { ...EMPTY_SHEET_EDITS, statuses: { r1: "" } },
    });
    expect(buildRoomListTable(auto).groups[0].rows[0].status).toEqual(["1/11 TRỐNG"]);
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

  it("sửa giá, loại phòng, nội thất, tình trạng ngay trên bảng rồi Lưu → ghi thẳng vào phòng", async () => {
    view();
    const price = screen.getByRole("textbox", { name: "Giá phòng 502" }) as HTMLInputElement;
    expect(price.value).toBe("4.000.000");
    fireEvent.change(price, { target: { value: "4800000" } });
    expect(price.value).toBe("4.800.000");
    fireEvent.change(screen.getByRole("textbox", { name: "Loại phòng phòng 502" }), { target: { value: "Phòng 25m², Gác" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Nội thất phòng 502" }), { target: { value: "Máy lạnh, tủ lạnh" } });
    const status = screen.getByRole("textbox", { name: "Tình trạng phòng 502" }) as HTMLInputElement;
    expect(status.value).toBe("");
    expect(status.placeholder).toBe("TRỐNG SẴN");
    expect(status.title).toBe("Để trống thì tự tính theo hợp đồng");
    fireEvent.change(status, { target: { value: "Trống từ 5/11" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(m.sheetSave).toHaveBeenCalledOnce());
    expect(m.sheetSave).toHaveBeenCalledWith({ buildings: [], rooms: [
      { id: "r1", rentPrice: 4800000, area: 25, roomType: "Gác", amenities: ["Máy lạnh", "tủ lạnh"], saleStatusNote: "Trống từ 5/11", saleStatusKey: "fact-key" },
    ] });
  });

  it("xoá trống giá → báo tại ô, không ghi; phòng khách pass không có ô giá", async () => {
    m.rooms = query([building({ rooms: [room({}), room({ id: "rp", code: "P9", status: "pass", price: 3 })] })]);
    view();
    expect(screen.queryByRole("textbox", { name: "Giá phòng P9" })).toBeNull();
    expect(screen.getByText("Giá khách pass — sửa ở Khách nhờ sale")).toBeTruthy();
    const price = screen.getByRole("textbox", { name: "Giá phòng 502" });
    fireEvent.change(price, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    await waitFor(() => expect(price.getAttribute("aria-invalid")).toBe("true"));
    expect(m.save).not.toHaveBeenCalled();
    expect(m.sheetSave).not.toHaveBeenCalled();
  });
});
