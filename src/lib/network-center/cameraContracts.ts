import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
const identifier = z.string().guid();
export const cameraChannelSchema = z.object({
  channel: z.number().int().positive(),
  name: z.string().optional(),
  state: z.enum(["CONNECTED", "DISCONNECTED", "EMPTY", "UNKNOWN"]),
});
const storageSchema = z.object({
  slot: z.number().int().positive(),
  state: z.enum(["NORMAL", "ERROR", "MISSING", "UNKNOWN"]),
  totalBytes: z.preprocess((value) => value === null ? undefined : value, z.number().nonnegative().optional()),
  usedBytes: z.preprocess((value) => value === null ? undefined : value, z.number().nonnegative().optional()),
});
export const cameraSnapshotSchema = z.object({
  recorder_id: identifier,
  organization_id: identifier,
  building_id: identifier,
  status: z.enum(["ONLINE", "OFFLINE", "UNKNOWN", "AUTH_DENIED"]),
  checked_at: timestamp,
  received_at: timestamp,
  channels: z.array(cameraChannelSchema),
  storage: z.array(storageSchema),
  event_coverage: z.enum(["STATE_POLLING_ONLY", "EVENT_STREAM"]),
  issues: z.array(z.string()),
});
export const cameraRecorderSchema = z.object({
  id: identifier,
  organization_id: identifier,
  building_id: identifier,
  display_name: z.string(),
  vendor: z.string(),
  model: z.string().nullable(),
  channel_count: z.number().int().positive(),
  enabled: z.boolean(),
  stale_after_seconds: z.number().positive(),
  snapshot: cameraSnapshotSchema.nullable(),
});
export const cameraBuildingSchema = z.object({ recorders: z.array(cameraRecorderSchema) });
export const cameraEventSchema = z.object({
  id: identifier,
  recorder_id: identifier,
  organization_id: identifier,
  building_id: identifier,
  event_key: z.string(),
  kind: z.enum(["RECORDER", "CHANNEL", "STORAGE", "DEVICE"]),
  channel: z.number().int().positive().nullable(),
  slot: z.number().int().positive().nullable(),
  previous_state: z.string().nullable(),
  state: z.string(),
  code: z.string().nullable(),
  action: z.string().nullable(),
  observed_at: timestamp,
  received_at: timestamp,
});
export const cameraEventsSchema = z.object({ items: z.array(cameraEventSchema), hasMore: z.boolean() });

export type CameraRecorder = z.infer<typeof cameraRecorderSchema>;
export type CameraBuilding = z.infer<typeof cameraBuildingSchema>;
export type CameraSnapshot = z.infer<typeof cameraSnapshotSchema>;
export type CameraEvent = z.infer<typeof cameraEventSchema>;
export type CameraEventPage = z.infer<typeof cameraEventsSchema>;
export interface CameraScope { organizationId: string; buildingId: string }
export interface CameraEventCursor { observedAt: string; id: string }
export interface CameraRepository {
  getBuilding(scope: CameraScope): Promise<CameraBuilding>;
  listEvents(scope: CameraScope, cursor?: CameraEventCursor): Promise<CameraEventPage>;
}

// ---------------------------------------------------------------------------
// Cảnh báo camera v2 (migration 20261124171943, spec 2026-11-24). Khoá JSON khớp
// đúng hình RPC trả về; trường thừa bị bỏ, trường thiếu ⇒ dữ liệu không hợp lệ.
// ---------------------------------------------------------------------------
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CAMERA_ALERT_TYPE_CODES = [
  "CAMERA_STORAGE_ERROR",
  "CAMERA_RECORDER_OFFLINE",
  "CAMERA_RECORDER_AUTH_DENIED",
  "CAMERA_MONITOR_STALE",
  "CAMERA_CHANNEL_LOST",
  "CAMERA_CHANNEL_FLAPPING",
  "CAMERA_RECORDER_UNKNOWN",
] as const;
export type CameraAlertTypeCode = typeof CAMERA_ALERT_TYPE_CODES[number];
export const cameraAlertDeliveryModeSchema = z.enum(["ZALO", "DIGEST", "BELL", "OFF"]);
export const cameraAlertModeSchema = z.enum(["SHADOW", "LIVE"]);
/** Một loại sự cố: bật/tắt, cách báo, ngưỡng (giây; chập chờn tính số lần). */
export const cameraAlertTypeSettingSchema = z.object({
  enabled: z.boolean(),
  delivery: cameraAlertDeliveryModeSchema,
  threshold_seconds: z.number().int().min(0).max(86_400).optional(),
  threshold_count: z.number().int().min(2).max(200).optional(),
});
export const cameraAlertTypesSchema = z.object({
  CAMERA_STORAGE_ERROR: cameraAlertTypeSettingSchema,
  CAMERA_RECORDER_OFFLINE: cameraAlertTypeSettingSchema,
  CAMERA_RECORDER_AUTH_DENIED: cameraAlertTypeSettingSchema,
  CAMERA_MONITOR_STALE: cameraAlertTypeSettingSchema,
  CAMERA_CHANNEL_LOST: cameraAlertTypeSettingSchema,
  CAMERA_CHANNEL_FLAPPING: cameraAlertTypeSettingSchema,
  CAMERA_RECORDER_UNKNOWN: cameraAlertTypeSettingSchema,
});
export const cameraAlertSettingsSchema = z.object({
  enabled: z.boolean(),
  mode: cameraAlertModeSchema,
  zaloAccountId: identifier.nullable(),
  zaloConversationId: identifier.nullable(),
  types: cameraAlertTypesSchema,
  nightStart: clock,
  nightEnd: clock,
  digestAt: clock,
  dailyZaloCap: z.number().int().min(1).max(20),
  pushEnabled: z.boolean(),
  liveSince: timestamp.nullable(),
  updatedBy: identifier.nullable(),
  updatedAt: timestamp.nullable(),
  /** 0 = chưa có dòng cài đặt; lưu lần đầu gửi expectedVersion 0. */
  version: z.number().int().nonnegative(),
});
export const cameraAlertZaloWarningSchema = z.enum(["NOT_CONFIGURED", "GROUP_MISSING", "ACCOUNT_DISCONNECTED"]);
/** camera_alert_get_settings_v1 / camera_alert_save_settings_v1. */
export const cameraAlertSettingsViewSchema = z.object({
  organizationId: identifier,
  exists: z.boolean(),
  settings: cameraAlertSettingsSchema,
  canEdit: z.boolean(),
  zalo: z.object({
    account: z.object({ id: identifier, name: z.string(), kind: z.string(), status: z.string() }).nullable(),
    conversation: z.object({ id: identifier, name: z.string(), threadType: z.string(), accountId: identifier.nullable() }).nullable(),
    warning: cameraAlertZaloWarningSchema.nullable(),
  }),
  today: z.object({
    date: localDate,
    zaloSent: z.number().int().nonnegative(),
    shadowWouldSend: z.number().int().nonnegative(),
    cap: z.number().int().min(1).max(20),
  }),
  defaults: cameraAlertTypesSchema,
});
/** Các khoá được lưu; chỉ gửi khoá đổi. types gửi từng loại đổi. */
export interface CameraAlertSettingsPatch {
  enabled?: boolean;
  mode?: z.infer<typeof cameraAlertModeSchema>;
  zaloAccountId?: string | null;
  zaloConversationId?: string | null;
  types?: Partial<Record<CameraAlertTypeCode, Partial<z.infer<typeof cameraAlertTypeSettingSchema>>>>;
  nightStart?: string;
  nightEnd?: string;
  digestAt?: string;
  dailyZaloCap?: number;
  pushEnabled?: boolean;
}
/** camera_alert_list_zalo_groups_v1 — không có nội dung tin. */
export const cameraAlertZaloGroupsSchema = z.object({
  items: z.array(z.object({
    id: identifier,
    name: z.string(),
    accountId: identifier,
    accountName: z.string(),
    lastMessageAt: timestamp.nullable(),
  })),
});
export const cameraChannelMuteKindSchema = z.enum(["IGNORE", "SNOOZE", "KNOWN_BROKEN"]);
/** camera_alert_set_channel_mute_v1. */
export const cameraChannelMuteSchema = z.object({
  recorderId: identifier,
  channel: z.number().int().positive(),
  kind: cameraChannelMuteKindSchema,
  untilAt: timestamp.nullable(),
  note: z.string().nullable(),
  setBy: identifier,
  setAt: timestamp,
});
/** camera_alert_clear_channel_mute_v1. */
export const cameraChannelMuteClearSchema = z.object({
  recorderId: identifier,
  channel: z.number().int().positive(),
  cleared: z.boolean(),
});
/** camera_building_channel_mutes_v1 — trạng thái tắt báo kênh của một toà. */
export const cameraBuildingMutesSchema = z.object({
  canEdit: z.boolean(),
  items: z.array(cameraChannelMuteSchema.extend({
    organizationId: identifier,
    buildingId: identifier,
    setByName: z.string().nullable(),
  })),
});
export const cameraAlertDeliveryStatusSchema = z.enum(["SHADOW", "QUEUED", "SENT", "FAILED", "SUPPRESSED", "DEFERRED"]);
export const cameraAlertDeliveryKindSchema = z.enum(["OPENED", "RESOLVED", "BASELINE", "NIGHT_DIGEST", "DIGEST", "TEST"]);
/** camera_alert_list_deliveries_v1 — sổ gửi 7 ngày, nguyên văn tin. */
export const cameraAlertDeliverySchema = z.object({
  id: identifier,
  createdAt: timestamp,
  kind: cameraAlertDeliveryKindSchema,
  channel: z.enum(["ZALO", "IN_APP"]),
  /** Trạng thái hiệu lực: QUEUED đã được worker gửi thì SENT, lỗi thì FAILED. */
  status: cameraAlertDeliveryStatusSchema,
  storedStatus: cameraAlertDeliveryStatusSchema,
  shadow: z.boolean(),
  /** SHADOW: điều LIVE lẽ ra đã làm (WOULD_QUEUE, NIGHT, DAILY_CAP, REPEAT_24H…); còn lại: lý do. */
  reason: z.string().nullable(),
  body: z.string(),
  buildingIds: z.array(identifier),
  recipients: z.number().int().nonnegative().nullable(),
  pendingRelease: z.boolean(),
  releasedAt: timestamp.nullable(),
  sentAt: timestamp.nullable(),
  zaloJobId: identifier.nullable(),
  jobStatus: z.string().nullable(),
  jobError: z.string().nullable(),
});
export const cameraAlertDeliveriesSchema = z.object({ items: z.array(cameraAlertDeliverySchema), hasMore: z.boolean() });
/** camera_alert_send_test_v1. */
export const cameraAlertTestResultSchema = z.object({
  deliveryId: identifier,
  status: cameraAlertDeliveryStatusSchema,
  reason: z.string().nullable().optional(),
  jobId: identifier.nullable().optional(),
  reused: z.boolean().optional(),
  capped: z.boolean().optional(),
});
/** Sự cố CAMERA_* chưa đóng của toà (camera_building_incidents_v1). */
export const cameraIncidentSchema = z.object({
  id: identifier,
  organization_id: identifier,
  building_id: identifier,
  incident_type: z.string().regex(/^CAMERA_[A-Z0-9_]+$/),
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
  status: z.enum(["OPEN", "ACKNOWLEDGED", "RECOVERING"]),
  title: z.string(),
  summary: z.string(),
  opened_at: timestamp,
  acknowledged_at: timestamp.nullable(),
  recorder_id: identifier.nullable(),
  subject: z.string().nullable(),
});
export const cameraIncidentsSchema = z.object({ items: z.array(cameraIncidentSchema) });
/** camera_alert_acknowledge_incident_v1 ("Đã biết"). */
export const cameraIncidentAcknowledgementSchema = z.object({
  incidentId: identifier,
  status: z.enum(["OPEN", "ACKNOWLEDGED", "RECOVERING"]),
  acknowledgedAt: timestamp,
  acknowledgedBy: identifier,
});

export type CameraAlertSettings = z.infer<typeof cameraAlertSettingsSchema>;
export type CameraAlertSettingsView = z.infer<typeof cameraAlertSettingsViewSchema>;
export type CameraAlertTypes = z.infer<typeof cameraAlertTypesSchema>;
export type CameraAlertZaloGroups = z.infer<typeof cameraAlertZaloGroupsSchema>;
export type CameraChannelMute = z.infer<typeof cameraChannelMuteSchema>;
export type CameraChannelMuteKind = z.infer<typeof cameraChannelMuteKindSchema>;
export type CameraBuildingMutes = z.infer<typeof cameraBuildingMutesSchema>;
export type CameraAlertDelivery = z.infer<typeof cameraAlertDeliverySchema>;
export type CameraAlertDeliveryPage = z.infer<typeof cameraAlertDeliveriesSchema>;
export type CameraAlertDeliveryStatus = z.infer<typeof cameraAlertDeliveryStatusSchema>;
export type CameraAlertTestResult = z.infer<typeof cameraAlertTestResultSchema>;
export type CameraIncident = z.infer<typeof cameraIncidentSchema>;
export type CameraIncidentList = z.infer<typeof cameraIncidentsSchema>;
export type CameraIncidentAcknowledgement = z.infer<typeof cameraIncidentAcknowledgementSchema>;
export interface CameraChannelMuteInput {
  recorderId: string;
  channel: number;
  kind: CameraChannelMuteKind;
  /** Bắt buộc với SNOOZE (≤ 90 ngày), bỏ trống với kiểu khác. */
  untilAt?: string | null;
  note?: string | null;
}
export interface CameraAlertDeliveryQuery {
  status?: CameraAlertDeliveryStatus;
  limit?: number;
  /** Trang kế: (createdAt, id) của dòng cuối trang trước — các dòng cùng lượt trùng giờ. */
  before?: { createdAt: string; id: string };
}
export interface CameraAlertRepository {
  getSettings(organizationId: string): Promise<CameraAlertSettingsView>;
  /** PT409 khi expectedVersion đã cũ (người khác vừa lưu). */
  saveSettings(organizationId: string, expectedVersion: number, patch: CameraAlertSettingsPatch): Promise<CameraAlertSettingsView>;
  listZaloGroups(organizationId: string, search?: string, limit?: number): Promise<CameraAlertZaloGroups>;
  setChannelMute(input: CameraChannelMuteInput): Promise<CameraChannelMute>;
  clearChannelMute(recorderId: string, channel: number): Promise<z.infer<typeof cameraChannelMuteClearSchema>>;
  listBuildingMutes(scope: CameraScope): Promise<CameraBuildingMutes>;
  listDeliveries(organizationId: string, query?: CameraAlertDeliveryQuery): Promise<CameraAlertDeliveryPage>;
  sendTest(organizationId: string): Promise<CameraAlertTestResult>;
  listIncidents(scope: CameraScope): Promise<CameraIncidentList>;
  acknowledgeIncident(incidentId: string): Promise<CameraIncidentAcknowledgement>;
}

export function cameraRecorderStatus(recorder: CameraRecorder, now = Date.now()) {
  if (!recorder.enabled) return "DISABLED";
  if (!recorder.snapshot) return "UNKNOWN";
  if (now - Date.parse(recorder.snapshot.checked_at) > recorder.stale_after_seconds * 1000) return "STALE";
  return recorder.snapshot.status;
}
