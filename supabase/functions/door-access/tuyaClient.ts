// Gọi Tuya Cloud OpenAPI cho hàm door-access: ký HMAC-SHA256, giữ access_token, bọc request, lỗi có mã.
//
// File đứng riêng (không import `_shared`, không thư mục con): lượt deploy lên TEST chỉ tải các file cấp cao
// nhất của thư mục hàm.
//
// Chữ ký — khớp ví dụ chính thức của Tuya (vector kiểm trong tuyaClient.test.ts):
//   stringToSign = METHOD + "\n" + sha256hex(thân) + "\n" + <"tên:giá trị\n" của từng header ký thêm> + "\n" + url
//   url          = path [+ "?" + khoá=giá trị nối "&", xếp theo khoá, giá trị THÔ]. URL gửi đi mang ĐÚNG các tham
//                  số đó, mã hoá phần trăm. Thân JSON hoá MỘT lần: chuỗi đem băm = chuỗi gửi đi.
//   lấy token    : sign = HEX HOA(HMAC-SHA256(secret, client_id + t + nonce + stringToSign))
//   gọi nghiệp vụ: sign = HEX HOA(HMAC-SHA256(secret, client_id + access_token + t + nonce + stringToSign))
//
// Không thử lại ngầm. Ngoại lệ duy nhất: Tuya trả mã 1010 (token hỏng/hết hạn — bị chặn ở cổng xác thực, chưa
// làm gì) ⇒ bỏ token, lấy token mới, gửi lại ĐÚNG MỘT lần. Lỗi mạng/hết giờ ném nguyên trạng: kết quả KHÔNG rõ
// (lệnh mở cửa có thể đã chạy) — người gọi không được tự gửi lại lệnh không idempotent.
// Không ghi log; thông điệp lỗi không chứa Access Secret hay access_token.

/** Máy chủ OpenAPI của Tuya được phép gọi (chỉ https) — cấu hình sai không biến hàm thành proxy tới máy khác. */
export const TUYA_HOSTS: readonly string[] = [
  "openapi.tuyacn.com", // Trung Quốc
  "openapi.tuyaus.com", // Tây Mỹ
  "openapi-ueaz.tuyaus.com", // Đông Mỹ
  "openapi.tuyaeu.com", // Trung Âu
  "openapi-weaz.tuyaeu.com", // Tây Âu
  "openapi.tuyain.com", // Ấn Độ
  "openapi-sg.iotbing.com", // Singapore
];
/** Trần một request, tính cả lúc đọc thân trả lời. */
export const TUYA_TIMEOUT_MS = 15_000;
/** Coi token hết hạn sớm hơn Tuya báo 60 s — không dùng token sắp hết giữa đường. */
export const TOKEN_EARLY_EXPIRY_MS = 60_000;
/** Mã Tuya "token invalid" — mã DUY NHẤT được lấy token mới và gửi lại một lần. */
export const TOKEN_INVALID_CODE = 1010;
/** sha256 của thân rỗng — giá trị có trong tài liệu ký của Tuya. */
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const TOKEN_PATH = "/v1.0/token";

export type TuyaMethod = "GET" | "POST" | "PUT" | "DELETE";
/** Giá trị `undefined` bị bỏ khỏi request; chuỗi rỗng vẫn gửi (`khoá=`) và vẫn có trong chuỗi ký. */
export type TuyaQuery = Readonly<Record<string, string | number | boolean | undefined>>;

export interface TuyaRequestOptions {
  query?: TuyaQuery;
  /** Chỉ POST/PUT. */
  body?: unknown;
}

/** Mặt tối thiểu tuyaDoor.ts cần — TuyaClient thoả. Trả `result` của Tuya (chưa kiểm dạng). */
export interface TuyaRequester {
  request<T = unknown>(method: TuyaMethod, path: string, options?: TuyaRequestOptions): Promise<T>;
}

export interface TuyaConfig {
  baseUrl: string;
  accessId: string;
  accessSecret: string;
  /** Header ký thêm (Signature-Headers, ví dụ area_id/call_id), ký theo thứ tự khai. Mặc định không có. */
  signatureHeaders?: Readonly<Record<string, string>>;
}

export interface TuyaToken {
  accessToken: string;
  /** Mốc ms coi là hết hạn = lúc xin + expire_time × 1000 − 60 s. */
  expiresAt: number;
}

/** Kho token theo khoá `baseUrl|accessId`. Giữ Promise để các lời gọi đồng thời dùng chung MỘT lần xin token. */
export type TuyaTokenCache = Map<string, Promise<TuyaToken>>;
export type TuyaFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TuyaDeps {
  fetch?: TuyaFetch;
  /** Đồng hồ ms (mặc định Date.now). */
  now?: () => number;
  /** Nonce cho từng request (mặc định UUID bỏ gạch). */
  nonce?: () => string;
  /** Trần một request, ms (mặc định 15 000). */
  timeoutMs?: number;
  /** Mặc định là kho chung cấp module: isolate Edge còn sống thì request sau dùng lại token. Test truyền Map riêng. */
  tokenCache?: TuyaTokenCache;
}

/**
 * Có trả lời từ Tuya nhưng không dùng được.
 * - `rejected = true`: Tuya trả `success:false` — `code`/`msg` của Tuya; lệnh KHÔNG được thực hiện.
 * - `rejected = false`: `http_<status>` (HTTP không 2xx), `bad_json` (thân không phải JSON object), `bad_token`,
 *   `bad_result` (kết quả sai dạng) — với lệnh ghi (mở cửa, tạo mật khẩu) kết quả KHÔNG chắc chắn.
 */
export class TuyaError extends Error {
  readonly code: number | string;
  readonly msg: string;
  readonly path: string;
  readonly rejected: boolean;
  constructor(code: number | string, msg: string, path: string, rejected = false) {
    super(`Tuya ${path} lỗi ${code}${msg ? `: ${msg}` : ""}`);
    this.name = "TuyaError";
    this.code = code;
    this.msg = msg;
    this.path = path;
    this.rejected = rejected;
  }
}

/** Cấu hình sai (base URL ngoài danh sách, thiếu Access ID/Secret…) — lỗi vận hành, chưa gửi gì. */
export class TuyaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuyaConfigError";
  }
}

/** Tham số không hợp lệ (id thiết bị, tên, mật khẩu, khung giờ…) — chặn TRƯỚC khi gọi Tuya. */
export class TuyaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuyaInputError";
  }
}

/** Kiểm base URL theo danh sách máy chủ Tuya; trả dạng chuẩn `https://<máy>` (không gạch chéo cuối). */
export function tuyaBaseUrl(raw: unknown): string {
  let url: URL | null = null;
  try {
    url = typeof raw === "string" ? new URL(raw) : null;
  } catch {
    url = null;
  }
  const ok = url !== null && url.protocol === "https:" && url.username === "" && url.password === "" &&
    url.port === "" && url.search === "" && url.hash === "" && (url.pathname === "/" || url.pathname === "") &&
    TUYA_HOSTS.includes(url.hostname);
  // Không nhắc lại URL sai trong thông điệp: cấu hình nhầm có thể chứa tài khoản/mật khẩu.
  if (!ok || url === null) throw new TuyaConfigError("Base URL Tuya phải là https://<máy chủ OpenAPI của Tuya> trong danh sách cho phép");
  return `https://${url.hostname}`;
}

const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

const QUERY_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Cặp tham số đã xếp theo khoá (thứ tự đơn vị mã UTF-16 = thứ tự ASCII của Tuya), bỏ giá trị undefined. */
function queryPairs(query: TuyaQuery | undefined): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  if (!query) return pairs;
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    if (!QUERY_KEY_RE.test(key)) throw new TuyaInputError(`Tên tham số không hợp lệ: ${key.slice(0, 64)}`);
    if (typeof value === "number" && !Number.isFinite(value)) throw new TuyaInputError(`Tham số ${key} không phải số hữu hạn`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new TuyaInputError(`Tham số ${key} phải là chuỗi, số hoặc boolean`);
    }
    pairs.push([key, String(value)]);
  }
  return pairs;
}

/** Phần url trong chuỗi ký: path + "?" + khoá=giá trị THÔ (chưa mã hoá), xếp theo khoá. */
export function signedUrl(path: string, query?: TuyaQuery): string {
  const pairs = queryPairs(query);
  return pairs.length > 0 ? `${path}?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}` : path;
}

/** URL gửi đi: CÙNG các tham số, cùng thứ tự, mã hoá phần trăm. */
function wireUrl(baseUrl: string, path: string, query?: TuyaQuery): string {
  const pairs = queryPairs(query);
  const search = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${baseUrl}${path}${search ? `?${search}` : ""}`;
}

export interface TuyaSignInput {
  accessId: string;
  accessSecret: string;
  /** Vắng = lời gọi lấy token. */
  accessToken?: string;
  /** Mốc ms dạng chuỗi 13 chữ số — cũng là header `t`. */
  t: string;
  nonce: string;
  method: TuyaMethod;
  path: string;
  query?: TuyaQuery;
  /** Chuỗi thân ĐÚNG như gửi đi; vắng = thân rỗng. */
  bodyText?: string;
  signatureHeaders?: Readonly<Record<string, string>>;
}

export async function stringToSign(
  input: Pick<TuyaSignInput, "method" | "path" | "query" | "bodyText" | "signatureHeaders">,
): Promise<string> {
  const headers = Object.entries(input.signatureHeaders ?? {}).map(([name, value]) => `${name}:${value}\n`).join("");
  return `${input.method}\n${await sha256Hex(input.bodyText ?? "")}\n${headers}\n${signedUrl(input.path, input.query)}`;
}

/** Chữ ký Tuya (HEX HOA). Thiếu accessToken = chữ ký lời gọi lấy token. */
export async function tuyaSign(input: TuyaSignInput): Promise<string> {
  const message = `${input.accessId}${input.accessToken ?? ""}${input.t}${input.nonce}${await stringToSign(input)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.accessSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))).toUpperCase();
}

const sharedTokenCache: TuyaTokenCache = new Map();
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "DELETE"]);
const ACCESS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
/** Header client tự đặt — không cho header ký thêm đè lên. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "client_id",
  "sign",
  "t",
  "sign_method",
  "nonce",
  "access_token",
  "signature-headers",
  "content-type",
]);

/** Đường dẫn chỉ gồm đoạn ký tự an toàn (không ".", "..", "?", "#", "%") — chuỗi ký và URL gửi đi trùng nhau. */
function checkPath(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/")) throw new TuyaInputError("Đường dẫn Tuya phải bắt đầu bằng /");
  const segments = path.slice(1).split("/");
  if (segments.some((s) => !PATH_SEGMENT_RE.test(s) || s === "." || s === "..")) {
    throw new TuyaInputError("Đường dẫn Tuya không hợp lệ");
  }
  return path;
}

function checkSignatureHeaders(raw: unknown): Readonly<Record<string, string>> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new TuyaConfigError("signatureHeaders phải là object tên → giá trị");
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!HEADER_NAME_RE.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new TuyaConfigError(`Header ký thêm không hợp lệ: ${name.slice(0, 64)}`);
    }
    if (typeof value !== "string" || value.includes("\r") || value.includes("\n")) {
      throw new TuyaConfigError(`Giá trị header ký thêm ${name} không hợp lệ`);
    }
    out[name] = value;
  }
  return out;
}

/** Xoá secret/token nếu Tuya có lỡ nhắc lại trong `msg`, rồi cắt ngắn. */
function scrub(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[ẩn]");
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

export class TuyaClient implements TuyaRequester {
  readonly #baseUrl: string;
  readonly #accessId: string;
  readonly #accessSecret: string;
  readonly #signatureHeaders: Readonly<Record<string, string>>;
  readonly #fetch: TuyaFetch;
  readonly #now: () => number;
  readonly #nonce: () => string;
  readonly #timeoutMs: number;
  readonly #tokens: TuyaTokenCache;
  readonly #tokenKey: string;

  constructor(config: TuyaConfig, deps: TuyaDeps = {}) {
    this.#baseUrl = tuyaBaseUrl(config.baseUrl);
    if (typeof config.accessId !== "string" || !ACCESS_ID_RE.test(config.accessId)) {
      throw new TuyaConfigError("Access ID Tuya trống hoặc sai dạng");
    }
    if (typeof config.accessSecret !== "string" || config.accessSecret === "") {
      throw new TuyaConfigError("Thiếu Access Secret Tuya");
    }
    this.#accessId = config.accessId;
    this.#accessSecret = config.accessSecret;
    this.#signatureHeaders = checkSignatureHeaders(config.signatureHeaders);
    const timeoutMs = deps.timeoutMs ?? TUYA_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new TuyaConfigError("timeoutMs phải là số nguyên 1–120000");
    }
    this.#timeoutMs = timeoutMs;
    // Gọi fetch như hàm trần (không gắn `this` của client) — fetch gốc của nền tảng đòi điều này.
    const fetchImpl = deps.fetch ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
    this.#fetch = (url, init) => fetchImpl(url, init);
    this.#now = deps.now ?? Date.now;
    this.#nonce = deps.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
    this.#tokens = deps.tokenCache ?? sharedTokenCache;
    this.#tokenKey = `${this.#baseUrl}|${this.#accessId}`;
  }

  /** Gọi một API nghiệp vụ, trả `result`. Lỗi: TuyaInputError (chưa gửi), TuyaError, lỗi mạng/hết giờ (ném nguyên). */
  async request<T = unknown>(method: TuyaMethod, path: string, options: TuyaRequestOptions = {}): Promise<T> {
    if (!METHODS.has(method)) throw new TuyaInputError("Phương thức HTTP không hợp lệ");
    checkPath(path);
    queryPairs(options.query); // kiểm tham số trước khi xin token
    let bodyText: string | undefined;
    if (options.body !== undefined) {
      if (method !== "POST" && method !== "PUT") throw new TuyaInputError(`${method} không gửi thân`);
      try {
        bodyText = JSON.stringify(options.body);
      } catch {
        bodyText = undefined;
      }
      if (typeof bodyText !== "string") throw new TuyaInputError("Thân request không JSON hoá được");
    }
    const token = await this.#accessToken();
    try {
      return await this.#send<T>(method, path, options.query, bodyText, token);
    } catch (error) {
      const tokenInvalid = error instanceof TuyaError && error.rejected && String(error.code) === String(TOKEN_INVALID_CODE);
      if (!tokenInvalid) throw error;
      // Tuya chặn ở cổng xác thực (chưa làm gì) ⇒ bỏ token này, lấy token mới, gửi lại đúng một lần.
      await this.#forget(token);
      return await this.#send<T>(method, path, options.query, bodyText, await this.#accessToken());
    }
  }

  async #accessToken(): Promise<string> {
    const cached = this.#tokens.get(this.#tokenKey);
    if (cached) {
      const token = await cached; // lần xin đang chạy hỏng ⇒ ném luôn cho lời gọi này (không tự xin lại)
      if (this.#now() < token.expiresAt) return token.accessToken;
      if (this.#tokens.get(this.#tokenKey) === cached) this.#tokens.delete(this.#tokenKey);
    }
    let pending = this.#tokens.get(this.#tokenKey);
    if (!pending) {
      const created = this.#requestToken();
      this.#tokens.set(this.#tokenKey, created);
      // Xin hỏng thì gỡ khỏi kho — lời gọi SAU sẽ xin lại từ đầu, kho không giữ lỗi.
      created.catch(() => {
        if (this.#tokens.get(this.#tokenKey) === created) this.#tokens.delete(this.#tokenKey);
      });
      pending = created;
    }
    // Token vừa xin luôn được dùng cho lời gọi này dù hạn ngắn — không có vòng xin lại.
    return (await pending).accessToken;
  }

  async #requestToken(): Promise<TuyaToken> {
    const askedAt = this.#now();
    const result = await this.#send<unknown>("GET", TOKEN_PATH, { grant_type: 1 }, undefined, undefined);
    if (!isRecord(result) || typeof result.access_token !== "string" || result.access_token === "") {
      throw new TuyaError("bad_token", "Tuya không trả access_token", TOKEN_PATH);
    }
    const seconds = typeof result.expire_time === "number" ? result.expire_time : Number.NaN;
    const expiresAt = Number.isFinite(seconds) && seconds > 0 ? askedAt + seconds * 1000 - TOKEN_EARLY_EXPIRY_MS : askedAt;
    return { accessToken: result.access_token, expiresAt };
  }

  /** Bỏ token khỏi kho nếu kho vẫn đang giữ ĐÚNG token đó (lời gọi khác có thể đã thay token mới). */
  async #forget(accessToken: string): Promise<void> {
    const cached = this.#tokens.get(this.#tokenKey);
    if (!cached) return;
    const token = await cached.catch(() => null);
    if (token?.accessToken === accessToken && this.#tokens.get(this.#tokenKey) === cached) {
      this.#tokens.delete(this.#tokenKey);
    }
  }

  async #send<T>(
    method: TuyaMethod,
    path: string,
    query: TuyaQuery | undefined,
    bodyText: string | undefined,
    accessToken: string | undefined,
  ): Promise<T> {
    const t = String(Math.trunc(this.#now()));
    const nonce = this.#nonce();
    const sign = await tuyaSign({
      accessId: this.#accessId,
      accessSecret: this.#accessSecret,
      accessToken,
      t,
      nonce,
      method,
      path,
      query,
      bodyText,
      signatureHeaders: this.#signatureHeaders,
    });
    const headers: Record<string, string> = { client_id: this.#accessId, sign, t, sign_method: "HMAC-SHA256", nonce };
    if (accessToken !== undefined) headers.access_token = accessToken;
    const signedNames = Object.keys(this.#signatureHeaders);
    if (signedNames.length > 0) {
      headers["Signature-Headers"] = signedNames.join(":");
      for (const name of signedNames) headers[name] = this.#signatureHeaders[name];
    }
    if (bodyText !== undefined) headers["Content-Type"] = "application/json";

    const reply = await this.#exchange(wireUrl(this.#baseUrl, path, query), { method, headers, body: bodyText });
    if (!reply.ok) throw new TuyaError(`http_${reply.status}`, `HTTP ${reply.status}`, path);
    let data: unknown;
    try {
      data = JSON.parse(reply.text);
    } catch {
      data = undefined;
    }
    if (!isRecord(data)) throw new TuyaError("bad_json", "Tuya trả thân không phải JSON object", path);
    if (data.success !== true) {
      const code = typeof data.code === "number" || (typeof data.code === "string" && data.code !== "") ? data.code : "unknown";
      const msg = typeof data.msg === "string" ? scrub(data.msg, [this.#accessSecret, accessToken]) : "";
      throw new TuyaError(code, msg, path, true);
    }
    return data.result as T;
  }

  /** Một lượt HTTP có trần thời gian (gồm cả đọc thân). Không theo chuyển hướng: máy chủ đích chỉ là base URL. */
  async #exchange(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException(`Tuya không trả lời trong ${this.#timeoutMs} ms`, "TimeoutError")),
      this.#timeoutMs,
    );
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal, redirect: "error" });
      return { ok: response.ok, status: response.status, text: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }
}
