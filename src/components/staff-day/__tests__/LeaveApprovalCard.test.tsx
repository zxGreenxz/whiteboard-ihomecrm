// @vitest-environment jsdom
// Thẻ «Đơn xin nghỉ chờ duyệt» trên các màn Hôm nay: chỉ super admin thấy nút (khớp cổng
// `approve_leave` = is_super_admin), bấm gửi đúng người/ngày/quyết định, lỗi đọc không giả là «không có đơn».
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { user_id: string; work_date: string; reason: string | null; requested_at: string | null; staff_name: string };

const m = vi.hoisted(() => ({
  superAdmin: { data: true as boolean | undefined },
  leaves: {} as Record<string, unknown>,
  enabledArgs: [] as boolean[],
  mutate: vi.fn(),
  approve: { isPending: false, variables: undefined as unknown },
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/hooks/useIsAdmin", () => ({ useIsSuperAdmin: () => m.superAdmin }));
vi.mock("@/hooks/useMyDay", () => ({
  usePendingLeaveRequests: (enabled: boolean) => { m.enabledArgs.push(enabled); return m.leaves; },
  useApproveLeave: () => ({ mutate: m.mutate, ...m.approve }),
  leaveActionErrorMessage: (_error: unknown, args: { date: string; approve: boolean; employeeName?: string }) =>
    `lỗi ${args.approve ? "duyệt" : "từ chối"} ${args.employeeName} ${args.date}`,
}));
vi.mock("sonner", () => ({ toast: { success: m.success, error: m.error } }));

import { LeaveApprovalCard } from "../LeaveApprovalCard";

const JOEY: Row = { user_id: "u-joey", work_date: "2026-11-18", reason: null, requested_at: "2026-11-18T15:54:48Z", staff_name: "JOEY" };
const NATHAN: Row = { user_id: "u-nathan", work_date: "2026-11-20", reason: "Về quê", requested_at: null, staff_name: "NATHAN" };

const loaded = (rows: Row[]) => ({
  data: rows, status: "success", fetchStatus: "idle", isLoading: false, isError: false, error: null, refetch: vi.fn(),
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  m.superAdmin = { data: true };
  m.leaves = loaded([JOEY, NATHAN]);
  m.enabledArgs = [];
  m.approve = { isPending: false, variables: undefined };
});

describe("LeaveApprovalCard", () => {
  it("không phải super admin: không hiện thẻ và không đọc danh sách đơn", () => {
    m.superAdmin = { data: false };
    const { container } = render(<LeaveApprovalCard />);
    expect(container.innerHTML).toBe("");
    expect(m.enabledArgs.length).toBeGreaterThan(0);
    expect(m.enabledArgs.every((enabled) => enabled === false)).toBe(true);
  });

  it("chưa xác nhận được quyền: không hiện nút duyệt", () => {
    m.superAdmin = { data: undefined };
    const { container } = render(<LeaveApprovalCard />);
    expect(container.innerHTML).toBe("");
  });

  it("super admin thấy mọi đơn chờ; bấm Duyệt gửi đúng người, đúng ngày và báo kết quả", () => {
    render(<LeaveApprovalCard />);
    expect(m.enabledArgs.at(-1)).toBe(true);
    expect(screen.getByRole("region", { name: "Đơn xin nghỉ chờ duyệt" })).toBeTruthy();
    expect(screen.getByText("JOEY")).toBeTruthy();
    expect(screen.getByText("Nghỉ ngày 18/11/2026")).toBeTruthy();
    expect(screen.getByText("Không ghi lý do")).toBeTruthy();
    expect(screen.getByText("Nghỉ ngày 20/11/2026")).toBeTruthy();
    expect(screen.getByText("Về quê")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Duyệt đơn nghỉ ngày 18/11/2026 của JOEY" }));
    expect(m.mutate).toHaveBeenCalledTimes(1);
    expect(m.mutate.mock.calls[0][0]).toEqual({ user: "u-joey", date: "2026-11-18", approve: true });
    m.mutate.mock.calls[0][1].onSuccess();
    expect(m.success).toHaveBeenCalledWith("Đã duyệt đơn nghỉ ngày 18/11/2026 của JOEY.");
  });

  it("Từ chối gửi approve=false; lỗi báo theo đúng đơn bị bấm", () => {
    render(<LeaveApprovalCard />);
    fireEvent.click(screen.getByRole("button", { name: "Từ chối đơn nghỉ ngày 20/11/2026 của NATHAN" }));
    expect(m.mutate.mock.calls[0][0]).toEqual({ user: "u-nathan", date: "2026-11-20", approve: false });
    m.mutate.mock.calls[0][1].onError(new Error("Ngày này không ở trạng thái chờ duyệt phép"));
    expect(m.error).toHaveBeenCalledWith("lỗi từ chối NATHAN 2026-11-20");
    expect(m.success).not.toHaveBeenCalled();
  });

  it("trang một người chỉ hiện đơn của người đó", () => {
    render(<LeaveApprovalCard userId="u-nathan" />);
    expect(screen.queryByText(/JOEY/)).toBeNull();
    expect(screen.getByText("NATHAN")).toBeTruthy();
    expect(screen.getByText("Nghỉ ngày 20/11/2026")).toBeTruthy();
    expect(screen.getByText("1 đơn")).toBeTruthy();
  });

  it("không có đơn của người đang xem: không chiếm chỗ", () => {
    const { container } = render(<LeaveApprovalCard userId="u-khac" />);
    expect(container.innerHTML).toBe("");
  });

  it("đang tải lần đầu: không hiện thẻ rỗng", () => {
    m.leaves = { data: undefined, status: "pending", fetchStatus: "fetching", isLoading: true, isError: false, error: null, refetch: vi.fn() };
    const { container } = render(<LeaveApprovalCard />);
    expect(container.innerHTML).toBe("");
  });

  it("lỗi đọc danh sách đơn: báo lỗi có nút tải lại, không giả là không có đơn", async () => {
    const refetch = vi.fn();
    m.leaves = { data: undefined, status: "error", fetchStatus: "idle", isLoading: false, isError: true, error: { code: "42501", message: "private sql" }, refetch };
    render(<LeaveApprovalCard />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Chưa tải được đơn nghỉ chờ duyệt");
    expect(alert.textContent).not.toContain("private sql");
    expect(screen.queryByRole("button", { name: /^Duyệt/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tải lại" }));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });

  it("đang gửi một quyết định: khoá mọi nút, nhãn chỉ đổi ở đơn đang gửi", () => {
    m.approve = { isPending: true, variables: { user: "u-joey", date: "2026-11-18", approve: true } };
    render(<LeaveApprovalCard />);
    const joey = screen.getByRole("button", { name: "Duyệt đơn nghỉ ngày 18/11/2026 của JOEY" }) as HTMLButtonElement;
    const nathan = screen.getByRole("button", { name: "Duyệt đơn nghỉ ngày 20/11/2026 của NATHAN" }) as HTMLButtonElement;
    expect(joey.textContent).toBe("Đang duyệt…");
    expect(nathan.textContent).toBe("Duyệt");
    expect(joey.disabled && nathan.disabled).toBe(true);
    for (const button of screen.getAllByRole("button", { name: /^Từ chối/ })) expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
