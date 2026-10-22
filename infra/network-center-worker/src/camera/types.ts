export type RecorderStatus = "ONLINE" | "OFFLINE" | "AUTH_DENIED" | "UNKNOWN";
export type CameraChannelState = "CONNECTED" | "DISCONNECTED" | "EMPTY" | "UNKNOWN";
export const CAMERA_ISSUES = [
  "NETWORK_UNREACHABLE", "AUTHENTICATION_FAILED", "CHANNEL_STATUS_UNAVAILABLE",
  "STORAGE_STATUS_UNAVAILABLE", "EVENT_STREAM_UNAVAILABLE", "DEVICE_RESPONSE_INVALID",
] as const;
export type CameraIssue = (typeof CAMERA_ISSUES)[number];

export interface CameraChannelObservation {
  /** User-facing number. Device indexes are converted exactly once at the boundary. */
  channel: number;
  state: CameraChannelState;
}

export interface CameraDiskObservation {
  slot: number;
  state: "NORMAL" | "ERROR" | "MISSING" | "UNKNOWN";
  totalBytes?: number;
  usedBytes?: number;
}

export interface CameraSnapshot {
  observedAt: string;
  status: RecorderStatus;
  channels: CameraChannelObservation[];
  storage: CameraDiskObservation[];
  /** Polling cannot reconstruct events that start and end between samples. */
  eventCoverage: "STATE_POLLING_ONLY";
  /** Fixed diagnostic codes only, never device response text or credentials. */
  issues: CameraIssue[];
}

export interface CameraPollingClient {
  poll(): Promise<CameraSnapshot>;
}
