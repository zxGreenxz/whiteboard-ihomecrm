// Hàm máy chủ của trang "Cửa vân tay" (/cua-van-tay): nối CRM với máy vân tay ở cửa các toà (SmartLife, nền Tuya
// Cloud). Hợp đồng — hành động, tham số, dạng trả, mã lỗi, RPC, biến môi trường: docs/he-thong/26-cua-van-tay.md.
//
//   POST …/door-access   { action, ...tham số }
//     ⇒ 200     { ok: true, data }
//     ⇒ 4xx/5xx { ok: false, error: { code, message, tuyaCode?, outcomeUnknown?, logPending? } }
//
// Thứ tự kiểm (lỗi sớm không tốn lời gọi nào phía sau):
//   phương thức → thân (JSON object ≤ 16 KB, action đã biết) → cấu hình (thiếu/sai khoá Tuya hoặc DOOR_ACCESS_ORG_ID
//   ⇒ not_configured, trừ status) → phiên (/auth/v1/user) → công ty (x-organization-id; khác DOOR_ACCESS_ORG_ID ⇒
//   org_not_connected, trừ status) → công tắc DOOR_ACCESS_MODE (off ⇒ mode_off; read ⇒ thao tác ghi bị
//   writes_disabled) → tham số → RPC quyền (JWT CỦA NGƯỜI DÙNG, quyền theo toà của máy) → Tuya.
//
// Thao tác ghi (tạo/xoá mật khẩu tạm, mở cửa từ xa, xoá vân tay/thẻ/mật khẩu trên máy):
//   door_access_begin_action_v1 (JWT người dùng: quyền, trần tần suất, ghi PENDING) ⇒ gọi Tuya ĐÚNG MỘT lần ⇒
//   door_access_finish_action_v1 (CHỈ service role — người dùng không tự chốt kết quả) chốt OK | FAILED | UNKNOWN.
//   Lỗi ở bước vé (trước khi lệnh được gửi) ⇒ luôn FAILED. Lỗi của lệnh: mạng/hết giờ/kết quả lạ/Tuya 500–501 ⇒
//   UNKNOWN + outcomeUnknown (lệnh có thể đã chạy) — KHÔNG gửi lại. Chốt nhật ký hỏng thì vẫn trả kết quả Tuya, kèm
//   logPending.
//
// Mật khẩu tạm sinh ở đây, chỉ nằm trong câu trả lời tạo (một lần; mọi câu trả lời đều Cache-Control: no-store);
// không vào p_detail/finish, không ghi log. console.error chỉ ghi mã ngắn — không token, secret, mật khẩu, vé.
//
// File đứng riêng (không import _shared): lượt deploy lên TEST chỉ tải file cấp cao nhất của thư mục hàm.

import {
  TuyaClient,
  type TuyaConfig,
  TuyaConfigError,
  TuyaError,
  TuyaInputError,
  type TuyaRequester,
  tuyaBaseUrl,
} from "./tuyaClient.ts";
import { generateNumericPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, TuyaCryptoError } from "./tuyaCrypto.ts";
import {
  createTempPassword,
  deleteTempPassword,
  deleteUnlockMethod,
  type DoorKind,
  type DoorUser,
  listDeviceUsers,
  listProjectDevices,
  listRecords,
  listTempPasswords,
  listUnassignedKeys,
  listUserUnlockMethods,
  remoteUnlock,
  TEMP_PASSWORD_NAME_MAX,
  TuyaTicketStageError,
  type UserUnlockMethod,
} from "./tuyaDoor.ts";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-organization-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Thân yêu cầu tối đa — tham số của mọi hành động chỉ vài trăm byte. */
export const TRAN_THAN_BYTES = 16 * 1024;
/** Trần một lời gọi Supabase (Auth/RPC). */
export const HAN_SUPABASE_MS = 10_000;
const NGAY_MS = 86_400_000;
/** Lịch sử ra vào: một lần đọc tối đa 31 ngày, tối đa 50 dòng một trang (mặc định 20). */
export const TRAN_KHOANG_NHAT_KY_MS = 31 * NGAY_MS;
export const TRAN_TRANG_NHAT_KY = 50;
export const TRANG_NHAT_KY_MAC_DINH = 20;
/**
 * Mật khẩu tạm: dài tối đa 7 ngày VÀ hết hạn trong 7 ngày kể từ lúc tạo; giờ bắt đầu được lùi, giờ hết hạn được vượt
 * tối đa 5 phút so với đồng hồ máy chủ (lệch giờ máy khách).
 */
export const TRAN_HAN_MAT_KHAU_GIAY = 7 * 86_400;
export const LUI_BAT_DAU_GIAY = 300;
/** Đối chiếu vân tay: người dùng trên máy đọc trang 50, tối đa 5 trang; cách mở khoá đọc tối đa 4 người cùng lúc. */
export const TRANG_NGUOI_DUNG = 50;
export const SO_TRANG_NGUOI_DUNG = 5;
export const SONG_SONG_CACH_MO = 4;
/** Tìm máy: tối đa 10 trang thiết bị của project Tuya. */
export const SO_TRANG_THIET_BI = 10;
export const MUC_DICH_MAT_KHAU = ["XEM_PHONG", "THO", "KHACH", "KHAC"] as const;
export type MucDichMatKhau = (typeof MUC_DICH_MAT_KHAU)[number];
export const LOAI_KHOA_XOA = ["fingerprint", "card", "password"] as const;
export type LoaiKhoaXoa = (typeof LOAI_KHOA_XOA)[number];
/** Mật khẩu tạm mặc định 7 chữ số (cột door_devices.password_length). */
const DO_DAI_MAT_KHAU_MAC_DINH = 7;
const MAX_INT32 = 2_147_483_647;
/** Mốc giây lớn nhất thư viện nhận (năm 2286). */
const MAX_EPOCH_SEC = 9_999_999_999;
/** Mốc ms hợp lệ của nhật ký (khớp tuyaDoor.listRecords): dưới 1e11 gần như chắc là giây truyền nhầm. */
const MIN_EPOCH_MS = 1e11;
const MAX_EPOCH_MS = 1e14;

/** Mã lỗi ⇒ HTTP: đúng bảng mã lỗi của hợp đồng, thêm method_not_allowed cho phương thức khác POST. */
export const HTTP_THEO_MA = {
  unauthorized: 401,
  organization_required: 400,
  invalid_request: 400,
  not_configured: 503,
  org_not_connected: 403,
  mode_off: 403,
  writes_disabled: 403,
  not_permitted: 403,
  device_not_found: 404,
  conflict: 409,
  rate_limited: 429,
  tuya_rejected: 502,
  tuya_unavailable: 504,
  internal: 500,
  method_not_allowed: 405,
} as const;
export type MaLoi = keyof typeof HTTP_THEO_MA;

export interface LoiTra {
  code: MaLoi;
  message: string;
  /** Mã lỗi Tuya khi Tuya từ chối (success:false). */
  tuyaCode?: number | string;
  /** Thao tác ghi: lệnh có thể đã chạy trên máy (lỗi mạng/hết giờ/kết quả lạ). */
  outcomeUnknown?: true;
  /** Thao tác ghi: chưa chốt được nhật ký (vẫn PENDING). */
  logPending?: true;
}

const LOI_NOI_BO: LoiTra = { code: "internal", message: "Lỗi máy chủ — thử lại sau." };
const LOI_CHUA_CAU_HINH: LoiTra = {
  code: "not_configured",
  message: "Chưa kết nối SmartLife: máy chủ chưa cấu hình khoá Tuya / công ty được nối.",
};
const LOI_KHONG_QUYEN: LoiTra = { code: "not_permitted", message: "Bạn không có quyền thao tác này." };

const HEADER_TRA_LOI: Record<string, string> = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
  // Câu trả lời tạo mật khẩu tạm chứa mật khẩu thô: không proxy/trình duyệt nào được giữ bản sao.
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function traLoi(status: number, body: unknown, them: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADER_TRA_LOI, ...them } });
}
const thanhCong = (data: unknown): Response => traLoi(200, { ok: true, data });
const loi = (e: LoiTra): Response => traLoi(HTTP_THEO_MA[e.code], { ok: false, error: e });

// ---------------------------------------------------------------------------------------------------
// Cấu hình

export type CheDo = "off" | "read" | "all";

/** DOOR_ACCESS_MODE: vắng/trống ⇒ read (mặc định chỉ đọc); đúng chữ off | read | all; giá trị lạ ⇒ off (an toàn). */
export function docCheDo(raw: string | undefined): CheDo {
  const v = (raw ?? "").trim();
  if (v === "") return "read";
  return v === "read" || v === "all" ? v : "off";
}

export interface CauHinhCua {
  /** null = thiếu hoặc sai khoá Tuya (Access ID, Access Secret đúng 32 byte, base URL trong danh sách cho phép). */
  tuya: TuyaConfig | null;
  /** DOOR_ACCESS_ORG_ID (chữ thường): công ty DUY NHẤT nối với tài khoản SmartLife; null = thiếu/sai. */
  orgId: string | null;
  cheDo: CheDo;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Id ghép vào đường dẫn Tuya (thiết bị, người dùng trên máy) — cùng luật với tuyaDoor.ts. */
const TUYA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function uuidHoacNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return UUID_RE.test(s) ? s : null;
}

export function docOrganizationId(headers: Headers): string | null {
  return uuidHoacNull(headers.get("x-organization-id"));
}

export function docCauHinh(env: (key: string) => string | undefined): CauHinhCua {
  const accessId = (env("TUYA_ACCESS_ID") ?? "").trim();
  const accessSecret = (env("TUYA_ACCESS_SECRET") ?? "").trim();
  let baseUrl: string | null;
  try {
    baseUrl = tuyaBaseUrl((env("TUYA_BASE_URL") ?? "").trim());
  } catch {
    baseUrl = null;
  }
  // Access Secret phải đúng 32 byte: nó là khoá AES-256 giải vé mật khẩu tạm (tuyaCrypto.decryptTicketKey).
  const tuyaOk = baseUrl !== null && TUYA_ID_RE.test(accessId) && new TextEncoder().encode(accessSecret).length === 32;
  return {
    tuya: tuyaOk && baseUrl !== null ? { baseUrl, accessId, accessSecret } : null,
    orgId: uuidHoacNull(env("DOOR_ACCESS_ORG_ID")),
    cheDo: docCheDo(env("DOOR_ACCESS_MODE")),
  };
}

// ---------------------------------------------------------------------------------------------------
// Thân yêu cầu và tham số

const HANH_DONG_GHI: ReadonlySet<string> = new Set([
  "create_temp_password",
  "delete_temp_password",
  "remote_unlock",
  "delete_key",
]);
const HANH_DONG: ReadonlySet<string> = new Set(["status", "discover", "records", "keys", "temp_passwords", ...HANH_DONG_GHI]);

const laObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Cắt theo code point (không chẻ đôi cặp surrogate). */
function catChu(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

class QuaLon extends Error {}

/** Đọc thân có trần: vượt trần thì dừng đọc ngay, không nạp cả gói vào bộ nhớ. */
async function docChuoiCoTran(body: ReadableStream<Uint8Array> | null, tran: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > tran) {
      await reader.cancel().catch(() => undefined);
      throw new QuaLon();
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

type KetQuaThan = { ok: true; body: Record<string, unknown>; action: string } | { ok: false; loi: LoiTra };

async function docThan(req: Request): Promise<KetQuaThan> {
  const khaiBao = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(khaiBao) && khaiBao > TRAN_THAN_BYTES) {
    return { ok: false, loi: { code: "invalid_request", message: "Thân yêu cầu quá lớn." } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await docChuoiCoTran(req.body, TRAN_THAN_BYTES));
  } catch (e) {
    const message = e instanceof QuaLon ? "Thân yêu cầu quá lớn." : "Thân yêu cầu phải là JSON.";
    return { ok: false, loi: { code: "invalid_request", message } };
  }
  if (!laObject(parsed) || typeof parsed.action !== "string") {
    return { ok: false, loi: { code: "invalid_request", message: "Thân yêu cầu phải là object có action." } };
  }
  if (!HANH_DONG.has(parsed.action)) return { ok: false, loi: { code: "invalid_request", message: "Hành động không hợp lệ." } };
  return { ok: true, body: parsed, action: parsed.action };
}

/** Tham số sai ⇒ 400 invalid_request. Mọi tham số được kiểm TRƯỚC lời gọi RPC/Tuya đầu tiên của hành động. */
class ThamSoSai extends Error {}

function canDeviceId(v: unknown): string {
  const id = uuidHoacNull(v);
  if (!id) throw new ThamSoSai("deviceId phải là mã máy (uuid) trong CRM.");
  return id;
}

/** Số nguyên an toàn trong [min, max]; vắng/null ⇒ mặc định (nếu có). Chuỗi chữ số KHÔNG được nhận. */
function canSoNguyen(v: unknown, ten: string, min: number, max: number, macDinh?: number): number {
  if ((v === undefined || v === null) && macDinh !== undefined) return macDinh;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new ThamSoSai(`${ten} phải là số nguyên ${min}–${max}.`);
  }
  return v;
}

function canMocMs(v: unknown, ten: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < MIN_EPOCH_MS || v > MAX_EPOCH_MS) {
    throw new ThamSoSai(`${ten} phải là mốc thời gian tính bằng mili-giây.`);
  }
  return v;
}

function canMocGiay(v: unknown, ten: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > MAX_EPOCH_SEC) {
    throw new ThamSoSai(`${ten} phải là mốc thời gian tính bằng giây.`);
  }
  return v;
}

/** Tên mật khẩu tạm: cắt khoảng trắng hai đầu, 1–20 ký tự (code point), không ký tự điều khiển — như tuyaDoor. */
function canTenMatKhau(v: unknown): string {
  const name = typeof v === "string" ? v.trim() : "";
  const chars = Array.from(name);
  const dieuKhien = chars.some((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
  });
  if (chars.length === 0 || chars.length > TEMP_PASSWORD_NAME_MAX || dieuKhien) {
    throw new ThamSoSai(`Tên mật khẩu tạm phải có 1–${TEMP_PASSWORD_NAME_MAX} ký tự, không ký tự điều khiển.`);
  }
  return name;
}

function canMucDich(v: unknown): MucDichMatKhau {
  const hit = MUC_DICH_MAT_KHAU.find((m) => m === v);
  if (!hit) throw new ThamSoSai(`purpose phải là ${MUC_DICH_MAT_KHAU.join(" | ")}.`);
  return hit;
}

function canLoaiKhoa(v: unknown): LoaiKhoaXoa {
  const hit = LOAI_KHOA_XOA.find((m) => m === v);
  if (!hit) throw new ThamSoSai(`unlockType phải là ${LOAI_KHOA_XOA.join(" | ")}.`);
  return hit;
}

function canTuyaUserId(v: unknown): string {
  // Xoá trên máy cần người dùng (Tuya) đang giữ số đó; số chưa gán ai thì API không xoá được — làm trong app.
  if (v === undefined || v === null || v === "") {
    throw new ThamSoSai("Vân tay chưa gắn người dùng trên máy — xoá trong app SmartLife");
  }
  if (typeof v !== "string" || !TUYA_ID_RE.test(v)) throw new ThamSoSai("tuyaUserId không hợp lệ.");
  return v;
}

function canUserType(v: unknown): 1 | 2 {
  if (v === undefined || v === null) return 1;
  if (v === 1 || v === 2) return v;
  throw new ThamSoSai("userType phải là 1 hoặc 2.");
}

// ---------------------------------------------------------------------------------------------------
// Supabase: phiên, RPC

interface NguCanh {
  f: typeof fetch;
  supabaseUrl: string;
  /** apikey đi kèm JWT người dùng (anon key; vắng thì service key — như quick-entry). */
  apikey: string;
  serviceKey: string;
  /** JWT của người gọi. */
  token: string;
  org: string;
}

/** Đọc thân trả lời thành JSON; hỏng/không phải JSON ⇒ undefined (vẫn đọc hết thân để không giữ kết nối). */
async function docJson(r: Response): Promise<unknown> {
  let text: string;
  try {
    text = await r.text();
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Phiên hợp lệ ⇒ true. 4xx của Auth ⇒ unauthorized; Auth không trả lời / 5xx / 429 ⇒ internal (không đá người dùng). */
async function kiemPhien(f: typeof fetch, supabaseUrl: string, apikey: string, token: string): Promise<true | LoiTra> {
  let r: Response;
  try {
    r = await f(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey },
      signal: AbortSignal.timeout(HAN_SUPABASE_MS),
    });
  } catch {
    console.error("door-access: không gọi được Auth");
    return LOI_NOI_BO;
  }
  const user = await docJson(r);
  if (r.status >= 500 || r.status === 429) {
    console.error(`door-access: Auth trả ${r.status}`);
    return LOI_NOI_BO;
  }
  if (r.ok && laObject(user) && typeof user.id === "string" && user.id !== "") return true;
  return { code: "unauthorized", message: "Phiên đăng nhập không hợp lệ — đăng nhập lại." };
}

type KetQuaRpc = { ok: true; data: unknown } | { ok: false; loi: LoiTra };

/**
 * Lỗi PostgREST ⇒ mã hợp đồng. Chỉ 22023/23505/54000/55000 mang câu tiếng Việt do SQL của ta viết cho người dùng
 * ⇒ chuyển nguyên (≤ 200 ký tự); 42501 gộp "không có quyền" và "không thấy trong công ty" nên không phân biệt được
 * máy không tồn tại ⇒ luôn not_permitted (không trả device_not_found).
 */
function loiTuPostgrest(status: number, body: unknown): LoiTra {
  const code = laObject(body) && typeof body.code === "string" ? body.code : "";
  const sql = laObject(body) && typeof body.message === "string" ? catChu(body.message.trim(), 200) : "";
  switch (code) {
    case "42501":
      return LOI_KHONG_QUYEN;
    case "22023":
      return { code: "invalid_request", message: sql || "Dữ liệu không hợp lệ." };
    case "23505":
    case "55000":
      return { code: "conflict", message: sql || "Dữ liệu vừa thay đổi — tải lại rồi thử lại." };
    case "54000":
      return { code: "rate_limited", message: sql || "Thao tác quá nhiều lần — thử lại sau." };
  }
  if (status === 401) return { code: "unauthorized", message: "Phiên đăng nhập không hợp lệ — đăng nhập lại." };
  console.error(`door-access: RPC lỗi ${status} ${catChu(code, 16) || "-"}`);
  return LOI_NOI_BO;
}

/** POST /rest/v1/rpc/<ten> schema public. `service`: khoá service role (CHỈ chốt nhật ký); không thì JWT người dùng. */
async function goiRpc(ng: NguCanh, ten: string, args: Record<string, unknown>, service = false): Promise<KetQuaRpc> {
  const bearer = service ? ng.serviceKey : ng.token;
  const apikey = service ? ng.serviceKey : ng.apikey;
  let r: Response;
  try {
    r = await ng.f(`${ng.supabaseUrl}/rest/v1/rpc/${ten}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        apikey,
        "Content-Type": "application/json",
        "Content-Profile": "public",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(HAN_SUPABASE_MS),
    });
  } catch {
    console.error(`door-access: không gọi được RPC ${ten}`);
    return { ok: false, loi: LOI_NOI_BO };
  }
  const data = await docJson(r);
  return r.ok ? { ok: true, data } : { ok: false, loi: loiTuPostgrest(r.status, data) };
}

/** Ngữ cảnh máy do authorize/begin trả (Ctx của hợp đồng), đã kiểm dạng. */
export interface MayCua {
  deviceId: string;
  tuyaDeviceId: string;
  kind: DoorKind;
  channelId: number | undefined;
  passwordLength: number;
}

/** Ctx sai dạng ⇒ null. Phải đúng máy đã xin (deviceId) — không bao giờ gửi lệnh tới máy khác. */
function docMayCua(raw: unknown, deviceId: string): MayCua | null {
  if (!laObject(raw)) return null;
  const tuyaDeviceId = typeof raw.tuya_device_id === "string" && TUYA_ID_RE.test(raw.tuya_device_id) ? raw.tuya_device_id : null;
  const kind = raw.device_kind === "access_control" || raw.device_kind === "wifi_lock" ? raw.device_kind : null;
  const channel = raw.channel_id ?? null;
  const len = raw.password_length ?? DO_DAI_MAT_KHAU_MAC_DINH;
  const channelOk = channel === null || (typeof channel === "number" && Number.isInteger(channel) && channel >= 1 && channel <= 64);
  const lenOk = typeof len === "number" && Number.isInteger(len) && len >= PASSWORD_MIN_LENGTH && len <= PASSWORD_MAX_LENGTH;
  if (uuidHoacNull(raw.device_id) !== deviceId || tuyaDeviceId === null || kind === null || !channelOk || !lenOk) return null;
  return {
    deviceId,
    tuyaDeviceId,
    kind,
    channelId: typeof channel === "number" ? channel : undefined,
    passwordLength: len as number,
  };
}

type KetQuaMay = { ok: true; may: MayCua } | { ok: false; loi: LoiTra };

/** door_access_authorize_v1 bằng JWT người dùng: máy đang hoạt động + quyền ở toà của máy ⇒ Ctx. */
async function xinQuyenMay(ng: NguCanh, deviceId: string, permission: string): Promise<KetQuaMay> {
  const r = await goiRpc(ng, "door_access_authorize_v1", {
    p_organization_id: ng.org,
    p_device_id: deviceId,
    p_permission: permission,
  });
  if (!r.ok) return r;
  const may = docMayCua(r.data, deviceId);
  if (!may) {
    console.error("door-access: authorize_v1 trả ngữ cảnh sai dạng");
    return { ok: false, loi: LOI_NOI_BO };
  }
  return { ok: true, may };
}

// ---------------------------------------------------------------------------------------------------
// Lỗi Tuya

/** Mã ngắn của lỗi: mã Tuya (từ chối) hoặc http_502, bad_json, bad_result, bad_token, timeout, network. */
function maLoiMang(e: unknown): string {
  if (e instanceof TuyaError) return catChu(String(e.code), 64);
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) return "timeout";
  return "network";
}

/** Mô tả ngắn để chốt nhật ký (không lấy message của lỗi mạng — có thể mang URL). */
function moTaLoiMang(e: unknown, ma: string): string {
  if (e instanceof TuyaError) return catChu(e.msg || ma, 300);
  return ma === "timeout" ? "Tuya không trả lời trong hạn" : "Lỗi mạng khi gọi Tuya";
}

/**
 * Mã "lỗi hệ thống" của Tuya (500 system error, 501 request exception): success:false nhưng lỗi ở phía Tuya, có thể
 * SAU khi lệnh đã tới máy ⇒ ở bước lệnh coi là CHƯA RÕ, không phải "từ chối". Mã từ chối khác vẫn là thất bại.
 */
const MA_TUYA_CHUA_RO: ReadonlySet<string> = new Set(["500", "501"]);

/** Hành động đọc: Tuya từ chối ⇒ 502 (+tuyaCode); tham số ⇒ 400; mạng/hết giờ/HTTP/kết quả lạ ⇒ 504. */
function loiTuyaDoc(e: unknown, action: string): LoiTra {
  if (e instanceof TuyaInputError) return { code: "invalid_request", message: catChu(e.message, 200) };
  if (e instanceof TuyaConfigError) return LOI_CHUA_CAU_HINH;
  if (e instanceof TuyaError && e.rejected) {
    console.error(`door-access: ${action} Tuya từ chối ${maLoiMang(e)}`);
    return { code: "tuya_rejected", message: `SmartLife từ chối yêu cầu (mã ${String(e.code)}).`, tuyaCode: e.code };
  }
  console.error(`door-access: ${action} Tuya lỗi ${maLoiMang(e)}`);
  return { code: "tuya_unavailable", message: "Không đọc được dữ liệu từ SmartLife (mạng/hết giờ) — thử lại sau." };
}

type ThaoTac = "TEMP_PASSWORD_CREATE" | "TEMP_PASSWORD_DELETE" | "REMOTE_UNLOCK" | "KEY_DELETE";
type TrangThaiChot = "OK" | "FAILED" | "UNKNOWN";

const CHUA_RO: Record<ThaoTac, string> = {
  TEMP_PASSWORD_CREATE: "Chưa rõ mật khẩu tạm đã được tạo chưa (mạng/hết giờ) — xem lại danh sách trước khi tạo lại.",
  TEMP_PASSWORD_DELETE: "Chưa rõ mật khẩu tạm đã bị xoá chưa (mạng/hết giờ) — xem lại danh sách.",
  REMOTE_UNLOCK: "Chưa rõ cửa đã mở chưa (mạng/hết giờ) — đừng bấm lại ngay.",
  KEY_DELETE: "Chưa rõ đã xoá trên máy chưa (mạng/hết giờ) — xem lại danh sách.",
};

interface KetCuc {
  status: Exclude<TrangThaiChot, "OK">;
  errorCode: string;
  errorMessage: string;
  traVe: LoiTra;
}

/**
 * Lỗi ở BƯỚC VÉ (TuyaTicketStageError — xin vé, giải ticket_key, mã hoá mật khẩu): lệnh chính CHƯA gửi xuống máy ⇒
 * luôn FAILED, không bao giờ outcomeUnknown; người dùng thử lại được.
 *   Tuya từ chối cấp vé (mọi mã, kể cả 500/501) ⇒ FAILED ticket_<mã Tuya>    · 502 tuya_rejected + tuyaCode
 *   giải vé / mã hoá hỏng                       ⇒ FAILED ticket_crypto_<mã>  · 502 tuya_rejected
 *   mạng, hết giờ, HTTP, kết quả lạ             ⇒ FAILED ticket_<mã>         · 504 tuya_unavailable (không outcomeUnknown)
 */
function ketCucBuocVe(cause: unknown): KetCuc {
  if (cause instanceof TuyaError && cause.rejected) {
    return {
      status: "FAILED",
      errorCode: catChu(`ticket_${maLoiMang(cause)}`, 64),
      errorMessage: catChu(cause.msg || `Tuya từ chối cấp vé (mã ${String(cause.code)})`, 300),
      traVe: {
        code: "tuya_rejected",
        message: `SmartLife từ chối cấp vé (mã ${String(cause.code)}) — lệnh chưa được gửi xuống máy.`,
        tuyaCode: cause.code,
      },
    };
  }
  if (cause instanceof TuyaCryptoError) {
    return {
      status: "FAILED",
      errorCode: `ticket_crypto_${cause.code}`,
      errorMessage: catChu(cause.message, 300),
      traVe: { code: "tuya_rejected", message: "Không giải được vé mật khẩu của SmartLife — lệnh chưa được gửi xuống máy." },
    };
  }
  const ma = maLoiMang(cause);
  return {
    status: "FAILED",
    errorCode: catChu(`ticket_${ma}`, 64),
    errorMessage: moTaLoiMang(cause, ma),
    traVe: {
      code: "tuya_unavailable",
      message: "Không lấy được vé từ SmartLife (mạng/hết giờ) — lệnh chưa được gửi xuống máy, có thể thử lại.",
    },
  };
}

/**
 * Lỗi của một thao tác ghi ⇒ cách chốt nhật ký + câu trả lời.
 *   bước vé (TuyaTicketStageError)          ⇒ FAILED ticket_…       · xem ketCucBuocVe (chưa gửi lệnh)
 *   Tuya từ chối lệnh (trừ 500/501)          ⇒ FAILED <mã Tuya>     · 502 tuya_rejected + tuyaCode
 *   tham số (chặn trước khi gửi)             ⇒ FAILED invalid_input  · 400 invalid_request
 *   mã hoá/sinh mật khẩu hỏng (trước khi gửi) ⇒ FAILED crypto_<mã>    · 502 tuya_rejected
 *   cấu hình                                 ⇒ FAILED not_configured · 503 not_configured
 *   còn lại — mạng, hết giờ, HTTP, kết quả lạ, Tuya 500/501 ⇒ UNKNOWN (lệnh CÓ THỂ đã chạy)
 *                                            · 504 tuya_unavailable + outcomeUnknown (+ tuyaCode nếu Tuya có trả mã)
 */
function ketCucLoiGhi(e: unknown, thaoTac: ThaoTac): KetCuc {
  if (e instanceof TuyaTicketStageError) {
    // Tham số/cấu hình hỏng ở bước vé: như khi ném thẳng (đều FAILED, chưa gửi gì).
    const cause = e.cause;
    return cause instanceof TuyaInputError || cause instanceof TuyaConfigError ? ketCucLoiGhi(cause, thaoTac) : ketCucBuocVe(cause);
  }
  if (e instanceof TuyaError && e.rejected && !MA_TUYA_CHUA_RO.has(String(e.code))) {
    return {
      status: "FAILED",
      errorCode: maLoiMang(e),
      errorMessage: catChu(e.msg || `Tuya từ chối (mã ${String(e.code)})`, 300),
      traVe: { code: "tuya_rejected", message: `SmartLife từ chối thao tác (mã ${String(e.code)}).`, tuyaCode: e.code },
    };
  }
  if (e instanceof TuyaInputError) {
    return {
      status: "FAILED",
      errorCode: "invalid_input",
      errorMessage: catChu(e.message, 300),
      traVe: { code: "invalid_request", message: catChu(e.message, 200) },
    };
  }
  if (e instanceof TuyaCryptoError) {
    return {
      status: "FAILED",
      errorCode: `crypto_${e.code}`,
      errorMessage: catChu(e.message, 300),
      traVe: { code: "tuya_rejected", message: "Lỗi mã hoá trước khi gửi lệnh — lệnh chưa được gửi xuống máy." },
    };
  }
  if (e instanceof TuyaConfigError) {
    return { status: "FAILED", errorCode: "not_configured", errorMessage: catChu(e.message, 300), traVe: LOI_CHUA_CAU_HINH };
  }
  const ma = maLoiMang(e);
  return {
    status: "UNKNOWN",
    errorCode: ma,
    errorMessage: moTaLoiMang(e, ma),
    traVe: {
      code: "tuya_unavailable",
      message: CHUA_RO[thaoTac],
      outcomeUnknown: true,
      ...(e instanceof TuyaError && e.rejected ? { tuyaCode: e.code } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Thao tác ghi: begin ⇒ Tuya đúng một lần ⇒ finish

interface KetQuaGhi {
  data: Record<string, unknown>;
  tuyaPasswordId?: number;
}

/** door_access_finish_action_v1 bằng service role. Hỏng ⇒ false (người gọi gắn logPending), không thử lại. */
async function chotNhatKy(
  ng: NguCanh,
  logId: string,
  ket: { status: TrangThaiChot; tuyaPasswordId?: number; errorCode?: string; errorMessage?: string },
): Promise<boolean> {
  const r = await goiRpc(ng, "door_access_finish_action_v1", {
    p_log_id: logId,
    p_status: ket.status,
    p_tuya_password_id: ket.tuyaPasswordId ?? null,
    p_error_code: ket.errorCode ?? null,
    p_error_message: ket.errorMessage ?? null,
  }, true);
  if (!r.ok) console.error(`door-access: chốt nhật ký ${logId} (${ket.status}) lỗi ${r.loi.code}`);
  return r.ok;
}

const kemPending = (e: LoiTra, daChot: boolean): LoiTra => (daChot ? e : { ...e, logPending: true });

/**
 * Một thao tác ghi. `goiTuya` chạy ĐÚNG MỘT lần sau khi begin ghi PENDING; trả null khi Tuya báo success nhưng kết quả
 * không phải true (lệnh không được thực hiện ⇒ FAILED, KHÔNG chốt OK — KEY_DELETE OK sẽ tự bỏ gắn liên kết).
 */
async function chayGhi(
  ng: NguCanh,
  deviceId: string,
  thaoTac: ThaoTac,
  chiTiet: Record<string, unknown>,
  goiTuya: (may: MayCua) => Promise<KetQuaGhi | null>,
): Promise<Response> {
  const bd = await goiRpc(ng, "door_access_begin_action_v1", {
    p_organization_id: ng.org,
    p_device_id: deviceId,
    p_action: thaoTac,
    p_detail: chiTiet,
  });
  if (!bd.ok) return loi(bd.loi);
  const logId = laObject(bd.data) ? uuidHoacNull(bd.data.log_id) : null;
  if (!logId) {
    console.error(`door-access: begin_action ${thaoTac} trả thiếu log_id`);
    return loi(LOI_NOI_BO);
  }
  const may = docMayCua(bd.data, deviceId);
  if (!may) {
    console.error(`door-access: begin_action ${thaoTac} trả ngữ cảnh sai dạng`);
    const daChot = await chotNhatKy(ng, logId, {
      status: "FAILED",
      errorCode: "bad_context",
      errorMessage: "Ngữ cảnh máy từ cơ sở dữ liệu sai dạng — chưa gửi lệnh",
    });
    return loi(kemPending(LOI_NOI_BO, daChot));
  }

  let ket: KetQuaGhi | null;
  try {
    ket = await goiTuya(may);
  } catch (e) {
    const kc = ketCucLoiGhi(e, thaoTac);
    console.error(`door-access: ${thaoTac} ${kc.status} ${kc.errorCode}`);
    return loi(kemPending(kc.traVe, await chotNhatKy(ng, logId, kc)));
  }
  if (ket === null) {
    console.error(`door-access: ${thaoTac} FAILED result_false`);
    const daChot = await chotNhatKy(ng, logId, {
      status: "FAILED",
      errorCode: "result_false",
      errorMessage: "Tuya trả success nhưng kết quả không phải true",
    });
    return loi(kemPending({ code: "tuya_rejected", message: "SmartLife không xác nhận đã thực hiện thao tác." }, daChot));
  }
  const daChot = await chotNhatKy(ng, logId, { status: "OK", tuyaPasswordId: ket.tuyaPasswordId });
  return thanhCong({ ...ket.data, logId, ...(daChot ? {} : { logPending: true }) });
}

// ---------------------------------------------------------------------------------------------------
// Đọc

/** Chạy `viec` cho từng phần tử, tối đa `gioiHan` việc cùng lúc, giữ thứ tự. Một việc hỏng ⇒ không nhận việc mới, ném lỗi. */
export async function chayGioiHan<T, R>(items: readonly T[], gioiHan: number, viec: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let ke = 0;
  let hong = false;
  const tho = async (): Promise<void> => {
    while (!hong && ke < items.length) {
      const i = ke++;
      try {
        out[i] = await viec(items[i]);
      } catch (e) {
        hong = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(gioiHan, items.length) }, () => tho()));
  return out;
}

const cachMo = (m: UserUnlockMethod) => ({ method: m.method, methodCode: m.methodCode, sn: m.sn, name: m.name });

/**
 * Người dùng trên máy + cách mở khoá của từng người + số chưa gán ai.
 * - access_control: người dùng lật trang 50, tối đa 5 trang (chạm trần ⇒ partial); cách mở khoá đọc tối đa 4 người
 *   cùng lúc; một người đọc hỏng ⇒ cả hành động hỏng (không lặng lẽ bỏ người — đối chiếu sẽ sai).
 * - wifi_lock: API không có cách mở theo người ⇒ methods rỗng, partial = true.
 * Người thiếu userId (hoặc id lạ không ghép được vào đường dẫn) ⇒ methods rỗng, partial = true.
 */
async function docKhoa(tuya: TuyaRequester, may: MayCua) {
  const deviceId = may.tuyaDeviceId;
  const raw: DoorUser[] = [];
  let partial = may.kind === "wifi_lock";
  if (may.kind === "access_control") {
    for (let page = 1;; page++) {
      const r = await listDeviceUsers(tuya, { deviceId, kind: may.kind, pageNo: page, pageSize: TRANG_NGUOI_DUNG });
      raw.push(...r.users);
      if (!r.hasMore) break;
      if (page >= SO_TRANG_NGUOI_DUNG) {
        partial = true;
        break;
      }
    }
  } else {
    raw.push(...(await listDeviceUsers(tuya, { deviceId, kind: may.kind })).users);
  }
  // Trang chồng nhau thì một người không được tính hai lần (và không đọc cách mở hai lần).
  const seen = new Set<string>();
  const users = raw.filter((u) => {
    if (u.userId === null) return true;
    if (seen.has(u.userId)) return false;
    seen.add(u.userId);
    return true;
  });
  const unassigned = await listUnassignedKeys(tuya, { deviceId });
  const docDuoc = (u: DoorUser): u is DoorUser & { userId: string } => u.userId !== null && TUYA_ID_RE.test(u.userId);
  if (may.kind === "access_control" && users.some((u) => !docDuoc(u))) partial = true;
  const methods = may.kind === "access_control"
    ? await chayGioiHan(
      users,
      SONG_SONG_CACH_MO,
      (u) => (docDuoc(u) ? listUserUnlockMethods(tuya, { deviceId, userId: u.userId }) : Promise.resolve([])),
    )
    : users.map((): UserUnlockMethod[] => []);
  return {
    users: users.map((u, i) => ({
      userId: u.userId,
      name: u.name,
      role: u.role,
      userType: u.userType,
      methods: methods[i].map(cachMo),
    })),
    unassigned: unassigned.map((k) => ({ method: k.method, methodCode: k.methodCode, sn: k.sn })),
    partial,
  };
}

/** door_access_devices_v1 ⇒ tuya_device_id → {deviceId, buildingId}. Sai dạng ⇒ null (không coi là "chưa gắn máy nào"). */
function mayDaGan(raw: unknown): Map<string, { deviceId: string; buildingId: string | null }> | null {
  if (!laObject(raw) || !Array.isArray(raw.devices)) return null;
  const out = new Map<string, { deviceId: string; buildingId: string | null }>();
  for (const d of raw.devices) {
    if (!laObject(d) || typeof d.tuya_device_id !== "string" || typeof d.id !== "string") return null;
    out.set(d.tuya_device_id, { deviceId: d.id, buildingId: typeof d.building_id === "string" ? d.building_id : null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------

export interface PhuThuoc {
  getEnv?: (key: string) => string | undefined;
  /** fetch cho Supabase (Auth, RPC) — và cho Tuya khi dùng nhà máy client mặc định. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Dựng client Tuya từ cấu hình đã kiểm. Mặc định TuyaClient (kho token chung của isolate). */
  tuya?: (config: TuyaConfig) => TuyaRequester;
  /** Sinh mật khẩu số đúng độ dài. Mặc định generateNumericPassword (CSPRNG, không lệch modulo). */
  randomPassword?: (length: number) => string;
}

interface MoiTruong {
  tuya: TuyaRequester;
  accessSecret: string;
  now: () => number;
  randomPassword: (length: number) => string;
}

async function dieuPhoi(action: string, body: Record<string, unknown>, ng: NguCanh, mt: MoiTruong): Promise<Response> {
  const { tuya } = mt;
  switch (action) {
    case "discover": {
      // Tìm máy cần Quản lý ở MỌI toà đang hoạt động của công ty: người quản lý một toà không được thấy (rồi gắn về toà
      // mình và mở) máy chưa gắn của toà khác.
      const quyen = await goiRpc(ng, "door_access_can_manage_org_v1", { p_organization_id: ng.org });
      if (!quyen.ok) return loi(quyen.loi);
      if (quyen.data !== true) return loi(LOI_KHONG_QUYEN);
      const ds = await goiRpc(ng, "door_access_devices_v1", { p_organization_id: ng.org, p_include_inactive: true });
      if (!ds.ok) return loi(ds.loi);
      const daGan = mayDaGan(ds.data);
      if (!daGan) {
        console.error("door-access: devices_v1 trả sai dạng");
        return loi(LOI_NOI_BO);
      }
      try {
        const kq = await listProjectDevices(tuya, { maxPages: SO_TRANG_THIET_BI });
        return thanhCong({
          // TRẢ MỌI máy của project, kể cả kind = null (category chưa nhận ra): mã category thật chưa kiểm trên máy thật,
          // lọc ở đây có thể làm máy cửa thật không gắn được. Trang ẩn kind = null sau một công tắc.
          devices: kq.devices.map((d) => ({
            tuyaDeviceId: d.id,
            name: d.name,
            category: d.category,
            productName: d.productName,
            online: d.online,
            kind: d.kind,
            registered: daGan.get(d.id) ?? null,
          })),
          hasMore: kq.hasMore,
        });
      } catch (e) {
        return loi(loiTuyaDoc(e, action));
      }
    }

    case "records": {
      const deviceId = canDeviceId(body.deviceId);
      const startMs = canMocMs(body.startMs, "startMs");
      const endMs = canMocMs(body.endMs, "endMs");
      if (endMs <= startMs) throw new ThamSoSai("endMs phải sau startMs.");
      if (endMs - startMs > TRAN_KHOANG_NHAT_KY_MS) throw new ThamSoSai("Mỗi lần xem lịch sử tối đa 31 ngày.");
      const pageNo = canSoNguyen(body.pageNo, "pageNo", 1, 10_000, 1);
      const pageSize = canSoNguyen(body.pageSize, "pageSize", 1, TRAN_TRANG_NHAT_KY, TRANG_NHAT_KY_MAC_DINH);
      const q = await xinQuyenMay(ng, deviceId, "door_access.view");
      if (!q.ok) return loi(q.loi);
      try {
        const page = await listRecords(tuya, {
          deviceId: q.may.tuyaDeviceId,
          kind: q.may.kind,
          startMs,
          endMs,
          pageNo,
          pageSize,
        });
        return thanhCong({ records: page.records, total: page.total, hasMore: page.hasMore });
      } catch (e) {
        return loi(loiTuyaDoc(e, action));
      }
    }

    case "keys": {
      const deviceId = canDeviceId(body.deviceId);
      const q = await xinQuyenMay(ng, deviceId, "door_access.view");
      if (!q.ok) return loi(q.loi);
      try {
        return thanhCong(await docKhoa(tuya, q.may));
      } catch (e) {
        return loi(loiTuyaDoc(e, action));
      }
    }

    case "temp_passwords": {
      const deviceId = canDeviceId(body.deviceId);
      const q = await xinQuyenMay(ng, deviceId, "door_access.temp_password");
      if (!q.ok) return loi(q.loi);
      try {
        const kq = await listTempPasswords(tuya, { deviceId: q.may.tuyaDeviceId, kind: q.may.kind });
        return thanhCong({ passwords: kq.passwords, hasMore: kq.hasMore });
      } catch (e) {
        return loi(loiTuyaDoc(e, action));
      }
    }

    case "create_temp_password": {
      const deviceId = canDeviceId(body.deviceId);
      const name = canTenMatKhau(body.name);
      const purpose = canMucDich(body.purpose);
      const effectiveSec = canMocGiay(body.effectiveSec, "effectiveSec");
      const invalidSec = canMocGiay(body.invalidSec, "invalidSec");
      const nowSec = Math.floor(mt.now() / 1000);
      if (effectiveSec < nowSec - LUI_BAT_DAU_GIAY) throw new ThamSoSai("Giờ bắt đầu đã qua — chọn lại.");
      if (invalidSec <= nowSec) throw new ThamSoSai("Giờ hết hạn phải sau hiện tại.");
      if (invalidSec <= effectiveSec) throw new ThamSoSai("Giờ hết hạn phải sau giờ bắt đầu.");
      if (invalidSec - effectiveSec > TRAN_HAN_MAT_KHAU_GIAY) throw new ThamSoSai("Mật khẩu tạm dùng tối đa 7 ngày.");
      // Mã phải hết hạn trong 7 ngày kể từ LÚC TẠO (không chỉ dài ≤ 7 ngày): không đặt trước mã sống ở tương lai xa.
      // Dung sai 300 s như giờ bắt đầu; SQL begin_action kiểm cùng luật.
      if (invalidSec > nowSec + TRAN_HAN_MAT_KHAU_GIAY + LUI_BAT_DAU_GIAY) {
        throw new ThamSoSai("Mật khẩu tạm phải hết hạn trong vòng 7 ngày kể từ bây giờ.");
      }
      // p_detail KHÔNG chứa mật khẩu: mật khẩu sinh SAU begin (độ dài theo máy) và chỉ đi tới Tuya (đã mã hoá bằng vé).
      return await chayGhi(ng, deviceId, "TEMP_PASSWORD_CREATE", {
        name,
        purpose,
        effective_sec: effectiveSec,
        invalid_sec: invalidSec,
      }, async (may) => {
        const password = mt.randomPassword(may.passwordLength);
        const { passwordId } = await createTempPassword(tuya, {
          deviceId: may.tuyaDeviceId,
          name,
          password,
          effectiveSec,
          invalidSec,
          accessSecret: mt.accessSecret,
        });
        return { data: { passwordId, password, effectiveSec, invalidSec }, tuyaPasswordId: passwordId };
      });
    }

    case "delete_temp_password": {
      const deviceId = canDeviceId(body.deviceId);
      const passwordId = canSoNguyen(body.passwordId, "passwordId", 0, Number.MAX_SAFE_INTEGER);
      return await chayGhi(ng, deviceId, "TEMP_PASSWORD_DELETE", { password_id: passwordId }, async (may) => {
        const deleted = await deleteTempPassword(tuya, { deviceId: may.tuyaDeviceId, passwordId });
        return deleted ? { data: { deleted: true } } : null;
      });
    }

    case "remote_unlock": {
      const deviceId = canDeviceId(body.deviceId);
      return await chayGhi(ng, deviceId, "REMOTE_UNLOCK", {}, async (may) => {
        const unlocked = await remoteUnlock(tuya, { deviceId: may.tuyaDeviceId, kind: may.kind, channelId: may.channelId });
        return unlocked ? { data: { unlocked: true } } : null;
      });
    }

    case "delete_key": {
      const deviceId = canDeviceId(body.deviceId);
      const unlockType = canLoaiKhoa(body.unlockType);
      const unlockNo = canSoNguyen(body.unlockNo, "unlockNo", 0, MAX_INT32);
      const tuyaUserId = canTuyaUserId(body.tuyaUserId);
      const userType = canUserType(body.userType);
      return await chayGhi(ng, deviceId, "KEY_DELETE", {
        unlock_type: unlockType,
        unlock_sn: unlockNo,
        tuya_user_id: tuyaUserId,
        user_type: userType,
      }, async (may) => {
        const deleted = await deleteUnlockMethod(tuya, {
          deviceId: may.tuyaDeviceId,
          userType,
          userId: tuyaUserId,
          unlockType,
          unlockNo,
        });
        return deleted ? { data: { deleted: true } } : null;
      });
    }
  }
  return loi({ code: "invalid_request", message: "Hành động không hợp lệ." });
}

export async function xuLy(req: Request, deps: PhuThuoc = {}): Promise<Response> {
  const env = deps.getEnv ?? ((k: string) => Deno.env.get(k));
  // Gọi fetch như hàm trần (không gắn `this`) — fetch gốc của nền tảng đòi điều này.
  const f: typeof fetch = (input, init) => (deps.fetchImpl ?? globalThis.fetch)(input, init);
  const now = deps.now ?? (() => Date.now());

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  if (req.method !== "POST") {
    return traLoi(405, { ok: false, error: { code: "method_not_allowed", message: "Chỉ nhận POST." } }, { Allow: "POST, OPTIONS" });
  }
  const than = await docThan(req);
  if (!than.ok) return loi(than.loi);
  const { action, body } = than;

  // Cấu hình trước mọi lời gọi: thiếu khoá thì không tốn lượt gọi Auth nào. status vẫn trả lời để trang báo "chưa kết nối".
  const cauHinh = docCauHinh(env);
  if (action !== "status" && (!cauHinh.tuya || !cauHinh.orgId)) return loi(LOI_CHUA_CAU_HINH);

  const supabaseUrl = (env("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  const serviceKey = (env("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const apikey = (env("SUPABASE_ANON_KEY") ?? "").trim() || serviceKey;
  // Chỉ nhận "Bearer <token>": header "Bearer" trơ (Headers đã cắt khoảng trắng cuối) là thiếu phiên, không phải token.
  const token = /^Bearer\s+(\S+)$/i.exec((req.headers.get("Authorization") ?? "").trim())?.[1] ?? "";
  if (!token) return loi({ code: "unauthorized", message: "Thiếu phiên đăng nhập." });
  if (!supabaseUrl || !apikey) {
    console.error("door-access: thiếu SUPABASE_URL hoặc khoá Supabase");
    return loi(LOI_NOI_BO);
  }
  const phien = await kiemPhien(f, supabaseUrl, apikey, token);
  if (phien !== true) return loi(phien);

  const org = docOrganizationId(req.headers);
  if (!org) return loi({ code: "organization_required", message: "Chưa chọn công ty." });

  if (action === "status") {
    return thanhCong({
      configured: cauHinh.tuya !== null && cauHinh.orgId !== null,
      connectedOrg: cauHinh.orgId !== null && org === cauHinh.orgId,
      mode: cauHinh.cheDo,
    });
  }
  if (!cauHinh.tuya || !cauHinh.orgId) return loi(LOI_CHUA_CAU_HINH);
  if (org !== cauHinh.orgId) {
    return loi({ code: "org_not_connected", message: "Công ty này chưa được nối với tài khoản SmartLife." });
  }
  if (cauHinh.cheDo === "off") return loi({ code: "mode_off", message: "Cửa vân tay đang tắt." });
  const ghi = HANH_DONG_GHI.has(action);
  if (ghi && cauHinh.cheDo !== "all") {
    return loi({ code: "writes_disabled", message: "Đang chạy chỉ đọc — chưa cho thao tác ghi xuống máy." });
  }
  // Không có khoá service thì không chốt được nhật ký ⇒ không gửi lệnh ghi nào xuống máy.
  if (ghi && !serviceKey) {
    console.error("door-access: thiếu SUPABASE_SERVICE_ROLE_KEY");
    return loi(LOI_NOI_BO);
  }

  let tuya: TuyaRequester;
  try {
    tuya = deps.tuya
      ? deps.tuya(cauHinh.tuya)
      : new TuyaClient(cauHinh.tuya, { fetch: (url, init) => f(url, init), now });
  } catch {
    console.error("door-access: dựng client Tuya lỗi");
    return loi(LOI_CHUA_CAU_HINH);
  }

  const ng: NguCanh = { f, supabaseUrl, apikey, serviceKey, token, org };
  try {
    return await dieuPhoi(action, body, ng, {
      tuya,
      accessSecret: cauHinh.tuya.accessSecret,
      now,
      randomPassword: deps.randomPassword ?? ((length: number) => generateNumericPassword(length)),
    });
  } catch (e) {
    if (e instanceof ThamSoSai) return loi({ code: "invalid_request", message: e.message });
    console.error(`door-access: ${action} lỗi ngoài dự kiến ${e instanceof Error ? e.name : typeof e}`);
    return loi(LOI_NOI_BO);
  }
}

if (import.meta.main) Deno.serve((req) => xuLy(req));
