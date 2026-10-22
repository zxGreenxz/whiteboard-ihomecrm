import { z } from "zod";
import type { CameraSnapshot } from "./camera/types.js";

export const cameraConnectionSchema = z.object({
  recorderId: z.uuid(), connectionId: z.uuid(), organizationId: z.uuid(), buildingId: z.uuid(),
  displayName: z.string().min(1).max(255), endpoint: z.string().url(),
  credentialRef: z.string().min(1).max(255), channelCount: z.number().int().min(1).max(256),
  pollIntervalSeconds: z.number().int().min(30).max(3600),
  connectTimeoutMs: z.number().int().min(1000).max(30000),
});
export type CameraConnection = z.infer<typeof cameraConnectionSchema>;
export interface CameraDeviceEvent {
  eventKey: string;
  code: string;
  action: "Start" | "Stop" | "Pulse";
  channel: number | null;
  observedAt: string;
}
export type CameraIngest = Omit<CameraSnapshot, "eventCoverage"> & {
  recorderId: string;
  connectionId: string;
  eventCoverage: "STATE_POLLING_ONLY" | "EVENT_STREAM";
  events: CameraDeviceEvent[];
};
export interface CameraWorkerApi {
  listCameraConnections(): Promise<CameraConnection[]>;
  ingestCamera(payload: CameraIngest): Promise<unknown>;
}
