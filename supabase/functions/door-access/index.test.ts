// Test hàm door-access: fetch giả cho Supabase (Auth + RPC, ghi lại mọi lời gọi) và requester Tuya giả (deps.tuya,
// định tuyến theo "PHƯƠNG THỨC đường dẫn"). Một test đi qua TuyaClient thật (nhà máy mặc định) để kiểm đấu nối.
// Mọi id, khoá, tên đều tự bịa; khoá mang chữ "fake" cho cửa quét secret.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  type TuyaConfig,
  TuyaError,
  TuyaInputError,
  type TuyaMethod,
  type TuyaRequester,
  type TuyaRequestOptions,
  tuyaSign,
} from "./tuyaClient.ts";
import { TuyaCryptoError } from "./tuyaCrypto.ts";
import { chayGioiHan, docCauHinh, docCheDo, HTTP_THEO_MA, type PhuThuoc, xuLy } from "./index.ts";

const URL_HAM = "https://proj.supabase.co/functions/v1/door-access";
const SUPABASE = "https://proj.supabase.co";
const ORG = "0e5d1f9a-3c2b-4a1d-9f00-112233445566";
const ORG_KHAC = "1f6e2a0b-4d3c-4b2e-8a11-223344556677";
const USER = "7a7a7a7a-0000-4000-8000-000000000001";
const DEVICE = "d0d0d0d0-0000-4000-8000-0000000000aa";
const DEVICE_KHAC = "d0d0d0d0-0000-4000-8000-0000000000bb";
const LOG = "10101010-0000-4000-8000-000000000001";
const BUILDING = "b0b0b0b0-0000-4000-8000-000000000001";
const TUYA_DEV = "vdevo00000000000000001";
const ACCESS_ID_FAKE = "fake_access_id_01";
/** Đúng 32 byte — khoá AES-256 giải vé. */
const SECRET_FAKE = "fake_secret_0123456789abcdef_32b";
const BASE = "https://openapi.tuyaus.com";
const USER_JWT = "fake-user-jwt";
const ANON_FAKE = "fake-anon-key";
const SERVICE_FAKE = "fake-service-role-key";
const NOW = Date.UTC(2026, 9, 21, 3, 0, 0);
const NOW_SEC = Math.floor(NOW / 1000);
const NGAY_MS = 86_400_000;

const HANH_DONG_GHI = ["create_temp_password", "delete_temp_password", "remote_unlock", "delete_key"] as const;
const HANH_DONG_DOC = ["discover", "records", "keys", "temp_passwords"] as const;

/** Tham số hợp lệ của từng hành động (trừ status). */
const THAN_HOP_LE: Record<string, Record<string, unknown>> = {
  discover: { action: "discover" },
  records: { action: "records", deviceId: DEVICE, startMs: NOW - NGAY_MS, endMs: NOW },
  keys: { action: "keys", deviceId: DEVICE },
  temp_passwords: { action: "temp_passwords", deviceId: DEVICE },
  create_temp_password: {
    action: "create_temp_password",
    deviceId: DEVICE,
    name: "Thợ sửa ống nước",
    purpose: "THO",
    effectiveSec: NOW_SEC,
    invalidSec: NOW_SEC + 7200,
  },
  delete_temp_password: { action: "delete_temp_password", deviceId: DEVICE, passwordId: 4242 },
  remote_unlock: { action: "remote_unlock", deviceId: DEVICE },
  delete_key: { action: "delete_key", deviceId: DEVICE, unlockType: "fingerprint", unlockNo: 3, tuyaUserId: "tuyaUser01" },
};

// ---------------------------------------------------------------------------------------------------
// Tuya giả

interface GoiTuya {
  method: TuyaMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}
type XuLyTuya = (call: GoiTuya) => unknown;

/** Requester giả: định tuyến "GET /đường/dẫn" (chuỗi hoặc RegExp); handler ném ⇒ lỗi tới thư viện. Đếm số lời gọi đang chạy. */
class TuyaGia implements TuyaRequester {
  readonly calls: GoiTuya[] = [];
  inFlight = 0;
  maxInFlight = 0;
  readonly routes: Array<[string | RegExp, XuLyTuya]>;
  constructor(routes: Array<[string | RegExp, XuLyTuya]> = []) {
    this.routes = routes;
  }
  async request<T = unknown>(method: TuyaMethod, path: string, options: TuyaRequestOptions = {}): Promise<T> {
    const call: GoiTuya = { method, path, query: options.query as Record<string, unknown> | undefined, body: options.body };
    this.calls.push(call);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const key = `${method} ${path}`;
      const route = this.routes.find(([m]) => (typeof m === "string" ? m === key : m.test(key)));
      if (!route) throw new Error(`Tuya giả không có đường ${key}`);
      return (await route[1](call)) as T;
    } finally {
      this.inFlight--;
    }
  }
  goiToi(key: string): GoiTuya[] {
    return this.calls.filter((c) => `${c.method} ${c.path}` === key);
  }
}

const P = {
  devices: "GET /v2.0/cloud/thing/device",
  records: `GET /v1.0/devices/${TUYA_DEV}/door-lock/records`,
  openLogs: `GET /v1.1/devices/${TUYA_DEV}/door-lock/open-logs`,
  usersAc: `GET /v1.1/devices/${TUYA_DEV}/users`,
  usersWifi: `GET /v1.0/devices/${TUYA_DEV}/users`,
  unassigned: `GET /v1.0/devices/${TUYA_DEV}/door-lock/unassigned-keys`,
  tempList: `GET /v1.0/smart-lock/devices/${TUYA_DEV}/stand-by-lock-temp-passwords`,
  ticket: `POST /v1.0/devices/${TUYA_DEV}/door-lock/password-ticket`,
  tempCreate: `POST /v1.0/devices/${TUYA_DEV}/door-lock/temp-password`,
  tempDelete: `DELETE /v1.0/devices/${TUYA_DEV}/door-lock/temp-passwords/4242`,
  unlockAc: `POST /v1.1/devices/${TUYA_DEV}/door-lock/password-free/open-door`,
  unlockWifi: `POST /v1.0/devices/${TUYA_DEV}/door-lock/password-free/open-door`,
  keyDelete: `DELETE /v1.0/devices/${TUYA_DEV}/door-lock/user-types/1/users/tuyaUser01/unlock-types/fingerprint/keys/3`,
};
const methodsOf = (userId: string) => `GET /v1.0/smart-lock/devices/${TUYA_DEV}/opmodes/${userId}`;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
function ecb(mode: "encrypt" | "decrypt", key: Uint8Array, data: Uint8Array): Uint8Array {
  const algorithm = `aes-${key.length * 8}-ecb`;
  const cipher = mode === "encrypt" ? createCipheriv(algorithm, key, null) : createDecipheriv(algorithm, key, null);
  return new Uint8Array([...cipher.update(data), ...cipher.final()]);
}
/** Vé giả đúng cách Tuya làm: khoá gốc 16 byte mã AES-256-ECB bằng Access Secret, hex HOA. */
function veGia(secret = SECRET_FAKE) {
  const rawKey = new Uint8Array(randomBytes(16));
  const ticketKey = hex(ecb("encrypt", new TextEncoder().encode(secret), rawKey)).toUpperCase();
  return { rawKey, ticket: { ticket_id: "fake-ticket-01", ticket_key: ticketKey, expire_time: 300 } };
}
const giaiMatKhau = (hexUpper: string, rawKey: Uint8Array) => new TextDecoder().decode(ecb("decrypt", rawKey, bytes(hexUpper)));

/** Tuya giả cho luồng tạo mật khẩu tạm: vé thật (mã bằng SECRET_FAKE), POST tạo ⇒ id 777, giải lại mật khẩu đã gửi. */
function tuyaTaoMatKhau(createReply: XuLyTuya = () => ({ id: 777 })) {
  const ve = veGia();
  const sent: string[] = [];
  const tuya = new TuyaGia([
    [P.ticket, () => ve.ticket],
    [P.tempCreate, (call) => {
      sent.push(giaiMatKhau(String((call.body as Record<string, unknown>).password), ve.rawKey));
      return createReply(call);
    }],
  ]);
  return { tuya, sent };
}

// ---------------------------------------------------------------------------------------------------
// Supabase giả

type TraRpc = { status?: number; body: unknown } | "network";
type KichRpc = TraRpc | ((args: Record<string, unknown>) => TraRpc);

interface GoiSupabase {
  url: string;
  ten: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

interface Kich {
  /** Ghi đè biến môi trường; giá trị undefined = xoá biến. */
  env?: Record<string, string | undefined>;
  /** null ⇒ Auth trả 401. */
  user?: string | null;
  authStatus?: number;
  authNetwork?: boolean;
  rpc?: Record<string, KichRpc>;
  tuya?: TuyaGia;
  /** false ⇒ không truyền deps.tuya (dùng TuyaClient thật qua fetchImpl). */
  fakeTuya?: boolean;
  tuyaFetch?: (url: string, init: RequestInit) => Promise<Response>;
  randomPassword?: (length: number) => string;
}

const ctxMau = (extra: Record<string, unknown> = {}) => ({
  device_id: DEVICE,
  tuya_device_id: TUYA_DEV,
  device_kind: "access_control",
  channel_id: 1,
  password_length: 7,
  building_id: BUILDING,
  display_name: "Cổng chính",
  ...extra,
});

function setup(k: Kich = {}) {
  const env: Record<string, string | undefined> = {
    TUYA_ACCESS_ID: ACCESS_ID_FAKE,
    TUYA_ACCESS_SECRET: SECRET_FAKE,
    TUYA_BASE_URL: BASE,
    DOOR_ACCESS_ORG_ID: ORG,
    DOOR_ACCESS_MODE: "all",
    SUPABASE_URL: SUPABASE,
    SUPABASE_ANON_KEY: ANON_FAKE,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_FAKE,
    ...k.env,
  };
  const calls: GoiSupabase[] = [];
  const rpcMacDinh: Record<string, KichRpc> = {
    door_access_authorize_v1: { body: ctxMau() },
    door_access_can_manage_org_v1: { body: true },
    door_access_devices_v1: { body: { devices: [] } },
    door_access_begin_action_v1: { body: { ...ctxMau(), log_id: LOG } },
    door_access_finish_action_v1: { body: { id: LOG } },
  };
  const j = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(SUPABASE)) {
      if (k.tuyaFetch) return await k.tuyaFetch(url, init ?? {});
      throw new Error(`fetch lạ: ${url}`);
    }
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const ten = url.endsWith("/auth/v1/user") ? "auth" : url.slice(`${SUPABASE}/rest/v1/rpc/`.length);
    calls.push({ url, ten, headers, body });
    if (ten === "auth") {
      if (k.authNetwork) throw new TypeError("network");
      if (k.authStatus) return j(k.authStatus, { msg: "boom" });
      return k.user === null ? j(401, { msg: "invalid JWT" }) : j(200, { id: k.user ?? USER });
    }
    assert.ok(url.startsWith(`${SUPABASE}/rest/v1/rpc/`), url);
    assert.equal(init?.method, "POST");
    const kich = k.rpc && Object.hasOwn(k.rpc, ten) ? k.rpc[ten] : rpcMacDinh[ten];
    if (!kich) return j(404, { code: "PGRST202", message: `không có hàm ${ten}` });
    const tra = typeof kich === "function" ? kich(body ?? {}) : kich;
    if (tra === "network") throw new TypeError("network");
    return j(tra.status ?? 200, tra.body);
  }) as typeof fetch;
  const tuya = k.tuya ?? new TuyaGia();
  const configs: TuyaConfig[] = [];
  const deps: PhuThuoc = {
    getEnv: (key) => env[key],
    fetchImpl,
    now: () => NOW,
    ...(k.fakeTuya === false ? {} : {
      tuya: (config: TuyaConfig) => {
        configs.push(config);
        return tuya;
      },
    }),
    ...(k.randomPassword ? { randomPassword: k.randomPassword } : {}),
  };
  const rpc = (ten: string) => calls.filter((c) => c.ten === ten);
  return { deps, calls, tuya, configs, rpc, rpcNames: () => calls.filter((c) => c.ten !== "auth").map((c) => c.ten) };
}

const yeuCau = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_HAM, {
    method: "POST",
    headers: { Authorization: `Bearer ${USER_JWT}`, "x-organization-id": ORG, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

interface TraVe {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; tuyaCode?: number | string; outcomeUnknown?: boolean; logPending?: boolean };
}
const docTra = async (r: Response) => (await r.json()) as TraVe;

/** Gọi hàm và gom mọi dòng console (để kiểm không lộ mật khẩu/khoá và giữ log test gọn). */
async function goi(req: Request, deps: PhuThuoc): Promise<{ r: Response; tra: TraVe; log: string[] }> {
  const log: string[] = [];
  const goc = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug };
  const ghi = (...args: unknown[]) => {
    log.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  Object.assign(console, { error: ghi, warn: ghi, log: ghi, info: ghi, debug: ghi });
  try {
    const r = await xuLy(req, deps);
    const tra = r.status === 204 ? { ok: true } : await docTra(r.clone());
    return { r, tra, log };
  } finally {
    Object.assign(console, goc);
  }
}

/** Mã lỗi + đúng HTTP theo bảng của hợp đồng. */
function loiLa(res: { r: Response; tra: TraVe }, code: string) {
  assert.equal(res.tra.ok, false, JSON.stringify(res.tra));
  assert.equal(res.tra.error?.code, code, JSON.stringify(res.tra));
  assert.equal(res.r.status, HTTP_THEO_MA[code as keyof typeof HTTP_THEO_MA], `HTTP của ${code}`);
  assert.equal(res.r.headers.get("Cache-Control"), "no-store");
}

/** Lời gọi RPC bằng JWT người dùng / bằng service role. */
function laJwtNguoiDung(c: GoiSupabase) {
  assert.equal(c.headers.get("Authorization"), `Bearer ${USER_JWT}`, c.ten);
  assert.equal(c.headers.get("apikey"), ANON_FAKE, c.ten);
  assert.equal(c.headers.get("Content-Profile"), "public", c.ten);
  assert.equal(c.headers.get("Content-Type"), "application/json", c.ten);
}
function laServiceRole(c: GoiSupabase) {
  assert.equal(c.headers.get("Authorization"), `Bearer ${SERVICE_FAKE}`, c.ten);
  assert.equal(c.headers.get("apikey"), SERVICE_FAKE, c.ten);
  assert.equal(c.headers.get("Content-Profile"), "public", c.ten);
}

const finishArgs = (status: string, extra: Record<string, unknown> = {}) => ({
  p_log_id: LOG,
  p_status: status,
  p_tuya_password_id: null,
  p_error_code: null,
  p_error_message: null,
  ...extra,
});

// ---------------------------------------------------------------------------------------------------
// Vỏ: CORS, phương thức, thân

Deno.test("OPTIONS ⇒ 204 + CORS có x-organization-id, no-store; không gọi gì", async () => {
  const { deps, calls, configs } = setup();
  const r = await xuLy(new Request(URL_HAM, { method: "OPTIONS" }), deps);
  assert.equal(r.status, 204);
  assert.match(r.headers.get("Access-Control-Allow-Headers") ?? "", /x-organization-id/);
  assert.match(r.headers.get("Access-Control-Allow-Headers") ?? "", /authorization/);
  assert.equal(r.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(calls.length, 0);
  assert.equal(configs.length, 0);
});

Deno.test("phương thức khác POST ⇒ 405 method_not_allowed + Allow; không gọi gì", async () => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    const { deps, calls } = setup();
    const res = await goi(new Request(URL_HAM, { method, headers: { Authorization: `Bearer ${USER_JWT}` } }), deps);
    loiLa(res, "method_not_allowed");
    assert.equal(res.r.headers.get("Allow"), "POST, OPTIONS");
    assert.equal(res.r.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(calls.length, 0);
  }
});

Deno.test("thân sai ⇒ 400 invalid_request trước mọi lời gọi (JSON hỏng, không object, thiếu action, quá 16 KB, UTF-8 hỏng)", async () => {
  const cases: Array<BodyInit> = [
    "{",
    "[]",
    "null",
    '"status"',
    "{}",
    JSON.stringify({ action: 1 }),
    JSON.stringify({ action: "status", pad: "x".repeat(17_000) }),
    new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
  ];
  for (const body of cases) {
    const { deps, calls } = setup();
    const req = new Request(URL_HAM, { method: "POST", headers: { Authorization: `Bearer ${USER_JWT}`, "x-organization-id": ORG }, body });
    const res = await goi(req, deps);
    loiLa(res, "invalid_request");
    assert.equal(calls.length, 0);
  }
  // Khai content-length vượt trần ⇒ chặn trước khi đọc.
  const { deps, calls } = setup();
  const res = await goi(yeuCau({ action: "status" }, { "content-length": String(20_000) }), deps);
  loiLa(res, "invalid_request");
  assert.equal(calls.length, 0);
});

Deno.test("action lạ ⇒ 400 invalid_request, không gọi gì (kể cả tên thuộc tính của Object)", async () => {
  for (const action of ["open_all_doors", "__proto__", "toString", "constructor", "STATUS", ""]) {
    const { deps, calls } = setup();
    const res = await goi(yeuCau({ action }), deps);
    loiLa(res, "invalid_request");
    assert.equal(calls.length, 0, action);
  }
});

// ---------------------------------------------------------------------------------------------------
// status, cấu hình, phiên, công ty, công tắc

Deno.test("docCheDo: vắng/trống ⇒ read; off/read/all đúng chữ; giá trị lạ ⇒ off", () => {
  assert.equal(docCheDo(undefined), "read");
  assert.equal(docCheDo(""), "read");
  assert.equal(docCheDo("  "), "read");
  assert.equal(docCheDo("off"), "off");
  assert.equal(docCheDo("read"), "read");
  assert.equal(docCheDo(" all "), "all");
  for (const v of ["ALL", "Read", "yes", "true", "1", "pilot"]) assert.equal(docCheDo(v), "off", v);
});

Deno.test("docCauHinh: khoá Tuya đủ + secret đúng 32 byte + base URL trong danh sách; org id chuẩn chữ thường", () => {
  const env = (over: Record<string, string | undefined>) => (k: string) =>
    ({ TUYA_ACCESS_ID: ACCESS_ID_FAKE, TUYA_ACCESS_SECRET: SECRET_FAKE, TUYA_BASE_URL: BASE, DOOR_ACCESS_ORG_ID: ORG, ...over })[k];
  assert.deepEqual(docCauHinh(env({})), {
    tuya: { baseUrl: BASE, accessId: ACCESS_ID_FAKE, accessSecret: SECRET_FAKE },
    orgId: ORG,
    cheDo: "read",
  });
  assert.equal(docCauHinh(env({ TUYA_BASE_URL: `${BASE}/` })).tuya?.baseUrl, BASE);
  assert.equal(docCauHinh(env({ DOOR_ACCESS_ORG_ID: ORG.toUpperCase() })).orgId, ORG);
  for (
    const over of [
      { TUYA_ACCESS_ID: undefined },
      { TUYA_ACCESS_ID: "id có dấu cách" },
      { TUYA_ACCESS_SECRET: undefined },
      { TUYA_ACCESS_SECRET: SECRET_FAKE.slice(1) },
      { TUYA_ACCESS_SECRET: `${SECRET_FAKE}x` },
      { TUYA_BASE_URL: undefined },
      { TUYA_BASE_URL: "http://openapi.tuyaus.com" },
      { TUYA_BASE_URL: "https://openapi.tuyaus.com.evil.example" },
      { TUYA_BASE_URL: "https://user:pw@openapi.tuyaus.com" },
    ]
  ) {
    assert.equal(docCauHinh(env(over)).tuya, null, JSON.stringify(over));
  }
  assert.equal(docCauHinh(env({ DOOR_ACCESS_ORG_ID: "khong-phai-uuid" })).orgId, null);
});

Deno.test("status: cần phiên, KHÔNG cần khoá Tuya, không dựng client Tuya; configured/connectedOrg/mode", async () => {
  const chay = async (k: Kich, headers: Record<string, string> = {}) => {
    const s = setup(k);
    const res = await goi(yeuCau({ action: "status" }, headers), s.deps);
    return { ...s, res };
  };
  let o = await chay({});
  assert.equal(o.res.r.status, 200);
  assert.deepEqual(o.res.tra, { ok: true, data: { configured: true, connectedOrg: true, mode: "all" } });
  assert.equal(o.res.r.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(o.calls.map((c) => c.ten), ["auth"]);
  assert.equal(o.configs.length, 0);
  assert.equal(o.tuya.calls.length, 0);

  o = await chay({ env: { TUYA_ACCESS_ID: undefined, TUYA_ACCESS_SECRET: undefined, TUYA_BASE_URL: undefined, DOOR_ACCESS_MODE: undefined } });
  assert.deepEqual(o.res.tra.data, { configured: false, connectedOrg: true, mode: "read" });
  o = await chay({}, { "x-organization-id": ORG_KHAC });
  assert.deepEqual(o.res.tra.data, { configured: true, connectedOrg: false, mode: "all" });
  o = await chay({ env: { DOOR_ACCESS_ORG_ID: undefined } });
  assert.deepEqual(o.res.tra.data, { configured: false, connectedOrg: false, mode: "all" });
  o = await chay({ env: { DOOR_ACCESS_ORG_ID: ORG.toUpperCase(), DOOR_ACCESS_MODE: "lung tung" } }, { "x-organization-id": ORG.toUpperCase() });
  assert.deepEqual(o.res.tra.data, { configured: true, connectedOrg: true, mode: "off" });

  // Vẫn cần phiên và công ty.
  const noToken = setup();
  loiLa(await goi(yeuCau({ action: "status" }, { Authorization: "" }), noToken.deps), "unauthorized");
  assert.equal(noToken.calls.length, 0);
  loiLa((await chay({ user: null })).res, "unauthorized");
  loiLa((await chay({}, { "x-organization-id": "" })).res, "organization_required");
});

Deno.test("phiên: thiếu JWT ⇒ 401 không gọi Auth; JWT hỏng ⇒ 401; Auth sập/429 ⇒ 500 internal — không RPC, không Tuya", async () => {
  const a = setup();
  loiLa(await goi(yeuCau(THAN_HOP_LE.records, { Authorization: "" }), a.deps), "unauthorized");
  loiLa(await goi(yeuCau(THAN_HOP_LE.records, { Authorization: "Bearer   " }), a.deps), "unauthorized");
  loiLa(await goi(yeuCau(THAN_HOP_LE.records, { Authorization: USER_JWT }), a.deps), "unauthorized");
  loiLa(await goi(yeuCau(THAN_HOP_LE.records, { Authorization: `Basic ${USER_JWT}` }), a.deps), "unauthorized");
  assert.equal(a.calls.length, 0);

  const b = setup({ user: null });
  loiLa(await goi(yeuCau(THAN_HOP_LE.records), b.deps), "unauthorized");
  assert.deepEqual(b.calls.map((c) => c.ten), ["auth"]);
  assert.equal(b.calls[0].headers.get("Authorization"), `Bearer ${USER_JWT}`);
  assert.equal(b.calls[0].headers.get("apikey"), ANON_FAKE);
  assert.equal(b.tuya.calls.length, 0);

  for (const k of [{ authStatus: 500 }, { authStatus: 429 }, { authNetwork: true }] as Kich[]) {
    const c = setup(k);
    loiLa(await goi(yeuCau(THAN_HOP_LE.remote_unlock), c.deps), "internal");
    assert.deepEqual(c.calls.map((x) => x.ten), ["auth"]);
  }
  // Thiếu anon key ⇒ apikey dùng service key (như quick-entry).
  const d = setup({ env: { SUPABASE_ANON_KEY: undefined } });
  assert.equal((await goi(yeuCau({ action: "status" }), d.deps)).r.status, 200);
  assert.equal(d.calls[0].headers.get("apikey"), SERVICE_FAKE);
  // Thiếu SUPABASE_URL ⇒ 500, không gọi gì.
  const e = setup({ env: { SUPABASE_URL: undefined } });
  loiLa(await goi(yeuCau({ action: "status" }), e.deps), "internal");
  assert.equal(e.calls.length, 0);
});

Deno.test("công ty: thiếu/sai header ⇒ organization_required; khác DOOR_ACCESS_ORG_ID ⇒ org_not_connected — không RPC, không Tuya", async () => {
  for (const org of ["", "khong-phai-uuid", `${ORG}x`]) {
    const s = setup();
    loiLa(await goi(yeuCau(THAN_HOP_LE.keys, { "x-organization-id": org }), s.deps), "organization_required");
    assert.deepEqual(s.calls.map((c) => c.ten), ["auth"]);
  }
  for (const action of [...HANH_DONG_DOC, ...HANH_DONG_GHI]) {
    const s = setup();
    loiLa(await goi(yeuCau(THAN_HOP_LE[action], { "x-organization-id": ORG_KHAC }), s.deps), "org_not_connected");
    assert.deepEqual(s.calls.map((c) => c.ten), ["auth"], action);
    assert.equal(s.tuya.calls.length, 0);
  }
  // Header chữ hoa vẫn là đúng công ty (chuẩn hoá chữ thường).
  const s = setup();
  assert.equal((await goi(yeuCau(THAN_HOP_LE.keys, { "x-organization-id": ORG.toUpperCase() }), s.deps)).r.status, 504);
  assert.equal(s.rpc("door_access_authorize_v1")[0].body?.p_organization_id, ORG);
});

Deno.test("chưa cấu hình ⇒ 503 not_configured cho mọi hành động trừ status — trước cả Auth", async () => {
  const thieu: Array<Record<string, string | undefined>> = [
    { TUYA_ACCESS_ID: undefined },
    { TUYA_ACCESS_SECRET: undefined },
    { TUYA_ACCESS_SECRET: "fake-secret-qua-ngan" },
    { TUYA_BASE_URL: undefined },
    { TUYA_BASE_URL: "https://evil.example.com" },
    { DOOR_ACCESS_ORG_ID: undefined },
    { DOOR_ACCESS_ORG_ID: "khong-phai-uuid" },
  ];
  for (const env of thieu) {
    for (const action of [...HANH_DONG_DOC, ...HANH_DONG_GHI]) {
      const s = setup({ env });
      const res = await goi(yeuCau(THAN_HOP_LE[action]), s.deps);
      loiLa(res, "not_configured");
      assert.equal(s.calls.length, 0, `${action} ${JSON.stringify(env)}`);
      assert.equal(s.configs.length, 0);
    }
  }
});

Deno.test("DOOR_ACCESS_MODE=off (hoặc giá trị lạ) ⇒ mode_off cho mọi hành động trừ status; không RPC, không Tuya", async () => {
  for (const mode of ["off", "lung tung", "ALL"]) {
    for (const action of [...HANH_DONG_DOC, ...HANH_DONG_GHI]) {
      const s = setup({ env: { DOOR_ACCESS_MODE: mode } });
      loiLa(await goi(yeuCau(THAN_HOP_LE[action]), s.deps), "mode_off");
      assert.deepEqual(s.calls.map((c) => c.ten), ["auth"], `${mode} ${action}`);
      assert.equal(s.tuya.calls.length, 0);
    }
    const s = setup({ env: { DOOR_ACCESS_MODE: mode } });
    assert.deepEqual((await goi(yeuCau({ action: "status" }), s.deps)).tra.data, { configured: true, connectedOrg: true, mode: "off" });
  }
});

Deno.test("chế độ read (mặc định) ⇒ 4 thao tác ghi bị writes_disabled, không begin, không Tuya; hành động đọc vẫn chạy", async () => {
  for (const mode of [undefined, "", "read"]) {
    for (const action of HANH_DONG_GHI) {
      const s = setup({ env: { DOOR_ACCESS_MODE: mode } });
      loiLa(await goi(yeuCau(THAN_HOP_LE[action]), s.deps), "writes_disabled");
      assert.deepEqual(s.calls.map((c) => c.ten), ["auth"], `${mode} ${action}`);
      assert.equal(s.tuya.calls.length, 0);
    }
  }
  const tuya = new TuyaGia([[P.records, () => ({ records: [], total: 0, has_more: false })]]);
  const s = setup({ env: { DOOR_ACCESS_MODE: undefined }, tuya });
  const res = await goi(yeuCau(THAN_HOP_LE.records), s.deps);
  assert.equal(res.r.status, 200);
  assert.deepEqual(res.tra.data, { records: [], total: 0, hasMore: false });
});

Deno.test("thao tác ghi khi thiếu SUPABASE_SERVICE_ROLE_KEY ⇒ 500, không begin (không chốt được nhật ký thì không gửi lệnh)", async () => {
  const s = setup({ env: { SUPABASE_SERVICE_ROLE_KEY: undefined } });
  loiLa(await goi(yeuCau(THAN_HOP_LE.remote_unlock), s.deps), "internal");
  assert.deepEqual(s.rpcNames(), []);
  assert.equal(s.tuya.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------------
// Lỗi PostgREST

Deno.test("lỗi PostgREST ⇒ mã hợp đồng; chỉ 22023/23505/54000/55000 chuyển câu của SQL (≤ 200 ký tự)", async () => {
  const pg = (code: string, message: string, status = 400): TraRpc => ({ status, body: { code, message, details: null, hint: null } });
  const cases: Array<[string, TraRpc, string, string | null]> = [
    ["door_access_authorize_v1", pg("42501", "máy d0d0… không thuộc công ty", 403), "not_permitted", null],
    ["door_access_begin_action_v1", pg("42501", "thiếu quyền door_access.remote_unlock", 403), "not_permitted", null],
    ["door_access_begin_action_v1", pg("22023", "Tên mật khẩu tạm quá dài"), "invalid_request", "Tên mật khẩu tạm quá dài"],
    ["door_access_begin_action_v1", pg("23505", "Máy đã thuộc công ty khác", 409), "conflict", "Máy đã thuộc công ty khác"],
    ["door_access_begin_action_v1", pg("55000", "Máy đã tắt"), "conflict", "Máy đã tắt"],
    ["door_access_begin_action_v1", pg("54000", "Mở cửa quá 10 lần trong 10 phút"), "rate_limited", "Mở cửa quá 10 lần trong 10 phút"],
    ["door_access_begin_action_v1", pg("PGRST202", "Could not find the function", 404), "internal", null],
    ["door_access_begin_action_v1", pg("P0001", "lỗi nội bộ có chi tiết", 400), "internal", null],
    ["door_access_begin_action_v1", { status: 401, body: { code: "PGRST301", message: "JWT expired" } }, "unauthorized", null],
    ["door_access_begin_action_v1", "network", "internal", null],
    ["door_access_begin_action_v1", { status: 500, body: "không phải json" }, "internal", null],
  ];
  for (const [ten, tra, code, message] of cases) {
    const action = ten === "door_access_authorize_v1" ? "records" : "remote_unlock";
    const s = setup({ rpc: { [ten]: tra } });
    const res = await goi(yeuCau(THAN_HOP_LE[action]), s.deps);
    loiLa(res, code);
    if (message !== null) assert.equal(res.tra.error?.message, message);
    if (typeof tra !== "string" && code !== "invalid_request" && message === null) {
      assert.ok(!res.tra.error?.message.includes(String((tra.body as { message?: string }).message)), "không lộ câu SQL");
    }
    assert.equal(s.tuya.calls.length, 0, `${ten} ${code}`);
    assert.equal(s.rpc("door_access_finish_action_v1").length, 0, "lỗi ở begin ⇒ chưa có gì để chốt");
  }
  // Câu dài bị cắt ở 200 ký tự (theo code point).
  const dai = "Đ".repeat(150) + "😀".repeat(100);
  const s = setup({ rpc: { door_access_begin_action_v1: pg("54000", dai) } });
  const res = await goi(yeuCau(THAN_HOP_LE.remote_unlock), s.deps);
  loiLa(res, "rate_limited");
  assert.equal(Array.from(res.tra.error?.message ?? "").length, 200);
  assert.equal(res.tra.error?.message, Array.from(dai).slice(0, 200).join(""));
});

// ---------------------------------------------------------------------------------------------------
// Hành động đọc

Deno.test("records: authorize (JWT người dùng, quyền xem) ⇒ listRecords đúng máy/khung giờ/trang; data đúng dạng", async () => {
  const tuya = new TuyaGia([[P.records, () => ({
    records: [{
      record_id: "r1",
      gmt_create: NOW - 60_000,
      record_type: "unlock",
      dps: [{ unlock_fingerprint: 3 }],
      user_id: "u1",
      user_name: "Khách A",
      unlock_name: "Ngón trỏ",
    }],
    total: 1,
    has_more: false,
  })]]);
  const s = setup({ tuya });
  const res = await goi(yeuCau({ ...THAN_HOP_LE.records, pageNo: 2, pageSize: 10, extra: "bỏ qua" }), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.deepEqual(res.tra, {
    ok: true,
    data: {
      records: [{
        id: "r1",
        at: NOW - 60_000,
        kind: "unlock",
        method: "fingerprint",
        methodCode: "unlock_fingerprint",
        slot: 3,
        userId: "u1",
        userName: "Khách A",
        unlockName: "Ngón trỏ",
      }],
      total: 1,
      hasMore: false,
    },
  });
  assert.deepEqual(s.rpcNames(), ["door_access_authorize_v1"]);
  const auth = s.rpc("door_access_authorize_v1")[0];
  laJwtNguoiDung(auth);
  assert.deepEqual(auth.body, { p_organization_id: ORG, p_device_id: DEVICE, p_permission: "door_access.view" });
  assert.deepEqual(s.configs, [{ baseUrl: BASE, accessId: ACCESS_ID_FAKE, accessSecret: SECRET_FAKE }]);
  assert.equal(tuya.calls.length, 1);
  assert.equal(tuya.calls[0].query?.start_time, NOW - NGAY_MS);
  assert.equal(tuya.calls[0].query?.end_time, NOW);
  assert.equal(tuya.calls[0].query?.page_no, 2);
  assert.equal(tuya.calls[0].query?.page_size, 10);

  // Khoá Wi-Fi đọc open-logs; mặc định trang 1, 20 dòng.
  const wifi = new TuyaGia([[P.openLogs, () => ({ logs: [], total: 0 })]]);
  const w = setup({ tuya: wifi, rpc: { door_access_authorize_v1: { body: ctxMau({ device_kind: "wifi_lock" }) } } });
  assert.equal((await goi(yeuCau(THAN_HOP_LE.records), w.deps)).r.status, 200);
  assert.equal(wifi.calls[0].query?.page_no, 1);
  assert.equal(wifi.calls[0].query?.page_size, 20);
});

Deno.test("records: khung giờ > 31 ngày, endMs ≤ startMs, pageSize ngoài 1–50, pageNo < 1, sai kiểu ⇒ 400 trước RPC", async () => {
  const sai: Array<Record<string, unknown>> = [
    { startMs: NOW - 31 * NGAY_MS - 1, endMs: NOW },
    { startMs: NOW, endMs: NOW },
    { startMs: NOW, endMs: NOW - 1 },
    { pageSize: 51 },
    { pageSize: 0 },
    { pageSize: 2.5 },
    { pageNo: 0 },
    { pageNo: "1" },
    { startMs: String(NOW - 1000) },
    { startMs: Math.floor((NOW - 1000) / 1000), endMs: Math.floor(NOW / 1000) },
    { deviceId: "khong-phai-uuid" },
    { deviceId: undefined },
  ];
  for (const patch of sai) {
    const s = setup();
    const res = await goi(yeuCau({ ...THAN_HOP_LE.records, ...patch }), s.deps);
    loiLa(res, "invalid_request");
    assert.deepEqual(s.rpcNames(), [], JSON.stringify(patch));
    assert.equal(s.tuya.calls.length, 0);
  }
  // Đúng 31 ngày và 50 dòng/trang là hợp lệ.
  const tuya = new TuyaGia([[P.records, () => ({ records: [], total: 0, has_more: false })]]);
  const s = setup({ tuya });
  const res = await goi(yeuCau({ ...THAN_HOP_LE.records, startMs: NOW - 31 * NGAY_MS, endMs: NOW, pageSize: 50 }), s.deps);
  assert.equal(res.r.status, 200);
});

Deno.test("đọc: Tuya từ chối ⇒ 502 + tuyaCode; mạng/hết giờ/HTTP/kết quả lạ ⇒ 504 (không outcomeUnknown); TuyaInputError ⇒ 400", async () => {
  const cases: Array<[() => unknown, string, number | string | undefined]> = [
    [() => {
      throw new TuyaError(1106, "permission deny", "/x", true);
    }, "tuya_rejected", 1106],
    [() => {
      throw new TypeError("network");
    }, "tuya_unavailable", undefined],
    [() => {
      throw new DOMException("hết giờ", "TimeoutError");
    }, "tuya_unavailable", undefined],
    [() => {
      throw new TuyaError("http_502", "HTTP 502", "/x");
    }, "tuya_unavailable", undefined],
    [() => ({ khong: "co records" }), "tuya_unavailable", undefined],
    [() => {
      throw new TuyaInputError("deviceId không hợp lệ");
    }, "invalid_request", undefined],
  ];
  for (const [reply, code, tuyaCode] of cases) {
    const tuya = new TuyaGia([[P.records, reply]]);
    const s = setup({ tuya });
    const res = await goi(yeuCau(THAN_HOP_LE.records), s.deps);
    loiLa(res, code);
    assert.equal(res.tra.error?.tuyaCode, tuyaCode);
    assert.equal(res.tra.error?.outcomeUnknown, undefined);
    assert.equal(tuya.calls.length, 1, "đọc cũng không tự gửi lại");
  }
});

Deno.test("temp_passwords: authorize quyền mật khẩu tạm ⇒ danh sách đúng dạng", async () => {
  const tuya = new TuyaGia([[P.tempList, () => ({
    records: [{ id: 11, name: "Khách xem phòng", phase: 2, effective_time: NOW_SEC, invalid_time: NOW_SEC + 3600, delivery_status: 1 }],
    has_more: false,
  })]]);
  const s = setup({ tuya });
  const res = await goi(yeuCau(THAN_HOP_LE.temp_passwords), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.deepEqual(res.tra.data, {
    passwords: [{ id: 11, name: "Khách xem phòng", phase: 2, effectiveSec: NOW_SEC, invalidSec: NOW_SEC + 3600, deliveryStatus: 1 }],
    hasMore: false,
  });
  const auth = s.rpc("door_access_authorize_v1")[0];
  laJwtNguoiDung(auth);
  assert.deepEqual(auth.body, { p_organization_id: ORG, p_device_id: DEVICE, p_permission: "door_access.temp_password" });
});

Deno.test("authorize trả ngữ cảnh sai dạng hoặc của máy KHÁC ⇒ 500, không gọi Tuya", async () => {
  for (
    const ctx of [
      ctxMau({ device_id: DEVICE_KHAC }),
      ctxMau({ tuya_device_id: "../khac" }),
      ctxMau({ device_kind: "smoke_sensor" }),
      ctxMau({ channel_id: 0 }),
      ctxMau({ password_length: 5 }),
      null,
      [ctxMau()],
    ]
  ) {
    const s = setup({ rpc: { door_access_authorize_v1: { body: ctx } } });
    loiLa(await goi(yeuCau(THAN_HOP_LE.keys), s.deps), "internal");
    assert.equal(s.tuya.calls.length, 0, JSON.stringify(ctx));
  }
});

Deno.test("keys access_control: gộp người dùng + cách mở + số chưa gán; partial=false khi đọc hết", async () => {
  const tuya = new TuyaGia([
    [P.usersAc, (call) =>
      call.query?.page_no === 1
        ? {
          records: [
            { user_id: "uA", nick_name: "Chủ nhà", user_type: 50 },
            { user_id: "uB", nick_name: "Khách B", user_type: 20 },
          ],
          has_more: true,
        }
        : { records: [{ user_id: "uB", nick_name: "Khách B", user_type: 20 }, { user_id: "uC", user_type: 10 }], has_more: false }],
    [/^GET \/v1\.0\/smart-lock\/devices\/vdevo00000000000000001\/opmodes\//, (call) => ({
      records: call.path.endsWith("/uA")
        ? [{ dp_code: "unlock_fingerprint", unlock_sn: 1, unlock_name: "Ngón cái", opmode_id: 9 }, { dp_code: "unlock_card", unlock_sn: 2 }]
        : [],
    })],
    [P.unassigned, () => ({ unlock_keys: [{ unlock_type: "fingerprint", unlock_no: 7 }] })],
  ]);
  const s = setup({ tuya });
  const res = await goi(yeuCau(THAN_HOP_LE.keys), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.deepEqual(res.tra.data, {
    users: [
      {
        userId: "uA",
        name: "Chủ nhà",
        role: "owner",
        userType: 50,
        methods: [
          { method: "fingerprint", methodCode: "unlock_fingerprint", sn: 1, name: "Ngón cái" },
          { method: "card", methodCode: "unlock_card", sn: 2, name: null },
        ],
      },
      { userId: "uB", name: "Khách B", role: "member", userType: 20, methods: [] },
      { userId: "uC", name: null, role: "admin", userType: 10, methods: [] },
    ],
    unassigned: [{ method: "fingerprint", methodCode: "fingerprint", sn: 7 }],
    partial: false,
  });
  assert.deepEqual(tuya.goiToi(P.usersAc).map((c) => [c.query?.page_no, c.query?.page_size]), [[1, 50], [2, 50]]);
  // uB trùng ở hai trang ⇒ chỉ đọc cách mở một lần.
  assert.deepEqual(tuya.calls.filter((c) => c.path.includes("/opmodes/")).map((c) => c.path.split("/").at(-1)), ["uA", "uB", "uC"]);
  assert.deepEqual(s.rpc("door_access_authorize_v1")[0].body, { p_organization_id: ORG, p_device_id: DEVICE, p_permission: "door_access.view" });
});

Deno.test("keys: chạm 5 trang ⇒ partial=true; cách mở đọc tối đa 4 người cùng lúc", async () => {
  let page = 0;
  const tuya = new TuyaGia([
    [P.usersAc, () => {
      page++;
      return { records: [{ user_id: `u${page}a` }, { user_id: `u${page}b` }], has_more: true };
    }],
    [/opmodes\//, async () => {
      await new Promise((r) => setTimeout(r, 2));
      return { records: [{ dp_code: "unlock_fingerprint", unlock_sn: 1 }] };
    }],
    [P.unassigned, () => ({ unlock_keys: [] })],
  ]);
  const s = setup({ tuya });
  const res = await goi(yeuCau(THAN_HOP_LE.keys), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.equal(tuya.goiToi(P.usersAc).length, 5, "dừng ở trang 5");
  assert.equal(res.tra.data?.partial, true);
  const users = res.tra.data?.users as Array<{ methods: unknown[] }>;
  assert.equal(users.length, 10);
  assert.ok(users.every((u) => u.methods.length === 1));
  assert.equal(tuya.calls.filter((c) => c.path.includes("/opmodes/")).length, 10);
  assert.equal(tuya.maxInFlight, 4, `tối đa 4 lời gọi cùng lúc (đo ${tuya.maxInFlight})`);
});

Deno.test("keys: một người đọc cách mở hỏng ⇒ cả hành động hỏng (không lặng lẽ bỏ người); người thiếu userId ⇒ partial", async () => {
  const hong = new TuyaGia([
    [P.usersAc, () => ({ records: [{ user_id: "uA" }, { user_id: "uB" }, { user_id: "uC" }], has_more: false })],
    [methodsOf("uB"), () => {
      throw new TuyaError(1106, "permission deny", "/opmodes", true);
    }],
    [/opmodes\//, () => ({ records: [] })],
    [P.unassigned, () => ({ unlock_keys: [] })],
  ]);
  const s = setup({ tuya: hong });
  const res = await goi(yeuCau(THAN_HOP_LE.keys), s.deps);
  loiLa(res, "tuya_rejected");
  assert.equal(res.tra.error?.tuyaCode, 1106);

  const thieu = new TuyaGia([
    [P.usersAc, () => ({ records: [{ nick_name: "Không id" }, { user_id: "uA" }], has_more: false })],
    [/opmodes\//, () => ({ records: [] })],
    [P.unassigned, () => ({ unlock_keys: [] })],
  ]);
  const t = setup({ tuya: thieu });
  const ok = await goi(yeuCau(THAN_HOP_LE.keys), t.deps);
  assert.equal(ok.r.status, 200);
  assert.equal(ok.tra.data?.partial, true);
  assert.equal(thieu.calls.filter((c) => c.path.includes("/opmodes/")).length, 1);
});

Deno.test("keys wifi_lock: người dùng v1.0 không lật trang, không đọc cách mở, partial=true", async () => {
  const tuya = new TuyaGia([
    [P.usersWifi, () => [{ user_id: "w1", nick_name: "Chủ", user_type: 50 }]],
    [P.unassigned, () => ({ unlock_keys: [{ unlock_type: "card", unlock_no: 4 }] })],
  ]);
  const s = setup({ tuya, rpc: { door_access_authorize_v1: { body: ctxMau({ device_kind: "wifi_lock", channel_id: null }) } } });
  const res = await goi(yeuCau(THAN_HOP_LE.keys), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.deepEqual(res.tra.data, {
    users: [{ userId: "w1", name: "Chủ", role: "owner", userType: 50, methods: [] }],
    unassigned: [{ method: "card", methodCode: "card", sn: 4 }],
    partial: true,
  });
  assert.equal(tuya.calls.length, 2);
});

Deno.test("discover: cần can_manage_org (Quản lý ở MỌI toà); gắn registered theo tuya_device_id; trả MỌI máy kể cả kind null", async () => {
  const thietBi = [
    { id: TUYA_DEV, name: "Cổng chính", category: "mk", productName: "Máy kiểm soát", isOnline: true },
    { id: "vdevo00000000000000002", customName: "Khoá phòng 101", category: "jtmspro", isOnline: false },
    { id: "vdevo00000000000000003", name: "Báo khói", category: "ywbj", isOnline: true },
  ];
  const tuya = new TuyaGia([[P.devices, () => thietBi]]);
  const s = setup({
    tuya,
    rpc: {
      door_access_devices_v1: {
        body: { devices: [{ id: DEVICE, building_id: BUILDING, tuya_device_id: TUYA_DEV, is_active: false }] },
      },
    },
  });
  const res = await goi(yeuCau({ action: "discover" }), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.deepEqual(res.tra.data, {
    devices: [
      {
        tuyaDeviceId: TUYA_DEV,
        name: "Cổng chính",
        category: "mk",
        productName: "Máy kiểm soát",
        online: true,
        kind: "access_control",
        registered: { deviceId: DEVICE, buildingId: BUILDING },
      },
      {
        tuyaDeviceId: "vdevo00000000000000002",
        name: "Khoá phòng 101",
        category: "jtmspro",
        productName: null,
        online: false,
        kind: "wifi_lock",
        registered: null,
      },
      // Category chưa nhận ra vẫn được trả (kind null) — trang ẩn sau công tắc; mã category thật chưa kiểm trên máy thật.
      {
        tuyaDeviceId: "vdevo00000000000000003",
        name: "Báo khói",
        category: "ywbj",
        productName: null,
        online: true,
        kind: null,
        registered: null,
      },
    ],
    hasMore: false,
  });
  assert.deepEqual(s.rpcNames(), ["door_access_can_manage_org_v1", "door_access_devices_v1"]);
  const [canManage, devices] = [s.rpc("door_access_can_manage_org_v1")[0], s.rpc("door_access_devices_v1")[0]];
  laJwtNguoiDung(canManage);
  laJwtNguoiDung(devices);
  assert.deepEqual(canManage.body, { p_organization_id: ORG });
  assert.deepEqual(devices.body, { p_organization_id: ORG, p_include_inactive: true });
  assert.equal(tuya.calls[0].query?.page_size, 20);

  // can_manage_org không đúng true (false, object, chuỗi, số, null, lỗi quyền) ⇒ 403, không đọc máy, không gọi Tuya.
  for (
    const tra of [
      { body: false },
      { body: { allowed: true } },
      { body: "true" },
      { body: 1 },
      { body: null },
      { status: 403, body: { code: "42501", message: "x" } },
    ]
  ) {
    const t = setup({ rpc: { door_access_can_manage_org_v1: tra } });
    loiLa(await goi(yeuCau({ action: "discover" }), t.deps), "not_permitted");
    assert.deepEqual(t.rpcNames(), ["door_access_can_manage_org_v1"], JSON.stringify(tra));
    assert.equal(t.tuya.calls.length, 0);
  }
  // devices_v1 sai dạng ⇒ 500 (không coi là "chưa gắn máy nào").
  const u = setup({ rpc: { door_access_devices_v1: { body: { khong: [] } } } });
  loiLa(await goi(yeuCau({ action: "discover" }), u.deps), "internal");
  assert.equal(u.tuya.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------------
// Thao tác ghi

Deno.test("create_temp_password: begin (JWT, không mật khẩu) ⇒ vé + tạo ⇒ finish OK (service role) + id; mật khẩu trả ĐÚNG một lần", async () => {
  const { tuya, sent } = tuyaTaoMatKhau();
  const s = setup({ tuya, rpc: { door_access_begin_action_v1: { body: { ...ctxMau({ password_length: 8 }), log_id: LOG } } } });
  const res = await goi(yeuCau({ ...THAN_HOP_LE.create_temp_password, name: "  Thợ sửa ống nước  " }), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.equal(res.r.headers.get("Cache-Control"), "no-store");
  const data = res.tra.data ?? {};
  assert.match(String(data.password), /^\d{8}$/);
  assert.deepEqual(data, { passwordId: 777, password: data.password, effectiveSec: NOW_SEC, invalidSec: NOW_SEC + 7200, logId: LOG });
  assert.deepEqual(sent, [data.password], "Tuya nhận đúng mật khẩu đã trả (mã hoá bằng khoá từ vé)");

  assert.deepEqual(s.rpcNames(), ["door_access_begin_action_v1", "door_access_finish_action_v1"]);
  const begin = s.rpc("door_access_begin_action_v1")[0];
  laJwtNguoiDung(begin);
  assert.deepEqual(begin.body, {
    p_organization_id: ORG,
    p_device_id: DEVICE,
    p_action: "TEMP_PASSWORD_CREATE",
    p_detail: { name: "Thợ sửa ống nước", purpose: "THO", effective_sec: NOW_SEC, invalid_sec: NOW_SEC + 7200 },
  });
  const finish = s.rpc("door_access_finish_action_v1")[0];
  laServiceRole(finish);
  assert.deepEqual(finish.body, finishArgs("OK", { p_tuya_password_id: 777 }));

  const createBody = tuya.goiToi(P.tempCreate)[0].body as Record<string, unknown>;
  assert.deepEqual({ ...createBody, password: "…" }, {
    name: "Thợ sửa ống nước",
    password: "…",
    password_type: "ticket",
    ticket_id: "fake-ticket-01",
    effective_time: NOW_SEC,
    invalid_time: NOW_SEC + 7200,
    type: 0,
  });
  // Mật khẩu thô không ở đâu khác: không trong RPC, không trong log, không trong lời gọi Tuya (chỉ bản mã).
  const pw = String(data.password);
  assert.ok(!JSON.stringify(s.calls.map((c) => c.body)).includes(pw));
  assert.ok(!res.log.some((l) => l.includes(pw)));
  assert.ok(!JSON.stringify(tuya.calls).includes(pw));
  assert.ok(!res.log.some((l) => l.includes(SECRET_FAKE) || l.includes(USER_JWT) || l.includes(SERVICE_FAKE)));
});

Deno.test("create_temp_password: độ dài mật khẩu theo máy; nguồn sinh thay được (deps.randomPassword)", async () => {
  const lengths: number[] = [];
  const { tuya, sent } = tuyaTaoMatKhau();
  const s = setup({
    tuya,
    randomPassword: (n) => {
      lengths.push(n);
      return "1234567890".slice(0, n);
    },
    rpc: { door_access_begin_action_v1: { body: { ...ctxMau({ password_length: 6 }), log_id: LOG } } },
  });
  const res = await goi(yeuCau(THAN_HOP_LE.create_temp_password), s.deps);
  assert.equal(res.tra.data?.password, "123456");
  assert.deepEqual(lengths, [6]);
  assert.deepEqual(sent, ["123456"]);
});

Deno.test("create_temp_password: tham số sai ⇒ 400 trước begin (tên 1–20 code point, purpose, khung giờ ≤ 7 ngày)", async () => {
  const sai: Array<Record<string, unknown>> = [
    { name: "" },
    { name: "   " },
    { name: "ổ".repeat(21) },
    { name: "Dòng\nhai" },
    { name: 12345 },
    { purpose: "VIP" },
    { purpose: undefined },
    { effectiveSec: NOW_SEC - 301 },
    { effectiveSec: String(NOW_SEC) },
    { effectiveSec: NOW_SEC + 0.5 },
    { invalidSec: NOW_SEC },
    { effectiveSec: NOW_SEC + 3600, invalidSec: NOW_SEC + 3600 },
    { effectiveSec: NOW_SEC + 3600, invalidSec: NOW_SEC + 1800 },
    { invalidSec: NOW_SEC + 7 * 86_400 + 1 },
    { effectiveSec: NOW, invalidSec: NOW + 3_600_000 },
    { deviceId: DEVICE.slice(1) },
  ];
  for (const patch of sai) {
    const s = setup();
    const res = await goi(yeuCau({ ...THAN_HOP_LE.create_temp_password, ...patch }), s.deps);
    loiLa(res, "invalid_request");
    assert.deepEqual(s.rpcNames(), [], JSON.stringify(patch));
    assert.equal(s.tuya.calls.length, 0);
  }
  // Hết hạn quá 7 ngày (+300 s) kể từ bây giờ ⇒ 400 dù độ dài ≤ 7 ngày: không đặt trước mã sống ở tương lai xa.
  for (
    const patch of [
      { effectiveSec: NOW_SEC + 2 * 86_400, invalidSec: NOW_SEC + 8 * 86_400 },
      { effectiveSec: NOW_SEC + 301, invalidSec: NOW_SEC + 7 * 86_400 + 301 },
      { effectiveSec: NOW_SEC + 30 * 86_400, invalidSec: NOW_SEC + 30 * 86_400 + 3600 },
    ]
  ) {
    const s = setup();
    const res = await goi(yeuCau({ ...THAN_HOP_LE.create_temp_password, ...patch }), s.deps);
    loiLa(res, "invalid_request");
    assert.equal(res.tra.error?.message, "Mật khẩu tạm phải hết hạn trong vòng 7 ngày kể từ bây giờ.", JSON.stringify(patch));
    assert.deepEqual(s.rpcNames(), []);
  }
  // Biên hợp lệ: lùi đúng 300 s, đúng 7 ngày, hết hạn đúng 7 ngày + 300 s kể từ bây giờ, tên 20 emoji
  // (20 code point, 40 đơn vị UTF-16).
  for (
    const patch of [
      { effectiveSec: NOW_SEC - 300, invalidSec: NOW_SEC - 300 + 7 * 86_400 },
      { effectiveSec: NOW_SEC + 300, invalidSec: NOW_SEC + 7 * 86_400 + 300 },
      { name: "😀".repeat(20) },
    ]
  ) {
    const { tuya } = tuyaTaoMatKhau();
    const s = setup({ tuya });
    const res = await goi(yeuCau({ ...THAN_HOP_LE.create_temp_password, ...patch }), s.deps);
    assert.equal(res.r.status, 200, `${JSON.stringify(patch)} ${JSON.stringify(res.tra)}`);
  }
});

Deno.test("delete_temp_password: begin {password_id} ⇒ DELETE ⇒ finish OK; data {deleted, logId}", async () => {
  const tuya = new TuyaGia([[P.tempDelete, () => true]]);
  const s = setup({ tuya });
  const res = await goi(yeuCau(THAN_HOP_LE.delete_temp_password), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.deepEqual(res.tra.data, { deleted: true, logId: LOG });
  const begin = s.rpc("door_access_begin_action_v1")[0];
  laJwtNguoiDung(begin);
  assert.deepEqual(begin.body, {
    p_organization_id: ORG,
    p_device_id: DEVICE,
    p_action: "TEMP_PASSWORD_DELETE",
    p_detail: { password_id: 4242 },
  });
  laServiceRole(s.rpc("door_access_finish_action_v1")[0]);
  assert.deepEqual(s.rpc("door_access_finish_action_v1")[0].body, finishArgs("OK"));
  for (const passwordId of [-1, 1.5, "4242", null]) {
    const t = setup();
    loiLa(await goi(yeuCau({ ...THAN_HOP_LE.delete_temp_password, passwordId }), t.deps), "invalid_request");
    assert.deepEqual(t.rpcNames(), []);
  }
});

Deno.test("remote_unlock: begin {} (JWT) ⇒ vé + mở đúng kênh của máy ⇒ finish OK (service role); khoá thân không đổi được org/máy", async () => {
  const tuya = new TuyaGia([[P.ticket, () => veGia().ticket], [P.unlockAc, () => true]]);
  const s = setup({ tuya, rpc: { door_access_begin_action_v1: { body: { ...ctxMau({ channel_id: 2 }), log_id: LOG } } } });
  const res = await goi(
    yeuCau({ ...THAN_HOP_LE.remote_unlock, p_organization_id: ORG_KHAC, tuyaDeviceId: "vdevoKHAC", channelId: 9 }),
    s.deps,
  );
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.deepEqual(res.tra.data, { unlocked: true, logId: LOG });
  const begin = s.rpc("door_access_begin_action_v1")[0];
  laJwtNguoiDung(begin);
  assert.deepEqual(begin.body, { p_organization_id: ORG, p_device_id: DEVICE, p_action: "REMOTE_UNLOCK", p_detail: {} });
  assert.deepEqual(s.rpc("door_access_finish_action_v1")[0].body, finishArgs("OK"));
  laServiceRole(s.rpc("door_access_finish_action_v1")[0]);
  assert.deepEqual(tuya.goiToi(P.unlockAc).map((c) => c.body), [{ ticket_id: "fake-ticket-01", channel_id: 2 }]);
  assert.equal(s.rpc("door_access_authorize_v1").length, 0, "thao tác ghi kiểm quyền trong begin");

  // Khoá Wi-Fi: đường v1.0, không kênh.
  const wifi = new TuyaGia([[P.ticket, () => veGia().ticket], [P.unlockWifi, () => true]]);
  const w = setup({ tuya: wifi, rpc: { door_access_begin_action_v1: { body: { ...ctxMau({ device_kind: "wifi_lock", channel_id: null }), log_id: LOG } } } });
  assert.equal((await goi(yeuCau(THAN_HOP_LE.remote_unlock), w.deps)).r.status, 200);
  assert.deepEqual(wifi.goiToi(P.unlockWifi).map((c) => c.body), [{ ticket_id: "fake-ticket-01" }]);
});

Deno.test("delete_key: begin {unlock_type, unlock_sn, tuya_user_id, user_type} ⇒ DELETE ⇒ finish OK; userType mặc định 1", async () => {
  const tuya = new TuyaGia([[P.keyDelete, () => true]]);
  const s = setup({ tuya });
  const res = await goi(yeuCau(THAN_HOP_LE.delete_key), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.deepEqual(res.tra.data, { deleted: true, logId: LOG });
  const begin = s.rpc("door_access_begin_action_v1")[0];
  laJwtNguoiDung(begin);
  assert.deepEqual(begin.body, {
    p_organization_id: ORG,
    p_device_id: DEVICE,
    p_action: "KEY_DELETE",
    p_detail: { unlock_type: "fingerprint", unlock_sn: 3, tuya_user_id: "tuyaUser01", user_type: 1 },
  });
  assert.deepEqual(s.rpc("door_access_finish_action_v1")[0].body, finishArgs("OK"));
  assert.equal(tuya.goiToi(P.keyDelete).length, 1);

  const t2 = new TuyaGia([[
    `DELETE /v1.0/devices/${TUYA_DEV}/door-lock/user-types/2/users/tuyaUser01/unlock-types/card/keys/0`,
    () => true,
  ]]);
  const s2 = setup({ tuya: t2 });
  const res2 = await goi(yeuCau({ ...THAN_HOP_LE.delete_key, unlockType: "card", unlockNo: 0, userType: 2 }), s2.deps);
  assert.equal(res2.r.status, 200, JSON.stringify(res2.tra));
  assert.equal((s2.rpc("door_access_begin_action_v1")[0].body?.p_detail as Record<string, unknown>).user_type, 2);
});

Deno.test("delete_key thiếu tuyaUserId ⇒ 400 với câu hướng dẫn, KHÔNG begin; tham số sai khác ⇒ 400", async () => {
  for (const tuyaUserId of [undefined, null, ""]) {
    const s = setup();
    const res = await goi(yeuCau({ ...THAN_HOP_LE.delete_key, tuyaUserId }), s.deps);
    loiLa(res, "invalid_request");
    assert.equal(res.tra.error?.message, "Vân tay chưa gắn người dùng trên máy — xoá trong app SmartLife");
    assert.deepEqual(s.rpcNames(), []);
    assert.equal(s.tuya.calls.length, 0);
  }
  for (
    const patch of [
      { tuyaUserId: "../users/khac" },
      { tuyaUserId: 42 },
      { tuyaUserId: "x".repeat(65) },
      { unlockType: "face" },
      { unlockNo: -1 },
      { unlockNo: 2_147_483_648 },
      { unlockNo: "3" },
      { userType: 3 },
      { userType: "1" },
    ]
  ) {
    const s = setup();
    const res = await goi(yeuCau({ ...THAN_HOP_LE.delete_key, ...patch }), s.deps);
    loiLa(res, "invalid_request");
    assert.notEqual(res.tra.error?.message, "Vân tay chưa gắn người dùng trên máy — xoá trong app SmartLife");
    assert.deepEqual(s.rpcNames(), [], JSON.stringify(patch));
  }
});

Deno.test("Tuya từ chối LỆNH (mã khác 500/501) ⇒ finish FAILED (mã + câu Tuya) + 502 tuya_rejected + tuyaCode", async () => {
  for (const [code, msg] of [[2001, "device is offline"], [1106, "permission deny"]] as const) {
    const tuya = new TuyaGia([[P.ticket, () => veGia().ticket], [P.unlockAc, () => {
      throw new TuyaError(code, msg, "/open-door", true);
    }]]);
    const s = setup({ tuya });
    const res = await goi(yeuCau(THAN_HOP_LE.remote_unlock), s.deps);
    loiLa(res, "tuya_rejected");
    assert.equal(res.tra.error?.tuyaCode, code);
    assert.equal(res.tra.error?.outcomeUnknown, undefined);
    assert.equal(res.tra.error?.logPending, undefined);
    laServiceRole(s.rpc("door_access_finish_action_v1")[0]);
    assert.deepEqual(
      s.rpc("door_access_finish_action_v1")[0].body,
      finishArgs("FAILED", { p_error_code: String(code), p_error_message: msg }),
    );
    assert.equal(tuya.goiToi(P.unlockAc).length, 1);
  }
  // Xoá vân tay bị từ chối ⇒ FAILED (không chốt OK nên không tự bỏ gắn liên kết).
  const tuya = new TuyaGia([[P.keyDelete, () => {
    throw new TuyaError(1106, "permission deny", "/keys", true);
  }]]);
  const s = setup({ tuya });
  loiLa(await goi(yeuCau(THAN_HOP_LE.delete_key), s.deps), "tuya_rejected");
  assert.equal(s.rpc("door_access_finish_action_v1")[0].body?.p_status, "FAILED");
});

Deno.test("Tuya báo 500/501 (lỗi hệ thống) cho LỆNH ⇒ UNKNOWN + 504 outcomeUnknown (+tuyaCode), lệnh gửi đúng một lần", async () => {
  for (const [code, msg] of [[500, "system error"], [501, "request exception"], ["500", "system error"]] as const) {
    const tuya = new TuyaGia([[P.ticket, () => veGia().ticket], [P.unlockAc, () => {
      throw new TuyaError(code, msg, "/open-door", true);
    }]]);
    const s = setup({ tuya });
    const res = await goi(yeuCau(THAN_HOP_LE.remote_unlock), s.deps);
    loiLa(res, "tuya_unavailable");
    assert.equal(res.tra.error?.outcomeUnknown, true, String(code));
    assert.equal(res.tra.error?.tuyaCode, code);
    assert.match(res.tra.error?.message ?? "", /Chưa rõ cửa đã mở chưa/);
    assert.equal(tuya.goiToi(P.unlockAc).length, 1, "không gửi lại");
    assert.deepEqual(
      s.rpc("door_access_finish_action_v1")[0].body,
      finishArgs("UNKNOWN", { p_error_code: String(code), p_error_message: msg }),
    );
  }
  // Tạo mật khẩu tạm: 500 ở lệnh tạo ⇒ chưa rõ (mật khẩu có thể đã nạp), không trả mật khẩu.
  const { tuya } = tuyaTaoMatKhau(() => {
    throw new TuyaError(500, "system error", "/temp-password", true);
  });
  const s = setup({ tuya });
  const res = await goi(yeuCau(THAN_HOP_LE.create_temp_password), s.deps);
  loiLa(res, "tuya_unavailable");
  assert.equal(res.tra.error?.outcomeUnknown, true);
  assert.equal(res.tra.data, undefined);
  assert.equal(s.rpc("door_access_finish_action_v1")[0].body?.p_status, "UNKNOWN");
});

Deno.test("lỗi ở BƯỚC VÉ (trước khi gửi lệnh) ⇒ finish FAILED ticket_…, không outcomeUnknown, không gửi lệnh", async () => {
  const cases: Array<[XuLyTuya, string, string, number | string | undefined]> = [
    [() => {
      throw new TypeError("error sending request");
    }, "ticket_network", "tuya_unavailable", undefined],
    [() => {
      throw new DOMException("Tuya không trả lời trong 15000 ms", "TimeoutError");
    }, "ticket_timeout", "tuya_unavailable", undefined],
    [() => {
      throw new TuyaError("http_502", "HTTP 502", "/password-ticket");
    }, "ticket_http_502", "tuya_unavailable", undefined],
    [() => ({ ticket_id: "t" }), "ticket_bad_result", "tuya_unavailable", undefined],
    [() => {
      throw new TuyaError(1106, "permission deny", "/password-ticket", true);
    }, "ticket_1106", "tuya_rejected", 1106],
    // 500 ở bước vé vẫn là "chưa làm": lệnh chưa được gửi.
    [() => {
      throw new TuyaError(500, "system error", "/password-ticket", true);
    }, "ticket_500", "tuya_rejected", 500],
  ];
  for (const [reply, errorCode, code, tuyaCode] of cases) {
    for (const action of ["remote_unlock", "create_temp_password"] as const) {
      const tuya = new TuyaGia([[P.ticket, reply], [P.unlockAc, () => true], [P.tempCreate, () => ({ id: 1 })]]);
      const s = setup({ tuya });
      const res = await goi(yeuCau(THAN_HOP_LE[action]), s.deps);
      loiLa(res, code);
      assert.equal(res.tra.error?.outcomeUnknown, undefined, `${action} ${errorCode}`);
      assert.equal(res.tra.error?.tuyaCode, tuyaCode);
      assert.match(res.tra.error?.message ?? "", /chưa được gửi/);
      assert.equal(tuya.goiToi(P.ticket).length, 1, "xin vé đúng một lần");
      assert.equal(tuya.goiToi(P.unlockAc).length + tuya.goiToi(P.tempCreate).length, 0, `${action} ${errorCode}: không gửi lệnh`);
      const finish = s.rpc("door_access_finish_action_v1");
      assert.equal(finish.length, 1);
      laServiceRole(finish[0]);
      assert.equal(finish[0].body?.p_status, "FAILED");
      assert.equal(finish[0].body?.p_error_code, errorCode);
      assert.equal(res.tra.data, undefined);
    }
  }
});

Deno.test("lỗi mạng/hết giờ/HTTP/kết quả lạ khi ghi ⇒ finish UNKNOWN + 504 outcomeUnknown; lệnh gửi ĐÚNG MỘT lần", async () => {
  const cases: Array<[XuLyTuya, string]> = [
    [() => {
      throw new TypeError("error sending request");
    }, "network"],
    [() => {
      throw new DOMException("Tuya không trả lời trong 15000 ms", "TimeoutError");
    }, "timeout"],
    [() => {
      throw new TuyaError("http_502", "HTTP 502", "/open-door");
    }, "http_502"],
    [() => {
      throw new TuyaError("bad_json", "Tuya trả thân không phải JSON object", "/open-door");
    }, "bad_json"],
  ];
  for (const [reply, errorCode] of cases) {
    const tuya = new TuyaGia([[P.ticket, () => veGia().ticket], [P.unlockAc, reply]]);
    const s = setup({ tuya });
    const res = await goi(yeuCau(THAN_HOP_LE.remote_unlock), s.deps);
    loiLa(res, "tuya_unavailable");
    assert.equal(res.tra.error?.outcomeUnknown, true);
    assert.match(res.tra.error?.message ?? "", /Chưa rõ cửa đã mở chưa/);
    assert.equal(tuya.goiToi(P.unlockAc).length, 1, `${errorCode}: không gửi lại lệnh mở`);
    const finish = s.rpc("door_access_finish_action_v1");
    assert.equal(finish.length, 1);
    laServiceRole(finish[0]);
    assert.equal(finish[0].body?.p_status, "UNKNOWN");
    assert.equal(finish[0].body?.p_error_code, errorCode);
  }

  // Tạo mật khẩu tạm: lỗi mạng ở lệnh tạo ⇒ UNKNOWN, không trả mật khẩu, POST tạo đúng một lần.
  const { tuya } = tuyaTaoMatKhau(() => {
    throw new TypeError("network");
  });
  const s = setup({ tuya });
  const res = await goi(yeuCau(THAN_HOP_LE.create_temp_password), s.deps);
  loiLa(res, "tuya_unavailable");
  assert.equal(res.tra.error?.outcomeUnknown, true);
  assert.equal(JSON.stringify(res.tra).includes("password\""), false);
  assert.equal(res.tra.data, undefined);
  assert.equal(tuya.goiToi(P.tempCreate).length, 1);
  assert.deepEqual(s.rpc("door_access_finish_action_v1")[0].body, finishArgs("UNKNOWN", {
    p_error_code: "network",
    p_error_message: "Lỗi mạng khi gọi Tuya",
  }));

  // Tạo xong nhưng kết quả thiếu id ⇒ UNKNOWN (mật khẩu có thể đã nạp vào máy).
  const thieuId = tuyaTaoMatKhau(() => ({}));
  const t = setup({ tuya: thieuId.tuya });
  const r2 = await goi(yeuCau(THAN_HOP_LE.create_temp_password), t.deps);
  loiLa(r2, "tuya_unavailable");
  assert.equal(t.rpc("door_access_finish_action_v1")[0].body?.p_error_code, "bad_result");
});

Deno.test("Tuya trả success nhưng kết quả false ⇒ FAILED result_false + 502 (KEY_DELETE không bị chốt OK)", async () => {
  for (
    const [action, route] of [
      ["remote_unlock", P.unlockAc],
      ["delete_temp_password", P.tempDelete],
      ["delete_key", P.keyDelete],
    ] as const
  ) {
    const tuya = new TuyaGia([[P.ticket, () => veGia().ticket], [route, () => false]]);
    const s = setup({ tuya });
    const res = await goi(yeuCau(THAN_HOP_LE[action]), s.deps);
    loiLa(res, "tuya_rejected");
    assert.equal(res.tra.error?.tuyaCode, undefined);
    assert.equal(s.rpc("door_access_finish_action_v1")[0].body?.p_status, "FAILED");
    assert.equal(s.rpc("door_access_finish_action_v1")[0].body?.p_error_code, "result_false");
    assert.equal(tuya.goiToi(route).length, 1);
  }
});

Deno.test("giải vé hỏng ⇒ FAILED ticket_crypto_<mã> + 502, lệnh tạo không được gửi; TuyaInputError ⇒ FAILED invalid_input + 400", async () => {
  const tuya = new TuyaGia([
    [P.ticket, () => ({ ticket_id: "fake-ticket-01", ticket_key: "ABCD", expire_time: 300 })],
    [P.tempCreate, () => ({ id: 1 })],
  ]);
  const s = setup({ tuya });
  const res = await goi(yeuCau(THAN_HOP_LE.create_temp_password), s.deps);
  loiLa(res, "tuya_rejected");
  assert.equal(res.tra.error?.outcomeUnknown, undefined);
  assert.equal(tuya.goiToi(P.tempCreate).length, 0);
  assert.equal(s.rpc("door_access_finish_action_v1")[0].body?.p_status, "FAILED");
  assert.equal(s.rpc("door_access_finish_action_v1")[0].body?.p_error_code, "ticket_crypto_bad_hex");

  // Vé mã bằng secret khác ⇒ hỏng đệm/độ dài khoá — vẫn là lỗi giải vé, không phải "chưa rõ".
  const khac = new TuyaGia([[P.ticket, () => veGia("fake_secret_other_0123456789abcd").ticket], [P.tempCreate, () => ({ id: 1 })]]);
  const k = setup({ tuya: khac });
  loiLa(await goi(yeuCau(THAN_HOP_LE.create_temp_password), k.deps), "tuya_rejected");
  assert.match(String(k.rpc("door_access_finish_action_v1")[0].body?.p_error_code), /^ticket_crypto_/);
  assert.equal(khac.goiToi(P.tempCreate).length, 0);

  // Sinh mật khẩu hỏng (TuyaCryptoError ngoài bước vé, trước khi gửi gì) ⇒ FAILED crypto_<mã>, không xin vé.
  const sinhHong = new TuyaGia([[P.ticket, () => veGia().ticket], [P.tempCreate, () => ({ id: 1 })]]);
  const g = setup({
    tuya: sinhHong,
    randomPassword: () => {
      throw new TuyaCryptoError("no_entropy", "Nguồn ngẫu nhiên không cho đủ chữ số");
    },
  });
  loiLa(await goi(yeuCau(THAN_HOP_LE.create_temp_password), g.deps), "tuya_rejected");
  assert.equal(g.rpc("door_access_finish_action_v1")[0].body?.p_error_code, "crypto_no_entropy");
  assert.equal(sinhHong.calls.length, 0);

  const input = new TuyaGia([[P.ticket, () => veGia().ticket], [P.unlockAc, () => {
    throw new TuyaInputError("channelId phải là số nguyên 1–64");
  }]]);
  const t = setup({ tuya: input });
  loiLa(await goi(yeuCau(THAN_HOP_LE.remote_unlock), t.deps), "invalid_request");
  assert.deepEqual(t.rpc("door_access_finish_action_v1")[0].body, finishArgs("FAILED", {
    p_error_code: "invalid_input",
    p_error_message: "channelId phải là số nguyên 1–64",
  }));
});

Deno.test("chốt nhật ký hỏng ⇒ vẫn trả kết quả Tuya, kèm logPending (thành công lẫn thất bại); không chốt lại", async () => {
  const { tuya } = tuyaTaoMatKhau();
  const s = setup({ tuya, rpc: { door_access_finish_action_v1: { status: 500, body: { code: "XX000", message: "boom" } } } });
  const res = await goi(yeuCau(THAN_HOP_LE.create_temp_password), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.equal(res.tra.data?.logPending, true);
  assert.equal(res.tra.data?.passwordId, 777);
  assert.match(String(res.tra.data?.password), /^\d{7}$/);
  assert.equal(s.rpc("door_access_finish_action_v1").length, 1);
  assert.ok(res.log.some((l) => l.includes("chốt nhật ký")));
  assert.ok(!res.log.some((l) => l.includes(String(res.tra.data?.password))));

  const rejected = new TuyaGia([[P.ticket, () => veGia().ticket], [P.unlockAc, () => {
    throw new TuyaError(2001, "device is offline", "/open-door", true);
  }]]);
  const t = setup({ tuya: rejected, rpc: { door_access_finish_action_v1: "network" } });
  const r2 = await goi(yeuCau(THAN_HOP_LE.remote_unlock), t.deps);
  loiLa(r2, "tuya_rejected");
  assert.equal(r2.tra.error?.logPending, true);
  assert.equal(r2.tra.error?.tuyaCode, 2001);
  assert.equal(t.rpc("door_access_finish_action_v1").length, 1);

  const unknown = new TuyaGia([[P.ticket, () => veGia().ticket], [P.unlockAc, () => {
    throw new TypeError("network");
  }]]);
  const u = setup({ tuya: unknown, rpc: { door_access_finish_action_v1: { status: 403, body: { code: "42501", message: "x" } } } });
  const r3 = await goi(yeuCau(THAN_HOP_LE.remote_unlock), u.deps);
  loiLa(r3, "tuya_unavailable");
  assert.equal(r3.tra.error?.outcomeUnknown, true);
  assert.equal(r3.tra.error?.logPending, true);
});

Deno.test("begin trả thiếu log_id ⇒ 500, không Tuya, không finish; ngữ cảnh sai/máy khác ⇒ finish FAILED bad_context, không Tuya", async () => {
  const a = setup({ rpc: { door_access_begin_action_v1: { body: ctxMau() } } });
  loiLa(await goi(yeuCau(THAN_HOP_LE.remote_unlock), a.deps), "internal");
  assert.equal(a.tuya.calls.length, 0);
  assert.equal(a.rpc("door_access_finish_action_v1").length, 0);

  for (const ctx of [ctxMau({ device_id: DEVICE_KHAC }), ctxMau({ device_kind: null }), ctxMau({ password_length: 11 })]) {
    const s = setup({ rpc: { door_access_begin_action_v1: { body: { ...ctx, log_id: LOG } } } });
    loiLa(await goi(yeuCau(THAN_HOP_LE.create_temp_password), s.deps), "internal");
    assert.equal(s.tuya.calls.length, 0, JSON.stringify(ctx));
    assert.equal(s.rpc("door_access_finish_action_v1")[0].body?.p_status, "FAILED");
    assert.equal(s.rpc("door_access_finish_action_v1")[0].body?.p_error_code, "bad_context");
  }
});

// ---------------------------------------------------------------------------------------------------
// Đấu nối TuyaClient thật (nhà máy mặc định) và bộ chạy giới hạn

Deno.test("nhà máy mặc định: TuyaClient thật đi qua fetchImpl, ký request, dùng now của deps", async () => {
  const accessId = "fake_access_id_wiring";
  const tuyaUrls: string[] = [];
  const tuyaFetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    assert.equal(u.origin, BASE);
    const headers = { ...(init.headers as Record<string, string>) };
    assert.equal(headers.client_id, accessId);
    assert.equal(headers.t, String(NOW));
    const expected = await tuyaSign({
      accessId,
      accessSecret: SECRET_FAKE,
      accessToken: headers.access_token,
      t: headers.t,
      nonce: headers.nonce,
      method: init.method as TuyaMethod,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      bodyText: typeof init.body === "string" ? init.body : undefined,
    });
    assert.equal(headers.sign, expected);
    tuyaUrls.push(`${init.method} ${u.pathname}`);
    if (u.pathname === "/v1.0/token") {
      return Response.json({ success: true, result: { access_token: "fake-token-wiring", expire_time: 7200 } });
    }
    return Response.json({ success: true, result: { records: [], total: 0, has_more: false } });
  };
  const s = setup({ env: { TUYA_ACCESS_ID: accessId }, fakeTuya: false, tuyaFetch });
  const res = await goi(yeuCau(THAN_HOP_LE.records), s.deps);
  assert.equal(res.r.status, 200, JSON.stringify(res.tra));
  assert.deepEqual(tuyaUrls, ["GET /v1.0/token", `GET /v1.0/devices/${TUYA_DEV}/door-lock/records`]);
});

Deno.test("chayGioiHan: giữ thứ tự, không vượt giới hạn, hỏng thì không nhận việc mới", async () => {
  let dang = 0;
  let max = 0;
  const out = await chayGioiHan([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    dang++;
    max = Math.max(max, dang);
    await new Promise((r) => setTimeout(r, 1));
    dang--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.equal(max, 3);
  assert.deepEqual(await chayGioiHan([], 4, () => Promise.resolve(1)), []);

  const started: number[] = [];
  await assert.rejects(
    chayGioiHan([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
      started.push(n);
      await Promise.resolve();
      if (n === 2) throw new Error("hỏng");
      return n;
    }),
    /hỏng/,
  );
  assert.ok(started.length < 8, `dừng nhận việc sau lỗi (đã chạy ${started.join(",")})`);
});
