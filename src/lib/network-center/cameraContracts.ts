import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
const identifier = z.string().uuid();
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

export function cameraRecorderStatus(recorder: CameraRecorder, now = Date.now()) {
  if (!recorder.enabled) return "DISABLED";
  if (!recorder.snapshot) return "UNKNOWN";
  if (now - Date.parse(recorder.snapshot.checked_at) > recorder.stale_after_seconds * 1000) return "STALE";
  return recorder.snapshot.status;
}
