import { z } from "zod";

import type {
  ArubaPage,
  ArubaNode,
  AuditRecord,
  ClientRecord,
  ConfigDiff,
  ConfigRevision,
  InterfaceRecord,
  MaintenanceWindow,
  NetworkActionType,
  NetworkAuditAction,
  NetworkBuilding,
  NetworkHealth,
  NetworkIncident,
  NetworkJob,
  NetworkMutationTarget,
  NetworkRolloutState,
  NetworkSettings,
} from "./contracts";

export const NETWORK_CENTER_PAGE_SIZE = 100;
export const NETWORK_CENTER_ARUBA_PAGE_SIZE = 100;
export const NETWORK_CENTER_ARUBA_MAX_PAGE_SIZE = 250;
export const NETWORK_CENTER_MAX_FLEET_SIZE = 500;

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const nullableTimestampSchema = timestampSchema.nullable();
const nullableNumberSchema = z.number().finite().nullable();
const nullableStringSchema = z.string().nullable();
const jsonObjectSchema = z.record(z.unknown());
const rolloutStateSchema = z.enum(["OFF", "READ_ONLY", "EXECUTE"]).catch("OFF");

const fleetItemSchema = z.object({
  buildingId: uuidSchema,
  buildingName: z.string().min(1).max(300),
  rolloutState: rolloutStateSchema,
  roomsCount: z.number().int().nonnegative(),
  routerId: uuidSchema.nullable(),
  routerIdentity: nullableStringSchema,
  routerModel: nullableStringSchema,
  targetFirmware: nullableStringSchema,
  lifecycleStatus: nullableStringSchema,
  reachable: z.boolean(),
  healthStatus: z.string(),
  lastSeenAt: nullableTimestampSchema,
  routerosVersion: nullableStringSchema,
  cpuPercent: nullableNumberSchema,
  memoryUsedBytes: nullableNumberSchema,
  memoryTotalBytes: nullableNumberSchema,
  pppoeState: nullableStringSchema,
  connectionCount: z.number().int().nonnegative().nullable(),
  arubaCount: z.number().int().nonnegative(),
  openIncidents: z.number().int().nonnegative(),
  activeClients: z.number().int().nonnegative(),
  lastBackupAt: nullableTimestampSchema,
  uptimePercent: nullableNumberSchema,
  mttrSeconds: nullableNumberSchema,
  maintenanceActive: z.boolean(),
});

const fleetSchema = z.object({
  items: z.array(fleetItemSchema).max(NETWORK_CENTER_MAX_FLEET_SIZE),
});

const routerSchema = z.object({
  id: uuidSchema,
  identity: nullableStringSchema,
  externalKey: z.string(),
  model: nullableStringSchema,
  firmware: nullableStringSchema,
  targetFirmware: nullableStringSchema,
  lifecycleStatus: z.string(),
  reachable: z.boolean(),
  healthStatus: z.string(),
  lastSeenAt: nullableTimestampSchema,
  cpuPercent: nullableNumberSchema,
  memoryUsedBytes: nullableNumberSchema,
  memoryTotalBytes: nullableNumberSchema,
  diskUsedBytes: nullableNumberSchema,
  diskTotalBytes: nullableNumberSchema,
  temperatureC: nullableNumberSchema,
  voltageV: nullableNumberSchema,
  pppoeState: nullableStringSchema,
  connectionCount: z.number().int().nonnegative().nullable(),
});

const interfaceSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  key: z.string(),
  role: z.string(),
  protected: z.boolean(),
  enabled: z.boolean(),
  linkState: nullableStringSchema,
  rxBps: nullableNumberSchema,
  txBps: nullableNumberSchema,
  utilizationPercent: nullableNumberSchema,
  errors: z.number().int().nonnegative().nullable(),
  discards: z.number().int().nonnegative().nullable(),
  queueDrops: z.number().int().nonnegative().nullable(),
});

const incidentSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  detail: z.string(),
  severity: z.string(),
  status: z.string(),
  openedAt: timestampSchema,
  acknowledgedAt: nullableTimestampSchema,
});

const maintenanceSchema = z.object({
  id: uuidSchema,
  reason: z.string(),
  startsAt: timestampSchema,
  endsAt: timestampSchema,
  status: z.string(),
}).nullable();

const revisionSchema = z.object({
  id: uuidSchema,
  capturedAt: timestampSchema,
  label: z.string(),
  hash: z.string().min(1).max(256),
  source: z.string(),
  schemaVersion: z.number().int().positive(),
});

const settingsSchema = z.object({
  pollingSeconds: z.number().int().min(30).max(300),
  backupHour: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  alertSensitivity: z.enum(["standard", "strict"]),
  dependencyGrouping: z.boolean(),
  changesPaused: z.boolean(),
  version: z.number().int().positive(),
});

// Toà nhà CHƯA có dòng `network_site_settings`: RPC vẫn trả 200 nhưng LEFT JOIN
// cho ra một object toàn null. Đó là trạng thái RỖNG hợp lệ (chưa provisioning),
// KHÔNG phải vi phạm hợp đồng — đọc thành `null` để UI hiển thị trạng thái rỗng
// bình tĩnh. Mọi hình dạng khác (nửa null, số ngoài khoảng…) vẫn là lỗi thật.
const absentSettingsSchema = z.object({
  pollingSeconds: z.null(),
  backupHour: z.null(),
  alertSensitivity: z.null(),
  dependencyGrouping: z.null(),
  changesPaused: z.null(),
  version: z.null(),
}).transform(() => null);

const settingsOrAbsentSchema = z.union([settingsSchema, absentSettingsSchema]);

const buildingSchema = z.object({
  buildingId: uuidSchema,
  buildingName: z.string().min(1).max(300),
  rolloutState: rolloutStateSchema,
  roomsCount: z.number().int().nonnegative(),
  router: routerSchema.nullable(),
  interfaces: z.array(interfaceSchema).max(256),
  incidents: z.array(incidentSchema).max(500),
  maintenance: maintenanceSchema,
  revisions: z.array(revisionSchema).max(50),
  settings: settingsOrAbsentSchema,
});

const arubaItemSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  model: nullableStringSchema,
  externalKey: z.string(),
  lifecycleStatus: z.string(),
  reachable: z.boolean(),
  healthStatus: nullableStringSchema,
  lastSeenAt: nullableTimestampSchema,
  address: nullableStringSchema,
});

const arubaCursorSchema = z.object({
  sortOrder: z.number().int(),
  id: uuidSchema,
});

const arubaPageSchema = z.object({
  items: z.array(arubaItemSchema).max(NETWORK_CENTER_ARUBA_MAX_PAGE_SIZE),
  nextCursor: arubaCursorSchema.nullable(),
});

const clientItemSchema = z.object({
  id: uuidSchema,
  hostname: nullableStringSchema,
  address: nullableStringSchema,
  macAddress: nullableStringSchema,
  sessionType: z.string(),
  connectionType: z.string(),
  roomHint: nullableStringSchema,
  customerName: nullableStringSchema,
  roomId: uuidSchema.nullable(),
  contractId: uuidSchema.nullable(),
  customerId: uuidSchema.nullable(),
  rxBps: nullableNumberSchema,
  txBps: nullableNumberSchema,
  randomizedMac: z.boolean(),
  sessionIdentity: z.string(),
  lastSeenAt: timestampSchema,
  expiresAt: timestampSchema,
});

const clientCursorSchema = z.object({ seenAt: timestampSchema, id: uuidSchema });
const clientPageSchema = z.object({
  items: z.array(clientItemSchema).max(NETWORK_CENTER_PAGE_SIZE),
  nextCursor: clientCursorSchema.nullable(),
});

const commandItemSchema = z.object({
  id: uuidSchema,
  actionType: z.string(),
  reason: z.string(),
  parameters: jsonObjectSchema,
  target: jsonObjectSchema,
  requestedBy: uuidSchema,
  status: z.string(),
  attemptCount: z.number().int().nonnegative(),
  result: jsonObjectSchema.nullable(),
  rollback: jsonObjectSchema.nullable(),
  reconciliationState: z.string(),
  transitionVersion: z.number().int().positive().optional(),
  createdAt: timestampSchema,
  startedAt: nullableTimestampSchema,
  finishedAt: nullableTimestampSchema,
});

const timeCursorSchema = z.object({ createdAt: timestampSchema, id: uuidSchema });
const commandPageSchema = z.object({
  items: z.array(commandItemSchema).max(NETWORK_CENTER_PAGE_SIZE),
  nextCursor: timeCursorSchema.nullable(),
});

const auditItemSchema = z.object({
  id: uuidSchema,
  at: timestampSchema,
  actorType: z.string(),
  actorId: uuidSchema.nullable(),
  workerId: nullableStringSchema,
  action: z.string(),
  targetType: z.string(),
  targetId: uuidSchema.nullable(),
  target: jsonObjectSchema,
  reason: z.string(),
  validation: jsonObjectSchema,
  result: jsonObjectSchema,
  outcome: z.string(),
  commandId: uuidSchema.nullable(),
});

const auditCursorSchema = z.object({ occurredAt: timestampSchema, id: uuidSchema });
const auditPageSchema = z.object({
  items: z.array(auditItemSchema).max(NETWORK_CENTER_PAGE_SIZE),
  nextCursor: auditCursorSchema.nullable(),
});

const diffSchema = z.object({
  fromRevisionId: uuidSchema,
  toRevisionId: uuidSchema,
  changeCount: z.number().int().nonnegative(),
  lines: z.array(z.object({
    kind: z.enum(["context", "added", "removed"]),
    text: z.string().max(20_000),
  })).max(20_000),
});

const maintenanceResultSchema = z.object({
  id: uuidSchema,
  reason: z.string(),
  startsAt: timestampSchema,
  endsAt: timestampSchema,
  status: z.string(),
});

const executeResultSchema = z.object({
  commandId: uuidSchema,
  status: z.string(),
  actionType: z.string(),
  reason: z.string(),
  parameters: jsonObjectSchema,
  target: jsonObjectSchema,
});

const settingsResultSchema = settingsSchema;

const acknowledgementResultSchema = z.object({
  incidentId: uuidSchema,
  status: z.string(),
  acknowledgedAt: nullableTimestampSchema,
  acknowledgedBy: uuidSchema.nullable(),
});

const cancellationResultSchema = z.object({
  id: uuidSchema,
  status: z.string(),
  cancelledAt: nullableTimestampSchema,
});

const snapshotRequestResultSchema = z.object({
  commandId: uuidSchema,
  status: z.string(),
  label: z.string(),
});

export type NetworkCenterFleetDto = z.infer<typeof fleetSchema>;
export type NetworkCenterFleetItemDto = z.infer<typeof fleetItemSchema>;
export type NetworkCenterBuildingDto = z.infer<typeof buildingSchema>;
export type NetworkCenterArubaPageDto = z.infer<typeof arubaPageSchema>;
export type NetworkCenterClientPageDto = z.infer<typeof clientPageSchema>;
export type NetworkCenterCommandPageDto = z.infer<typeof commandPageSchema>;
export type NetworkCenterCommandDto = z.infer<typeof commandItemSchema>;
export type NetworkCenterAuditPageDto = z.infer<typeof auditPageSchema>;
export type NetworkCenterExecuteResultDto = z.infer<typeof executeResultSchema>;

export function parseNetworkCenterFleet(value: unknown): NetworkCenterFleetDto {
  return fleetSchema.parse(value);
}

export function parseNetworkCenterBuilding(value: unknown): NetworkCenterBuildingDto {
  return buildingSchema.parse(value);
}

export function parseNetworkCenterArubaPage(value: unknown): NetworkCenterArubaPageDto {
  return arubaPageSchema.parse(value);
}

export function parseNetworkCenterClientPage(value: unknown): NetworkCenterClientPageDto {
  return clientPageSchema.parse(value);
}

export function parseNetworkCenterCommandPage(value: unknown): NetworkCenterCommandPageDto {
  return commandPageSchema.parse(value);
}

export function parseNetworkCenterCommand(value: unknown): NetworkCenterCommandDto {
  return commandItemSchema.parse(value);
}

export function parseNetworkCenterAuditPage(value: unknown): NetworkCenterAuditPageDto {
  return auditPageSchema.parse(value);
}

export function parseNetworkCenterDiff(value: unknown): ConfigDiff {
  const parsed = diffSchema.parse(value);
  return {
    fromRevisionId: parsed.fromRevisionId!,
    toRevisionId: parsed.toRevisionId!,
    changeCount: parsed.changeCount!,
    lines: parsed.lines!.map((line) => ({
      kind: line.kind!,
      text: line.text!,
    })),
  };
}

export function parseNetworkCenterMaintenanceResult(value: unknown) {
  return maintenanceResultSchema.parse(value);
}

export function parseNetworkCenterExecuteResult(value: unknown): NetworkCenterExecuteResultDto {
  return executeResultSchema.parse(value);
}

export function parseNetworkCenterSettingsResult(value: unknown) {
  return settingsResultSchema.parse(value);
}

export function parseNetworkCenterAcknowledgementResult(value: unknown) {
  return acknowledgementResultSchema.parse(value);
}

export function parseNetworkCenterCancellationResult(value: unknown) {
  return cancellationResultSchema.parse(value);
}

export function parseNetworkCenterSnapshotRequestResult(value: unknown) {
  return snapshotRequestResultSchema.parse(value);
}

function normalizeLifecycle(value: string | null | undefined): NetworkBuilding["router"]["lifecycleStatus"] {
  switch (value?.toUpperCase()) {
    case "PROVISIONING":
    case "ONLINE":
    case "OFFLINE":
    case "DISABLED":
      return value.toUpperCase() as NetworkBuilding["router"]["lifecycleStatus"];
    default:
      return "UNPROVISIONED";
  }
}

function mapHealth(reachable: boolean, status: string, lifecycle: string | null | undefined): NetworkHealth {
  if (normalizeLifecycle(lifecycle) === "UNPROVISIONED" || !reachable) return "offline";
  const normalized = status.toUpperCase();
  if (normalized === "HEALTHY" || normalized === "ONLINE") return "online";
  return "degraded";
}

function percentage(used: number | null, total: number | null): number {
  if (!used || !total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

function mbps(value: number | null): number {
  return value ? Math.round((value / 1_000_000) * 100) / 100 : 0;
}

function ageHours(timestamp: string | null, now: number): number {
  if (!timestamp) return -1;
  return Math.max(0, Math.floor((now - Date.parse(timestamp)) / 3_600_000));
}

function lastSeenLabel(timestamp: string | null, lifecycle: string | null | undefined, now: number): string {
  if (!timestamp) {
    return normalizeLifecycle(lifecycle) === "UNPROVISIONED" ? "Chưa kết nối" : "Chưa có dữ liệu";
  }
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000));
  if (seconds < 60) return `${seconds} giây trước`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} phút trước`;
  return `${Math.floor(seconds / 3_600)} giờ trước`;
}

function mapIncident(buildingId: string, item: z.infer<typeof incidentSchema>): NetworkIncident {
  const severity = item.severity.toUpperCase();
  const status = item.status.toUpperCase();
  return {
    id: item.id,
    buildingId,
    title: item.title,
    detail: item.detail,
    severity: severity === "CRITICAL" ? "critical" : severity === "WARNING" ? "high" : "low",
    status: status === "ACKNOWLEDGED" ? "acknowledged" : status === "RESOLVED" ? "resolved" : "open",
    openedAt: item.openedAt,
    acknowledgedAt: item.acknowledgedAt ?? undefined,
  };
}

function mapInterface(item: z.infer<typeof interfaceSchema>): InterfaceRecord {
  const role = item.role.toUpperCase();
  return {
    id: item.id,
    name: item.name,
    role: role === "WAN" ? "wan" : role === "UPLINK" ? "uplink" : "lan",
    status: item.enabled && item.linkState?.toUpperCase() === "UP" ? "up" : "down",
    protected: item.protected,
    rxMbps: mbps(item.rxBps),
    txMbps: mbps(item.txBps),
    utilizationPercent: item.utilizationPercent ?? 0,
    errors: item.errors ?? 0,
    discards: item.discards ?? 0,
  };
}

function mapMaintenance(item: z.infer<typeof maintenanceSchema>): MaintenanceWindow | null {
  if (!item) return null;
  return {
    id: item.id,
    reason: item.reason,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    durationMinutes: Math.max(0, Math.round((Date.parse(item.endsAt) - Date.parse(item.startsAt)) / 60_000)),
  };
}

function mapRevision(item: z.infer<typeof revisionSchema>): ConfigRevision {
  const source = item.source.toUpperCase();
  return {
    id: item.id,
    capturedAt: item.capturedAt,
    label: item.label,
    hash: item.hash,
    changeCount: 0,
    source: source === "SCHEDULED" ? "scheduled" : source === "PRE_ACTION" ? "pre_action" : "manual",
    snapshot: {},
  };
}

function settingsFromDto(item: z.infer<typeof settingsSchema>): NetworkSettings {
  return {
    pollingSeconds: item.pollingSeconds,
    backupHour: item.backupHour,
    alertSensitivity: item.alertSensitivity,
    dependencyGrouping: item.dependencyGrouping,
    changesPaused: item.changesPaused,
  };
}

function baseFleetBuilding(item: NetworkCenterFleetItemDto, now: number): NetworkBuilding {
  const lifecycle = normalizeLifecycle(item.lifecycleStatus);
  const backupAgeHours = ageHours(item.lastBackupAt, now);
  const identity = item.routerIdentity?.trim() || "MikroTik chưa kết nối";
  return {
    buildingId: item.buildingId,
    buildingName: item.buildingName,
    rolloutState: item.rolloutState as NetworkRolloutState,
    roomsCount: item.roomsCount,
    health: mapHealth(item.reachable, item.healthStatus, item.lifecycleStatus),
    backupStatus: backupAgeHours >= 0 && backupAgeHours <= 30 ? "fresh" : "stale",
    backupAgeHours,
    uptimePercent: item.uptimePercent ?? 0,
    mttrMinutes: item.mttrSeconds === null ? 0 : Math.round(item.mttrSeconds / 60),
    activeClients: item.activeClients,
    router: {
      id: item.routerId,
      identity,
      model: item.routerModel?.trim() || "Chưa xác định",
      firmware: item.routerosVersion?.trim() || (lifecycle === "UNPROVISIONED" ? "Chưa kết nối" : "Chưa có dữ liệu"),
      targetFirmware: item.targetFirmware?.trim() || "Chưa cấu hình",
      lifecycleStatus: lifecycle,
      wanStatus: item.reachable ? "up" : "down",
      lastSeenLabel: lastSeenLabel(item.lastSeenAt, item.lifecycleStatus, now),
      cpuPercent: item.cpuPercent ?? 0,
      memoryPercent: percentage(item.memoryUsedBytes, item.memoryTotalBytes),
      downloadMbps: 0,
      uploadMbps: 0,
    },
    interfaces: [],
    clients: [],
    arubaNodes: [],
    arubaTotal: item.arubaCount,
    arubaOnline: null,
    incidents: [],
    maintenance: null,
    revisions: [],
    jobs: [],
    audit: [],
    // RPC hạm đội KHÔNG trả cài đặt. Không bịa giá trị mặc định ở đây — chỉ RPC
    // chi tiết mới biết toà có dòng `network_site_settings` hay không.
    settings: null,
    settingsVersion: null,
  };
}

export function mapNetworkCenterFleetItem(
  item: NetworkCenterFleetItemDto,
  detail?: NetworkCenterBuildingDto,
  now = Date.now(),
): NetworkBuilding {
  const building = baseFleetBuilding(item, now);
  if (!detail) return building;
  const merged = mergeNetworkCenterBuilding(building, detail, [], [], [], [], now);
  // The fleet RPC carries the aggregate; detail pagination is intentionally deferred.
  merged.arubaTotal = item.arubaCount;
  merged.arubaOnline = null;
  return merged;
}

function mapAruba(item: z.infer<typeof arubaItemSchema>, now: number): ArubaNode {
  return {
    id: item.id,
    name: item.name,
    status: !item.reachable
      ? "offline"
      : item.healthStatus?.toUpperCase() === "HEALTHY"
        ? "online"
        : "slow",
    address: item.address ?? "Chưa xác định",
    uplink: "Chưa xác định",
    lastSeenLabel: lastSeenLabel(item.lastSeenAt, item.lifecycleStatus, now),
  };
}

export function mapNetworkCenterArubaPage(
  page: NetworkCenterArubaPageDto,
  now = Date.now(),
): ArubaPage {
  return {
    items: page.items.map((item) => mapAruba(item, now)),
    nextCursor: page.nextCursor
      ? { sortOrder: page.nextCursor.sortOrder!, id: page.nextCursor.id! }
      : null,
  };
}

function mapClient(item: z.infer<typeof clientItemSchema>): ClientRecord {
  const connection = item.connectionType.toLowerCase();
  return {
    id: item.id,
    hostname: item.hostname ?? "Thiết bị chưa đặt tên",
    address: item.address ?? "—",
    macAddress: item.macAddress ?? "—",
    connection: connection === "hotspot" ? "hotspot" : connection === "static" ? "static" : "dhcp",
    roomHint: item.roomHint ?? "Chưa liên kết phòng",
    rxMbps: mbps(item.rxBps),
    txMbps: mbps(item.txBps),
    randomizedMac: item.randomizedMac,
    userIdentity: item.customerName ?? item.roomHint ?? "Chưa liên kết khách thuê",
    sessionIdentity: item.sessionIdentity,
  };
}

const ACTION_TYPES = new Set<NetworkActionType>([
  "flush_dns_cache",
  "renew_dhcp_lease",
  "cycle_access_port",
  "reboot_router",
]);

const ACTION_LABELS: Record<NetworkActionType, string> = {
  flush_dns_cache: "Làm mới bộ nhớ đệm DNS",
  renew_dhcp_lease: "Làm mới DHCP lease",
  cycle_access_port: "Tắt/bật cổng truy cập",
  reboot_router: "Khởi động lại MikroTik",
};

function primitiveRecord(value: Record<string, unknown>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      result[key] = item;
    }
  }
  return result;
}

function stringField(value: Record<string, unknown>, key: string, fallback: string): string {
  return typeof value[key] === "string" && value[key] ? value[key] : fallback;
}

function mapTarget(
  building: Pick<NetworkBuilding, "buildingId" | "buildingName" | "router">,
  value: Record<string, unknown>,
): NetworkMutationTarget {
  return {
    buildingId: stringField(value, "buildingId", building.buildingId),
    buildingName: stringField(value, "buildingName", building.buildingName),
    routerIdentity: stringField(value, "routerIdentity", building.router.identity),
    interfaceId: typeof value.interfaceId === "string" ? value.interfaceId : undefined,
    interfaceName: typeof value.interfaceName === "string" ? value.interfaceName : undefined,
  };
}

function mapJob(
  building: Pick<NetworkBuilding, "buildingId" | "buildingName" | "router">,
  item: z.infer<typeof commandItemSchema>,
): NetworkJob | null {
  const action = item.actionType.toLowerCase() as NetworkActionType;
  if (!ACTION_TYPES.has(action)) return null;
  const rawStatus = item.status.toUpperCase();
  const status: NetworkJob["status"] = rawStatus === "SUCCEEDED"
    ? "success"
    : rawStatus === "UNCERTAIN"
      ? "uncertain"
      : rawStatus === "FAILED" || rawStatus.startsWith("CANCELLED")
        ? "failed"
        : rawStatus === "LEASED" || rawStatus === "RUNNING" || rawStatus === "RECONCILING"
          ? "running"
          : "queued";
  const finished = status === "success" || status === "failed";
  const running = status === "running";
  const resultMessage = item.result && typeof item.result.message === "string"
    ? item.result.message
    : status === "queued"
      ? "Đang chờ worker xử lý"
      : status === "running"
        ? "Worker đang thực hiện và kiểm tra"
        : status === "uncertain"
          ? "Chưa đủ bằng chứng hậu kiểm; chưa thể kết luận thành công hay thất bại"
          : status === "success"
          ? "Worker đã hoàn tất và đối soát"
          : "Thao tác không hoàn tất";
  return {
    id: item.id,
    buildingId: building.buildingId,
    action,
    actionLabel: ACTION_LABELS[action],
    reason: item.reason,
    actor: { id: item.requestedBy, label: "Người dùng iHomeCRM" },
    target: mapTarget(building, item.target),
    parameters: primitiveRecord(item.parameters),
    status,
    createdAt: item.createdAt,
    validation: { status: "passed", detail: "Đã được RPC xác thực quyền và đầu vào" },
    stages: [
      { key: "validation", label: "Kiểm tra đầu vào", status: "success", detail: "Đã xác thực" },
      { key: "backup", label: "Backup", status: finished ? "success" : running ? "running" : "pending", detail: "Worker quản lý backup trước thao tác" },
      { key: "execution", label: "Thực hiện", status: finished ? (status === "success" ? "success" : "failed") : running || status === "uncertain" ? "running" : "pending", detail: resultMessage },
      { key: "post_check", label: "Kiểm tra sau", status: status === "success" ? "success" : finished ? "failed" : status === "uncertain" ? "running" : "pending", detail: "Đối soát trạng thái thiết bị" },
      { key: "success", label: "Hoàn tất", status: status === "success" ? "success" : status === "failed" ? "failed" : "pending", detail: resultMessage },
    ],
    result: resultMessage,
    rollback: {
      available: item.rollback !== null,
      performed: false,
      status: item.rollback ? "available" : "not_required",
      detail: item.rollback ? "Có dữ liệu rollback đã làm sạch" : "Chưa cần rollback",
    },
    reconciliation: {
      status: rawStatus === "UNCERTAIN" || item.reconciliationState.toUpperCase() === "REQUIRED"
        ? "uncertain"
        : item.reconciliationState.toUpperCase() === "CONFIRMED"
          ? "matched"
          : item.reconciliationState.toUpperCase() === "FAILED"
            ? "drifted"
            : "not_required",
      detail: `Trạng thái đối soát: ${item.reconciliationState}`,
    },
  };
}

export function mapNetworkCenterCommand(item: NetworkCenterCommandDto): NetworkJob {
  const buildingId = stringField(item.target, "buildingId", "unknown-building");
  const buildingName = stringField(item.target, "buildingName", "Network Center");
  const routerIdentity = stringField(item.target, "routerIdentity", "MikroTik");
  const job = mapJob({
    buildingId,
    buildingName,
    router: { identity: routerIdentity } as NetworkBuilding["router"],
  }, item);
  if (!job) throw new Error("Unsupported Network Center command response");
  return job;
}

const AUDIT_ACTIONS = new Set<NetworkAuditAction>([
  ...ACTION_TYPES,
  "acknowledge_incident",
  "create_maintenance",
  "cancel_maintenance",
  "capture_configuration",
  "update_settings",
  "health_check",
]);

function mapAudit(
  building: NetworkBuilding,
  item: z.infer<typeof auditItemSchema>,
): AuditRecord {
  const candidate = item.action.toLowerCase() as NetworkAuditAction;
  const actionType = AUDIT_ACTIONS.has(candidate) ? candidate : "health_check";
  return {
    id: item.id,
    at: item.at,
    actor: item.actorType.toUpperCase() === "WORKER" ? item.workerId ?? "Network worker" : "Người dùng iHomeCRM",
    actorId: item.actorId ?? item.workerId ?? "network-worker",
    actionType,
    action: actionType in ACTION_LABELS
      ? ACTION_LABELS[actionType as NetworkActionType]
      : item.action.split("_").join(" "),
    target: mapTarget(building, item.target),
    parameters: primitiveRecord(item.result),
    detail: item.reason,
    reason: item.reason,
    validation: JSON.stringify(item.validation),
    result: JSON.stringify(item.result),
    outcome: item.outcome.toUpperCase() === "SUCCEEDED" ? "success" : "info",
  };
}

export function mergeNetworkCenterBuilding(
  fallback: NetworkBuilding,
  detail: NetworkCenterBuildingDto,
  arubaItems: NetworkCenterArubaPageDto["items"],
  clientItems: NetworkCenterClientPageDto["items"],
  commandItems: NetworkCenterCommandPageDto["items"],
  auditItems: NetworkCenterAuditPageDto["items"],
  now = Date.now(),
): NetworkBuilding {
  const interfaces = detail.interfaces.map(mapInterface);
  const mappedArubaNodes = arubaItems.map((item) => mapAruba(item, now));
  const arubaNodes = mappedArubaNodes.length > 0 ? mappedArubaNodes : fallback.arubaNodes;
  const arubaTotal = Math.max(fallback.arubaTotal ?? 0, arubaNodes.length);
  const loadedAllAruba = arubaNodes.length >= arubaTotal;
  const wan = interfaces.find((item) => item.role === "wan");
  const router = detail.router;
  const lifecycle = normalizeLifecycle(router?.lifecycleStatus);
  const merged: NetworkBuilding = {
    ...fallback,
    buildingId: detail.buildingId,
    buildingName: detail.buildingName,
    rolloutState: detail.rolloutState as NetworkRolloutState,
    roomsCount: detail.roomsCount,
    health: router
      ? mapHealth(router.reachable, router.healthStatus, router.lifecycleStatus)
      : "offline",
    router: {
      id: router?.id ?? null,
      identity: router?.identity?.trim() || fallback.router.identity,
      model: router?.model?.trim() || "Chưa xác định",
      firmware: router?.firmware?.trim() || (lifecycle === "UNPROVISIONED" ? "Chưa kết nối" : "Chưa có dữ liệu"),
      targetFirmware: router?.targetFirmware?.trim() || "Chưa cấu hình",
      lifecycleStatus: lifecycle,
      wanStatus: wan?.status ?? (router?.reachable ? "up" : "down"),
      lastSeenLabel: lastSeenLabel(router?.lastSeenAt ?? null, router?.lifecycleStatus, now),
      cpuPercent: router?.cpuPercent ?? 0,
      memoryPercent: percentage(router?.memoryUsedBytes ?? null, router?.memoryTotalBytes ?? null),
      downloadMbps: wan?.rxMbps ?? 0,
      uploadMbps: wan?.txMbps ?? 0,
    },
    interfaces,
    incidents: detail.incidents.map((item) => mapIncident(detail.buildingId, item)),
    maintenance: mapMaintenance(detail.maintenance),
    revisions: detail.revisions.map(mapRevision),
    settings: detail.settings ? settingsFromDto(detail.settings) : null,
    settingsVersion: detail.settings?.version ?? null,
    arubaNodes,
    arubaTotal,
    arubaOnline: loadedAllAruba
      ? arubaNodes.filter((item) => item.status === "online").length
      : fallback.arubaOnline ?? null,
    clients: clientItems.map(mapClient),
    jobs: [],
    audit: [],
  };
  merged.jobs = commandItems.map((item) => mapJob(merged, item)).filter((item): item is NetworkJob => item !== null);
  merged.audit = auditItems.map((item) => mapAudit(merged, item));
  return merged;
}

export function mapNetworkCenterExecuteResult(
  building: NetworkBuilding,
  result: NetworkCenterExecuteResultDto,
  actor: { id: string; label: string },
  now = new Date().toISOString(),
): NetworkJob {
  const command = commandItemSchema.parse({
    id: result.commandId,
    actionType: result.actionType,
    reason: result.reason,
    parameters: result.parameters,
    target: result.target,
    requestedBy: "00000000-0000-4000-8000-000000000000",
    status: result.status,
    attemptCount: 0,
    result: null,
    rollback: null,
    reconciliationState: "NOT_REQUIRED",
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  });
  const job = mapJob(building, command);
  if (!job) throw new Error("Unsupported Network Center action response");
  job.actor = actor;
  return job;
}
