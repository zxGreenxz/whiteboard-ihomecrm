import type {
  ArubaPage,
  ArubaPageCursor,
  ArubaNode,
  AuditRecord,
  ClientRecord,
  ConfigDiff,
  ConfigRevision,
  InterfaceRecord,
  MaintenanceInput,
  MaintenanceWindow,
  NetworkActionRequest,
  NetworkActor,
  NetworkAuditAction,
  NetworkBuilding,
  NetworkHealth,
  NetworkIncident,
  NetworkJob,
  NetworkMutationTarget,
  NetworkSettings,
  PhysicalBuildingRecord,
} from "./contracts";
import {
  NETWORK_ACTION_DEFINITIONS,
  isMaintenanceActive,
  validateNetworkAction,
  validateNetworkSettings,
} from "./model";

/**
 * Toà MÔ PHỎNG luôn có cài đặt.
 *
 * `NetworkBuilding.settings`/`settingsVersion` khai `| null` để diễn đạt toà
 * THẬT chưa được provisioning (chưa có dòng `network_site_settings`). Trạng
 * thái đó không tồn tại trong bộ nhớ demo: `generateBuilding` seed đủ cả hai
 * trường cho mọi toà, và không có đường nào đặt chúng về `null`.
 *
 * Vì vậy kho demo giữ kiểu đã thu hẹp ở BÊN TRONG, thay vì rắc kiểm tra null
 * giả ở từng chỗ dùng. Chữ ký công khai không đổi — `DemoNetworkBuilding` vẫn
 * gán được vào `NetworkBuilding`.
 */
type DemoNetworkBuilding = NetworkBuilding & {
  settings: NetworkSettings;
  settingsVersion: number;
};

const DEMO_NOW = Date.UTC(2026, 6, 24, 3, 30, 0);
const REDACTED = "[ĐÃ ẨN]";
const MODELS = ["hEX S", "RB5009UG+S+", "L009UiGS", "CCR2004-1G-12S+2XS"];
const FIRMWARE = ["7.18.2", "7.19.1", "7.20.1"];
const SECRET_KEY_PATTERN = /(password|secret|token|credential|community|private.?key|pre.?shared|psk)/i;
const SECRET_VALUE_PATTERN = /(bearer\s+|-----BEGIN|password\s*=|secret\s*=|token\s*=)/i;

const clone = <T>(value: T): T => structuredClone(value);

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const seeded = (seed: number, offset: number, min: number, max: number): number =>
  min + ((seed >>> (offset % 16)) + offset * 7919) % (max - min + 1);

const atOffset = (minutes: number): string => new Date(DEMO_NOW + minutes * 60_000).toISOString();

function makeInterfaces(seed: number): InterfaceRecord[] {
  const wanDown = seed % 11 === 0;
  return [
    {
      id: "ether1-wan",
      name: "ether1 · WAN",
      role: "wan",
      status: wanDown ? "down" : "up",
      protected: true,
      rxMbps: wanDown ? 0 : seeded(seed, 1, 40, 190),
      txMbps: wanDown ? 0 : seeded(seed, 2, 10, 65),
      utilizationPercent: wanDown ? 0 : seeded(seed, 3, 18, 86),
      errors: seeded(seed, 4, 0, 9),
      discards: seeded(seed, 5, 0, 34),
    },
    {
      id: "sfp1-uplink",
      name: "sfp1 · Uplink Aruba",
      role: "uplink",
      status: "up",
      protected: true,
      rxMbps: seeded(seed, 6, 30, 140),
      txMbps: seeded(seed, 7, 12, 52),
      utilizationPercent: seeded(seed, 8, 14, 72),
      errors: seeded(seed, 9, 0, 4),
      discards: seeded(seed, 10, 0, 15),
    },
    ...[2, 3, 4].map((port, index): InterfaceRecord => {
      const status = seeded(seed, 11 + index, 0, 12) === 0 ? "down" : "up";
      return {
        id: `ether${port}-lan`,
        name: `ether${port} · LAN ${index + 1}`,
        role: "lan",
        status,
        protected: false,
        rxMbps: status === "down" ? 0 : seeded(seed, 14 + index, 2, 42),
        txMbps: status === "down" ? 0 : seeded(seed, 17 + index, 1, 24),
        utilizationPercent: status === "down" ? 0 : seeded(seed, 20 + index, 4, 58),
        errors: seeded(seed, 23 + index, 0, 3),
        discards: seeded(seed, 26 + index, 0, 8),
      };
    }),
  ];
}

function makeClients(seed: number, count: number): ClientRecord[] {
  return Array.from({ length: Math.min(12, Math.max(5, count)) }, (_, index) => {
    const randomizedMac = index % 4 === 0;
    const firstOctet = randomizedMac ? "02" : "00";
    return {
      id: `client-${seed.toString(16)}-${index + 1}`,
      hostname: `Thiết bị ${String(index + 1).padStart(2, "0")}`,
      address: `198.18.${seed % 200}.${20 + index}`,
      macAddress: `${firstOctet}:00:${(seed % 255).toString(16).padStart(2, "0")}:00:00:${(index + 1).toString(16).padStart(2, "0")}`,
      connection: (["dhcp", "hotspot", "static"] as const)[index % 3],
      roomHint: `Khu ${String.fromCharCode(65 + (index % 4))}-${index + 1}`,
      rxMbps: seeded(seed, 31 + index, 1, 24),
      txMbps: seeded(seed, 45 + index, 1, 12),
      randomizedMac,
      userIdentity: `demo-user-${seed.toString(16)}-${index + 1}`,
      sessionIdentity: `demo-session-${seed.toString(16)}-${index + 1}`,
    };
  });
}

function makeArubaNodes(seed: number): ArubaNode[] {
  const count = seeded(seed, 2, 4, 10);
  return Array.from({ length: count }, (_, index) => {
    const statusRoll = seeded(seed, 51 + index, 0, 15);
    return {
      id: `ap-${seed.toString(16)}-${index + 1}`,
      name: `Aruba AP ${String(index + 1).padStart(2, "0")}`,
      status: statusRoll === 0 ? "offline" : statusRoll < 4 ? "slow" : "online",
      address: `198.19.${seed % 200}.${40 + index}`,
      uplink: "sfp1-uplink",
      lastSeenLabel: statusRoll === 0 ? "9 phút trước" : `${seeded(seed, 60 + index, 8, 58)} giây trước`,
    };
  });
}

function makeIncidents(seed: number, buildingId: string, health: NetworkHealth): NetworkIncident[] {
  const primarySeverity = health === "offline" ? "critical" : health === "degraded" ? "high" : "medium";
  return [
    {
      id: `incident-${seed.toString(16)}-1`,
      buildingId,
      title: health === "offline" ? "MikroTik mất heartbeat mô phỏng" : "Queue drop vượt ngưỡng mô phỏng",
      detail: "Sự kiện tổng hợp từ dữ liệu mô phỏng; không chứa telemetry router thật.",
      severity: primarySeverity,
      status: "open",
      openedAt: atOffset(-seeded(seed, 70, 12, 240)),
    },
    {
      id: `incident-${seed.toString(16)}-2`,
      buildingId,
      title: "Độ trễ uplink từng tăng cao",
      detail: "Đã tự hồi phục trong cửa sổ theo dõi mô phỏng.",
      severity: "low",
      status: "resolved",
      openedAt: atOffset(-seeded(seed, 71, 400, 1_400)),
    },
  ];
}

export function sanitizeConfigSnapshot(snapshot: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshot)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, rawValue]) => {
        const value = String(rawValue);
        return [key, SECRET_KEY_PATTERN.test(key) || SECRET_VALUE_PATTERN.test(value) ? REDACTED : value];
      }),
  );
}

function snapshotForSite(
  site: Pick<DemoNetworkBuilding, "router" | "interfaces" | "settings">,
): Record<string, string> {
  const snapshot: Record<string, unknown> = {
    "router.identity": site.router.identity,
    "router.model": site.router.model,
    "router.firmware": site.router.firmware,
    "router.targetFirmware": site.router.targetFirmware,
    "wan.status": site.router.wanStatus,
    "firewall.order": "preserved",
    "dns.cacheMode": "managed",
    "snmp.community": "demo-community-secret",
    "settings.pollingSeconds": site.settings.pollingSeconds,
    "settings.backupHour": site.settings.backupHour,
    "settings.alertSensitivity": site.settings.alertSensitivity,
    "settings.dependencyGrouping": site.settings.dependencyGrouping,
    "settings.changesPaused": site.settings.changesPaused,
  };
  for (const networkInterface of site.interfaces) {
    snapshot[`interface.${networkInterface.id}.role`] = networkInterface.role;
    snapshot[`interface.${networkInterface.id}.protected`] = networkInterface.protected;
    snapshot[`interface.${networkInterface.id}.status`] = networkInterface.status;
  }
  return sanitizeConfigSnapshot(snapshot);
}

function countSnapshotChanges(from: Record<string, string>, to: Record<string, string>): number {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  let count = 0;
  for (const key of keys) {
    if (from[key] !== to[key]) count += 1;
  }
  return count;
}

function snapshotHash(snapshot: Record<string, string>): string {
  const content = Object.entries(snapshot).map(([key, value]) => `${key}=${value}`).join("\n");
  return `sha256:${hashString(content).toString(16).padStart(16, "0")}`;
}

function makeSeedRevisions(seed: number, site: DemoNetworkBuilding): ConfigRevision[] {
  const olderSnapshot = snapshotForSite(site);
  olderSnapshot["dns.cacheMode"] = "legacy";
  olderSnapshot["settings.pollingSeconds"] = "90";
  const latestSnapshot = snapshotForSite(site);
  const older: ConfigRevision = {
    id: `revision-${seed.toString(16)}-2`,
    capturedAt: atOffset(-720),
    label: "Bản ổn định trước đó",
    hash: snapshotHash(olderSnapshot),
    changeCount: 0,
    source: "scheduled",
    snapshot: olderSnapshot,
  };
  const latest: ConfigRevision = {
    id: `revision-${seed.toString(16)}-1`,
    capturedAt: atOffset(-360),
    label: "Bản gần nhất",
    hash: snapshotHash(latestSnapshot),
    changeCount: countSnapshotChanges(olderSnapshot, latestSnapshot),
    source: "scheduled",
    snapshot: latestSnapshot,
  };
  return [latest, older];
}

function makeTarget(site: NetworkBuilding, extra: Partial<NetworkMutationTarget> = {}): NetworkMutationTarget {
  return {
    buildingId: site.buildingId,
    buildingName: site.buildingName,
    routerIdentity: site.router.identity,
    ...extra,
  };
}

function makeAudit(seed: number, site: NetworkBuilding): AuditRecord[] {
  return [
    {
      id: `audit-${seed.toString(16)}-1`,
      at: atOffset(-90),
      actor: "Tác vụ demo tự động",
      actorId: "demo-system",
      actionType: "health_check",
      action: "Kiểm tra sức khỏe",
      target: makeTarget(site),
      parameters: {},
      detail: "WAN, DNS, backup và trạng thái Aruba liên quan đều được đánh giá mô phỏng.",
      reason: "Lịch kiểm tra demo",
      validation: "Dữ liệu đầu vào mô phỏng hợp lệ",
      result: "Đã cập nhật trạng thái sức khỏe mô phỏng",
      outcome: "info",
    },
  ];
}

function generateBuilding(building: PhysicalBuildingRecord): DemoNetworkBuilding {
  const seed = hashString(building.id);
  const backupAgeHours = seeded(seed, 4, 2, 64);
  const firmware = FIRMWARE[seed % FIRMWARE.length];
  const activeClients = seeded(seed, 5, 12, 88);
  const arubaNodes = makeArubaNodes(seed);
  const interfaces = makeInterfaces(seed);
  const wan = interfaces.find((networkInterface) => networkInterface.role === "wan")!;
  const dependencyDegraded = arubaNodes.some((node) => node.status !== "online");
  const health: NetworkHealth = wan.status === "down"
    ? "offline"
    : dependencyDegraded || seed % 5 === 0
      ? "degraded"
      : "online";

  const site: DemoNetworkBuilding = {
    buildingId: building.id,
    buildingName: building.name,
    rolloutState: building.rolloutState ?? "EXECUTE",
    roomsCount: building.roomsCount ?? 0,
    health,
    backupStatus: backupAgeHours > 30 ? "stale" : "fresh",
    backupAgeHours,
    uptimePercent: Number((98.4 + seeded(seed, 7, 0, 159) / 100).toFixed(2)),
    mttrMinutes: seeded(seed, 8, 12, 56),
    activeClients,
    router: {
      id: `demo-router-${building.id}`,
      identity: `MT-${seed.toString(16).slice(0, 6).toUpperCase()}`,
      model: MODELS[seed % MODELS.length],
      firmware,
      targetFirmware: "7.20.1",
      lifecycleStatus: "ONLINE",
      wanStatus: wan.status,
      lastSeenLabel: wan.status === "down" ? "4 phút trước" : `${seeded(seed, 9, 6, 55)} giây trước`,
      cpuPercent: seeded(seed, 10, 8, 72),
      memoryPercent: seeded(seed, 11, 24, 68),
      downloadMbps: wan.rxMbps,
      uploadMbps: wan.txMbps,
    },
    interfaces,
    clients: makeClients(seed, activeClients),
    arubaNodes,
    arubaTotal: arubaNodes.length,
    arubaOnline: arubaNodes.filter((node) => node.status === "online").length,
    incidents: makeIncidents(seed, building.id, health),
    maintenance: null,
    revisions: [],
    jobs: [],
    audit: [],
    settings: {
      pollingSeconds: 60,
      backupHour: "02:30",
      alertSensitivity: "standard",
      dependencyGrouping: true,
      changesPaused: false,
    },
    settingsVersion: 1,
  };
  site.revisions = makeSeedRevisions(seed, site);
  site.audit = makeAudit(seed, site);
  return site;
}

export class DemoNetworkCenterRepository {
  private buildings: PhysicalBuildingRecord[] = [];
  private states = new Map<string, DemoNetworkBuilding>();
  private revisionSequence = 0;
  private mutationSequence = 0;

  constructor(buildings: PhysicalBuildingRecord[]) {
    this.replaceBuildings(buildings);
  }

  replaceBuildings(buildings: PhysicalBuildingRecord[]): void {
    this.buildings = buildings.map((building) => ({ ...building }));
    const accessibleIds = new Set(buildings.map((building) => building.id));
    for (const id of this.states.keys()) {
      if (!accessibleIds.has(id)) this.states.delete(id);
    }
    for (const building of buildings) {
      const existing = this.states.get(building.id);
      if (existing) {
        existing.buildingName = building.name;
        existing.roomsCount = building.roomsCount ?? 0;
      } else {
        this.states.set(building.id, generateBuilding(building));
      }
    }
  }

  listFleet(): NetworkBuilding[] {
    return this.buildings.map((building) => this.cloneForRead(this.states.get(building.id)!));
  }

  getBuilding(buildingId: string): NetworkBuilding | null {
    const site = this.states.get(buildingId);
    return site ? this.cloneForRead(site) : null;
  }

  listArubaPage(
    buildingId: string,
    cursor: ArubaPageCursor | null = null,
    limit = 100,
  ): ArubaPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
      throw new Error("Kích thước trang Aruba phải từ 1 đến 250");
    }
    const nodes = this.requireBuilding(buildingId).arubaNodes;
    let start = 0;
    if (cursor) {
      const cursorIndex = nodes.findIndex((node) => node.id === cursor.id);
      if (cursorIndex < 0 || cursor.sortOrder !== cursorIndex + 1) {
        throw new Error("Cursor Aruba demo không hợp lệ");
      }
      start = cursorIndex + 1;
    }
    const end = Math.min(nodes.length, start + limit);
    const items = clone(nodes.slice(start, end));
    const last = items.at(-1);
    return {
      items,
      nextCursor: end < nodes.length && last
        ? { sortOrder: end, id: last.id }
        : null,
    };
  }

  acknowledgeIncident(buildingId: string, incidentId: string, actor: NetworkActor): void {
    const site = this.requireBuilding(buildingId);
    this.requireActor(actor);
    const incident = site.incidents.find((candidate) => candidate.id === incidentId);
    if (!incident) throw new Error("Không tìm thấy sự cố");
    if (incident.status === "resolved") throw new Error("Sự cố đã đóng");
    incident.status = "acknowledged";
    incident.acknowledgedAt = this.currentTimestamp();
    this.appendAudit(site, actor, {
      actionType: "acknowledge_incident",
      action: "Xác nhận sự cố",
      target: makeTarget(site, { incidentId }),
      parameters: { incidentId },
      detail: incident.title,
      reason: incident.title,
      validation: "Sự cố đang mở và thuộc đúng tòa nhà",
      result: "Đã xác nhận sự cố trong bộ nhớ mô phỏng cục bộ",
      outcome: "success",
    });
  }

  createMaintenance(buildingId: string, input: MaintenanceInput, actor: NetworkActor): MaintenanceWindow {
    const site = this.requireBuilding(buildingId);
    this.requireActor(actor);
    if (isMaintenanceActive(site.maintenance)) throw new Error("Tòa đang có cửa sổ bảo trì");
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 15 || input.durationMinutes > 480) {
      throw new Error("Thời lượng bảo trì phải từ 15 đến 480 phút");
    }
    if (input.reason.trim().length < 8) throw new Error("Lý do bảo trì phải có ít nhất 8 ký tự");
    const startsAt = this.currentTimestamp();
    const maintenance: MaintenanceWindow = {
      id: this.nextId("maintenance", buildingId),
      reason: input.reason.trim(),
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + input.durationMinutes * 60_000).toISOString(),
      durationMinutes: input.durationMinutes,
    };
    site.maintenance = maintenance;
    this.appendAudit(site, actor, {
      actionType: "create_maintenance",
      action: "Tạo bảo trì",
      target: makeTarget(site, { maintenanceId: maintenance.id }),
      parameters: { durationMinutes: input.durationMinutes },
      detail: maintenance.reason,
      reason: maintenance.reason,
      validation: "Thời lượng và lý do hợp lệ",
      result: "Đã tạo cửa sổ bảo trì trong bộ nhớ mô phỏng cục bộ",
      outcome: "success",
    });
    return clone(maintenance);
  }

  cancelMaintenance(buildingId: string, maintenanceId: string, actor: NetworkActor): void {
    const site = this.requireBuilding(buildingId);
    this.requireActor(actor);
    if (!site.maintenance || site.maintenance.id !== maintenanceId) throw new Error("Không tìm thấy bảo trì");
    const reason = site.maintenance.reason;
    site.maintenance = null;
    this.appendAudit(site, actor, {
      actionType: "cancel_maintenance",
      action: "Huỷ bảo trì",
      target: makeTarget(site, { maintenanceId }),
      parameters: { maintenanceId },
      detail: reason,
      reason,
      validation: "Cửa sổ bảo trì tồn tại và thuộc đúng tòa nhà",
      result: "Đã huỷ cửa sổ bảo trì trong bộ nhớ mô phỏng cục bộ",
      outcome: "success",
    });
  }

  captureConfiguration(buildingId: string, label: string, actor: NetworkActor): ConfigRevision {
    return this.captureConfigurationWithSource(buildingId, label, "manual", actor);
  }

  compareRevisions(buildingId: string, fromRevisionId: string, toRevisionId: string): ConfigDiff {
    const site = this.requireBuilding(buildingId);
    if (fromRevisionId === toRevisionId) throw new Error("Hãy chọn hai phiên bản khác nhau");
    const from = site.revisions.find((revision) => revision.id === fromRevisionId);
    const to = site.revisions.find((revision) => revision.id === toRevisionId);
    if (!from || !to) throw new Error("Không tìm thấy phiên bản cấu hình");
    const fromSnapshot = sanitizeConfigSnapshot(from.snapshot);
    const toSnapshot = sanitizeConfigSnapshot(to.snapshot);
    const keys = [...new Set([...Object.keys(fromSnapshot), ...Object.keys(toSnapshot)])].sort();
    const lines: ConfigDiff["lines"] = [
      { kind: "context", text: `@@ ${from.label} → ${to.label} @@` },
    ];
    let changeCount = 0;
    for (const key of keys) {
      if (fromSnapshot[key] === toSnapshot[key]) continue;
      changeCount += 1;
      if (key in fromSnapshot) lines.push({ kind: "removed", text: `- ${key}=${fromSnapshot[key]}` });
      if (key in toSnapshot) lines.push({ kind: "added", text: `+ ${key}=${toSnapshot[key]}` });
    }
    return { fromRevisionId, toRevisionId, changeCount, lines };
  }

  executeAction(buildingId: string, input: NetworkActionRequest, actor: NetworkActor): NetworkJob {
    const site = this.requireBuilding(buildingId);
    this.requireActor(actor);
    if (site.settings.changesPaused) throw new Error("Thay đổi đang tạm dừng cho tòa này");
    const request = validateNetworkAction(site, input);
    const definition = NETWORK_ACTION_DEFINITIONS.find((candidate) => candidate.type === request.type)!;
    const targetInterface = request.type === "cycle_access_port"
      ? site.interfaces.find((networkInterface) => networkInterface.id === String(request.fields.interfaceId))
      : undefined;
    const target = makeTarget(site, targetInterface ? {
      interfaceId: targetInterface.id,
      interfaceName: targetInterface.name,
    } : {});
    const backup = this.captureConfigurationWithSource(
      buildingId,
      `Trước thao tác: ${definition.label}`,
      "pre_action",
      actor,
    );

    let executionDetail = "Đã thực thi trong bộ nhớ mô phỏng cục bộ; không gọi router hoặc RPC thật";
    let postCheckDetail = definition.postCheck;
    let result = "Thao tác chỉ được mô phỏng trong bộ nhớ cục bộ; không có thiết bị thật nào bị thay đổi.";
    if (request.type === "cycle_access_port" && targetInterface) {
      const durationSeconds = Number(request.fields.durationSeconds);
      const previousMetrics = {
        rxMbps: targetInterface.rxMbps,
        txMbps: targetInterface.txMbps,
        utilizationPercent: targetInterface.utilizationPercent,
      };
      targetInterface.status = "down";
      targetInterface.rxMbps = 0;
      targetInterface.txMbps = 0;
      targetInterface.utilizationPercent = 0;
      targetInterface.status = "up";
      Object.assign(targetInterface, previousMetrics);
      executionDetail = `${targetInterface.name}: UP → DOWN ${durationSeconds} giây → UP trong mô phỏng cục bộ`;
      postCheckDetail = `${targetInterface.name} đã trở lại UP; lưu lượng mẫu được khôi phục và đối soát`;
      result = `Đã mô phỏng chu kỳ ${targetInterface.name} trong bộ nhớ cục bộ; trạng thái cuối UP.`;
    }

    const validationDetail = "Dữ liệu, định danh router, trạng thái cổng và danh sách được phép đều hợp lệ";
    const createdAt = this.currentTimestamp();
    const job: NetworkJob = {
      id: this.nextId("job", buildingId),
      buildingId,
      action: request.type,
      actionLabel: definition.label,
      reason: request.reason.trim(),
      actor: clone(actor),
      target,
      parameters: clone(request.fields),
      status: "success",
      createdAt,
      validation: { status: "passed", detail: validationDetail },
      stages: [
        { key: "validation", label: "Kiểm tra đầu vào", status: "success", detail: validationDetail },
        { key: "backup", label: "Backup", status: "success", detail: `Đã tạo ${backup.id} trước thao tác` },
        { key: "execution", label: "Thực hiện", status: "success", detail: executionDetail },
        { key: "post_check", label: "Kiểm tra sau", status: "success", detail: postCheckDetail },
        { key: "success", label: "Hoàn tất", status: "success", detail: "Hoàn tất mô phỏng cục bộ" },
      ],
      result,
      rollback: {
        available: true,
        performed: false,
        status: "not_required",
        detail: `Không cần rollback; bản ${backup.id} sẵn sàng cho mô phỏng phục hồi`,
      },
      reconciliation: {
        status: "matched",
        detail: targetInterface ? `${targetInterface.name} khớp trạng thái UP sau post-check` : "Trạng thái mô phỏng khớp kỳ vọng",
      },
    };
    site.jobs.unshift(job);
    this.appendAudit(site, actor, {
      actionType: request.type,
      action: definition.label,
      target,
      parameters: clone(request.fields),
      detail: result,
      reason: request.reason.trim(),
      validation: validationDetail,
      result,
      outcome: "success",
    });
    return clone(job);
  }

  updateSettings(
    buildingId: string,
    settings: Partial<NetworkSettings>,
    actor: NetworkActor,
    expectedVersion?: number,
  ): void {
    const site = this.requireBuilding(buildingId);
    this.requireActor(actor);
    if (expectedVersion !== undefined && expectedVersion !== site.settingsVersion) {
      throw new Error("Cài đặt đã thay đổi; vui lòng tải lại trước khi lưu");
    }
    const nextSettings = validateNetworkSettings({ ...site.settings, ...settings });
    site.settings = nextSettings;
    site.settingsVersion += 1;
    this.appendAudit(site, actor, {
      actionType: "update_settings",
      action: "Cập nhật cài đặt",
      target: makeTarget(site),
      parameters: { ...nextSettings },
      detail: "Cấu hình giám sát mô phỏng",
      reason: "Lưu cài đặt theo tòa nhà",
      validation: "Polling, giờ backup và enum cài đặt hợp lệ",
      result: "Đã lưu cài đặt trong bộ nhớ mô phỏng cục bộ",
      outcome: "success",
    });
  }

  private captureConfigurationWithSource(
    buildingId: string,
    label: string,
    source: ConfigRevision["source"],
    actor: NetworkActor,
  ): ConfigRevision {
    const site = this.requireBuilding(buildingId);
    this.requireActor(actor);
    if (label.trim().length < 4) throw new Error("Nhãn bản chụp phải có ít nhất 4 ký tự");
    this.revisionSequence += 1;
    const snapshot = snapshotForSite(site);
    const previousSnapshot = site.revisions[0]?.snapshot ?? {};
    const revision: ConfigRevision = {
      id: `revision-${hashString(buildingId).toString(16)}-${source}-${this.revisionSequence}`,
      capturedAt: this.currentTimestamp(),
      label: label.trim(),
      hash: snapshotHash(snapshot),
      changeCount: countSnapshotChanges(previousSnapshot, snapshot),
      source,
      snapshot,
    };
    site.revisions.unshift(revision);
    site.backupAgeHours = 0;
    site.backupStatus = "fresh";
    this.appendAudit(site, actor, {
      actionType: "capture_configuration",
      action: "Chụp cấu hình",
      target: makeTarget(site, { revisionId: revision.id }),
      parameters: { source },
      detail: revision.label,
      reason: revision.label,
      validation: "Snapshot đã được làm sạch và sắp xếp ổn định",
      result: `Đã lưu ${revision.id} trong bộ nhớ mô phỏng cục bộ`,
      outcome: "success",
    });
    return clone(revision);
  }

  private requireBuilding(buildingId: string): DemoNetworkBuilding {
    const site = this.states.get(buildingId);
    if (!site) throw new Error("Tòa nhà không thuộc phạm vi truy cập");
    return site;
  }

  private requireActor(actor: NetworkActor): void {
    if (!actor?.id?.trim() || !actor?.label?.trim()) {
      throw new Error("Không xác định được người thực hiện đã đăng nhập");
    }
  }

  private cloneForRead(site: DemoNetworkBuilding): DemoNetworkBuilding {
    const result = clone(site);
    if (!isMaintenanceActive(result.maintenance)) result.maintenance = null;
    return result;
  }

  private currentTimestamp(): string {
    return new Date().toISOString();
  }

  private nextId(kind: string, buildingId: string): string {
    this.mutationSequence += 1;
    return `${kind}-${buildingId}-${this.mutationSequence}`;
  }

  private appendAudit(
    site: NetworkBuilding,
    actor: NetworkActor,
    record: Omit<AuditRecord, "id" | "at" | "actor" | "actorId"> & { actionType: NetworkAuditAction },
  ): void {
    site.audit.unshift({
      id: this.nextId("audit", site.buildingId),
      at: this.currentTimestamp(),
      actor: actor.label,
      actorId: actor.id,
      ...record,
    });
  }
}
