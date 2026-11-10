// =============================================================================
// Chia sẻ camera có thời hạn: nhân viên cấp cho khách ID + mật khẩu để xem lại MỘT kênh trong MỘT khung giờ.
// Khách mở /xem-camera/<ID>, không cần tài khoản CRM; server cấp phiên `cs_…` dùng làm Bearer cho cổng video.
// File này giữ hợp đồng gói (zod), lớp gọi RPC và các hàm thuần (chuẩn hoá mã, tin nhắn gửi khách, nhãn trạng thái).
// Server là hàng rào thật: chống dò mật khẩu, hết hạn/thu hồi, giới hạn kênh và khung giờ.
// =============================================================================
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { cameraInputTime, cameraTimeLabel, vietnamCameraInput } from "./cameraArchive";
import type { CameraRecorder } from "./cameraContracts";

export const CAMERA_SHARE_CODE = /^[A-HJ-NP-Z2-9]{8}$/u;
export const CAMERA_SHARE_PASSWORD = /^[a-z0-9]{8}$/u;
export const CAMERA_SHARE_SESSION = /^cs_[A-Za-z0-9_-]{43}$/u;
export const CAMERA_SHARE_MAX_WINDOW_MS = 24 * 3600_000;
/** Server chỉ nhận khung giờ bắt đầu trong 60 ngày gần nhất. */
export const CAMERA_SHARE_MAX_AGE_MS = 60 * 24 * 3600_000;
/** Giờ kết thúc được phép vượt "bây giờ" tối đa chừng này (đồng hồ máy lệch, thời gian điền form). */
export const CAMERA_SHARE_END_SKEW_MS = 60_000;
export const CAMERA_SHARE_NOTE_MAX = 120;
export const CAMERA_SHARE_PATH = "/xem-camera";

// ─────────────────────────────── gói server ───────────────────────────────

const uuid = z.string().guid();
/**
 * Postgres trả timestamptz trong jsonb kèm micro giây ("…:38.123456+00:00"). Cắt về mili giây rồi đổi sang ISO "Z"
 * để mọi trình duyệt (kể cả Safari cũ trên iPhone của khách) đọc cùng một giá trị.
 */
export function parseServerTime(value: string) {
  return Date.parse(value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /u, "$1T").replace(/(\.\d{3})\d+/u, "$1"));
}
const isoTime = z.string().transform((value, ctx) => {
  const ms = parseServerTime(value);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  ctx.addIssue({ code: "custom", message: "Thời điểm không hợp lệ" });
  return z.NEVER;
});
const channel = z.number().int().min(1).max(64);

export const cameraShareStatusSchema = z.enum(["ACTIVE", "EXPIRED", "REVOKED"]);
export type CameraShareStatus = z.infer<typeof cameraShareStatusSchema>;

/** Trả về đúng một lần khi tạo — mật khẩu không bao giờ đọc lại được. */
export const cameraShareCreatedSchema = z.object({
  id: uuid, code: z.string().regex(CAMERA_SHARE_CODE), password: z.string().regex(CAMERA_SHARE_PASSWORD),
  recorder_id: uuid, channel, channel_name: z.string().nullable(),
  window_start: isoTime, window_end: isoTime, expires_at: isoTime, note: z.string().nullable(),
});
export type CameraShareCreated = z.infer<typeof cameraShareCreatedSchema>;

export const cameraShareRowSchema = z.object({
  id: uuid, recorder_id: uuid, channel, channel_name: z.string().nullable(),
  window_start: isoTime, window_end: isoTime, code: z.string().regex(CAMERA_SHARE_CODE), note: z.string().nullable(),
  created_by_name: z.string().nullable(), created_at: isoTime, expires_at: isoTime, revoked_at: isoTime.nullable(),
  status: cameraShareStatusSchema, last_login_at: isoTime.nullable(), login_count: z.number().int().nonnegative(),
});
export type CameraShareRow = z.infer<typeof cameraShareRowSchema>;
export const cameraSharesSchema = z.object({ shares: z.array(cameraShareRowSchema) });
export const cameraShareRevokeSchema = z.object({ status: z.enum(["REVOKED", "ALREADY_ENDED"]) });
export type CameraShareRevokeResult = z.infer<typeof cameraShareRevokeSchema>;

/** Phạm vi một phiên khách được xem: một đầu ghi, một kênh, một khung giờ, tới lúc hết hạn. */
export const cameraShareSchema = z.object({
  share_id: uuid, recorder_id: uuid, organization_id: uuid, building_id: uuid, channel,
  channel_name: z.string().nullable(), building_name: z.string().nullable(),
  window_start: isoTime, window_end: isoTime, expires_at: isoTime,
});
export type CameraShare = z.infer<typeof cameraShareSchema>;

export const cameraShareLoginSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("OK"), session: z.string().regex(CAMERA_SHARE_SESSION), share: cameraShareSchema }),
  z.object({ status: z.literal("INVALID"), attempts_left: z.number().int().nonnegative() }),
  z.object({ status: z.literal("LOCKED"), retry_after_seconds: z.number().nonnegative() }),
  z.object({ status: z.literal("ENDED") }),
]);
export type CameraShareLoginResult = z.infer<typeof cameraShareLoginSchema>;
export const cameraShareLogoutSchema = z.object({ status: z.literal("OK") });

// ─────────────────────────────── lỗi ───────────────────────────────

export type CameraShareErrorKind = "permission" | "validation" | "rule" | "session" | "unavailable" | "network" | "data" | "unknown";
export class CameraShareError extends Error {
  readonly kind: CameraShareErrorKind;
  readonly code?: string;
  constructor(message: string, kind: CameraShareErrorKind, code?: string) {
    super(message);
    this.name = "CameraShareError";
    this.kind = kind;
    this.code = code;
  }
}

type Audience = "staff" | "tenant";
interface RpcError { code?: string; message: string; details?: string | null; hint?: string | null }
type RpcCall = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError | null } | null | undefined>;

/**
 * Ranh giới kiểu cho RPC chưa có trong `types.ts` sinh tự động (migration chia sẻ camera chưa lên production lúc viết).
 * Sau gen:types đổi sang `supabase.rpc('<tên>', …)` có kiểu. Tên RPC vẫn viết thẳng tại nơi gọi.
 */
const rpc: RpcCall = (name, args) => (supabase.rpc as unknown as RpcCall)(name, args);

export function cameraShareRpcError(error: RpcError, audience: Audience): CameraShareError {
  const code = error.code ?? "";
  if (code === "42501") {
    return new CameraShareError(audience === "staff"
      ? "Bạn không có quyền chia sẻ camera của tòa nhà này."
      : "Trang xem camera đang tạm ngưng. Vui lòng liên hệ bên quản lý.", "permission", code);
  }
  if (code === "22023") {
    return new CameraShareError(audience === "staff"
      ? "Thông tin chia sẻ chưa hợp lệ. Kiểm tra kênh, khung giờ (tối đa 24 giờ, nằm hẳn trong quá khứ và trong 60 ngày gần nhất), hiệu lực và ghi chú."
      : "ID hoặc mật khẩu chưa đúng định dạng.", "validation", code);
  }
  // Luật nghiệp vụ: server trả câu tiếng Việt, hiện nguyên văn.
  if (code === "P0001" && error.message.trim()) return new CameraShareError(error.message.trim(), "rule", code);
  if (["PGRST301", "PGRST302", "PGRST303"].includes(code)) {
    return new CameraShareError(audience === "staff"
      ? "Phiên đăng nhập đã hết hạn. Đăng nhập lại để chia sẻ camera."
      : "Không xác minh được phiên xem. Tải lại trang rồi thử lại.", "session", code);
  }
  if (code === "PGRST202" || code === "42883") return new CameraShareError("Dịch vụ chia sẻ camera chưa được triển khai.", "unavailable", code);
  // supabase-js trả lỗi mạng (fetch hỏng) dưới dạng error không có mã PostgREST.
  if (!code) return new CameraShareError("Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.", "network");
  return new CameraShareError(audience === "staff" ? "Không thể xử lý yêu cầu chia sẻ camera. Vui lòng thử lại." : "Máy chủ chưa xử lý được yêu cầu. Vui lòng thử lại.", "unknown", code);
}

async function call<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, audience: Audience): Promise<T> {
  let result: Awaited<ReturnType<RpcCall>>;
  try {
    result = await rpc(name, args);
  } catch (cause) {
    throw new CameraShareError("Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.", "network", cause instanceof Error ? cause.name : undefined);
  }
  if (!result) throw new CameraShareError("Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.", "network");
  if (result.error) throw cameraShareRpcError(result.error, audience);
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new CameraShareError("Dữ liệu chia sẻ camera chưa hợp lệ. Vui lòng tải lại trang.", "data", "CAMERA_SHARE_INVALID_DATA");
  return parsed.data;
}

/** Thử lại đúng một lần cho lỗi mạng; lỗi do server trả lời (quyền, dữ liệu) thử lại không đổi kết quả. */
export function shouldRetryCameraShare(failureCount: number, error: unknown) {
  if (error instanceof CameraShareError && error.kind !== "network") return false;
  return failureCount < 1;
}

// ─────────────────────────────── RPC nhân viên ───────────────────────────────

export interface CameraShareCreateInput {
  recorderId: string; channel: number; windowStart: string; windowEnd: string; expiresHours: number; note: string | null;
}
export function createCameraShare(input: CameraShareCreateInput) {
  return call("camera_share_create_v1", {
    p_recorder_id: uuid.parse(input.recorderId), p_channel: channel.parse(input.channel),
    p_window_start: input.windowStart, p_window_end: input.windowEnd,
    p_expires_hours: z.number().int().min(1).max(168).parse(input.expiresHours),
    p_note: input.note?.trim() ? input.note.trim().slice(0, CAMERA_SHARE_NOTE_MAX) : null,
  }, cameraShareCreatedSchema, "staff");
}
export async function listCameraShares(buildingId: string) {
  return (await call("camera_shares_v1", { p_building_id: uuid.parse(buildingId) }, cameraSharesSchema, "staff")).shares;
}
export function revokeCameraShare(shareId: string) {
  return call("camera_share_revoke_v1", { p_share_id: uuid.parse(shareId) }, cameraShareRevokeSchema, "staff");
}

// ─────────────────────────────── RPC khách (anon) ───────────────────────────────

export function loginCameraShare(code: string, password: string) {
  return call("camera_share_login_v1", { p_code: normalizeShareCode(code), p_password: normalizeSharePassword(password) }, cameraShareLoginSchema, "tenant");
}
/** NULL = phiên hoặc lượt chia sẻ không còn hiệu lực. */
export function authorizeCameraShare(token: string) {
  return call("camera_share_authorize_v1", { p_token: token }, cameraShareSchema.nullable(), "tenant");
}
export function logoutCameraShare(token: string) {
  return call("camera_share_logout_v1", { p_token: token }, cameraShareLogoutSchema, "tenant");
}

// ─────────────────────────────── hàm thuần ───────────────────────────────

/** Gạch nối ASCII và các loại gạch Unicode mà bàn phím điện thoại hay tự đổi. */
const SHARE_CODE_DASHES = /[-‐-―]+/gu;
/** Giống server: viết hoa, bỏ khoảng trắng và gạch nối (khách hay chép "ABCD-EFGH" hoặc "abcd efgh"). */
export const normalizeShareCode = (value: string) => value.toUpperCase().replace(/\s+/gu, "").replace(SHARE_CODE_DASHES, "");
/** Giống server: bỏ khoảng trắng hai đầu, viết thường. */
export const normalizeSharePassword = (value: string) => value.trim().toLowerCase();

/** "45 giây" / "khoảng 3 phút" — thời gian chờ sau khi nhập sai nhiều lần. */
export const cameraShareWaitLabel = (seconds: number) =>
  seconds < 60 ? `${Math.max(1, Math.ceil(seconds))} giây` : `khoảng ${Math.ceil(seconds / 60)} phút`;

export const cameraShareStatusLabel: Record<CameraShareStatus, string> = {
  ACTIVE: "Đang hiệu lực", EXPIRED: "Hết hạn", REVOKED: "Đã thu hồi",
};

export const CAMERA_SHARE_EXPIRY = ["1h", "6h", "24h", "3d", "7d"] as const;
export type CameraShareExpiry = typeof CAMERA_SHARE_EXPIRY[number];
export const cameraShareExpiryHours: Record<CameraShareExpiry, number> = { "1h": 1, "6h": 6, "24h": 24, "3d": 72, "7d": 168 };
export const cameraShareExpiryLabel: Record<CameraShareExpiry, string> = { "1h": "1 giờ", "6h": "6 giờ", "24h": "24 giờ", "3d": "3 ngày", "7d": "7 ngày" };

export const recorderChannelName = (recorder: Pick<CameraRecorder, "snapshot">, channelNumber: number) =>
  recorder.snapshot?.channels.find((row) => row.channel === channelNumber)?.name || null;
export const cameraShareChannelLabel = (channelNumber: number, name: string | null | undefined) =>
  name?.trim() ? `${name.trim()} · kênh ${channelNumber}` : `Kênh ${channelNumber}`;
export const cameraShareWindowLabel = (start: string | number, end: string | number) => `${cameraTimeLabel(start)} → ${cameraTimeLabel(end)}`;
export const cameraShareLink = (origin: string, code: string) => `${origin.replace(/\/+$/u, "")}${CAMERA_SHARE_PATH}/${encodeURIComponent(code)}`;

/** Lề cho đồng hồ máy khách lệch máy chủ: cổng video từ chối `end` ở tương lai. */
export const CAMERA_SHARE_CLOCK_MARGIN_MS = 5000;
export interface CameraShareSpan { from: number; to: number }
/** Khoảng khách xem được lúc này: [đầu khung giờ, min(cuối khung giờ, bây giờ − lề)], tròn giây. */
export function cameraSharePlayableSpan(share: Pick<CameraShare, "window_start" | "window_end">, now: number): CameraShareSpan {
  const from = Math.ceil(Date.parse(share.window_start) / 1000) * 1000;
  const end = Math.floor(Date.parse(share.window_end) / 1000) * 1000;
  return { from, to: Math.min(end, Math.floor((now - CAMERA_SHARE_CLOCK_MARGIN_MS) / 1000) * 1000) };
}

/** Hình ngừng lâu chừng này (đồng hồ thật) mới xét là luồng đã kết thúc. */
export const CAMERA_SHARE_END_STALL_MS = 2500;
/**
 * Đầu ghi dừng phát đúng giờ kết thúc của khung giờ, nhưng vị trí trên thanh thời gian chỉ là ƯỚC TÍNH: ở tốc độ cao
 * nó có thể dừng sớm vài giây so với cuối khung giờ (đo trên production 10/11/2026: 8× dừng ở −4 giây), nên phép so
 * "đã tới cuối" không bao giờ đúng và trình xem treo chờ lỗi của cổng. Hình đã ngừng mà mốc đang sát cuối ⇒ coi là xem hết.
 * Sai số cho phép tăng theo tốc độ: 1× là 3 giây nội dung, 8× là 13,5 giây.
 */
export function cameraShareReachedEnd(input: { cursor: number; to: number; speed: number; lastFrameAt: number; now: number }): boolean {
  if (!(input.lastFrameAt > 0) || input.now - input.lastFrameAt < CAMERA_SHARE_END_STALL_MS) return false;
  return input.cursor >= input.to - (Math.max(1, input.speed) * 1500 + 1500);
}

export interface CameraShareMessageInput {
  link: string; code: string; password: string; cameraLabel: string; buildingName?: string | null;
  windowStart: string; windowEnd: string; expiresAt: string;
}
/** Tin nhắn gửi khách — chép một lần, không lưu ở đâu. */
export function cameraShareMessage(input: CameraShareMessageInput) {
  return [
    `Bên quản lý gửi anh/chị quyền xem lại camera${input.buildingName?.trim() ? ` tại ${input.buildingName.trim()}` : ""}.`,
    `- Camera: ${input.cameraLabel}`,
    `- Khung giờ xem lại: ${cameraShareWindowLabel(input.windowStart, input.windowEnd)}`,
    `- Mở link: ${input.link}`,
    `- ID: ${input.code}`,
    `- Mật khẩu: ${input.password}`,
    `Link hết hạn lúc ${cameraTimeLabel(input.expiresAt)}. Chỉ xem lại được khung giờ trên, không tải video về máy. Vui lòng không chuyển tiếp tin nhắn này.`,
  ].join("\n");
}

// ─────────────────────────────── form tạo lượt chia sẻ ───────────────────────────────

// Khai đủ khoá ở cả hai nhánh: tsconfig.app (không strict) không thu hẹp union theo `!ok`.
export type CameraShareWindow =
  | { ok: true; start: number; end: number; field?: undefined; message?: undefined }
  | { ok: false; field: "from" | "to"; message: string; start?: undefined; end?: undefined };
/** Ô giờ là giờ Việt Nam (UTC+7) như các màn camera khác; server kiểm lại cùng luật. */
export function cameraShareWindow(from: string, to: string, now: number): CameraShareWindow {
  const start = cameraInputTime(from); const end = cameraInputTime(to);
  if (!Number.isFinite(start) || start < Date.UTC(2000, 0, 1)) return { ok: false, field: "from", message: "Chọn ngày giờ bắt đầu hợp lệ." };
  if (!Number.isFinite(end)) return { ok: false, field: "to", message: "Chọn ngày giờ kết thúc hợp lệ." };
  if (start >= now) return { ok: false, field: "from", message: "Giờ bắt đầu phải ở quá khứ." };
  if (start < now - CAMERA_SHARE_MAX_AGE_MS) return { ok: false, field: "from", message: "Chỉ chia sẻ được bản ghi trong 60 ngày gần nhất." };
  if (end <= start) return { ok: false, field: "to", message: "Giờ kết thúc phải sau giờ bắt đầu." };
  // Chỉ xem lại: khung giờ kéo sang tương lai sẽ cho khách theo dõi gần như trực tiếp. Server từ chối cùng luật;
  // lề một phút để "đến bây giờ" trong form không bị chặn vì vài giây gõ phím (server kéo giờ kết thúc về hiện tại).
  if (end > now + CAMERA_SHARE_END_SKEW_MS) return { ok: false, field: "to", message: "Giờ kết thúc không được ở tương lai: khách chỉ xem lại, không xem trực tiếp." };
  if (end - start > CAMERA_SHARE_MAX_WINDOW_MS) return { ok: false, field: "to", message: "Khung giờ xem lại tối đa 24 giờ." };
  return { ok: true, start, end };
}

export function cameraShareFormSchema(now: () => number) {
  return z.object({
    channel,
    from: z.string(),
    to: z.string(),
    expiry: z.enum(CAMERA_SHARE_EXPIRY),
    note: z.string().max(CAMERA_SHARE_NOTE_MAX, `Ghi chú tối đa ${CAMERA_SHARE_NOTE_MAX} ký tự.`),
  }).superRefine((values, ctx) => {
    const window = cameraShareWindow(values.from, values.to, now());
    if (!window.ok) ctx.addIssue({ code: "custom", path: [window.field], message: window.message });
  });
}
export type CameraShareFormValues = z.infer<ReturnType<typeof cameraShareFormSchema>>;

/** Mặc định: hôm nay 00:00 → bây giờ (giờ Việt Nam), hiệu lực 24 giờ. Vừa qua nửa đêm thì lùi một giờ. */
export function defaultCameraShareValues(now: number, channelNumber: number): CameraShareFormValues {
  const end = Math.floor(now / 1000) * 1000;
  const midnight = Date.parse(`${vietnamCameraInput(end).slice(0, 10)}T00:00:00+07:00`);
  const start = end - midnight >= 60_000 ? midnight : end - 3600_000;
  return { channel: channelNumber, from: vietnamCameraInput(start), to: vietnamCameraInput(end), expiry: "24h", note: "" };
}

export function cameraShareCreateInput(recorderId: string, values: CameraShareFormValues, now: number): CameraShareCreateInput {
  const window = cameraShareWindow(values.from, values.to, now);
  if (!window.ok) throw new CameraShareError(window.message, "validation");
  const note = values.note.trim();
  return {
    recorderId, channel: values.channel,
    windowStart: new Date(window.start).toISOString(), windowEnd: new Date(window.end).toISOString(),
    expiresHours: cameraShareExpiryHours[values.expiry], note: note || null,
  };
}

// ─────────────────────────────── phiên khách trên máy ───────────────────────────────

const sessionKey = (code: string) => `camera-share-session:${code}`;

/** Phiên theo từng mã, chỉ sống trong tab (sessionStorage). Bộ nhớ bị chặn ⇒ null, trang hỏi mật khẩu. */
export function readCameraShareSession(code: string): string | null {
  let value: string | null = null;
  try {
    value = globalThis.sessionStorage.getItem(sessionKey(code));
  } catch {
    /* Trình duyệt chặn bộ nhớ tab — coi như chưa đăng nhập. */
  }
  return value && CAMERA_SHARE_SESSION.test(value) ? value : null;
}

export function writeCameraShareSession(code: string, session: string | null): void {
  try {
    if (session) globalThis.sessionStorage.setItem(sessionKey(code), session);
    else globalThis.sessionStorage.removeItem(sessionKey(code));
  } catch {
    /* Không lưu được thì tải lại trang phải nhập lại mật khẩu — không chặn việc xem. */
  }
}
