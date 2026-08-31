import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTracker, NOOP_TRACKER } from "./tracking";
import { fmtDuration } from "@/components/sale-phong/analyticsUtils";
import { supabase } from "@/integrations/supabase/client";

/**
 * A minimal view of the client, used only for spying.
 *
 * `supabase.rpc` carries one overload per database function, and the generated
 * Database type now spans every table in the project - enough that inferring
 * through those overloads inside `vi.spyOn` exceeds TypeScript's instantiation
 * depth (TS2589). The spy only needs to observe calls, so it attaches through
 * this narrow shape instead, keeping the one deliberate cast in a single place.
 */
const spyableClient = supabase as unknown as {
  rpc: (name: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

type AnyEvent = { event_type: string; metadata?: Record<string, unknown> };

/** Mọi sự kiện đã gửi qua supabase.rpc trong một bài test. */
const rpcEvents = (rpc: { mock: { calls: unknown[][] } }): AnyEvent[] =>
  rpc.mock.calls
    .filter((c) => c[0] === "log_public_room_events")
    .flatMap((c) => ((c[1] as { p_events?: AnyEvent[] })?.p_events ?? []));

/** Mọi sự kiện đã gửi qua fetch(keepalive) — đường flush cuối. */
const fetchEvents = (f: { mock: { calls: unknown[][] } }): AnyEvent[] =>
  f.mock.calls.flatMap((c) => {
    const body = (c[1] as { body?: string } | undefined)?.body;
    if (!body) return [];
    return (JSON.parse(body) as { p_events?: AnyEvent[] }).p_events ?? [];
  });

/** Kho lưu tối giản đủ cho localStorage/sessionStorage trong môi trường node. */
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as unknown as Storage;
}

/** window/document giả, đủ để tracker gắn được listener và hẹn giờ. */
function stubDom(extra: Record<string, unknown> = {}) {
  const listeners: { target: string; type: string; capture: unknown }[] = [];
  const win = {
    addEventListener: (type: string, _fn: unknown, opts?: unknown) =>
      void listeners.push({ target: "window", type, capture: opts }),
    removeEventListener: (type: string, _fn: unknown, opts?: unknown) =>
      void listeners.push({ target: "window:off", type, capture: opts }),
    setInterval: () => 1,
    clearInterval: () => undefined,
    innerWidth: 390,
    innerHeight: 844,
    ...extra,
  };
  const doc = {
    visibilityState: "visible",
    referrer: "",
    addEventListener: (type: string) => void listeners.push({ target: "document", type, capture: undefined }),
    removeEventListener: (type: string) => void listeners.push({ target: "document:off", type, capture: undefined }),
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { href: "https://ptcrm.vercel.app/phongtrong", origin: "https://ptcrm.vercel.app" });
  return { win, listeners };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("fmtDuration", () => {
  it("formats m:ss and h:mm", () => {
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(5_000)).toBe("0:05");
    expect(fmtDuration(65_000)).toBe("1:05");
    expect(fmtDuration(600_000)).toBe("10:00");
    expect(fmtDuration(3_661_000)).toBe("1h01");
    expect(fmtDuration(-50)).toBe("0:00");
    expect(fmtDuration(NaN as unknown as number)).toBe("0:00");
  });
});

describe("createTracker", () => {
  beforeEach(() => {
    try { sessionStorage.clear(); } catch { /* node: không có sessionStorage */ }
    vi.restoreAllMocks();
    // chặn mọi network thật (flush keepalive) trong test
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a no-op tracker when no token", () => {
    const t = createTracker(undefined, { isStaff: false });
    expect(t.enabled).toBe(false);
    expect(t.sessionId).toBe("");
    // không ném khi gọi các API
    expect(() => { t.track("session"); t.trackError({ kind: "js", msg: "x" }); t.start(); t.stop(); }).not.toThrow();
  });

  it("buffers events and flushes via supabase.rpc (not immediately)", async () => {
    const rpc = vi.spyOn(spyableClient, "rpc").mockResolvedValue({ data: 1, error: null } as never);
    const t = createTracker("tok-abc", { isStaff: true });
    expect(t.enabled).toBe(true);
    expect(t.sessionId).toBeTruthy();

    // track chỉ đẩy buffer — chưa gọi RPC ngay
    t.track("room_open", { room_id: "11111111-1111-1111-1111-111111111111", dwell_ms: 1234 });
    expect(rpc).not.toHaveBeenCalled();

    // flush thủ công (non-final) → gọi đúng RPC với token + mảng sự kiện
    t.flush();
    expect(rpc).toHaveBeenCalled();
    const [fn, params] = rpc.mock.calls[0];
    expect(fn).toBe("log_public_room_events");
    expect(params).toHaveProperty("p_token", "tok-abc");
    expect(Array.isArray((params as { p_events: unknown[] }).p_events)).toBe(true);
  });

  it("dedupes impressions per room within a session", () => {
    const rpc = vi.spyOn(spyableClient, "rpc").mockResolvedValue({ data: 1, error: null } as never);
    const t = createTracker("tok-imp", { isStaff: false });
    const room = { room_id: "22222222-2222-2222-2222-222222222222" };
    t.track("impression", room);
    t.track("impression", room); // trùng → bỏ
    t.flush();
    const impressions = rpcEvents(rpc).filter((e) => e.event_type === "impression");
    expect(impressions.length).toBe(1);
  });
});

describe("createTracker — ghi lỗi", () => {
  beforeEach(() => {
    try { sessionStorage.clear(); } catch { /* node */ }
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chuẩn hoá lỗi: có vân tay, nguồn và thông tin thiết bị", () => {
    const rpc = vi.spyOn(spyableClient, "rpc").mockResolvedValue({ data: 1, error: null } as never);
    stubDom();
    const t = createTracker("tok-e1", { isStaff: false });
    t.trackError({ kind: "js", msg: "TypeError: x", src: "/assets/a.js", line: 3, col: 9 });
    t.flush();

    const [err] = rpcEvents(rpc).filter((e) => e.event_type === "error");
    expect(err).toBeTruthy();
    expect(err.metadata).toMatchObject({ kind: "js", source: "app", n: 1, line: 3, col: 9 });
    expect(err.metadata?.fp).toMatch(/^[0-9a-f]{8}$/);
    expect(err.metadata?.href).toBe("https://ptcrm.vercel.app/phongtrong");
    expect(err.metadata?.vp).toBe("390x844");
  });

  it("tách lỗi do WebView bên thứ ba tiêm vào (zaloJSV2) sang source=external", () => {
    const rpc = vi.spyOn(spyableClient, "rpc").mockResolvedValue({ data: 1, error: null } as never);
    stubDom();
    const t = createTracker("tok-e2", { isStaff: false });
    t.trackError({ kind: "js", msg: "ReferenceError: Can't find variable: zaloJSV2" });
    t.flush();
    const [err] = rpcEvents(rpc).filter((e) => e.event_type === "error");
    expect(err.metadata?.source).toBe("external");
  });

  it("gộp lỗi trùng: 1 dòng lúc đầu, bản cập nhật n khi flush cuối", async () => {
    const rpc = vi.spyOn(spyableClient, "rpc").mockResolvedValue({ data: 1, error: null } as never);
    stubDom();
    const f = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", f);

    const t = createTracker("tok-e3", { isStaff: false });
    for (let i = 0; i < 3; i++) t.trackError({ kind: "js", msg: "loi lap", src: "/a.js", line: 1 });
    t.flush();
    await tick(); // để lô đầu rời buffer sau khi máy chủ nhận

    const first = rpcEvents(rpc).filter((e) => e.event_type === "error");
    expect(first.length).toBe(1);
    expect(first[0].metadata?.n).toBe(1);

    t.flushNow(); // gửi lại bộ đếm đã tăng
    const updates = fetchEvents(f).filter((e) => e.event_type === "error");
    expect(updates.length).toBe(1);
    expect(updates[0].metadata?.n).toBe(3);
    expect(updates[0].metadata?.fp).toBe(first[0].metadata?.fp);
  });

  it("giữ lô khi gửi hỏng rồi gửi lại ở lần flush sau", async () => {
    // postgrest-js KHÔNG ném khi mạng hỏng — nó fulfil kèm { error }. Test cũ
    // dùng mockRejectedValue nên xanh mà không chứng minh được gì: nhánh giữ lô
    // thật ra là mã chết. Phải mô phỏng đúng hình dạng client thật trả về.
    const rpc = vi
      .spyOn(spyableClient, "rpc")
      .mockResolvedValue({ data: null, error: { message: "FetchError: mat song" } } as never);
    stubDom();
    const t = createTracker("tok-e4", { isStaff: false });
    t.trackError({ kind: "js", msg: "loi mang" });

    t.flush();
    await tick();
    expect(rpc).toHaveBeenCalledTimes(1);

    // lô vẫn còn trong buffer → lần flush sau gửi LẠI đúng sự kiện đó
    t.flush();
    await tick();
    expect(rpc).toHaveBeenCalledTimes(2);
    const sent = rpcEvents(rpc).filter((e) => e.event_type === "error");
    expect(sent.length).toBe(2);
    expect(sent[0].metadata?.fp).toBe(sent[1].metadata?.fp);
  });

  it("hỏng dai dẳng thì ký gửi lỗi vào localStorage và tracker sau gửi tiếp", async () => {
    const store = fakeStorage();
    vi.stubGlobal("localStorage", store);
    stubDom();
    const rpc = vi
      .spyOn(spyableClient, "rpc")
      .mockResolvedValue({ data: null, error: { message: "FetchError: mat song" } } as never);

    const t = createTracker("tok-e5", { isStaff: false });
    t.trackError({ kind: "js", msg: "loi dai dang" });
    for (let i = 0; i < 5; i++) { t.flush(); await tick(); }

    const parked = store.getItem("pt_perr_tok-e5");
    expect(parked).toBeTruthy();
    expect(JSON.parse(parked as string)).toHaveLength(1);

    // Tracker mới (lần tải trang sau) rút kho ký gửi ra gửi lại.
    rpc.mockResolvedValue({ data: 1, error: null } as never);
    const t2 = createTracker("tok-e5", { isStaff: false });
    t2.start();
    t2.flush();
    await tick();
    expect(rpcEvents(rpc).some((e) => e.event_type === "error" && e.metadata?.msg === "loi dai dang")).toBe(true);
    expect(store.getItem("pt_perr_tok-e5")).toBeNull();
    t2.stop();
  });
});

describe("createTracker — bàn giao lô khi gửi", () => {
  beforeEach(() => {
    try { sessionStorage.clear(); } catch { /* node */ }
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rời trang giữa lúc một lô đang bay: KHÔNG gửi đúp, KHÔNG mất sự kiện", async () => {
    // Đây là ca đã làm hỏng bản trước: flush cuối lấy lại đúng lô đang bay
    // (gửi đúp toàn bộ) rồi phép cắt của lô kia lấn sang phần chưa ai gửi.
    let giai: ((v: unknown) => void) | undefined;
    const rpc = vi.spyOn(spyableClient, "rpc").mockImplementation(
      () => new Promise((r) => { giai = r; }) as never,
    );
    const f = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", f);
    stubDom();

    const t = createTracker("tok-dua", { isStaff: false });
    for (let i = 0; i < 60; i++) t.track("image_view", { metadata: { i } });

    t.flush();                       // lô 1 (50 sự kiện) đang bay, chưa resolve
    t.flushNow();                    // rời trang giữa chừng → lô 2 (10 còn lại)
    giai?.({ data: 50, error: null }); // lô 1 về đích
    await tick();

    const quaRpc = rpcEvents(rpc).filter((e) => e.event_type === "image_view");
    const quaFetch = fetchEvents(f).filter((e) => e.event_type === "image_view");
    const tatCa = [...quaRpc, ...quaFetch].map((e) => e.metadata?.i);

    expect(tatCa.length).toBe(60);                 // không mất
    expect(new Set(tatCa).size).toBe(60);          // không đúp
  });

  it("gửi hỏng thì trả lô về ĐẦU hàng, giữ nguyên thứ tự", async () => {
    const rpc = vi
      .spyOn(spyableClient, "rpc")
      .mockResolvedValue({ data: null, error: { message: "FetchError" } } as never);
    stubDom();

    const t = createTracker("tok-tra-lo", { isStaff: false });
    t.track("image_view", { metadata: { i: 0 } });
    t.flush();
    await tick();

    t.track("image_view", { metadata: { i: 1 } }); // sự kiện mới tới sau khi hỏng
    rpc.mockResolvedValue({ data: 2, error: null } as never);
    t.flush();
    await tick();

    const lanCuoi = rpc.mock.calls[rpc.mock.calls.length - 1]?.[1] as { p_events: AnyEvent[] };
    expect(lanCuoi.p_events.map((e) => e.metadata?.i)).toEqual([0, 1]);
  });
});

describe("createTracker — cầu nối bắt lỗi sớm", () => {
  beforeEach(() => {
    try { sessionStorage.clear(); } catch { /* node */ }
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rút hàng đợi của pt-boot.js, cắm hook và KHÔNG gắn listener trùng", async () => {
    const rpc = vi.spyOn(spyableClient, "rpc").mockResolvedValue({ data: 1, error: null } as never);
    const bag = {
      q: [
        { k: "js", msg: "loi som 1", src: "/a.js", line: 2 },
        { k: "resource", msg: "resource load failed: IMG", src: "/anh.png" },
      ],
      hook: null as ((r: unknown) => void) | null,
    };
    const { win, listeners } = stubDom({ __ptErr: bag });

    const t = createTracker("tok-early", { isStaff: false });
    t.start();
    t.flush();
    await tick();

    const errs = rpcEvents(rpc).filter((e) => e.event_type === "error");
    expect(errs.map((e) => e.metadata?.msg)).toEqual(["loi som 1", "resource load failed: IMG"]);
    expect(bag.q).toHaveLength(0);
    expect(typeof bag.hook).toBe("function");
    // Có hàng đợi thì tracker KHÔNG được tự gắn listener nữa, nếu không lỗi vào hai lần.
    expect(listeners.filter((l) => l.target === "window" && l.type === "error")).toHaveLength(0);

    // Lỗi tới sau khi đã cắm hook vẫn chảy vào tracker.
    bag.hook?.({ k: "js", msg: "loi sau khi mount" });
    t.flush();
    await tick();
    expect(rpcEvents(rpc).some((e) => e.metadata?.msg === "loi sau khi mount")).toBe(true);

    t.stop();
    expect(bag.hook).toBeNull();
    void win;
  });

  it("không có hàng đợi thì gắn listener dự phòng ở PHA CAPTURE", () => {
    vi.spyOn(spyableClient, "rpc").mockResolvedValue({ data: 1, error: null } as never);
    const { listeners } = stubDom();
    const t = createTracker("tok-fallback", { isStaff: false });
    t.start();

    const errListener = listeners.find((l) => l.target === "window" && l.type === "error");
    expect(errListener).toBeTruthy();
    // capture=true là điều kiện để bắt được tài nguyên tải hỏng (chúng không nổi bọt).
    expect(errListener?.capture).toBe(true);
    expect(listeners.some((l) => l.target === "window" && l.type === "unhandledrejection")).toBe(true);
    t.stop();
  });
});

describe("NOOP_TRACKER", () => {
  it("is inert", () => {
    expect(NOOP_TRACKER.enabled).toBe(false);
    expect(() => NOOP_TRACKER.track("error")).not.toThrow();
    expect(() => NOOP_TRACKER.trackError({ kind: "js", msg: "x" })).not.toThrow();
    expect(() => NOOP_TRACKER.flushNow()).not.toThrow();
  });
});
