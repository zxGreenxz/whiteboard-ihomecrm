// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const io = vi.hoisted(() => ({
  count: undefined as number | undefined,
  perms: { notifications: { view: true } } as Record<string, unknown>,
  permsLoading: false,
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "u1", email: "a@b.c" } }) }));
vi.mock("@/hooks/useProfile", () => ({ useProfile: () => ({ data: { full_name: "Nguyễn Văn A" } }) }));
vi.mock("@/hooks/useDashboard", () => ({ useDashboardStats: () => ({ data: undefined }) }));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => ({ data: io.perms, isLoading: io.permsLoading }) }));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsSuperAdmin: () => ({ data: false, isError: false, isLoading: false, isPending: false }) }));
vi.mock("@/hooks/usePrefetchHeavyPages", () => ({ usePrefetchHeavyPages: () => undefined }));
vi.mock("@/lib/prefetchIntent", () => ({ prefetchOnIntent: vi.fn() }));
vi.mock("@/lib/appSplash", () => ({ hideAppSplash: vi.fn() }));
vi.mock("@/components/pwa/InstallHint", () => ({ default: () => null }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/hooks/useNotifications", () => ({ useUnreadNotificationsCount: () => ({ data: io.count }) }));

import HomeLauncher from "@/pages/home/HomeLauncher";

const renderLauncher = () => render(<MemoryRouter><HomeLauncher /></MemoryRouter>);

describe("HomeLauncher — nút chuông hiện số thật (C6)", () => {
  afterEach(cleanup);
  beforeEach(() => {
    io.count = undefined;
    io.perms = { notifications: { view: true } };
    io.permsLoading = false;
  });

  it("0 chưa đọc: không còn chấm đỏ cố định", () => {
    io.count = 0;
    const { container } = renderLauncher();
    expect(screen.getByRole("link", { name: "Thông báo" })).toBeTruthy();
    expect(container.querySelector(".hh-icbtn .nt")).toBeNull();
  });

  it("có chưa đọc: hiện đúng số, quá 99 thì 99+", () => {
    io.count = 5;
    const { container, unmount } = renderLauncher();
    expect(container.querySelector(".hh-icbtn .nt")?.textContent).toBe("5");
    expect(screen.getByRole("link", { name: "Thông báo: 5 chưa đọc" })).toBeTruthy();
    unmount();
    io.count = 150;
    const again = renderLauncher();
    expect(again.container.querySelector(".hh-icbtn .nt")?.textContent).toBe("99+");
  });

  it("thiếu quyền notifications.view (hoặc quyền chưa nạp): ẩn nút — bấm vào chỉ bị đá về trang chủ", () => {
    io.count = 3;
    io.perms = {};
    const { unmount } = renderLauncher();
    expect(screen.queryByRole("link", { name: /Thông báo/ })).toBeNull();
    unmount();
    io.perms = { notifications: { view: true } };
    io.permsLoading = true;
    renderLauncher();
    expect(screen.queryByRole("link", { name: /Thông báo/ })).toBeNull();
  });
});
