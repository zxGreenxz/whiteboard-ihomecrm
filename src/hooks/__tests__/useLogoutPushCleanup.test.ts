import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  order: [] as string[],
  signOut: vi.fn(),
  disablePushForLogout: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options: unknown) => options),
  useMutation: vi.fn((options: unknown) => options),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), clear: vi.fn() }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/accountBrowserState", () => ({ restartAtLogin: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signOut: io.signOut } } }));
vi.mock("@/lib/push", () => ({ disablePushForLogout: io.disablePushForLogout }));

import { LOGOUT_PUSH_DEADLINE_MS, useLogout } from "@/hooks/useAuth";

const mutationFn = () => (useLogout() as unknown as { mutationFn: () => Promise<void> }).mutationFn();

describe("useLogout gỡ đăng ký push của máy này TRƯỚC khi đăng xuất", () => {
  beforeEach(() => {
    io.order.length = 0;
    io.signOut.mockReset().mockImplementation(async () => {
      io.order.push("signOut");
      return { error: null };
    });
    io.disablePushForLogout.mockReset().mockImplementation(async () => {
      io.order.push("push");
      return "removed";
    });
  });
  afterEach(() => vi.useRealTimers());

  it("dọn push chạy trước signOut (cần phiên để xoá dòng của chính mình)", async () => {
    await mutationFn();
    expect(io.order).toEqual(["push", "signOut"]);
    expect(io.disablePushForLogout).toHaveBeenCalledWith(LOGOUT_PUSH_DEADLINE_MS);
  });

  it("dọn push lỗi vẫn đăng xuất", async () => {
    io.disablePushForLogout.mockRejectedValue(new Error("PRIVATE_PUSH"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mutationFn();
    expect(io.signOut).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("dọn push treo: tối đa 3 giây rồi vẫn đăng xuất", async () => {
    vi.useFakeTimers();
    io.disablePushForLogout.mockImplementation(() => new Promise(() => {}));
    const done = mutationFn();
    await vi.advanceTimersByTimeAsync(LOGOUT_PUSH_DEADLINE_MS - 1);
    expect(io.signOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(io.signOut).toHaveBeenCalledOnce();
  });
});
