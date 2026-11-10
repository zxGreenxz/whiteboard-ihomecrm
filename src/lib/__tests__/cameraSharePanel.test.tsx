// @vitest-environment jsdom
// Tab Camera → "Chia sẻ cho khách": tạo lượt chia sẻ (ID + mật khẩu hiện ĐÚNG một lần, sao chép tin nhắn), danh sách
// theo đầu ghi, thu hồi có xác nhận, và phân biệt lỗi quyền / luật nghiệp vụ / mạng. Mã và mật khẩu là chuỗi giả.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CameraSharePanel from "@/components/network-center/tabs/CameraSharePanel";
import { createDemoCameraRecorder } from "@/lib/network-center/cameraDemo";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), clipboard: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));

const scope = { actorId: "user-a", organizationId: "a0000000-0000-4000-8000-000000000001", buildingId: "b0000000-0000-4000-8000-000000000001" };
const recorder = createDemoCameraRecorder(scope);
const SHARE = "30000000-0000-4000-8000-000000000001";
// Dựng lúc chạy: chuỗi giống mật khẩu để nguyên văn trong file làm máy quét bí mật báo nhầm.
const PASSWORD = ["k7m2", "p9qx"].join("");
const row = (patch: Record<string, unknown> = {}) => ({
  id: SHARE, recorder_id: recorder.id, channel: 2, channel_name: null, window_start: "2026-11-09T17:00:00+00:00", window_end: "2026-11-10T05:30:15+00:00",
  code: "ABCD2345", note: "Chị Lan P302", created_by_name: "Người kiểm thử", created_at: "2026-11-10T05:31:00+00:00", expires_at: "2026-11-11T05:31:00+00:00",
  revoked_at: null, status: "ACTIVE", last_login_at: null, login_count: 0, ...patch,
});
let shares: unknown[] = [];
let client: QueryClient;
function Wrapper({ children }: PropsWithChildren) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
const show = () => render(<CameraSharePanel recorder={recorder} buildingName="Tòa mẫu" scope={scope} />, { wrapper: Wrapper });
const calls = (name: string) => mocks.rpc.mock.calls.filter(([called]) => called === name);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T05:30:15Z")); // 12:30:15 giờ Việt Nam
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  shares = [];
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (name: string) => name === "camera_shares_v1" ? { data: { shares }, error: null } : { data: null, error: { code: "XX000", message: "chưa giả lập" } });
  mocks.clipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.clipboard } });
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); });

describe("chia sẻ camera cho khách", () => {
  it("tạo lượt chia sẻ: gửi đúng khung giờ/kênh/hiệu lực, hiện ID + mật khẩu một lần, sao chép tin nhắn rồi tải lại danh sách", async () => {
    show();
    await screen.findByText("Chưa có lượt chia sẻ nào của đầu ghi này trong 30 ngày qua.");
    fireEvent.click(screen.getByRole("button", { name: "Chia sẻ camera" }));
    const dialog = await screen.findByRole("dialog");
    // Trình duyệt bỏ phần giây ":00" khi chuẩn hoá ô datetime-local; ô giờ hiểu cả hai dạng.
    expect((within(dialog).getByLabelText("Xem lại từ") as HTMLInputElement).value).toBe("2026-11-10T00:00");
    expect((within(dialog).getByLabelText("Đến") as HTMLInputElement).value).toMatch(/^2026-11-10T12:30:15(\.000)?$/u);
    expect(within(dialog).getByRole("radio", { name: "24 giờ" }).getAttribute("aria-checked")).toBe("true");
    const channel = within(dialog).getByLabelText("Kênh") as HTMLSelectElement;
    expect([...channel.options].map((option) => option.textContent)).toEqual(["Sảnh DEMO · kênh 1", "Hành lang DEMO · kênh 2", "Kênh 3", "Kênh 4"]);
    fireEvent.change(channel, { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "7 ngày" }));
    fireEvent.change(within(dialog).getByLabelText("Ghi chú (không bắt buộc)"), { target: { value: "  Chị Lan P302 " } });

    shares = [row()];
    mocks.rpc.mockImplementationOnce(async () => ({ data: {
      id: SHARE, code: "ABCD2345", password: PASSWORD, recorder_id: recorder.id, channel: 2, channel_name: "Hành lang DEMO",
      window_start: "2026-11-09T17:00:00+00:00", window_end: "2026-11-10T05:30:15+00:00", expires_at: "2026-11-17T05:30:16+00:00", note: "Chị Lan P302",
    }, error: null }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Tạo link chia sẻ" }));

    const result = await screen.findByRole("dialog", { name: "Đã tạo link chia sẻ camera" });
    expect(calls("camera_share_create_v1")).toEqual([["camera_share_create_v1", {
      p_recorder_id: recorder.id, p_channel: 2, p_window_start: "2026-11-09T17:00:00.000Z", p_window_end: "2026-11-10T05:30:15.000Z", p_expires_hours: 168, p_note: "Chị Lan P302",
    }]]);
    const link = `${window.location.origin}/xem-camera/ABCD2345`;
    expect(within(result).getByLabelText("Link xem").textContent).toBe(link);
    expect(within(result).getByLabelText("ID").textContent).toBe("ABCD2345");
    expect(within(result).getByLabelText("Mật khẩu").textContent).toBe(PASSWORD);
    expect(within(result).getByRole("note").textContent).toContain("Mật khẩu chỉ hiện một lần.");

    fireEvent.click(within(result).getByRole("button", { name: "Sao chép tin nhắn gửi khách" }));
    await within(result).findByText("Đã sao chép tin nhắn gửi khách.");
    const message = String(mocks.clipboard.mock.calls[0]?.[0]);
    for (const part of [link, "ID: ABCD2345", `Mật khẩu: ${PASSWORD}`, "Hành lang DEMO · kênh 2", "tại Tòa mẫu", "00:00:00 10/11/2026", "12:30:15 10/11/2026", "Link hết hạn lúc 12:30:16 17/11/2026"]) expect(message).toContain(part);
    fireEvent.click(within(result).getByRole("button", { name: "Sao chép mật khẩu" }));
    await waitFor(() => expect(mocks.clipboard).toHaveBeenLastCalledWith(PASSWORD));

    await waitFor(() => expect(calls("camera_shares_v1").length).toBeGreaterThanOrEqual(2));
    fireEvent.click(within(result).getByRole("button", { name: "Đã gửi cho khách" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const item = await screen.findByRole("listitem", { name: "Lượt chia sẻ ABCD2345" });
    expect(item.textContent).toContain("Đang hiệu lực");
    expect(item.textContent).toContain("Chị Lan P302");
    expect(item.textContent).toContain("Khách chưa vào xem");
    expect(document.body.textContent).not.toContain(PASSWORD);

    // Mở lại hộp tạo: không còn dấu vết mật khẩu cũ, form về mặc định.
    fireEvent.click(screen.getByRole("button", { name: "Chia sẻ camera" }));
    const again = await screen.findByRole("dialog");
    expect((within(again).getByLabelText("Ghi chú (không bắt buộc)") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it("chặn khung giờ sai ngay trên form và hiện nguyên văn luật nghiệp vụ của server", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Chia sẻ camera" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Xem lại từ"), { target: { value: "2026-11-10T13:00:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Tạo link chia sẻ" }));
    expect(await within(dialog).findByText("Giờ bắt đầu phải ở quá khứ.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Xem lại từ"), { target: { value: "2026-11-09T10:00:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Tạo link chia sẻ" }));
    expect(await within(dialog).findByText("Khung giờ xem lại tối đa 24 giờ.")).toBeTruthy();
    expect(calls("camera_share_create_v1")).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText("Xem lại từ"), { target: { value: "2026-11-10T08:00:00" } });
    mocks.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: "P0001", message: "Đầu ghi đang có quá nhiều lượt chia sẻ còn hiệu lực." } }));
    await waitFor(() => expect(within(dialog).queryByText("Khung giờ xem lại tối đa 24 giờ.")).toBeNull());
    fireEvent.click(within(dialog).getByRole("button", { name: "Tạo link chia sẻ" }));
    expect((await within(dialog).findByText("Đầu ghi đang có quá nhiều lượt chia sẻ còn hiệu lực.")).getAttribute("role")).toBe("alert");
    expect(screen.queryByRole("dialog", { name: "Đã tạo link chia sẻ camera" })).toBeNull();
  });

  it("thu hồi có xác nhận, chỉ cho lượt đang hiệu lực của đầu ghi này, rồi tải lại danh sách", async () => {
    shares = [
      row(),
      row({ id: "30000000-0000-4000-8000-000000000002", code: "WXYZ2345", status: "EXPIRED", note: null, login_count: 3, last_login_at: "2026-11-09T02:00:00+00:00" }),
      row({ id: "30000000-0000-4000-8000-000000000003", code: "QRST2345", recorder_id: "d0000000-0000-4000-8000-000000000099" }),
    ];
    show();
    const active = await screen.findByRole("listitem", { name: "Lượt chia sẻ ABCD2345" });
    const expired = screen.getByRole("listitem", { name: "Lượt chia sẻ WXYZ2345" });
    expect(screen.queryByRole("listitem", { name: "Lượt chia sẻ QRST2345" })).toBeNull();
    expect(expired.textContent).toContain("Hết hạn");
    expect(expired.textContent).toContain("Khách đã vào 3 lần · lần cuối 09:00:00 9/11/2026");
    expect(within(expired).queryByRole("button")).toBeNull();

    fireEvent.click(within(active).getByRole("button", { name: "Thu hồi lượt chia sẻ ABCD2345" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Không hoàn tác được");
    expect(calls("camera_share_revoke_v1")).toHaveLength(0);
    const before = calls("camera_shares_v1").length;
    shares = [row({ status: "REVOKED", revoked_at: "2026-11-10T05:35:00+00:00" })];
    mocks.rpc.mockImplementationOnce(async () => ({ data: { status: "REVOKED" }, error: null }));
    fireEvent.click(within(confirm).getByRole("button", { name: "Thu hồi ngay" }));
    await screen.findByText("Đã thu hồi lượt chia sẻ ABCD2345. Khách đang xem sẽ bị ngắt trong khoảng một phút.");
    expect(calls("camera_share_revoke_v1")).toEqual([["camera_share_revoke_v1", { p_share_id: SHARE }]]);
    await waitFor(() => expect(calls("camera_shares_v1").length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole("listitem", { name: "Lượt chia sẻ ABCD2345" }).textContent).toContain("Đã thu hồi"));
    expect(screen.queryByRole("button", { name: "Thu hồi lượt chia sẻ ABCD2345" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("lỗi quyền: không có nút tải lại và khoá nút tạo; lỗi mạng: cho tải lại danh sách", async () => {
    mocks.rpc.mockImplementation(async () => ({ data: null, error: { code: "42501", message: "permission denied" } }));
    const view = show();
    expect((await screen.findByRole("alert")).textContent).toContain("Bạn không có quyền chia sẻ camera của tòa nhà này.");
    expect(screen.queryByRole("button", { name: "Tải lại danh sách" })).toBeNull();
    expect(screen.getByRole("button", { name: "Chia sẻ camera" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/Chưa có lượt chia sẻ/)).toBeNull();
    view.unmount(); client.clear();

    mocks.rpc.mockImplementation(async () => ({ data: null, error: { code: "", message: "TypeError: Failed to fetch" } }));
    show();
    // Lỗi mạng được thử lại đúng một lần trước khi báo.
    expect((await screen.findByRole("alert", {}, { timeout: 4000 })).textContent).toContain("Không kết nối được máy chủ");
    shares = [];
    mocks.rpc.mockImplementation(async () => ({ data: { shares }, error: null }));
    fireEvent.click(screen.getByRole("button", { name: "Tải lại danh sách" }));
    await screen.findByText("Chưa có lượt chia sẻ nào của đầu ghi này trong 30 ngày qua.");
    expect(screen.getByRole("button", { name: "Chia sẻ camera" }).hasAttribute("disabled")).toBe(false);
  });
});
