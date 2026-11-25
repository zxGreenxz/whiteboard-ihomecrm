// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraAlertSettingsPage, type CameraAlertPageController } from "@/components/network-center/camera-alerts/CameraAlertSettingsPage";
import type {
  CameraAlertDelivery, CameraAlertRepository, CameraAlertSettingsView,
} from "@/lib/network-center/cameraContracts";
import { DEMO_CAMERA_ALERT_TYPES } from "@/lib/network-center/cameraDemo";
import { NetworkCenterRepositoryError } from "@/lib/network-center/supabaseRepository";

// Không bao giờ gọi Supabase thật (worktree có .env trỏ production).
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(async () => ({ data: null, error: { code: "TEST", message: "blocked" } })) } }));

const org = "a0000000-0000-4000-8000-000000000001";
const building = "b0000000-0000-4000-8000-000000000001";
const account = "c0000000-0000-4000-8000-0000000000a1";
const otherAccount = "c0000000-0000-4000-8000-0000000000a2";
const group = "c0000000-0000-4000-8000-0000000000b1";
const newGroup = "c0000000-0000-4000-8000-0000000000b2";

function settingsView(overrides: Partial<CameraAlertSettingsView> = {}, settings: Partial<CameraAlertSettingsView["settings"]> = {}): CameraAlertSettingsView {
  return {
    organizationId: org, exists: true, canEdit: true,
    settings: {
      enabled: true, mode: "SHADOW", zaloAccountId: account, zaloConversationId: group,
      types: structuredClone(DEMO_CAMERA_ALERT_TYPES), nightStart: "22:00", nightEnd: "07:00", digestAt: "08:00",
      dailyZaloCap: 6, pushEnabled: false, liveSince: null, updatedBy: null, updatedAt: "2026-11-24T03:00:00Z", version: 3,
      ...settings,
    },
    zalo: {
      account: { id: account, name: "Nick Văn phòng", kind: "personal", status: "connected" },
      conversation: { id: group, name: "Nhóm kỹ thuật", threadType: "group", accountId: account },
      warning: null,
    },
    today: { date: "2026-11-25", zaloSent: 2, shadowWouldSend: 5, cap: 6 },
    defaults: structuredClone(DEMO_CAMERA_ALERT_TYPES),
    ...overrides,
  };
}

function delivery(overrides: Partial<CameraAlertDelivery> = {}): CameraAlertDelivery {
  return {
    id: "d1000000-0000-4000-8000-000000000001", createdAt: "2026-11-25T01:00:00Z", kind: "OPENED", channel: "ZALO",
    status: "SHADOW", storedStatus: "SHADOW", shadow: true, reason: "WOULD_QUEUE",
    body: "⚠ TOÀ A: Kênh 3 \"Hầm 2\" mất hình 15 phút (từ 07:50).\nXem: CRM › Trung tâm mạng › Camera",
    buildingIds: [building], recipients: null, pendingRelease: false, releasedAt: null, sentAt: null,
    zaloJobId: null, jobStatus: null, jobError: null, ...overrides,
  };
}

type Mocked = { [K in keyof CameraAlertRepository]: ReturnType<typeof vi.fn<CameraAlertRepository[K]>> };
function repositoryMock(view = settingsView()): Mocked {
  return {
    getSettings: vi.fn<CameraAlertRepository["getSettings"]>(async () => structuredClone(view)),
    saveSettings: vi.fn<CameraAlertRepository["saveSettings"]>(async (_org, version, patch) => {
      const next = settingsView({}, { ...view.settings, version: version + 1 });
      if (patch.dailyZaloCap !== undefined) next.settings.dailyZaloCap = patch.dailyZaloCap;
      if (patch.mode) next.settings.mode = patch.mode;
      return next;
    }),
    listZaloGroups: vi.fn<CameraAlertRepository["listZaloGroups"]>(async (_org, search) => ({
      items: [
        { id: group, name: "Nhóm kỹ thuật", accountId: account, accountName: "Nick Văn phòng", lastMessageAt: "2026-11-24T10:00:00Z" },
        { id: newGroup, name: "Web nội bộ", accountId: account, accountName: "Nick Văn phòng", lastMessageAt: null },
        { id: "c0000000-0000-4000-8000-0000000000b3", name: "Nhóm khác nick", accountId: otherAccount, accountName: "Nick Kho", lastMessageAt: null },
      ].filter((item) => !search || item.name.toLowerCase().includes(search.toLowerCase())),
    })),
    setChannelMute: vi.fn<CameraAlertRepository["setChannelMute"]>(),
    clearChannelMute: vi.fn<CameraAlertRepository["clearChannelMute"]>(),
    listBuildingMutes: vi.fn<CameraAlertRepository["listBuildingMutes"]>(),
    listDeliveries: vi.fn<CameraAlertRepository["listDeliveries"]>(async () => ({ items: [delivery()], hasMore: false })),
    sendTest: vi.fn<CameraAlertRepository["sendTest"]>(async () => ({ deliveryId: "d1000000-0000-4000-8000-000000000009", status: "QUEUED", reason: null })),
    listIncidents: vi.fn<CameraAlertRepository["listIncidents"]>(),
    acknowledgeIncident: vi.fn<CameraAlertRepository["acknowledgeIncident"]>(),
  };
}

const controller: CameraAlertPageController = {
  actor: { id: "user-a", label: "Người kiểm thử" } as CameraAlertPageController["actor"],
  canView: true, mode: "production", isDemo: false,
  physicalBuildings: [{ id: building, name: "Toà A", organizationId: org }],
};

let client: QueryClient;
function Wrapper({ children }: PropsWithChildren) {
  return <MemoryRouter><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>;
}
function renderPage(repository: Mocked | undefined, overrides: Partial<CameraAlertPageController> = {}) {
  return render(
    <CameraAlertSettingsPage controller={{ ...controller, ...overrides }} organizationId={org} organizationName="Công ty DEMO" repository={repository as CameraAlertRepository | undefined} />,
    { wrapper: Wrapper },
  );
}
const typeRow = (label: string) => screen.getByRole("group", { name: label });
const openSelect = (combobox: HTMLElement) => fireEvent.keyDown(combobox, { key: "ArrowDown" });
const pickOption = (name: string) => fireEvent.keyDown(screen.getByRole("option", { name }), { key: "Enter" });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

describe("Cài đặt cảnh báo camera — quyền", () => {
  it("người chỉ xem thấy cài đặt nhưng mọi ô bị khoá, không có nút lưu và không đọc danh sách nhóm Zalo", async () => {
    const repository = repositoryMock(settingsView({ canEdit: false }));
    renderPage(repository);
    expect(await screen.findByText(/Chỉ chủ công ty hoặc superadmin sửa được/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Bật cảnh báo camera cho cả công ty" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("radio", { name: /Gửi thật/ }).hasAttribute("disabled")).toBe(true);
    expect(within(typeRow("Kênh camera mất hình")).getByLabelText("Ngưỡng (phút): Kênh camera mất hình").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Tối đa tin Zalo mỗi ngày").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Đổi nhóm/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Gửi tin thử/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /Lưu cài đặt/ })).toBeNull();
    expect(repository.listZaloGroups).not.toHaveBeenCalled();
    // Nhật ký vẫn đọc được.
    expect(await screen.findByText("Chạy thử")).toBeTruthy();
  });

  it("máy chủ từ chối quyền xem ⇒ câu giải thích, không dựng form", async () => {
    const repository = repositoryMock();
    repository.getSettings.mockRejectedValue(new NetworkCenterRepositoryError("x", { code: "42501" }));
    renderPage(repository);
    expect(await screen.findByText(/Bạn chưa có quyền xem cài đặt cảnh báo camera/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Cài đặt cảnh báo camera" })).toBeNull();
  });

  it("phiên hết hạn nói đúng là phiên hết hạn, không nói là thiếu quyền", async () => {
    const repository = repositoryMock();
    repository.getSettings.mockRejectedValue(new NetworkCenterRepositoryError("x", { code: "PGRST301" }));
    renderPage(repository);
    expect(await screen.findByText("Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục.")).toBeTruthy();
    expect(screen.queryByText(/chưa có quyền/)).toBeNull();
  });

  it("bộ cảnh báo chưa triển khai ⇒ câu tiếng Việt và nút thử lại", async () => {
    const repository = repositoryMock();
    repository.getSettings.mockRejectedValueOnce(new NetworkCenterRepositoryError("Bộ cảnh báo camera chưa được triển khai trên hệ thống này.", { code: "PGRST202" }));
    renderPage(repository);
    expect(await screen.findByText("Bộ cảnh báo camera chưa được triển khai trên hệ thống này.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByRole("form", { name: "Cài đặt cảnh báo camera" })).toBeTruthy();
  });
});

describe("Cài đặt cảnh báo camera — lưu", () => {
  it("đổi ngưỡng theo phút và trần tin ⇒ gửi đúng khoá đổi, ngưỡng đổi sang giây", async () => {
    const repository = repositoryMock();
    renderPage(repository);
    const minutes = await screen.findByLabelText("Ngưỡng (phút): Kênh camera mất hình");
    expect((minutes as HTMLInputElement).value).toBe("15");
    fireEvent.change(minutes, { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Tối đa tin Zalo mỗi ngày"), { target: { value: "4" } });
    openSelect(within(typeRow("Đầu ghi trả lời lạ")).getByRole("combobox", { name: "Cách báo: Đầu ghi trả lời lạ" }));
    pickOption("Chỉ bản tin sáng");
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    await waitFor(() => expect(repository.saveSettings).toHaveBeenCalledTimes(1));
    expect(repository.saveSettings).toHaveBeenCalledWith(org, 3, {
      dailyZaloCap: 4,
      types: { CAMERA_CHANNEL_LOST: { threshold_seconds: 1200 }, CAMERA_RECORDER_UNKNOWN: { delivery: "DIGEST" } },
    });
    expect(await screen.findByText(/Đã lưu cài đặt lúc/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Tối đa tin Zalo mỗi ngày") as HTMLInputElement).value).toBe("4"));
  });

  it("chặn giá trị ngoài cận ngay trên form, không gọi máy chủ", async () => {
    const repository = repositoryMock();
    renderPage(repository);
    fireEvent.change(await screen.findByLabelText("Ngưỡng (phút): Không gọi tới được đầu ghi"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Số lần rớt: Kênh chập chờn"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Ngưỡng (phút): Ổ cứng đầu ghi báo lỗi"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Tối đa tin Zalo mỗi ngày"), { target: { value: "21" } });
    fireEvent.change(screen.getByLabelText("Giờ đêm kết thúc (gửi tin dồn)"), { target: { value: "22:00" } });
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    expect(await screen.findByText("Từ 1 đến 1440 phút (24 giờ).")).toBeTruthy();
    expect(screen.getByText("Từ 2 đến 200 lần.")).toBeTruthy();
    expect(screen.getByText("Tối đa 20 tin mỗi ngày.")).toBeTruthy();
    expect(screen.getByText("Giờ kết thúc đêm phải khác giờ bắt đầu.")).toBeTruthy();
    // Ổ lỗi nhận 0 = báo ngay: không có lỗi ở dòng đó.
    expect(within(typeRow("Ổ cứng đầu ghi báo lỗi")).queryByText(/phút\./)).toBeNull();
    expect(repository.saveSettings).not.toHaveBeenCalled();
  });

  it("xung đột phiên bản ⇒ “Có người vừa sửa”, bấm Tải lại thì lấy bản mới", async () => {
    const repository = repositoryMock();
    repository.saveSettings.mockRejectedValueOnce(new NetworkCenterRepositoryError("Cài đặt cảnh báo camera vừa được người khác thay đổi. Tải lại rồi lưu lại.", { code: "PT409" }));
    renderPage(repository);
    fireEvent.change(await screen.findByLabelText("Tối đa tin Zalo mỗi ngày"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    expect(await screen.findByText(/Có người vừa sửa cài đặt này/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("PT409");
    repository.getSettings.mockResolvedValue(settingsView({}, { version: 4, dailyZaloCap: 9 }));
    fireEvent.click(screen.getByRole("button", { name: "Tải lại" }));
    await waitFor(() => expect((screen.getByLabelText("Tối đa tin Zalo mỗi ngày") as HTMLInputElement).value).toBe("9"));
    expect(screen.queryByText(/Có người vừa sửa cài đặt này/)).toBeNull();
  });

  it("lần nạp lại chạy nền lỗi thì GIỮ form và phần đang sửa, báo tại chỗ", async () => {
    const repository = repositoryMock();
    renderPage(repository);
    fireEvent.change(await screen.findByLabelText("Tối đa tin Zalo mỗi ngày"), { target: { value: "5" } });
    repository.getSettings.mockRejectedValue(new NetworkCenterRepositoryError("x", { code: "57014" }));
    await client.invalidateQueries({ queryKey: ["network-center"] });
    expect(await screen.findByText(/Chưa tải lại được cài đặt mới nhất/)).toBeTruthy();
    expect((screen.getByLabelText("Tối đa tin Zalo mỗi ngày") as HTMLInputElement).value).toBe("5");
    expect(screen.getByRole("form", { name: "Cài đặt cảnh báo camera" })).toBeTruthy();
  });

  it("lần nạp nền bị từ chối quyền ⇒ bỏ form cũ, nói đúng là không có quyền xem", async () => {
    const repository = repositoryMock();
    renderPage(repository);
    fireEvent.change(await screen.findByLabelText("Tối đa tin Zalo mỗi ngày"), { target: { value: "5" } });
    repository.getSettings.mockRejectedValue(new NetworkCenterRepositoryError("x", { code: "42501" }));
    await client.invalidateQueries({ queryKey: ["network-center"] });
    expect(await screen.findByText(/Bạn chưa có quyền xem cài đặt cảnh báo camera/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Cài đặt cảnh báo camera" })).toBeNull();
    expect(screen.queryByText("Chỉ chủ công ty hoặc superadmin sửa được.")).toBeNull();
  });

  it("có bản mới trên máy chủ khi đang sửa ⇒ giữ phần đang sửa và mời Tải lại; form sạch thì tự nhận bản mới", async () => {
    const repository = repositoryMock();
    renderPage(repository);
    fireEvent.change(await screen.findByLabelText("Tối đa tin Zalo mỗi ngày"), { target: { value: "5" } });
    repository.getSettings.mockResolvedValue(settingsView({}, { version: 4, dailyZaloCap: 9 }));
    await client.invalidateQueries({ queryKey: ["network-center"] });
    expect(await screen.findByText(/Có người vừa sửa cài đặt này/)).toBeTruthy();
    expect((screen.getByLabelText("Tối đa tin Zalo mỗi ngày") as HTMLInputElement).value).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Tải lại" }));
    await waitFor(() => expect((screen.getByLabelText("Tối đa tin Zalo mỗi ngày") as HTMLInputElement).value).toBe("9"));
    expect(screen.queryByText(/Có người vừa sửa cài đặt này/)).toBeNull();
    // Form sạch: bản mới vào thẳng, không cần bấm gì.
    repository.getSettings.mockResolvedValue(settingsView({}, { version: 5, dailyZaloCap: 11 }));
    await client.invalidateQueries({ queryKey: ["network-center"] });
    await waitFor(() => expect((screen.getByLabelText("Tối đa tin Zalo mỗi ngày") as HTMLInputElement).value).toBe("11"));
    expect(screen.queryByText(/Có người vừa sửa cài đặt này/)).toBeNull();
  });

  it("lỗi dữ liệu kỹ thuật từ máy chủ không lộ tên trường", async () => {
    const repository = repositoryMock();
    repository.saveSettings.mockRejectedValueOnce(new NetworkCenterRepositoryError("Giá trị cài đặt không hợp lệ: types.CAMERA_CHANNEL_LOST.threshold_seconds", { code: "22023" }));
    repository.saveSettings.mockRejectedValueOnce(new NetworkCenterRepositoryError("Nhóm Zalo không thuộc nick đã chọn của công ty", { code: "22023" }));
    renderPage(repository);
    fireEvent.change(await screen.findByLabelText("Tối đa tin Zalo mỗi ngày"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    expect(await screen.findByText("Giá trị chưa hợp lệ. Kiểm tra lại các ô đã nhập.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/CAMERA_|threshold_seconds/);
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    expect(await screen.findByText("Nhóm Zalo không thuộc nick đã chọn của công ty")).toBeTruthy();
  });

  it("chuyển sang Gửi thật phải xác nhận, hộp xác nhận nói rõ sẽ gửi tin hiện trạng vào nhóm", async () => {
    const repository = repositoryMock();
    renderPage(repository);
    fireEvent.click(await screen.findByRole("radio", { name: /Gửi thật/ }));
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    const confirm = await screen.findByRole("alertdialog", { name: "Bật gửi thật?" });
    expect(confirm.textContent).toContain("MỘT tin “Hiện trạng camera lúc bật cảnh báo”");
    expect(confirm.textContent).toContain("“Nhóm kỹ thuật”");
    fireEvent.click(within(confirm).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(repository.saveSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Bật gửi thật và lưu" }));
    await waitFor(() => expect(repository.saveSettings).toHaveBeenCalledWith(org, 3, { mode: "LIVE" }));
  });

  it("nick mất kết nối ⇒ hộp xác nhận nói rõ và không cho bật gửi thật", async () => {
    const repository = repositoryMock(settingsView({ zalo: { ...settingsView().zalo, warning: "ACCOUNT_DISCONNECTED" } }));
    renderPage(repository);
    fireEvent.click(await screen.findByRole("radio", { name: /Gửi thật/ }));
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    const confirm = await screen.findByRole("alertdialog", { name: "Bật gửi thật?" });
    expect(confirm.textContent).toContain("chưa bật gửi thật được");
    expect(within(confirm).getByRole("button", { name: "Bật gửi thật và lưu" }).hasAttribute("disabled")).toBe(true);
    expect(repository.saveSettings).not.toHaveBeenCalled();
  });

  it("Gửi thật khi chưa chọn nhóm ⇒ báo ngay trên form, không mở hộp xác nhận", async () => {
    const view = settingsView({ zalo: { account: null, conversation: null, warning: "NOT_CONFIGURED" } }, { zaloAccountId: null, zaloConversationId: null });
    const repository = repositoryMock(view);
    renderPage(repository);
    expect(await screen.findByText(/Chưa chọn nhóm Zalo nhận cảnh báo/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Gửi thật/ }));
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    expect(await screen.findByText("Chọn nhóm Zalo trước khi chuyển sang gửi thật.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(repository.saveSettings).not.toHaveBeenCalled();
  });
});

describe("Cài đặt cảnh báo camera — nơi nhận Zalo", () => {
  it("chọn nick rồi chọn nhóm theo tên; tin thử khoá tới khi lưu", async () => {
    const repository = repositoryMock();
    renderPage(repository);
    fireEvent.click(await screen.findByRole("button", { name: /Đổi nhóm/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn nhóm Zalo nhận cảnh báo" });
    await within(dialog).findByRole("radio", { name: /Nhóm kỹ thuật/ });
    // Chỉ nhóm của nick đang chọn.
    expect(within(dialog).queryByRole("radio", { name: /Nhóm khác nick/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Tìm nhóm theo tên"), { target: { value: "web" } });
    await waitFor(() => expect(repository.listZaloGroups).toHaveBeenCalledWith(org, "web", 200));
    await waitFor(() => expect(within(dialog).queryByRole("radio", { name: /Nhóm kỹ thuật/ })).toBeNull());
    fireEvent.click(within(dialog).getByRole("radio", { name: /Web nội bộ/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Dùng nhóm này" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Web nội bộ")).toBeTruthy();
    expect(screen.getByText(/Đã chọn nhóm mới/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Gửi tin thử/ }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    await waitFor(() => expect(repository.saveSettings).toHaveBeenCalledWith(org, 3, { zaloConversationId: newGroup }));
  });

  it("đổi sang nick khác thì gửi cả nick lẫn nhóm", async () => {
    const repository = repositoryMock();
    renderPage(repository);
    fireEvent.click(await screen.findByRole("button", { name: /Đổi nhóm/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chọn nhóm Zalo nhận cảnh báo" });
    openSelect(await within(dialog).findByRole("combobox", { name: "Nick Zalo gửi tin" }));
    pickOption("Nick Kho");
    fireEvent.click(await within(dialog).findByRole("radio", { name: /Nhóm khác nick/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Dùng nhóm này" }));
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    await waitFor(() => expect(repository.saveSettings).toHaveBeenCalledWith(org, 3, {
      zaloAccountId: otherAccount, zaloConversationId: "c0000000-0000-4000-8000-0000000000b3",
    }));
  });

  it.each([
    ["ACCOUNT_DISCONNECTED", /Nick Zalo “Nick Văn phòng” đang mất kết nối/],
    ["GROUP_MISSING", /Nhóm Zalo đã chọn không còn/],
  ] as const)("cảnh báo nơi nhận %s", async (warning, text) => {
    renderPage(repositoryMock(settingsView({ zalo: { ...settingsView().zalo, warning } })));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("gửi tin thử và báo kết quả bằng lời; bấm lại trong 1 phút thì nói không gửi thêm", async () => {
    const repository = repositoryMock();
    renderPage(repository);
    fireEvent.click(await screen.findByRole("button", { name: /Gửi tin thử/ }));
    expect(await screen.findByText(/Đã xếp hàng tin thử/)).toBeTruthy();
    expect(repository.sendTest).toHaveBeenCalledWith(org);
    repository.sendTest.mockResolvedValueOnce({ deliveryId: "d1000000-0000-4000-8000-000000000009", status: "QUEUED", reused: true });
    fireEvent.click(screen.getByRole("button", { name: /Gửi tin thử/ }));
    expect(await screen.findByText(/không gửi thêm/)).toBeTruthy();
    repository.sendTest.mockRejectedValueOnce(new NetworkCenterRepositoryError("x", { code: "42501" }));
    fireEvent.click(screen.getByRole("button", { name: /Gửi tin thử/ }));
    expect(await screen.findByText("Chỉ chủ công ty hoặc superadmin sửa được.")).toBeTruthy();
  });

  it("hiện số tin đã gửi hôm nay so với trần và số tin chạy thử", async () => {
    renderPage(repositoryMock());
    const today = await screen.findByText(/Hôm nay đã gửi/);
    expect(today.textContent).toContain("2/6");
    expect(today.textContent).toContain("lẽ ra gửi 5 tin");
  });
});

describe("Cài đặt cảnh báo camera — nhật ký gửi", () => {
  it("nhãn tiếng Việt cho trạng thái, xem nguyên văn, lọc và trang cũ hơn theo con trỏ", async () => {
    const repository = repositoryMock();
    repository.listDeliveries.mockImplementation(async (_org, query = {}) => {
      if (query.status === "FAILED") return { items: [delivery({ id: "d1000000-0000-4000-8000-000000000005", status: "FAILED", storedStatus: "QUEUED", shadow: false, reason: null, jobStatus: "failed", jobError: "SEND_TIMEOUT" })], hasMore: false };
      if (query.before) return { items: [delivery({ id: "d1000000-0000-4000-8000-000000000004", status: "DEFERRED", shadow: false, reason: "NIGHT", kind: "OPENED" })], hasMore: false };
      return {
        items: [
          delivery(),
          delivery({ id: "d1000000-0000-4000-8000-000000000002", status: "SUPPRESSED", shadow: false, reason: "REPEAT_24H" }),
          delivery({ id: "d1000000-0000-4000-8000-000000000003", kind: "DIGEST", channel: "IN_APP", status: "SENT", shadow: false, reason: null, recipients: 3, buildingIds: [] }),
        ],
        hasMore: true,
      };
    });
    renderPage(repository);
    const log = await screen.findByRole("list", { name: "Các tin đã ghi sổ" });
    await waitFor(() => expect(within(log).getAllByRole("listitem")).toHaveLength(3));
    expect(log.textContent).toContain("Chạy thử");
    expect(log.textContent).toContain("Lẽ ra gửi vào nhóm Zalo.");
    expect(log.textContent).toContain("Bỏ qua vì trùng 24 giờ");
    expect(log.textContent).toContain("Đã gửi");
    expect(log.textContent).toContain("Bản tin sáng · Chuông CRM");
    expect(log.textContent).toContain("Đã báo chuông cho 3 người.");
    expect(log.textContent).toContain("Toà: Toà A");
    expect(document.body.textContent).not.toMatch(/WOULD_QUEUE|REPEAT_24H|SHADOW|CAMERA_/);

    fireEvent.click(screen.getByRole("button", { name: "Xem tin cũ hơn" }));
    await waitFor(() => expect(within(log).getAllByRole("listitem")).toHaveLength(4));
    expect(repository.listDeliveries).toHaveBeenLastCalledWith(org, { status: undefined, limit: 50, before: { createdAt: "2026-11-25T01:00:00Z", id: "d1000000-0000-4000-8000-000000000003" } });
    expect(log.textContent).toContain("Dồn bản tin");

    fireEvent.click(within(log).getAllByRole("button", { name: /Xem nguyên văn/ })[0]!);
    const message = await screen.findByRole("dialog");
    expect(within(message).getByLabelText("Nguyên văn tin").textContent).toBe("⚠ TOÀ A: Kênh 3 \"Hầm 2\" mất hình 15 phút (từ 07:50).\nXem: CRM › Trung tâm mạng › Camera");
    expect(message.textContent).toContain("25/11 08:00");
    fireEvent.click(within(message).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    openSelect(screen.getByRole("combobox", { name: "Lọc nhật ký theo trạng thái" }));
    pickOption("Lỗi gửi");
    await waitFor(() => expect(repository.listDeliveries).toHaveBeenLastCalledWith(org, { status: "FAILED", limit: 50, before: undefined }));
    const failed = await within(await screen.findByRole("list", { name: "Các tin đã ghi sổ" })).findByText("Lỗi gửi");
    expect(failed.className).toContain("nc-status-bad");
    expect(screen.getByText("Máy gửi Zalo báo lỗi.")).toBeTruthy();
    // Mã lỗi của máy gửi không lên màn hình, kể cả trong hộp nguyên văn.
    fireEvent.click(within(screen.getByRole("list", { name: "Các tin đã ghi sổ" })).getByRole("button", { name: /Xem nguyên văn/ }));
    const failedDialog = await screen.findByRole("dialog");
    expect(failedDialog.textContent).toContain("Máy gửi Zalo báo lỗi.");
    expect(document.body.textContent).not.toContain("SEND_TIMEOUT");
  });

  it("nhật ký rỗng và lỗi đọc nói rõ, không trả rỗng che lỗi", async () => {
    const repository = repositoryMock();
    repository.listDeliveries.mockRejectedValueOnce(new NetworkCenterRepositoryError("x", { code: "57014" }));
    renderPage(repository);
    expect(await screen.findByText("Chưa tải nhật ký gửi được. Kiểm tra mạng rồi thử lại.")).toBeTruthy();
    expect(screen.queryByText("Chưa có tin nào trong 7 ngày qua.")).toBeNull();
    repository.listDeliveries.mockResolvedValue({ items: [], hasMore: false });
    fireEvent.click(within(screen.getByRole("region", { name: "Nhật ký gửi" })).getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByText("Chưa có tin nào trong 7 ngày qua.")).toBeTruthy();
  });
});

describe("Cài đặt cảnh báo camera — DEMO", () => {
  it("chạy trên kho mô phỏng trong bộ nhớ: lưu được và nói rõ không gửi thật", async () => {
    renderPage(undefined, { mode: "demo", isDemo: true });
    expect(await screen.findByText(/Dữ liệu mô phỏng: lưu và gửi tin thử chỉ chạy trong bộ nhớ trình duyệt/)).toBeTruthy();
    expect(screen.getByText("Nhóm kỹ thuật DEMO")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Tối đa tin Zalo mỗi ngày"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /Lưu cài đặt/ }));
    expect(await screen.findByText(/Đã lưu cài đặt lúc/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Gửi tin thử/ }));
    expect(await screen.findByText("Dữ liệu mô phỏng: không gửi tin thật.")).toBeTruthy();
  });
});
