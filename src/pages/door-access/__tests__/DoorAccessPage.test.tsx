// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DoorDevice } from "@/lib/door-access/dto";

// Hằng của mock phải nằm trong vi.hoisted (vi.mock được kéo lên trên mọi import).
const m = vi.hoisted(() => ({
  ORG: "00000000-0000-4000-8000-000000000001",
  ACTOR: "00000000-0000-4000-8000-000000000002",
  perms: {} as Record<string, unknown>,
  buildings: [] as unknown[],
  edge: {
    status: vi.fn(),
    discover: vi.fn(),
    records: vi.fn(),
    keys: vi.fn(),
    tempPasswords: vi.fn(),
    createTempPassword: vi.fn(),
    deleteTempPassword: vi.fn(),
    remoteUnlock: vi.fn(),
    deleteKey: vi.fn(),
  },
  repo: {
    canManageOrganization: vi.fn(),
    listDevices: vi.fn(),
    listKeyLinks: vi.fn(),
    listBuildingTenants: vi.fn(),
    listActionLogs: vi.fn(),
    saveDevice: vi.fn(),
    disableDevice: vi.fn(),
    linkKey: vi.fn(),
    unlinkKey: vi.fn(),
  },
}));

// Không bao giờ chạm mạng: .env của worktree có thể trỏ production.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/layout/MainLayout", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: m.ACTOR } }) }));
vi.mock("@/contexts/OrganizationContext", () => ({ useOrganization: () => ({ selectedOrganizationId: m.ORG }) }));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: m.perms }) }));
vi.mock("@/hooks/useBuildings", () => ({ useBuildings: () => ({ data: m.buildings, isError: false, refetch: vi.fn() }) }));
// Ô chọn có tìm kiếm (Popover + cmdk) khó bấm trong jsdom: thay bằng <select> thường, giữ nguyên hợp đồng props.
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: (props: {
    value?: string;
    onValueChange: (value: string) => void;
    options: Array<{ value: string; label: ReactNode }>;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <select aria-label={props["aria-label"]} value={props.value ?? ""} disabled={props.disabled} onChange={(event) => props.onValueChange(event.target.value)}>
      <option value="">—</option>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {typeof option.label === "string" ? option.label : option.value}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/lib/door-access/edge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/door-access/edge")>()),
  doorAccessEdge: () => m.edge,
}));
vi.mock("@/lib/door-access/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/door-access/repository")>()),
  doorAccessRepository: m.repo,
}));

import { DoorAccessError } from "@/lib/door-access/errors";

import DoorAccessPage from "../DoorAccessPage";
import DoorAccessView from "../DoorAccessView";

const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";
const CODE = "4827193";

function device(can: Partial<DoorDevice["can"]> = {}): DoorDevice {
  return {
    id: DEVICE_ID,
    building_id: "00000000-0000-4000-8000-0000000000a1",
    building_name: "Tòa A",
    display_name: "Cửa chính Tòa A",
    device_kind: "access_control",
    tuya_device_id: "tuyaDevFake001",
    tuya_category: "mk",
    tuya_product_name: null,
    channel_id: 1,
    password_length: 7,
    is_active: true,
    updated_at: "2026-10-21T07:00:00+00:00",
    can: { view: true, temp_password: true, remote_unlock: true, manage_devices: true, ...can },
  };
}

let client: QueryClient;

function renderPage(lazyEntry = false) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<p>route-fallback</p>}>{lazyEntry ? <DoorAccessPage /> : <DoorAccessView />}</Suspense>
    </QueryClientProvider>,
  );
}

function connected(mode: "read" | "all", devices: DoorDevice[]) {
  m.edge.status.mockResolvedValue({ configured: true, connectedOrg: true, mode });
  m.repo.listDevices.mockResolvedValue(devices);
}

const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });

beforeEach(() => {
  vi.clearAllMocks();
  m.perms = {};
  m.buildings = [];
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom luôn có localStorage */
  }
  m.edge.records.mockResolvedValue({ records: [], total: 0, hasMore: false });
  m.edge.tempPasswords.mockResolvedValue({ passwords: [], hasMore: false });
  m.edge.keys.mockResolvedValue({ users: [], unassigned: [], partial: false });
  m.repo.listKeyLinks.mockResolvedValue([]);
  m.repo.listActionLogs.mockResolvedValue({ logs: [], has_more: false });
  m.repo.canManageOrganization.mockResolvedValue(false);
});
afterEach(() => {
  cleanup();
  // Bỏ hẹn giờ dọn bộ đệm (gcTime) để worker test thoát gọn.
  client.clear();
});

describe("trang Cửa vân tay", () => {
  it("trang lazy (route) nạp màn ở tầng hai", async () => {
    m.edge.status.mockResolvedValue({ configured: false, connectedOrg: false, mode: "read" });
    renderPage(true);
    expect(await screen.findByRole("heading", { name: "Chưa kết nối SmartLife" }, { timeout: 5000 })).toBeTruthy();
  });

  it("chưa kết nối SmartLife ⇒ hướng dẫn chủ công ty, không gọi thêm gì", async () => {
    m.edge.status.mockResolvedValue({ configured: false, connectedOrg: false, mode: "read" });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Chưa kết nối SmartLife" })).toBeTruthy();
    expect(screen.getByText(/platform\.tuya\.com/)).toBeTruthy();
    expect(screen.getByText(/Link Tuya App Account/)).toBeTruthy();
    expect(m.repo.listDevices).not.toHaveBeenCalled();
    expect(m.edge.records).not.toHaveBeenCalled();
  });

  it("Edge báo not_configured (503) cũng là 'chưa kết nối', không phải màn lỗi", async () => {
    m.edge.status.mockRejectedValue(new DoorAccessError("not_connected", "Chưa kết nối SmartLife.", { code: "not_configured" }));
    renderPage();
    expect(await screen.findByRole("heading", { name: "Chưa kết nối SmartLife" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("chế độ chỉ đọc: hiện nhãn 'Chỉ đọc' và khoá nút ghi", async () => {
    connected("read", [device()]);
    renderPage();
    expect(await screen.findByText("Chỉ đọc")).toBeTruthy();
    const unlock = await screen.findByRole("button", { name: "Mở cửa" });
    expect(unlock.hasAttribute("disabled")).toBe(true);
    expect(unlock.closest("[title]")?.getAttribute("title")).toContain("chỉ đọc");

    openTab("Mật khẩu tạm");
    const create = await screen.findByRole("button", { name: "Tạo mật khẩu tạm" });
    expect(create.hasAttribute("disabled")).toBe(true);
    fireEvent.click(create);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ẩn tab theo quyền của máy đang chọn", async () => {
    connected("all", [device({ temp_password: false, remote_unlock: false, manage_devices: false })]);
    renderPage();
    await screen.findByRole("tab", { name: "Lịch sử ra vào" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Lịch sử ra vào", "Đối chiếu vân tay", "Nhật ký thao tác"]);
    expect(screen.queryByRole("button", { name: "Mở cửa" })).toBeNull();
  });

  it("chỉ có quyền Mật khẩu tạm ⇒ chỉ tab đó; quyền Quản lý ở tòa khác ⇒ thêm tab Thiết bị", async () => {
    connected("all", [device({ view: false, remote_unlock: false, manage_devices: false })]);
    m.perms = { door_access: { manage_devices: { org_wide: false, building_ids: ["00000000-0000-4000-8000-0000000000b1"] } } };
    renderPage();
    await screen.findByRole("tab", { name: "Mật khẩu tạm" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Mật khẩu tạm", "Thiết bị"]);
    expect(m.edge.records).not.toHaveBeenCalled();
  });

  it("Mở cửa: hỏi xác nhận, chưa rõ kết quả thì cảnh báo và KHÔNG tự bấm lại", async () => {
    connected("all", [device()]);
    let reject: (error: unknown) => void = () => undefined;
    m.edge.remoteUnlock.mockImplementation(() => new Promise((_resolve, rejectFn) => (reject = rejectFn)));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Mở cửa" }));
    expect(await screen.findByText("Mở cửa Cửa chính Tòa A ngay bây giờ?")).toBeTruthy();
    expect(m.edge.remoteUnlock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Mở cửa ngay" }));
    const pending = await screen.findByRole("button", { name: "Đang mở cửa…" });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect(m.edge.remoteUnlock).toHaveBeenCalledWith(DEVICE_ID);

    reject(new DoorAccessError("unavailable", "Chưa rõ đã mở cửa từ xa chưa.", { outcomeUnknown: true }));
    expect(await screen.findByText("Chưa rõ cửa đã mở chưa — xem Lịch sử ra vào trước khi bấm lại")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Mở cửa" }).hasAttribute("disabled")).toBe(false);
  });

  it("Mở cửa bị từ chối quyền ⇒ báo lỗi rõ, không gọi là 'chưa rõ'", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockRejectedValue(new DoorAccessError("permission", "Bạn chưa có quyền mở cửa từ xa ở máy này."));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Mở cửa" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mở cửa ngay" }));
    expect(await screen.findByText("Bạn chưa có quyền mở cửa từ xa ở máy này.")).toBeTruthy();
    expect(screen.queryByText(/Chưa rõ cửa đã mở chưa/)).toBeNull();
  });

  it("Mật khẩu tạm: mã hiện đúng một lần, đóng hộp là xoá khỏi màn hình và bộ đệm", async () => {
    connected("all", [device()]);
    m.edge.createTempPassword.mockImplementation(async (input: { effectiveSec: number; invalidSec: number }) => ({
      passwordId: 3001,
      password: CODE,
      effectiveSec: input.effectiveSec,
      invalidSec: input.invalidSec,
      logId: "00000000-0000-4000-8000-0000000002a1",
    }));
    renderPage();
    await screen.findByRole("tab", { name: "Mật khẩu tạm" });
    openTab("Mật khẩu tạm");
    fireEvent.click(await screen.findByRole("button", { name: "Tạo mật khẩu tạm" }));
    fireEvent.change(await screen.findByLabelText("Tên"), { target: { value: "Xem phòng P302" } });
    fireEvent.click(screen.getByRole("button", { name: "Tạo mật khẩu" }));

    expect(await screen.findByText(CODE)).toBeTruthy();
    expect(screen.getAllByText(CODE)).toHaveLength(1);
    expect(screen.getByText(/Mã chỉ hiện một lần/)).toBeTruthy();
    expect(m.edge.createTempPassword).toHaveBeenCalledTimes(1);
    const sent = m.edge.createTempPassword.mock.calls[0]?.[0] as { deviceId: string; name: string; purpose: string; effectiveSec: number; invalidSec: number };
    expect(sent).toMatchObject({ deviceId: DEVICE_ID, name: "Xem phòng P302", purpose: "XEM_PHONG" });
    expect(sent.invalidSec - sent.effectiveSec).toBe(7200);

    fireEvent.click(screen.getByRole("button", { name: "Đã ghi lại mã" }));
    await waitFor(() => expect(document.body.textContent).not.toContain(CODE));

    // Không nằm lại ở đâu: localStorage, query cache, mutation cache.
    const stored = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.getItem(window.localStorage.key(i) ?? "") ?? "");
    expect(stored.join("|")).not.toContain(CODE);
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data ?? null))).not.toContain(CODE);
    await waitFor(() =>
      expect(JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state.data ?? null))).not.toContain(CODE),
    );

    // Mở lại hộp tạo: không còn mã cũ.
    fireEvent.click(screen.getByRole("button", { name: "Tạo mật khẩu tạm" }));
    await screen.findByLabelText("Tên");
    expect(document.body.textContent).not.toContain(CODE);
  });

  it("form mật khẩu tạm: tên trống bị chặn tại chỗ, không gọi Edge", async () => {
    connected("all", [device()]);
    renderPage();
    await screen.findByRole("tab", { name: "Mật khẩu tạm" });
    openTab("Mật khẩu tạm");
    fireEvent.click(await screen.findByRole("button", { name: "Tạo mật khẩu tạm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Tạo mật khẩu" }));
    expect(await screen.findByText("Nhập tên mật khẩu.")).toBeTruthy();
    expect(m.edge.createTempPassword).not.toHaveBeenCalled();
  });
});

const BUILDING_A = "00000000-0000-4000-8000-0000000000a1";
const BUILDING_B = "00000000-0000-4000-8000-0000000000b1";
const CUSTOMER = "00000000-0000-4000-8000-0000000000c1";
const twoBuildings = () => [
  { id: BUILDING_A, name: "Tòa A", code: null, street_address: "12/3 Đường Số 1", organization_id: m.ORG },
  { id: BUILDING_B, name: "Tòa B", code: null, street_address: "45 Đường Số 2", organization_id: m.ORG },
];
const LOG_PENDING = "Nhật ký thao tác chưa chốt được — kiểm lại ở tab Nhật ký";

describe("rà soát chéo 22/10", () => {
  // Dạng THẬT của get_my_permissions_v2 cho khoá có chiều BUILDING: org_wide luôn false, kể cả chủ công ty.
  const realPerms = (manageBuildings: string[]) => ({
    door_access: {
      view: { org_wide: false, building_ids: [BUILDING_A, BUILDING_B] },
      manage_devices: { org_wide: false, building_ids: manageBuildings },
    },
  });

  it("Thiết bị: máy chủ nói KHÔNG quản lý mọi tòa ⇒ không tìm máy mới (chỉ ghi chú); ô chọn tòa chỉ còn tòa được quản lý", async () => {
    connected("all", [device()]);
    m.perms = realPerms([BUILDING_A]);
    m.repo.canManageOrganization.mockResolvedValue(false);
    m.buildings = twoBuildings();
    renderPage();
    await screen.findByRole("tab", { name: "Thiết bị" });
    openTab("Thiết bị");
    expect(await screen.findByText("Chỉ người có quyền Quản lý máy ở mọi tòa mới gắn được máy mới.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tìm máy trên SmartLife" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Sửa" }));
    const picker = await screen.findByLabelText("Chọn tòa");
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["—", "Tòa A"]);
    expect(m.edge.discover).not.toHaveBeenCalled();
  });

  it("Thiết bị: chủ công ty (quyền mọi tòa, org_wide=false như máy chủ thật) mà máy chủ chưa xác nhận ⇒ vẫn ẩn tìm máy", async () => {
    connected("all", [device()]);
    m.perms = realPerms([BUILDING_A, BUILDING_B]);
    m.repo.canManageOrganization.mockResolvedValue(false);
    m.buildings = twoBuildings();
    renderPage();
    await screen.findByRole("tab", { name: "Thiết bị" });
    openTab("Thiết bị");
    expect(await screen.findByText("Chỉ người có quyền Quản lý máy ở mọi tòa mới gắn được máy mới.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tìm máy trên SmartLife" })).toBeNull();
    expect(m.repo.canManageOrganization).toHaveBeenCalledWith(m.ORG);
  });

  it("Thiết bị: máy chủ xác nhận Quản lý ở mọi tòa ⇒ tìm máy; máy không rõ loại ẩn mặc định, gắn thì PHẢI chọn loại", async () => {
    connected("all", [device()]);
    m.perms = realPerms([BUILDING_A, BUILDING_B]);
    m.repo.canManageOrganization.mockResolvedValue(true);
    m.buildings = twoBuildings();
    m.edge.discover.mockResolvedValue({
      devices: [
        { tuyaDeviceId: "tuyaLock405", name: "405XYZ", category: "mk", productName: null, online: true, kind: "access_control", registered: null },
        { tuyaDeviceId: "tuyaOther01", name: "Thiết bị lạ", category: "xyz", productName: null, online: null, kind: null, registered: null },
        {
          tuyaDeviceId: "tuyaDevFake001",
          name: "Cửa chính đã gắn",
          category: "mk",
          productName: null,
          online: true,
          kind: "access_control",
          registered: { deviceId: DEVICE_ID, buildingId: BUILDING_A },
        },
      ],
      hasMore: false,
    });
    renderPage();
    await screen.findByRole("tab", { name: "Thiết bị" });
    openTab("Thiết bị");
    fireEvent.click(await screen.findByRole("button", { name: "Tìm máy trên SmartLife" }));
    expect(await screen.findByText("405XYZ")).toBeTruthy();
    expect(screen.queryByText("Thiết bị lạ")).toBeNull();
    expect(screen.queryByText("Cửa chính đã gắn")).toBeNull();

    fireEvent.click(screen.getByRole("switch"));
    const other = (await screen.findByText("Thiết bị lạ")).closest("li");
    expect(other).toBeTruthy();
    fireEvent.click(within(other as HTMLElement).getByRole("button", { name: "Gắn tòa" }));
    fireEvent.change(await screen.findByLabelText("Chọn tòa"), { target: { value: BUILDING_A } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu máy" }));
    expect(await screen.findByText("Chọn loại máy: kiểm soát ra vào hoặc khoá Wi-Fi.")).toBeTruthy();
    expect(m.repo.saveDevice).not.toHaveBeenCalled();
  });

  it("Mở cửa thành công nhưng nhật ký chưa chốt ⇒ thêm dòng nhắc trung tính", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockResolvedValue({ unlocked: true, logId: "log-1", logPending: true });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Mở cửa" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mở cửa ngay" }));
    expect(await screen.findByText("Đã gửi lệnh mở cửa Cửa chính Tòa A.")).toBeTruthy();
    expect(screen.getByText(LOG_PENDING)).toBeTruthy();
  });

  it("Mở cửa lỗi kèm logPending ⇒ báo lỗi + dòng nhắc; không có cờ thì không nhắc", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockRejectedValueOnce(new DoorAccessError("tuya_rejected", "SmartLife từ chối (mã 2001).", { logPending: true }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Mở cửa" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mở cửa ngay" }));
    expect(await screen.findByText("SmartLife từ chối (mã 2001).")).toBeTruthy();
    expect(screen.getByText(LOG_PENDING)).toBeTruthy();

    m.edge.remoteUnlock.mockResolvedValueOnce({ unlocked: true, logId: "log-2" });
    fireEvent.click(screen.getByRole("button", { name: "Mở cửa" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mở cửa ngay" }));
    expect(await screen.findByText("Đã gửi lệnh mở cửa Cửa chính Tòa A.")).toBeTruthy();
    expect(screen.queryByText(LOG_PENDING)).toBeNull();
  });

  it("Gắn khách bị máy chủ từ chối 42501 ⇒ câu lý do hiện ngay trong hộp, hộp vẫn mở", async () => {
    connected("all", [device()]);
    m.edge.keys.mockResolvedValue({
      users: [
        {
          userId: "tuyaUserFake01",
          name: "Người dùng 01",
          role: "member",
          userType: 20,
          methods: [{ method: "fingerprint", methodCode: "unlock_fingerprint", sn: 12, name: null }],
        },
      ],
      unassigned: [],
      partial: false,
    });
    m.repo.listBuildingTenants.mockResolvedValue([
      { customer_id: CUSTOMER, full_name: "Nguyễn Văn Thử", room_id: null, room_name: "P302", contract_id: null, is_representative: true },
    ]);
    m.repo.linkKey.mockRejectedValue(new DoorAccessError("permission", "Khách chưa từng có hợp đồng ở tòa của máy này", { code: "42501" }));
    renderPage();
    await screen.findByRole("tab", { name: "Đối chiếu vân tay" });
    openTab("Đối chiếu vân tay");
    fireEvent.click(await screen.findByRole("button", { name: "Gắn" }));
    const picker = await screen.findByLabelText("Chọn khách");
    await waitFor(() => expect(within(picker).getAllByRole("option")).toHaveLength(2));
    fireEvent.change(picker, { target: { value: CUSTOMER } });
    fireEvent.click(screen.getByRole("button", { name: "Gắn" }));
    expect(await screen.findByText("Khách chưa từng có hợp đồng ở tòa của máy này")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(m.repo.linkKey).toHaveBeenCalledWith(m.ORG, expect.objectContaining({ customerId: CUSTOMER, unlockType: "fingerprint", unlockSn: 12 }));
  });
});
