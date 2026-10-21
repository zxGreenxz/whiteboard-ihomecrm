// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

const io = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  org: {
    selectedOrganizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null,
    organizations: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    isLoading: false,
  },
  selectOrganization: vi.fn(),
  perms: { __superadmin: true } as Record<string, unknown> | undefined,
  permsLoading: false,
  count: 3 as number | undefined,
  markRead: vi.fn(),
  invalidate: vi.fn(),
  badge: vi.fn(),
  closeAll: vi.fn(async () => 0),
  ensure: vi.fn(async () => "in-sync"),
}));

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: io.invalidate }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: io.user }) }));
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ ...io.org, selectOrganization: io.selectOrganization }),
}));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: io.perms, isLoading: io.permsLoading }) }));
vi.mock("@/hooks/useNotifications", () => ({ useUnreadNotificationsCount: () => ({ data: io.count }) }));
vi.mock("@/hooks/useMarkNotificationsRead", () => ({ useMarkNotificationsRead: () => ({ mutate: io.markRead }) }));
vi.mock("@/lib/push/osNotifications", () => ({ capNhatSoTrenIcon: io.badge, dongMoiThongBaoHopThu: io.closeAll }));
vi.mock("@/lib/push", () => ({ ensurePushSubscription: io.ensure }));

import { CHO_DOI_CONG_TY_MS, ServiceWorkerBridge } from "@/lib/push/serviceWorkerBridge";

let swListener: ((event: { data: unknown; ports: Array<{ postMessage: (d: unknown) => void }> }) => void) | null = null;

function ViTri() {
  const location = useLocation();
  return <output data-testid="loc">{location.pathname + location.search}</output>;
}

function dung(entry = "/income-expense") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ServiceWorkerBridge />
      <ViTri />
    </MemoryRouter>,
  );
}

const viTri = () => screen.getByTestId("loc").textContent;

function swGui(data: unknown) {
  const port = { postMessage: vi.fn() };
  act(() => swListener?.({ data, ports: [port] }));
  return port;
}

describe("cầu nối service worker ↔ app (C4/C5/C7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    io.user = { id: "u1" };
    io.org = { selectedOrganizationId: ORG_A, organizations: [{ id: ORG_A }, { id: ORG_B }], isLoading: false };
    io.perms = { __superadmin: true };
    io.permsLoading = false;
    io.count = 3;
    swListener = null;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: vi.fn((_t: string, fn: typeof swListener) => { swListener = fn; }),
        removeEventListener: vi.fn(),
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("bấm push cùng công ty: xác nhận cho SW, đánh dấu đọc các id, điều hướng SPA qua allow-list", () => {
    dung();
    const port = swGui({ type: "notification-click", url: `/thu-tien?handover=${ID2}&x=1`, notificationIds: [ID1, ID2], organizationId: ORG_A });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "notification-click-ack" });
    expect(io.markRead).toHaveBeenCalledWith([ID1, ID2]);
    expect(io.selectOrganization).not.toHaveBeenCalled();
    expect(viTri()).toBe(`/thu-tien?handover=${ID2}`);
  });

  it("url ngoài allow-list: đánh dấu đọc nhưng KHÔNG điều hướng", () => {
    dung();
    swGui({ type: "notification-click", url: "/khong-co-route", notificationIds: [ID1], organizationId: null });
    expect(io.markRead).toHaveBeenCalledWith([ID1]);
    expect(viTri()).toBe("/income-expense");
  });

  it("thiếu quyền module của đích: hạ về /my-day", () => {
    io.perms = {};
    dung();
    swGui({ type: "notification-click", url: "/finance/cashbooks", notificationIds: [], organizationId: ORG_A });
    expect(viTri()).toBe("/my-day");
  });

  it("push của công ty khác mà người dùng là thành viên: đổi công ty TRƯỚC, đợi quyền công ty mới rồi mới điều hướng", () => {
    const view = dung();
    swGui({ type: "notification-click", url: "/tasks", notificationIds: [ID1], organizationId: ORG_B });
    expect(io.selectOrganization).toHaveBeenCalledWith(ORG_B);
    expect(viTri()).toBe("/income-expense");
    // Công ty đã đổi nhưng quyền công ty mới còn đang nạp.
    io.org = { ...io.org, selectedOrganizationId: ORG_B };
    io.permsLoading = true;
    view.rerender(<MemoryRouter initialEntries={["/income-expense"]}><ServiceWorkerBridge /><ViTri /></MemoryRouter>);
    expect(viTri()).toBe("/income-expense");
    io.permsLoading = false;
    view.rerender(<MemoryRouter initialEntries={["/income-expense"]}><ServiceWorkerBridge /><ViTri /></MemoryRouter>);
    expect(viTri()).toBe("/tasks");
    expect(io.selectOrganization).toHaveBeenCalledTimes(1);
  });

  it("đổi công ty không thành sau thời hạn: vẫn điều hướng ở công ty đang chọn", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dung();
    swGui({ type: "notification-click", url: "/tasks", notificationIds: [], organizationId: ORG_B });
    expect(viTri()).toBe("/income-expense");
    act(() => { vi.advanceTimersByTime(CHO_DOI_CONG_TY_MS); });
    expect(viTri()).toBe("/tasks");
  });

  it("push của công ty mình không còn là thành viên: không đổi công ty", () => {
    dung();
    swGui({ type: "notification-click", url: "/tasks", notificationIds: [], organizationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    expect(io.selectOrganization).not.toHaveBeenCalled();
    expect(viTri()).toBe("/tasks");
  });

  it("mở tab mới từ push (?notif=&org=): gỡ tham số khỏi URL, đánh dấu đọc, đổi công ty, ở nguyên trang", () => {
    dung(`/thu-tien?handover=${ID2}&notif=${ID1}&org=${ORG_B}`);
    expect(viTri()).toBe(`/thu-tien?handover=${ID2}`);
    expect(io.markRead).toHaveBeenCalledWith([ID1]);
    expect(io.selectOrganization).toHaveBeenCalledWith(ORG_B);
  });

  it("push-received làm tươi hộp thư; tin lạ bị bỏ qua", () => {
    dung();
    swGui({ type: "push-received", payload: {} });
    swGui({ type: "la" });
    expect(io.invalidate).toHaveBeenCalledTimes(1);
    expect(io.invalidate).toHaveBeenCalledWith({ queryKey: ["notifications"] });
  });

  it("số chưa đọc ⇒ số trên icon; về 0 ⇒ đóng thông báo hộp thư trên màn khoá", () => {
    const view = dung();
    expect(io.badge).toHaveBeenLastCalledWith(3);
    expect(io.closeAll).not.toHaveBeenCalled();
    io.count = 0;
    view.rerender(<MemoryRouter><ServiceWorkerBridge /><ViTri /></MemoryRouter>);
    expect(io.badge).toHaveBeenLastCalledWith(0);
    expect(io.closeAll).toHaveBeenCalledOnce();
  });

  it("có phiên + đã chốt công ty: đối chiếu đăng ký push một lần; SW báo đăng ký đổi thì đối chiếu lại", async () => {
    dung();
    await vi.waitFor(() => expect(io.ensure).toHaveBeenCalledWith(ORG_A));
    swGui({ type: "push-subscription-changed" });
    await vi.waitFor(() => expect(io.ensure).toHaveBeenCalledTimes(2));
  });

  it("chưa chốt công ty: chưa đối chiếu (lưu đăng ký cần organization_id)", async () => {
    io.org = { ...io.org, selectedOrganizationId: null };
    dung();
    await Promise.resolve();
    expect(io.ensure).not.toHaveBeenCalled();
  });
});
