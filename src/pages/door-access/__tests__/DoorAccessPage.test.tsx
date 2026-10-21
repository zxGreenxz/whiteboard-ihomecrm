// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DoorDevice } from "@/lib/door-access/dto";

// Hằng của mock phải nằm trong vi.hoisted (vi.mock được kéo lên trên mọi import).
const m = vi.hoisted(() => ({
  ORG: "00000000-0000-4000-8000-000000000001",
  ACTOR: "00000000-0000-4000-8000-000000000002",
  perms: {} as Record<string, unknown>,
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
vi.mock("@/hooks/useBuildings", () => ({ useBuildings: () => ({ data: [], isError: false, refetch: vi.fn() }) }));
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
