// Hợp đồng dữ liệu và quy tắc của điểm danh GPS tự động.
import { z } from "zod";
import { gpsDaySchema } from "@/lib/staffDay";

/** Bản app Android đang phát hành. Đăng GitHub Release từ artifact CI rồi sửa hằng số này. */
export const GPS_CHECKIN_APK = {
  version: "1.0.0",
  url: "https://github.com/zxGreenxz/whiteboard-ihomecrm/releases/download/diem-danh-v1.0.0/ihome-diem-danh.apk",
};

export const pairDeepLink = (code: string) => `ihomediemdanh://pair?c=${encodeURIComponent(code)}`;

const stamp = z.string().min(1);
const windowSchema = z.object({ from: z.string(), to: z.string() });

const deviceStateSchema = z.object({
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  sdkInt: z.number().optional(),
  appVersion: z.string().optional(),
  batteryPct: z.number().nullable().optional(),
  charging: z.boolean().optional(),
  idle: z.boolean().optional(),
  powerSave: z.boolean().optional(),
  locationEnabled: z.boolean().optional(),
  locationPermission: z.string().optional(),
  batteryOptimizationIgnored: z.boolean().optional(),
  exactAlarmAllowed: z.boolean().optional(),
  paused: z.boolean().optional(),
});

const deviceSchema = z.object({
  id: z.string(),
  paired_at: stamp,
  last_seen_at: stamp.nullable().optional(),
  last_state_at: stamp.nullable().optional(),
  state: deviceStateSchema,
});
export type GpsDevice = z.infer<typeof deviceSchema>;

const settingsSchema = z.object({
  version: z.number().int(),
  effective_from: stamp.nullable(),
  enabled: z.boolean(),
  interval_min: z.number().int(),
  late_tolerance_min: z.number().int(),
  windows: z.array(windowSchema),
  skip_sunday: z.boolean(),
  skip_holidays: z.boolean(),
  skip_approved_leave: z.boolean(),
  retention_days: z.number().int(),
});

export const gpsSettingsDocSchema = z.object({
  organization_id: z.string(),
  as_of: stamp,
  configured: z.boolean(),
  settings: settingsSchema,
  members: z.array(z.object({
    user: z.object({ id: z.string(), name: z.string(), role_title: z.string().nullable().optional() }),
    applies: z.boolean(),
    device: deviceSchema.nullable().optional(),
    last_ping_at: stamp.nullable().optional(),
  })),
});
export type GpsSettingsDoc = z.infer<typeof gpsSettingsDocSchema>;

export const gpsMyStatusSchema = z.object({
  eligible: z.boolean(),
  as_of: stamp,
  date: z.string().optional(),
  settings: z.object({
    version: z.number().int(),
    enabled: z.boolean(),
    applies: z.boolean(),
    intervalMin: z.number().int(),
    toleranceMin: z.number().int(),
    windows: z.array(z.tuple([z.string(), z.string()])),
    skipSunday: z.boolean(),
    offDates: z.array(z.string()),
    tz: z.string(),
    serverNow: stamp,
  }).optional(),
  device: deviceSchema.nullable().optional(),
  today: gpsDaySchema.optional(),
});
export type GpsMyStatus = z.infer<typeof gpsMyStatusSchema>;

export const pairStartSchema = z.object({ code: z.string().min(1), expires_at: stamp });

// --- Form cài đặt ------------------------------------------------------------
const clock = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][05]$/, "Chọn giờ theo bước 5 phút");

export const gpsSettingsFormSchema = z.object({
  enabled: z.boolean(),
  interval_min: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  late_tolerance_min: z.union([z.literal(5), z.literal(10), z.literal(15)]),
  windows: z.array(z.object({ from: clock, to: clock })).min(1, "Cần ít nhất một khung giờ").max(6, "Tối đa 6 khung giờ"),
  skip_sunday: z.boolean(),
  skip_holidays: z.boolean(),
  skip_approved_leave: z.boolean(),
}).superRefine((value, ctx) => {
  const sorted = value.windows
    .map((window, index) => ({ ...window, index }))
    .sort((a, b) => a.from.localeCompare(b.from));
  sorted.forEach((window, order) => {
    if (window.from >= window.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Giờ kết thúc phải sau giờ bắt đầu", path: ["windows", window.index, "to"] });
    }
    const previous = sorted[order - 1];
    if (previous && window.from <= previous.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Các khung giờ không được chồng hoặc chạm nhau", path: ["windows", window.index, "from"] });
    }
  });
});
export type GpsSettingsForm = z.infer<typeof gpsSettingsFormSchema>;

/** Số mốc mỗi ngày với cài đặt này (mỗi khung tính cả đầu khung). */
export function slotsPerDay(windows: readonly { from?: string; to?: string }[], intervalMin: number): number {
  const minutes = (hhmm?: string) => {
    const [h, m] = (hhmm ?? "").split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return windows.reduce((total, window) => {
    const span = minutes(window.to) - minutes(window.from);
    return span >= 0 ? total + Math.floor(span / intervalMin) + 1 : total;
  }, 0);
}

const PERMISSION_LABEL: Record<string, string> = {
  always: "Luôn luôn",
  while_in_use: "Chỉ khi mở app",
  denied: "Đã tắt",
};
export const permissionLabel = (value?: string) => (value ? (PERMISSION_LABEL[value] ?? value) : "chưa rõ");

/** Máy còn báo về gần đây không: quá hai lần chu kỳ kiểm tra nền (15 phút) coi như im lặng. */
export function deviceSilent(device: GpsDevice, now: Date = new Date()): boolean {
  if (!device.last_seen_at) return true;
  return now.getTime() - new Date(device.last_seen_at).getTime() > 45 * 60_000;
}

export function relativeMinutes(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}
