// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CamerasTab } from "@/components/network-center/tabs/CamerasTab";
import { cameraQueryKey, useBuildingCameras, type BuildingCameraScope } from "@/hooks/network-center/useBuildingCameras";
import type { CameraEventPage, CameraRecorder, CameraScope } from "@/lib/network-center/cameraContracts";
import { createDemoCameraRecorder, demoCameraRepository } from "@/lib/network-center/cameraDemo";
import { DemoNetworkCenterRepository } from "@/lib/network-center/demoRepository";
import { NetworkCenterRepositoryError } from "@/lib/network-center/supabaseRepository";

const mocks = vi.hoisted(() => ({
  getBuilding: vi.fn<(scope: CameraScope) => Promise<{ recorders: CameraRecorder[] }>>(),
  listEvents: vi.fn<() => Promise<CameraEventPage>>(),
}));
vi.mock("@/lib/network-center/cameraRepository", () => ({ supabaseCameraRepository: mocks }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn() } }));
vi.mock("@/lib/network-center/cameraLive", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/network-center/cameraLive")>(),
  cameraLiveCapabilities: vi.fn(async () => ({ channels: [1, 2, 3, 4], maxView: 4, leaseSeconds: 75, archive: true })),
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
function Wrapper({ children }: PropsWithChildren) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  mocks.getBuilding.mockImplementation(async (target) => ({ recorders: [createDemoCameraRecorder(target)] }));
  mocks.listEvents.mockResolvedValue({ items: [], hasMore: false });
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); });

describe("camera tab", () => {
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
    expect(await screen.findByRole("button", { name: "Xem trực tiếp" })).toBeTruthy();
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
