export type NetworkHealth = "online" | "degraded" | "offline";
export type IncidentSeverity = "critical" | "high" | "medium" | "low";
export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type BackupStatus = "fresh" | "stale";
export type NetworkRolloutState = "OFF" | "READ_ONLY" | "EXECUTE";

export interface PhysicalBuildingRecord {
  id: string;
  name: string;
  roomsCount?: number;
  organizationId?: string;
  rolloutState?: NetworkRolloutState;
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

/**
 * Router downstream không nói LLDP — hôm nay là ZTE H196A ở 950NK.
 *
 * KHÔNG dùng chung `ArubaNode` dù nhìn na ná, vì hai bên biết được những thứ
 * khác nhau và gộp lại là bịa. `ArubaNode` có `model` (Aruba tự khai qua LLDP);
 * ở đây không có model, không serial, không firmware — không nguồn nào trên
 * MikroTik cho các giá trị đó. Đổi lại, chỗ này có `healthReason` và
 * `bridgePort`: `ArubaNode.status` không nói được vì sao nó là thế.
 */
export interface H196aNode {
  id: string;
  name: string;
  /** `unknown` nghĩa là CHƯA ĐO ĐƯỢC, không phải đã chết. */
  status: "online" | "stale" | "offline" | "unknown";
  address: string;
  /** Cổng vật lý khung tin đi vào; `null` khi vắng bảng bridge host. */
  bridgePort: string | null;
  /** Vì sao phán quyết là thế, để người đọc cãi lại được. */
  healthReason: string;
  /** Số lượt vắng mặt liên tiếp; OFFLINE bắt đầu từ 3. */
  absentPolls: number;
  lastSeenLabel: string;
}

export interface H196aPageCursor {
  sortOrder: number;
  id: string;
}

export interface H196aPage {
  items: H196aNode[];
  nextCursor: H196aPageCursor | null;
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

export type NetworkJobStatus =
  | "queued"
  | "running"
  | "uncertain"
  | "success"
  | "failed"
  | "rolled_back";

export interface NetworkJob {
  id: string;
  isStableIntent?: boolean;
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
    status: "matched" | "drifted" | "uncertain" | "not_required";
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
  rolloutState: NetworkRolloutState;
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
  h196aNodes: H196aNode[];
  /** Fleet-level aggregate; detail pages fill exact online state after cursor pagination. */
  arubaTotal?: number;
  arubaOnline?: number | null;
  h196aTotal?: number;
  /** `null` nghĩa là chưa biết. Hiện `—`, tuyệt đối không hiện `0`. */
  h196aOnline?: number | null;
  incidents: NetworkIncident[];
  maintenance: MaintenanceWindow | null;
  revisions: ConfigRevision[];
  jobs: NetworkJob[];
  audit: AuditRecord[];
  /** `null` = toà chưa được provisioning (không có dòng `network_site_settings`). */
  settings: NetworkSettings | null;
  settingsVersion: number | null;
  /**
   * Chỉ được đặt khi RPC chi tiết của RIÊNG toà này thất bại thật. Hàng vẫn giữ
   * nguyên số liệu do RPC hạm đội trả về — KHÔNG bịa dữ liệu thay thế — và UI
   * phải nói rõ phần chi tiết chưa tải được.
   */
  detailError?: string;
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
  listH196aPage(
    buildingId: string,
    cursor?: H196aPageCursor | null,
    limit?: number,
  ): Promise<H196aPage>;

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
  getCommand?(
    buildingId: string,
    lookup: { commandId?: string | null; requestId?: string | null },
  ): Promise<NetworkJob>;
  updateSettings(
    buildingId: string,
    settings: Partial<NetworkSettings>,
    actor: NetworkActor,
    requestId?: string,
    expectedVersion?: number,
  ): Promise<void>;
}
