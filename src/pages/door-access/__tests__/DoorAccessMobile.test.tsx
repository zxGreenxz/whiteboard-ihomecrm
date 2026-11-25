// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DoorDevice } from "@/lib/door-access/dto";

/**
 * Màn điện thoại /cua-van-tay (Bản A): viewport ≤ 767px rẽ sang thanh dưới 4 mục + giữ 1 giây để mở.
 * Màn rộng đã có DoorAccessPage.test.tsx (jsdom không có matchMedia ⇒ nhánh máy tính).
 */
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

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/layout/MainLayout", () => ({ default: ({ children }: { children: ReactNode }) => <div data-testid="desktop-layout">{children}</div> }));
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

import DoorAccessView from "../DoorAccessView";

const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";
const CODE = "4827193";

function device(can: Partial<DoorDevice["can"]> = {}): DoorDevice {
  return {
    id: DEVICE_ID,
    building_id: "00000000-0000-4000-8000-0000000000a1",
    building_name: "Tòa A",
    display_name: "Cổng chính",
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

function renderPhone() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>
        <Suspense fallback={<p>route-fallback</p>}>
          <DoorAccessView />
        </Suspense>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function connected(mode: "read" | "all", devices: DoorDevice[]) {
  m.edge.status.mockResolvedValue({ configured: true, connectedOrg: true, mode });
  m.repo.listDevices.mockResolvedValue(devices);
}

const sleep = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const dial = () => screen.findByRole("button", { name: /^Giữ để mở Cổng chính/ }, { timeout: 5000 });
const tabbar = () => screen.getByRole("navigation", { name: "Cửa vân tay" });

beforeEach(() => {
  vi.clearAllMocks();
  m.perms = {};
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom luôn có bộ nhớ */
  }
  // Điện thoại: mọi truy vấn ≤ 767px khớp; không giảm chuyển động.
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  // jsdom chưa có PointerEvent: thiếu nó thì fireEvent.pointerDown không mang `button`/`pointerId`.
  class FakePointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  vi.stubGlobal("PointerEvent", FakePointerEvent);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  m.edge.records.mockResolvedValue({ records: [], total: 0, hasMore: false });
  m.edge.tempPasswords.mockResolvedValue({ passwords: [], hasMore: false });
  m.edge.keys.mockResolvedValue({ users: [], unassigned: [], partial: false });
  m.repo.listKeyLinks.mockResolvedValue([]);
  m.repo.listActionLogs.mockResolvedValue({ logs: [], has_more: false });
  m.repo.canManageOrganization.mockResolvedValue(false);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

describe("Cửa vân tay — màn điện thoại", () => {
  it("rẽ sang bố cục điện thoại: thanh dưới 4 mục, không dựng bố cục máy tính", async () => {
    connected("all", [device()]);
    renderPhone();
    await dial();
    expect(screen.queryByTestId("desktop-layout")).toBeNull();
    expect(within(tabbar()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cửa", "Mã tạm", "Lịch sử", "Quản lý"]);
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("ẩn mục theo quyền ở toà: chỉ có Mã tạm ⇒ Cửa + Mã tạm, nút mở báo chưa có quyền", async () => {
    connected("all", [device({ view: false, remote_unlock: false, manage_devices: false })]);
    renderPhone();
    const button = await dial();
    expect(within(tabbar()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cửa", "Mã tạm"]);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Chưa có quyền mở từ xa")).toBeTruthy();
    // Không có quyền Xem ⇒ không đọc lịch sử từ SmartLife.
    expect(m.edge.records).not.toHaveBeenCalled();
  });

  it("giữ đủ 1 giây ⇒ gửi lệnh mở đúng một lần, hiện Cửa đã mở", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockResolvedValue({ unlocked: true, logId: "log-1" });
    renderPhone();
    const button = await dial();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await sleep(1150);
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    expect(await screen.findByText("Cửa đã mở")).toBeTruthy();
    expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);
    expect(m.edge.remoteUnlock).toHaveBeenCalledWith(DEVICE_ID);
  });

  it("buông tay sớm ⇒ không gửi lệnh, nhắc giữ lâu hơn", async () => {
    connected("all", [device()]);
    renderPhone();
    const button = await dial();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await sleep(400);
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    await sleep(900);
    expect(screen.getByText("Giữ lâu hơn một chút")).toBeTruthy();
    expect(m.edge.remoteUnlock).not.toHaveBeenCalled();
  });

  it("bàn phím: giữ Space đủ giờ thì mở", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockResolvedValue({ unlocked: true, logId: "log-1" });
    renderPhone();
    const button = await dial();
    fireEvent.keyDown(button, { key: " " });
    await sleep(1150);
    fireEvent.keyUp(button, { key: " " });
    expect(await screen.findByText("Cửa đã mở")).toBeTruthy();
    expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);
  });

  it("chưa rõ kết quả ⇒ KHÔNG tự gửi lại, giữ lại cũng không gửi; Đã hiểu mới giữ lại được", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockRejectedValue(new DoorAccessError("unavailable", "Chưa rõ đã mở cửa từ xa chưa.", { outcomeUnknown: true }));
    renderPhone();
    const button = await dial();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await sleep(1150);
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    expect(await screen.findByText("Chưa rõ cửa đã mở chưa")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Xem lịch sử" })).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await sleep(1150);
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Đã hiểu" }));
    expect(screen.getByText("Giữ để mở cửa")).toBeTruthy();
  });

  it("đổi mục giữa lúc gửi lệnh ⇒ quay lại vẫn thấy đang gửi rồi kết quả; KHÔNG gửi được lệnh thứ hai", async () => {
    connected("all", [device()]);
    let resolve: (value: { unlocked: boolean; logId: string }) => void = () => undefined;
    m.edge.remoteUnlock.mockImplementation(() => new Promise((ok) => (resolve = ok)));
    renderPhone();
    const button = await dial();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await sleep(1150);
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    expect(await screen.findByText("Đang gửi lệnh tới cửa…")).toBeTruthy();
    // Thẻ chọn cửa khoá khi đang gửi.
    expect(screen.getByRole("button", { name: /^Đang chọn Cổng chính/ }).getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(within(tabbar()).getByRole("button", { name: "Lịch sử" }));
    await screen.findByRole("group", { name: "Lọc theo cách mở" });
    fireEvent.click(within(tabbar()).getByRole("button", { name: "Cửa" }));
    const again = await dial();
    expect(screen.getByText("Đang gửi lệnh tới cửa…")).toBeTruthy();
    fireEvent.pointerDown(again, { button: 0, pointerId: 1 });
    await sleep(1150);
    fireEvent.pointerUp(again, { button: 0, pointerId: 1 });
    expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);

    await act(async () => resolve({ unlocked: true, logId: "log-1" }));
    expect(await screen.findByText("Cửa đã mở")).toBeTruthy();
    expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);
  });

  it("chưa rõ ⇒ Xem lịch sử rồi quay lại vẫn khoá, phải bấm Đã hiểu", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockRejectedValue(new DoorAccessError("unavailable", "Chưa rõ", { outcomeUnknown: true }));
    renderPhone();
    const button = await dial();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await sleep(1150);
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    await screen.findByText("Chưa rõ cửa đã mở chưa");
    fireEvent.click(screen.getByRole("button", { name: "Xem lịch sử" }));
    await screen.findByRole("group", { name: "Lọc theo cách mở" });
    fireEvent.click(within(tabbar()).getByRole("button", { name: "Cửa" }));
    const again = await dial();
    expect(screen.getByText("Chưa rõ cửa đã mở chưa")).toBeTruthy();
    expect(again.getAttribute("aria-disabled")).toBe("true");
    fireEvent.pointerDown(again, { button: 0, pointerId: 1 });
    await sleep(1150);
    fireEvent.pointerUp(again, { button: 0, pointerId: 1 });
    expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);
  });

  it("trình đọc màn hình (click không con trỏ) ⇒ hỏi xác nhận, Huỷ không gửi, Mở cửa ngay gửi một lần", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockResolvedValue({ unlocked: true, logId: "log-1" });
    renderPhone();
    const button = await dial();
    fireEvent.click(button, { detail: 0 });
    let sheet = await screen.findByRole("alertdialog", { name: "Mở cửa Cổng chính ngay bây giờ?" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(m.edge.remoteUnlock).not.toHaveBeenCalled();
    // Chạm thật (detail 1) không mở hộp — đó là đường giữ.
    fireEvent.click(button, { detail: 1 });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(button, { detail: 0 });
    sheet = await screen.findByRole("alertdialog", { name: "Mở cửa Cổng chính ngay bây giờ?" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Mở cửa ngay" }));
    expect(await screen.findByText("Cửa đã mở")).toBeTruthy();
    expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);
  });

  it("máy báo mất mạng lúc giữ ⇒ gọi ngay và báo chưa rõ; KHÔNG treo rồi tự gửi khi có mạng lại", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockRejectedValue(new DoorAccessError("unavailable", "Chưa rõ", { outcomeUnknown: true }));
    renderPhone();
    const button = await dial();
    onlineManager.setOnline(false);
    try {
      fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
      await sleep(1150);
      fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
      expect(await screen.findByText("Chưa rõ cửa đã mở chưa")).toBeTruthy();
      expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);
    } finally {
      onlineManager.setOnline(true);
    }
    await sleep(50);
    expect(m.edge.remoteUnlock).toHaveBeenCalledTimes(1);
  });

  it("chạm trần 10 lần/10 phút ⇒ báo đúng giới hạn", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockRejectedValue(new DoorAccessError("rate_limited", "Thao tác quá nhiều lần — đợi một lát rồi thử lại.", { code: "rate_limited" }));
    renderPhone();
    const button = await dial();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await sleep(1150);
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    expect(await screen.findByText("Đã gửi 10 lệnh mở trong 10 phút")).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("không mở được (SmartLife từ chối) ⇒ câu lỗi rõ, giữ lại được", async () => {
    connected("all", [device()]);
    m.edge.remoteUnlock.mockRejectedValueOnce(new DoorAccessError("tuya_rejected", "SmartLife từ chối (mã 2001)."));
    renderPhone();
    const button = await dial();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await sleep(1150);
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    expect(await screen.findByText("Chưa mở được cửa")).toBeTruthy();
    expect(screen.getByText(/SmartLife từ chối \(mã 2001\)\./)).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("chế độ chỉ đọc ⇒ nút mở khoá, nói rõ lý do", async () => {
    connected("read", [device()]);
    renderPhone();
    const button = await dial();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Chưa thao tác được trên máy")).toBeTruthy();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    await sleep(1150);
    expect(m.edge.remoteUnlock).not.toHaveBeenCalled();
  });

  it("mã tạm: tạo ⇒ mã hiện một lần, Gửi qua Zalo mở hộp chia sẻ với tin soạn sẵn; Xong là mất mã", async () => {
    connected("all", [device()]);
    const nowSec = Math.floor(Date.now() / 1000);
    m.edge.createTempPassword.mockResolvedValue({ passwordId: 501, password: CODE, effectiveSec: nowSec, invalidSec: nowSec + 7200, logId: "log-1" });
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    renderPhone();
    await dial();
    fireEvent.click(within(tabbar()).getByRole("button", { name: "Mã tạm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Tạo mã" }));
    const sheet = await screen.findByRole("dialog", { name: "Tạo mã tạm" });
    fireEvent.change(within(sheet).getByLabelText(/Tên gợi nhớ/), { target: { value: "Khách xem phòng" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Tạo mã" }));

    const code = await screen.findByRole("img", { name: `Mã ${CODE.split("").join(" ")}` });
    expect(code).toBeTruthy();
    expect(m.edge.createTempPassword).toHaveBeenCalledWith(expect.objectContaining({ deviceId: DEVICE_ID, name: "Khách xem phòng", purpose: "XEM_PHONG" }));
    expect(screen.getByText("Mã chỉ hiện lần này. Rời màn này là không xem lại được, vì CRM không lưu mã.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Gửi qua Zalo" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const text = share.mock.calls[0][0].text as string;
    expect(text).toContain(`Mã mở Cổng chính toà Tòa A: ${CODE}.`);

    fireEvent.click(screen.getByRole("button", { name: "Xong" }));
    await waitFor(() => expect(screen.queryByText(CODE)).toBeNull());
    expect(document.body.textContent).not.toContain(CODE);
    Reflect.deleteProperty(navigator, "share");
  });

  it("máy không có hộp chia sẻ ⇒ Gửi qua Zalo sao chép tin", async () => {
    connected("all", [device()]);
    const nowSec = Math.floor(Date.now() / 1000);
    m.edge.createTempPassword.mockResolvedValue({ passwordId: 501, password: CODE, effectiveSec: nowSec, invalidSec: nowSec + 3600, logId: "log-1" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderPhone();
    await dial();
    fireEvent.click(within(tabbar()).getByRole("button", { name: "Mã tạm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Tạo mã" }));
    const sheet = await screen.findByRole("dialog", { name: "Tạo mã tạm" });
    fireEvent.change(within(sheet).getByLabelText(/Tên gợi nhớ/), { target: { value: "Thợ điện" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "1 giờ" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Tạo mã" }));
    await screen.findByRole("img", { name: `Mã ${CODE.split("").join(" ")}` });
    fireEvent.click(screen.getByRole("button", { name: "Gửi qua Zalo" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain(CODE);
    expect(await screen.findByText("Đã sao chép tin. Dán vào Zalo hoặc tin nhắn để gửi.")).toBeTruthy();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("tên mã trống ⇒ nút Tạo mã khoá, không gọi Edge", async () => {
    connected("all", [device()]);
    renderPhone();
    await dial();
    fireEvent.click(within(tabbar()).getByRole("button", { name: "Mã tạm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Tạo mã" }));
    const sheet = await screen.findByRole("dialog", { name: "Tạo mã tạm" });
    const submit = within(sheet).getByRole("button", { name: "Tạo mã" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(within(sheet).getByText("Nhập tên gợi nhớ để biết mã này đưa cho ai.")).toBeTruthy();
    expect(m.edge.createTempPassword).not.toHaveBeenCalled();
  });

  it("xoá mã tạm: hỏi ngay trong thẻ, Giữ lại thì không gọi, Xoá mã thì gửi lệnh", async () => {
    connected("all", [device()]);
    const nowSec = Math.floor(Date.now() / 1000);
    m.edge.tempPasswords.mockResolvedValue({
      passwords: [{ id: 501, name: "Khách xem phòng", phase: 1, effectiveSec: nowSec - 600, invalidSec: nowSec + 3000, deliveryStatus: 2 }],
      hasMore: false,
    });
    m.edge.deleteTempPassword.mockResolvedValue({ deleted: true, logId: "log-2" });
    renderPhone();
    await dial();
    fireEvent.click(within(tabbar()).getByRole("button", { name: "Mã tạm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Xoá mã Khách xem phòng" }));
    fireEvent.click(screen.getByRole("button", { name: "Giữ lại" }));
    expect(m.edge.deleteTempPassword).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Xoá mã Khách xem phòng" }));
    fireEvent.click(screen.getByRole("button", { name: "Xoá mã" }));
    await waitFor(() => expect(m.edge.deleteTempPassword).toHaveBeenCalledWith(DEVICE_ID, 501));
    expect(await screen.findByText("Đã gửi lệnh xoá mã «Khách xem phòng».")).toBeTruthy();
  });

  it("Đối chiếu: số của khách đã trả phòng nằm ở Cần xoá; xoá phải qua hộp xác nhận", async () => {
    connected("all", [device()]);
    m.edge.keys.mockResolvedValue({
      users: [{ userId: "tuyaUserFake09", name: "Khach P204", role: null, userType: 2, methods: [{ method: "fingerprint", methodCode: null, sn: 9, name: null }] }],
      unassigned: [],
      partial: false,
    });
    m.repo.listKeyLinks.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-0000000001a9",
        device_id: DEVICE_ID,
        unlock_type: "fingerprint",
        unlock_sn: 9,
        tuya_user_id: "tuyaUserFake09",
        device_user_name: "Khach P204",
        customer_id: "00000000-0000-4000-8000-0000000000c9",
        customer_name: "Khách Thử Hai",
        label: null,
        linked_at: "2026-10-01T03:00:00+00:00",
        linked_by_name: null,
        tenancy: "MOVED_OUT",
        room_name: "P204",
        contract_end_date: "2026-11-15",
      },
    ]);
    m.edge.deleteKey.mockResolvedValue({ deleted: true, logId: "log-3" });
    renderPhone();
    await dial();
    fireEvent.click(within(tabbar()).getByRole("button", { name: "Quản lý" }));
    fireEvent.click(await screen.findByRole("button", { name: /Đối chiếu vân tay/ }));
    const remove = await screen.findByRole("button", { name: "Xoá Vân tay #9 · Khách Thử Hai trên máy" });
    expect(m.edge.deleteKey).not.toHaveBeenCalled();
    fireEvent.click(remove);
    const sheet = await screen.findByRole("alertdialog", { name: "Xoá Vân tay #9 khỏi máy?" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Xoá trên máy" }));
    await waitFor(() =>
      expect(m.edge.deleteKey).toHaveBeenCalledWith({ deviceId: DEVICE_ID, unlockType: "fingerprint", unlockNo: 9, tuyaUserId: "tuyaUserFake09" }),
    );
    expect(await within(sheet).findByText("Đã xoá Vân tay #9 trên máy", { selector: "p" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Về Đối chiếu" }));
    expect(await screen.findByText("Đã xoá Vân tay #9 (Khách Thử Hai · P204) trên máy Cổng chính.")).toBeTruthy();
    // Số cần xoá hiện trên thanh dưới sau khi đã đọc Đối chiếu (máy giả vẫn trả số 9 ⇒ còn 1).
    expect(within(tabbar()).getByLabelText("1 số cần xoá")).toBeTruthy();
  });

  it("Lịch sử: nhóm theo ngày, chip lọc theo cách mở", async () => {
    connected("all", [device()]);
    const now = Date.now();
    m.edge.records.mockResolvedValue({
      records: [
        { id: "a", at: now - 60_000, kind: "unlock", method: "fingerprint", methodCode: null, slot: 31, userId: null, userName: "user31", unlockName: null },
        { id: "b", at: now - 120_000, kind: "unlock", method: "card", methodCode: null, slot: 3, userId: null, userName: "the3", unlockName: null },
      ],
      total: 2,
      hasMore: false,
    });
    renderPhone();
    await dial();
    fireEvent.click(within(tabbar()).getByRole("button", { name: "Lịch sử" }));
    const filters = await screen.findByRole("group", { name: "Lọc theo cách mở" });
    expect(within(filters).getAllByRole("button").map((b) => b.textContent)).toEqual(["Tất cả 2", "Vân tay 1", "Thẻ 1"]);
    expect(screen.getByRole("heading", { name: /^Hôm nay, / })).toBeTruthy();
    fireEvent.click(within(filters).getByRole("button", { name: "Thẻ 1" }));
    const list = screen.getByRole("list", { name: /^Lịch sử Hôm nay/ });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Thẻ #3")).toBeTruthy();
  });
});
