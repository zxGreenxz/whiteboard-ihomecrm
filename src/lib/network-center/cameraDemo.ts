import {
  CAMERA_ALERT_TYPE_CODES,
  type CameraAlertDelivery, type CameraAlertRepository, type CameraAlertSettingsView, type CameraAlertTypes,
  type CameraBuildingMutes, type CameraIncident, type CameraRecorder, type CameraRepository, type CameraScope,
} from "./cameraContracts";
import { NetworkCenterRepositoryError } from "./supabaseRepository";

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

// ---------------------------------------------------------------------------
// Cảnh báo camera v2 — DEMO trong bộ nhớ cho màn cài đặt và tab Camera. Chỉ dùng
// khi đang ở chế độ demo; không bao giờ là đường lui khi truy vấn thật lỗi.
// ---------------------------------------------------------------------------
const DEMO_RECORDER_ID = "d0000000-0000-4000-8000-000000000001";
const DEMO_ACCOUNT_ID = "d0000000-0000-4000-8000-0000000000a1";
const DEMO_GROUP_ID = "d0000000-0000-4000-8000-0000000000b1";
const DEMO_ACTOR_ID = "d0000000-0000-4000-8000-0000000000c1";

export const DEMO_CAMERA_ALERT_TYPES: CameraAlertTypes = {
  CAMERA_STORAGE_ERROR: { enabled: true, delivery: "ZALO", threshold_seconds: 0 },
  CAMERA_RECORDER_OFFLINE: { enabled: true, delivery: "ZALO", threshold_seconds: 600 },
  CAMERA_RECORDER_AUTH_DENIED: { enabled: true, delivery: "ZALO", threshold_seconds: 600 },
  CAMERA_MONITOR_STALE: { enabled: true, delivery: "ZALO", threshold_seconds: 600 },
  CAMERA_CHANNEL_LOST: { enabled: true, delivery: "ZALO", threshold_seconds: 900 },
  CAMERA_CHANNEL_FLAPPING: { enabled: true, delivery: "DIGEST", threshold_count: 5 },
  CAMERA_RECORDER_UNKNOWN: { enabled: true, delivery: "BELL", threshold_seconds: 1800 },
};

function demoSettingsView(organizationId: string, now: number): CameraAlertSettingsView {
  return {
    organizationId, exists: true, canEdit: true,
    settings: {
      enabled: true, mode: "SHADOW", zaloAccountId: DEMO_ACCOUNT_ID, zaloConversationId: DEMO_GROUP_ID,
      types: structuredClone(DEMO_CAMERA_ALERT_TYPES), nightStart: "22:00", nightEnd: "07:00", digestAt: "08:00",
      dailyZaloCap: 6, pushEnabled: false, liveSince: null, updatedBy: DEMO_ACTOR_ID,
      updatedAt: new Date(now - 3_600_000).toISOString(), version: 1,
    },
    zalo: {
      account: { id: DEMO_ACCOUNT_ID, name: "Nick DEMO", kind: "personal", status: "connected" },
      conversation: { id: DEMO_GROUP_ID, name: "Nhóm kỹ thuật DEMO", threadType: "group", accountId: DEMO_ACCOUNT_ID },
      warning: null,
    },
    today: { date: new Date(now).toISOString().slice(0, 10), zaloSent: 0, shadowWouldSend: 2, cap: 6 },
    defaults: structuredClone(DEMO_CAMERA_ALERT_TYPES),
  };
}

/** Repository DEMO có trạng thái: lưu cài đặt (CAS theo version), tắt kênh, "Đã biết", tin thử. */
export function createDemoCameraAlertRepository(now = Date.now()): CameraAlertRepository {
  let view: CameraAlertSettingsView | null = null;
  const mutes = new Map<string, CameraBuildingMutes["items"][number]>();
  const acknowledged = new Set<string>();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const settingsOf = (organizationId: string) => (view ??= demoSettingsView(organizationId, now));
  const deliveries = (): CameraAlertDelivery[] => {
    const scopeBuilding = "d0000000-0000-4000-8000-0000000000e1";
    return [
      {
        id: "d0000000-0000-4000-8000-0000000000d1", createdAt: iso(-1_800_000), kind: "OPENED", channel: "ZALO",
        status: "SHADOW", storedStatus: "SHADOW", shadow: true, reason: "WOULD_QUEUE",
        body: "⚠ TOÀ DEMO: Kênh 2 \"Hành lang DEMO\" mất hình 16 phút (từ 07:50).\nXem: CRM › Trung tâm mạng › Camera",
        buildingIds: [scopeBuilding], recipients: null, pendingRelease: false, releasedAt: null, sentAt: null,
        zaloJobId: null, jobStatus: null, jobError: null,
      },
      {
        id: "d0000000-0000-4000-8000-0000000000d2", createdAt: iso(-7_200_000), kind: "BASELINE", channel: "ZALO",
        status: "SHADOW", storedStatus: "SHADOW", shadow: true, reason: "WOULD_QUEUE",
        body: "📋 Hiện trạng camera lúc bật cảnh báo\n• Không có sự cố nào đang mở (1 đầu ghi đang theo dõi).\nXem: CRM › Trung tâm mạng › Camera",
        buildingIds: [], recipients: null, pendingRelease: false, releasedAt: null, sentAt: null,
        zaloJobId: null, jobStatus: null, jobError: null,
      },
    ];
  };
  const muteKey = (recorderId: string, channel: number) => `${recorderId}:${channel}`;
  return {
    async getSettings(organizationId) { return structuredClone(settingsOf(organizationId)); },
    async saveSettings(organizationId, expectedVersion, patch) {
      const current = settingsOf(organizationId);
      if (expectedVersion !== current.settings.version) {
        throw new NetworkCenterRepositoryError("Cài đặt cảnh báo camera vừa được người khác thay đổi. Tải lại rồi lưu lại.", { code: "PT409" });
      }
      if (patch.dailyZaloCap !== undefined && (patch.dailyZaloCap < 1 || patch.dailyZaloCap > 20)) {
        throw new NetworkCenterRepositoryError("Giá trị cài đặt không hợp lệ: dailyZaloCap", { code: "22023" });
      }
      const types = structuredClone(current.settings.types);
      for (const code of CAMERA_ALERT_TYPE_CODES) {
        if (patch.types?.[code]) types[code] = { ...types[code], ...patch.types[code] };
      }
      const { types: _ignored, ...rest } = patch;
      void _ignored;
      view = {
        ...current,
        settings: { ...current.settings, ...rest, types, version: current.settings.version + 1, updatedAt: iso(0) },
      };
      return structuredClone(view);
    },
    async listZaloGroups() {
      return { items: [{ id: DEMO_GROUP_ID, name: "Nhóm kỹ thuật DEMO", accountId: DEMO_ACCOUNT_ID, accountName: "Nick DEMO", lastMessageAt: iso(-600_000) }] };
    },
    async setChannelMute(input) {
      const row = {
        recorderId: input.recorderId, channel: input.channel, kind: input.kind,
        untilAt: input.kind === "SNOOZE" ? input.untilAt ?? null : null, note: input.note?.trim() || null,
        setBy: DEMO_ACTOR_ID, setAt: iso(0),
      };
      mutes.set(muteKey(input.recorderId, input.channel), { ...row, organizationId: "", buildingId: "", setByName: "Chủ DEMO" });
      return row;
    },
    async clearChannelMute(recorderId, channel) {
      return { recorderId, channel, cleared: mutes.delete(muteKey(recorderId, channel)) };
    },
    async listBuildingMutes(scope: CameraScope) {
      return {
        canEdit: true,
        items: [...mutes.values()].map((row) => ({ ...row, organizationId: scope.organizationId, buildingId: scope.buildingId })),
      };
    },
    async listDeliveries(_organizationId, query = {}) {
      const items = deliveries().filter((row) => !query.status || row.status === query.status);
      return { items, hasMore: false };
    },
    async sendTest() {
      return { deliveryId: "d0000000-0000-4000-8000-0000000000d9", status: "SHADOW", reason: "DEMO", jobId: null };
    },
    async listIncidents(scope: CameraScope) {
      const incident: CameraIncident = {
        id: "d0000000-0000-4000-8000-0000000000f1", organization_id: scope.organizationId, building_id: scope.buildingId,
        incident_type: "CAMERA_CHANNEL_LOST", severity: "WARNING",
        status: acknowledged.has("d0000000-0000-4000-8000-0000000000f1") ? "ACKNOWLEDGED" : "OPEN",
        title: "Camera Hành lang DEMO của đầu ghi Đầu ghi DEMO mất hình",
        summary: "Kênh 2 (Hành lang DEMO) của đầu ghi Đầu ghi DEMO mất kết nối.",
        opened_at: iso(-1_800_000),
        acknowledged_at: acknowledged.has("d0000000-0000-4000-8000-0000000000f1") ? iso(0) : null,
        recorder_id: DEMO_RECORDER_ID, subject: "channel:2",
      };
      return { items: [incident] };
    },
    async acknowledgeIncident(incidentId) {
      acknowledged.add(incidentId);
      return { incidentId, status: "ACKNOWLEDGED", acknowledgedAt: iso(0), acknowledgedBy: DEMO_ACTOR_ID };
    },
  };
}
