// @vitest-environment jsdom
// Trang khách /xem-camera/<ID>: đăng nhập bằng ID + mật khẩu (sai / khoá / đã kết thúc / mất mạng), phiên giữ trong tab
// và khôi phục qua camera_share_authorize_v1, trình xem dùng phiên `cs_…` làm Bearer, cổng báo SHARE_ENDED ⇒ trang
// chuyển sang "đã kết thúc" và xoá phiên. Mã, mật khẩu, phiên đều là chuỗi giả.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraLiveOptions } from "@/lib/network-center/cameraLive";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), capabilities: vi.fn(), start: vi.fn(), stop: vi.fn(), seek: vi.fn(), connections: [] as CameraLiveOptions[],
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("@/lib/network-center/cameraLive", async (original) => ({
  ...await original<typeof import("@/lib/network-center/cameraLive")>(),
  cameraLiveCapabilities: mocks.capabilities,
  CameraLiveConnection: class { constructor(options: CameraLiveOptions) { mocks.connections.push(options); } start = mocks.start; stop = mocks.stop; seek = mocks.seek; },
}));

import CameraSharePage from "../CameraSharePage";

const CODE = "ABCD2345";
const KEY = `camera-share-session:${CODE}`;
// Dựng lúc chạy để máy quét bí mật không coi chuỗi giả là mật khẩu / token thật.
const PASSWORD = ["k7m2", "p9qx"].join("");
const SESSION = `cs_${"S".repeat(43)}`;
const RECORDER = "20000000-0000-4000-8000-000000000001";
const share = {
  share_id: "30000000-0000-4000-8000-000000000001", recorder_id: RECORDER, organization_id: "a0000000-0000-4000-8000-000000000001",
  building_id: "b0000000-0000-4000-8000-000000000001", channel: 3, channel_name: "Cổng chính", building_name: "Tòa mẫu",
  window_start: "2026-11-10T01:00:00+00:00", window_end: "2026-11-10T03:00:00+00:00", expires_at: "2026-11-11T05:00:00+00:00",
};
let client: QueryClient;
function Where() { const location = useLocation(); return <output data-testid="path">{location.pathname}</output>; }
const open = (path = `/xem-camera/${CODE}`) => render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/xem-camera/:code?" element={<><CameraSharePage /><Where /></>} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
const rpcCalls = (name: string) => mocks.rpc.mock.calls.filter(([called]) => called === name);
const submit = (password: string) => {
  fireEvent.change(screen.getByLabelText("Mật khẩu"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Xem camera" }));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T05:30:00Z"));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  sessionStorage.clear();
  mocks.rpc.mockReset().mockResolvedValue({ data: null, error: { code: "XX000", message: "chưa giả lập" } });
  mocks.capabilities.mockReset().mockResolvedValue({ channels: [3], maxView: 1, leaseSeconds: 75, archive: false, liveQualities: [], playback: true, playbackControl: true, playbackPreview: true, playbackSpeeds: [1, 2, 4], playbackQualities: ["sd", "hd"] });
  mocks.start.mockReset().mockResolvedValue(undefined); mocks.stop.mockReset().mockResolvedValue(undefined); mocks.seek.mockReset();
  mocks.connections.length = 0;
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); });

describe("trang khách xem lại camera", () => {
  it("đăng nhập: chuẩn hoá ID từ link, báo số lần còn, thời gian khoá, mất mạng; không gửi khi sai định dạng", async () => {
    open("/xem-camera/abcd-2345");
    expect((screen.getByLabelText("ID") as HTMLInputElement).value).toBe(CODE);
    submit("ngắn");
    expect((await screen.findByRole("alert")).textContent).toBe("Mật khẩu gồm 8 ký tự chữ thường và số.");
    expect(rpcCalls("camera_share_login_v1")).toHaveLength(0);

    mocks.rpc.mockResolvedValueOnce({ data: { status: "INVALID", attempts_left: 3 }, error: null });
    submit(` ${PASSWORD.toUpperCase()} `);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("ID hoặc mật khẩu không đúng — còn 3 lần thử."));
    expect(rpcCalls("camera_share_login_v1")[0]).toEqual(["camera_share_login_v1", { p_code: CODE, p_password: PASSWORD }]);
    expect((screen.getByLabelText("Mật khẩu") as HTMLInputElement).value).toBe("");

    mocks.rpc.mockResolvedValueOnce({ data: { status: "LOCKED", retry_after_seconds: 130 }, error: null });
    submit(PASSWORD);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Nhập sai nhiều lần — thử lại sau khoảng 3 phút."));

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "", message: "TypeError: Failed to fetch" } });
    submit(PASSWORD);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Không kết nối được máy chủ/u));
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(mocks.connections).toHaveLength(0);
  });

  it("lượt chia sẻ đã kết thúc khi đăng nhập ⇒ màn đã kết thúc, quay lại được ô nhập", async () => {
    open();
    mocks.rpc.mockResolvedValueOnce({ data: { status: "ENDED" }, error: null });
    submit(PASSWORD);
    expect((await screen.findByTestId("camera-share-ended")).textContent).toContain("đã hết hạn hoặc đã bị thu hồi");
    fireEvent.click(screen.getByRole("button", { name: "Nhập ID khác" }));
    // Nút nói "ID khác": ID đã kết thúc phải rời khỏi đường dẫn và ô ID trống, sẵn con trỏ.
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/xem-camera"));
    expect(screen.getByTestId("camera-share-login")).toBeTruthy();
    expect((screen.getByLabelText("ID") as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(screen.getByLabelText("ID"));
  });

  it("đăng nhập đúng: nhớ phiên trong tab, mở trình xem với đúng kênh, khung giờ, SD và phiên chia sẻ làm Bearer", async () => {
    open();
    mocks.rpc.mockResolvedValueOnce({ data: { status: "OK", session: SESSION, share }, error: null });
    submit(PASSWORD);
    expect((await screen.findByTestId("camera-share-title")).textContent).toBe("Cổng chính · kênh 3");
    expect(sessionStorage.getItem(KEY)).toBe(SESSION);
    expect(screen.getByText("Tòa mẫu")).toBeTruthy();
    expect(screen.getByLabelText("Phạm vi được xem").textContent).toContain("08:00:00 10/11/2026 → 10:00:00 10/11/2026");
    await waitFor(() => expect(mocks.capabilities).toHaveBeenCalledWith(RECORDER, expect.any(AbortSignal), SESSION));
    // Đã có phiên từ lúc đăng nhập — không hỏi lại server.
    expect(rpcCalls("camera_share_authorize_v1")).toHaveLength(0);

    fireEvent.click(await screen.findByRole("button", { name: "Xem" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    expect(mocks.connections[0]).toMatchObject({
      recorderId: RECORDER, channel: 3, accessToken: SESSION,
      playback: { start: "2026-11-10T01:00:00.000Z", end: "2026-11-10T03:00:00.000Z", quality: "sd" },
    });
    expect(mocks.connections[0]?.playback).not.toHaveProperty("position");
    expect(screen.queryByRole("button", { name: /Tải|Xuất/u })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "HD" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(2));
    expect(mocks.connections[1]?.playback?.quality).toBe("hd");
    expect(screen.getByRole("radiogroup", { name: "Tốc độ xem lại" }).textContent).toBe("1×2×4×");
  });

  it("không có ID trên link: khách tự nhập, đăng nhập xong đường dẫn mang ID để tải lại vẫn khôi phục được", async () => {
    open("/xem-camera");
    fireEvent.change(screen.getByLabelText("ID"), { target: { value: "abcd 2345" } });
    mocks.rpc.mockResolvedValueOnce({ data: { status: "OK", session: SESSION, share }, error: null });
    submit(PASSWORD);
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe(`/xem-camera/${CODE}`));
    expect(await screen.findByTestId("camera-share-title")).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBe(SESSION);
  });

  it("khôi phục phiên đã lưu qua authorize; server trả NULL ⇒ xoá phiên, hỏi lại mật khẩu", async () => {
    sessionStorage.setItem(KEY, SESSION);
    mocks.rpc.mockImplementation(async (name: string) => name === "camera_share_authorize_v1" ? { data: share, error: null } : { data: null, error: { code: "XX000", message: "?" } });
    open();
    await waitFor(() => expect(screen.getByTestId("camera-share-title").textContent).toBe("Cổng chính · kênh 3"));
    expect(rpcCalls("camera_share_authorize_v1")).toEqual([["camera_share_authorize_v1", { p_token: SESSION }]]);
    expect(screen.queryByTestId("camera-share-login")).toBeNull();
    cleanup(); client.clear();

    mocks.rpc.mockImplementation(async () => ({ data: null, error: null }));
    open();
    expect(await screen.findByTestId("camera-share-login")).toBeTruthy();
    expect(screen.getByText(/Phiên xem đã kết thúc/u).getAttribute("role")).toBe("status");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("cổng video báo SHARE_ENDED khi đang xem ⇒ màn đã kết thúc và xoá phiên", async () => {
    sessionStorage.setItem(KEY, SESSION);
    mocks.rpc.mockResolvedValue({ data: share, error: null });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Xem" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(1));
    act(() => { mocks.connections[0]?.onErrorCode?.("SHARE_ENDED"); mocks.connections[0]?.onState("error", "Lượt chia sẻ đã hết hạn hoặc đã bị thu hồi."); });
    expect(await screen.findByTestId("camera-share-ended")).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    await waitFor(() => expect(mocks.stop).toHaveBeenCalled());
  });

  it("máy khác mở cùng lượt chia sẻ (phiên bị đóng) ⇒ báo rõ, bấm Thử lại mở phiên mới tại mốc đang xem", async () => {
    sessionStorage.setItem(KEY, SESSION);
    mocks.rpc.mockResolvedValue({ data: share, error: null });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Xem" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(1));
    act(() => { mocks.connections[0]?.onErrorCode?.("SESSION_NOT_FOUND"); mocks.connections[0]?.onState("error", "Không thể kết nối video. Vui lòng thử lại."); });
    expect((await screen.findByRole("alert")).textContent).toContain("đang được mở ở máy hoặc tab khác");
    // Trang hỏi lại máy chủ để phân biệt với hết hạn; máy chủ nói còn hạn ⇒ giữ phiên và câu báo này.
    await waitFor(() => expect(rpcCalls("camera_share_authorize_v1")).toHaveLength(2));
    expect(screen.queryByTestId("camera-share-ended")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe(SESSION);
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(2));
    expect(mocks.connections[1]).toMatchObject({ accessToken: SESSION, playback: { start: "2026-11-10T01:00:00.000Z", quality: "sd" } });
  });

  it("lượt chia sẻ hết hạn giữa lúc đang xem (cổng đóng phiên, gia hạn nhận SESSION_NOT_FOUND) ⇒ hỏi lại máy chủ rồi ra màn đã kết thúc", async () => {
    sessionStorage.setItem(KEY, SESSION);
    mocks.rpc.mockResolvedValue({ data: share, error: null });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Xem" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(1));
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    act(() => { mocks.connections[0]?.onErrorCode?.("SESSION_NOT_FOUND"); mocks.connections[0]?.onState("error", "Không thể kết nối video. Vui lòng thử lại."); });
    expect(await screen.findByTestId("camera-share-ended")).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("tốc độ khác 1×: mở luồng ở 1× rồi mới xin tốc độ bằng lệnh tua, kể cả khi đổi SD sang HD (cổng không mở được luồng mới thẳng ở tốc độ cao)", async () => {
    sessionStorage.setItem(KEY, SESSION);
    mocks.rpc.mockResolvedValue({ data: share, error: null });
    mocks.seek.mockImplementation(async (time: number, speed: number) => ({ time: new Date(time).toISOString(), speed, expiresAt: Date.now() + 75_000 }));
    open();
    fireEvent.click(await screen.findByRole("radio", { name: "4×" }));
    fireEvent.click(screen.getByRole("button", { name: "Xem" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(1));
    expect(mocks.connections[0]?.playback).toMatchObject({ start: "2026-11-10T01:00:00.000Z", quality: "sd" });
    expect(mocks.connections[0]?.playback).not.toHaveProperty("speed");
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(Date.parse("2026-11-10T01:00:00Z"), 4));
    // Đổi chất lượng lúc đang 4× (đúng thao tác gây lỗi trên điện thoại): luồng HD mới cũng mở ở 1× rồi mới lên 4×.
    fireEvent.click(screen.getByRole("radio", { name: "HD" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(2));
    expect(mocks.connections[1]?.playback).toMatchObject({ quality: "hd" });
    expect(mocks.connections[1]?.playback).not.toHaveProperty("speed");
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledTimes(2));
    expect(mocks.seek.mock.calls[1]?.[1]).toBe(4);
  });

  it("đầu ghi không tua được trên luồng đang chạy (Hikvision): mở thẳng ở tốc độ đã chọn, tua và đổi tốc độ là mở luồng mới, lỗi thì chờ khách bấm Thử lại", async () => {
    sessionStorage.setItem(KEY, SESSION);
    mocks.rpc.mockResolvedValue({ data: share, error: null });
    mocks.capabilities.mockResolvedValue({ channels: [3], maxView: 1, leaseSeconds: 75, archive: false, liveQualities: [], playback: true, playbackControl: false, playbackPreview: false, playbackSpeeds: [1, 2, 4], playbackQualities: ["sd", "hd"] });
    open();
    fireEvent.click(await screen.findByRole("radio", { name: "4×" }));
    fireEvent.click(screen.getByRole("button", { name: "Xem" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(1));
    // Không có lệnh tua để xin tốc độ sau khi mở, nên luồng mở thẳng ở 4×.
    expect(mocks.connections[0]?.playback).toMatchObject({ start: "2026-11-10T01:00:00.000Z", end: "2026-11-10T03:00:00.000Z", quality: "sd", speed: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Tới 10 giây" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(2));
    expect(mocks.connections[1]?.playback).toMatchObject({ start: "2026-11-10T01:00:10.000Z", end: "2026-11-10T03:00:00.000Z", quality: "sd", speed: 4 });
    fireEvent.click(screen.getByRole("radio", { name: "2×" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(3));
    expect(mocks.connections[2]?.playback).toMatchObject({ start: "2026-11-10T01:00:10.000Z", quality: "sd", speed: 2 });
    fireEvent.click(screen.getByRole("radio", { name: "HD" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(4));
    expect(mocks.connections[3]?.playback).toMatchObject({ start: "2026-11-10T01:00:10.000Z", quality: "hd", speed: 2 });
    for (const connection of mocks.connections) expect(connection.playback).not.toHaveProperty("position");
    // Luồng mới không lên hình: báo lỗi rồi dừng, không tự mở lại mãi.
    act(() => { mocks.connections[3]?.onErrorCode?.("CAMERA_UNAVAILABLE"); mocks.connections[3]?.onState("error", "Chưa nhận được video từ đầu ghi. Vui lòng thử lại."); });
    expect((await screen.findByRole("alert")).textContent).toBe("Chưa nhận được video từ đầu ghi. Vui lòng thử lại.");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(mocks.connections).toHaveLength(4);
    // Khách hạ về 1× là xem tiếp được ngay tại mốc đó.
    fireEvent.click(screen.getByRole("radio", { name: "1×" }));
    await waitFor(() => expect(mocks.connections).toHaveLength(5));
    expect(mocks.connections[4]?.playback).toMatchObject({ start: "2026-11-10T01:00:10.000Z", quality: "hd" });
    expect(mocks.connections[4]?.playback).not.toHaveProperty("speed");
    expect(mocks.seek).not.toHaveBeenCalled();
  });

  it("cổng video từ chối ngay khi kiểm tra dịch vụ (SHARE_ENDED) ⇒ màn đã kết thúc", async () => {
    sessionStorage.setItem(KEY, SESSION);
    mocks.rpc.mockResolvedValue({ data: share, error: null });
    const { CameraLiveError } = await import("@/lib/network-center/cameraLive");
    mocks.capabilities.mockRejectedValue(new CameraLiveError("SHARE_ENDED"));
    open();
    expect(await screen.findByTestId("camera-share-ended")).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("Thoát: huỷ phiên ở server, xoá phiên trong tab, về ô đăng nhập", async () => {
    sessionStorage.setItem(KEY, SESSION);
    mocks.rpc.mockImplementation(async (name: string) => name === "camera_share_authorize_v1" ? { data: share, error: null } : { data: { status: "OK" }, error: null });
    open();
    await screen.findByTestId("camera-share-title");
    fireEvent.click(screen.getByRole("button", { name: /Thoát/u }));
    expect(screen.getByTestId("camera-share-login")).toBeTruthy();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    await waitFor(() => expect(rpcCalls("camera_share_logout_v1")).toEqual([["camera_share_logout_v1", { p_token: SESSION }]]));
  });
});
