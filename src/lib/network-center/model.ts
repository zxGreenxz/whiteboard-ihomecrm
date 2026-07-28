import { z } from "zod";

import type {
  FleetFilters,
  FleetSummary,
  MaintenanceWindow,
  NetworkActionRequest,
  NetworkActionType,
  NetworkBuilding,
  NetworkIncident,
  NetworkSettings,
} from "./contracts";

export const NETWORK_CENTER_TABS = [
  { value: "overview", label: "Tổng quan" },
  { value: "interfaces", label: "Cổng giao tiếp" },
  { value: "clients", label: "Thiết bị kết nối" },
  { value: "topology", label: "Aruba & sơ đồ" },
  { value: "incidents", label: "Sự cố & SLA" },
  { value: "configuration", label: "Cấu hình" },
  { value: "backups", label: "Sao lưu & so sánh" },
  { value: "changes", label: "Thay đổi" },
  { value: "audit", label: "Nhật ký & Bảo mật" },
  { value: "settings", label: "Cài đặt" },
] as const;

export type NetworkCenterTab = (typeof NETWORK_CENTER_TABS)[number]["value"];

export const isNetworkCenterTab = (value: string | null): value is NetworkCenterTab =>
  NETWORK_CENTER_TABS.some((tab) => tab.value === value);

export function isMaintenanceActive(
  maintenance: MaintenanceWindow | null,
  now: number | Date = Date.now(),
): boolean {
  if (!maintenance) return false;
  const currentTime = now instanceof Date ? now.getTime() : now;
  return Date.parse(maintenance.startsAt) <= currentTime && currentTime <= Date.parse(maintenance.endsAt);
}

export function summarizeFleet(
  fleet: NetworkBuilding[],
  now: number | Date = Date.now(),
  severity: FleetFilters["severity"] = "all",
): FleetSummary {
  const summary: FleetSummary = {
    online: 0,
    degraded: 0,
    offline: 0,
    openIncidents: 0,
    staleBackups: 0,
    activeMaintenance: 0,
  };

  for (const site of fleet) {
    summary[site.health] += 1;
    summary.openIncidents += site.incidents.filter(
      (incident) => incident.status !== "resolved"
        && (!severity || severity === "all" || incident.severity === severity),
    ).length;
    if (site.backupStatus === "stale") summary.staleBackups += 1;
    if (isMaintenanceActive(site.maintenance, now)) summary.activeMaintenance += 1;
  }
  return summary;
}

export function filterFleet(fleet: NetworkBuilding[], filters: FleetFilters): NetworkBuilding[] {
  const search = filters.search?.trim().toLocaleLowerCase("vi") ?? "";
  return fleet.filter((site) => {
    if (search && !site.buildingName.toLocaleLowerCase("vi").includes(search)) return false;
    if (filters.health && filters.health !== "all" && site.health !== filters.health) return false;
    if (filters.backup && filters.backup !== "all" && site.backupStatus !== filters.backup) return false;
    if (
      filters.firmware === "drift" &&
      site.router.firmware === site.router.targetFirmware
    ) return false;
    if (
      filters.severity &&
      filters.severity !== "all" &&
      !site.incidents.some(
        (incident) => incident.status !== "resolved" && incident.severity === filters.severity,
      )
    ) return false;
    return true;
  });
}

const INCIDENT_SEVERITY_PRIORITY = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
} as const;

const compareIncidentPriority = (left: NetworkIncident, right: NetworkIncident) =>
  INCIDENT_SEVERITY_PRIORITY[left.severity] - INCIDENT_SEVERITY_PRIORITY[right.severity]
  || right.openedAt.localeCompare(left.openedAt);

export function selectPriorityIncidents(
  incidents: NetworkIncident[],
  capacity = 8,
): NetworkIncident[] {
  const ordered = [...incidents].sort(compareIncidentPriority);
  const critical = ordered.filter((incident) => incident.severity === "critical");
  const remainingCapacity = Math.max(0, capacity - critical.length);
  return [
    ...critical,
    ...ordered.filter((incident) => incident.severity !== "critical").slice(0, remainingCapacity),
  ];
}

export function deriveFleetView(
  fleet: NetworkBuilding[],
  filters: FleetFilters,
  now: number | Date = Date.now(),
) {
  const filteredFleet = filterFleet(fleet, filters);
  const incidents = filteredFleet
    .flatMap((site) => site.incidents)
    .filter((incident) =>
      incident.status !== "resolved"
      && (filters.severity === undefined
        || filters.severity === "all"
        || incident.severity === filters.severity),
    );

  return {
    fleet: filteredFleet,
    summary: summarizeFleet(filteredFleet, now, filters.severity),
    incidents: selectPriorityIncidents(incidents),
  };
}

export interface ActionFieldDefinition {
  key: string;
  label: string;
  type: "select" | "number";
  required: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  defaultValue?: string | number | boolean;
}

export interface NetworkActionDefinition {
  type: NetworkActionType;
  label: string;
  risk: "Thấp" | "Trung bình" | "Cao";
  description: string;
  preview: string;
  backupRule: string;
  postCheck: string;
  requiresIdentity: boolean;
  fields: ActionFieldDefinition[];
}

export const NETWORK_ACTION_DEFINITIONS: NetworkActionDefinition[] = [
  {
    type: "flush_dns_cache",
    label: "Làm mới bộ nhớ đệm DNS",
    risk: "Thấp",
    description: "Xoá bộ nhớ đệm DNS mô phỏng, không thay DNS upstream.",
    preview: "DNS cache: giữ cấu hình → làm mới dữ liệu tạm",
    backupRule: "Chụp metadata trước thao tác",
    postCheck: "Kiểm tra phân giải tên mô phỏng",
    requiresIdentity: false,
    fields: [],
  },
  {
    type: "renew_dhcp_lease",
    label: "Gia hạn DHCP uplink",
    risk: "Trung bình",
    description: "Gia hạn kết nối DHCP trên uplink hiện hữu, không đổi tuyến mặc định.",
    preview: "Lease uplink: hiện tại → cấp lại địa chỉ",
    backupRule: "Chụp cấu hình trước thao tác",
    postCheck: "Kiểm tra WAN và DNS mô phỏng",
    requiresIdentity: false,
    fields: [],
  },
  {
    type: "cycle_access_port",
    label: "Khởi động lại cổng truy cập",
    risk: "Trung bình",
    description: "Tắt/bật một cổng LAN trong danh sách được phép; cổng WAN và uplink bị khoá.",
    preview: "Cổng LAN đã chọn: up → down ngắn → up",
    backupRule: "Chụp cấu hình trước thao tác",
    postCheck: "Kiểm tra link và client quay lại",
    requiresIdentity: true,
    fields: [
      {
        key: "interfaceId",
        label: "Cổng LAN",
        type: "select",
        required: true,
      },
      {
        key: "durationSeconds",
        label: "Thời gian ngắt (giây)",
        type: "number",
        required: true,
        min: 5,
        max: 30,
        defaultValue: 10,
      },
    ],
  },
  {
    type: "reboot_router",
    label: "Khởi động lại MikroTik",
    risk: "Cao",
    description: "Khởi động lại router mô phỏng sau khi sao lưu và kiểm tra đầu vào.",
    preview: "Router: đang hoạt động → khởi động lại → kiểm tra sau",
    backupRule: "Bắt buộc chụp cấu hình trước thao tác",
    postCheck: "Kiểm tra router, WAN, DNS và trạng thái Aruba liên quan",
    requiresIdentity: true,
    fields: [],
  },
];

const requestSchema = z.object({
  type: z.enum(["flush_dns_cache", "renew_dhcp_lease", "cycle_access_port", "reboot_router"]),
  reason: z.string().trim().min(8, "Lý do phải có ít nhất 8 ký tự"),
  fields: z.record(z.union([z.string(), z.number(), z.boolean()])),
  confirmation: z.string().optional(),
});

export function validateNetworkAction(site: NetworkBuilding, input: unknown): NetworkActionRequest {
  const parsed = requestSchema.parse(input);
  const request: NetworkActionRequest = {
    type: parsed.type,
    reason: parsed.reason,
    fields: parsed.fields,
    confirmation: parsed.confirmation,
  };
  const definition = NETWORK_ACTION_DEFINITIONS.find((candidate) => candidate.type === request.type)!;

  if (definition.requiresIdentity && request.confirmation !== site.router.identity) {
    throw new Error("Tên định danh router không khớp");
  }

  if (request.type === "cycle_access_port") {
    const interfaceId = String(request.fields.interfaceId ?? "");
    const durationSeconds = Number(request.fields.durationSeconds);
    const target = site.interfaces.find((candidate) => candidate.id === interfaceId);
    if (!target || target.protected || target.role !== "lan") {
      throw new Error("Cổng được chọn không nằm trong danh sách LAN được phép");
    }
    if (target.status !== "up") {
      throw new Error("Cổng được chọn đang down; không thể mô phỏng chu kỳ tắt/bật");
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 30) {
      throw new Error("Thời gian ngắt phải từ 5 đến 30 giây");
    }
  }

  return request;
}

const backupHourPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateNetworkSettings(input: unknown): NetworkSettings {
  if (!input || typeof input !== "object") {
    throw new Error("Cài đặt mạng không hợp lệ");
  }
  const settings = input as Record<string, unknown>;
  const pollingSeconds = Number(settings.pollingSeconds);
  if (!Number.isInteger(pollingSeconds)) {
    throw new Error("Chu kỳ polling phải là số nguyên");
  }
  if (pollingSeconds < 30 || pollingSeconds > 300) {
    throw new Error("Chu kỳ polling phải từ 30 đến 300 giây");
  }

  const backupHour = typeof settings.backupHour === "string" ? settings.backupHour.trim() : "";
  if (!backupHourPattern.test(backupHour)) {
    throw new Error("Giờ backup phải đúng định dạng HH:mm");
  }

  if (settings.alertSensitivity !== "standard" && settings.alertSensitivity !== "strict") {
    throw new Error("Ngưỡng cảnh báo không hợp lệ");
  }
  if (typeof settings.dependencyGrouping !== "boolean" || typeof settings.changesPaused !== "boolean") {
    throw new Error("Tuỳ chọn cài đặt mạng không hợp lệ");
  }

  return {
    pollingSeconds,
    backupHour,
    alertSensitivity: settings.alertSensitivity,
    dependencyGrouping: settings.dependencyGrouping,
    changesPaused: settings.changesPaused,
  };
}
