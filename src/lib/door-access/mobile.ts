import type { DoorAction, DoorActionLog, DoorDevice, DoorDeviceCan, DoorKeyLink, DoorRecord, DoorTempPassword } from "./dto";
import { DAY_MS, TENANCY_LABEL, VN_OFFSET_MS, deliveryHint, formatTimeDay, purposeLabel, recordMethodLabel, unlockTypeLabel, vnDate } from "./format";
import type { ReconcileResult, ReconcileRow } from "./reconcile";
import { isLinkableMethod, recordPerson } from "./records";
import { groupDevicesByBuilding } from "./view";

/**
 * Hàm thuần cho màn điện thoại /cua-van-tay (Bản A, < 768px). Dữ liệu và luật lấy từ lớp sẵn có
 * (records, reconcile, tempPassword); ở đây chỉ gom nhóm và soạn chữ cho bố cục di động.
 */

const pad = (n: number) => String(n).padStart(2, "0");

function vnClock(ms: number) {
  const d = new Date(ms + VN_OFFSET_MS);
  return { day: d.getUTCDate(), month: d.getUTCMonth() + 1, hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
}

/** "14:05" giờ Việt Nam. */
export function formatClock(ms: number): string {
  const p = vnClock(ms);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "25/11" giờ Việt Nam. */
export function formatDayMonth(ms: number): string {
  const p = vnClock(ms);
  return `${pad(p.day)}/${pad(p.month)}`;
}

const WEEKDAY = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];

/** "Thứ Tư, 25/11" — dòng phụ đầu màn. */
export function formatWeekdayDate(ms: number): string {
  return `${WEEKDAY[vnClock(ms).weekday]}, ${formatDayMonth(ms)}`;
}

/** Tiêu đề nhóm theo ngày: "Hôm nay, 25/11", "Hôm qua, 24/11", "Thứ Hai, 23/11". */
export function vnDayTitle(ms: number, nowMs: number): string {
  const day = vnDate(ms);
  if (day === vnDate(nowMs)) return `Hôm nay, ${formatDayMonth(ms)}`;
  if (day === vnDate(nowMs - DAY_MS)) return `Hôm qua, ${formatDayMonth(ms)}`;
  return formatWeekdayDate(ms);
}

/** Bỏ dấu + chữ thường, để "toa a", "cong chinh" khớp "Cổng chính · Tòa A". */
export function foldVi(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

// ---------------------------------------------------------------------------------------------
// Chọn cửa

export function searchDeviceGroups(devices: readonly DoorDevice[], query: string): Array<{ building: string; devices: DoorDevice[] }> {
  const key = foldVi(query).trim();
  return groupDevicesByBuilding(devices)
    .map((group) => ({
      building: group.building,
      devices: key ? group.devices.filter((device) => foldVi(`${group.building} ${device.display_name}`).includes(key)) : group.devices,
    }))
    .filter((group) => group.devices.length > 0);
}

/** "6 cửa ở 5 toà bạn được xem" */
export function deviceCountText(devices: readonly DoorDevice[]): string {
  const buildings = new Set(devices.map((device) => device.building_id)).size;
  return `${devices.length} cửa ở ${buildings} toà bạn được xem`;
}

/** "Cổng chính · Tòa A" */
export function doorLabel(device: Pick<DoorDevice, "display_name" | "building_name">): string {
  return device.building_name ? `${device.display_name} · ${device.building_name}` : device.display_name;
}

// ---------------------------------------------------------------------------------------------
// Mã tạm

/** "13:20 → 14:20" (cùng ngày hôm nay), "08:00 → 20:00 26/11" (cùng một ngày khác), "08:00 25/11 → 18:00 27/11". */
export function validityWindowText(effectiveSec: number, invalidSec: number, nowMs: number): string {
  const from = effectiveSec * 1000;
  const to = invalidSec * 1000;
  if (vnDate(from) === vnDate(to)) {
    const tail = vnDate(from) === vnDate(nowMs) ? "" : ` ${formatDayMonth(from)}`;
    return `${formatClock(from)} → ${formatClock(to)}${tail}`;
  }
  return `${formatTimeDay(from)} → ${formatTimeDay(to)}`;
}

/** "còn 15 phút", "còn 3 giờ", "còn 2 ngày", "bắt đầu 08:00 26/11", "đã hết hạn". */
export function timeLeftText(effectiveSec: number, invalidSec: number, nowMs: number): string {
  const nowSec = Math.floor(nowMs / 1000);
  if (effectiveSec > nowSec) return `bắt đầu ${formatTimeDay(effectiveSec * 1000)}`;
  const left = invalidSec - nowSec;
  if (left <= 0) return "đã hết hạn";
  if (left < 3600) return `còn ${Math.max(1, Math.ceil(left / 60))} phút`;
  if (left < 86_400) return `còn ${Math.floor(left / 3600)} giờ`;
  return `còn ${Math.floor(left / 86_400)} ngày`;
}

/** Còn ≤ 30 phút ⇒ tô vàng. */
export const TEMP_SOON_SEC = 30 * 60;

export interface TempPasswordCard {
  id: number;
  name: string;
  purpose: string | null;
  window: string | null;
  left: string | null;
  soon: boolean;
  /** Phần thời gian còn lại, 0…100. */
  remainingPct: number;
  meta: string | null;
  deliveryPending: boolean;
}

const tempName = (item: DoorTempPassword) => item.name ?? `Mã #${item.id}`;

/**
 * Hai nhóm "Đang hiệu lực" và "Sắp hiệu lực". Mã thiếu giờ hiệu lực (SmartLife trả thiếu) vẫn hiện
 * ở nhóm đang hiệu lực, không đoán giờ.
 */
export function tempPasswordCards(
  passwords: readonly DoorTempPassword[],
  createdBy: ReadonlyMap<string, DoorActionLog>,
  nowMs: number,
): { active: TempPasswordCard[]; upcoming: TempPasswordCard[] } {
  const nowSec = Math.floor(nowMs / 1000);
  const active: TempPasswordCard[] = [];
  const upcoming: TempPasswordCard[] = [];
  for (const item of passwords) {
    const log = createdBy.get(String(item.id)) ?? null;
    const hasWindow = item.effectiveSec !== null && item.invalidSec !== null;
    const eff = item.effectiveSec ?? 0;
    const inv = item.invalidSec ?? 0;
    const later = hasWindow && eff > nowSec;
    const total = inv - eff;
    const remainingPct = !hasWindow || later || total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round(((inv - nowSec) / total) * 100)));
    const createdAt = log ? Date.parse(log.created_at) : Number.NaN;
    const creator = log ? `${log.actor_name ?? "Không rõ người"} tạo lúc ${Number.isFinite(createdAt) ? formatClock(createdAt) : "?"}` : null;
    const hint = deliveryHint(item.deliveryStatus);
    const card: TempPasswordCard = {
      id: item.id,
      name: tempName(item),
      purpose: log ? purposeLabel(log.detail?.purpose) : null,
      window: hasWindow ? validityWindowText(eff, inv, nowMs) : null,
      left: hasWindow ? timeLeftText(eff, inv, nowMs) : null,
      soon: hasWindow && !later && inv - nowSec <= TEMP_SOON_SEC,
      remainingPct,
      meta: [creator, hint].filter(Boolean).join(" · ") || null,
      deliveryPending: item.deliveryStatus === 1,
    };
    (later ? upcoming : active).push(card);
  }
  return { active, upcoming };
}

/** Câu "Dùng được …" của tin gửi khách. */
export function validitySentence(effectiveSec: number, invalidSec: number, nowMs: number): string {
  const from = effectiveSec * 1000;
  const to = invalidSec * 1000;
  if (vnDate(from) === vnDate(to)) {
    const when = vnDate(from) === vnDate(nowMs) ? `hôm nay (${formatDayMonth(from)})` : `ngày ${formatDayMonth(from)}`;
    return `Dùng được từ ${formatClock(from)} đến ${formatClock(to)} ${when}.`;
  }
  return `Dùng được từ ${formatTimeDay(from)} đến ${formatTimeDay(to)}.`;
}

/**
 * Tin soạn sẵn gửi người nhận mã (Zalo/tin nhắn). Chỉ sinh khi bấm gửi/sao chép, không lưu ở đâu.
 */
export function tempPasswordShareText(input: {
  doorName: string;
  buildingName: string | null;
  code: string;
  effectiveSec: number;
  invalidSec: number;
  nowMs: number;
}): string {
  const door = input.buildingName ? `${input.doorName} toà ${input.buildingName}` : input.doorName;
  return `Mã mở ${door}: ${input.code}. ${validitySentence(input.effectiveSec, input.invalidSec, input.nowMs)} Nhập mã trên bàn phím ở cửa.`;
}

// ---------------------------------------------------------------------------------------------
// Lịch sử ra vào

export const HISTORY_FILTERS = ["all", "fingerprint", "card", "password", "temporary", "remote", "alarm"] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export const HISTORY_FILTER_LABEL: Record<HistoryFilter, string> = {
  all: "Tất cả",
  fingerprint: "Vân tay",
  card: "Thẻ",
  password: "Mật khẩu",
  temporary: "Mã tạm",
  remote: "Từ xa",
  alarm: "Cảnh báo",
};

/** Nhóm lọc của một lượt (null = chỉ hiện ở "Tất cả", vd chuông, khuôn mặt). */
export function recordFilterOf(record: Pick<DoorRecord, "kind" | "method">): Exclude<HistoryFilter, "all"> | null {
  if (record.kind === "alarm") return "alarm";
  if (record.kind === "doorbell") return null;
  switch (record.method) {
    case "fingerprint":
    case "card":
    case "password":
      return record.method;
    case "temporary":
    case "dynamic":
      return "temporary";
    case "app":
    case "remote":
      return "remote";
    default:
      return null;
  }
}

export type HistoryTone = "fp" | "plain" | "temp" | "remote" | "alarm";

export interface HistoryRow {
  id: string;
  at: number | null;
  time: string;
  who: string;
  sub: string;
  how: string;
  tone: HistoryTone;
  alarm: boolean;
  /** Khách đã trả phòng mà số vẫn mở cửa — tô nổi. */
  movedOut: boolean;
  muted: boolean;
}

const TONE_OF: Record<Exclude<HistoryFilter, "all">, HistoryTone> = {
  fingerprint: "fp",
  card: "plain",
  password: "plain",
  temporary: "temp",
  remote: "remote",
  alarm: "alarm",
};

export function historyRow(
  record: DoorRecord,
  links: ReadonlyMap<string, DoorKeyLink>,
  tempNames: ReadonlyMap<string, string>,
  tempLogs: ReadonlyMap<string, DoorActionLog>,
): HistoryRow {
  const person = recordPerson(record, links, tempNames);
  const filter = recordFilterOf(record);
  const base = {
    id: record.id,
    at: record.at,
    time: record.at === null ? "—" : formatClock(record.at),
    how: recordMethodLabel(record),
    tone: filter ? TONE_OF[filter] : ("plain" as const),
    alarm: record.kind === "alarm",
    movedOut: person.link?.tenancy === "MOVED_OUT",
    muted: person.source === "none",
  };
  if (record.kind === "doorbell") return { ...base, who: "Có người bấm chuông", sub: "Không mở cửa", muted: false };
  if (record.kind === "alarm") {
    return { ...base, who: person.source === "none" ? "Cảnh báo từ máy cửa" : person.name, sub: "Xem chi tiết trong SmartLife", muted: false };
  }
  const who = person.detail ? `${person.name} · ${person.detail}` : person.name;
  let sub: string;
  if (person.source === "link" && person.link) {
    sub = person.link.tenancy === "CURRENT" ? "Khách thuê" : TENANCY_LABEL[person.link.tenancy];
  } else if (person.source === "temp") {
    const log = record.slot === null ? null : tempLogs.get(String(record.slot)) ?? null;
    sub = log?.actor_name ? `Mã do ${log.actor_name} tạo` : "Mã tạm tạo từ CRM";
  } else if (person.source === "device") {
    sub = isLinkableMethod(record.method) ? "Tên trên máy · chưa gắn" : "Tên trên máy";
  } else if (filter === "remote") {
    sub = "Mở từ app hoặc CRM";
  } else if (record.method === "temporary") {
    // Không có tên: mã tạo ngoài CRM, hoặc nhật ký tạo mã chưa tải được — không đoán.
    sub = "Mã tạm";
  } else {
    sub = isLinkableMethod(record.method) ? "Chưa gắn người" : "—";
  }
  return { ...base, who, sub };
}

/** Đếm theo nhóm lọc, trên các lượt ĐÃ TẢI. */
export function historyCounts(records: readonly DoorRecord[]): Record<HistoryFilter, number> {
  const counts = Object.fromEntries(HISTORY_FILTERS.map((filter) => [filter, 0])) as Record<HistoryFilter, number>;
  for (const record of records) {
    counts.all += 1;
    const filter = recordFilterOf(record);
    if (filter) counts[filter] += 1;
  }
  return counts;
}

/** Chip hiện ra: "Tất cả", chip đang chọn, và các nhóm có ít nhất một lượt. */
export function visibleHistoryFilters(counts: Record<HistoryFilter, number>, active: HistoryFilter): HistoryFilter[] {
  return HISTORY_FILTERS.filter((filter) => filter === "all" || filter === active || counts[filter] > 0);
}

/** Gom theo ngày (giữ thứ tự mới ⇒ cũ của nguồn). Lượt không rõ giờ gom cuối, tiêu đề "Không rõ giờ". */
export function groupByDay<T extends { at: number | null }>(rows: readonly T[], nowMs: number): Array<{ key: string; title: string; rows: T[] }> {
  const groups = new Map<string, { key: string; title: string; rows: T[] }>();
  for (const row of rows) {
    const key = row.at === null ? "unknown" : vnDate(row.at);
    let group = groups.get(key);
    if (!group) {
      group = { key, title: row.at === null ? "Không rõ giờ" : vnDayTitle(row.at, nowMs), rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  const out = [...groups.values()];
  const unknown = out.findIndex((group) => group.key === "unknown");
  if (unknown >= 0) out.push(...out.splice(unknown, 1));
  return out;
}

/** "24/11 – 25/11" hoặc "25/11" (một ngày). Nhận "YYYY-MM-DD". */
export function dateRangeText(from: string, to: string): string {
  const short = (date: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    return m ? `${m[3]}/${m[2]}` : date;
  };
  return from === to ? short(from) : `${short(from)} – ${short(to)}`;
}

// ---------------------------------------------------------------------------------------------
// Đối chiếu

export interface ReconcileSections {
  onDevice: number;
  linked: number;
  unlinked: number;
  needsDelete: ReconcileRow[];
  unlinkedRows: ReconcileRow[];
  gone: ReconcileRow[];
  linkedOk: ReconcileRow[];
  /** "32 khách đang thuê · 3 nhân viên · 1 không có HĐ ở tòa" */
  linkedOkSummary: string;
}

export function reconcileSections(result: ReconcileResult): ReconcileSections {
  const onDeviceRows = result.rows.filter((row) => row.onDevice);
  const linkedOk = onDeviceRows.filter((row) => row.link !== null && !row.needsDelete);
  const count = (tenancy: string) => linkedOk.filter((row) => row.link?.tenancy === tenancy).length;
  const parts = [
    count("CURRENT") ? `${count("CURRENT")} khách đang thuê` : null,
    count("STAFF") ? `${count("STAFF")} nhân viên` : null,
    count("NO_CONTRACT") ? `${count("NO_CONTRACT")} không có HĐ ở tòa` : null,
  ].filter(Boolean);
  return {
    onDevice: onDeviceRows.length,
    linked: onDeviceRows.filter((row) => row.link !== null).length,
    unlinked: result.unlinked,
    needsDelete: result.needsDelete,
    unlinkedRows: onDeviceRows.filter((row) => row.link === null),
    gone: result.gone,
    linkedOk,
    linkedOkSummary: parts.join(" · "),
  };
}

/** "Vân tay #9 · Trần Minh Khôi" */
export function reconcileRowTitle(row: ReconcileRow): string {
  const what = unlockTypeLabel(row.unlockType, row.sn);
  const who = row.link ? row.link.customer_name ?? row.link.label : null;
  return who ? `${what} · ${who}` : what;
}

/** Các số khách đang có trong CRM: "đã có Vân tay #12, Thẻ #3" / "chưa có số nào". */
export function customerKeysText(links: readonly DoorKeyLink[], customerId: string): string {
  const own = links
    .filter((link) => link.customer_id === customerId)
    .sort((a, b) => a.unlock_type.localeCompare(b.unlock_type) || a.unlock_sn - b.unlock_sn)
    .map((link) => unlockTypeLabel(link.unlock_type, link.unlock_sn));
  return own.length ? `đã có ${own.join(", ")}` : "chưa có số nào";
}

// ---------------------------------------------------------------------------------------------
// Nhật ký thao tác

export const LOG_FILTERS = ["all", "remote", "temp", "key", "device"] as const;
export type LogFilter = (typeof LOG_FILTERS)[number];

export const LOG_FILTER_LABEL: Record<LogFilter, string> = {
  all: "Tất cả",
  remote: "Mở cửa",
  temp: "Mã tạm",
  key: "Vân tay, thẻ",
  device: "Thiết bị",
};

/** Nhóm lọc ⇒ `p_actions` của RPC nhật ký (null = mọi thao tác). */
export const LOG_FILTER_ACTIONS: Record<LogFilter, readonly DoorAction[] | null> = {
  all: null,
  remote: ["REMOTE_UNLOCK"],
  temp: ["TEMP_PASSWORD_CREATE", "TEMP_PASSWORD_DELETE"],
  key: ["KEY_DELETE", "KEY_LINK", "KEY_UNLINK"],
  device: ["DEVICE_SAVE", "DEVICE_DISABLE"],
};

// ---------------------------------------------------------------------------------------------
// Quản lý — quyền của người dùng ở toà của máy

export function permissionRows(can: DoorDeviceCan): Array<{ key: keyof DoorDeviceCan; label: string; granted: boolean; note: string | null }> {
  return [
    { key: "view", label: "Xem lịch sử ra vào", granted: can.view, note: null },
    { key: "temp_password", label: "Tạo và xoá mã tạm", granted: can.temp_password, note: null },
    { key: "remote_unlock", label: "Mở cửa từ xa", granted: can.remote_unlock, note: can.remote_unlock ? "10 lần / 10 phút" : null },
    { key: "manage_devices", label: "Quản lý máy và vân tay", granted: can.manage_devices, note: null },
  ];
}

/** Bốn mục thanh dưới. "Cửa" luôn có (chọn cửa + trạng thái nút mở); các mục khác theo quyền ở toà. */
export const MOBILE_TABS = ["door", "temp", "history", "manage"] as const;
export type MobileTab = (typeof MOBILE_TABS)[number];

export const MOBILE_TAB_LABEL: Record<MobileTab, string> = {
  door: "Cửa",
  temp: "Mã tạm",
  history: "Lịch sử",
  manage: "Quản lý",
};

export function visibleMobileTabs(can: DoorDeviceCan | null, canManageAnywhere: boolean): MobileTab[] {
  return MOBILE_TABS.filter((tab) => {
    if (tab === "door") return true;
    if (tab === "temp") return Boolean(can?.temp_password);
    if (tab === "history") return Boolean(can?.view);
    return Boolean(can?.view) || Boolean(can?.manage_devices) || canManageAnywhere;
  });
}
