// Test tuyaClient.ts: vector ký chính thức của Tuya, token (giữ/hết hạn/đồng thời/1010), lỗi, hết giờ, allowlist.
// Khoá/id dưới đây là giá trị MẪU trong tài liệu ký của Tuya hoặc tự bịa — không có thông tin thật.
import assert from "node:assert/strict";
import {
  EMPTY_BODY_SHA256,
  sha256Hex,
  signedUrl,
  stringToSign,
  TUYA_HOSTS,
  tuyaBaseUrl,
  TuyaClient,
  TuyaConfigError,
  TuyaError,
  TuyaInputError,
  tuyaSign,
  type TuyaConfig,
  type TuyaDeps,
  type TuyaFetch,
  type TuyaMethod,
} from "./tuyaClient.ts";

// Giá trị MẪU công khai trong mục "Signature method" của tài liệu Tuya — không phải khoá thật. Hậu tố _EXAMPLE để
// cửa quét secret (.gitleaks.toml) nhận ra đây là giá trị ví dụ.
const ACCESS_ID_EXAMPLE = "1KAD46OrT9HafiKdsXeg";
const ACCESS_SECRET_EXAMPLE = "4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC";
const ACCESS_TOKEN_EXAMPLE = "3f4eda2bdec17232f67c0b188af3eec1";
const DOC = {
  accessId: ACCESS_ID_EXAMPLE,
  accessSecret: ACCESS_SECRET_EXAMPLE,
  t: "1588925778000",
  nonce: "5138cc3a9033d69856923fd07b491173",
  signatureHeaders: { area_id: "29a33e8796834b1efa6", call_id: "8afdb70ab2ed11eb85290242ac130003" },
  accessToken: ACCESS_TOKEN_EXAMPLE,
  tokenSign: "9E48A3E93B302EEECC803C7241985D0A34EB944F40FB573C7B5C2A82158AF13E",
  businessSign: "AE4481C692AA80B25F3A7E12C3A5FD9BBF6251539DD78E565A1A72A508A88784",
};
const BASE = "https://openapi.tuyaus.com";
const CONFIG: TuyaConfig = { baseUrl: BASE, accessId: DOC.accessId, accessSecret: DOC.accessSecret };
const T0 = 1_760_000_000_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ success: true, result, t: T0 });
const fail = (code: number | string, msg: string) => json({ success: false, code, msg, t: T0 });

interface Seen {
  url: string;
  path: string;
  init: RequestInit;
  headers: Record<string, string>;
}

/**
 * Máy chủ Tuya giả. Xin token: lấy lần lượt trong `tokens`, hết thì cấp token-1, token-2…; gọi nghiệp vụ: lấy lần lượt
 * trong `replies` (Error ⇒ ném như lỗi mạng). Đồng hồ chỉnh qua `clock.now`.
 */
function setup(options: {
  replies?: Array<Response | Error>;
  tokens?: Array<Response | Error>;
  deps?: TuyaDeps;
  config?: Partial<TuyaConfig>;
} = {}) {
  const seen: Seen[] = [];
  const replies = [...(options.replies ?? [])];
  const tokens = [...(options.tokens ?? [])];
  let issued = 0;
  let nonce = 0;
  const clock = { now: T0 };
  const fetch: TuyaFetch = (url, init) => {
    const path = new URL(url).pathname;
    seen.push({ url, path, init, headers: { ...(init.headers as Record<string, string>) } });
    const next = path === "/v1.0/token"
      ? tokens.shift() ?? ok({ access_token: `token-${++issued}`, expire_time: 7200, refresh_token: "r", uid: "u" })
      : replies.shift() ?? new Error(`Không có trả lời giả cho ${init.method} ${path}`);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const tokenCache = options.deps?.tokenCache ?? new Map();
  const client = new TuyaClient(
    { ...CONFIG, ...options.config },
    { fetch, now: () => clock.now, nonce: () => `nonce${++nonce}`, ...options.deps, tokenCache },
  );
  return {
    client,
    seen,
    clock,
    tokenCache,
    tokenCalls: () => seen.filter((s) => s.path === "/v1.0/token").length,
    businessCalls: () => seen.filter((s) => s.path !== "/v1.0/token"),
  };
}

/** Lỗi phải là TuyaError đúng mã/đường dẫn/loại, và thông điệp không lộ secret hay token. */
function isTuyaError(code: number | string, path: string, rejected: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof TuyaError, String(error));
    assert.equal(error.name, "TuyaError");
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    assert.equal(error.rejected, rejected);
    for (const secret of [DOC.accessSecret, "token-1", "token-2"]) assert.equal(error.message.includes(secret), false, secret);
    return true;
  };
}

Deno.test("ký: vector chính thức của Tuya — lời gọi lấy token và lời gọi nghiệp vụ", async () => {
  assert.equal(await sha256Hex(""), EMPTY_BODY_SHA256);
  const common = {
    accessId: DOC.accessId,
    accessSecret: DOC.accessSecret,
    t: DOC.t,
    nonce: DOC.nonce,
    signatureHeaders: DOC.signatureHeaders,
  };
  assert.equal(await tuyaSign({ ...common, method: "GET", path: "/v1.0/token", query: { grant_type: 1 } }), DOC.tokenSign);
  // Khai tham số ngược thứ tự: chữ ký vẫn phải xếp theo khoá.
  const business = await tuyaSign({
    ...common,
    accessToken: DOC.accessToken,
    method: "GET",
    path: "/v2.0/apps/schema/users",
    query: { page_size: 50, page_no: 1 },
  });
  assert.equal(business, DOC.businessSign);
});

Deno.test("ký: dạng stringToSign — dòng header ký thêm, dòng trống khi không có, url xếp theo khoá", async () => {
  const empty = EMPTY_BODY_SHA256;
  assert.equal(
    await stringToSign({ method: "GET", path: "/v1.0/token", query: { grant_type: 1 } }),
    `GET\n${empty}\n\n/v1.0/token?grant_type=1`,
  );
  assert.equal(
    await stringToSign({ method: "GET", path: "/v1.0/token", query: { grant_type: 1 }, signatureHeaders: DOC.signatureHeaders }),
    `GET\n${empty}\narea_id:29a33e8796834b1efa6\ncall_id:8afdb70ab2ed11eb85290242ac130003\n\n/v1.0/token?grant_type=1`,
  );
  const body = '{"ticket_id":"t1"}';
  assert.equal(await stringToSign({ method: "POST", path: "/v1.0/x", bodyText: body }), `POST\n${await sha256Hex(body)}\n\n/v1.0/x`);
  assert.equal(signedUrl("/p", { b: "2", a: "x y,z", c: undefined, d: "" }), "/p?a=x y,z&b=2&d=");
  assert.equal(signedUrl("/p", {}), "/p");
});

Deno.test("client: request thật mang đúng header và chữ ký của vector Tuya (token rồi nghiệp vụ)", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetch: TuyaFetch = (url, init) => {
    seen.push({ url, init });
    return Promise.resolve(
      url.includes("/v1.0/token") ? ok({ access_token: DOC.accessToken, expire_time: 7200, refresh_token: "r", uid: "u" }) : ok({ list: [] }),
    );
  };
  const client = new TuyaClient(
    { baseUrl: "https://openapi.tuyacn.com/", accessId: DOC.accessId, accessSecret: DOC.accessSecret, signatureHeaders: DOC.signatureHeaders },
    { fetch, now: () => Number(DOC.t), nonce: () => DOC.nonce, tokenCache: new Map() },
  );
  assert.deepEqual(await client.request("GET", "/v2.0/apps/schema/users", { query: { page_no: 1, page_size: 50 } }), { list: [] });
  assert.equal(seen.length, 2);
  const [token, business] = seen;
  const signed = { "Signature-Headers": "area_id:call_id", ...DOC.signatureHeaders };
  const common = { client_id: DOC.accessId, t: DOC.t, sign_method: "HMAC-SHA256", nonce: DOC.nonce };
  assert.equal(token.url, "https://openapi.tuyacn.com/v1.0/token?grant_type=1");
  assert.equal(token.init.method, "GET");
  assert.equal(token.init.body, undefined);
  assert.equal(token.init.redirect, "error");
  assert.ok(token.init.signal instanceof AbortSignal);
  assert.deepEqual(token.init.headers, { ...common, sign: DOC.tokenSign, ...signed });
  assert.equal(business.url, "https://openapi.tuyacn.com/v2.0/apps/schema/users?page_no=1&page_size=50");
  assert.deepEqual(business.init.headers, { ...common, sign: DOC.businessSign, access_token: DOC.accessToken, ...signed });
});

Deno.test("client: ký giá trị THÔ, URL gửi mã hoá %; bỏ undefined, giữ chuỗi rỗng; thân băm = thân gửi", async () => {
  const h = setup({ replies: [ok(1), ok(2), ok(3)] });
  const query = { z: "a,b c", a: "Việt&=?/", empty: "", skip: undefined, n: 5, b: true };
  assert.equal(await h.client.request("GET", "/v1.0/x", { query }), 1);
  const [get] = h.businessCalls();
  assert.equal(get.url, `${BASE}/v1.0/x?a=Vi%E1%BB%87t%26%3D%3F%2F&b=true&empty=&n=5&z=a%2Cb%20c`);
  assert.equal(get.init.body, undefined);
  assert.equal("Content-Type" in get.headers, false);
  const signInput = { accessId: DOC.accessId, accessSecret: DOC.accessSecret, accessToken: "token-1", t: String(T0) };
  assert.equal(get.headers.sign, await tuyaSign({ ...signInput, nonce: get.headers.nonce, method: "GET", path: "/v1.0/x", query }));
  // URL gửi đi giải mã ra đúng bộ tham số đã ký.
  assert.deepEqual(Object.fromEntries(new URL(get.url).searchParams), { a: "Việt&=?/", b: "true", empty: "", n: "5", z: "a,b c" });

  assert.equal(await h.client.request("POST", "/v1.0/y", { body: { b: 1, a: "ư" } }), 2);
  const post = h.businessCalls()[1];
  assert.equal(post.init.body, '{"b":1,"a":"ư"}');
  assert.equal(post.headers["Content-Type"], "application/json");
  const postSign = await tuyaSign({ ...signInput, nonce: post.headers.nonce, method: "POST", path: "/v1.0/y", bodyText: '{"b":1,"a":"ư"}' });
  assert.equal(post.headers.sign, postSign);

  // POST không thân (như xin vé): không Content-Type, băm thân rỗng.
  assert.equal(await h.client.request("POST", "/v1.0/z"), 3);
  const bare = h.businessCalls()[2];
  assert.equal(bare.init.body, undefined);
  assert.equal("Content-Type" in bare.headers, false);
  assert.equal(bare.headers.sign, await tuyaSign({ ...signInput, nonce: bare.headers.nonce, method: "POST", path: "/v1.0/z" }));
  // Mỗi request một nonce mới; t là mốc ms 13 chữ số.
  assert.equal(new Set(h.seen.map((s) => s.headers.nonce)).size, h.seen.length);
  assert.ok(h.seen.every((s) => /^\d{13}$/.test(s.headers.t)));
});

Deno.test("token: hai lời gọi chỉ xin token một lần; client khác cùng kho + cùng accessId dùng chung", async () => {
  const h = setup({ replies: [ok("a"), ok("b")] });
  await h.client.request("GET", "/v1.0/a");
  await h.client.request("GET", "/v1.0/b");
  assert.equal(h.tokenCalls(), 1);
  assert.equal(h.seen[0].headers.access_token, undefined);
  assert.deepEqual(h.businessCalls().map((c) => c.headers.access_token), ["token-1", "token-1"]);

  // Client mới (như request HTTP mới trong cùng isolate) dùng chung kho ⇒ không xin lại.
  const again = setup({ replies: [ok("c")], deps: { tokenCache: h.tokenCache } });
  await again.client.request("GET", "/v1.0/c");
  assert.equal(again.tokenCalls(), 0);
  assert.equal(again.businessCalls()[0].headers.access_token, "token-1");

  // accessId khác ⇒ khoá kho khác ⇒ xin token riêng.
  const other = setup({ replies: [ok("d")], deps: { tokenCache: h.tokenCache }, config: { accessId: "otherAccessId0000001" } });
  await other.client.request("GET", "/v1.0/d");
  assert.equal(other.tokenCalls(), 1);
});

Deno.test("token: hết hạn sớm 60 s so với expire_time; thiếu expire_time thì chỉ dùng cho đúng lời gọi đó", async () => {
  const h = setup({ replies: [ok(1), ok(2), ok(3)] });
  await h.client.request("GET", "/v1.0/a");
  h.clock.now = T0 + 7200 * 1000 - 60_000 - 1;
  await h.client.request("GET", "/v1.0/b");
  assert.equal(h.tokenCalls(), 1);
  h.clock.now = T0 + 7200 * 1000 - 60_000;
  await h.client.request("GET", "/v1.0/c");
  assert.equal(h.tokenCalls(), 2);
  assert.equal(h.businessCalls()[2].headers.access_token, "token-2");

  const once = setup({ replies: [ok(1), ok(2)], tokens: [ok({ access_token: "no-expiry" })] });
  await once.client.request("GET", "/v1.0/a");
  await once.client.request("GET", "/v1.0/b");
  assert.deepEqual(once.businessCalls().map((c) => c.headers.access_token), ["no-expiry", "token-1"]);
});

Deno.test("token: các lời gọi đồng thời dùng chung một lần xin token", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let tokenRequests = 0;
  const fetch: TuyaFetch = async (url, init) => {
    if (!url.includes("/v1.0/token")) return ok(init.method);
    tokenRequests++;
    await gate;
    return ok({ access_token: "shared", expire_time: 7200 });
  };
  const client = new TuyaClient(CONFIG, { fetch, now: () => T0, tokenCache: new Map() });
  const calls = Promise.all([
    client.request("GET", "/v1.0/a"),
    client.request("POST", "/v1.0/b", { body: {} }),
    client.request("DELETE", "/v1.0/c"),
  ]);
  release();
  assert.deepEqual(await calls, ["GET", "POST", "DELETE"]);
  assert.equal(tokenRequests, 1);
});

Deno.test("1010: bỏ token, xin token mới, gửi lại ĐÚNG một lần cùng thân; lời gọi sau dùng token mới", async () => {
  const h = setup({ replies: [fail(1010, "token invalid"), ok("done"), ok("later")] });
  assert.equal(await h.client.request("POST", "/v1.0/devices/d1/open", { body: { ticket_id: "t1" } }), "done");
  const [first, retry] = h.businessCalls();
  assert.equal(h.tokenCalls(), 2);
  assert.equal(first.headers.access_token, "token-1");
  assert.equal(retry.headers.access_token, "token-2");
  assert.equal(retry.url, first.url);
  assert.equal(retry.init.body, first.init.body);
  assert.notEqual(retry.headers.nonce, first.headers.nonce);
  assert.equal(await h.client.request("GET", "/v1.0/x"), "later");
  assert.equal(h.tokenCalls(), 2);
  assert.equal(h.businessCalls()[2].headers.access_token, "token-2");
});

Deno.test("1010 lần hai (mã dạng chuỗi): ném TuyaError, không gửi lần ba", async () => {
  const h = setup({ replies: [fail(1010, "token invalid"), fail("1010", "token invalid")] });
  await assert.rejects(h.client.request("POST", "/v1.0/devices/d1/open", { body: {} }), isTuyaError("1010", "/v1.0/devices/d1/open", true));
  assert.equal(h.businessCalls().length, 2);
  assert.equal(h.tokenCalls(), 2);
});

Deno.test("không thử lại: lỗi Tuya khác, HTTP 5xx, thân không phải JSON, lỗi mạng — mỗi thứ đúng một lần gọi", async () => {
  const offline = setup({ replies: [fail(2001, "device is offline")] });
  await assert.rejects(offline.client.request("POST", "/v1.0/p", { body: { a: 1 } }), (error: unknown) => {
    isTuyaError(2001, "/v1.0/p", true)(error);
    assert.equal((error as TuyaError).msg, "device is offline");
    return true;
  });
  assert.equal(offline.businessCalls().length, 1);

  const http = setup({ replies: [json({ success: true, result: 1 }, 502)] });
  await assert.rejects(http.client.request("POST", "/v1.0/p"), isTuyaError("http_502", "/v1.0/p", false));
  assert.equal(http.businessCalls().length, 1);

  const html = setup({ replies: [new Response("<html>bad gateway</html>", { status: 200 }), json([1, 2])] });
  await assert.rejects(html.client.request("GET", "/v1.0/p"), isTuyaError("bad_json", "/v1.0/p", false));
  await assert.rejects(html.client.request("GET", "/v1.0/q"), isTuyaError("bad_json", "/v1.0/q", false));
  assert.equal(html.businessCalls().length, 2);

  // Thiếu `success` coi là thất bại; thiếu `code` ⇒ "unknown".
  const odd = setup({ replies: [json({ result: 1 })] });
  await assert.rejects(odd.client.request("GET", "/v1.0/p"), isTuyaError("unknown", "/v1.0/p", true));

  const boom = new TypeError("network down");
  const network = setup({ replies: [boom, ok("after")] });
  await assert.rejects(network.client.request("POST", "/v1.0/p", { body: {} }), (error: unknown) => error === boom);
  assert.equal(network.businessCalls().length, 1);
  // Token vẫn tốt: lời gọi kế không xin lại token.
  assert.equal(await network.client.request("GET", "/v1.0/q"), "after");
  assert.equal(network.tokenCalls(), 1);
});

Deno.test("token hỏng: lỗi Tuya / lỗi mạng / thiếu access_token ném ra, kho không giữ lỗi", async () => {
  const rejected = setup({ replies: [ok("x")], tokens: [fail(1004, "sign invalid")] });
  await assert.rejects(rejected.client.request("GET", "/v1.0/a"), isTuyaError(1004, "/v1.0/token", true));
  assert.equal(rejected.businessCalls().length, 0);
  assert.equal(rejected.tokenCache.size, 0);
  assert.equal(await rejected.client.request("GET", "/v1.0/a"), "x");
  assert.equal(rejected.tokenCalls(), 2);

  const dns = new TypeError("dns failure");
  const network = setup({ tokens: [dns] });
  await assert.rejects(network.client.request("GET", "/v1.0/a"), (error: unknown) => error === dns);
  assert.equal(network.tokenCalls(), 1);
  assert.equal(network.tokenCache.size, 0);

  const malformed = setup({ tokens: [ok({ expire_time: 7200 })] });
  await assert.rejects(malformed.client.request("GET", "/v1.0/a"), isTuyaError("bad_token", "/v1.0/token", false));
});

Deno.test("lỗi: msg của Tuya có lỡ chứa secret/token thì bị che", async () => {
  const h = setup({ replies: [fail(2008, `echo ${DOC.accessSecret} with token-1`)] });
  await assert.rejects(h.client.request("GET", "/v1.0/a"), (error: unknown) => {
    isTuyaError(2008, "/v1.0/a", true)(error);
    assert.equal((error as TuyaError).msg, "echo [ẩn] with [ẩn]");
    return true;
  });
});

Deno.test("hết giờ: huỷ request bằng AbortSignal, ném TimeoutError, không gửi lại", async () => {
  let business = 0;
  const fetch: TuyaFetch = (url, init) => {
    if (url.includes("/v1.0/token")) return Promise.resolve(ok({ access_token: "t", expire_time: 7200 }));
    business++;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  };
  const client = new TuyaClient(CONFIG, { fetch, timeoutMs: 20, tokenCache: new Map() });
  await assert.rejects(
    client.request("POST", "/v1.1/devices/d1/door-lock/password-free/open-door", { body: { ticket_id: "t" } }),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
  );
  assert.equal(business, 1);
});

Deno.test("base URL: chỉ https tới máy chủ OpenAPI Tuya trong danh sách; thông điệp lỗi không nhắc URL", () => {
  assert.equal(TUYA_HOSTS.length, 7);
  for (const host of TUYA_HOSTS) {
    assert.equal(tuyaBaseUrl(`https://${host}`), `https://${host}`);
    assert.equal(tuyaBaseUrl(`https://${host}/`), `https://${host}`);
  }
  assert.equal(tuyaBaseUrl("HTTPS://OPENAPI.TUYAEU.COM"), "https://openapi.tuyaeu.com");
  const rejected: unknown[] = [
    "http://openapi.tuyaus.com",
    "https://openapi.tuyaus.com.evil.example",
    "https://evil.example",
    "https://evil.example/openapi.tuyaus.com",
    "https://user:secretpw@openapi.tuyaus.com",
    "https://openapi.tuyaus.com:8443",
    "https://openapi.tuyaus.com/v1.0",
    "https://openapi.tuyaus.com/?x=1",
    "https://openapi.tuyaus.com/#frag",
    "https://openapi.tuyaus.com./",
    "https://127.0.0.1",
    "openapi.tuyaus.com",
    "",
    undefined,
    42,
  ];
  for (const raw of rejected) {
    assert.throws(() => tuyaBaseUrl(raw), (error: unknown) => {
      assert.ok(error instanceof TuyaConfigError, String(raw));
      assert.equal(error.message.includes("secretpw"), false);
      return true;
    });
  }
  let calls = 0;
  const fetch: TuyaFetch = () => {
    calls++;
    return Promise.resolve(ok(null));
  };
  assert.throws(() => new TuyaClient({ ...CONFIG, baseUrl: "https://evil.example" }, { fetch }), TuyaConfigError);
  assert.equal(calls, 0);
});

Deno.test("cấu hình: Access ID/Secret, header ký thêm, timeout sai ⇒ TuyaConfigError", () => {
  const bad: Array<[Partial<TuyaConfig>, TuyaDeps?]> = [
    [{ accessId: "" }],
    [{ accessId: "has space" }],
    [{ accessSecret: "" }],
    [{ signatureHeaders: { sign: "x" } }],
    [{ signatureHeaders: { "Content-Type": "x" } }],
    [{ signatureHeaders: { "bad name": "x" } }],
    [{ signatureHeaders: { area_id: "a\r\nx-injected: 1" } }],
    [{}, { timeoutMs: 0 }],
    [{}, { timeoutMs: 1.5 }],
  ];
  for (const [config, deps] of bad) {
    assert.throws(() => new TuyaClient({ ...CONFIG, ...config }, { tokenCache: new Map(), ...deps }), TuyaConfigError, JSON.stringify(config));
  }
});

Deno.test("đầu vào: đường dẫn/phương thức/tham số/thân sai ⇒ TuyaInputError, không gửi gì (kể cả xin token)", async () => {
  const h = setup();
  const attempts: Array<[string, string, Parameters<TuyaClient["request"]>[2]?]> = [
    ["GET", "v1.0/x"],
    ["GET", "/v1.0/../x"],
    ["GET", "/v1.0/./x"],
    ["GET", "/v1.0//x"],
    ["GET", "/v1.0/x?y=1"],
    ["GET", "/v1.0/x#y"],
    ["GET", "/v1.0/%2e%2e/x"],
    ["GET", "/v1.0/x/"],
    ["PATCH", "/v1.0/x"],
    ["GET", "/v1.0/x", { body: { a: 1 } }],
    ["DELETE", "/v1.0/x", { body: { a: 1 } }],
    ["GET", "/v1.0/x", { query: { "a b": "1" } }],
    ["GET", "/v1.0/x", { query: { "a=b": "1" } }],
    ["GET", "/v1.0/x", { query: { n: Number.NaN } }],
    ["POST", "/v1.0/x", { body: { n: 1n } }],
  ];
  for (const [method, path, options] of attempts) {
    await assert.rejects(h.client.request(method as TuyaMethod, path, options), TuyaInputError, `${method} ${path}`);
  }
  assert.equal(h.seen.length, 0);
});
