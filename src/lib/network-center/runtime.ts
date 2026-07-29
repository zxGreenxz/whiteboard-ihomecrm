export type NetworkCenterMode = "off" | "demo" | "production";

export const NETWORK_CENTER_REALTIME_TABLES = [
  "network_device_current",
  "network_interface_current",
  "network_incidents",
  "network_command_events",
  "network_worker_heartbeats",
] as const;

export type NetworkCenterRealtimeTable = (typeof NETWORK_CENTER_REALTIME_TABLES)[number];

export interface NetworkCenterRealtimeTarget {
  invalidateFleet: true;
  buildingIds: string[];
}

export function resolveNetworkCenterMode(
  value: string | undefined,
  isProductionBuild: boolean,
): NetworkCenterMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production") return "production";
  if (normalized === "demo" && !isProductionBuild) return "demo";
  return "off";
}

export function isNetworkCenterEnabled(mode: NetworkCenterMode): boolean {
  return mode !== "off";
}

export const NETWORK_CENTER_RUNTIME_MODE = resolveNetworkCenterMode(
  import.meta.env.VITE_NETWORK_CENTER_MODE,
  import.meta.env.PROD,
);

export const NETWORK_CENTER_RUNTIME_ENABLED = isNetworkCenterEnabled(
  NETWORK_CENTER_RUNTIME_MODE,
);

export function selectNetworkCenterRepository<T>(
  mode: NetworkCenterMode,
  productionRepository: T,
  demoRepository: T,
): T | null {
  if (mode === "off") return null;
  return mode === "demo" ? demoRepository : productionRepository;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedBuildingId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function payloadBuildingId(payload: unknown): string | null {
  const envelope = record(payload);
  if (!envelope) return null;
  for (const candidate of [record(envelope.new), record(envelope.old)]) {
    const buildingId = normalizedBuildingId(candidate?.building_id);
    if (buildingId) return buildingId;
  }
  return null;
}

export function resolveNetworkCenterRealtimeTarget(
  table: NetworkCenterRealtimeTable,
  payload: unknown,
  selectedBuildingId?: string,
): NetworkCenterRealtimeTarget {
  const buildingId = payloadBuildingId(payload);
  if (buildingId) return { invalidateFleet: true, buildingIds: [buildingId] };

  if (table === "network_command_events") {
    const selected = normalizedBuildingId(selectedBuildingId);
    return {
      invalidateFleet: true,
      buildingIds: selected ? [selected] : [],
    };
  }

  return { invalidateFleet: true, buildingIds: [] };
}
