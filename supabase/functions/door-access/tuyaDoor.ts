// Bộ chuyển "Door Lock API" của Tuya ⇒ kiểu dữ liệu chuẩn hoá (camelCase) cho hàm door-access.
//
// Hai loại thiết bị (kindFromCategory):
//   access_control — kiểm soát ra vào (category "mk"): nhật ký /door-lock/records, người dùng v1.1, mở cửa v1.1 (có kênh);
//   wifi_lock      — khoá Wi-Fi (ms, jtmspro, videolock, …): nhật ký /open-logs, người dùng v1.0, mở cửa v1.0.
//
// - Mọi id ghép vào đường dẫn đều được kiểm (chữ/số/_/-, ≤ 64 ký tự; id dạng số phải là số nguyên) — không chèn
//   được đoạn đường dẫn khác.
// - Kết quả sai dạng (thiếu mảng, thiếu id bắt buộc) ⇒ TuyaError "bad_result": không trả rỗng che lỗi. Trường phụ
//   vắng/sai kiểu ⇒ null.
// - Không thử lại: mỗi request tới Tuya gửi đúng một lần (lật trang là request mới; ngoại lệ duy nhất là gửi lại
//   khi token hỏng — xem tuyaClient.ts).
// - Không trả/ghi mật khẩu (thô hay đã mã hoá) ra ngoài; tạo mật khẩu tạm chỉ trả passwordId.
// - Tạo mật khẩu tạm / mở cửa từ xa có hai bước: VÉ (xin vé, giải ticket_key, mã hoá mật khẩu) rồi LỆNH. Mọi lỗi ở
//   bước vé — kể cả mạng/hết giờ — được bọc trong TuyaTicketStageError {cause}: lệnh chưa được gửi, kết quả chắc
//   chắn là "chưa làm". Lỗi ở bước lệnh ném nguyên trạng (mạng/hết giờ ⇒ lệnh CÓ THỂ đã chạy).

import { TuyaConfigError, TuyaError, TuyaInputError, type TuyaRequester } from "./tuyaClient.ts";
import { decryptTicketKey, encryptPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./tuyaCrypto.ts";

export type DoorKind = "access_control" | "wifi_lock";
export type UnlockMethod = "fingerprint" | "password" | "card" | "temporary" | "dynamic" | "app" | "remote" | "face" | "other";
/** "doorbell" thêm ngoài unlock/alarm: bộ mã dp đọc nhật ký có cả chuông cửa — gộp vào "mở cửa" là sai. */
export type DoorRecordKind = "unlock" | "alarm" | "doorbell";
export type DoorUserRole = "owner" | "admin" | "member";

/** Mã dp đọc nhật ký của thiết bị kiểm soát ra vào (tham số target_standard_dp_codes). */
export const RECORD_DP_CODES: readonly string[] = [
  "unlock_fingerprint",
  "unlock_password",
  "unlock_card",
  "unlock_temporary",
  "unlock_dynamic",
  "unlock_app",
  "unlock_remote",
  "unlock_face",
  "doorbell",
  "alarm_lock",
];

/**
 * Đơn vị start_time/end_time khi đọc nhật ký. Tài liệu Tuya không thống nhất (trang ghi giây, trang ghi ms) —
 * CẦN KIỂM trên thiết bị thật; đổi đúng một chỗ này.
 */
export const RECORD_TIME_UNIT: "ms" | "s" = "ms";

export const DEVICE_PAGE_SIZE = 20;
export const TEMP_PASSWORD_PAGE_SIZE = 50;
export const TEMP_PASSWORD_NAME_MAX = 20;

/**
 * Lỗi ở BƯỚC VÉ của createTempPassword/remoteUnlock (xin vé mật khẩu, giải ticket_key, mã hoá mật khẩu bằng khoá vé):
 * lệnh chính (tạo mật khẩu tạm / mở cửa) CHƯA được gửi tới Tuya. `cause` là lỗi gốc nguyên trạng — TuyaError
 * (từ chối hoặc HTTP/kết quả lạ), TuyaCryptoError, lỗi mạng/hết giờ… Chỉ ném từ bước vé; người gọi chốt "thất bại",
 * không bao giờ "chưa rõ". Không thử lại.
 */
export class TuyaTicketStageError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    // Không chép message của lỗi gốc (lỗi mạng có thể mang URL): chỉ tên loại lỗi.
    super(`Bước vé mật khẩu lỗi (${cause instanceof Error ? cause.name : typeof cause}) — lệnh chưa được gửi`);
    this.name = "TuyaTicketStageError";
    this.cause = cause;
  }
}

/** Chạy bước vé: lỗi nào cũng bọc thành TuyaTicketStageError (lệnh chính chưa gửi). */
async function buocVe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new TuyaTicketStageError(error);
  }
}

export interface DoorDevice {
  id: string;
  /** Tên người dùng tự đặt (customName) nếu có, không thì tên thiết bị. */
  name: string | null;
  category: string | null;
  productName: string | null;
  online: boolean | null;
  timeZone: string | null;
  kind: DoorKind | null;
}

export interface DoorRecord {
  /** record_id của Tuya; open-logs không có id ⇒ ghép "mốc:mã dp:giá trị:người". */
  id: string;
  /** Mốc ms (Tuya trả giây thì đã nhân 1000). */
  at: number | null;
  kind: DoorRecordKind;
  method: UnlockMethod;
  /** Mã dp gốc (unlock_fingerprint, alarm_lock, …). */
  methodCode: string | null;
  /** Giá trị dp: số vân tay/thẻ/mật khẩu, id mật khẩu tạm, hoặc mã cảnh báo. */
  slot: number | string | null;
  userId: string | null;
  userName: string | null;
  unlockName: string | null;
}

export interface DoorRecordPage {
  records: DoorRecord[];
  total: number | null;
  hasMore: boolean;
}

export interface DoorUser {
  userId: string | null;
  name: string | null;
  /** user_type 50 = owner, 10 = admin, 20 = member; mã khác ⇒ null (xem userType). */
  role: DoorUserRole | null;
  userType: number | null;
  lockUserId: number | null;
  effective: boolean | null;
}

export interface DoorUserPage {
  users: DoorUser[];
  total: number | null;
  hasMore: boolean;
}

export interface UserUnlockMethod {
  method: UnlockMethod;
  methodCode: string | null;
  /** Số thứ tự trên khoá (unlock_sn) — chính là unlockNo khi xoá. */
  sn: number | null;
  name: string | null;
  opmodeId: number | string | null;
}

export interface UnassignedKey {
  method: UnlockMethod;
  methodCode: string | null;
  sn: number | null;
}

export interface PasswordTicket {
  ticketId: string;
  ticketKey: string;
  expireTime: number | null;
}

export interface TempPassword {
  id: number;
  name: string | null;
  phase: number | null;
  effectiveSec: number | null;
  invalidSec: number | null;
  deliveryStatus: number | null;
}

// ---------------------------------------------------------------------------------------------------
// Kiểm đầu vào

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Mốc ms nhỏ hơn mức này (năm 1973) gần như chắc là giây truyền nhầm. */
const MIN_EPOCH_MS = 1e11;
const MAX_EPOCH_MS = 1e14;
/** Mốc giây lớn hơn mức này (năm 2286) gần như chắc là ms truyền nhầm. */
const MAX_EPOCH_SEC = 9_999_999_999;
const MAX_INT32 = 2_147_483_647;

function idSegment(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new TuyaInputError(`${label} không hợp lệ`);
  return value;
}

function intValue(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new TuyaInputError(`${label} phải là số nguyên ${min}–${max}`);
  }
  return n;
}

function checkKind(value: unknown): DoorKind {
  if (value !== "access_control" && value !== "wifi_lock") throw new TuyaInputError("Loại thiết bị không hợp lệ");
  return value;
}

/** Tên mật khẩu tạm: 1–20 ký tự (đếm theo code point), không ký tự điều khiển; cắt khoảng trắng hai đầu. */
function checkName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  const chars = [...name];
  const control = chars.some((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
  if (chars.length === 0 || chars.length > TEMP_PASSWORD_NAME_MAX || control) {
    throw new TuyaInputError(`Tên mật khẩu tạm phải có 1–${TEMP_PASSWORD_NAME_MAX} ký tự, không ký tự điều khiển`);
  }
  return name;
}

/** Mốc nhật ký theo RECORD_TIME_UNIT. */
export function recordTimeParam(ms: number, unit: "ms" | "s" = RECORD_TIME_UNIT): number {
  return unit === "s" ? Math.floor(ms / 1000) : ms;
}

// ---------------------------------------------------------------------------------------------------
// Đọc kết quả

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

const numberOf = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
};

const flag = (value: unknown): boolean | null => {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
};

const idText = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;

/** Mốc về ms: số < 1e11 coi là GIÂY (1e11 ms = năm 1973 — bản ghi thật không cũ vậy). */
const toMs = (value: unknown): number | null => {
  const n = numberOf(value);
  if (n === null || n <= 0) return null;
  return n < MIN_EPOCH_MS ? n * 1000 : n;
};

/** Mốc về giây: số ≥ 1e11 coi là ms. */
const toSec = (value: unknown): number | null => {
  const n = numberOf(value);
  if (n === null || n <= 0) return null;
  return n >= MIN_EPOCH_MS ? Math.floor(n / 1000) : n;
};

/** Số nguyên không âm (số hoặc chuỗi chữ số) — id mật khẩu tạm. */
const integerId = (value: unknown): number | null => {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** Giá trị dp làm "slot": số giữ nguyên, chuỗi chữ số ⇒ số, chuỗi khác giữ nguyên. */
const slotOf = (value: unknown): number | string | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  return /^\d{1,15}$/.test(value) ? Number(value) : value;
};

function badResult(path: string, what: string): TuyaError {
  return new TuyaError("bad_result", `Kết quả Tuya sai dạng: ${what}`, path);
}

/** Mảng kết quả: result là mảng, hoặc object có mảng ở một trong các khoá. Không có ⇒ bad_result. */
function listIn(result: unknown, keys: readonly string[], path: string): unknown[] {
  if (Array.isArray(result)) return result;
  if (isRecord(result)) {
    for (const key of keys) {
      const value = result[key];
      if (Array.isArray(value)) return value;
    }
  }
  throw badResult(path, `thiếu mảng ${keys.join("/")}`);
}

const METHOD_BY_CODE: ReadonlyMap<string, UnlockMethod> = new Map(
  (["fingerprint", "password", "card", "temporary", "dynamic", "app", "remote", "face"] as const).flatMap(
    (m): Array<[string, UnlockMethod]> => [[`unlock_${m}`, m], [m, m]],
  ),
);

/** Mã dp/loại mở khoá ⇒ cách mở chuẩn; nhận cả "unlock_fingerprint" lẫn "fingerprint". */
export function unlockMethodFromCode(code: unknown): UnlockMethod {
  return typeof code === "string" ? METHOD_BY_CODE.get(code) ?? "other" : "other";
}

const WIFI_LOCK_CATEGORIES: ReadonlySet<string> = new Set(["ms", "jtmspro", "videolock", "jtmsbh", "gyms", "hotelms", "bxx"]);

export function kindFromCategory(category: unknown): DoorKind | null {
  if (category === "mk") return "access_control";
  return typeof category === "string" && WIFI_LOCK_CATEGORIES.has(category) ? "wifi_lock" : null;
}

/** dps/status ⇒ danh sách [mã, giá trị]. Nhận [{mã: giá trị}], {mã: giá trị}, {code, value}, {dp_code, value} và mảng của chúng. */
function dpEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap(dpEntries);
  if (!isRecord(value)) return [];
  const code = text(value.code) ?? text(value.dp_code);
  if (code !== null) return [[code, value.value ?? value.dp_value ?? null]];
  return Object.entries(value);
}

function pickDp(entries: Array<[string, unknown]>, preferAlarm: boolean): [string, unknown] | null {
  if (preferAlarm) {
    const alarm = entries.find(([code]) => code === "alarm_lock");
    if (alarm) return alarm;
  }
  return entries.find(([code]) => METHOD_BY_CODE.has(code)) ?? entries[0] ?? null;
}

function recordKind(recordType: unknown, code: string | null): DoorRecordKind {
  if (recordType === "alarm" || code === "alarm_lock") return "alarm";
  if (code === "doorbell") return "doorbell";
  return "unlock";
}

function normalizeDevice(raw: unknown, path: string, fallbackId?: string): DoorDevice {
  if (!isRecord(raw)) throw badResult(path, "thiết bị không phải object");
  const id = text(raw.id) ?? fallbackId ?? null;
  if (id === null) throw badResult(path, "thiết bị thiếu id");
  const category = text(raw.category);
  return {
    id,
    name: text(raw.customName) ?? text(raw.custom_name) ?? text(raw.name),
    category,
    productName: text(raw.productName) ?? text(raw.product_name),
    online: flag(raw.isOnline) ?? flag(raw.online),
    timeZone: text(raw.timeZone) ?? text(raw.time_zone),
    kind: kindFromCategory(category),
  };
}

function normalizeAccessRecord(raw: unknown, path: string): DoorRecord {
  if (!isRecord(raw)) throw badResult(path, "bản ghi không phải object");
  const union = isRecord(raw.union_unlock_info) ? raw.union_unlock_info : {};
  const dp = pickDp(dpEntries(raw.dps), raw.record_type === "alarm");
  const methodCode = dp?.[0] ?? text(union.opmode);
  const at = toMs(raw.gmt_create);
  const slot = slotOf(dp?.[1]);
  const userId = idText(raw.user_id);
  return {
    id: idText(raw.record_id) ?? `${at ?? ""}:${methodCode ?? ""}:${slot ?? ""}:${userId ?? ""}`,
    at,
    kind: recordKind(raw.record_type, methodCode),
    method: unlockMethodFromCode(methodCode),
    methodCode,
    slot,
    userId,
    userName: text(raw.user_name) ?? text(union.user_name),
    unlockName: text(raw.unlock_name) ?? text(union.unlock_name),
  };
}

function normalizeOpenLog(raw: unknown, path: string): DoorRecord {
  if (!isRecord(raw)) throw badResult(path, "nhật ký không phải object");
  const dp = pickDp(dpEntries(raw.status), false);
  const methodCode = dp?.[0] ?? null;
  const at = toMs(raw.update_time);
  const slot = slotOf(dp?.[1]);
  const userId = idText(raw.user_id);
  return {
    id: idText(raw.record_id) ?? idText(raw.id) ?? `${at ?? ""}:${methodCode ?? ""}:${slot ?? ""}:${userId ?? ""}`,
    at,
    kind: recordKind(undefined, methodCode),
    method: unlockMethodFromCode(methodCode),
    methodCode,
    slot,
    userId,
    userName: text(raw.nick_name) ?? text(raw.user_name),
    unlockName: text(raw.unlock_name),
  };
}

const ROLE_BY_TYPE: ReadonlyMap<number, DoorUserRole> = new Map([[50, "owner"], [10, "admin"], [20, "member"]]);

function normalizeUser(raw: unknown, path: string): DoorUser {
  if (!isRecord(raw)) throw badResult(path, "người dùng không phải object");
  const userType = numberOf(raw.user_type);
  return {
    userId: idText(raw.user_id) ?? idText(raw.uid),
    name: text(raw.nick_name) ?? text(raw.user_name) ?? text(raw.name),
    role: userType === null ? null : ROLE_BY_TYPE.get(userType) ?? null,
    userType,
    lockUserId: numberOf(raw.lock_user_id),
    effective: flag(raw.effective_flag),
  };
}

function normalizeTempPassword(raw: unknown, path: string): TempPassword {
  if (!isRecord(raw)) throw badResult(path, "mật khẩu tạm không phải object");
  const id = integerId(raw.id) ?? integerId(raw.password_id) ?? integerId(raw.passwordId);
  if (id === null) throw badResult(path, "mật khẩu tạm thiếu id");
  return {
    id,
    name: text(raw.name),
    phase: numberOf(raw.phase),
    effectiveSec: toSec(raw.effective_time ?? raw.effectiveTime),
    invalidSec: toSec(raw.invalid_time ?? raw.invalidTime),
    deliveryStatus: numberOf(raw.delivery_status ?? raw.deliveryStatus),
  };
}

/** has_more nếu Tuya có trả; không thì suy từ tổng số trang / tổng bản ghi. */
function hasMoreOf(result: Record<string, unknown>, pageNo: number, pageSize: number, total: number | null): boolean {
  const explicit = flag(result.has_more) ?? flag(result.hasMore);
  if (explicit !== null) return explicit;
  const totalPages = numberOf(result.total_pages);
  if (totalPages !== null) return pageNo < totalPages;
  return total !== null && pageNo * pageSize < total;
}

// ---------------------------------------------------------------------------------------------------
// Thiết bị

/** Thiết bị trong project Tuya, lật trang bằng last_id. hasMore = còn trang nhưng đã chạm maxPages. */
export async function listProjectDevices(
  client: TuyaRequester,
  options: { maxPages?: number } = {},
): Promise<{ devices: DoorDevice[]; hasMore: boolean }> {
  const maxPages = intValue(options.maxPages ?? 10, "maxPages", 1, 50);
  const path = "/v2.0/cloud/thing/device";
  const devices: DoorDevice[] = [];
  const seen = new Set<string>();
  let lastId: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await client.request<unknown>("GET", path, { query: { page_size: DEVICE_PAGE_SIZE, last_id: lastId } });
    const items = listIn(result, ["list", "devices"], path).map((item) => normalizeDevice(item, path));
    for (const device of items) {
      if (seen.has(device.id)) continue;
      seen.add(device.id);
      devices.push(device);
    }
    if (items.length < DEVICE_PAGE_SIZE) return { devices, hasMore: false };
    const nextId = items[items.length - 1].id;
    // last_id không đổi ⇒ Tuya không lật trang; dừng thay vì đọc lặp — vẫn báo là có thể còn.
    if (nextId === lastId) return { devices, hasMore: true };
    lastId = nextId;
  }
  return { devices, hasMore: true };
}

export async function getDevice(client: TuyaRequester, deviceId: string): Promise<DoorDevice> {
  const id = idSegment(deviceId, "deviceId");
  const path = `/v1.0/devices/${id}`;
  return normalizeDevice(await client.request<unknown>("GET", path), path, id);
}

// ---------------------------------------------------------------------------------------------------
// Nhật ký

export interface ListRecordsInput {
  deviceId: string;
  kind: DoorKind;
  /** Mốc ms (đổi sang RECORD_TIME_UNIT khi gửi). */
  startMs: number;
  endMs: number;
  pageNo?: number;
  pageSize?: number;
}

export async function listRecords(client: TuyaRequester, input: ListRecordsInput): Promise<DoorRecordPage> {
  const id = idSegment(input.deviceId, "deviceId");
  const kind = checkKind(input.kind);
  const startMs = intValue(input.startMs, "startMs", MIN_EPOCH_MS, MAX_EPOCH_MS);
  const endMs = intValue(input.endMs, "endMs", MIN_EPOCH_MS, MAX_EPOCH_MS);
  if (endMs <= startMs) throw new TuyaInputError("endMs phải lớn hơn startMs");
  const pageNo = intValue(input.pageNo ?? 1, "pageNo", 1, 10_000);
  const pageSize = intValue(input.pageSize ?? 20, "pageSize", 1, 100);
  const startTime = recordTimeParam(startMs);
  const endTime = recordTimeParam(endMs);

  if (kind === "access_control") {
    const path = `/v1.0/devices/${id}/door-lock/records`;
    const result = await client.request<unknown>("GET", path, {
      query: {
        target_standard_dp_codes: RECORD_DP_CODES.join(","),
        start_time: startTime,
        end_time: endTime,
        page_no: pageNo,
        page_size: pageSize,
      },
    });
    if (!isRecord(result)) throw badResult(path, "kết quả không phải object");
    const records = listIn(result, ["records"], path).map((item) => normalizeAccessRecord(item, path));
    const total = numberOf(result.total);
    return { records, total, hasMore: hasMoreOf(result, pageNo, pageSize, total) };
  }

  const path = `/v1.1/devices/${id}/door-lock/open-logs`;
  const result = await client.request<unknown>("GET", path, {
    query: { page_no: pageNo, page_size: pageSize, start_time: startTime, end_time: endTime },
  });
  if (!isRecord(result)) throw badResult(path, "kết quả không phải object");
  const records = listIn(result, ["logs"], path).map((item) => normalizeOpenLog(item, path));
  const total = numberOf(result.total);
  return { records, total, hasMore: hasMoreOf(result, pageNo, pageSize, total) };
}

// ---------------------------------------------------------------------------------------------------
// Người dùng và cách mở khoá

export interface ListDeviceUsersInput {
  deviceId: string;
  kind: DoorKind;
  /** Chỉ access_control lật trang; khoá Wi-Fi trả cả danh sách. */
  pageNo?: number;
  pageSize?: number;
}

export async function listDeviceUsers(client: TuyaRequester, input: ListDeviceUsersInput): Promise<DoorUserPage> {
  const id = idSegment(input.deviceId, "deviceId");
  const kind = checkKind(input.kind);
  const pageNo = intValue(input.pageNo ?? 1, "pageNo", 1, 10_000);
  const pageSize = intValue(input.pageSize ?? 20, "pageSize", 1, 100);

  if (kind === "access_control") {
    const path = `/v1.1/devices/${id}/users`;
    const result = await client.request<unknown>("GET", path, {
      query: { keyword: "", role: "", page_no: pageNo, page_size: pageSize },
    });
    const users = listIn(result, ["records", "list", "users"], path).map((item) => normalizeUser(item, path));
    if (!isRecord(result)) return { users, total: users.length, hasMore: false };
    const total = numberOf(result.total);
    return { users, total, hasMore: hasMoreOf(result, pageNo, pageSize, total) };
  }

  const path = `/v1.0/devices/${id}/users`;
  const result = await client.request<unknown>("GET", path);
  const users = listIn(result, ["records", "list", "users"], path).map((item) => normalizeUser(item, path));
  return { users, total: users.length, hasMore: false };
}

/** Cách mở khoá đã gán cho một người (thiết bị kiểm soát ra vào). */
export async function listUserUnlockMethods(
  client: TuyaRequester,
  input: { deviceId: string; userId: string },
): Promise<UserUnlockMethod[]> {
  const id = idSegment(input.deviceId, "deviceId");
  const userId = idSegment(input.userId, "userId");
  const path = `/v1.0/smart-lock/devices/${id}/opmodes/${userId}`;
  const result = await client.request<unknown>("GET", path, {
    query: { codes: "", unlock_name: "", page_no: 1, page_size: 100 },
  });
  return listIn(result, ["records", "list", "opmodes"], path).map((item) => {
    if (!isRecord(item)) throw badResult(path, "cách mở khoá không phải object");
    const methodCode = text(item.dp_code);
    return {
      method: unlockMethodFromCode(methodCode),
      methodCode,
      sn: numberOf(item.unlock_sn),
      name: text(item.unlock_name),
      opmodeId: numberOf(item.opmode_id) ?? idText(item.opmode_id),
    };
  });
}

/** Vân tay/thẻ/mật khẩu đã nạp vào khoá nhưng chưa gán cho ai. */
export async function listUnassignedKeys(client: TuyaRequester, input: { deviceId: string }): Promise<UnassignedKey[]> {
  const id = idSegment(input.deviceId, "deviceId");
  const path = `/v1.0/devices/${id}/door-lock/unassigned-keys`;
  const result = await client.request<unknown>("GET", path);
  return listIn(result, ["unlock_keys"], path).map((item) => {
    if (!isRecord(item)) throw badResult(path, "khoá chưa gán không phải object");
    const methodCode = text(item.unlock_type);
    return { method: unlockMethodFromCode(methodCode), methodCode, sn: numberOf(item.unlock_no) };
  });
}

export interface DeleteUnlockMethodInput {
  deviceId: string;
  /** 1 = thành viên nhà, 2 = không phải thành viên (theo Tuya). */
  userType: 1 | 2;
  userId: string;
  unlockType: "fingerprint" | "password" | "card";
  unlockNo: number;
}

export async function deleteUnlockMethod(client: TuyaRequester, input: DeleteUnlockMethodInput): Promise<boolean> {
  const id = idSegment(input.deviceId, "deviceId");
  if (input.userType !== 1 && input.userType !== 2) throw new TuyaInputError("userType phải là 1 hoặc 2");
  const userId = idSegment(input.userId, "userId");
  if (input.unlockType !== "fingerprint" && input.unlockType !== "password" && input.unlockType !== "card") {
    throw new TuyaInputError("unlockType phải là fingerprint, password hoặc card");
  }
  const unlockNo = intValue(input.unlockNo, "unlockNo", 0, MAX_INT32);
  const path =
    `/v1.0/devices/${id}/door-lock/user-types/${input.userType}/users/${userId}/unlock-types/${input.unlockType}/keys/${unlockNo}`;
  return (await client.request<unknown>("DELETE", path)) === true;
}

// ---------------------------------------------------------------------------------------------------
// Vé mật khẩu, mật khẩu tạm, mở cửa từ xa

export async function getPasswordTicket(client: TuyaRequester, deviceId: string): Promise<PasswordTicket> {
  const id = idSegment(deviceId, "deviceId");
  const path = `/v1.0/devices/${id}/door-lock/password-ticket`;
  const result = await client.request<unknown>("POST", path);
  if (!isRecord(result)) throw badResult(path, "vé không phải object");
  const ticketId = idText(result.ticket_id);
  const ticketKey = typeof result.ticket_key === "string" && /^[0-9A-Fa-f]+$/.test(result.ticket_key) ? result.ticket_key : null;
  if (ticketId === null || ticketKey === null) throw badResult(path, "vé thiếu ticket_id/ticket_key");
  return { ticketId, ticketKey, expireTime: numberOf(result.expire_time) };
}

export interface CreateTempPasswordInput {
  deviceId: string;
  /** 1–20 ký tự. */
  name: string;
  /** Mật khẩu thô 6–10 chữ số (mã hoá bằng vé trước khi gửi). */
  password: string;
  /** Mốc GIÂY bắt đầu / hết hiệu lực. */
  effectiveSec: number;
  invalidSec: number;
  /** Access Secret của project (32 ký tự) — giải ticket_key. */
  accessSecret: string;
}

/**
 * Mật khẩu tạm dùng nhiều lần tới khi hết hạn (type 0). Chỉ trả passwordId — không trả mật khẩu.
 * Lỗi bước vé (xin vé, giải ticket_key, mã hoá) ⇒ TuyaTicketStageError (chưa gửi lệnh tạo); lỗi của lệnh tạo ném nguyên.
 */
export async function createTempPassword(
  client: TuyaRequester,
  input: CreateTempPasswordInput,
): Promise<{ passwordId: number }> {
  const id = idSegment(input.deviceId, "deviceId");
  const name = checkName(input.name);
  const digits = new RegExp(`^\\d{${PASSWORD_MIN_LENGTH},${PASSWORD_MAX_LENGTH}}$`);
  if (typeof input.password !== "string" || !digits.test(input.password)) {
    throw new TuyaInputError(`Mật khẩu phải gồm ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} chữ số`);
  }
  const effectiveSec = intValue(input.effectiveSec, "effectiveSec", 1, MAX_EPOCH_SEC);
  const invalidSec = intValue(input.invalidSec, "invalidSec", 1, MAX_EPOCH_SEC);
  if (invalidSec <= effectiveSec) throw new TuyaInputError("invalidSec phải sau effectiveSec");
  if (typeof input.accessSecret !== "string" || new TextEncoder().encode(input.accessSecret).length !== 32) {
    throw new TuyaConfigError("Access Secret phải đúng 32 byte để giải vé mật khẩu");
  }

  const { ticket, encrypted } = await buocVe(async () => {
    const ticket = await getPasswordTicket(client, id);
    const key = await decryptTicketKey(ticket.ticketKey, input.accessSecret);
    try {
      return { ticket, encrypted: await encryptPassword(input.password, key) };
    } finally {
      key.fill(0);
    }
  });
  const path = `/v1.0/devices/${id}/door-lock/temp-password`;
  const result = await client.request<unknown>("POST", path, {
    body: {
      name,
      password: encrypted,
      password_type: "ticket",
      ticket_id: ticket.ticketId,
      effective_time: effectiveSec,
      invalid_time: invalidSec,
      type: 0,
    },
  });
  const passwordId = isRecord(result) ? integerId(result.id) : null;
  if (passwordId === null) throw badResult(path, "thiếu id mật khẩu");
  return { passwordId };
}

/** Mật khẩu tạm còn hiệu lực. access_control lật trang bằng last_row_key (tối đa maxPages). */
export async function listTempPasswords(
  client: TuyaRequester,
  input: { deviceId: string; kind: DoorKind; maxPages?: number },
): Promise<{ passwords: TempPassword[]; hasMore: boolean }> {
  const id = idSegment(input.deviceId, "deviceId");
  const kind = checkKind(input.kind);
  const maxPages = intValue(input.maxPages ?? 10, "maxPages", 1, 50);

  if (kind === "wifi_lock") {
    const path = `/v1.0/devices/${id}/door-lock/temp-passwords`;
    const result = await client.request<unknown>("GET", path, { query: { valid: true } });
    const passwords = listIn(result, ["records", "list", "passwords"], path).map((item) => normalizeTempPassword(item, path));
    return { passwords, hasMore: false };
  }

  const path = `/v1.0/smart-lock/devices/${id}/stand-by-lock-temp-passwords`;
  const passwords: TempPassword[] = [];
  const seen = new Set<number>();
  let rowKey: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await client.request<unknown>("GET", path, {
      query: { valid: true, page_size: TEMP_PASSWORD_PAGE_SIZE, last_row_key: rowKey },
    });
    const items = listIn(result, ["records", "list", "passwords"], path).map((item) => normalizeTempPassword(item, path));
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      passwords.push(item);
    }
    // Tài liệu lẫn lộn lastRowKey/last_row_key: gửi snake_case, đọc cả hai.
    const next = isRecord(result) ? text(result.last_row_key) ?? text(result.lastRowKey) : null;
    const more = isRecord(result) ? flag(result.has_more) ?? flag(result.hasMore) : null;
    if (items.length === 0 || next === null || next === rowKey || more === false) return { passwords, hasMore: false };
    rowKey = next;
  }
  return { passwords, hasMore: true };
}

export async function deleteTempPassword(
  client: TuyaRequester,
  input: { deviceId: string; passwordId: number | string },
): Promise<boolean> {
  const id = idSegment(input.deviceId, "deviceId");
  const passwordId = intValue(input.passwordId, "passwordId", 0, Number.MAX_SAFE_INTEGER);
  const path = `/v1.0/devices/${id}/door-lock/temp-passwords/${passwordId}`;
  return (await client.request<unknown>("DELETE", path)) === true;
}

/**
 * Mở cửa từ xa không cần mật khẩu: xin vé rồi gửi lệnh mở MỘT lần. Lỗi khi xin vé ⇒ TuyaTicketStageError (chưa gửi
 * lệnh mở); lỗi mạng/hết giờ của lệnh mở ⇒ ném nguyên (cửa có thể đã mở) — không tự gửi lại. channelId chỉ dùng cho
 * access_control (mặc định 1); khoá Wi-Fi bỏ qua.
 */
export async function remoteUnlock(
  client: TuyaRequester,
  input: { deviceId: string; kind: DoorKind; channelId?: number },
): Promise<boolean> {
  const id = idSegment(input.deviceId, "deviceId");
  const kind = checkKind(input.kind);
  const channelId = intValue(input.channelId ?? 1, "channelId", 1, 64);
  const ticket = await buocVe(() => getPasswordTicket(client, id));
  if (kind === "access_control") {
    const path = `/v1.1/devices/${id}/door-lock/password-free/open-door`;
    return (await client.request<unknown>("POST", path, { body: { ticket_id: ticket.ticketId, channel_id: channelId } })) === true;
  }
  const path = `/v1.0/devices/${id}/door-lock/password-free/open-door`;
  return (await client.request<unknown>("POST", path, { body: { ticket_id: ticket.ticketId } })) === true;
}
