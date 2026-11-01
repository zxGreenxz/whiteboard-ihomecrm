// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCameraQuality } from "@/hooks/network-center/useCameraQuality";

const mocks = vi.hoisted(() => ({ owner: "alice", read: vi.fn(), write: vi.fn(), token: vi.fn() }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: mocks.owner ? { id: mocks.owner } : null }) }));
vi.mock("@/lib/companyPreferenceRemote", () => ({ companySessionToken: mocks.token }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  from: () => ({ select: () => ({ eq: (_key: string, owner: string) => ({ single: () => ({ setHeader: (_name: string, token: string) => mocks.read(owner, token) }) }) }) }),
  rpc: (_name: string, args: { p_key: string; p_value: string }) => ({ setHeader: (_name: string, token: string) => mocks.write(args, token) }),
} }));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.owner = "alice";
  mocks.token.mockImplementation(async (owner: string) => `token-${owner}`);
  mocks.read.mockResolvedValue({ data: { ui_preferences: {} }, error: null });
  mocks.write.mockImplementation(async ({ p_key, p_value }: { p_key: string; p_value: string }) => ({ data: { [p_key]: p_value }, error: null }));
});
afterEach(cleanup);

it("defaults to SD then restores independent account preferences on another page/device", async () => {
  mocks.read.mockResolvedValue({ data: { ui_preferences: { camera_live_quality: "hd", camera_playback_quality: "fullhd", camera_export_quality: "720p" } }, error: null });
  const { result } = renderHook(() => [useCameraQuality("live"), useCameraQuality("playback"), useCameraQuality("export")] as const);
  expect(result.current.map(([value]) => value)).toEqual(["sd", "sd", "480p"]);
  await waitFor(() => expect(result.current.map(([value]) => value)).toEqual(["hd", "fullhd", "720p"]));
  expect(mocks.write).not.toHaveBeenCalled();
});

it("persists a selection atomically and restores it after remount", async () => {
  const first = renderHook(() => useCameraQuality("playback"));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  act(() => first.result.current[1]("original"));
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({ p_key: "camera_playback_quality", p_value: "original" }, "Bearer token-alice"));
  await waitFor(() => expect(JSON.parse(localStorage.getItem("ihomecrm.camera-quality:alice:playback")!)).toEqual({ value: "original", pending: false }));
  first.unmount();
  const second = renderHook(() => useCameraQuality("playback"));
  expect(second.result.current[0]).toBe("original");
});

it("serializes rapid choices and never lets an older read replace the last selection", async () => {
  let loaded!: (result: unknown) => void; let saved!: (result: unknown) => void;
  mocks.read.mockImplementationOnce(() => new Promise((resolve) => { loaded = resolve; }));
  mocks.write.mockImplementationOnce(() => new Promise((resolve) => { saved = resolve; }));
  const { result } = renderHook(() => useCameraQuality("playback"));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  act(() => { result.current[1]("hd"); result.current[1]("fullhd"); });
  await waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
  await act(async () => { loaded({ data: { ui_preferences: { camera_playback_quality: "sd" } }, error: null }); saved({ data: { camera_playback_quality: "hd" }, error: null }); });
  await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
  expect(result.current[0]).toBe("fullhd");
  await waitFor(() => expect(JSON.parse(localStorage.getItem("ihomecrm.camera-quality:alice:playback")!).pending).toBe(false));
});

it("does not apply a former account's late read or save to the next account", async () => {
  let loaded!: (result: unknown) => void;
  mocks.read.mockImplementationOnce(() => new Promise((resolve) => { loaded = resolve; }));
  const hook = renderHook(() => useCameraQuality("live"));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  act(() => { hook.result.current[1]("hd"); });
  await waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
  mocks.owner = "bob"; hook.rerender();
  await act(async () => loaded({ data: { ui_preferences: { camera_live_quality: "hd" } }, error: null }));
  expect(hook.result.current[0]).toBe("sd");
  expect(localStorage.getItem("ihomecrm.camera-quality:bob:live")).toBeNull();
});

it("keeps an in-flight choice across remount even when an older server read finishes after the save", async () => {
  let saved!: (result: unknown) => void; let staleRead!: (result: unknown) => void;
  const first = renderHook(() => useCameraQuality("playback"));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  mocks.write.mockImplementationOnce(() => new Promise((resolve) => { saved = resolve; }));
  act(() => first.result.current[1]("fullhd"));
  await waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
  first.unmount();
  mocks.read.mockImplementationOnce(() => new Promise((resolve) => { staleRead = resolve; }));
  const second = renderHook(() => useCameraQuality("playback"));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  await act(async () => saved({ data: { camera_playback_quality: "fullhd" }, error: null }));
  expect(JSON.parse(localStorage.getItem("ihomecrm.camera-quality:alice:playback")!).pending).toBe(false);
  await act(async () => staleRead({ data: { ui_preferences: { camera_playback_quality: "sd" } }, error: null }));
  expect(second.result.current[0]).toBe("fullhd");
  expect(JSON.parse(localStorage.getItem("ihomecrm.camera-quality:alice:playback")!).value).toBe("fullhd");
});

it("keeps an offline choice, reports incomplete sync and retries it on the next open", async () => {
  mocks.write.mockRejectedValueOnce(new Error("offline"));
  const first = renderHook(() => useCameraQuality("export"));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  act(() => first.result.current[1]("1080p"));
  await waitFor(() => expect(first.result.current[2]).toContain("chưa đồng bộ"));
  first.unmount();
  const second = renderHook(() => useCameraQuality("export"));
  await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(JSON.parse(localStorage.getItem("ihomecrm.camera-quality:alice:export")!).pending).toBe(false));
  expect(second.result.current[0]).toBe("1080p");
});
