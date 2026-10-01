// @vitest-environment jsdom
// Mở lại tab (iPhone treo tab nền) thì khu vực đang báo "Chưa tải được…" phải tự đọc lại,
// không bắt người dùng bấm "Tải lại" (báo lỗi màn Tài khoản 01/10/2026).
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const unsubscribe = vi.fn();
const refetchFailedActiveQueries = vi.fn().mockResolvedValue(undefined);

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe } } }) } },
}));
vi.mock("@/lib/authQueryCache", () => ({
  syncAuthQueryCache: vi.fn(),
  refetchFailedActiveQueries: (...args: unknown[]) => refetchFailedActiveQueries(...args),
}));

const { subscribeAuthCacheSync } = await import("../AuthCacheSync");
const client = {} as Parameters<typeof subscribeAuthCacheSync>[0];
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => { visibility = "visible"; });

it("đọc lại query đang lỗi khi tab hiện lại, không đọc khi tab bị ẩn", () => {
  const stop = subscribeAuthCacheSync(client);
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(refetchFailedActiveQueries).not.toHaveBeenCalled();
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(refetchFailedActiveQueries).toHaveBeenCalledWith(client);
  stop();
});

it("huỷ đăng ký thì gỡ luôn listener tab hiện lại", () => {
  const stop = subscribeAuthCacheSync(client);
  stop();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(refetchFailedActiveQueries).not.toHaveBeenCalled();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
