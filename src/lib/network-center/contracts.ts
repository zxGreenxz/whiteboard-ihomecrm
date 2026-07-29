export type NetworkHealth = "online" | "degraded" | "offline";
export type IncidentSeverity = "critical" | "high" | "medium" | "low";
export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type BackupStatus = "fresh" | "stale";

export interface PhysicalBuildingRecord {
  id: string;
  name: string;
  roomsCount?: number;
  organizationId?: string;
}

export interface RouterSummary {
  id: string | null;
  identity: string;
  model: string;
  firmware: string;
  targetFirmware: string;
  lifecycleStatus: "UNPROVISIONED" | "PROVISIONING" | "ONLINE" | "OFFLINE" | "DISABLED";
  wanStatus: "up" | "down";
  lastSeenLabel: string;
  cpuPercent: number;
  memoryPercent: number;
  downloadMbps: number;
  uploadMbps: number;
}

export interface InterfaceRecord {
  id: string;
  name: string;
  role: "wan" | "lan" | "uplink";
  status: "up" | "down";
  protected: boolean;
  rxMbps: number;
  txMbps: number;
  utilizationPercent: number;
  errors: number;
  discards: number;
}

export interface ClientRecord {
  id: string;
  hostname: string;
  address: string;
  macAddress: string;
  connection: "dhcp" | "hotspot" | "static";
  roomHint: string;
  rxMbps: number;
  txMbps: number;
  randomizedMac: boolean;
  userIdentity: string;
  sessionIdentity: string;
}

export interface ArubaNode {
  id: string;
  name: string;
  status: "online" | "slow" | "offline";
  address: string;
  uplink: string;
  lastSeenLabel: string;
}

export interface ArubaPageCursor {
  sortOrder: number;
  id: string;
}

export interface ArubaPage {
  items: ArubaNode[];
  nextCursor: ArubaPageCursor | null;
}

export interface NetworkIncident {
  id: string;
  buildingId: string;
  title: string;
  detail: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  openedAt: string;
  acknowledgedAt?: string;
}

export interface MaintenanceWindow {
  id: string;
  reason: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
}

export interface ConfigRevision {
  id: string;
  capturedAt: string;
  label: string;
  hash: string;
  changeCount: number;
  source: "scheduled" | "manual" | "pre_action";
  snapshot: Record<string, string>;
}

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

export interface ConfigDiff {
  fromRevisionId: string;
  toRevisionId: string;
  changeCount: number;
  lines: DiffLine[];
}

export type JobStageKey = "validation" | "backup" | "execution" | "post_check" | "success";

export interface JobStage {
  key: JobStageKey;
  label: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  detail: string;
}

export type NetworkActionType =
  | "flush_dns_cache"
  | "renew_dhcp_lease"
  | "cycle_access_port"
  | "reboot_router";

export interface NetworkActionRequest {
  type: NetworkActionType;
  reason: string;
  fields: Record<string, string | number | boolean>;
  confirmation?: string;
}

export interface NetworkActor {
  id: string;
  label: string;
}

export interface NetworkMutationTarget {
  buildingId: string;
  buildingName: string;
  routerIdentity: string;
  interfaceId?: string;
  interfaceName?: string;
  incidentId?: string;
  maintenanceId?: string;
  revisionId?: string;
}

export type NetworkJobStatus = "queued" | "running" | "success" | "failed" | "rolled_back";

export interface NetworkJob {
  id: string;
  buildingId: string;
  action: NetworkActionType;
  actionLabel: string;
  reason: string;
  actor: NetworkActor;
  target: NetworkMutationTarget;
  parameters: Record<string, string | number | boolean>;
  status: NetworkJobStatus;
  createdAt: string;
  validation: { status: "passed" | "failed"; detail: string };
  stages: JobStage[];
  result: string;
  rollback: {
    available: boolean;
    performed: boolean;
    status: "not_required" | "available" | "completed" | "failed";
    detail: string;
  };
  reconciliation: {
    status: "matched" | "drifted" | "not_required";
    detail: string;
  };
}

export type NetworkAuditAction =
  | NetworkActionType
  | "acknowledge_incident"
  | "create_maintenance"
  | "cancel_maintenance"
  | "capture_configuration"
  | "update_settings"
  | "health_check";

export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  actorId: string;
  actionType: NetworkAuditAction;
  action: string;
  target: NetworkMutationTarget;
  parameters: Record<string, string | number | boolean>;
  detail: string;
  reason: string;
  validation: string;
  result: string;
  outcome: "success" | "info";
}

export interface NetworkSettings {
  pollingSeconds: number;
  backupHour: string;
  alertSensitivity: "standard" | "strict";
  dependencyGrouping: boolean;
  changesPaused: boolean;
}

export interface NetworkBuilding {
  buildingId: string;
  buildingName: string;
  roomsCount: number;
  health: NetworkHealth;
  backupStatus: BackupStatus;
  backupAgeHours: number;
  uptimePercent: number;
  mttrMinutes: number;
  activeClients: number;
  router: RouterSummary;
  interfaces: InterfaceRecord[];
  clients: ClientRecord[];
  arubaNodes: ArubaNode[];
  /** Fleet-level aggregate; detail pages fill exact online state after cursor pagination. */
  arubaTotal?: number;
  arubaOnline?: number | null;
  incidents: NetworkIncident[];
  maintenance: MaintenanceWindow | null;
  revisions: ConfigRevision[];
  jobs: NetworkJob[];
  audit: AuditRecord[];
  settings: NetworkSettings;
  settingsVersion: number;
}

export interface FleetFilters {
  search?: string;
  health?: NetworkHealth | "all";
  severity?: IncidentSeverity | "all";
  backup?: BackupStatus | "all";
  firmware?: "drift" | "all";
}

export interface FleetSummary {
  online: number;
  degraded: number;
  offline: number;
  openIncidents: number;
  staleBackups: number;
  activeMaintenance: number;
}

export interface MaintenanceInput {
  durationMinutes: number;
  reason: string;
}

export interface NetworkCenterRepository {
  listFleet(): Promise<NetworkBuilding[]>;
  getBuilding(buildingId: string, fallback?: NetworkBuilding): Promise<NetworkBuilding | null>;
  listArubaPage(
    buildingId: string,
    cursor?: ArubaPageCursor | null,
    limit?: number,
  ): Promise<ArubaPage>;
  acknowledgeIncident(
    buildingId: string,
    incidentId: string,
    actor: NetworkActor,
    requestId?: string,
  ): Promise<void>;
  createMaintenance(
    buildingId: string,
    input: MaintenanceInput,
    actor: NetworkActor,
    requestId?: string,
  ): Promise<MaintenanceWindow>;
  cancelMaintenance(
    buildingId: string,
    maintenanceId: string,
    actor: NetworkActor,
    requestId?: string,
  ): Promise<void>;
  captureConfiguration(
    buildingId: string,
    label: string,
    actor: NetworkActor,
    requestId?: string,
  ): Promise<void>;
  compareRevisions(
    buildingId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<ConfigDiff>;
  executeAction(
    buildingId: string,
    request: NetworkActionRequest,
    actor: NetworkActor,
    requestId?: string,
  ): Promise<NetworkJob>;
  updateSettings(
    buildingId: string,
    settings: Partial<NetworkSettings>,
    actor: NetworkActor,
    requestId?: string,
    expectedVersion?: number,
  ): Promise<void>;
}
