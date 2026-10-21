// Kiểm public/sw.js — file TĨNH không qua bundler nên không import được: nạp mã
// nguồn rồi chạy với `self`/`MessageChannel` giả, bắn sự kiện như trình duyệt.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SW_SOURCE = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
const ORIGIN = "https://crm.example";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";

type Listener = (event: Record<string, unknown>) => void;

interface FakeClient {
  url: string;
  focused: boolean;
  visibilityState: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

/** MessageChannel giả: tab "trả lời" bằng cách gọi port2.postMessage. */
class FakeChannel {
  port1: { onmessage: ((ev: unknown) => void) | null } = { onmessage: null };
  port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }) };
}

function dungSw() {
  const listeners = new Map<string, Listener>();
  const clientsList: FakeClient[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => clientsList),
      openWindow: vi.fn(async (_url: string) => null),
    },
    registration: {
      showNotification: vi.fn(async (_title: string, _options: unknown) => undefined),
      pushManager: { subscribe: vi.fn(async (_options: unknown) => ({ endpoint: "https://push.example/new" })) },
    },
  };
  new Function("self", "MessageChannel", SW_SOURCE)(self, FakeChannel);

  /** Bắn sự kiện, chờ promise của waitUntil chạy xong (kèm timer giả nếu cần). */
  const ban = async (type: string, extra: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    const event = { ...extra, waitUntil: (p: Promise<unknown>) => { pending = p; } };
    const fn = listeners.get(type);
    if (!fn) throw new Error(`sw.js không nghe ${type}`);
    fn(event);
    return pending;
  };
  return { self, clientsList, ban, listeners };
}

function tab(over: Partial<FakeClient> = {}, ack = true): FakeClient {
  const client: FakeClient = {
    url: `${ORIGIN}/income-expense`,
    focused: false,
    visibilityState: "visible",
    focus: vi.fn(async () => client),
    navigate: vi.fn(async () => client),
    postMessage: vi.fn((data: unknown, ports?: Array<{ postMessage: (d: unknown) => void }>) => {
      if (ack && (data as { type?: string }).type === "notification-click") ports?.[0]?.postMessage({ type: "notification-click-ack" });
    }),
    ...over,
  };
  return client;
}

function bamThongBao(data: Record<string, unknown>) {
  return { notification: { close: vi.fn(), data } };
}

describe("public/sw.js", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("đăng ký đủ các sự kiện của hợp đồng (kể cả pushsubscriptionchange)", () => {
    const { listeners } = dungSw();
    expect([...listeners.keys()].sort()).toEqual(["activate", "install", "notificationclick", "push", "pushsubscriptionchange"]);
  });

  it("push: hiện thông báo kèm data (id + công ty) và báo push-received cho tab", async () => {
    const sw = dungSw();
    const t = tab();
    sw.clientsList.push(t);
    const payload = { title: "Phiếu chờ duyệt", body: "3 phiếu", url: "/income-expense", tag: `crm-${ID1}`, data: { notificationIds: [ID1], organizationId: ORG } };
    await sw.ban("push", { data: { json: () => payload } });
    expect(sw.self.registration.showNotification).toHaveBeenCalledWith("Phiếu chờ duyệt", expect.objectContaining({
      tag: `crm-${ID1}`,
      data: { url: "/income-expense", notificationIds: [ID1], organizationId: ORG },
    }));
    expect(t.postMessage).toHaveBeenCalledWith({ type: "push-received", payload });
  });

  it("bấm khi có tab: focus + giao notification-click cho app, KHÔNG tải lại trang", async () => {
    const sw = dungSw();
    const nen = tab({ visibilityState: "hidden" });
    const dangDung = tab({ focused: true });
    sw.clientsList.push(nen, dangDung);
    const ev = bamThongBao({ url: "/thu-tien?handover=x", notificationIds: [ID1, "rac", ID2], organizationId: ORG });
    await sw.ban("notificationclick", ev);
    expect(ev.notification.close).toHaveBeenCalled();
    expect(dangDung.focus).toHaveBeenCalled();
    expect(dangDung.postMessage).toHaveBeenCalledWith(
      { type: "notification-click", url: "/thu-tien?handover=x", notificationIds: [ID1, ID2], organizationId: ORG },
      expect.any(Array),
    );
    expect(dangDung.navigate).not.toHaveBeenCalled();
    expect(nen.postMessage).not.toHaveBeenCalled();
    expect(sw.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("tab chạy bản app cũ (không xác nhận) ⇒ quá hạn thì điều hướng kiểu cũ, mang id theo URL", async () => {
    const sw = dungSw();
    const cu = tab({}, false);
    sw.clientsList.push(cu);
    const done = sw.ban("notificationclick", bamThongBao({ url: "/my-day", notificationIds: [ID1], organizationId: ORG }));
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(cu.navigate).toHaveBeenCalledWith(`/my-day?notif=${ID1}&org=${ORG}`);
  });

  it("không có tab: mở tab mới với ?notif=&org=", async () => {
    const sw = dungSw();
    await sw.ban("notificationclick", bamThongBao({ url: "/income-expense?approval_status=UNAPPROVED", notificationIds: [ID1, ID2], organizationId: ORG }));
    expect(sw.self.clients.openWindow).toHaveBeenCalledWith(
      `/income-expense?approval_status=UNAPPROVED&notif=${encodeURIComponent(`${ID1},${ID2}`)}&org=${ORG}`,
    );
  });

  it("url khác origin hoặc hỏng ⇒ /my-day; url rỗng ⇒ /", async () => {
    const sw = dungSw();
    await sw.ban("notificationclick", bamThongBao({ url: "https://evil.example/phish" }));
    await sw.ban("notificationclick", bamThongBao({ url: "//evil.example/x" }));
    await sw.ban("notificationclick", bamThongBao({}));
    expect(sw.self.clients.openWindow.mock.calls.map((c) => c[0])).toEqual(["/my-day", "/my-day", "/"]);
  });

  it("pushsubscriptionchange: đăng ký lại bằng applicationServerKey cũ rồi báo app lưu", async () => {
    const sw = dungSw();
    const t = tab();
    sw.clientsList.push(t);
    const key = new Uint8Array([1, 2, 3]).buffer;
    await sw.ban("pushsubscriptionchange", { oldSubscription: { endpoint: "https://push.example/old", options: { applicationServerKey: key } }, newSubscription: null });
    expect(sw.self.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
    expect(t.postMessage).toHaveBeenCalledWith({
      type: "push-subscription-changed",
      endpoint: "https://push.example/new",
      oldEndpoint: "https://push.example/old",
    });
  });

  it("pushsubscriptionchange: trình duyệt đã cấp đăng ký mới thì không subscribe lần nữa; lỗi subscribe vẫn báo app", async () => {
    const sw = dungSw();
    const t = tab();
    sw.clientsList.push(t);
    await sw.ban("pushsubscriptionchange", { oldSubscription: null, newSubscription: { endpoint: "https://push.example/browser" } });
    expect(sw.self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    sw.self.registration.pushManager.subscribe.mockRejectedValueOnce(new Error("denied"));
    await sw.ban("pushsubscriptionchange", { oldSubscription: { endpoint: "e", options: { applicationServerKey: new ArrayBuffer(1) } } });
    expect(t.postMessage).toHaveBeenLastCalledWith({ type: "push-subscription-changed", endpoint: null, oldEndpoint: "e" });
  });
});
