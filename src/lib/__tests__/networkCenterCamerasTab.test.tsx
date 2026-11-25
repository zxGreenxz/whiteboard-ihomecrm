// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CamerasTab } from "@/components/network-center/tabs/CamerasTab";
import { cameraQueryKey, useBuildingCameras, type BuildingCameraScope } from "@/hooks/network-center/useBuildingCameras";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type {
  CameraBuildingMutes, CameraChannelMute, CameraChannelMuteInput, CameraEventPage, CameraIncident, CameraIncidentAcknowledgement,
  CameraIncidentList, CameraRecorder, CameraScope,
} from "@/lib/network-center/cameraContracts";
import { createDemoCameraRecorder, demoCameraRepository } from "@/lib/network-center/cameraDemo";
import { DemoNetworkCenterRepository } from "@/lib/network-center/demoRepository";
import { NetworkCenterRepositoryError } from "@/lib/network-center/supabaseRepository";

const mocks = vi.hoisted(() => ({
  liveStart: vi.fn(async () => {}), liveStop: vi.fn(async () => {}),
  getBuilding: vi.fn<(scope: CameraScope) => Promise<{ recorders: CameraRecorder[] }>>(),
  listEvents: vi.fn<() => Promise<CameraEventPage>>(),
}));
const alertMocks = vi.hoisted(() => ({
  listIncidents: vi.fn<(scope: CameraScope) => Promise<CameraIncidentList>>(),
  listBuildingMutes: vi.fn<(scope: CameraScope) => Promise<CameraBuildingMutes>>(),
  setChannelMute: vi.fn<(input: CameraChannelMuteInput) => Promise<CameraChannelMute>>(),
  clearChannelMute: vi.fn<(recorderId: string, channel: number) => Promise<{ recorderId: string; channel: number; cleared: boolean }>>(),
  acknowledgeIncident: vi.fn<(incidentId: string) => Promise<CameraIncidentAcknowledgement>>(),
}));
vi.mock("@/lib/network-center/cameraRepository", () => ({ supabaseCameraRepository: mocks, supabaseCameraAlertRepository: alertMocks }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn() } }));
vi.mock("@/lib/network-center/cameraLive", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/network-center/cameraLive")>(),
  cameraLiveCapabilities: vi.fn(async () => ({ channels: [1, 2, 3, 4], maxView: 4, leaseSeconds: 75, archive: true, liveQualities: ["sd", "hd"] })),
  prepareCameraLiveView: vi.fn(async () => "50000000-0000-4000-8000-000000000001"),
  CameraLiveConnection: class { start = mocks.liveStart; stop = mocks.liveStop; },
}));
const scope: BuildingCameraScope = {
  organizationId: "a0000000-0000-4000-8000-000000000001",
  buildingId: "b0000000-0000-4000-8000-000000000001",
  actorId: "user-a", canView: true, mode: "production",
};
const site = new DemoNetworkCenterRepository([{ id: scope.buildingId, name: "Tòa kiểm thử", organizationId: scope.organizationId }]).getBuilding(scope.buildingId)!;
const controller = {
  actor: { id: scope.actorId, label: "Người kiểm thử" },
  canView: true, mode: "production" as const, isDemo: false,
  physicalBuildings: [{ id: scope.buildingId, organizationId: scope.organizationId, name: site.buildingName }],
};
let client: QueryClient;
function Wrapper({ children }: PropsWithChildren) { return <MemoryRouter><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>; }
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  mocks.getBuilding.mockImplementation(async (target) => ({ recorders: [createDemoCameraRecorder(target)] }));
  mocks.listEvents.mockResolvedValue({ items: [], hasMore: false });
  alertMocks.listIncidents.mockResolvedValue({ items: [] });
  alertMocks.listBuildingMutes.mockResolvedValue({ canEdit: false, items: [] });
  vi.stubGlobal("PointerEvent", MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
const recorderId = "d0000000-0000-4000-8000-000000000001";
const ownerId = "e0000000-0000-4000-8000-0000000000aa";
function incident(overrides: Partial<CameraIncident> = {}): CameraIncident {
  return {
    id: "e0000000-0000-4000-8000-000000000001", organization_id: scope.organizationId, building_id: scope.buildingId,
    incident_type: "CAMERA_STORAGE_ERROR", severity: "CRITICAL", status: "OPEN",
    title: "Ổ cứng đầu ghi Đầu ghi DEMO báo lỗi", summary: "Ổ 1 báo lỗi", opened_at: "2026-01-01T08:12:00Z",
    acknowledged_at: null, recorder_id: recorderId, subject: "storage:1", ...overrides,
  };
}
function withDisk(state: "NORMAL" | "ERROR", checkedAt = Date.now()): CameraRecorder {
  const recorder = createDemoCameraRecorder(scope, checkedAt);
  return { ...recorder, snapshot: { ...recorder.snapshot!, storage: [{ slot: 1, state, totalBytes: 1_000, usedBytes: 10 }, { slot: 2, state: "NORMAL" }] } };
}
function muteRow(overrides: Partial<CameraBuildingMutes["items"][number]> = {}): CameraBuildingMutes["items"][number] {
  return {
    recorderId, channel: 2, kind: "KNOWN_BROKEN", untilAt: null, note: "Chờ thay dây", setBy: ownerId,
    setAt: "2026-11-20T03:00:00Z", organizationId: scope.organizationId, buildingId: scope.buildingId, setByName: "Chủ DEMO", ...overrides,
  };
}
const executeAt = (buildingIds: string[]) => ({
  data: { network_center: { view: true, execute: { org_wide: false, building_ids: buildingIds } } },
} as unknown as NetworkCenterController["permissionsQuery"]);
const channelCard = (label: string) => screen.getByRole("article", { name: `Đầu ghi DEMO · ${label}` });
const openChannelMenu = async (label: string) => {
  const trigger = await screen.findByRole("button", { name: `Tuỳ chọn báo cho ${label}` });
  fireEvent.click(trigger);
  return screen.findByRole("group", { name: `Cách báo cho ${label}` });
};
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("camera tab", () => {
  it("refreshes active video as well as metadata while preserving the archive form", async () => {
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    const from = await screen.findByLabelText<HTMLInputElement>("Từ ngày giờ", {}, { timeout: 5000 });
    fireEvent.change(from, { target: { value: "2026-10-24T13:20:05" } });
    const selectedTime = from.value;
    fireEvent.click(screen.getByRole("button", { name: "Xem trực tiếp" }));
    await waitFor(() => expect(mocks.liveStart).toHaveBeenCalledTimes(4));
    fireEvent.click(screen.getByRole("button", { name: "Làm mới camera" }));
    await waitFor(() => expect(mocks.liveStart).toHaveBeenCalledTimes(8));
    expect(mocks.liveStop).toHaveBeenCalledTimes(4);
    expect(screen.getByLabelText("Từ ngày giờ")).toBe(from);
    expect(from.value).toBe(selectedTime);
    expect(mocks.getBuilding.mock.calls.length).toBeGreaterThan(1);
  });
  it("renders each measured channel state, storage, history coverage and no fake player", async () => {
    const { container } = render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByText("Đầu ghi kết nối");
    expect(screen.getByText("Có kết nối")).toBeTruthy();
    expect(screen.getByText("Sảnh DEMO", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("Hành lang DEMO", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("Mất kết nối")).toBeTruthy();
    expect(screen.getByText("Kênh chưa gắn camera")).toBeTruthy();
    expect(screen.getByText("Chưa xác định")).toBeTruthy();
    expect(screen.getByText("Bình thường")).toBeTruthy();
    expect(screen.getByText("Theo lần kiểm tra")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Xem trực tiếp" }, { timeout: 5000 })).toBeTruthy();
    expect(container.querySelector("video,iframe")).toBeNull();
  });

  it("marks old channel observations as historical when a recorder is stale", async () => {
    mocks.getBuilding.mockResolvedValue({ recorders: [createDemoCameraRecorder(scope, Date.now() - 300_000)] });
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByText("Dữ liệu đã cũ");
    expect(screen.getByText(/Chưa thể kết luận trạng thái camera hiện tại/)).toBeTruthy();
    expect(screen.getByText("Có kết nối").className).toContain("nc-status-neutral");
  });

  it("separates initial loading, a real empty result, and unavailable service", async () => {
    let resolve!: (value: { recorders: CameraRecorder[] }) => void;
    mocks.getBuilding.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    expect(screen.queryByText("Chưa cấu hình đầu ghi")).toBeNull();
    await act(async () => resolve({ recorders: [] }));
    await screen.findByText("Chưa cấu hình đầu ghi");
    await waitFor(() => expect(screen.getByRole("button", { name: "Làm mới camera" }).hasAttribute("disabled")).toBe(false));
    mocks.getBuilding.mockRejectedValue(new NetworkCenterRepositoryError("Dịch vụ theo dõi camera chưa được triển khai.", { code: "PGRST202" }));
    fireEvent.click(screen.getByRole("button", { name: "Làm mới camera" }));
    await screen.findByText("Dịch vụ theo dõi camera chưa được triển khai.");
    expect(screen.queryByText("Chưa cấu hình đầu ghi")).toBeNull();
  });

  it("blocks requests without view access and hides cached data after server denial", async () => {
    const view = render(<CamerasTab site={site} controller={{ ...controller, canView: false }} />, { wrapper: Wrapper });
    expect(screen.getByRole("alert").textContent).toContain("không có quyền");
    expect(mocks.getBuilding).not.toHaveBeenCalled();
    view.rerender(<CamerasTab site={site} controller={controller} />);
    await screen.findByText("Đầu ghi kết nối");
    await waitFor(() => expect(screen.getByRole("button", { name: "Làm mới camera" }).hasAttribute("disabled")).toBe(false));
    mocks.getBuilding.mockRejectedValue(new NetworkCenterRepositoryError("Bạn không có quyền xem camera của tòa nhà này.", { code: "42501" }));
    fireEvent.click(screen.getByRole("button", { name: "Làm mới camera" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("không có quyền"));
    expect(screen.queryByText("Đầu ghi kết nối")).toBeNull();
  });

  it.each([undefined, "", "57014", "PGRST003"])("preserves the open archive form after a temporary refresh failure (%s), then recovers in place", async (code) => {
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    const from = await screen.findByLabelText<HTMLInputElement>("Từ ngày giờ");
    fireEvent.change(from, { target: { value: "2026-10-24T13:20:05" } });
    const selectedTime = from.value;
    await waitFor(() => expect(screen.getByRole("button", { name: "Làm mới camera" }).hasAttribute("disabled")).toBe(false));
    mocks.getBuilding.mockRejectedValue(new NetworkCenterRepositoryError("Mất kết nối tạm thời", { code }));
    fireEvent.click(screen.getByRole("button", { name: "Làm mới camera" }));
    await screen.findByText("Mất kết nối tạm thời");
    expect(screen.getByLabelText("Từ ngày giờ")).toBe(from);
    expect(from.value).toBe(selectedTime);
    mocks.getBuilding.mockResolvedValue({ recorders: [createDemoCameraRecorder(scope)] });
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(screen.queryByText("Mất kết nối tạm thời")).toBeNull());
    expect(screen.getByLabelText("Từ ngày giờ")).toBe(from);
    expect(from.value).toBe(selectedTime);
  });

  it.each(["42501", "PGRST301", "PGRST302", "CAMERA_SCOPE_MISMATCH", "CAMERA_INVALID_DATA"])("removes the archive form after an authoritative access or data error (%s)", async (code) => {
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByLabelText("Từ ngày giờ");
    await waitFor(() => expect(screen.getByRole("button", { name: "Làm mới camera" }).hasAttribute("disabled")).toBe(false));
    mocks.getBuilding.mockRejectedValue(new NetworkCenterRepositoryError("Không thể xác minh quyền hoặc phạm vi camera", { code }));
    fireEvent.click(screen.getByRole("button", { name: "Làm mới camera" }));
    await screen.findByText("Không thể xác minh quyền hoặc phạm vi camera");
    expect(screen.queryByLabelText("Từ ngày giờ")).toBeNull();
    expect(screen.queryByText("Đầu ghi kết nối")).toBeNull();
  });

  it("does not show an archive form when the initial snapshot failed", async () => {
    mocks.getBuilding.mockRejectedValue(new NetworkCenterRepositoryError("Mất kết nối tạm thời"));
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByText("Mất kết nối tạm thời");
    expect(screen.queryByLabelText("Từ ngày giờ")).toBeNull();
    expect(screen.queryByText("Chưa cấu hình đầu ghi")).toBeNull();
  });

  it.each(["42501", "CAMERA_SCOPE_MISMATCH"])("keeps a rejected snapshot locked through later failures and remounts until a fresh success (%s)", async (code) => {
    const key = [...cameraQueryKey(scope), "snapshot"];
    const view = render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByLabelText("Từ ngày giờ");
    mocks.getBuilding.mockRejectedValue(new NetworkCenterRepositoryError("Phạm vi camera đã bị từ chối", { code }));
    await act(async () => { await client.refetchQueries({ queryKey: key, exact: true }); });
    await screen.findByText("Phạm vi camera đã bị từ chối");
    expect(screen.queryByLabelText("Từ ngày giờ")).toBeNull();
    view.unmount();
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    let reject!: (error: Error) => void;
    mocks.getBuilding.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    let retry!: Promise<void>;
    await act(async () => { retry = client.refetchQueries({ queryKey: key, exact: true }); });
    expect(screen.queryByLabelText("Từ ngày giờ")).toBeNull();
    await act(async () => { reject(new NetworkCenterRepositoryError("Mất mạng")); await retry; });
    expect(screen.queryByLabelText("Từ ngày giờ")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Phạm vi camera đã bị từ chối");
    mocks.getBuilding.mockResolvedValue({ recorders: [createDemoCameraRecorder(scope)] });
    await act(async () => { await client.refetchQueries({ queryKey: key, exact: true }); });
    expect(await screen.findByLabelText("Từ ngày giờ")).toBeTruthy();
  });

  it.each([false, true])("keeps an event denial locked while retrying and after a network failure (initial denial: %s)", async (initialDenial) => {
    const key = [...cameraQueryKey(scope), "events"];
    const denial = new NetworkCenterRepositoryError("Quyền camera đã bị từ chối", { code: "42501" });
    if (initialDenial) mocks.listEvents.mockRejectedValue(denial);
    const view = render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    if (!initialDenial) {
      await screen.findByLabelText("Từ ngày giờ");
      await waitFor(() => expect(client.getQueryState(key)?.status).toBe("success"));
      mocks.listEvents.mockRejectedValue(denial);
      await act(async () => { await client.refetchQueries({ queryKey: key, exact: true }); });
    }
    await screen.findByText("Quyền camera đã bị từ chối");
    view.unmount();
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    let reject!: (error: Error) => void;
    mocks.listEvents.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    let retry!: Promise<void>;
    await act(async () => { retry = client.refetchQueries({ queryKey: key, exact: true }); });
    expect(screen.queryByLabelText("Từ ngày giờ")).toBeNull();
    await act(async () => { reject(new NetworkCenterRepositoryError("Mất mạng")); await retry; });
    expect(screen.queryByLabelText("Từ ngày giờ")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Quyền camera đã bị từ chối");
    mocks.listEvents.mockResolvedValue({ items: [], hasMore: false });
    await act(async () => { await client.refetchQueries({ queryKey: key, exact: true }); });
    expect(await screen.findByLabelText("Từ ngày giờ")).toBeTruthy();
  });

  it("does not let a cancelled request clear a later permission denial", async () => {
    const key = [...cameraQueryKey(scope), "snapshot"];
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByLabelText("Từ ngày giờ");
    let resolveOld!: (data: { recorders: CameraRecorder[] }) => void;
    mocks.getBuilding.mockImplementationOnce(() => new Promise((done) => { resolveOld = done; }));
    let oldRequest!: Promise<void>;
    await act(async () => { oldRequest = client.refetchQueries({ queryKey: key, exact: true }); });
    await act(async () => { await client.cancelQueries({ queryKey: key, exact: true }); });
    mocks.getBuilding.mockRejectedValue(new NetworkCenterRepositoryError("Quyền đã bị thu hồi", { code: "42501" }));
    await act(async () => { await client.refetchQueries({ queryKey: key, exact: true }); });
    await screen.findByText("Quyền đã bị thu hồi");
    await act(async () => { resolveOld({ recorders: [createDemoCameraRecorder(scope)] }); await oldRequest; });
    mocks.getBuilding.mockRejectedValue(new NetworkCenterRepositoryError("Mất mạng"));
    await act(async () => { await client.refetchQueries({ queryKey: key, exact: true }); });
    expect(screen.queryByLabelText("Từ ngày giờ")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Quyền đã bị thu hồi");
  });

  it.each(["42501", "PGRST301", "PGRST302"])("clears cached camera UI when event access or the session is denied (%s)", async (code) => {
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByLabelText("Từ ngày giờ");
    await waitFor(() => expect(screen.getByRole("button", { name: "Làm mới camera" }).hasAttribute("disabled")).toBe(false));
    mocks.listEvents.mockRejectedValue(new NetworkCenterRepositoryError("Phiên hoặc quyền camera không còn hợp lệ", { code }));
    fireEvent.click(screen.getByRole("button", { name: "Làm mới camera" }));
    await screen.findByText("Phiên hoặc quyền camera không còn hợp lệ");
    expect(screen.queryByLabelText("Từ ngày giờ")).toBeNull();
    expect(screen.queryByText("Đầu ghi kết nối")).toBeNull();
  });

  it("loads older events with the last row cursor and keeps a page error visible", async () => {
    const first = await demoCameraRepository.listEvents(scope);
    const second = { ...first.items[0], id: "d0000000-0000-4000-8000-000000000003", observed_at: "2025-12-31T23:00:00Z", state: "CONNECTED" };
    mocks.listEvents.mockResolvedValueOnce({ ...first, hasMore: true }).mockResolvedValueOnce({ items: [second], hasMore: false });
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Xem sự kiện cũ hơn" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Xem sự kiện cũ hơn" })).toBeNull());
    expect(mocks.listEvents).toHaveBeenLastCalledWith(expect.objectContaining({ buildingId: scope.buildingId }), { observedAt: first.items[0].observed_at, id: first.items[0].id });
    expect(screen.getAllByRole("row")).toHaveLength(3);
    mocks.listEvents.mockRejectedValue(new NetworkCenterRepositoryError("Không thể tải dữ liệu camera. Vui lòng thử lại."));
    fireEvent.click(screen.getByRole("button", { name: "Làm mới camera" }));
    await screen.findByText("Không thể tải dữ liệu camera. Vui lòng thử lại.");
    expect(screen.queryByText("Chưa nhận được sự kiện camera.")).toBeNull();
  });
});

describe("camera tab — cảnh báo v2", () => {
  it("raises a red storage banner on an ONLINE recorder whose disk failed (B1), not only a badge", async () => {
    mocks.getBuilding.mockResolvedValue({ recorders: [withDisk("ERROR")] });
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByText("Đầu ghi kết nối");
    const banner = screen.getByText(/^Ổ cứng 1 báo lỗi/).closest('[role="alert"]');
    expect(banner?.textContent).toBe("Ổ cứng 1 báo lỗi — đầu ghi có thể không lưu được video. Cần kiểm tra hoặc thay ổ.");
    expect(screen.getByText("Có lỗi").className).toContain("nc-status-bad");
  });

  it("does not claim a disk failure from a stale snapshot or a healthy disk", async () => {
    mocks.getBuilding.mockResolvedValue({ recorders: [withDisk("ERROR", Date.now() - 300_000)] });
    const view = render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByText("Dữ liệu đã cũ");
    expect(screen.queryByText(/đầu ghi có thể không lưu được video/)).toBeNull();
    view.unmount(); client.clear();
    mocks.getBuilding.mockResolvedValue({ recorders: [withDisk("NORMAL")] });
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByText("Đầu ghi kết nối");
    expect(screen.queryByText(/đầu ghi có thể không lưu được video/)).toBeNull();
  });

  it("lists open incidents under their recorder, keeps unattached ones visible and hides actions from a viewer", async () => {
    alertMocks.listIncidents.mockResolvedValue({ items: [
      incident(),
      incident({ id: "e0000000-0000-4000-8000-000000000002", incident_type: "CAMERA_CHANNEL_LOST", severity: "WARNING", status: "RECOVERING",
        title: "Camera Hành lang DEMO của đầu ghi Đầu ghi DEMO mất hình", subject: "channel:2" }),
      incident({ id: "e0000000-0000-4000-8000-000000000003", recorder_id: null, title: "Mất dữ liệu giám sát đầu ghi đã gỡ", subject: "monitor" }),
    ] });
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    const recorderStrip = await screen.findByRole("region", { name: "Sự cố đang mở" });
    expect(recorderStrip.textContent).toContain("Sự cố đang mở (2)");
    expect(recorderStrip.textContent).toContain("Ổ cứng đầu ghi Đầu ghi DEMO báo lỗi");
    expect(recorderStrip.textContent).toContain("Đang hồi phục");
    expect(recorderStrip.querySelector(".nc-status-bad")?.textContent).toBe("Nghiêm trọng");
    const buildingStrip = screen.getByRole("region", { name: "Sự cố camera đang mở của tòa nhà" });
    expect(buildingStrip.textContent).toContain("Mất dữ liệu giám sát đầu ghi đã gỡ");
    expect(alertMocks.listIncidents).toHaveBeenCalledWith(expect.objectContaining({ buildingId: scope.buildingId }));
    // Người chỉ xem: không có "Đã biết", không có menu báo kênh; không lộ mã loại sự cố.
    expect(screen.queryByRole("button", { name: /^Đã biết:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Tuỳ chọn báo cho/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/CAMERA_|PT409/);
  });

  it("shows an incident read failure in place without hiding measured camera state", async () => {
    alertMocks.listIncidents.mockRejectedValue(new NetworkCenterRepositoryError("Bộ cảnh báo camera chưa được triển khai trên hệ thống này.", { code: "PGRST202" }));
    alertMocks.listBuildingMutes.mockRejectedValue(new NetworkCenterRepositoryError("Bộ cảnh báo camera chưa được triển khai trên hệ thống này.", { code: "PGRST202" }));
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    const note = await screen.findByText(/Chưa đọc được sự cố hoặc cách báo của kênh/);
    // Hai lỗi cùng câu chỉ hiện một lần.
    expect(note.textContent?.match(/chưa được triển khai/g)).toHaveLength(1);
    expect(screen.getByText("Đầu ghi kết nối")).toBeTruthy();
    expect(screen.getByText("Có kết nối")).toBeTruthy();
  });

  it("locks the tab when the incident read is denied", async () => {
    alertMocks.listIncidents.mockRejectedValue(new NetworkCenterRepositoryError("Bạn không có quyền xem camera của tòa nhà này.", { code: "42501" }));
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("không có quyền"));
    expect(screen.queryByText("Đầu ghi kết nối")).toBeNull();
  });

  it("shows the mute badge with who set it and when, for viewers too", async () => {
    alertMocks.listBuildingMutes.mockResolvedValue({ canEdit: false, items: [
      muteRow(),
      muteRow({ channel: 1, kind: "SNOOZE", untilAt: "2026-12-01T16:59:59Z", note: null, setByName: null }),
    ] });
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByText("Đầu ghi kết nối");
    const broken = channelCard("Kênh 2 “Hành lang DEMO”");
    await waitFor(() => expect(broken.textContent).toContain("Đã biết hỏng · nhắc thứ Hai"));
    expect(broken.textContent).toContain("Chủ DEMO đặt ngày 20/11/2026");
    expect(broken.textContent).toContain("Ghi chú: Chờ thay dây");
    const snoozed = channelCard("Kênh 1 “Sảnh DEMO”");
    expect(snoozed.textContent).toContain("Tạm ẩn đến hết 01/12/2026");
    expect(snoozed.textContent).toContain("Không rõ người đặt");
    expect(screen.queryByRole("button", { name: /Tuỳ chọn báo cho/ })).toBeNull();
  });

  it("lets an editor mute a channel, snooze it with a valid date, and follow it again", async () => {
    alertMocks.listBuildingMutes.mockResolvedValue({ canEdit: true, items: [muteRow()] });
    alertMocks.setChannelMute.mockImplementation(async (input) => ({
      recorderId: input.recorderId, channel: input.channel, kind: input.kind, untilAt: input.untilAt ?? null,
      note: input.note ?? null, setBy: ownerId, setAt: "2026-11-25T03:00:00Z",
    }));
    alertMocks.clearChannelMute.mockResolvedValue({ recorderId, channel: 2, cleared: true });
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await screen.findByText("Đầu ghi kết nối");
    // Cả 4 kênh DEMO đều có trong trạng thái đầu ghi (kênh 3 trống vẫn có) ⇒ menu hiện ở cả 4.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Tuỳ chọn báo cho/ })).toHaveLength(4));

    const menu = await openChannelMenu("Kênh 1 “Sảnh DEMO”");
    expect(within(menu).queryByRole("button", { name: "Theo dõi lại" })).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: "Không theo dõi kênh này" }));
    const dialog = await screen.findByRole("dialog", { name: "Không theo dõi kênh này" });
    fireEvent.change(within(dialog).getByLabelText("Ghi chú (không bắt buộc)"), { target: { value: "  chưa lắp  " } });
    const listsBefore = alertMocks.listBuildingMutes.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Không theo dõi" }));
    await waitFor(() => expect(alertMocks.setChannelMute).toHaveBeenCalledWith({ recorderId, channel: 1, kind: "IGNORE", untilAt: null, note: "  chưa lắp  " }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(alertMocks.listBuildingMutes.mock.calls.length).toBeGreaterThan(listsBefore));

    const snoozeMenu = await openChannelMenu("Kênh 1 “Sảnh DEMO”");
    fireEvent.click(within(snoozeMenu).getByRole("button", { name: "Tạm ẩn đến…" }));
    const snooze = await screen.findByRole("dialog", { name: "Tạm ẩn kênh này" });
    const day = within(snooze).getByLabelText("Tạm ẩn đến hết ngày");
    fireEvent.change(day, { target: { value: "01/01/2020" } });
    fireEvent.blur(day);
    fireEvent.click(within(snooze).getByRole("button", { name: "Tạm ẩn" }));
    expect(await within(snooze).findByText(/Chọn một ngày từ hôm nay đến/)).toBeTruthy();
    expect(alertMocks.setChannelMute).toHaveBeenCalledTimes(1);
    fireEvent.click(within(snooze).getByRole("button", { name: "Huỷ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Đóng hộp mở từ menu không được để trang kẹt "không bấm được".
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));

    const brokenMenu = await openChannelMenu("Kênh 2 “Hành lang DEMO”");
    fireEvent.click(within(brokenMenu).getByRole("button", { name: "Theo dõi lại" }));
    await waitFor(() => expect(alertMocks.clearChannelMute).toHaveBeenCalledWith(recorderId, 2));
  });

  it("submits a snooze until the end of the chosen day in Vietnam time", async () => {
    alertMocks.listBuildingMutes.mockResolvedValue({ canEdit: true, items: [] });
    alertMocks.setChannelMute.mockImplementation(async (input) => ({
      recorderId: input.recorderId, channel: input.channel, kind: input.kind, untilAt: input.untilAt ?? null,
      note: null, setBy: ownerId, setAt: "2026-11-25T03:00:00Z",
    }));
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    const menu = await openChannelMenu("Kênh 2 “Hành lang DEMO”");
    fireEvent.click(within(menu).getByRole("button", { name: "Tạm ẩn đến…" }));
    const snooze = await screen.findByRole("dialog", { name: "Tạm ẩn kênh này" });
    fireEvent.click(within(snooze).getByRole("button", { name: "Tạm ẩn" }));
    await waitFor(() => expect(alertMocks.setChannelMute).toHaveBeenCalledTimes(1));
    const input = alertMocks.setChannelMute.mock.calls[0]![0];
    expect(input.kind).toBe("SNOOZE");
    // Mặc định 7 ngày tới, hết ngày theo giờ Việt Nam (23:59:59 +07:00 = 16:59:59Z).
    expect(input.untilAt).toMatch(/T16:59:59\.000Z$/);
    const days = (Date.parse(input.untilAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8.1);
  });

  it("shows a mute permission failure in words, not a code", async () => {
    alertMocks.listBuildingMutes.mockResolvedValue({ canEdit: true, items: [] });
    alertMocks.setChannelMute.mockRejectedValue(new NetworkCenterRepositoryError("Bạn không có quyền thực hiện thao tác này với cảnh báo camera.", { code: "42501" }));
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    const menu = await openChannelMenu("Kênh 1 “Sảnh DEMO”");
    fireEvent.click(within(menu).getByRole("button", { name: "Đã biết hỏng (nhắc hằng tuần)" }));
    const dialog = await screen.findByRole("dialog", { name: "Đánh dấu kênh đã biết hỏng" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Đã biết hỏng" }));
    expect(await within(dialog).findByText("Chỉ chủ công ty hoặc superadmin sửa được.")).toBeTruthy();
    expect(dialog.textContent).not.toContain("42501");
  });

  it("offers no menu for a channel the recorder did not report (server only accepts reported channels)", async () => {
    alertMocks.listBuildingMutes.mockResolvedValue({ canEdit: true, items: [] });
    mocks.getBuilding.mockImplementation(async (target) => {
      const recorder = createDemoCameraRecorder(target);
      return { recorders: [{ ...recorder, channel_count: 5 }] };
    });
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Tuỳ chọn báo cho/ })).toHaveLength(4));
    expect(within(channelCard("Kênh 5")).queryByRole("button", { name: /Tuỳ chọn báo cho/ })).toBeNull();
  });

  it("shows “Đã biết” only to an executor of THIS building, not of another one", async () => {
    alertMocks.listIncidents.mockResolvedValue({ items: [incident({ title: "Kênh 2 mất hình" })] });
    const view = render(<CamerasTab site={site} controller={{ ...controller, permissionsQuery: executeAt(["b0000000-0000-4000-8000-000000000999"]) }} />, { wrapper: Wrapper });
    await screen.findByRole("region", { name: "Sự cố đang mở" });
    expect(screen.queryByRole("button", { name: "Đã biết: Kênh 2 mất hình" })).toBeNull();
    view.unmount();
    render(<CamerasTab site={site} controller={{ ...controller, permissionsQuery: executeAt([scope.buildingId]) }} />, { wrapper: Wrapper });
    expect(await screen.findByRole("button", { name: "Đã biết: Kênh 2 mất hình" })).toBeTruthy();
  });

  it("acknowledges an open incident for an editor or an executor and refreshes the strip", async () => {
    alertMocks.listIncidents.mockResolvedValue({ items: [incident({ incident_type: "CAMERA_CHANNEL_LOST", severity: "WARNING", subject: "channel:2", title: "Kênh 2 mất hình" })] });
    alertMocks.acknowledgeIncident.mockImplementation(async (incidentId) => {
      alertMocks.listIncidents.mockResolvedValue({ items: [incident({ status: "ACKNOWLEDGED", acknowledged_at: "2026-11-25T03:00:00Z", title: "Kênh 2 mất hình" })] });
      return { incidentId, status: "ACKNOWLEDGED", acknowledgedAt: "2026-11-25T03:00:00Z", acknowledgedBy: ownerId };
    });
    render(<CamerasTab site={site} controller={{ ...controller, permissionsQuery: executeAt([scope.buildingId]) }} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Đã biết: Kênh 2 mất hình" }));
    await waitFor(() => expect(alertMocks.acknowledgeIncident).toHaveBeenCalledWith("e0000000-0000-4000-8000-000000000001"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Đã biết: Kênh 2 mất hình" })).toBeNull());
    expect(screen.getByRole("region", { name: "Sự cố đang mở" }).textContent).toContain("Đã biết");
  });

  it("shows a closed incident acknowledgement as words", async () => {
    alertMocks.listBuildingMutes.mockResolvedValue({ canEdit: true, items: [] });
    alertMocks.listIncidents.mockResolvedValue({ items: [incident()] });
    alertMocks.acknowledgeIncident.mockRejectedValue(new NetworkCenterRepositoryError("Sự cố này đã đóng.", { code: "P0002" }));
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Đã biết: Ổ cứng đầu ghi Đầu ghi DEMO báo lỗi" }));
    expect(await screen.findByText("Sự cố này đã đóng.")).toBeTruthy();
  });

  it("links to the company-wide alert settings", async () => {
    render(<CamerasTab site={site} controller={controller} />, { wrapper: Wrapper });
    const link = await screen.findByRole("link", { name: "Cài đặt cảnh báo" });
    expect(link.getAttribute("href")).toBe("/network-center/camera-alerts");
  });

  it("DEMO: channel menus and acknowledgement run against the in-memory repository", async () => {
    render(<CamerasTab site={site} controller={{ ...controller, mode: "demo", isDemo: true }} />, { wrapper: Wrapper });
    const menu = await openChannelMenu("Kênh 2 “Hành lang DEMO”");
    fireEvent.click(within(menu).getByRole("button", { name: "Đã biết hỏng (nhắc hằng tuần)" }));
    const dialog = await screen.findByRole("dialog", { name: "Đánh dấu kênh đã biết hỏng" });
    expect(dialog.textContent).toContain("Dữ liệu mô phỏng");
    fireEvent.click(within(dialog).getByRole("button", { name: "Đã biết hỏng" }));
    await waitFor(() => expect(channelCard("Kênh 2 “Hành lang DEMO”").textContent).toContain("Đã biết hỏng · nhắc thứ Hai"));
    fireEvent.click(await screen.findByRole("button", { name: /^Đã biết: Camera Hành lang DEMO/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Đã biết: Camera Hành lang DEMO/ })).toBeNull());
    expect(alertMocks.setChannelMute).not.toHaveBeenCalled();
    expect(alertMocks.acknowledgeIncident).not.toHaveBeenCalled();
  });
});

describe("camera query isolation", () => {
  it("clears visible data and page cursors on building, organization, actor, or mode switches", async () => {
    const view = renderHook((target: BuildingCameraScope) => useBuildingCameras(target), { wrapper: Wrapper, initialProps: scope });
    await waitFor(() => expect(view.result.current.recorders).toHaveLength(1));
    const unresolved = () => new Promise<{ recorders: CameraRecorder[] }>(() => undefined);
    mocks.getBuilding.mockImplementation(unresolved);
    for (const changed of [
      { ...scope, buildingId: "b0000000-0000-4000-8000-000000000002" },
      { ...scope, organizationId: "a0000000-0000-4000-8000-000000000002" },
      { ...scope, actorId: "user-b" },
    ]) {
      view.rerender(changed);
      expect(view.result.current.recorders).toEqual([]);
      expect(view.result.current.events).toEqual([]);
      expect(view.result.current.eventsQuery.hasNextPage).toBe(false);
    }
    view.rerender({ ...scope, mode: "demo" });
    await waitFor(() => expect(view.result.current.recorders[0]?.vendor).toBe("DEMO"));
    expect(mocks.getBuilding).toHaveBeenCalledTimes(4);
  });

  it("refreshes mounted monitoring queries after thirty seconds", async () => {
    renderHook(() => useBuildingCameras(scope), { wrapper: Wrapper });
    await waitFor(() => expect(mocks.listEvents).toHaveBeenCalledTimes(1));
    // The existing mounted timers are real; switch to fake timers, then remount
    // to observe the actual polling callback without a thirty-second test delay.
    cleanup(); client.clear(); vi.clearAllMocks(); vi.useFakeTimers();
    renderHook(() => useBuildingCameras(scope), { wrapper: Wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const initial = mocks.getBuilding.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.getBuilding.mock.calls.length).toBeGreaterThan(initial);
  });
});
