// Hợp đồng dữ liệu và công thức hiển thị của các màn «xem theo người» (/my-day/...).
// Biên nhận zod chặn dữ liệu sai dạng: thiếu nguồn thì báo lỗi, không vẽ số 0.
import { z } from "zod";
import { haversineKm } from "@/lib/v5Routing";

export const VN_TZ = "Asia/Ho_Chi_Minh";

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stamp = z.string().min(1);
const count = z.number().int().nonnegative();
const num = z.number().finite().nullable().optional();
const text = z.string().nullable().optional();

// --- Điểm danh GPS -----------------------------------------------------------
export const gpsSlotSchema = z.object({
  at: stamp,
  status: z.enum(["ok", "ok_stationary", "missing", "paused", "pending", "future"]),
  reason: text,
  recorded_at: stamp.nullable().optional(),
  lat: num,
  lng: num,
  accuracy_m: num,
  is_mock: z.boolean().optional().default(false),
  battery_pct: num,
  nearest_building_id: text,
  nearest_building_name: text,
  nearest_distance_m: num,
});
export type GpsSlot = z.infer<typeof gpsSlotSchema>;

const gpsWindowSchema = z.object({ from: z.string(), to: z.string() });
export type GpsWindow = z.infer<typeof gpsWindowSchema>;

const gpsCountsSchema = z.object({
  ok: count, stationary: count, missing: count, paused: count, pending: count, future: count, mock: count,
});
export type GpsCounts = z.infer<typeof gpsCountsSchema>;

export const gpsDaySchema = z.object({
  enabled: z.boolean(),
  interval_min: z.number().int().nullable(),
  late_tolerance_min: z.number().int().nullable(),
  windows: z.array(gpsWindowSchema),
  paired: z.boolean(),
  slots: z.array(gpsSlotSchema),
  counts: gpsCountsSchema,
});
export type GpsDay = z.infer<typeof gpsDaySchema>;

// --- Sự kiện trong ngày ------------------------------------------------------
const place = {
  at: stamp,
  building_id: text,
  building_name: text,
  lat: num,
  lng: num,
};
const sessionPhotoSchema = z.object({
  path: z.string().min(1),
  slot: text,
  label: text,
  geofence_status: text,
  distance_m: num,
  lat: num,
  lng: num,
});
export type SessionPhoto = z.infer<typeof sessionPhotoSchema>;

const sessionOpenSchema = z.object({
  kind: z.literal("session_open"), ...place, session_id: z.string(),
  type: z.enum(["FULL", "QUICK"]), status: z.string(), prev_full_date: dateKey.nullable().optional(),
});
const sessionPhotosSchema = z.object({
  kind: z.literal("session_photos"), ...place, session_id: z.string(), photos: z.array(sessionPhotoSchema),
});
const sessionDoneSchema = z.object({
  kind: z.literal("session_done"), ...place, session_id: z.string(),
  type: z.enum(["FULL", "QUICK"]), status: z.string(), dwell_seconds: z.number(),
  condition_note: text, fail_reasons: z.array(z.string()).nullable().optional(),
  spawned_job_id: text, counted: z.boolean(),
});
const jobDoneSchema = z.object({
  kind: z.literal("job_done"), ...place, job_id: z.string(), title: z.string(),
  distance_m: num, geofence_status: text, photo_count: count, counted: z.boolean(),
});
const paymentSchema = z.object({
  kind: z.literal("payment"), ...place, collection_id: z.string(), room_name: text,
  methods: z.array(z.string()).nullable().optional(), distance_m: num, geofence_status: text,
});

export const staffEventSchema = z.discriminatedUnion("kind", [
  sessionOpenSchema, sessionPhotosSchema, sessionDoneSchema, jobDoneSchema, paymentSchema,
]);
export type StaffEvent = z.infer<typeof staffEventSchema>;
type SessionOpenEvent = z.infer<typeof sessionOpenSchema>;
type SessionDoneEvent = z.infer<typeof sessionDoneSchema>;
type PaymentEvent = z.infer<typeof paymentSchema>;

const userSchema = z.object({ id: z.string(), name: z.string(), role_title: text });
export type StaffUser = z.infer<typeof userSchema>;

const daySchema = z.object({
  status: z.string(), tick_source: text, ticked_at: stamp.nullable().optional(), building_name: text,
});
export type StaffDayStatus = z.infer<typeof daySchema>;

const nowPhotoSchema = sessionPhotoSchema.pick({ path: true, slot: true, label: true, geofence_status: true, distance_m: true });
const nowSchema = z.object({
  session_id: z.string(), building_id: z.string(), building_name: z.string(),
  type: z.enum(["FULL", "QUICK"]), status: z.string(), started_at: stamp, photos_count: count,
  items_total: count, items_done: count, items_missing: z.array(z.string()), photos: z.array(nowPhotoSchema),
});
export type StaffNow = z.infer<typeof nowSchema>;

// --- Màn cả đội --------------------------------------------------------------
const teamGpsSchema = gpsDaySchema.omit({ slots: true }).extend({ last_ok: gpsSlotSchema.nullable().optional() });
const teamNowSchema = nowSchema.partial({ items_total: true, items_done: true, items_missing: true, photos: true });

export const teamSchema = z.object({
  date: dateKey,
  is_today: z.boolean(),
  as_of: stamp,
  organization_id: z.string(),
  members: z.array(z.object({
    user: userSchema,
    buildings_assigned: count,
    day: daySchema,
    now: teamNowSchema.nullable().optional(),
    visited_today: count,
    due_remaining: count,
    jobs_done: count,
    payments: count,
    last_event: staffEventSchema.nullable().optional(),
    gps: teamGpsSchema,
  })),
  overdue_buildings: z.array(z.object({
    building_id: z.string(), building_name: z.string(), kind: z.enum(["touch", "full"]),
    days: z.number().int().nullable(), managers: z.array(z.string()),
  })),
});
export type StaffTeam = z.infer<typeof teamSchema>;
export type StaffTeamMember = StaffTeam["members"][number];

// --- Màn một người -----------------------------------------------------------
export const summarySchema = z.object({
  date: dateKey,
  is_today: z.boolean(),
  as_of: stamp,
  user: userSchema,
  day: daySchema,
  attend: z.object({ n_chuan: z.number().int().nullable(), ticked_days: count }),
  streak: z.object({
    current: count, best: count, breaks_no_leave: count, updated_at: stamp,
  }).nullable().optional(),
  pending_checks: z.array(z.object({ building_id: z.string(), building_name: text })),
  now: nowSchema.nullable().optional(),
  gps: gpsDaySchema.nullable().optional(),
  open_jobs: z.object({
    total: count,
    items: z.array(z.object({
      id: z.string(), code: z.string(), title: z.string(),
      building_id: text, building_name: text, deadline: stamp.nullable().optional(), priority: z.string(),
    })),
  }),
  recent_events: z.array(staffEventSchema),
});
export type StaffSummary = z.infer<typeof summarySchema>;

const routeItemSchema = z.object({
  building_id: z.string(),
  building_name: z.string(),
  days_since_touch: z.number().int().nullable(),
  days_since_full: z.number().int().nullable(),
  priority_bucket: z.number().int(),
  priority_label: z.string(),
  touch_sla_days: z.number().int(),
  full_interval_days: z.number().int(),
  visited_today: z.boolean(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  reason: z.string().nullable().optional(),
});
export const routeSchema = z.object({ as_of: stamp, items: z.array(routeItemSchema) });
export type StaffRouteItem = z.infer<typeof routeItemSchema>;

// --- Hành trình --------------------------------------------------------------
export const journeySchema = z.object({
  date: dateKey,
  is_today: z.boolean(),
  as_of: stamp,
  user: userSchema,
  day: daySchema,
  events: z.array(staffEventSchema),
  gps: gpsDaySchema.nullable().optional(),
});
export type StaffJourney = z.infer<typeof journeySchema>;

// --- Lịch tháng --------------------------------------------------------------
const dayKindSchema = z.enum([
  "ticked", "leave", "pending_leave", "flagged", "future", "before_start", "sunday", "holiday", "today_pending", "missed",
]);
export type StaffDayKind = z.infer<typeof dayKindSchema>;

export const calendarSchema = z.object({
  month: dateKey,
  first_month: dateKey,
  as_of: stamp,
  user: userSchema,
  days: z.array(z.object({
    date: dateKey, kind: dayKindSchema, tick_source: text,
    buildings: count, sessions: count, jobs: count, payments: count,
    gps: gpsCountsSchema.nullable().optional(),
  })),
  totals: z.object({
    ticked_days: count, n_chuan: z.number().int().nullable(), leave_days: count, visits: count,
    best_streak: count.nullable(), current_streak: count.nullable(),
  }),
});
export type StaffCalendar = z.infer<typeof calendarSchema>;
export type StaffCalendarDay = StaffCalendar["days"][number];

// --- Báo cáo kỳ --------------------------------------------------------------
const metricsSchema = z.object({
  ticked_days: count, n_chuan: count, best_streak: count.nullable(), breaks_no_leave: count.nullable(),
  leave_days: count, full_passed: count, full_presence: count, full_expired: count,
  avg_dwell_seconds: z.number().nullable(), photos_total: count, photos_out_of_range: count, photos_gps_denied: count,
  jobs_total: count, jobs_on_time: count, payments_total: count, payments_gps_ok: count,
  gps_ok: count, gps_stationary: count, gps_missing: count, gps_paused: count, gps_mock: count, flagged: count,
});
export type StaffMetrics = z.infer<typeof metricsSchema>;

export const reportSchema = z.object({
  from: dateKey,
  to: dateKey,
  measured_to: dateKey,
  is_month: z.boolean(),
  as_of: stamp,
  organization_id: z.string(),
  members: z.array(z.object({
    user: userSchema,
    metrics: metricsSchema,
    overdue: z.object({
      buildings: count,
      times: count,
      items: z.array(z.object({
        building_id: z.string(), building_name: z.string(), times: count, max_gap_days: z.number().int(),
      })),
    }),
    days: z.array(z.object({ date: dateKey, kind: dayKindSchema })),
    review: z.object({
      rating: z.enum(["A", "B", "C"]).nullable(), note: text, updated_at: stamp,
    }).nullable().optional(),
  })),
});
export type StaffReport = z.infer<typeof reportSchema>;
export type StaffReportMember = StaffReport["members"][number];

// --- Ngày giờ ----------------------------------------------------------------
const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"] as const;

export function vnTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: VN_TZ });
}

export function vnDateOf(iso: string | Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: VN_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(typeof iso === "string" ? new Date(iso) : iso);
  return parts;
}

const utcNoon = (key: string) => new Date(`${key}T12:00:00Z`);

export function addDays(key: string, days: number): string {
  const d = utcNoon(key);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(monthKey: string, months: number): string {
  const [y, m] = monthKey.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  return d.toISOString().slice(0, 7);
}

export function monthLastDay(monthKey: string): string {
  return addDays(`${addMonths(monthKey, 1)}-01`, -1);
}

/** Thứ Bảy, 07/11 */
export function dayTitle(key: string): string {
  const d = utcNoon(key);
  return `${WEEKDAYS[d.getUTCDay()]}, ${key.slice(8, 10)}/${key.slice(5, 7)}`;
}

export function shortDate(key: string): string {
  return `${key.slice(8, 10)}/${key.slice(5, 7)}`;
}

/** Số ngày từ a tới b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((utcNoon(b).getTime() - utcNoon(a).getTime()) / 86_400_000);
}

/** Thứ của ngày, 0 = Thứ Hai … 6 = Chủ nhật (lịch bắt đầu từ Thứ Hai). */
export function mondayIndex(key: string): number {
  return (utcNoon(key).getUTCDay() + 6) % 7;
}

export function minutesBetween(fromIso: string, to: Date = new Date()): number {
  return Math.max(0, Math.round((to.getTime() - new Date(fromIso).getTime()) / 60_000));
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1).replace(".", ",")} km`;
}

// --- Nhãn trạng thái ngày ----------------------------------------------------
export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const SOURCE_LABEL: Record<string, string> = {
  JOB: "hoàn thành việc",
  FULL: "kiểm tra nhà đạt",
  PAYMENT: "thu tiền + check nhà",
  MANUAL_DEVICE_ISSUE: "duyệt tay (sự cố thiết bị)",
};

export function tickSourceLabel(source?: string | null): string {
  return source ? (SOURCE_LABEL[source] ?? source) : "";
}

export function dayBadge(day: StaffDayStatus): { label: string; tone: Tone } {
  switch (day.status) {
    case "ticked": return { label: "Đã có ngày công", tone: "success" };
    case "leave_approved": return { label: "Nghỉ phép", tone: "info" };
    case "pending_leave": return { label: "Chờ duyệt phép", tone: "info" };
    case "pending_check": return { label: "Chờ check sau thu tiền", tone: "warning" };
    case "flagged": return { label: "Đang nghi án", tone: "danger" };
    case "voided": return { label: "Ngày công bị huỷ", tone: "danger" };
    case "expired": return { label: "Không có ngày công", tone: "danger" };
    default: return { label: "Chưa có ngày công", tone: "warning" };
  }
}

// --- Dòng thời gian ----------------------------------------------------------
export interface TimelineRow {
  key: string;
  at: string;
  time: string;
  title: string;
  sub: string | null;
  tone: "inspect" | "job" | "payment" | "gps" | "warn" | "open";
  strong: boolean;
  badge: { text: string; tone: "success" | "warning" } | null;
  photos: SessionPhoto[] | null;
}

const METHOD_LABEL: Record<string, string> = { TM: "tiền mặt", TK: "chuyển khoản", TT: "thẻ/ví", CT: "cấn trừ" };

function gpsPhrase(status?: string | null, distance?: number | null): string {
  if (status === "ok") return distance != null ? `GPS khớp ${Math.round(distance)} m` : "GPS khớp";
  if (status === "out_of_range") return distance != null ? `GPS lệch ${formatDistance(distance)}` : "GPS lệch toà";
  if (status === "gps_denied") return "thiếu GPS";
  return "không có GPS";
}

export function photoCounts(photos: readonly SessionPhoto[]) {
  const outOfRange = photos.filter((p) => p.geofence_status === "out_of_range");
  return {
    total: photos.length,
    ok: photos.filter((p) => p.geofence_status === "ok").length,
    outOfRange: outOfRange.length,
    denied: photos.filter((p) => p.geofence_status === "gps_denied").length,
    maxOutOfRange: outOfRange.reduce((max, p) => Math.max(max, p.distance_m ?? 0), 0),
  };
}

function photoSummary(photos: readonly SessionPhoto[]): string {
  const c = photoCounts(photos);
  const parts: string[] = [];
  if (c.ok) parts.push(`${c.ok} ảnh GPS khớp`);
  if (c.outOfRange) parts.push(`${c.outOfRange} ảnh ngoài vùng ${c.maxOutOfRange ? formatDistance(c.maxOutOfRange) : ""}`.trim());
  if (c.denied) parts.push(`${c.denied} ảnh thiếu GPS`);
  return parts.join(" · ");
}

function typeWord(type: "FULL" | "QUICK"): string {
  return type === "FULL" ? "FULL" : "nhanh";
}

export function eventRow(event: StaffEvent, dayKey: string): TimelineRow {
  const building = event.building_name ?? "toà chưa rõ";
  const base = { at: event.at, time: vnTime(event.at), badge: null, photos: null, strong: false, sub: null as string | null };
  switch (event.kind) {
    case "session_open": {
      const open = event.status === "open";
      let sub: string | null = null;
      if (event.type === "FULL") {
        sub = event.prev_full_date
          ? `toà ${daysBetween(event.prev_full_date, dayKey)} ngày chưa kiểm tra FULL`
          : "toà chưa từng kiểm tra FULL";
      }
      return {
        ...base, key: `open-${event.session_id}`, tone: open ? "open" : "inspect", strong: true, sub,
        title: `Bắt đầu kiểm tra nhà ${typeWord(event.type)} · ${building}${open ? " — đang làm" : ""}`,
      };
    }
    case "session_photos":
      return {
        ...base, key: `photos-${event.session_id}`, tone: "inspect",
        title: `Chụp ${event.photos.length} ảnh theo mục`,
        sub: photoSummary(event.photos) || null,
        photos: event.photos,
      };
    case "session_done": {
      const minutes = Math.round(event.dwell_seconds / 60);
      const note = event.condition_note && event.condition_note.trim().toUpperCase() !== "OK" ? event.condition_note.trim() : null;
      const fails = event.fail_reasons?.length ? `thiếu: ${event.fail_reasons.join(", ")}` : null;
      const spawned = event.spawned_job_id ? "tự sinh việc sửa" : null;
      const title = event.status === "passed"
        ? `Hoàn tất — ĐẠT · ${minutes} phút tại toà`
        : event.status === "quick_done"
          ? `Check nhanh xong · ${minutes} phút tại toà`
          : `Có mặt, chưa đủ điều kiện · ${minutes} phút tại toà`;
      return {
        ...base, key: `done-${event.session_id}`, tone: event.status === "presence" ? "warn" : "inspect", strong: true, title,
        sub: [note, fails, spawned].filter(Boolean).join(" · ") || null,
        badge: event.counted ? { text: "Ngày công được tính từ phiên này", tone: "success" } : null,
      };
    }
    case "job_done":
      return {
        ...base, key: `job-${event.job_id}`, tone: "job",
        title: `Hoàn thành việc «${event.title}»${event.building_name ? ` · ${event.building_name}` : ""}`,
        sub: `${event.photo_count} ảnh · ${gpsPhrase(event.geofence_status, event.distance_m)}`,
        badge: event.counted ? { text: "Ngày công được tính từ việc này", tone: "success" } : null,
      };
    case "payment": {
      const methods = (event.methods ?? []).map((m) => METHOD_LABEL[m] ?? m).join(", ");
      return {
        ...base, key: `pay-${event.collection_id}`, tone: "payment", strong: true,
        title: `Thu tiền${event.room_name ? ` ${event.room_name}` : ""} · ${building}`,
        sub: [methods, gpsPhrase(event.geofence_status, event.distance_m)].filter(Boolean).join(" · "),
      };
    }
  }
}

const GPS_REASON: Record<string, string> = {
  permission_denied: "máy tắt quyền vị trí",
  location_off: "máy tắt định vị",
  timeout: "máy không lấy được vị trí",
  paused: "quản lý tạm dừng",
};

export function gpsReasonLabel(reason?: string | null): string {
  return reason ? (GPS_REASON[reason] ?? reason) : "máy không báo gì";
}

function gpsPlace(slot: GpsSlot): string {
  if (slot.lat == null) return "vị trí đã hết hạn lưu";
  if (slot.nearest_building_name && slot.nearest_distance_m != null) {
    return `${slot.nearest_distance_m <= 150 ? "tại" : "cách"} ${slot.nearest_building_name}${slot.nearest_distance_m <= 150 ? "" : ` ${formatDistance(slot.nearest_distance_m)}`}`;
  }
  return "đang di chuyển";
}

function gpsRow(first: GpsSlot, last: GpsSlot, n: number): TimelineRow {
  const isOk = first.status === "ok" || first.status === "ok_stationary";
  const time = vnTime(first.at);
  const range = n > 1 ? ` · ${time}–${vnTime(last.at)} (${n} mốc)` : "";
  if (first.status === "paused") {
    return {
      key: `gps-${first.at}`, at: first.at, time, tone: "warn", strong: false, badge: null, photos: null,
      title: `Điểm danh — ĐÃ TẮT${range}`, sub: "quản lý tạm dừng",
    };
  }
  if (!isOk) {
    return {
      key: `gps-${first.at}`, at: first.at, time, tone: "warn", strong: true, badge: null, photos: null,
      title: `Điểm danh — MẤT TÍN HIỆU${range}`, sub: gpsReasonLabel(first.reason),
    };
  }
  return {
    key: `gps-${first.at}`, at: first.at, time, tone: "gps", strong: false, badge: null, photos: null,
    title: `Điểm danh tự động${range}`,
    sub: [gpsPlace(first), first.status === "ok_stationary" ? "máy đứng yên" : null, first.is_mock ? "nghi vị trí giả" : null].filter(Boolean).join(" · "),
  };
}

/** Gộp mốc GPS liền nhau cùng trạng thái, cùng chỗ để dòng thời gian không dài vô ích. */
function gpsRows(slots: readonly GpsSlot[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let group: GpsSlot[] = [];
  const flush = () => {
    const first = group[0];
    const last = group[group.length - 1];
    if (first && last) rows.push(gpsRow(first, last, group.length));
    group = [];
  };
  const groupKey = (s: GpsSlot) => `${s.status}|${s.reason ?? ""}|${s.nearest_building_id ?? ""}|${s.is_mock ? 1 : 0}`;
  for (const slot of slots) {
    if (slot.status === "future" || slot.status === "pending") continue;
    const head = group[0];
    if (head && groupKey(head) !== groupKey(slot)) flush();
    group.push(slot);
  }
  flush();
  return rows;
}

/** Gộp các lần thu tiền liền nhau ở cùng toà thành một dòng. */
function collapsePayments(events: readonly StaffEvent[], dayKey: string): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let run: PaymentEvent[] = [];
  const flush = () => {
    const first = run[0];
    if (first) {
      if (run.length === 1) rows.push(eventRow(first, dayKey));
      else {
        const rooms = run.map((p) => p.room_name).filter(Boolean).slice(0, 6).join(", ");
        rows.push({
          ...eventRow(first, dayKey),
          title: `Thu tiền ${run.length} phòng · ${first.building_name ?? "toà chưa rõ"}`,
          sub: rooms || null,
        });
      }
    }
    run = [];
  };
  for (const event of events) {
    if (event.kind === "payment") {
      const head = run[0];
      if (head && head.building_id !== event.building_id) flush();
      run.push(event);
    } else {
      flush();
      rows.push(eventRow(event, dayKey));
    }
  }
  flush();
  return rows;
}

export function timelineRows(events: readonly StaffEvent[], slots: readonly GpsSlot[], dayKey: string): TimelineRow[] {
  return [...collapsePayments(events, dayKey), ...gpsRows(slots)]
    .sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

// --- Bản đồ ------------------------------------------------------------------
export interface JourneyStop {
  seq: number;
  buildingId: string | null;
  name: string;
  lat: number;
  lng: number;
  firstAt: string;
  lastAt: string;
  state: "passed" | "open" | "payment" | "job" | "presence";
}
export interface JourneyPoint { lat: number; lng: number; at: string; kind: "stop" | "gps"; ok: boolean }
export interface OutOfRangePoint { lat: number; lng: number; distance: number | null }

const hasPoint = (lat?: number | null, lng?: number | null): boolean => typeof lat === "number" && typeof lng === "number";

/** Điểm dừng: chỉ tính sự kiện có toạ độ; sự kiện liền nhau cùng toà gộp thành một ghim. */
export function journeyStops(events: readonly StaffEvent[]): JourneyStop[] {
  const stops: JourneyStop[] = [];
  for (const event of events) {
    if (event.lat == null || event.lng == null) continue;
    const buildingId = event.building_id ?? null;
    const state: JourneyStop["state"] =
      event.kind === "payment" ? "payment"
        : event.kind === "job_done" ? "job"
          : event.kind === "session_done"
            ? (event.status === "presence" ? "presence" : "passed")
            : event.kind === "session_open" && event.status === "open" ? "open"
              : "passed";
    const last = stops[stops.length - 1];
    if (last && buildingId && last.buildingId === buildingId) {
      last.lastAt = event.at;
      // Kết quả phiên mới nhất quyết định màu ghim; ảnh, việc, thu tiền cùng toà không đổi màu.
      if (event.kind === "session_open" || event.kind === "session_done") last.state = state;
      continue;
    }
    stops.push({
      seq: stops.length + 1, buildingId, name: event.building_name ?? "Điểm dừng",
      lat: event.lat, lng: event.lng, firstAt: event.at, lastAt: event.at, state,
    });
  }
  return stops;
}

export function outOfRangePoints(events: readonly StaffEvent[]): OutOfRangePoint[] {
  return events.flatMap((event) => event.kind !== "session_photos" ? [] : event.photos
    .filter((p) => p.geofence_status === "out_of_range" && hasPoint(p.lat, p.lng))
    .map((p) => ({ lat: p.lat as number, lng: p.lng as number, distance: p.distance_m ?? null })));
}

export function journeyPath(stops: readonly JourneyStop[], slots: readonly GpsSlot[]): JourneyPoint[] {
  const points: JourneyPoint[] = [
    ...stops.map((s) => ({ lat: s.lat, lng: s.lng, at: s.firstAt, kind: "stop" as const, ok: true })),
    ...slots.filter((s) => (s.status === "ok" || s.status === "ok_stationary") && hasPoint(s.lat, s.lng)).map((s) => ({
      lat: s.lat as number, lng: s.lng as number, at: s.recorded_at ?? s.at, kind: "gps" as const, ok: true,
    })),
  ];
  return points.sort((a, b) => a.at.localeCompare(b.at));
}

export function pathDistanceMeters(points: readonly JourneyPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += haversineKm({ latitude: a.lat, longitude: a.lng }, { latitude: b.lat, longitude: b.lng }) * 1000;
  }
  return total;
}

export function journeyTotals(events: readonly StaffEvent[]) {
  const done = events.filter((e): e is SessionDoneEvent => e.kind === "session_done");
  const opened = events.filter((e): e is SessionOpenEvent => e.kind === "session_open");
  const photos = events.flatMap((e) => e.kind === "session_photos" ? e.photos : []);
  return {
    sessionsPassed: done.filter((e) => e.status === "passed" || e.status === "quick_done").length,
    sessionsOpen: opened.filter((e) => e.status === "open").length,
    payments: events.filter((e) => e.kind === "payment").length,
    jobs: events.filter((e) => e.kind === "job_done").length,
    photosNoGps: photos.filter((p) => p.geofence_status === "gps_denied").length,
    dwellMinutes: Math.round(done.reduce((sum, e) => sum + e.dwell_seconds, 0) / 60),
  };
}

// --- Dải mốc điểm danh -------------------------------------------------------
export interface StripCell {
  at: string;
  label: string;
  hourLabel: string | null;
  state: GpsSlot["status"] | "off";
  mock: boolean;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Lưới đều theo cài đặt mới nhất, cộng thêm mọi mốc thật của ngày: đổi tần suất giữa ngày thì
 * các mốc đã qua theo bản cũ vẫn còn trên dải. Chỗ không có mốc là «ngoài khung giờ».
 */
export function slotStrip(gps: Pick<GpsDay, "windows" | "interval_min" | "slots">): StripCell[] {
  const step = gps.interval_min;
  if (!step || gps.windows.length === 0) return [];
  const byClock = new Map(gps.slots.map((slot) => [vnTime(slot.at), slot]));
  const slotMinutes = [...byClock.keys()].map(minutesOf);
  // Lưới neo theo khung giờ mới nhất; mốc cũ lệch lưới chỉ được chèn thêm, không kéo lệch cả lưới.
  const start = Math.min(...gps.windows.map((w) => minutesOf(w.from)));
  const end = Math.max(...gps.windows.map((w) => minutesOf(w.to)));
  const marks = new Set(slotMinutes);
  for (let minute = start; minute <= end; minute += step) marks.add(minute);
  return [...marks].sort((a, b) => a - b).map((minute) => {
    const label = hhmm(minute);
    const slot = byClock.get(label);
    return {
      at: label,
      label,
      hourLabel: minute % 60 === 0 && (minute - start) % 120 === 0 ? `${Math.floor(minute / 60)}h` : null,
      state: slot ? slot.status : "off",
      mock: slot?.is_mock === true,
    };
  });
}

export function gpsCountsText(counts: GpsCounts): string {
  const got = counts.ok + counts.stationary;
  return `${got}/${got + counts.missing}`;
}

export function gpsMockText(counts: Pick<GpsCounts, "mock"> | null | undefined): string | null {
  return counts && counts.mock > 0 ? `nghi vị trí giả ${counts.mock} mốc` : null;
}
