import { z } from "zod";
import {
  CAMERA_ALERT_TYPE_CODES,
  type CameraAlertDelivery, type CameraAlertDeliveryStatus, type CameraAlertSettings, type CameraAlertSettingsPatch,
  type CameraAlertTestResult, type CameraAlertTypeCode, type CameraAlertTypes, type CameraChannelMute, type CameraChannelMuteKind,
} from "./cameraContracts";
import { NetworkCenterRepositoryError } from "./supabaseRepository";

// ---------------------------------------------------------------------------
// Cảnh báo camera v2 — phần thuần của màn cài đặt (spec 2026-11-24 §2, §6):
// nhãn cho người dùng, schema form (ngưỡng theo PHÚT, máy chủ lưu GIÂY), dựng
// patch chỉ gồm khoá đổi, và câu báo lỗi không lộ mã kỹ thuật.
// ---------------------------------------------------------------------------

export type CameraAlertDeliveryMode = CameraAlertTypes[CameraAlertTypeCode]["delivery"];
export type CameraAlertSeverity = "CRITICAL" | "WARNING" | "INFO";

export const FLAPPING_CODE = "CAMERA_CHANNEL_FLAPPING" satisfies CameraAlertTypeCode;
export const STORAGE_CODE = "CAMERA_STORAGE_ERROR" satisfies CameraAlertTypeCode;

/** Cột "Nghĩa" của bảng §2 — chữ duy nhất người dùng thấy cho từng loại. */
export const CAMERA_ALERT_TYPE_INFO: Record<CameraAlertTypeCode, { label: string; hint: string; severity: CameraAlertSeverity }> = {
  CAMERA_STORAGE_ERROR: {
    label: "Ổ cứng đầu ghi báo lỗi",
    hint: "Đầu ghi có thể không lưu được video. Ngưỡng 0 phút là báo ngay.",
    severity: "CRITICAL",
  },
  CAMERA_RECORDER_OFFLINE: {
    label: "Không gọi tới được đầu ghi",
    hint: "Đầu ghi tắt hoặc toà mất mạng.",
    severity: "CRITICAL",
  },
  CAMERA_RECORDER_AUTH_DENIED: {
    label: "Đầu ghi từ chối mật khẩu giám sát",
    hint: "Mật khẩu giám sát trên đầu ghi đã bị đổi.",
    severity: "CRITICAL",
  },
  CAMERA_MONITOR_STALE: {
    label: "Hệ thống giám sát ngừng gửi dữ liệu",
    hint: "Lỗi ở máy chủ giám sát (VPS), không ở từng toà. Nhiều toà cùng lúc thì gộp thành một tin.",
    severity: "CRITICAL",
  },
  CAMERA_CHANNEL_LOST: {
    label: "Kênh camera mất hình",
    hint: "Từ một nửa số kênh của một đầu ghi cùng mất trở lên thì coi là nghiêm trọng. Phát sinh ban đêm thì gửi trong tin lúc hết giờ đêm.",
    severity: "WARNING",
  },
  CAMERA_CHANNEL_FLAPPING: {
    label: "Kênh chập chờn",
    hint: "Đếm số lần kênh rớt trong 24 giờ. Chỉ đưa vào bản tin sáng.",
    severity: "INFO",
  },
  CAMERA_RECORDER_UNKNOWN: {
    label: "Đầu ghi trả lời lạ",
    hint: "Ổ cứng hoặc kênh không đọc được.",
    severity: "WARNING",
  },
};

export const CAMERA_ALERT_SEVERITY_LABELS: Record<CameraAlertSeverity, string> = {
  CRITICAL: "Nghiêm trọng", WARNING: "Cảnh báo", INFO: "Thông tin",
};

export const CAMERA_ALERT_DELIVERY_LABELS: Record<CameraAlertDeliveryMode, string> = {
  ZALO: "Zalo",
  DIGEST: "Chỉ bản tin sáng",
  BELL: "Chỉ chuông",
  OFF: "Tắt",
};

/** Chập chờn không có sự cố để gửi ngay ⇒ máy chủ chỉ nhận bản tin hoặc tắt. */
export function deliveryOptionsFor(code: CameraAlertTypeCode): CameraAlertDeliveryMode[] {
  return code === FLAPPING_CODE ? ["DIGEST", "OFF"] : ["ZALO", "DIGEST", "BELL", "OFF"];
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------
const clockSchema = z.string({ error: "Chọn giờ." }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Giờ không hợp lệ (dạng 07:00).");
const numberField = (message: string) => z.number({ error: message });
const typeRowSchema = z.object({
  enabled: z.boolean(),
  delivery: z.enum(["ZALO", "DIGEST", "BELL", "OFF"]),
  /** Phút với mọi loại; riêng chập chờn là số lần rớt trong 24 giờ. */
  threshold: numberField("Nhập một con số."),
});
const typesShape = Object.fromEntries(CAMERA_ALERT_TYPE_CODES.map((code) => [code, typeRowSchema])) as Record<CameraAlertTypeCode, typeof typeRowSchema>;

export const MAX_THRESHOLD_MINUTES = 1440;

export const cameraAlertFormSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["SHADOW", "LIVE"]),
  zaloAccountId: z.string().nullable(),
  zaloConversationId: z.string().nullable(),
  types: z.object(typesShape),
  nightStart: clockSchema,
  nightEnd: clockSchema,
  digestAt: clockSchema,
  dailyZaloCap: numberField("Nhập số tin tối đa mỗi ngày.").int("Số tin phải là số nguyên.")
    .min(1, "Tối thiểu 1 tin mỗi ngày.").max(20, "Tối đa 20 tin mỗi ngày."),
}).superRefine((values, ctx) => {
  for (const code of CAMERA_ALERT_TYPE_CODES) {
    const row = values.types[code];
    const path = ["types", code, "threshold"];
    if (code === FLAPPING_CODE) {
      if (!Number.isInteger(row.threshold) || row.threshold < 2 || row.threshold > 200) {
        ctx.addIssue({ code: "custom", path, message: "Từ 2 đến 200 lần." });
      }
      if (!["DIGEST", "OFF"].includes(row.delivery)) {
        ctx.addIssue({ code: "custom", path: ["types", code, "delivery"], message: "Kênh chập chờn chỉ báo trong bản tin sáng." });
      }
      continue;
    }
    // Máy chủ: ổ lỗi 0 hoặc 60–86 400 giây; loại khác 60–86 400 giây.
    const min = code === STORAGE_CODE ? 0 : 1;
    if (!Number.isFinite(row.threshold) || row.threshold < min || row.threshold > MAX_THRESHOLD_MINUTES
      || (code === STORAGE_CODE && row.threshold > 0 && row.threshold < 1)) {
      ctx.addIssue({
        code: "custom", path,
        message: code === STORAGE_CODE ? "0 (báo ngay) hoặc từ 1 đến 1440 phút." : "Từ 1 đến 1440 phút (24 giờ).",
      });
    } else if (Math.abs(row.threshold * 60 - Math.round(row.threshold * 60)) > 1e-6) {
      ctx.addIssue({ code: "custom", path, message: "Ngưỡng phải tròn tới giây (ví dụ 1,5 phút)." });
    }
  }
  if (values.nightStart === values.nightEnd) {
    ctx.addIssue({ code: "custom", path: ["nightEnd"], message: "Giờ kết thúc đêm phải khác giờ bắt đầu." });
  }
  if (values.enabled && values.mode === "LIVE" && !values.zaloConversationId) {
    ctx.addIssue({ code: "custom", path: ["zaloConversationId"], message: "Chọn nhóm Zalo trước khi chuyển sang gửi thật." });
  }
});

export type CameraAlertFormValues = z.infer<typeof cameraAlertFormSchema>;

function thresholdOf(code: CameraAlertTypeCode, row: CameraAlertTypes[CameraAlertTypeCode], fallback: CameraAlertTypes[CameraAlertTypeCode]): number {
  if (code === FLAPPING_CODE) return row.threshold_count ?? fallback.threshold_count ?? 5;
  return (row.threshold_seconds ?? fallback.threshold_seconds ?? 600) / 60;
}

export function cameraAlertFormValues(settings: CameraAlertSettings, defaults: CameraAlertTypes): CameraAlertFormValues {
  const types = Object.fromEntries(CAMERA_ALERT_TYPE_CODES.map((code) => {
    const row = settings.types[code];
    return [code, { enabled: row.enabled, delivery: row.delivery, threshold: thresholdOf(code, row, defaults[code]) }];
  })) as CameraAlertFormValues["types"];
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    zaloAccountId: settings.zaloAccountId,
    zaloConversationId: settings.zaloConversationId,
    types,
    nightStart: settings.nightStart,
    nightEnd: settings.nightEnd,
    digestAt: settings.digestAt,
    dailyZaloCap: settings.dailyZaloCap,
  };
}

/** Chỉ các khoá thật sự đổi; loại sự cố gửi riêng từng trường đổi (máy chủ gộp vào bản đang lưu). */
export function buildCameraAlertPatch(settings: CameraAlertSettings, values: CameraAlertFormValues, defaults: CameraAlertTypes): CameraAlertSettingsPatch {
  const patch: CameraAlertSettingsPatch = {};
  if (values.enabled !== settings.enabled) patch.enabled = values.enabled;
  if (values.mode !== settings.mode) patch.mode = values.mode;
  if (values.zaloAccountId !== settings.zaloAccountId) patch.zaloAccountId = values.zaloAccountId;
  if (values.zaloConversationId !== settings.zaloConversationId) patch.zaloConversationId = values.zaloConversationId;
  if (values.nightStart !== settings.nightStart) patch.nightStart = values.nightStart;
  if (values.nightEnd !== settings.nightEnd) patch.nightEnd = values.nightEnd;
  if (values.digestAt !== settings.digestAt) patch.digestAt = values.digestAt;
  if (values.dailyZaloCap !== settings.dailyZaloCap) patch.dailyZaloCap = values.dailyZaloCap;
  const types: NonNullable<CameraAlertSettingsPatch["types"]> = {};
  for (const code of CAMERA_ALERT_TYPE_CODES) {
    const saved = settings.types[code];
    const next = values.types[code];
    const change: NonNullable<CameraAlertSettingsPatch["types"]>[CameraAlertTypeCode] = {};
    if (next.enabled !== saved.enabled) change.enabled = next.enabled;
    if (next.delivery !== saved.delivery) change.delivery = next.delivery;
    if (next.threshold !== thresholdOf(code, saved, defaults[code])) {
      if (code === FLAPPING_CODE) change.threshold_count = next.threshold;
      else change.threshold_seconds = Math.round(next.threshold * 60);
    }
    if (Object.keys(change).length > 0) types[code] = change;
  }
  if (Object.keys(types).length > 0) patch.types = types;
  return patch;
}

/** Lưu lần này sẽ bật gửi thật ⇒ máy chủ gửi một tin hiện trạng vào nhóm (spec §3.2). */
export function startsLiveSending(settings: Pick<CameraAlertSettings, "enabled" | "mode">, values: Pick<CameraAlertFormValues, "enabled" | "mode">): boolean {
  return values.enabled && values.mode === "LIVE" && !(settings.enabled && settings.mode === "LIVE");
}

// ---------------------------------------------------------------------------
// Nhật ký gửi
// ---------------------------------------------------------------------------
export type CameraAlertTone = "good" | "warn" | "bad" | "info" | "neutral";

export const CAMERA_ALERT_STATUS_FILTERS: Array<{ value: CameraAlertDeliveryStatus; label: string }> = [
  { value: "SHADOW", label: "Chạy thử" },
  { value: "QUEUED", label: "Đã xếp hàng" },
  { value: "SENT", label: "Đã gửi" },
  { value: "FAILED", label: "Lỗi gửi" },
  { value: "SUPPRESSED", label: "Bỏ qua (trùng 24 giờ, chạm trần)" },
  { value: "DEFERRED", label: "Dồn bản tin" },
];

export const CAMERA_ALERT_KIND_LABELS: Record<CameraAlertDelivery["kind"], string> = {
  OPENED: "Sự cố mới",
  RESOLVED: "Đã khôi phục",
  BASELINE: "Hiện trạng lúc bật",
  NIGHT_DIGEST: "Tin dồn sau giờ đêm",
  DIGEST: "Bản tin sáng",
  TEST: "Tin thử",
};

export const CAMERA_ALERT_CHANNEL_LABELS: Record<CameraAlertDelivery["channel"], string> = {
  ZALO: "Zalo", IN_APP: "Chuông CRM",
};

/** Câu máy chủ viết sẵn cho người dùng (không phải mã) thì giữ; còn lại không hiện. */
export function isPlainSentence(value: string | null | undefined): value is string {
  if (!value) return false;
  const text = value.trim();
  if (!text || text.length > 200) return false;
  if (/^[A-Z0-9_]+$/.test(text)) return false;
  if (/[A-Z]{2,}_|[a-z][A-Z]|:\s*[\w.]+$/.test(text)) return false;
  return true;
}

const SHADOW_REASONS: Record<string, string> = {
  WOULD_QUEUE: "Lẽ ra gửi vào nhóm Zalo.",
  WOULD_NOTIFY: "Lẽ ra báo chuông CRM.",
  NIGHT: "Lẽ ra dồn vào tin sau giờ đêm.",
  DAILY_CAP: "Lẽ ra dồn vì đã chạm trần tin trong ngày.",
  REPEAT_24H: "Lẽ ra bỏ qua vì đã báo trong 24 giờ qua.",
  DEMO: "Dữ liệu mô phỏng, không gửi.",
};

export function deliveryStatusView(row: Pick<CameraAlertDelivery, "status" | "reason" | "recipients" | "channel">): { label: string; tone: CameraAlertTone; detail: string | null } {
  const reason = row.reason ?? "";
  switch (row.status) {
    case "SHADOW": {
      let detail = SHADOW_REASONS[reason] ?? null;
      if (reason === "WOULD_NOTIFY" && row.recipients !== null) detail = `Lẽ ra báo chuông CRM cho ${row.recipients} người.`;
      return { label: "Chạy thử", tone: "info", detail };
    }
    case "QUEUED": return { label: "Đã xếp hàng", tone: "neutral", detail: "Đang chờ máy gửi Zalo gửi đi." };
    case "SENT":
      return {
        label: "Đã gửi", tone: "good",
        detail: row.channel === "IN_APP" && row.recipients !== null ? `Đã báo chuông cho ${row.recipients} người.` : null,
      };
    case "FAILED": return { label: "Lỗi gửi", tone: "bad", detail: isPlainSentence(reason) ? reason : "Máy gửi Zalo báo lỗi." };
    case "SUPPRESSED":
      if (reason === "DAILY_CAP") return { label: "Bỏ qua vì chạm trần ngày", tone: "neutral", detail: null };
      return { label: "Bỏ qua vì trùng 24 giờ", tone: "neutral", detail: "Sự cố này đã được báo trong 24 giờ qua; bản tin sáng ghi số lần tái diễn." };
    case "DEFERRED":
      if (reason === "DAILY_CAP") return { label: "Dồn bản tin", tone: "warn", detail: "Đã chạm trần tin trong ngày; nội dung vào bản tin kế tiếp." };
      return { label: "Dồn bản tin", tone: "warn", detail: reason === "NIGHT" ? "Phát sinh ban đêm; gửi trong tin sau giờ đêm." : null };
  }
}

// ---------------------------------------------------------------------------
// Tin thử, tắt báo kênh
// ---------------------------------------------------------------------------
export function testResultText(result: CameraAlertTestResult): { tone: CameraAlertTone; text: string } {
  if (result.reused) return { tone: "info", text: "Vừa có tin thử trong một phút trước — không gửi thêm. Xem kết quả ở Nhật ký gửi." };
  switch (result.status) {
    case "QUEUED":
    case "SENT": return { tone: "good", text: "Đã xếp hàng tin thử. Kiểm tra nhóm Zalo trong vài phút." };
    case "FAILED": return { tone: "bad", text: `Không gửi được tin thử${isPlainSentence(result.reason) ? `: ${result.reason}` : "."}` };
    case "SUPPRESSED":
    case "DEFERRED": return { tone: "warn", text: "Đã chạm trần tin Zalo hôm nay — tin thử không được gửi." };
    case "SHADOW": return { tone: "info", text: "Dữ liệu mô phỏng: không gửi tin thật." };
  }
}

export const CAMERA_CHANNEL_MUTE_LABELS: Record<CameraChannelMuteKind, string> = {
  IGNORE: "Không theo dõi",
  SNOOZE: "Tạm ẩn",
  KNOWN_BROKEN: "Đã biết hỏng",
};

export function cameraChannelMuteText(mute: Pick<CameraChannelMute, "kind" | "untilAt">): string {
  if (mute.kind === "SNOOZE" && mute.untilAt) return `Tạm ẩn đến hết ${formatVnDate(mute.untilAt)}`;
  if (mute.kind === "KNOWN_BROKEN") return "Đã biết hỏng · nhắc thứ Hai";
  return CAMERA_CHANNEL_MUTE_LABELS[mute.kind];
}

const VN_TIME_ZONE = "Asia/Ho_Chi_Minh";
// Ghép từ formatToParts: chuỗi "vi-VN" của ICU khác nhau giữa trình duyệt và Node ("25/11" / "25-11").
const vnParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: VN_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function partsOf(value: string | number | Date) {
  const parts = Object.fromEntries(vnParts.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return { year: parts.year ?? "", month: parts.month ?? "", day: parts.day ?? "", hour: parts.hour ?? "", minute: parts.minute ?? "" };
}

/** Ngày theo giờ Việt Nam (máy chủ cũng tính ngày theo múi giờ của công ty). */
export function formatVnDate(value: string | number) {
  const p = partsOf(value);
  return `${p.day}/${p.month}/${p.year}`;
}
export function formatVnDateTime(value: string | number) {
  const p = partsOf(value);
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}
export function vnIsoDay(value: number | Date) {
  const p = partsOf(value);
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDaysIso(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, date + days));
  return next.toISOString().slice(0, 10);
}

/** "Tạm ẩn đến ngày X" = hết ngày X giờ Việt Nam; máy chủ nhận tối đa 90 ngày tới. */
export const SNOOZE_MAX_DAYS = 89;
export function snoozeUntilIso(day: string): string {
  return new Date(`${day}T23:59:59+07:00`).toISOString();
}

export function cameraChannelMuteSchema(today: string) {
  const last = addDaysIso(today, SNOOZE_MAX_DAYS);
  return z.object({
    kind: z.enum(["IGNORE", "SNOOZE", "KNOWN_BROKEN"]),
    untilDay: z.string(),
    note: z.string().max(500, "Ghi chú tối đa 500 ký tự."),
  }).superRefine((values, ctx) => {
    if (values.kind !== "SNOOZE") return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.untilDay)) {
      ctx.addIssue({ code: "custom", path: ["untilDay"], message: "Chọn ngày theo dõi lại." });
    } else if (values.untilDay < today || values.untilDay > last) {
      ctx.addIssue({ code: "custom", path: ["untilDay"], message: `Chọn một ngày từ hôm nay đến ${formatVnDate(`${last}T12:00:00+07:00`)}.` });
    }
  });
}
export type CameraChannelMuteFormValues = z.infer<ReturnType<typeof cameraChannelMuteSchema>>;

// ---------------------------------------------------------------------------
// Lỗi: tách quyền / dữ liệu nhập / xung đột; không hiện mã cho người dùng.
// ---------------------------------------------------------------------------
export type CameraAlertFailureKind = "conflict" | "permission" | "session" | "validation" | "unavailable" | "closed" | "data" | "other";

/**
 * `permissionText`: câu cho 42501 của đúng thao tác (mặc định là câu của thao tác SỬA cài đặt;
 * thao tác đọc hoặc "Đã biết" truyền câu riêng).
 */
export function cameraAlertFailure(error: unknown, action: string, permissionText = "Chỉ chủ công ty hoặc superadmin sửa được."): { kind: CameraAlertFailureKind; text: string } {
  const code = error instanceof NetworkCenterRepositoryError ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  switch (code) {
    case "PT409":
      return { kind: "conflict", text: "Có người vừa sửa cài đặt này. Bấm “Tải lại” để xem bản mới nhất rồi sửa lại." };
    case "42501":
      return { kind: "permission", text: permissionText };
    case "PGRST301":
    case "PGRST302":
      return { kind: "session", text: "Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục." };
    case "22023":
      return { kind: "validation", text: isPlainSentence(message) && !/^Giá trị/.test(message) ? message : "Giá trị chưa hợp lệ. Kiểm tra lại các ô đã nhập." };
    case "P0002":
      return { kind: "closed", text: "Sự cố này đã đóng." };
    case "PGRST202":
    case "42883":
      return { kind: "unavailable", text: "Bộ cảnh báo camera chưa được triển khai trên hệ thống này." };
    case "CAMERA_ALERT_INVALID_DATA":
    case "CAMERA_SCOPE_MISMATCH":
      // Câu của lớp dữ liệu (tiếng Việt, không có mã): dữ liệu trả về sai hợp đồng, không phải lỗi mạng.
      return { kind: "data", text: `${isPlainSentence(message) ? message : "Dữ liệu cảnh báo camera chưa hợp lệ."} Tải lại trang; nếu còn lỗi, báo kỹ thuật.` };
    default:
      return { kind: "other", text: `Chưa ${action} được. Kiểm tra mạng rồi thử lại.` };
  }
}
