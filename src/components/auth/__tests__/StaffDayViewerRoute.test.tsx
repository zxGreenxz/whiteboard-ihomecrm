// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const viewer = vi.hoisted(() => ({
  canView: false,
  isOwner: false,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
vi.mock("@/hooks/staff-day/useStaffDay", () => ({ useStaffViewer: () => viewer }));

import { StaffDayViewerRoute } from "../StaffDayViewerRoute";

const show = () => render(
  <MemoryRouter initialEntries={["/my-day/team"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Routes>
      <Route path="/my-day/team" element={<StaffDayViewerRoute><p>Việc của quản lý</p></StaffDayViewerRoute>} />
      <Route path="/my-day" element={<p>Ngày của tôi</p>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  Object.assign(viewer, { canView: false, isOwner: false, isLoading: false, isError: false });
  viewer.refetch.mockReset();
});
afterEach(cleanup);

it("cho chủ công ty hoặc super admin vào", () => {
  viewer.canView = true;
  show();
  expect(screen.getByText("Việc của quản lý")).toBeTruthy();
});

it("người không có vai được đưa về màn của chính họ", () => {
  show();
  expect(screen.getByText("Ngày của tôi")).toBeTruthy();
  expect(screen.queryByText("Việc của quản lý")).toBeNull();
});

it("đang tải quyền thì không mở nội dung", () => {
  viewer.isLoading = true;
  show();
  expect(screen.queryByText("Việc của quản lý")).toBeNull();
  expect(screen.queryByText("Ngày của tôi")).toBeNull();
});

it("không đọc được quyền thì giữ kín và cho tải lại, không đá về trang khác", () => {
  viewer.isError = true;
  show();
  expect(screen.getByRole("alert").textContent).toContain("Chưa kiểm tra được quyền xem");
  expect(screen.queryByText("Việc của quản lý")).toBeNull();
  expect(screen.queryByText("Ngày của tôi")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Tải lại" }));
  expect(viewer.refetch).toHaveBeenCalledTimes(1);
});
