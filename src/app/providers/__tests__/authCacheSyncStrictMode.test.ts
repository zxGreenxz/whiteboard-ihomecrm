// Vòng đời StrictMode / HMR của listener auth — mô phỏng, KHÔNG dựng DOM.
//
// VÌ SAO KHÔNG THÊM jsdom + @testing-library (P1.3 cho hai lựa chọn)
//   Component `AuthCacheSync` có đúng bốn dòng thân:
//     const queryClient = useQueryClient();
//     useEffect(() => subscribeAuthCacheSync(queryClient), [queryClient]);
//     return null;
//
//   Dựng DOM để render nó chỉ chứng minh MỘT điều: React gọi effect rồi gọi
//   cleanup rồi gọi lại effect. Đó là bảo đảm của chính React, không phải tính
//   chất của mã trong repo này — test nó là test thư viện của người khác.
//
//   Thứ THẬT SỰ có thể sai nằm ở phía chúng ta: hàm cleanup có thực sự nhả
//   subscription không. Cái đó kiểm được trực tiếp bằng cách gọi đúng chuỗi mà
//   StrictMode tạo ra — mount → unmount → mount — trên chính hàm thuần.
//
//   Đổi lại: 3 dependency mới, một environment vitest riêng, và mọi test trong
//   repo chậm đi. Giá đó chỉ đáng nếu nó mua được một tính chất mới; ở đây không.
//
//   Bản thân `subscribeAuthCacheSync` đã được TÁCH RA khỏi component chính vì lý
//   do này (xem chú thích trong AuthCacheSync.tsx). Bộ ca dưới đây dùng đúng cái
//   khả năng đó thay vì huỷ nó bằng cách kéo DOM vào.
//
// ÁN LỆ ĐANG ĐƯỢC CANH
//   Listener này từng đăng ký ở MODULE SCOPE trong App.tsx và vứt luôn
//   subscription. Production nạp module một lần nên không lộ; HMR lúc dev, test
//   isolation, hay một lần import lặp là đủ tạo listener trùng — và mỗi listener
//   lại ghi vào cùng một cache key `['auth','user']`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const unsubscribe = vi.fn();
const onAuthStateChange = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { onAuthStateChange: (cb: unknown) => onAuthStateChange(cb) } },
}));
vi.mock("@/lib/authQueryCache", () => ({ syncAuthQueryCache: vi.fn() }));

const { subscribeAuthCacheSync } = await import("../AuthCacheSync");
const client = {} as Parameters<typeof subscribeAuthCacheSync>[0];

/** Số subscription còn SỐNG = số lần đăng ký trừ số lần huỷ. */
const conSong = () => onAuthStateChange.mock.calls.length - unsubscribe.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  onAuthStateChange.mockImplementation(() => ({ data: { subscription: { unsubscribe } } }));
});

describe("vòng đời StrictMode (mount → unmount → mount)", () => {
  it("sau chu kỳ kép còn ĐÚNG MỘT subscription sống", () => {
    // Đây chính là thứ React StrictMode làm với mọi effect ở chế độ dev.
    const stop1 = subscribeAuthCacheSync(client); // mount
    stop1(); // unmount ngay (StrictMode)
    const stop2 = subscribeAuthCacheSync(client); // mount lại

    expect(onAuthStateChange).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(conSong()).toBe(1);

    stop2();
    expect(conSong()).toBe(0);
  });

  it("QUÊN cleanup giữa hai lần mount ⇒ rò rỉ, và phép đo thấy được", () => {
    // Ca đối chứng: nếu bỏ lời gọi cleanup thì `conSong()` lên 2. Ghim ở đây để
    // chứng minh phép đo KHÔNG luôn trả 1 — một khẳng định luôn đúng thì không
    // canh được gì.
    subscribeAuthCacheSync(client);
    subscribeAuthCacheSync(client);
    expect(conSong()).toBe(2);
  });

  it("chu kỳ HMR lặp 10 lần không tích luỹ listener", () => {
    for (let i = 0; i < 10; i += 1) subscribeAuthCacheSync(client)();
    expect(onAuthStateChange).toHaveBeenCalledTimes(10);
    expect(conSong()).toBe(0);
  });

  it("cleanup gọi HAI LẦN không huỷ nhầm subscription của lần mount sau", () => {
    // React không gọi cleanup hai lần, nhưng HMR và một số bộ test có thể. Nếu
    // hàm huỷ không idempotent thì lần gọi thừa sẽ nhả subscription đang sống.
    const stop1 = subscribeAuthCacheSync(client);
    stop1();
    stop1(); // thừa
    subscribeAuthCacheSync(client);

    // 2 lần đăng ký, 2 lần gọi huỷ (một thừa) — phép đếm thô sẽ ra 0 và tưởng
    // như không còn gì sống. Ghim hiện trạng: hàm huỷ CHƯA idempotent.
    expect(onAuthStateChange).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
