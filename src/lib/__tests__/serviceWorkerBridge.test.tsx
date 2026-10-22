// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from "react-router-dom";

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
  closeAll: vi.fn(async (_org: string | null) => 0),
  ensure: vi.fn(async () => "in-sync"),
  recover: vi.fn(async () => "resubscribed"),
  ghiOrg: 0,
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
vi.mock("@/lib/push", () => ({ ensurePushSubscription: io.ensure, recoverPushAfterBrowserChange: io.recover }));

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
    io.ghiOrg = 0;
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

  it("url ngoài allow-list: đánh dấu đọc rồi về /my-day (khớp đích dự phòng của SQL), không 'bấm mà không đi đâu'", () => {
    dung();
    swGui({ type: "notification-click", url: "/khong-co-route", notificationIds: [ID1], organizationId: null });
    expect(io.markRead).toHaveBeenCalledWith([ID1]);
    expect(viTri()).toBe("/my-day");
  });

  it("push lịch Hermes (/settings/hermes) điều hướng đúng trang khi app đang mở", () => {
    dung();
    swGui({ type: "notification-click", url: "/settings/hermes", notificationIds: [], organizationId: ORG_A });
    expect(viTri()).toBe("/settings/hermes");
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

  it("mở tab mới từ push (?__pn=&__porg=): gỡ tham số khỏi URL, đánh dấu đọc, đổi công ty, ở nguyên trang", () => {
    dung(`/thu-tien?handover=${ID2}&__pn=${ID1}&__porg=${ORG_B}`);
    expect(viTri()).toBe(`/thu-tien?handover=${ID2}`);
    expect(io.markRead).toHaveBeenCalledWith([ID1]);
    expect(io.selectOrganization).toHaveBeenCalledWith(ORG_B);
  });

  it("tham số cũ `notif`/`org` không còn là tín hiệu của cầu nối: URL giữ nguyên, không đánh dấu/đổi công ty", () => {
    dung(`/reports/x?notif=${ID1}&org=${ORG_B}`);
    expect(viTri()).toBe(`/reports/x?notif=${ID1}&org=${ORG_B}`);
    expect(io.markRead).not.toHaveBeenCalled();
    expect(io.selectOrganization).not.toHaveBeenCalled();
  });

  describe("NOTIF-CLIENT-1: trang tự ghi ?org= (báo cáo KQKD) sống chung với cầu nối", () => {
    /** Chép đúng khuôn effect của BusinessPerformanceReportPage: thiếu/lệch `org` ⇒ ghi lại bằng replace. */
    function TrangBaoCao() {
      const [params, setParams] = useSearchParams();
      useEffect(() => {
        if (params.get("org") === ORG_B) return;
        io.ghiOrg += 1;
        if (io.ghiOrg > 50) throw new Error("vòng lặp ghi ?org= vô hạn");
        const next = new URLSearchParams(params);
        next.set("org", ORG_B);
        setParams(next, { replace: true });
      }, [params, setParams]);
      return null;
    }
    const dungBaoCao = (entry: string) => render(
      <MemoryRouter initialEntries={[entry]}>
        <ServiceWorkerBridge />
        <Routes><Route path="/reports/finance/business-performance" element={<TrangBaoCao />} /></Routes>
        <ViTri />
      </MemoryRouter>,
    );

    it("trang ghi ?org= một lần, URL ổn định, cầu nối không gọi selectOrganization", () => {
      dungBaoCao("/reports/finance/business-performance");
      expect(viTri()).toBe(`/reports/finance/business-performance?org=${ORG_B}`);
      expect(io.ghiOrg).toBe(1);
      expect(io.selectOrganization).not.toHaveBeenCalled();
      expect(io.markRead).not.toHaveBeenCalled();
    });

    it("mở từ push vào chính trang đó: chỉ gỡ __pn/__porg, `org` của trang giữ nguyên, xử lý đúng một lần", () => {
      dungBaoCao(`/reports/finance/business-performance?org=${ORG_B}&__pn=${ID1}&__porg=${ORG_B}`);
      expect(viTri()).toBe(`/reports/finance/business-performance?org=${ORG_B}`);
      expect(io.ghiOrg).toBe(0);
      expect(io.markRead).toHaveBeenCalledTimes(1);
      expect(io.selectOrganization).toHaveBeenCalledTimes(1);
      expect(io.selectOrganization).toHaveBeenCalledWith(ORG_B);
    });
  });

  it("push-received làm tươi hộp thư; tin lạ bị bỏ qua", () => {
    dung();
    swGui({ type: "push-received", payload: {} });
    swGui({ type: "la" });
    expect(io.invalidate).toHaveBeenCalledTimes(1);
    expect(io.invalidate).toHaveBeenCalledWith({ queryKey: ["notifications"] });
  });

  it("số chưa đọc (công ty đang chọn) ⇒ số trên icon; về 0 ⇒ chỉ đóng thông báo hộp thư của CÔNG TY ĐANG CHỌN", () => {
    const view = dung();
    expect(io.badge).toHaveBeenLastCalledWith(3);
    expect(io.closeAll).not.toHaveBeenCalled();
    io.count = 0;
    view.rerender(<MemoryRouter><ServiceWorkerBridge /><ViTri /></MemoryRouter>);
    expect(io.badge).toHaveBeenLastCalledWith(0);
    expect(io.closeAll).toHaveBeenCalledOnce();
    expect(io.closeAll).toHaveBeenCalledWith(ORG_A);
  });

  it("có phiên + đã chốt công ty: đối chiếu đăng ký push một lần; SW báo đăng ký đổi thì đối chiếu lại", async () => {
    dung();
    await vi.waitFor(() => expect(io.ensure).toHaveBeenCalledWith(ORG_A));
    swGui({ type: "push-subscription-changed", endpoint: "https://push.example/new", oldEndpoint: "https://push.example/old" });
    await vi.waitFor(() => expect(io.ensure).toHaveBeenCalledTimes(2));
    expect(io.recover).not.toHaveBeenCalled();
  });

  it("SW không tự đăng ký lại được (endpoint null): app khôi phục bằng khoá của app, mang endpoint cũ để kiểm 'từng có dòng'", async () => {
    dung();
    await vi.waitFor(() => expect(io.ensure).toHaveBeenCalledTimes(1));
    swGui({ type: "push-subscription-changed", endpoint: null, oldEndpoint: "https://push.example/old" });
    await vi.waitFor(() => expect(io.recover).toHaveBeenCalledWith("https://push.example/old", ORG_A));
    expect(io.ensure).toHaveBeenCalledTimes(1);
  });

  it("chưa chốt công ty: chưa đối chiếu (lưu đăng ký cần organization_id)", async () => {
    io.org = { ...io.org, selectedOrganizationId: null };
    dung();
    await Promise.resolve();
    expect(io.ensure).not.toHaveBeenCalled();
  });
});
