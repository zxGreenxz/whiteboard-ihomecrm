// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const io = vi.hoisted(() => ({ desktop: true }));

vi.mock("@/components/layout/NotificationBell", () => ({ default: () => <button type="button" aria-label="Thông báo" /> }));
vi.mock("../NotificationBell", () => ({ default: () => <button type="button" aria-label="Thông báo" /> }));
vi.mock("../Sidebar", () => ({ default: ({ notificationSlot }: { notificationSlot?: ReactNode }) => <nav>{notificationSlot}</nav> }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: { id: "u1", email: "a@b.c" } }),
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useProfile", () => ({ useProfile: () => ({ data: { full_name: "Nguyễn Văn A" } }) }));
vi.mock("@/components/layout/RealtimeSyncBanner", () => ({ default: () => <div data-testid="realtime-banner" /> }));

import MainLayout from "@/components/layout/MainLayout";

function giaLapManHinh(desktop: boolean) {
  io.desktop = desktop;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("min-width: 1024px") ? io.desktop : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

const renderLayout = (props: { hideMobileHeader?: boolean } = {}) =>
  render(<MemoryRouter><MainLayout {...props}><p>nội dung</p></MainLayout></MemoryRouter>);

describe("MainLayout chỉ dựng MỘT chuông thông báo (C6)", () => {
  beforeEach(() => giaLapManHinh(true));
  afterEach(cleanup);

  it("desktop: chuông ở sidebar, header mobile không dựng chuông thứ hai", () => {
    renderLayout();
    expect(screen.getAllByRole("button", { name: "Thông báo" })).toHaveLength(1);
    expect(screen.getByRole("navigation").querySelector('[aria-label="Thông báo"]')).not.toBeNull();
  });

  it("mobile: chuông ở header, sidebar không dựng thêm", () => {
    giaLapManHinh(false);
    renderLayout();
    expect(screen.getAllByRole("button", { name: "Thông báo" })).toHaveLength(1);
    expect(screen.getByRole("navigation").querySelector('[aria-label="Thông báo"]')).toBeNull();
  });

  it("mount dải cảnh báo realtime ở vùng nội dung", () => {
    renderLayout();
    expect(screen.getByTestId("realtime-banner")).toBeTruthy();
  });
});
