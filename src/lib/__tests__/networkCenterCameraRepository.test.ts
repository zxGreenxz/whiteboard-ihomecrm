import { describe, expect, it, vi } from "vitest";
import { cameraRecorderStatus } from "@/lib/network-center/cameraContracts";
import { createDemoCameraRecorder, demoCameraRepository } from "@/lib/network-center/cameraDemo";
import { SupabaseCameraRepository } from "@/lib/network-center/cameraRepository";
import type { NetworkCenterRpcCall } from "@/lib/network-center/supabaseRepository";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn() } }));
const scope = {
  organizationId: "a0000000-0000-4000-8000-000000000001",
  buildingId: "b0000000-0000-4000-8000-000000000001",
};
const now = Date.parse("2026-01-01T10:00:00Z");

describe("camera repository and freshness", () => {
  it("distinguishes unmeasured, offline, denied, stale and paused recorders", () => {
    const recorder = createDemoCameraRecorder(scope, now);
    expect(cameraRecorderStatus(recorder, now)).toBe("ONLINE");
    expect(cameraRecorderStatus(recorder, now + 121_000)).toBe("STALE");
    expect(cameraRecorderStatus({ ...recorder, snapshot: null }, now)).toBe("UNKNOWN");
    expect(cameraRecorderStatus({ ...recorder, enabled: false }, now)).toBe("DISABLED");
    for (const status of ["OFFLINE", "AUTH_DENIED", "UNKNOWN"] as const) {
      expect(cameraRecorderStatus({ ...recorder, snapshot: { ...recorder.snapshot!, status } }, now)).toBe(status);
    }
  });

  it("reads the requested building and strips fields not in the public contract", async () => {
    const recorder = { ...createDemoCameraRecorder(scope, now), model: null, private_address: "never render" };
    const call = vi.fn<NetworkCenterRpcCall>().mockResolvedValue({ data: { recorders: [recorder] }, error: null });
    const result = await new SupabaseCameraRepository(call).getBuilding(scope);
    expect(call).toHaveBeenCalledWith("camera_building_snapshot_v1", { p_building_id: scope.buildingId });
    expect(result.recorders[0].model).toBeNull();
    expect(result.recorders[0]).not.toHaveProperty("private_address");
  });

  it("accepts nullable disk measurements without hiding the recorder", async () => {
    const recorder = createDemoCameraRecorder(scope, now);
    const call: NetworkCenterRpcCall = async () => ({ data: { recorders: [{ ...recorder,
      snapshot: { ...recorder.snapshot!, storage: [{ slot: 1, state: "UNKNOWN", totalBytes: null, usedBytes: null }] },
    }] }, error: null });
    const result = await new SupabaseCameraRepository(call).getBuilding(scope);
    expect(result.recorders[0].snapshot?.storage).toEqual([{ slot: 1, state: "UNKNOWN", totalBytes: undefined, usedBytes: undefined }]);
  });

  it("rejects another organization, building, or mismatched snapshot rather than rendering it", async () => {
    const recorder = createDemoCameraRecorder(scope, now);
    const other = "c0000000-0000-4000-8000-000000000002";
    for (const wrong of [
      { ...recorder, organization_id: other },
      { ...recorder, building_id: other },
      { ...recorder, snapshot: { ...recorder.snapshot!, recorder_id: other } },
      { ...recorder, snapshot: { ...recorder.snapshot!, organization_id: other } },
    ]) {
      const call: NetworkCenterRpcCall = async () => ({ data: { recorders: [wrong] }, error: null });
      await expect(new SupabaseCameraRepository(call).getBuilding(scope)).rejects.toMatchObject({ code: "CAMERA_SCOPE_MISMATCH" });
    }
  });

  it("never substitutes demo or an empty array after denial, missing service or invalid data", async () => {
    for (const code of ["42501", "PGRST202", "PGRST301"]) {
      const repository = new SupabaseCameraRepository(async () => ({ data: null, error: { code, message: "private internal error" } }));
      await expect(repository.getBuilding(scope)).rejects.toMatchObject({ code });
      await expect(repository.getBuilding(scope)).rejects.not.toHaveProperty("message", "private internal error");
    }
    const repository = new SupabaseCameraRepository(async () => ({ data: { recorders: null }, error: null }));
    await expect(repository.getBuilding(scope)).rejects.toMatchObject({ code: "CAMERA_INVALID_DATA" });
  });

  it("passes both cursor fields for stable event pagination and rejects cross-scope events", async () => {
    const data = await demoCameraRepository.listEvents(scope);
    const call = vi.fn<NetworkCenterRpcCall>().mockResolvedValue({ data, error: null });
    const cursor = { observedAt: data.items[0].observed_at, id: data.items[0].id };
    await new SupabaseCameraRepository(call).listEvents(scope, cursor);
    expect(call).toHaveBeenCalledWith("camera_building_events_v1", {
      p_building_id: scope.buildingId, p_limit: 50,
      p_before_observed_at: cursor.observedAt, p_before_id: cursor.id,
    });
    call.mockResolvedValue({ data: { ...data, items: [{ ...data.items[0], building_id: "b0000000-0000-4000-8000-000000000002" }] }, error: null });
    await expect(new SupabaseCameraRepository(call).listEvents(scope)).rejects.toMatchObject({ code: "CAMERA_SCOPE_MISMATCH" });
    call.mockResolvedValue({ data: { items: [], hasMore: true }, error: null });
    await expect(new SupabaseCameraRepository(call).listEvents(scope)).rejects.toMatchObject({ code: "CAMERA_INVALID_DATA" });
  });
});
