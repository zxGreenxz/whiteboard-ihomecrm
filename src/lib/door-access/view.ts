import type { BuildingCandidate } from "./buildingMatch";
import type { DoorActionLog, DoorDevice, DoorDeviceCan } from "./dto";
import { DAY_MS, UNLOCK_TYPE_LABEL, vnDayStartMs } from "./format";
import type { ReconcileRow } from "./reconcile";
import { linkDisplayName } from "./records";

/** Hàm thuần phục vụ màn /cua-van-tay (tách khỏi component để test và để Fast Refresh gọn). */

export const READ_ONLY_REASON = "Đang ở chế độ chỉ đọc — chưa thao tác được trên máy";

// ---------------------------------------------------------------------------------------------
// Tab

export const DOOR_TABS = ["history", "temp", "reconcile", "devices", "logs"] as const;
export type DoorTab = (typeof DOOR_TABS)[number];

export const DOOR_TAB_LABEL: Record<DoorTab, string> = {
  history: "Lịch sử ra vào",
  temp: "Mật khẩu tạm",
  reconcile: "Đối chiếu vân tay",
  devices: "Thiết bị",
  logs: "Nhật ký thao tác",
};

export const isDoorTab = (value: string): value is DoorTab => (DOOR_TABS as readonly string[]).includes(value);

/**
 * Tab theo quyền của MÁY ĐANG CHỌN (`device.can`, máy chủ tính theo tòa của máy). Riêng tab
 * Thiết bị không gắn với một máy: hiện khi có quyền Quản lý ở ít nhất một tòa — kể cả khi chưa có
 * máy nào (đó là lúc cần nó nhất).
 */
export function visibleTabs(can: DoorDeviceCan | null, canManageAnywhere: boolean): DoorTab[] {
  return DOOR_TABS.filter((tab) => {
    if (tab === "devices") return canManageAnywhere || Boolean(can?.manage_devices);
    if (tab === "temp") return Boolean(can?.temp_password);
    return Boolean(can?.view);
  });
}

// ---------------------------------------------------------------------------------------------
// Chọn máy

const collator = new Intl.Collator("vi");

/** Máy theo tòa, tòa và máy xếp theo tên. */
export function groupDevicesByBuilding(devices: readonly DoorDevice[]): Array<{ building: string; devices: DoorDevice[] }> {
  const groups = new Map<string, DoorDevice[]>();
  for (const device of devices) {
    const building = device.building_name ?? "Chưa rõ tòa";
    const list = groups.get(building) ?? [];
    list.push(device);
    groups.set(building, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([building, list]) => ({ building, devices: [...list].sort((a, b) => collator.compare(a.display_name, b.display_name)) }));
}

// ---------------------------------------------------------------------------------------------
// Lịch sử ra vào

/** Tối đa 31 ngày mỗi lần đọc (giới hạn của hàm Edge). */
export const HISTORY_MAX_DAYS = 31;

export function historyRange(from: string, to: string): { range: { startMs: number; endMs: number } | null; problem: string | null } {
  const start = vnDayStartMs(from);
  const end = vnDayStartMs(to);
  if (start === null || end === null) return { range: null, problem: "Chọn đủ ngày bắt đầu và ngày kết thúc." };
  if (end < start) return { range: null, problem: "Ngày kết thúc phải bằng hoặc sau ngày bắt đầu." };
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > HISTORY_MAX_DAYS) return { range: null, problem: `Mỗi lần xem tối đa ${HISTORY_MAX_DAYS} ngày.` };
  return { range: { startMs: start, endMs: end + DAY_MS - 1 }, problem: null };
}

// ---------------------------------------------------------------------------------------------
// Đối chiếu

/** "Nguyễn Văn A · P302" hoặc tên trên máy hoặc "chưa gắn khách". */
export function rowOwner(row: ReconcileRow): string {
  if (row.link) return `${linkDisplayName(row.link)}${row.link.room_name ? ` · ${row.link.room_name}` : ""}`;
  return row.deviceUserName ? `${row.deviceUserName} (tên trên máy)` : "chưa gắn khách";
}

/** Lý do không xoá được trên máy (null = xoá được). */
export function deleteBlockedReason(row: ReconcileRow, writable: boolean): string | null {
  if (!row.tuyaUserId) return `${UNLOCK_TYPE_LABEL[row.unlockType]} chưa gắn người dùng trên máy — xoá trong app SmartLife`;
  if (!writable) return READ_ONLY_REASON;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Thiết bị

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Tòa của CÔNG TY ĐANG CHỌN, từ hook tòa dùng chung (đọc phòng thủ, bỏ dòng sai dạng). */
export function organizationBuildings(rows: unknown, organizationId: string): BuildingCandidate[] {
  if (!Array.isArray(rows)) return [];
  const out: BuildingCandidate[] = [];
  for (const row of rows) {
    if (!isRecord(row) || row.organization_id !== organizationId) continue;
    if (typeof row.id !== "string" || typeof row.name !== "string") continue;
    out.push({
      id: row.id,
      name: row.name,
      code: typeof row.code === "string" ? row.code : null,
      street_address: typeof row.street_address === "string" ? row.street_address : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Nhật ký thao tác

/** Gộp các trang nhật ký, bỏ dòng trùng id (phòng hờ hai trang chồng nhau). */
export function mergeLogPages(pages: ReadonlyArray<{ logs?: readonly DoorActionLog[] }>): DoorActionLog[] {
  const seen = new Set<string>();
  const out: DoorActionLog[] = [];
  for (const page of pages) {
    for (const log of page.logs ?? []) {
      if (seen.has(log.id)) continue;
      seen.add(log.id);
      out.push(log);
    }
  }
  return out;
}
