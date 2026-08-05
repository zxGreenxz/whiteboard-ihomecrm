// Lát 1 của Đợt 4: listener auth phải có vòng đời rõ ràng.
//
// Trước đây nó đăng ký ở module scope trong App.tsx và vứt luôn subscription —
// không có đường huỷ. Test này cố định bốn tính chất mà bản cũ KHÔNG có: huỷ
// được, không rò rỉ khi đăng ký lại nhiều lần, chuyển tiếp đúng sự kiện, và
// callback vẫn là hàm đồng bộ.
import { beforeEach, describe, expect, it, vi } from "vitest";

const unsubscribe = vi.fn();
const onAuthStateChange = vi.fn();
const syncAuthQueryCache = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { onAuthStateChange: (cb: unknown) => onAuthStateChange(cb) } },
}));

vi.mock("@/lib/authQueryCache", () => ({
  syncAuthQueryCache: (...args: unknown[]) => syncAuthQueryCache(...args),
}));

const { subscribeAuthCacheSync } = await import("../AuthCacheSync");

const fakeClient = {} as Parameters<typeof subscribeAuthCacheSync>[0];

beforeEach(() => {
  vi.clearAllMocks();
  onAuthStateChange.mockImplementation(() => ({ data: { subscription: { unsubscribe } } }));
});

describe("subscribeAuthCacheSync", () => {
  it("đăng ký đúng MỘT listener", () => {
    subscribeAuthCacheSync(fakeClient);
    expect(onAuthStateChange).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("trả về hàm huỷ thật — đây là thứ bản module-scope không có", () => {
    const stop = subscribeAuthCacheSync(fakeClient);
    expect(typeof stop).toBe("function");
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("đăng ký lại nhiều lần không để listener cũ sống sót (HMR / test isolation)", () => {
    subscribeAuthCacheSync(fakeClient)();
    subscribeAuthCacheSync(fakeClient)();
    subscribeAuthCacheSync(fakeClient)();

    // Số lần huỷ phải bằng số lần đăng ký; lệch nghĩa là có listener còn sống
    // và tiếp tục ghi vào cùng một cache key.
    expect(onAuthStateChange).toHaveBeenCalledTimes(3);
    expect(unsubscribe).toHaveBeenCalledTimes(3);
  });

  it("chuyển tiếp sự kiện auth sang syncAuthQueryCache đúng thứ tự tham số", () => {
    subscribeAuthCacheSync(fakeClient);
    const callback = onAuthStateChange.mock.calls[0][0] as (e: string, s: unknown) => void;

    const session = { user: { id: "u1" } };
    callback("INITIAL_SESSION", session);
    callback("SIGNED_OUT", null);

    expect(syncAuthQueryCache).toHaveBeenCalledTimes(2);
    expect(syncAuthQueryCache.mock.calls[0][0]).toBe(fakeClient);
    expect(syncAuthQueryCache.mock.calls[0][1]).toBe("INITIAL_SESSION");
    expect(syncAuthQueryCache.mock.calls[0][2]).toBe(session);
    expect(syncAuthQueryCache.mock.calls[1][1]).toBe("SIGNED_OUT");
    expect(syncAuthQueryCache.mock.calls[1][2]).toBeNull();
  });

  it("callback là hàm SYNC — await supabase.* trong đó gây deadlock", () => {
    subscribeAuthCacheSync(fakeClient);
    const callback = onAuthStateChange.mock.calls[0][0] as (...a: unknown[]) => unknown;

    // Trả về Promise nghĩa là ai đó đã biến nó thành async. supabase-js giữ lock
    // nội bộ khi dispatch sự kiện auth, nên một await ở đây khoá luôn client —
    // triệu chứng là app treo im lặng lúc boot, không có lỗi nào để lần theo.
    expect(callback("INITIAL_SESSION", null)).toBeUndefined();
  });
});
