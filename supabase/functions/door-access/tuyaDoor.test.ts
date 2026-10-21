// Test tuyaDoor.ts qua TuyaClient thật + fetch giả: mỗi hàm — phương thức, đường dẫn, tham số, thân, chữ ký (máy chủ
// giả tự tính lại chữ ký cho MỌI request); chuẩn hoá dữ liệu mẫu; kiểm id; mật khẩu tạm đầu-cuối với vé giả; mở cửa
// không thử lại. Khoá là giá trị MẪU công khai trong tài liệu ký của Tuya (hậu tố _EXAMPLE để cửa quét secret nhận
// ra); id thiết bị, tên, mốc giờ đều tự bịa.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TuyaClient, TuyaConfigError, TuyaError, TuyaInputError, tuyaSign, type TuyaFetch, type TuyaMethod } from "./tuyaClient.ts";
import { TuyaCryptoError } from "./tuyaCrypto.ts";
import {
  createTempPassword,
  type CreateTempPasswordInput,
  deleteTempPassword,
  deleteUnlockMethod,
  type DeleteUnlockMethodInput,
  type DoorKind,
  getDevice,
  getPasswordTicket,
  kindFromCategory,
  listDeviceUsers,
  listProjectDevices,
  listRecords,
  type ListRecordsInput,
  listTempPasswords,
  listUnassignedKeys,
  listUserUnlockMethods,
  RECORD_DP_CODES,
  RECORD_TIME_UNIT,
  recordTimeParam,
  remoteUnlock,
  unlockMethodFromCode,
} from "./tuyaDoor.ts";

const ACCESS_ID_EXAMPLE = "1KAD46OrT9HafiKdsXeg";
const ACCESS_SECRET_EXAMPLE = "4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC";
const ACCESS_TOKEN_EXAMPLE = "3f4eda2bdec17232f67c0b188af3eec1";
const BASE = "https://openapi.tuyaus.com";
const NOW = 1_760_000_000_000;
const DEVICE = "vdevo00000000000000001";
const DAY_START = 1_760_000_000_000;
const DAY_END = 1_760_086_400_000;

type Envelope = { success: true; result?: unknown } | { success: false; code: number | string; msg: string };
const ok = (result?: unknown): Envelope => ({ success: true, result });
const fail = (code: number | string, msg: string): Envelope => ({ success: false, code, msg });

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  bodyText: string | undefined;
  body: unknown;
}

/**
 * Máy chủ Tuya giả. Kiểm cho MỌI request: đúng máy chủ, không theo chuyển hướng, đủ header ký và chữ ký đúng (tính lại
 * từ tham số giải mã từ URL + đúng chuỗi thân gửi đi). Lời gọi nghiệp vụ lấy trả lời lần lượt trong `replies`
 * (Error ⇒ ném như lỗi mạng).
 */
function harness(replies: Array<Envelope | Error> = []) {
  const calls: Call[] = [];
  const queue = [...replies];
  let tokens = 0;
  let nonce = 0;
  const fetch: TuyaFetch = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, BASE);
    assert.equal(init.redirect, "error");
    const headers = { ...(init.headers as Record<string, string>) };
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    const query = Object.fromEntries(u.searchParams);
    assert.equal(headers.client_id, ACCESS_ID_EXAMPLE);
    assert.equal(headers.sign_method, "HMAC-SHA256");
    assert.equal(headers.t, String(NOW));
    assert.match(headers.nonce, /^n\d+$/);
    assert.equal(headers["Content-Type"], bodyText === undefined ? undefined : "application/json");
    const expected = await tuyaSign({
      accessId: ACCESS_ID_EXAMPLE,
      accessSecret: ACCESS_SECRET_EXAMPLE,
      accessToken: headers.access_token,
      t: headers.t,
      nonce: headers.nonce,
      method: init.method as TuyaMethod,
      path: u.pathname,
      query,
      bodyText,
    });
    assert.equal(headers.sign, expected, `chữ ký ${init.method} ${u.pathname}`);
    if (u.pathname === "/v1.0/token") {
      tokens++;
      return Response.json({ success: true, result: { access_token: ACCESS_TOKEN_EXAMPLE, expire_time: 7200, refresh_token: "r", uid: "u" }, t: NOW });
    }
    assert.equal(headers.access_token, ACCESS_TOKEN_EXAMPLE);
    calls.push({ method: init.method ?? "", path: u.pathname, query, bodyText, body: bodyText === undefined ? undefined : JSON.parse(bodyText) });
    const reply = queue.shift();
    if (reply === undefined) throw new Error(`Không có trả lời giả cho ${init.method} ${u.pathname}`);
    if (reply instanceof Error) throw reply;
    return Response.json({ ...reply, t: NOW });
  };
  const client = new TuyaClient(
    { baseUrl: BASE, accessId: ACCESS_ID_EXAMPLE, accessSecret: ACCESS_SECRET_EXAMPLE },
    { fetch, now: () => NOW, nonce: () => `n${++nonce}`, tokenCache: new Map() },
  );
  return { client, calls, tokenCalls: () => tokens, left: () => queue.length };
}

const route = (calls: Call[]) => calls.map((c) => [c.method, c.path, c.query, c.body]);

const isBadResult = (error: unknown) => {
  assert.ok(error instanceof TuyaError, String(error));
  assert.equal(error.code, "bad_result");
  assert.equal(error.rejected, false);
  return true;
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
function nodeEcb(mode: "encrypt" | "decrypt", key: Uint8Array, data: Uint8Array): Uint8Array {
  const algorithm = `aes-${key.length * 8}-ecb`;
  const cipher = mode === "encrypt" ? createCipheriv(algorithm, key, null) : createDecipheriv(algorithm, key, null);
  return new Uint8Array([...cipher.update(data), ...cipher.final()]);
}
/** Vé giả đúng cách Tuya làm: khoá gốc 16 byte mã AES-256-ECB bằng Access Secret, hex. */
function fakeTicket(ticketId: string, secret = ACCESS_SECRET_EXAMPLE) {
  const rawKey = new Uint8Array(randomBytes(16));
  const ticketKey = hex(nodeEcb("encrypt", new TextEncoder().encode(secret), rawKey)).toUpperCase();
  return { rawKey, reply: ok({ ticket_id: ticketId, ticket_key: ticketKey, expire_time: 300 }) };
}

const TICKET_PATH = `/v1.0/devices/${DEVICE}/door-lock/password-ticket`;

Deno.test("kindFromCategory và unlockMethodFromCode", () => {
  assert.equal(kindFromCategory("mk"), "access_control");
  for (const category of ["ms", "jtmspro", "videolock", "jtmsbh", "gyms", "hotelms", "bxx"]) {
    assert.equal(kindFromCategory(category), "wifi_lock", category);
  }
  for (const category of ["wk", "MK", "", null, undefined, 1, "constructor"]) assert.equal(kindFromCategory(category), null);
  assert.equal(unlockMethodFromCode("unlock_fingerprint"), "fingerprint");
  assert.equal(unlockMethodFromCode("card"), "card");
  assert.equal(unlockMethodFromCode("unlock_face"), "face");
  for (const code of ["unlock_key", "alarm_lock", "doorbell", "constructor", "__proto__", "toString", null, 3]) {
    assert.equal(unlockMethodFromCode(code), "other", String(code));
  }
});

const deviceItem = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `vdevo${String(i).padStart(17, "0")}`,
  name: `Thiết bị ${i}`,
  customName: "",
  category: ["mk", "ms", "jtmspro", "wk"][i % 4],
  productName: "Sản phẩm mẫu",
  isOnline: i % 2 === 0,
  timeZone: "+07:00",
  icon: "smart/icon/demo.png",
  localKey: "khoa-cuc-bo-khong-duoc-lo",
  ...extra,
});

Deno.test("listProjectDevices: lật trang bằng last_id tới khi trang thiếu; chuẩn hoá + kind; không lộ localKey", async () => {
  const page1 = Array.from({ length: 20 }, (_, i) => deviceItem(i + 1));
  page1[0] = deviceItem(1, { customName: "Cổng chính" });
  const page2 = [deviceItem(21), deviceItem(22, { timeZone: undefined, isOnline: undefined }), deviceItem(23)];
  const h = harness([ok(page1), ok(page2)]);
  const out = await listProjectDevices(h.client);
  assert.deepEqual(route(h.calls), [
    ["GET", "/v2.0/cloud/thing/device", { page_size: "20" }, undefined],
    ["GET", "/v2.0/cloud/thing/device", { page_size: "20", last_id: page1[19].id }, undefined],
  ]);
  assert.equal(out.hasMore, false);
  assert.equal(out.devices.length, 23);
  assert.deepEqual(out.devices[0], {
    id: page1[0].id,
    name: "Cổng chính",
    category: "ms",
    productName: "Sản phẩm mẫu",
    online: false,
    timeZone: "+07:00",
    kind: "wifi_lock",
  });
  assert.deepEqual(out.devices[3], { ...out.devices[3], name: "Thiết bị 4", category: "mk", online: true, kind: "access_control" });
  assert.deepEqual(out.devices[21], {
    id: page2[1].id,
    name: "Thiết bị 22",
    category: "jtmspro",
    productName: "Sản phẩm mẫu",
    online: null,
    timeZone: null,
    kind: "wifi_lock",
  });
  assert.equal(out.devices[2].kind, null);
  assert.equal(JSON.stringify(out).includes("khoa-cuc-bo-khong-duoc-lo"), false);
});

Deno.test("listProjectDevices: chạm maxPages ⇒ hasMore; Tuya lờ last_id ⇒ dừng, không trùng", async () => {
  const first = Array.from({ length: 20 }, (_, i) => deviceItem(i + 1));
  const second = Array.from({ length: 20 }, (_, i) => deviceItem(i + 21));
  const capped = harness([ok(first), ok(second)]);
  const out = await listProjectDevices(capped.client, { maxPages: 2 });
  assert.equal(capped.calls.length, 2);
  assert.equal(out.devices.length, 40);
  assert.equal(out.hasMore, true);

  const stuck = harness([ok(first), ok(first)]);
  const again = await listProjectDevices(stuck.client);
  assert.equal(stuck.calls.length, 2);
  assert.equal(again.devices.length, 20);
  assert.equal(again.hasMore, true);
});

Deno.test("getDevice: GET /v1.0/devices/{id}, chuẩn hoá trường snake_case, không lộ local_key", async () => {
  const h = harness([
    ok({ id: DEVICE, name: "Khoá cửa mẫu", category: "jtmspro", online: true, product_name: "Khoá Wi-Fi mẫu", time_zone: "+07:00", local_key: "bi-mat" }),
  ]);
  const device = await getDevice(h.client, DEVICE);
  assert.deepEqual(route(h.calls), [["GET", `/v1.0/devices/${DEVICE}`, {}, undefined]]);
  assert.deepEqual(device, {
    id: DEVICE,
    name: "Khoá cửa mẫu",
    category: "jtmspro",
    productName: "Khoá Wi-Fi mẫu",
    online: true,
    timeZone: "+07:00",
    kind: "wifi_lock",
  });
  assert.equal(JSON.stringify(device).includes("bi-mat"), false);
});

const ACCESS_RECORDS = {
  has_more: true,
  total_pages: 3,
  total: 45,
  records: [
    {
      record_id: "1001",
      record_type: "normal",
      unlock_name: "Vân tay 3",
      gmt_create: 1_760_000_000_123,
      user_id: "u-01",
      user_name: "Người thuê A",
      member_bindable_flag: 0,
      dps: [{ unlock_fingerprint: 3 }],
      union_unlock_info: { user_name: "Người thuê A", opmode: "fingerprint", unlock_name: "Vân tay 3" },
    },
    {
      record_id: 1002,
      record_type: "alarm",
      unlock_name: "",
      gmt_create: 1_760_000_100_000,
      user_id: "",
      user_name: "",
      member_bindable_flag: 0,
      dps: [{ unlock_password: 0 }, { alarm_lock: "wrong_password" }],
      union_unlock_info: {},
    },
    {
      record_id: "1003",
      record_type: "normal",
      gmt_create: 1_760_000_200_000,
      user_id: "0",
      dps: [{ unlock_temporary: 9876543 }],
      union_unlock_info: { user_name: "Khách", unlock_name: "Mật khẩu tạm" },
    },
    { record_id: "1004", record_type: "normal", gmt_create: 1_760_000_300_000, dps: [{ doorbell: true }] },
    // gmt_create bằng giây ⇒ đổi ms; dps dạng object.
    { record_id: "1005", record_type: "normal", gmt_create: 1_760_000_400, dps: { unlock_remote: 1 }, user_id: "u-02", user_name: "Quản lý" },
    // Không dps ⇒ lấy opmode của union_unlock_info.
    { record_id: "1006", record_type: "normal", gmt_create: 1_760_000_500_000, dps: [], union_unlock_info: { opmode: "unlock_card", unlock_name: "Thẻ 7" } },
    { record_id: "1007", gmt_create: 1_760_000_600_000, dps: [{ unlock_key: 1 }] },
  ],
};

Deno.test("listRecords access_control: GET records với dp codes + mốc ms + trang; chuẩn hoá vân tay/cảnh báo/tạm/chuông/giây", async () => {
  assert.equal(RECORD_TIME_UNIT, "ms");
  const h = harness([ok(ACCESS_RECORDS)]);
  const page = await listRecords(h.client, { deviceId: DEVICE, kind: "access_control", startMs: DAY_START, endMs: DAY_END, pageNo: 2, pageSize: 15 });
  assert.deepEqual(route(h.calls), [[
    "GET",
    `/v1.0/devices/${DEVICE}/door-lock/records`,
    {
      target_standard_dp_codes:
        "unlock_fingerprint,unlock_password,unlock_card,unlock_temporary,unlock_dynamic,unlock_app,unlock_remote,unlock_face,doorbell,alarm_lock",
      start_time: String(DAY_START),
      end_time: String(DAY_END),
      page_no: "2",
      page_size: "15",
    },
    undefined,
  ]]);
  assert.equal(RECORD_DP_CODES.length, 10);
  assert.equal(page.total, 45);
  assert.equal(page.hasMore, true);
  const none = { userId: null, userName: null, unlockName: null };
  assert.deepEqual(page.records, [
    {
      id: "1001",
      at: 1_760_000_000_123,
      kind: "unlock",
      method: "fingerprint",
      methodCode: "unlock_fingerprint",
      slot: 3,
      userId: "u-01",
      userName: "Người thuê A",
      unlockName: "Vân tay 3",
    },
    { id: "1002", at: 1_760_000_100_000, kind: "alarm", method: "other", methodCode: "alarm_lock", slot: "wrong_password", ...none },
    {
      id: "1003",
      at: 1_760_000_200_000,
      kind: "unlock",
      method: "temporary",
      methodCode: "unlock_temporary",
      slot: 9876543,
      userId: "0",
      userName: "Khách",
      unlockName: "Mật khẩu tạm",
    },
    { id: "1004", at: 1_760_000_300_000, kind: "doorbell", method: "other", methodCode: "doorbell", slot: null, ...none },
    {
      id: "1005",
      at: 1_760_000_400_000,
      kind: "unlock",
      method: "remote",
      methodCode: "unlock_remote",
      slot: 1,
      userId: "u-02",
      userName: "Quản lý",
      unlockName: null,
    },
    { id: "1006", at: 1_760_000_500_000, kind: "unlock", method: "card", methodCode: "unlock_card", slot: null, ...none, unlockName: "Thẻ 7" },
    { id: "1007", at: 1_760_000_600_000, kind: "unlock", method: "other", methodCode: "unlock_key", slot: 1, ...none },
  ]);
});

Deno.test("listRecords: hasMore suy từ total_pages hoặc total khi Tuya không trả has_more", async () => {
  const base = { deviceId: DEVICE, kind: "access_control" as DoorKind, startMs: DAY_START, endMs: DAY_END, pageSize: 20 };
  const h = harness([
    ok({ total_pages: 2, total: 40, records: [] }),
    ok({ total: 45, records: [] }),
    ok({ total: 40, records: [] }),
  ]);
  assert.equal((await listRecords(h.client, { ...base, pageNo: 2 })).hasMore, false);
  assert.equal((await listRecords(h.client, { ...base, pageNo: 2 })).hasMore, true);
  assert.equal((await listRecords(h.client, { ...base, pageNo: 2 })).hasMore, false);
  assert.equal(recordTimeParam(1_760_000_000_999, "s"), 1_760_000_000);
  assert.equal(recordTimeParam(1_760_000_000_999), 1_760_000_000_999);
});

Deno.test("listRecords wifi_lock: GET v1.1 open-logs; status dạng object lẫn mảng; mốc giây ⇒ ms", async () => {
  const h = harness([
    ok({
      total: 25,
      logs: [
        { status: { code: "unlock_fingerprint", value: "2" }, update_time: 1_760_000_000_000, unlock_name: "Vân tay 2", user_id: "u-03", nick_name: "Người thuê B" },
        { status: [{ code: "unlock_password", value: 1 }], update_time: 1_760_000_060, unlock_name: "", user_id: "", nick_name: "" },
        { status: [{ code: "unlock_switch", value: true }, { code: "unlock_app", value: 0 }], update_time: 1_760_000_120_000, user_id: "u-04", nick_name: "Chủ nhà" },
      ],
    }),
  ]);
  const page = await listRecords(h.client, { deviceId: DEVICE, kind: "wifi_lock", startMs: DAY_START, endMs: DAY_END, pageSize: 10 });
  assert.deepEqual(route(h.calls), [[
    "GET",
    `/v1.1/devices/${DEVICE}/door-lock/open-logs`,
    { page_no: "1", page_size: "10", start_time: String(DAY_START), end_time: String(DAY_END) },
    undefined,
  ]]);
  assert.equal(page.total, 25);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.records, [
    {
      id: "1760000000000:unlock_fingerprint:2:u-03",
      at: 1_760_000_000_000,
      kind: "unlock",
      method: "fingerprint",
      methodCode: "unlock_fingerprint",
      slot: 2,
      userId: "u-03",
      userName: "Người thuê B",
      unlockName: "Vân tay 2",
    },
    {
      id: "1760000060000:unlock_password:1:",
      at: 1_760_000_060_000,
      kind: "unlock",
      method: "password",
      methodCode: "unlock_password",
      slot: 1,
      userId: null,
      userName: null,
      unlockName: null,
    },
    {
      id: "1760000120000:unlock_app:0:u-04",
      at: 1_760_000_120_000,
      kind: "unlock",
      method: "app",
      methodCode: "unlock_app",
      slot: 0,
      userId: "u-04",
      userName: "Chủ nhà",
      unlockName: null,
    },
  ]);
});

Deno.test("listDeviceUsers access_control: GET v1.1 users (keyword/role rỗng vẫn gửi và ký); vai theo user_type", async () => {
  const h = harness([
    ok({
      total: 3,
      has_more: false,
      records: [
        { user_id: "u-01", nick_name: "Chủ nhà", user_type: 50, lock_user_id: 1, effective_flag: 1, time_schedule_info: { permanent: true } },
        { user_id: "u-02", nick_name: "Quản lý", user_type: 10, lock_user_id: 2, effective_flag: 1 },
        {
          user_id: "u-03",
          nick_name: "Người thuê A",
          user_type: 20,
          lock_user_id: "3",
          effective_flag: 0,
          time_schedule_info: { permanent: false, effective_time: 1_760_000_000, expired_time: 1_790_000_000 },
        },
      ],
    }),
  ]);
  const out = await listDeviceUsers(h.client, { deviceId: DEVICE, kind: "access_control", pageSize: 50 });
  assert.deepEqual(route(h.calls), [["GET", `/v1.1/devices/${DEVICE}/users`, { keyword: "", role: "", page_no: "1", page_size: "50" }, undefined]]);
  assert.deepEqual(out, {
    users: [
      { userId: "u-01", name: "Chủ nhà", role: "owner", userType: 50, lockUserId: 1, effective: true },
      { userId: "u-02", name: "Quản lý", role: "admin", userType: 10, lockUserId: 2, effective: true },
      { userId: "u-03", name: "Người thuê A", role: "member", userType: 20, lockUserId: 3, effective: false },
    ],
    total: 3,
    hasMore: false,
  });
});

Deno.test("listDeviceUsers wifi_lock: GET v1.0 users không tham số; chuẩn hoá tối đa có thể", async () => {
  const h = harness([ok([{ user_id: "u-05", nick_name: "Người thuê C", user_type: 2 }, { uid: "u-06", user_name: "Người thuê D" }])]);
  const out = await listDeviceUsers(h.client, { deviceId: DEVICE, kind: "wifi_lock" });
  assert.deepEqual(route(h.calls), [["GET", `/v1.0/devices/${DEVICE}/users`, {}, undefined]]);
  assert.deepEqual(out, {
    users: [
      { userId: "u-05", name: "Người thuê C", role: null, userType: 2, lockUserId: null, effective: null },
      { userId: "u-06", name: "Người thuê D", role: null, userType: null, lockUserId: null, effective: null },
    ],
    total: 2,
    hasMore: false,
  });
});

Deno.test("listUserUnlockMethods: GET opmodes/{user_id} với codes/unlock_name rỗng, trang 1 × 100", async () => {
  const h = harness([
    ok({
      total: 2,
      records: [
        { dp_code: "unlock_fingerprint", unlock_sn: 3, unlock_name: "Ngón trỏ", opmode_id: 101, user_type: 20, phase: 2 },
        { dp_code: "unlock_card", unlock_sn: "7", unlock_name: "Thẻ từ", opmode_id: "op-102", user_type: 20, phase: 2 },
      ],
    }),
  ]);
  const methods = await listUserUnlockMethods(h.client, { deviceId: DEVICE, userId: "u-03" });
  assert.deepEqual(route(h.calls), [[
    "GET",
    `/v1.0/smart-lock/devices/${DEVICE}/opmodes/u-03`,
    { codes: "", unlock_name: "", page_no: "1", page_size: "100" },
    undefined,
  ]]);
  assert.deepEqual(methods, [
    { method: "fingerprint", methodCode: "unlock_fingerprint", sn: 3, name: "Ngón trỏ", opmodeId: 101 },
    { method: "card", methodCode: "unlock_card", sn: 7, name: "Thẻ từ", opmodeId: "op-102" },
  ]);
});

Deno.test("listUnassignedKeys: GET unassigned-keys; nhận cả loại có/không tiền tố unlock_", async () => {
  const h = harness([
    ok({
      unlock_keys: [
        { unlock_no: 4, unlock_type: "fingerprint" },
        { unlock_no: 9, unlock_type: "card" },
        { unlock_no: 2, unlock_type: "unlock_password" },
        { unlock_no: 1, unlock_type: "face" },
      ],
    }),
  ]);
  const keys = await listUnassignedKeys(h.client, { deviceId: DEVICE });
  assert.deepEqual(route(h.calls), [["GET", `/v1.0/devices/${DEVICE}/door-lock/unassigned-keys`, {}, undefined]]);
  assert.deepEqual(keys, [
    { method: "fingerprint", methodCode: "fingerprint", sn: 4 },
    { method: "card", methodCode: "card", sn: 9 },
    { method: "password", methodCode: "unlock_password", sn: 2 },
    { method: "face", methodCode: "face", sn: 1 },
  ]);
});

Deno.test("deleteUnlockMethod: DELETE đúng đường dẫn user-types/users/unlock-types/keys; trả boolean", async () => {
  const h = harness([ok(true), ok(false)]);
  const input: DeleteUnlockMethodInput = { deviceId: DEVICE, userType: 2, userId: "u-03", unlockType: "fingerprint", unlockNo: 4 };
  assert.equal(await deleteUnlockMethod(h.client, input), true);
  assert.equal(await deleteUnlockMethod(h.client, { ...input, userType: 1, unlockType: "card", unlockNo: 0 }), false);
  assert.deepEqual(route(h.calls), [
    ["DELETE", `/v1.0/devices/${DEVICE}/door-lock/user-types/2/users/u-03/unlock-types/fingerprint/keys/4`, {}, undefined],
    ["DELETE", `/v1.0/devices/${DEVICE}/door-lock/user-types/1/users/u-03/unlock-types/card/keys/0`, {}, undefined],
  ]);
});

Deno.test("getPasswordTicket: POST không thân, không Content-Type; chuẩn hoá vé", async () => {
  const h = harness([ok({ ticket_id: "ticket-demo-0001", ticket_key: "17998CA646016FA7F6E78C6E1FD549139173247C8D56147E406EBA159F6E577A", expire_time: 300 })]);
  assert.deepEqual(await getPasswordTicket(h.client, DEVICE), {
    ticketId: "ticket-demo-0001",
    ticketKey: "17998CA646016FA7F6E78C6E1FD549139173247C8D56147E406EBA159F6E577A",
    expireTime: 300,
  });
  assert.deepEqual(route(h.calls), [["POST", TICKET_PATH, {}, undefined]]);
  assert.equal(h.calls[0].bodyText, undefined);
});

Deno.test("createTempPassword: vé giả → giải khoá → mã hoá → POST đúng thân; node giải lại ra đúng mật khẩu", async () => {
  const ticket = fakeTicket("ticket-demo-0001");
  const h = harness([ticket.reply, ok({ id: 5_551_234 })]);
  const out = await createTempPassword(h.client, {
    deviceId: DEVICE,
    name: "  Khách phòng 101  ",
    password: "4829105",
    effectiveSec: 1_760_000_000,
    invalidSec: 1_760_086_400,
    accessSecret: ACCESS_SECRET_EXAMPLE,
  });
  assert.deepEqual(out, { passwordId: 5_551_234 });
  assert.equal(h.calls.length, 2);
  const [ticketCall, createCall] = h.calls;
  assert.deepEqual(route([ticketCall]), [["POST", TICKET_PATH, {}, undefined]]);
  assert.equal(createCall.method, "POST");
  assert.equal(createCall.path, `/v1.0/devices/${DEVICE}/door-lock/temp-password`);
  assert.deepEqual(createCall.query, {});
  const body = createCall.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["name", "password", "password_type", "ticket_id", "effective_time", "invalid_time", "type"]);
  assert.deepEqual(
    { ...body, password: "<mã hoá>" },
    {
      name: "Khách phòng 101",
      password: "<mã hoá>",
      password_type: "ticket",
      ticket_id: "ticket-demo-0001",
      effective_time: 1_760_000_000,
      invalid_time: 1_760_086_400,
      type: 0,
    },
  );
  const encrypted = String(body.password);
  assert.match(encrypted, /^[0-9A-F]{32}$/);
  assert.equal(new TextDecoder().decode(nodeEcb("decrypt", ticket.rawKey, bytes(encrypted))), "4829105");
  // Thân gửi đi không chứa mật khẩu thô; kết quả trả về không chứa mật khẩu nào.
  assert.equal(createCall.bodyText?.includes("4829105"), false);
  assert.equal(JSON.stringify(out).includes(encrypted), false);
  assert.equal(JSON.stringify(out).includes("4829105"), false);

  // Biên: tên đúng 20 ký tự có dấu, mật khẩu 10 chữ số.
  const edge = fakeTicket("ticket-demo-0002");
  const h2 = harness([edge.reply, ok({ id: "77" })]);
  const result = await createTempPassword(h2.client, {
    deviceId: DEVICE,
    name: "ư".repeat(20),
    password: "0123456789",
    effectiveSec: 1_760_000_000,
    invalidSec: 1_760_000_001,
    accessSecret: ACCESS_SECRET_EXAMPLE,
  });
  assert.deepEqual(result, { passwordId: 77 });
  const sent = String((h2.calls[1].body as Record<string, unknown>).password);
  assert.equal(new TextDecoder().decode(nodeEcb("decrypt", edge.rawKey, bytes(sent))), "0123456789");
});

Deno.test("createTempPassword: đầu vào sai bị chặn TRƯỚC khi xin vé; vé sai secret dừng trước khi tạo; id thiếu ⇒ bad_result", async () => {
  const base: CreateTempPasswordInput = {
    deviceId: DEVICE,
    name: "Khách",
    password: "123456",
    effectiveSec: 1_760_000_000,
    invalidSec: 1_760_086_400,
    accessSecret: ACCESS_SECRET_EXAMPLE,
  };
  const bad: Array<[Partial<CreateTempPasswordInput>, typeof TuyaInputError | typeof TuyaConfigError]> = [
    [{ invalidSec: 1_760_000_000 }, TuyaInputError],
    [{ invalidSec: 1_759_999_999 }, TuyaInputError],
    [{ name: "x".repeat(21) }, TuyaInputError],
    [{ name: "   " }, TuyaInputError],
    [{ name: "Khách\nphòng" }, TuyaInputError],
    [{ password: "12345a" }, TuyaInputError],
    [{ password: "12345" }, TuyaInputError],
    [{ password: "12345678901" }, TuyaInputError],
    [{ password: "１２３４５６" }, TuyaInputError],
    [{ effectiveSec: 1_760_000_000_000, invalidSec: 1_760_086_400_000 }, TuyaInputError],
    [{ effectiveSec: 1.5 }, TuyaInputError],
    [{ accessSecret: "ngan-qua" }, TuyaConfigError],
  ];
  const h = harness();
  for (const [patch, errorClass] of bad) {
    await assert.rejects(createTempPassword(h.client, { ...base, ...patch }), errorClass, JSON.stringify(patch));
  }
  assert.equal(h.calls.length + h.tokenCalls(), 0);

  // Vé mã bằng secret khác ⇒ TuyaCryptoError, không gửi lệnh tạo mật khẩu.
  const wrong = fakeTicket("ticket-demo-0003", "Y".repeat(32));
  const h2 = harness([wrong.reply, ok({ id: 1 })]);
  await assert.rejects(createTempPassword(h2.client, base), (error: unknown) => error instanceof TuyaCryptoError);
  assert.deepEqual(h2.calls.map((c) => c.path), [TICKET_PATH]);

  // Tuya báo thành công nhưng thiếu id ⇒ bad_result (không chắc đã tạo hay chưa — rejected = false).
  const h3 = harness([fakeTicket("ticket-demo-0004").reply, ok({})]);
  await assert.rejects(createTempPassword(h3.client, base), isBadResult);
  assert.equal(h3.calls.length, 2);
});

Deno.test("listTempPasswords access_control: valid=true, page_size=50, lật trang last_row_key (đọc cả lastRowKey), bỏ trùng", async () => {
  const h = harness([
    ok({
      has_more: true,
      last_row_key: "row-50",
      records: [{ id: 3001, name: "Khách 1", phase: 2, effective_time: 1_760_000_000, invalid_time: 1_760_086_400, delivery_status: 1 }],
    }),
    ok({
      lastRowKey: "row-51",
      records: [
        { password_id: "3002", name: "Khách 2", phase: 1, effectiveTime: 1_760_000_000_000, invalidTime: 1_760_086_400_000, deliveryStatus: 2 },
        { id: 3001, name: "Khách 1 (trùng)" },
      ],
    }),
    ok({ records: [] }),
  ]);
  const out = await listTempPasswords(h.client, { deviceId: DEVICE, kind: "access_control" });
  const path = `/v1.0/smart-lock/devices/${DEVICE}/stand-by-lock-temp-passwords`;
  assert.deepEqual(route(h.calls), [
    ["GET", path, { page_size: "50", valid: "true" }, undefined],
    ["GET", path, { last_row_key: "row-50", page_size: "50", valid: "true" }, undefined],
    ["GET", path, { last_row_key: "row-51", page_size: "50", valid: "true" }, undefined],
  ]);
  assert.deepEqual(out, {
    passwords: [
      { id: 3001, name: "Khách 1", phase: 2, effectiveSec: 1_760_000_000, invalidSec: 1_760_086_400, deliveryStatus: 1 },
      { id: 3002, name: "Khách 2", phase: 1, effectiveSec: 1_760_000_000, invalidSec: 1_760_086_400, deliveryStatus: 2 },
    ],
    hasMore: false,
  });

  // has_more = false thì dừng dù còn khoá; chạm maxPages thì báo hasMore.
  const stop = harness([ok({ has_more: false, last_row_key: "row-9", records: [{ id: 1 }] })]);
  assert.equal((await listTempPasswords(stop.client, { deviceId: DEVICE, kind: "access_control" })).hasMore, false);
  assert.equal(stop.calls.length, 1);
  const capped = harness([
    ok({ has_more: true, last_row_key: "a", records: [{ id: 1 }] }),
    ok({ has_more: true, last_row_key: "b", records: [{ id: 2 }] }),
  ]);
  const partial = await listTempPasswords(capped.client, { deviceId: DEVICE, kind: "access_control", maxPages: 2 });
  assert.deepEqual([partial.passwords.length, partial.hasMore, capped.calls.length], [2, true, 2]);
});

Deno.test("listTempPasswords wifi_lock: GET door-lock/temp-passwords?valid=true, kết quả mảng", async () => {
  const h = harness([ok([{ id: 4001, name: "Khách 3", phase: 2, effective_time: 1_760_000_000, invalid_time: 1_760_086_400, delivery_status: 1 }])]);
  const out = await listTempPasswords(h.client, { deviceId: DEVICE, kind: "wifi_lock" });
  assert.deepEqual(route(h.calls), [["GET", `/v1.0/devices/${DEVICE}/door-lock/temp-passwords`, { valid: "true" }, undefined]]);
  assert.deepEqual(out, {
    passwords: [{ id: 4001, name: "Khách 3", phase: 2, effectiveSec: 1_760_000_000, invalidSec: 1_760_086_400, deliveryStatus: 1 }],
    hasMore: false,
  });
});

Deno.test("deleteTempPassword: DELETE temp-passwords/{id}; id số hoặc chuỗi chữ số", async () => {
  const h = harness([ok(true), ok(true)]);
  assert.equal(await deleteTempPassword(h.client, { deviceId: DEVICE, passwordId: 3001 }), true);
  assert.equal(await deleteTempPassword(h.client, { deviceId: DEVICE, passwordId: "3002" }), true);
  assert.deepEqual(route(h.calls), [
    ["DELETE", `/v1.0/devices/${DEVICE}/door-lock/temp-passwords/3001`, {}, undefined],
    ["DELETE", `/v1.0/devices/${DEVICE}/door-lock/temp-passwords/3002`, {}, undefined],
  ]);
});

Deno.test("remoteUnlock: xin vé rồi mở — access_control v1.1 có channel_id (mặc định 1), wifi_lock v1.0 chỉ ticket_id", async () => {
  const h = harness([
    ok({ ticket_id: "ticket-a", ticket_key: "00", expire_time: 300 }),
    ok(true),
    ok({ ticket_id: "ticket-b", ticket_key: "00", expire_time: 300 }),
    ok(true),
    ok({ ticket_id: "ticket-c", ticket_key: "00", expire_time: 300 }),
    ok(false),
  ]);
  assert.equal(await remoteUnlock(h.client, { deviceId: DEVICE, kind: "access_control" }), true);
  assert.equal(await remoteUnlock(h.client, { deviceId: DEVICE, kind: "access_control", channelId: 2 }), true);
  assert.equal(await remoteUnlock(h.client, { deviceId: DEVICE, kind: "wifi_lock" }), false);
  assert.deepEqual(route(h.calls), [
    ["POST", TICKET_PATH, {}, undefined],
    ["POST", `/v1.1/devices/${DEVICE}/door-lock/password-free/open-door`, {}, { ticket_id: "ticket-a", channel_id: 1 }],
    ["POST", TICKET_PATH, {}, undefined],
    ["POST", `/v1.1/devices/${DEVICE}/door-lock/password-free/open-door`, {}, { ticket_id: "ticket-b", channel_id: 2 }],
    ["POST", TICKET_PATH, {}, undefined],
    ["POST", `/v1.0/devices/${DEVICE}/door-lock/password-free/open-door`, {}, { ticket_id: "ticket-c" }],
  ]);
});

Deno.test("remoteUnlock: lỗi Tuya / lỗi mạng ⇒ ném, gửi lệnh mở đúng một lần; 1010 ⇒ token mới, gửi lại một lần cùng vé", async () => {
  const ticket = ok({ ticket_id: "ticket-x", ticket_key: "00", expire_time: 300 });
  const offline = harness([ticket, fail(2001, "device is offline")]);
  await assert.rejects(remoteUnlock(offline.client, { deviceId: DEVICE, kind: "access_control" }), (error: unknown) => {
    assert.ok(error instanceof TuyaError);
    assert.deepEqual([error.code, error.rejected, error.path], [2001, true, `/v1.1/devices/${DEVICE}/door-lock/password-free/open-door`]);
    return true;
  });
  assert.equal(offline.calls.length, 2);

  const reset = new TypeError("connection reset");
  const network = harness([ticket, reset]);
  await assert.rejects(remoteUnlock(network.client, { deviceId: DEVICE, kind: "wifi_lock" }), (error: unknown) => error === reset);
  assert.equal(network.calls.length, 2);

  const expired = harness([ticket, fail(1010, "token invalid"), ok(true)]);
  assert.equal(await remoteUnlock(expired.client, { deviceId: DEVICE, kind: "access_control" }), true);
  assert.deepEqual(expired.calls.map((c) => c.body), [undefined, { ticket_id: "ticket-x", channel_id: 1 }, { ticket_id: "ticket-x", channel_id: 1 }]);
  assert.equal(expired.tokenCalls(), 2);
});

Deno.test("id ghép vào đường dẫn được kiểm ở MỌI hàm — không gọi Tuya khi id sai", async () => {
  const badIds: unknown[] = ["", "../x", "a/b", "a b", "a.b", "x".repeat(65), "dev%2F", "dev?x", "dev#x", "ổ", 123, null, undefined];
  const h = harness();
  for (const raw of badIds) {
    const id = raw as string;
    const attempts: Array<() => Promise<unknown>> = [
      () => getDevice(h.client, id),
      () => listRecords(h.client, { deviceId: id, kind: "access_control", startMs: DAY_START, endMs: DAY_END }),
      () => listDeviceUsers(h.client, { deviceId: id, kind: "wifi_lock" }),
      () => listUserUnlockMethods(h.client, { deviceId: id, userId: "u-01" }),
      () => listUserUnlockMethods(h.client, { deviceId: DEVICE, userId: id }),
      () => listUnassignedKeys(h.client, { deviceId: id }),
      () => deleteUnlockMethod(h.client, { deviceId: id, userType: 1, userId: "u-01", unlockType: "card", unlockNo: 1 }),
      () => deleteUnlockMethod(h.client, { deviceId: DEVICE, userType: 1, userId: id, unlockType: "card", unlockNo: 1 }),
      () => getPasswordTicket(h.client, id),
      () =>
        createTempPassword(h.client, {
          deviceId: id,
          name: "Khách",
          password: "123456",
          effectiveSec: 1_760_000_000,
          invalidSec: 1_760_086_400,
          accessSecret: ACCESS_SECRET_EXAMPLE,
        }),
      () => listTempPasswords(h.client, { deviceId: id, kind: "access_control" }),
      () => deleteTempPassword(h.client, { deviceId: id, passwordId: 1 }),
      () => remoteUnlock(h.client, { deviceId: id, kind: "wifi_lock" }),
    ];
    for (const attempt of attempts) await assert.rejects(attempt(), TuyaInputError, String(raw));
  }
  assert.equal(h.calls.length + h.tokenCalls(), 0);
});

Deno.test("tham số số/loại sai bị chặn trước khi gọi Tuya", async () => {
  const h = harness();
  const unlock = { deviceId: DEVICE, userType: 1, userId: "u-01", unlockType: "card", unlockNo: 1 } as DeleteUnlockMethodInput;
  const records: ListRecordsInput = { deviceId: DEVICE, kind: "access_control", startMs: DAY_START, endMs: DAY_END };
  const attempts: Array<[string, () => Promise<unknown>]> = [
    ["userType 3", () => deleteUnlockMethod(h.client, { ...unlock, userType: 3 as 1 })],
    ["unlockType face", () => deleteUnlockMethod(h.client, { ...unlock, unlockType: "face" as "card" })],
    ["unlockNo -1", () => deleteUnlockMethod(h.client, { ...unlock, unlockNo: -1 })],
    ["unlockNo 1.5", () => deleteUnlockMethod(h.client, { ...unlock, unlockNo: 1.5 })],
    ["unlockNo 2^31", () => deleteUnlockMethod(h.client, { ...unlock, unlockNo: 2 ** 31 })],
    ["unlockNo chuỗi lạ", () => deleteUnlockMethod(h.client, { ...unlock, unlockNo: "1/../2" as unknown as number })],
    ["passwordId chữ", () => deleteTempPassword(h.client, { deviceId: DEVICE, passwordId: "abc" })],
    ["passwordId âm", () => deleteTempPassword(h.client, { deviceId: DEVICE, passwordId: -1 })],
    ["passwordId lẻ", () => deleteTempPassword(h.client, { deviceId: DEVICE, passwordId: 1.5 })],
    ["passwordId đường dẫn", () => deleteTempPassword(h.client, { deviceId: DEVICE, passwordId: "1/../2" })],
    ["channelId 0", () => remoteUnlock(h.client, { deviceId: DEVICE, kind: "access_control", channelId: 0 })],
    ["channelId 65", () => remoteUnlock(h.client, { deviceId: DEVICE, kind: "access_control", channelId: 65 })],
    ["kind lạ", () => remoteUnlock(h.client, { deviceId: DEVICE, kind: "zigbee" as DoorKind })],
    ["kind lạ (nhật ký)", () => listRecords(h.client, { ...records, kind: "zigbee" as DoorKind })],
    ["mốc giây truyền nhầm", () => listRecords(h.client, { ...records, startMs: 1_760_000_000, endMs: 1_760_086_400 })],
    ["endMs = startMs", () => listRecords(h.client, { ...records, endMs: DAY_START })],
    ["pageSize 0", () => listRecords(h.client, { ...records, pageSize: 0 })],
    ["pageSize 101", () => listRecords(h.client, { ...records, pageSize: 101 })],
    ["pageNo 0", () => listRecords(h.client, { ...records, pageNo: 0 })],
    ["users pageSize 0", () => listDeviceUsers(h.client, { deviceId: DEVICE, kind: "access_control", pageSize: 0 })],
    ["maxPages 0", () => listProjectDevices(h.client, { maxPages: 0 })],
    ["maxPages 51", () => listTempPasswords(h.client, { deviceId: DEVICE, kind: "access_control", maxPages: 51 })],
  ];
  for (const [label, attempt] of attempts) await assert.rejects(attempt(), TuyaInputError, label);
  assert.equal(h.calls.length + h.tokenCalls(), 0);
});

Deno.test("kết quả sai dạng ⇒ TuyaError bad_result (không trả rỗng), mỗi hàm gọi đúng một lần", async () => {
  const records: ListRecordsInput = { deviceId: DEVICE, kind: "access_control", startMs: DAY_START, endMs: DAY_END };
  const cases: Array<[string, Envelope, (client: TuyaClient) => Promise<unknown>]> = [
    ["thiết bị không phải mảng", ok({ list: "x" }), (c) => listProjectDevices(c)],
    ["thiết bị thiếu id", ok([{ name: "không id" }]), (c) => listProjectDevices(c)],
    ["getDevice chuỗi", ok("x"), (c) => getDevice(c, DEVICE)],
    ["records không phải mảng", ok({ records: "x" }), (c) => listRecords(c, records)],
    ["records kết quả mảng", ok([]), (c) => listRecords(c, records)],
    ["open-logs thiếu logs", ok({ total: 1 }), (c) => listRecords(c, { ...records, kind: "wifi_lock" })],
    ["bản ghi không phải object", ok({ records: [1] }), (c) => listRecords(c, records)],
    ["users thiếu mảng", ok({ total: 1 }), (c) => listDeviceUsers(c, { deviceId: DEVICE, kind: "access_control" })],
    ["opmodes thiếu mảng", ok({}), (c) => listUserUnlockMethods(c, { deviceId: DEVICE, userId: "u-01" })],
    ["unassigned null", ok({ unlock_keys: null }), (c) => listUnassignedKeys(c, { deviceId: DEVICE })],
    ["vé thiếu ticket_key", ok({ ticket_id: "t" }), (c) => getPasswordTicket(c, DEVICE)],
    ["vé ticket_key không hex", ok({ ticket_id: "t", ticket_key: "xyz" }), (c) => getPasswordTicket(c, DEVICE)],
    ["mật khẩu tạm thiếu id", ok([{ name: "không id" }]), (c) => listTempPasswords(c, { deviceId: DEVICE, kind: "wifi_lock" })],
  ];
  for (const [label, reply, call] of cases) {
    const h = harness([reply]);
    await assert.rejects(call(h.client), isBadResult, label);
    assert.equal(h.calls.length, 1, label);
  }
});
