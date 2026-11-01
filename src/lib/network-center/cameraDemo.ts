import type { CameraRecorder, CameraRepository, CameraScope } from "./cameraContracts";

/** Explicit DEMO fixture only; never used as a fallback for a failed live query. */
export function createDemoCameraRecorder(scope: CameraScope, now = Date.now()): CameraRecorder {
  const id = "d0000000-0000-4000-8000-000000000001";
  return {
    id, organization_id: scope.organizationId, building_id: scope.buildingId,
    display_name: "Đầu ghi DEMO", vendor: "DEMO", model: "Mô phỏng 4 kênh",
    channel_count: 4, enabled: true, stale_after_seconds: 120,
    snapshot: {
      recorder_id: id, organization_id: scope.organizationId, building_id: scope.buildingId,
      status: "ONLINE", checked_at: new Date(now).toISOString(), received_at: new Date(now).toISOString(),
      channels: [
        { channel: 1, name: "Sảnh DEMO", state: "CONNECTED" },
        { channel: 2, name: "Hành lang DEMO", state: "DISCONNECTED" },
        { channel: 3, state: "EMPTY" },
        { channel: 4, state: "UNKNOWN" },
      ],
      storage: [{ slot: 1, state: "NORMAL", totalBytes: 1_000_000_000_000, usedBytes: 400_000_000_000 }],
      event_coverage: "STATE_POLLING_ONLY", issues: [],
    },
  };
}

export const demoCameraRepository: CameraRepository = {
  async getBuilding(scope) { return { recorders: [createDemoCameraRecorder(scope)] }; },
  async listEvents(scope) {
    return {
      hasMore: false,
      items: [{
        id: "d0000000-0000-4000-8000-000000000002",
        recorder_id: "d0000000-0000-4000-8000-000000000001",
        organization_id: scope.organizationId, building_id: scope.buildingId,
        event_key: "demo-channel-disconnected", kind: "CHANNEL", channel: 2, slot: null,
        previous_state: "CONNECTED", state: "DISCONNECTED", code: null, action: null,
        observed_at: "2026-01-01T08:00:00Z", received_at: "2026-01-01T08:00:01Z",
      }],
    };
  },
};
