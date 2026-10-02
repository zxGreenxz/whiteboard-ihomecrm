// Test hàm quick-entry: fetch giả mô phỏng Auth, RPC quyền, bảng entitlement, sổ ai_usage_logs và OpenRouter.
import {
  chuanCum,
  coQuyen,
  dauNgayVN,
  dungCumTu,
  MO_HINH_CUM_TU,
  TRAN_CUM_TU,
  TRAN_KY_TU_CUM,
  MOI_LAN_MS,
  NGAN_SACH_MS,
  nenThuMoHinhKe,
  READ_EFFORTS,
  READ_MODEL_CHOICES,
  STT_CHOICES,
  STT_MODELS_MAC_DINH,
  thoiGianLanThu,
  TRAN_AM_THANH_BYTES,
  TRAN_CHU_KY_TU,
  xuLy,
  type PhuThuoc,
} from "./index.ts";

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEquals<T>(actual: T, expected: T, message = "Values differ"): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\nactual: ${a}\nexpected: ${e}`);
}

const ORG = "0e5d1f9a-3c2b-4a1d-9f00-112233445566";
const USER = "7a7a7a7a-0000-4000-8000-000000000001";
const AUDIO = btoa("fake-audio-bytes");
/** base64 của n byte 0, có ký tự đệm "=" đúng như trình duyệt sinh. */
const base64Zero = (n: number) => "A".repeat(Math.floor(n / 3) * 4) + (n % 3 === 1 ? "AA==" : n % 3 === 2 ? "AAA=" : "");

interface Kich {
  mode?: string;
  key?: string;
  /** null = không có biến riêng của quick-entry cho 9router. */
  nineBase?: string | null;
  nineKey?: string | null;
  /** Có NINEROUTER_* của Copilot. */
  copilotNine?: boolean;
  user?: string | null;
  perms?: unknown;
  entitled?: boolean;
  usedTasks?: string[];
  usageReadFails?: boolean;
  /** Ghi dòng giữ chỗ ('pending', trước khi gọi nhà cung cấp) hỏng. */
  reserveFails?: boolean;
  /** Ghi kết quả SAU khi gọi (PATCH dòng giữ chỗ / POST lần thử sau) hỏng. */
  logFails?: boolean;
  dailyCalls?: string;
  upstream?: Array<{ status: number; body: unknown } | "network">;
  /** Mỗi lần gọi nhà cung cấp làm đồng hồ chạy thêm chừng này mili-giây. */
  upstreamMs?: number;
  /** QUICK_ENTRY_CHOICES — "off" tắt lựa chọn mô hình của người dùng. */
  choices?: string;
  /** QUICK_ENTRY_STT_MODELS — chuỗi chép giọng do vận hành đặt. */
  sttModels?: string;
  /** Dữ liệu các nguồn cụm từ ưu tiên (đọc bằng JWT người dùng); vắng ⇒ 404 như bảng chưa có. */
  nguon?: Partial<Record<NguonTen, unknown[]>>;
  /** Đọc nguồn cụm từ ném lỗi mạng. */
  nguonFails?: boolean;
  /** Đọc nguồn chờ promise này rồi mới trả (thử "chờ lười"). */
  nguonCho?: Promise<void>;
  /** Đọc nguồn treo tới khi bị huỷ bằng signal (thử hạn 3 s). */
  nguonTreo?: boolean;
  /** QUICK_ENTRY_STT_HINTS. */
  hints?: string;
}

type NguonTen = "ie_form_buildings" | "building_common_names" | "rooms" | "income_expense_types";
const NGUON_RE = /\/rest\/v1\/(?:rpc\/)?(ie_form_buildings|building_common_names|rooms|income_expense_types)\?/;

const NGUON_MAU: Kich["nguon"] = {
  ie_form_buildings: [
    { id: "b102", name: "102LVT", code: "102LVT" },
    { id: "b1392", name: "1392QT", code: "1392qt, QT, 1392" },
    { id: "b111", name: "111PVC", code: "111" },
  ],
  building_common_names: [
    { building_id: "b102", name: "Lê Văn Thọ" },
    { building_id: "b102", name: "một lẻ hai Lê Văn Thọ" },
    { building_id: "b1392", name: "Quang Trung" },
  ],
  rooms: [{ name: "301" }, { name: "MADRID 3" }, { name: "P204" }, { name: "301" }],
  income_expense_types: [{ name: "bắn foam đường ống đồng" }, { name: "BTaskee" }],
};

function setup(k: Kich = {}) {
  const calls: Array<{ url: string; init?: RequestInit; body?: unknown }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let clock = Date.UTC(2026, 9, 1, 3, 0, 0);
  let seq = 0;
  const upstreamBodies: Array<Record<string, unknown>> = [];
  const upstreamUrls: string[] = [];
  const queue = [...(k.upstream ?? [{ status: 200, body: { text: "mua sơn ba trăm nghìn", usage: { cost: 0.0002, input_tokens: 40, output_tokens: 10 } } }])];
  const env: Record<string, string | undefined> = {
    QUICK_ENTRY_MODE: k.mode ?? "all",
    QUICK_ENTRY_OPENROUTER_KEY: k.key ?? "or-test-key",
    QUICK_ENTRY_NINEROUTER_BASE_URL: k.nineBase === null ? undefined : k.nineBase ?? "https://router.example/v1/",
    QUICK_ENTRY_NINEROUTER_KEY: k.nineKey === null ? undefined : k.nineKey ?? "nr-key",
    NINEROUTER_BASE_URL: k.copilotNine ? "https://copilot-router.example/v1" : undefined,
    NINEROUTER_API_KEY: k.copilotNine ? "copilot-nr-key" : undefined,
    SUPABASE_URL: "https://proj.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    SUPABASE_ANON_KEY: "anon-key",
    QUICK_ENTRY_DAILY_CALLS: k.dailyCalls,
    QUICK_ENTRY_CHOICES: k.choices,
    QUICK_ENTRY_STT_MODELS: k.sttModels,
    QUICK_ENTRY_STT_HINTS: k.hints,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const j = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/auth/v1/user")) return k.user === null ? j(401, {}) : j(200, { id: k.user ?? USER });
    if (url.includes("/rest/v1/rpc/get_my_permissions_v2")) {
      return j(200, k.perms ?? { income_expenses: { create: { org_wide: false, building_ids: ["b1"], cashbook_ids: [] } } });
    }
    if (url.includes("/rest/v1/ai_copilot_entitlements")) return j(200, k.entitled ? [{ chat_enabled: true }] : []);
    const bangNguon = NGUON_RE.exec(url)?.[1] as NguonTen | undefined;
    if (bangNguon) {
      if (k.nguonFails) throw new TypeError("network");
      if (k.nguonTreo) {
        await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError"))));
      }
      if (k.nguonCho) await k.nguonCho;
      const rows = k.nguon?.[bangNguon];
      return rows ? j(200, rows) : j(404, { code: "PGRST205", message: "relation does not exist" });
    }
    if (url.includes("/rest/v1/ai_usage_logs") && (init?.method ?? "GET") === "GET") {
      if (k.usageReadFails) return j(500, { message: "boom" });
      // Đếm cả dòng đã có từ trước lẫn dòng các lượt (kể cả song song) vừa giữ chỗ.
      return j(200, [...(k.usedTasks ?? []).map((t) => ({ task_id: t })), ...logs.map((l) => ({ task_id: l.task_id }))]);
    }
    if (url.includes("/rest/v1/ai_usage_logs") && init?.method === "POST") {
      const row = body as Record<string, unknown>;
      if (row.status === "pending" ? k.reserveFails : k.logFails) throw new Error("db down");
      const id = `log-${++seq}`;
      logs.push({ ...row, id });
      const prefer = new Headers(init?.headers).get("Prefer") ?? "";
      return prefer.includes("return=representation") ? j(201, [{ id }]) : new Response(null, { status: 201 });
    }
    if (url.includes("/rest/v1/ai_usage_logs") && (init?.method === "PATCH" || init?.method === "DELETE")) {
      if (init.method === "PATCH" && k.logFails) throw new Error("db down");
      const id = new URL(url).searchParams.get("id")?.replace(/^eq\./, "");
      const at = logs.findIndex((l) => l.id === id);
      if (at < 0) return j(404, {});
      if (init.method === "DELETE") logs.splice(at, 1);
      else logs[at] = { ...logs[at], ...(body as Record<string, unknown>) };
      return new Response(null, { status: 204 });
    }
    if (url.startsWith("https://openrouter.ai/api/v1/") || url.includes("router.example/v1/")) {
      upstreamUrls.push(url);
      upstreamBodies.push(body as Record<string, unknown>);
      clock += k.upstreamMs ?? 0;
      const next = queue.shift() ?? { status: 500, body: {} };
      if (next === "network") throw new TypeError("network");
      return j(next.status, next.body);
    }
    return j(404, { message: `unexpected ${url}` });
  }) as typeof fetch;
  let idSeq = 0;
  const deps: PhuThuoc = {
    getEnv: (key) => env[key],
    fetchImpl,
    now: () => clock,
    newId: () => `11111111-2222-4333-8444-${String(555555555555 + idSeq++).padStart(12, "0")}`,
  };
  return { deps, calls, logs, upstreamBodies, upstreamUrls };
}

const sttReq = (body: unknown = { format: "webm", data: AUDIO, language: "vi" }, headers: Record<string, string> = {}) =>
  new Request("https://proj.supabase.co/functions/v1/quick-entry/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer user-jwt", "x-organization-id": ORG, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const readReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://proj.supabase.co/functions/v1/quick-entry/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer user-jwt", "x-organization-id": ORG, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const codeOf = async (r: Response) => ((await r.json()) as { error?: { code?: string } }).error?.code;
const openrouterCalls = (calls: Array<{ url: string }>) =>
  calls.filter((c) => c.url.startsWith("https://openrouter.ai") || c.url.includes("router.example/v1/")).length;

Deno.test("OPTIONS ⇒ CORS cho header thử lại và lộ header tên mô hình", async () => {
  const { deps } = setup();
  const r = await xuLy(new Request("https://x/functions/v1/quick-entry/chat/completions", { method: "OPTIONS" }), deps);
  assertEquals(r.status, 204);
  assert(r.headers.get("Access-Control-Allow-Headers")!.includes("x-quick-entry-skip"));
  assert(r.headers.get("Access-Control-Expose-Headers")!.includes("x-quick-entry-model"));
});

Deno.test("đường lạ ⇒ 404; GET ⇒ 405; content-length vượt trần ⇒ 413 — trước mọi truy vấn", async () => {
  const { deps, calls } = setup();
  assertEquals((await xuLy(new Request("https://x/functions/v1/quick-entry/khac", { method: "POST", body: "{}" }), deps)).status, 404);
  assertEquals((await xuLy(new Request("https://x/functions/v1/quick-entry/chat/completions"), deps)).status, 405);
  const big = await xuLy(
    new Request("https://x/functions/v1/quick-entry/audio/transcriptions", { method: "POST", headers: { "content-length": String(900 * 1024) }, body: "{}" }),
    deps,
  );
  assertEquals(big.status, 413);
  assertEquals(calls.length, 0);
});

Deno.test("công tắc off / thiếu khoá ⇒ quick_entry_disabled, không gọi gì", async () => {
  for (const k of [{ mode: "off" }, { mode: "lung tung" }, { key: "" }] as Kich[]) {
    const { deps, calls } = setup(k);
    const r = await xuLy(sttReq(), deps);
    assertEquals(r.status, 403);
    assertEquals(await codeOf(r), "quick_entry_disabled");
    assertEquals(calls.length, 0);
  }
});

Deno.test("thiếu JWT ⇒ 401; JWT không hợp lệ ⇒ 401", async () => {
  const { deps } = setup();
  const r1 = await xuLy(new Request("https://x/functions/v1/quick-entry/audio/transcriptions", { method: "POST", body: "{}" }), deps);
  assertEquals(r1.status, 401);
  const r2 = await xuLy(sttReq(), setup({ user: null }).deps);
  assertEquals(r2.status, 401);
});

Deno.test("thiếu / sai công ty ⇒ organization_required", async () => {
  const { deps } = setup();
  const r = await xuLy(sttReq(undefined, { "x-organization-id": "khong-phai-uuid" }), deps);
  assertEquals(await codeOf(r), "organization_required");
});

Deno.test("quyền: đọc bằng JWT của người dùng; không có quyền nào ⇒ not_permitted, không gọi OpenRouter", async () => {
  const { deps, calls } = setup({ perms: { income_expenses: { view: true } } });
  const r = await xuLy(sttReq(), deps);
  assertEquals(r.status, 403);
  assertEquals(await codeOf(r), "not_permitted");
  const rpc = calls.find((c) => c.url.includes("get_my_permissions_v2"))!;
  assertEquals((rpc.init!.headers as Record<string, string>).Authorization, "Bearer user-jwt");
  assertEquals((rpc.body as { p_org: string }).p_org, ORG);
  assertEquals(openrouterCalls(calls), 0);
});

Deno.test("coQuyen khớp giao diện: superadmin, boolean v1, org_wide, toà, sổ; vắng khoá ⇒ không", () => {
  assert(coQuyen({ __superadmin: true }, "income_expenses", "create"));
  assert(coQuyen({ personal_finance: { create: true } }, "personal_finance", "create"));
  assert(!coQuyen({ personal_finance: { create: false } }, "personal_finance", "create"));
  assert(coQuyen({ income_expenses: { create: { org_wide: true } } }, "income_expenses", "create"));
  assert(coQuyen({ income_expenses: { create: { building_ids: [], cashbook_ids: ["c1"] } } }, "income_expenses", "create"));
  assert(!coQuyen({ income_expenses: { create: { org_wide: false, building_ids: [], cashbook_ids: [] } } }, "income_expenses", "create"));
  assert(!coQuyen({}, "income_expenses", "create"));
  assert(!coQuyen(null, "income_expenses", "create"));
});

Deno.test("chỉ có quyền Ví cá nhân vẫn được dùng", async () => {
  const { deps } = setup({ perms: { personal_finance: { create: true } } });
  assertEquals((await xuLy(sttReq(), deps)).status, 200);
});

Deno.test("chế độ thử: không có Copilot ⇒ not_entitled; có Copilot ⇒ được; super admin bỏ qua", async () => {
  const r1 = await xuLy(sttReq(), setup({ mode: "pilot", entitled: false }).deps);
  assertEquals(await codeOf(r1), "not_entitled");
  assertEquals((await xuLy(sttReq(), setup({ mode: "pilot", entitled: true }).deps)).status, 200);
  assertEquals((await xuLy(sttReq(), setup({ mode: "pilot", entitled: false, perms: { __superadmin: true } }).deps)).status, 200);
});

Deno.test("trần lượt/ngày đếm TASK khác nhau; đủ trần ⇒ quick_entry_daily_cap; không đọc được sổ ⇒ chặn", async () => {
  const ok = await xuLy(sttReq(), setup({ dailyCalls: "3", usedTasks: ["a", "a", "b"] }).deps);
  assertEquals(ok.status, 200);
  const het = await xuLy(sttReq(), setup({ dailyCalls: "3", usedTasks: ["a", "b", "c"] }).deps);
  assertEquals(await codeOf(het), "quick_entry_daily_cap");
  const hong = await xuLy(sttReq(), setup({ usageReadFails: true }).deps);
  assertEquals(await codeOf(hong), "quick_entry_daily_cap");
  const { calls } = setup();
  await xuLy(sttReq(), setup().deps);
  assert(calls.length === 0);
});

Deno.test("trần ngày tính từ 00:00 giờ Việt Nam", () => {
  // 01/10/2026 03:00 UTC = 10:00 VN ⇒ đầu ngày VN = 30/09 17:00 UTC
  assertEquals(dauNgayVN(Date.UTC(2026, 9, 1, 3, 0, 0)), "2026-09-30T17:00:00.000Z");
  // 30/09 18:00 UTC = 01/10 01:00 VN ⇒ vẫn là ngày 01/10 VN
  assertEquals(dauNgayVN(Date.UTC(2026, 8, 30, 18, 0, 0)), "2026-09-30T17:00:00.000Z");
});

Deno.test("nhận giọng: tiếng Việt, mp4 của iPhone gửi thành m4a, trả chữ + tên mô hình, ghi sổ một dòng", async () => {
  const { deps, upstreamBodies, logs } = setup();
  const r = await xuLy(sttReq({ format: "mp4", data: AUDIO }), deps);
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { text: "mua sơn ba trăm nghìn" });
  assertEquals(r.headers.get("x-quick-entry-model"), "google/chirp-3");
  assertEquals(upstreamBodies[0], { model: "google/chirp-3", language: "vi", input_audio: { data: AUDIO, format: "m4a" } });
  assertEquals(logs.length, 1);
  assertEquals(logs[0].feature, "quick_entry");
  assertEquals(logs[0].status, "ok");
  assertEquals(logs[0].organization_id, ORG);
  assertEquals(logs[0].user_id, USER);
  assertEquals(logs[0].cost_usd, 0.0002);
  assertEquals(logs[0].task_id, "qe:11111111-2222-4333-8444-555555555555");
});

Deno.test("nhận giọng: định dạng lạ ⇒ 400; base64 hỏng ⇒ 400; quá dài ⇒ 413 — không gọi OpenRouter", async () => {
  for (const [body, status] of [
    [{ format: "flac-x", data: AUDIO }, 400],
    [{ format: "webm", data: "không phải base64!" }, 400],
    [{ format: "webm", data: base64Zero(TRAN_AM_THANH_BYTES + 3) }, 413],
  ] as const) {
    const { deps, calls } = setup();
    assertEquals((await xuLy(sttReq(body), deps)).status, status);
    assertEquals(openrouterCalls(calls), 0);
  }
});

Deno.test("nhận giọng: đúng trần byte thô (cả ba kiểu ký tự đệm) ⇒ nhận; thêm 1 byte ⇒ 413", async () => {
  for (const n of [TRAN_AM_THANH_BYTES - 2, TRAN_AM_THANH_BYTES - 1, TRAN_AM_THANH_BYTES]) {
    const { deps } = setup();
    assertEquals((await xuLy(sttReq({ format: "mp4", data: base64Zero(n) }), deps)).status, 200, `n=${n}`);
  }
  const { deps, calls } = setup();
  assertEquals((await xuLy(sttReq({ format: "mp4", data: base64Zero(TRAN_AM_THANH_BYTES + 1) }), deps)).status, 413);
  assertEquals(openrouterCalls(calls), 0);
});

Deno.test("trần âm thanh chứa được 30 giây ở 128 kbps (trình duyệt bỏ qua gợi ý bitrate) + vỏ mp4", () => {
  assert(TRAN_AM_THANH_BYTES >= (128_000 / 8) * 30 + 20_000, `trần ${TRAN_AM_THANH_BYTES}`);
});

Deno.test("mô hình đầu lỗi tạm (503) ⇒ mô hình kế; sổ ghi hai dòng cùng task", async () => {
  const { deps, logs } = setup({ upstream: [{ status: 503, body: {} }, { status: 200, body: { text: "keo hai mươi nghìn" } }] });
  const r = await xuLy(sttReq(), deps);
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("x-quick-entry-model"), "deepgram/nova-3");
  assertEquals(r.headers.get("x-quick-entry-attempts"), "2");
  assertEquals(logs.map((l) => l.status), ["upstream_error", "ok"]);
  assertEquals(new Set(logs.map((l) => l.task_id)).size, 1);
});

Deno.test("mất mạng tới OpenRouter ⇒ thử mô hình kế", async () => {
  const { deps } = setup({ upstream: ["network", { status: 200, body: { text: "ok" } }] });
  assertEquals((await xuLy(sttReq(), deps)).status, 200);
});

Deno.test("hết tiền (402) / khoá sai (401) ⇒ dừng ngay, không đốt mô hình khác ⇒ quick_entry_all_failed", async () => {
  for (const status of [402, 401]) {
    const { deps, calls } = setup({ upstream: [{ status, body: { error: { message: "x" } } }, { status: 200, body: { text: "ok" } }] });
    const r = await xuLy(sttReq(), deps);
    assertEquals(r.status, 502);
    assertEquals(await codeOf(r), "quick_entry_all_failed");
    assertEquals(openrouterCalls(calls), 1);
  }
  assert(!nenThuMoHinhKe(402) && !nenThuMoHinhKe(401) && nenThuMoHinhKe(429) && nenThuMoHinhKe(0) && nenThuMoHinhKe(503));
});

Deno.test("ghi KẾT QUẢ hỏng (sau khi gọi) không làm hỏng câu trả lời — dòng giữ chỗ vẫn tính lượt", async () => {
  const { deps, logs } = setup({ logFails: true });
  assertEquals((await xuLy(sttReq(), deps)).status, 200);
  assertEquals(logs.map((l) => l.status), ["pending"]);
});

Deno.test("giữ chỗ TRƯỚC khi gọi nhà cung cấp: dòng 'pending' ghi trước, rồi mới gọi", async () => {
  const { deps, calls, logs } = setup();
  assertEquals((await xuLy(sttReq(), deps)).status, 200);
  const giu = calls.findIndex((c) => c.url.includes("/rest/v1/ai_usage_logs") && c.init?.method === "POST");
  const goi = calls.findIndex((c) => c.url.startsWith("https://openrouter.ai"));
  assert(giu >= 0 && giu < goi, `giữ chỗ ở ${giu}, gọi ở ${goi}`);
  assertEquals((calls[giu].body as { status: string }).status, "pending");
  assertEquals(logs.map((l) => l.status), ["ok"]);
});

Deno.test("không ghi được dòng giữ chỗ ⇒ 503, KHÔNG gọi nhà cung cấp (trần không bị lách)", async () => {
  const { deps, calls } = setup({ reserveFails: true });
  const r = await xuLy(sttReq(), deps);
  assertEquals(r.status, 503);
  assertEquals(await codeOf(r), "quick_entry_unavailable");
  assertEquals(openrouterCalls(calls), 0);
});

Deno.test("vượt trần SAU khi giữ chỗ ⇒ 429 và xoá dòng giữ chỗ của mình (không ăn lượt)", async () => {
  const { deps, logs, calls } = setup({ dailyCalls: "3", usedTasks: ["a", "b", "c"] });
  assertEquals(await codeOf(await xuLy(sttReq(), deps)), "quick_entry_daily_cap");
  assertEquals(logs.length, 0);
  assertEquals(openrouterCalls(calls), 0);
});

Deno.test("hai lượt SONG SONG khi chỉ còn một chỗ ⇒ nhiều nhất một lượt được gọi nhà cung cấp", async () => {
  const s = setup({ dailyCalls: "3", usedTasks: ["a", "b"], upstream: [{ status: 200, body: { text: "một" } }, { status: 200, body: { text: "hai" } }] });
  const [r1, r2] = await Promise.all([xuLy(sttReq(), s.deps), xuLy(sttReq(), s.deps)]);
  assert([r1.status, r2.status].filter((x) => x === 200).length <= 1, `${r1.status} ${r2.status}`);
  assert(openrouterCalls(s.calls) <= 1, `${openrouterCalls(s.calls)} lần gọi`);
});

Deno.test("chữ gửi AI quá dài ⇒ 400, không gọi nhà cung cấp (hàm không thành proxy LLM đa dụng)", async () => {
  const { deps, calls } = setup();
  const dai = [{ role: "system", content: "x".repeat(TRAN_CHU_KY_TU + 1) }, { role: "user", content: "đọc" }];
  assertEquals((await xuLy(readReq({ messages: dai }), deps)).status, 400);
  assertEquals(openrouterCalls(calls), 0);
});

Deno.test("ngân sách thời gian: lần thử kẹp theo phần còn lại; còn quá ít thì không mở lần mới", () => {
  assertEquals(thoiGianLanThu(40_000, 0), 25_000);
  assertEquals(thoiGianLanThu(40_000, 30_000), 10_000);
  assertEquals(thoiGianLanThu(40_000, 38_000), 0);
});

Deno.test("chép giọng hết ngân sách (khớp client chờ 45 s) ⇒ dừng, không thử mô hình thứ ba", async () => {
  const s = setup({ upstreamMs: 20_000, upstream: [{ status: 503, body: {} }, { status: 503, body: {} }, { status: 200, body: { text: "muộn" } }] });
  assertEquals((await xuLy(sttReq(), s.deps)).status, 502);
  assertEquals(openrouterCalls(s.calls), 2);
});

const messages = [
  { role: "system", content: "Bạn là trợ lý" },
  { role: "user", content: [{ type: "text", text: "đọc bill" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] },
];

Deno.test("AI đọc đi 9ROUTER (không OpenRouter): chỉ chuyển khoá cho phép, ép JSON, kẹp max_tokens; trả dạng OpenAI", async () => {
  const { deps, upstreamBodies, upstreamUrls, logs } = setup({
    upstream: [{ status: 200, body: { choices: [{ message: { content: '{"items":[]}' } }], usage: { prompt_tokens: 900, completion_tokens: 40 } } }],
  });
  const r = await xuLy(readReq({ model: "quick_entry:auto", messages, max_tokens: 99999, tools: [{ x: 1 }], temperature: 2 }), deps);
  assertEquals(r.status, 200);
  const out = (await r.json()) as { choices: Array<{ message: { content: string } }> };
  assertEquals(out.choices[0].message.content, '{"items":[]}');
  assertEquals(r.headers.get("x-quick-entry-model"), "cx/gpt-6-luna(low)");
  assertEquals(r.headers.get("x-quick-entry-index"), "0");
  assertEquals(upstreamUrls[0], "https://router.example/v1/chat/completions");
  const sent = upstreamBodies[0];
  assertEquals(Object.keys(sent).sort(), ["max_tokens", "messages", "model", "response_format", "stream"]);
  assertEquals(sent.model, "cx/gpt-6-luna(low)");
  assertEquals(sent.max_tokens, 4000);
  assertEquals(sent.response_format, { type: "json_object" });
  assertEquals(logs[0].provider, "9router");
  assertEquals(logs[0].total_tokens, 940);
});

Deno.test("chép giọng đi OPENROUTER, sổ ghi provider openrouter", async () => {
  const { deps, upstreamUrls, logs } = setup();
  await xuLy(sttReq(), deps);
  assertEquals(upstreamUrls[0], "https://openrouter.ai/api/v1/audio/transcriptions");
  assertEquals(logs[0].provider, "openrouter");
});

Deno.test("thiếu cấu hình 9router ⇒ CHỈ đường đọc tắt; chép giọng vẫn chạy", async () => {
  const k: Kich = { nineBase: null, nineKey: null };
  assertEquals(await codeOf(await xuLy(readReq({ messages }), setup(k).deps)), "quick_entry_disabled");
  assertEquals((await xuLy(sttReq(), setup(k).deps)).status, 200);
});

Deno.test("thiếu khoá OpenRouter ⇒ CHỈ chép giọng tắt; đọc vẫn chạy", async () => {
  const k: Kich = { key: "", upstream: [{ status: 200, body: { choices: [{ message: { content: "{}" } }] } }] };
  assertEquals(await codeOf(await xuLy(sttReq(), setup(k).deps)), "quick_entry_disabled");
  assertEquals((await xuLy(readReq({ messages }), setup(k).deps)).status, 200);
});

Deno.test("không có biến riêng ⇒ dùng NINEROUTER_* của Copilot", async () => {
  const s = setup({ nineBase: null, nineKey: null, copilotNine: true, upstream: [{ status: 200, body: { choices: [{ message: { content: "{}" } }] } }] });
  assertEquals((await xuLy(readReq({ messages }), s.deps)).status, 200);
  assertEquals(s.upstreamUrls[0], "https://copilot-router.example/v1/chat/completions");
});

Deno.test("địa chỉ 9router không phải https ⇒ coi như chưa cấu hình", async () => {
  const s = setup({ nineBase: "http://10.0.0.1:20128/v1" });
  assertEquals(await codeOf(await xuLy(readReq({ messages }), s.deps)), "quick_entry_disabled");
  assertEquals(openrouterCalls(s.calls), 0);
});

Deno.test("AI đọc: header thử lại ⇒ bỏ qua mô hình đầu; bị kẹp trong chuỗi", async () => {
  const one = setup({ upstream: [{ status: 200, body: { choices: [{ message: { content: "{}" } }] } }] });
  await xuLy(readReq({ messages }, { "x-quick-entry-skip": "1" }), one.deps);
  assertEquals(one.upstreamBodies[0].model, "cx/gpt-5.6-luna(low)");
  const big = setup({ upstream: [{ status: 200, body: { choices: [{ message: { content: "{}" } }] } }] });
  const r = await xuLy(readReq({ messages }, { "x-quick-entry-skip": "99" }), big.deps);
  assertEquals(r.headers.get("x-quick-entry-index"), "1");
});

Deno.test("AI đọc: nội dung rỗng ⇒ mô hình kế", async () => {
  const { deps } = setup({
    upstream: [
      { status: 200, body: { choices: [{ message: { content: "" } }] } },
      { status: 200, body: { choices: [{ message: { content: "{}" } }] } },
    ],
  });
  const r = await xuLy(readReq({ messages }), deps);
  assertEquals(r.headers.get("x-quick-entry-index"), "1");
});

Deno.test("AI đọc: hai ảnh ⇒ too_many_images; ảnh không phải data URL ⇒ 400; vai lạ ⇒ 400", async () => {
  const hai = [{ role: "user", content: [messages[1].content[1], messages[1].content[1]] }];
  const r1 = await xuLy(readReq({ messages: hai }), setup().deps);
  assertEquals(await codeOf(r1), "too_many_images");
  const url = [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://evil/x.png" } }] }];
  assertEquals((await xuLy(readReq({ messages: url }), setup().deps)).status, 400);
  const tool = [{ role: "tool", content: "x" }];
  assertEquals((await xuLy(readReq({ messages: tool }), setup().deps)).status, 400);
});

Deno.test("thân không phải JSON ⇒ invalid_json", async () => {
  const req = new Request("https://x/functions/v1/quick-entry/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer user-jwt", "x-organization-id": ORG },
    body: "{không phải json",
  });
  assertEquals(await codeOf(await xuLy(req, setup().deps)), "invalid_json");
});

// ---------------------------------------------------------------------------------------------------
// Ô chọn mô hình trên trang (chủ muốn tự thử và so sánh): client gửi `model`; máy chủ CHỈ nhận id trong
// danh sách cho phép, thử nó TRƯỚC rồi mới tới chuỗi mặc định (bỏ trùng).

Deno.test("chọn mô hình giọng nói trong danh sách ⇒ thử nó trước, lỗi thì tới chuỗi mặc định (không lặp lại)", async () => {
  const { deps, upstreamBodies } = setup({ upstream: [{ status: 503, body: {} }, { status: 200, body: { text: "ok" } }] });
  const r = await xuLy(sttReq({ format: "webm", data: AUDIO, model: "openai/whisper-1" }), deps);
  assertEquals(r.status, 200);
  assertEquals(upstreamBodies.map((b) => b.model), ["openai/whisper-1", "google/chirp-3"]);
  assertEquals(r.headers.get("x-quick-entry-model"), "google/chirp-3");
  const { deps: d2, upstreamBodies: u2 } = setup();
  await xuLy(sttReq({ format: "webm", data: AUDIO, model: "deepgram/nova-3" }), d2);
  assertEquals(u2[0].model, "deepgram/nova-3");
});

Deno.test("mô hình giọng nói NGOÀI danh sách (kể cả gpt-4o bịa chữ khi ồn) ⇒ bỏ qua, dùng chuỗi mặc định", async () => {
  for (const model of ["openai/gpt-4o-transcribe", "anthropic/claude-opus", 123, ""]) {
    const { deps, upstreamBodies } = setup();
    await xuLy(sttReq({ format: "webm", data: AUDIO, model }), deps);
    assertEquals(upstreamBodies[0].model, "google/chirp-3", String(model));
  }
});

Deno.test("chọn mô hình đọc + mức suy nghĩ hợp lệ ⇒ gọi đúng id đó trước; header báo đúng mô hình trả lời", async () => {
  for (const model of ["cx/gpt-6.1-sol(high)", "cx/gpt-6-astra", "cx/gpt-6-luna(ultra)", "cx/gpt-5.6-luna(minimal)"]) {
    const s = setup({ upstream: [{ status: 200, body: { choices: [{ message: { content: "{}" } }] } }] });
    const r = await xuLy(readReq({ model, messages }), s.deps);
    assertEquals(s.upstreamBodies[0].model, model);
    assertEquals(r.headers.get("x-quick-entry-model"), model);
  }
});

Deno.test("mô hình đọc ngoài danh sách / tổ hợp không hỗ trợ (Astra + minimal) / mức lạ ⇒ chuỗi mặc định", async () => {
  for (const model of ["cx/gpt-6-astra(minimal)", "cx/gpt-reserve", "cx/gpt-6-luna(turbo)", "ag/gemini-3.8-flash", "quick_entry:auto"]) {
    const s = setup({ upstream: [{ status: 200, body: { choices: [{ message: { content: "{}" } }] } }] });
    await xuLy(readReq({ model, messages }), s.deps);
    assertEquals(s.upstreamBodies[0].model, "cx/gpt-6-luna(low)", model);
  }
});

Deno.test("đã chọn mô hình đọc + header thử lại ⇒ bỏ qua mô hình đã chọn, sang chuỗi mặc định", async () => {
  const s = setup({ upstream: [{ status: 200, body: { choices: [{ message: { content: "{}" } }] } }] });
  await xuLy(readReq({ model: "cx/gpt-6-sol(low)", messages }, { "x-quick-entry-skip": "1" }), s.deps);
  assertEquals(s.upstreamBodies[0].model, "cx/gpt-6-luna(low)");
});

Deno.test("đường đọc: một lần thử được tới 35 s (mức suy nghĩ cao, ảnh bill); đường giọng vẫn 25 s", () => {
  assertEquals(thoiGianLanThu(NGAN_SACH_MS.read, 0, MOI_LAN_MS.read), 35_000);
  assertEquals(thoiGianLanThu(NGAN_SACH_MS.read, 40_000, MOI_LAN_MS.read), 10_000);
  assertEquals(thoiGianLanThu(NGAN_SACH_MS.stt, 0, MOI_LAN_MS.stt), 25_000);
  // Mốc chờ của client: đọc 60 s, giọng 45 s (AI_TIMEOUT_MS / STT_TIMEOUT_MS ở useQuickEntryFeed.ts).
  assert(NGAN_SACH_MS.read <= 50_000 && NGAN_SACH_MS.stt <= 35_000, "ngân sách chừa >=10 s cho tải lên/kiểm quyền dưới mốc chờ của client");
});

Deno.test("không gửi model ⇒ chuỗi vận hành đặt qua biến môi trường quyết định mô hình đầu", async () => {
  const { deps, upstreamBodies } = setup({ sttModels: "openai/whisper-1,google/chirp-3" });
  await xuLy(sttReq({ format: "webm", data: AUDIO }), deps);
  assertEquals(upstreamBodies[0].model, "openai/whisper-1");
});

Deno.test("QUICK_ENTRY_CHOICES=off ⇒ bỏ qua lựa chọn của người dùng (vận hành ép chuỗi khi một mô hình hỏng)", async () => {
  const { deps, upstreamBodies } = setup({ choices: "off", sttModels: "openai/whisper-1" });
  await xuLy(sttReq({ format: "webm", data: AUDIO, model: "google/chirp-3" }), deps);
  assertEquals(upstreamBodies[0].model, "openai/whisper-1");
});

Deno.test("danh sách lựa chọn: 5 mô hình giọng nói; mặc định nằm trong danh sách", () => {
  assertEquals(STT_CHOICES.length, 5);
  assert(STT_MODELS_MAC_DINH.every((m) => STT_CHOICES.includes(m)));
  assert(READ_MODEL_CHOICES.includes("cx/gpt-6-luna") && READ_EFFORTS.includes("low"));
});

// ── Cụm từ ưu tiên cho chirp-3 ─────────────────────────────────────────────────────────────────────

type PhraseBody = {
  provider?: { options?: Record<string, { config?: { adaptation?: { phraseSets?: Array<{ inlinePhraseSet?: { phrases?: Array<{ value: string }> } }> } } }> };
};
const phrasesOf = (b: Record<string, unknown>) =>
  (b as PhraseBody).provider?.options?.["google-vertex"]?.config?.adaptation?.phraseSets?.[0]?.inlinePhraseSet?.phrases?.map((p) => p.value) ??
    null;
const docNguon = (calls: Array<{ url: string; init?: RequestInit }>) =>
  calls.filter((c) => NGUON_RE.test(c.url));

Deno.test("dungCumTu: mã in hoa, bỏ mã toàn số, tên toà, tên thường gọi + 'số nhà + tên', hạng mục, phòng", () => {
  const out = dungCumTu({
    buildings: NGUON_MAU!.ie_form_buildings as never,
    commonNames: NGUON_MAU!.building_common_names as never,
    rooms: NGUON_MAU!.rooms as never,
    categories: NGUON_MAU!.income_expense_types as never,
  });
  assertEquals(out, [
    "102LVT",
    "1392QT",
    "QT",
    "111PVC",
    "Lê Văn Thọ",
    "102 Lê Văn Thọ",
    "một lẻ hai Lê Văn Thọ",
    "Quang Trung",
    "1392 Quang Trung",
    "bắn foam đường ống đồng",
    "BTaskee",
    "phòng 301",
    "phòng MADRID 3",
    "P204",
  ]);
});

Deno.test("dungCumTu: bỏ trùng không phân biệt hoa/thường, bỏ cụm sai kiểu/1 ký tự/quá 100 ký tự, gộp khoảng trắng", () => {
  const out = dungCumTu({
    buildings: [{ id: "b", name: "  Kho   Văn\nPhòng Chung ", code: "VP, vp, 15" }],
    commonNames: [{ building_id: "b", name: "x" }, { building_id: "b", name: "a".repeat(TRAN_KY_TU_CUM + 1) }, { building_id: "b", name: 42 }],
    rooms: [{ name: null }, { name: "" }],
    categories: [{ name: "kho văn phòng chung" }, { name: "a".repeat(TRAN_KY_TU_CUM) }],
  });
  assertEquals(out, ["VP", "Kho Văn Phòng Chung", "a".repeat(TRAN_KY_TU_CUM)]);
  assertEquals(chuanCum(" a\tb "), "a b");
  assertEquals(chuanCum("a"), null);
});

Deno.test("dungCumTu: cắt đúng ở TRAN_CUM_TU (dưới trần 1.000 đo được), toà/tên thường gọi đứng trước", () => {
  const categories = Array.from({ length: 2000 }, (_, i) => ({ name: `hạng mục ${i}` }));
  const out = dungCumTu({
    buildings: [{ id: "b", name: "102LVT", code: "102LVT" }],
    commonNames: [{ building_id: "b", name: "Lê Văn Thọ" }],
    rooms: [],
    categories,
  });
  assertEquals(out.length, TRAN_CUM_TU);
  assert(TRAN_CUM_TU < 1000);
  assertEquals(out.slice(0, 3), ["102LVT", "Lê Văn Thọ", "102 Lê Văn Thọ"]);
});

Deno.test("dungCumTu: tên đường mở đầu bằng MỘT từ chỉ số vẫn được ghép số nhà; cách đọc số (≥2 từ) thì không", () => {
  const out = dungCumTu({
    buildings: [{ id: "b", name: "102HBT", code: "102HBT" }],
    commonNames: ["Hai Bà Trưng", "Ba Tháng Hai", "Nam Kỳ Khởi Nghĩa", "một lẻ hai Hai Bà Trưng", "mười lăm KV"].map((name) => ({ building_id: "b", name })),
    rooms: [],
    categories: [],
  });
  for (const ten of ["Hai Bà Trưng", "Ba Tháng Hai", "Nam Kỳ Khởi Nghĩa"]) assert(out.includes(`102 ${ten}`), ten);
  assert(!out.includes("102 một lẻ hai Hai Bà Trưng") && !out.includes("102 mười lăm KV"));
});

Deno.test("dungCumTu: tên thường gọi của toà KHÔNG có trong danh sách toà (đã xoá, ngoài phạm vi) ⇒ bỏ", () => {
  const out = dungCumTu({
    buildings: [{ id: "b102", name: "102LVT", code: "102LVT" }],
    commonNames: [{ building_id: "b102", name: "Lê Văn Thọ" }, { building_id: "b-da-xoa", name: "Gò Vấp" }],
    rooms: [],
    categories: [],
  });
  assertEquals(out, ["102LVT", "Lê Văn Thọ", "102 Lê Văn Thọ"]);
  // Không đọc được danh sách toà ⇒ vẫn gửi tên thường gọi, chỉ thiếu cụm ghép số nhà.
  const khongDs = dungCumTu({ buildings: [], commonNames: [{ building_id: "b102", name: "Lê Văn Thọ" }], rooms: [], categories: [] });
  assertEquals(khongDs, ["Lê Văn Thọ"]);
});

Deno.test("chirp-3: gửi cụm từ đúng dạng OpenRouter chuyển tiếp (google-vertex.config.adaptation), header báo số cụm", async () => {
  const { deps, upstreamBodies, calls } = setup({ nguon: NGUON_MAU });
  const r = await xuLy(sttReq(), deps);
  assertEquals(r.status, 200);
  assertEquals(upstreamBodies[0].model, MO_HINH_CUM_TU);
  const phrases = phrasesOf(upstreamBodies[0])!;
  assertEquals(phrases.length, 14);
  assert(phrases.includes("102 Lê Văn Thọ") && phrases.includes("phòng MADRID 3"));
  assertEquals(r.headers.get("x-quick-entry-hints"), "14");
  assert(r.headers.get("Access-Control-Expose-Headers")!.includes("x-quick-entry-hints"));
  // Không gửi boost: đo 02/10 boost 10/20 ra y hệt không boost.
  assert(!JSON.stringify(upstreamBodies[0]).includes("boost"));
  // Bốn nguồn đọc bằng JWT CỦA NGƯỜI DÙNG; toà qua đúng RPC của trang; lọc công ty ở mọi nguồn có cột công ty
  // (ie_form_buildings không trả cột này — giống trang).
  const doc = docNguon(calls);
  assertEquals(doc.length, 4);
  for (const c of doc) {
    assertEquals((c.init!.headers as Record<string, string>).Authorization, "Bearer user-jwt");
    if (!c.url.includes("/rpc/ie_form_buildings?")) assert(c.url.includes(`organization_id=eq.${ORG}`), c.url);
  }
  // RPC phải nói rõ schema public (schema REST mặc định là api ⇒ thiếu header là 404 im lặng, mất nguồn toà).
  assert(doc.some((c) =>
    c.url.includes("/rest/v1/rpc/ie_form_buildings?") && c.init?.method === "POST" &&
    (c.init.headers as Record<string, string>)["Content-Profile"] === "public"
  ));
  for (const c of doc) assertEquals((c.init!.headers as Record<string, string>)["Accept-Profile"], "public");
  assert(doc.some((c) => c.url.includes("/rest/v1/rooms?") && c.url.includes("deleted_at=is.null")));
  assert(doc.some((c) => c.url.includes("/rest/v1/building_common_names?")));
  // Không có restricted_create ⇒ bỏ hạng mục hạn chế (như danh sách của trang).
  assert(doc.some((c) =>
    c.url.includes("income_expense_types?") && c.url.includes("type=eq.expense") && c.url.includes("system_only=is.false") &&
    c.url.includes("is_restricted=is.false")
  ));
  // Đọc nguồn bắt đầu TRƯỚC khi giữ chỗ ai_usage_logs (song song với bước giữ chỗ/đếm trần).
  const giuCho = calls.findIndex((c) => c.url.includes("/rest/v1/ai_usage_logs") && c.init?.method === "POST");
  assert(calls.findIndex((c) => NGUON_RE.test(c.url)) < giuCho, "đọc nguồn phải bắt đầu trước bước giữ chỗ");
});

Deno.test("có restricted_create ⇒ gửi cả hạng mục hạn chế", async () => {
  const perms = { income_expenses: { create: { org_wide: true }, restricted_create: { org_wide: true } } };
  const { deps, calls } = setup({ nguon: NGUON_MAU, perms });
  await xuLy(sttReq(), deps);
  const cat = docNguon(calls).find((c) => c.url.includes("income_expense_types?"))!;
  assert(!cat.url.includes("is_restricted"), cat.url);
});

Deno.test("chỉ có quyền Ví cá nhân ⇒ không đọc dữ liệu công ty, chép như cũ", async () => {
  const { deps, calls, upstreamBodies } = setup({ nguon: NGUON_MAU, perms: { personal_finance: { create: true } } });
  assertEquals((await xuLy(sttReq(), deps)).status, 200);
  assertEquals(docNguon(calls).length, 0);
  assertEquals(phrasesOf(upstreamBodies[0]), null);
});

Deno.test("chọn nova-3 ⇒ không chờ đọc cụm từ (chỉ chờ trước lần gọi chirp-3)", async () => {
  let mo: () => void = () => {};
  const cho = new Promise<void>((r) => (mo = r));
  const s = setup({ nguon: NGUON_MAU, nguonCho: cho });
  let hen: ReturnType<typeof setTimeout> | undefined;
  const ketQua = await Promise.race([
    xuLy(sttReq({ format: "webm", data: AUDIO, model: "deepgram/nova-3" }), s.deps),
    new Promise<"treo">((r) => (hen = setTimeout(() => r("treo"), 500))),
  ]);
  clearTimeout(hen);
  mo();
  assert(ketQua !== "treo", "lần thử nova-3 bị chặn chờ đọc cụm từ");
  assertEquals((ketQua as Response).status, 200);
  assertEquals(s.upstreamBodies[0].model, "deepgram/nova-3");
});

Deno.test("đọc nguồn treo ⇒ bỏ sau 3 s, chép chirp-3 không gợi ý", async () => {
  const s = setup({ nguonTreo: true, nguon: NGUON_MAU });
  let hen: ReturnType<typeof setTimeout> | undefined;
  const ketQua = await Promise.race([
    xuLy(sttReq(), s.deps),
    new Promise<"treo">((r) => (hen = setTimeout(() => r("treo"), 6_000))),
  ]);
  clearTimeout(hen);
  assert(ketQua !== "treo", "đọc nguồn không có hạn");
  assertEquals((ketQua as Response).status, 200);
  assertEquals(s.upstreamBodies[0], { model: MO_HINH_CUM_TU, language: "vi", input_audio: { data: AUDIO, format: "webm" } });
});

Deno.test("mô hình khác chirp-3 KHÔNG nhận cụm từ (payload cũ); chirp-3 dự phòng phía sau thì có", async () => {
  const s = setup({ nguon: NGUON_MAU, upstream: [{ status: 503, body: {} }, { status: 200, body: { text: "ok" } }] });
  await xuLy(sttReq({ format: "webm", data: AUDIO, model: "deepgram/nova-3" }), s.deps);
  assertEquals(s.upstreamBodies[0], { model: "deepgram/nova-3", language: "vi", input_audio: { data: AUDIO, format: "webm" } });
  assertEquals(s.upstreamBodies[1].model, MO_HINH_CUM_TU);
  assertEquals(phrasesOf(s.upstreamBodies[1])!.length, 14);
});

Deno.test("chuỗi không có chirp-3 ⇒ không đọc nguồn cụm từ", async () => {
  const { deps, calls } = setup({ nguon: NGUON_MAU, sttModels: "openai/whisper-1", choices: "off" });
  await xuLy(sttReq(), deps);
  assertEquals(docNguon(calls).length, 0);
});

Deno.test("Google từ chối bộ cụm từ (400) ⇒ thử lại CHÍNH chirp-3 không cụm từ rồi mới tới mô hình kế", async () => {
  const s = setup({
    nguon: NGUON_MAU,
    upstream: [{ status: 400, body: { error: { message: "Provider returned 400" } } }, { status: 200, body: { text: "102LVT mua sơn" } }],
  });
  const r = await xuLy(sttReq(), s.deps);
  assertEquals(r.status, 200);
  assertEquals(s.upstreamBodies.map((b) => b.model), [MO_HINH_CUM_TU, MO_HINH_CUM_TU]);
  assertEquals(phrasesOf(s.upstreamBodies[0])!.length, 14);
  assertEquals(phrasesOf(s.upstreamBodies[1]), null);
  assertEquals(r.headers.get("x-quick-entry-model"), MO_HINH_CUM_TU);
  assertEquals(r.headers.get("x-quick-entry-attempts"), "2");
  assertEquals(r.headers.get("x-quick-entry-hints"), "0");
  assertEquals(s.logs.map((l) => l.error_detail), ["stt:400:cum_tu=14", null]);
});

Deno.test("400 lần nữa khi đã bỏ cụm từ ⇒ sang mô hình kế (không lặp chirp-3 mãi)", async () => {
  const s = setup({
    nguon: NGUON_MAU,
    upstream: [{ status: 400, body: {} }, { status: 400, body: {} }, { status: 200, body: { text: "ok" } }],
  });
  const r = await xuLy(sttReq(), s.deps);
  assertEquals(r.status, 200);
  assertEquals(s.upstreamBodies.map((b) => b.model), [MO_HINH_CUM_TU, MO_HINH_CUM_TU, "deepgram/nova-3"]);
});

Deno.test("lỗi thường của chirp-3 (503) khi có cụm từ ⇒ sang mô hình kế, không thử lại chirp-3", async () => {
  const s = setup({ nguon: NGUON_MAU, upstream: [{ status: 503, body: {} }, { status: 200, body: { text: "ok" } }] });
  await xuLy(sttReq(), s.deps);
  assertEquals(s.upstreamBodies.map((b) => b.model), [MO_HINH_CUM_TU, "deepgram/nova-3"]);
});

Deno.test("đọc nguồn hỏng (mạng / bảng chưa có) ⇒ chép như cũ, không chặn", async () => {
  for (const k of [{ nguonFails: true }, {}, { nguon: { ie_form_buildings: NGUON_MAU!.ie_form_buildings } }] as Kich[]) {
    const s = setup(k);
    const r = await xuLy(sttReq(), s.deps);
    assertEquals(r.status, 200);
    const phrases = phrasesOf(s.upstreamBodies[0]);
    // Chỉ có bảng toà ⇒ vẫn gửi mã toà; không có gì ⇒ payload cũ.
    if (k.nguon) assertEquals(phrases, ["102LVT", "1392QT", "QT", "111PVC"]);
    else assertEquals(s.upstreamBodies[0], { model: MO_HINH_CUM_TU, language: "vi", input_audio: { data: AUDIO, format: "webm" } });
  }
});

Deno.test("QUICK_ENTRY_STT_HINTS=off ⇒ không đọc nguồn, không gửi cụm từ", async () => {
  const { deps, calls, upstreamBodies } = setup({ nguon: NGUON_MAU, hints: "OFF" });
  await xuLy(sttReq(), deps);
  assertEquals(docNguon(calls).length, 0);
  assertEquals(phrasesOf(upstreamBodies[0]), null);
});

Deno.test("đường đọc chữ/ảnh không đọc nguồn cụm từ", async () => {
  const { deps, calls } = setup({ nguon: NGUON_MAU, upstream: [{ status: 200, body: { choices: [{ message: { content: "{}" } }] } }] });
  await xuLy(readReq({ messages: [{ role: "user", content: "mua sơn" }] }), deps);
  assertEquals(docNguon(calls).length, 0);
});

Deno.test("vượt trần lượt/ngày ⇒ vẫn chặn dù nguồn cụm từ đọc song song", async () => {
  const s = setup({ nguon: NGUON_MAU, dailyCalls: "1", usedTasks: ["a"] });
  const r = await xuLy(sttReq(), s.deps);
  assertEquals(await codeOf(r), "quick_entry_daily_cap");
  assertEquals(openrouterCalls(s.calls), 0);
});
