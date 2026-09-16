// @vitest-environment jsdom
//
// Bug đang vá: RPC quyền lỗi → useMyPermissions trả `{}` → canUse false →
// `<Navigate to="/" />`. Người dùng CÓ quyền bị đá khỏi trang vì một lỗi mạng,
// và vì query vẫn "success" nên không có gì retry, không có gì hiện ra để bấm.
//
// Ba trạng thái phải TÁCH BẠCH: đang tải / lỗi / đã biết quyền. Chỉ trạng thái
// thứ ba mới được phép chuyển hướng — chuyển hướng là kết luận "bạn không có
// quyền", và ta chỉ kết luận được khi thật sự đọc được quyền.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useMyPermissions = vi.fn();
const navigateTo = vi.fn();

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => useMyPermissions(),
}));

vi.mock("react-router-dom", () => ({
  Navigate: ({ to }: { to: string }) => {
    navigateTo(to);
    return <div data-testid="navigate">{to}</div>;
  },
}));

const { RequirePermission } = await import("../RequirePermission");

const noiDung = () => <div data-testid="trang">Nội dung trang</div>;

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("RequirePermission", () => {
  it("đang tải → skeleton, KHÔNG chuyển hướng, KHÔNG hiện nội dung", () => {
    useMyPermissions.mockReturnValue({ data: undefined, isPending: true, isError: false, refetch: vi.fn() });

    const { container } = render(<RequirePermission module="invoices">{noiDung()}</RequirePermission>);

    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.queryByTestId("trang")).toBeNull();
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0);
  });

  it("LỖI → KHÔNG chuyển hướng (đây là hồi quy chính)", () => {
    useMyPermissions.mockReturnValue({ data: undefined, isPending: false, isError: true, refetch: vi.fn() });

    render(<RequirePermission module="invoices">{noiDung()}</RequirePermission>);

    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.queryByTestId("trang")).toBeNull();
  });

  it("LỖI → hiện lời giải thích và nút thử lại", () => {
    const refetch = vi.fn();
    useMyPermissions.mockReturnValue({ data: undefined, isPending: false, isError: true, refetch });

    render(<RequirePermission module="invoices">{noiDung()}</RequirePermission>);

    expect(screen.getByText(/Không tải được quyền/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /thử lại/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("đọc được quyền và KHÔNG có quyền → vẫn chuyển hướng như cũ", () => {
    useMyPermissions.mockReturnValue({ data: {}, isPending: false, isError: false, refetch: vi.fn() });

    render(<RequirePermission module="invoices">{noiDung()}</RequirePermission>);

    expect(navigateTo).toHaveBeenCalledWith("/");
    expect(screen.queryByTestId("trang")).toBeNull();
  });

  it("chuyển hướng tôn trọng fallbackPath", () => {
    useMyPermissions.mockReturnValue({ data: {}, isPending: false, isError: false, refetch: vi.fn() });

    render(
      <RequirePermission module="invoices" fallbackPath="/khong-co-quyen">
        {noiDung()}
      </RequirePermission>,
    );

    expect(navigateTo).toHaveBeenCalledWith("/khong-co-quyen");
  });

  it("có quyền → hiện nội dung", () => {
    useMyPermissions.mockReturnValue({
      data: { __superadmin: true },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<RequirePermission module="invoices">{noiDung()}</RequirePermission>);

    expect(screen.getByTestId("trang")).toBeTruthy();
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
