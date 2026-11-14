// Edge function: admin-reset-user-password
// Superadmin hoặc chủ công ty đặt mật khẩu mới cho một user KHÁC (14/11/2026).
//
// HỢP ĐỒNG
//   POST JSON { userId: uuid, password: string }, Authorization: Bearer <JWT người bấm>.
//   200 { ok: true, via: "SUPER_ADMIN" | "COMPANY_OWNER" }
//   lỗi { error, message }: 400 invalid_request · 401 unauthorized · 403 forbidden · 405 · 413 · 415
//     · 422 weak_password · 429 rate_limited
//     · 503 service_unavailable — hỏng TRƯỚC khi đổi gì: chắc chắn CHƯA đổi
//     · 502 outcome_unknown — Auth không trả lời rõ: CHƯA BIẾT đã đổi hay chưa
//   Kiểu phía frontend: src/lib/edgeFunctions.ts (test drift đọc thẳng file này).
//
// LUỒNG (khuôn bắt đầu → làm → chốt như door-access)
//   1. RPC user_password_reset_begin_v1 BẰNG JWT NGƯỜI BẤM: SQL kiểm quyền (nguồn duy nhất:
//      app_private.user_password_reset_decision_v1), giới hạn tần suất, ghi dòng PENDING và sự kiện
//      USER_PASSWORD_RESET vào nhật ký phân quyền (đúng người bấm) trong cùng transaction.
//   2. Auth Admin API (khoá service role) đặt mật khẩu. Mật khẩu chỉ đi đúng một nơi là đây,
//      không xuống SQL, không vào log.
//   3. RPC user_password_reset_finish_v1 BẰNG JWT NGƯỜI BẤM kèm mã chốt mà bước 1 chỉ trả cho
//      edge: chốt kết quả (FAILED ghi thêm dòng đính chính). Bước này hỏng thì mật khẩu VẪN đã đổi
//      và nhật ký đã có từ bước 1 ⇒ vẫn trả thành công, chỉ log mã lỗi. Mã chốt không ra khỏi
//      edge: không trả cho trình duyệt, không log.
// Khoá service role chỉ dùng ở bước 2: quyền nằm ở SQL, edge không tự quyết ai được đổi cho ai.
// Mọi lời gọi PostgREST gửi Content-Profile/Accept-Profile: public (thiếu là 503 — bài học gps-checkin-ingest).

export const MIN_PASSWORD_CHARS = 6;
export const MAX_PASSWORD_BYTES = 72;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4 * 1024;
const TIMEOUT_MS = 10_000;
const VIA = ["SUPER_ADMIN", "COMPANY_OWNER"] as const;
type Via = (typeof VIA)[number];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LOI_KHONG_QUYEN = "Bạn không có quyền đặt lại mật khẩu cho tài khoản này.";
const LOI_PHIEN = "Phiên đăng nhập không hợp lệ — đăng nhập lại.";
const LOI_DICH_VU = "Hệ thống chưa đặt lại được mật khẩu (chưa có gì thay đổi). Thử lại sau ít phút.";
const LOI_CHUA_RO = "Chưa xác nhận được mật khẩu đã đổi hay chưa. Thử đăng nhập bằng mật khẩu mới, hoặc đặt lại lần nữa.";

export interface Dependencies {
  env?: (name: string) => string | undefined;
  fetch?: typeof fetch;
}

class HttpFail extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function reply(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Câu báo nếu mật khẩu sai luật; null nếu dùng được. Cùng luật với `adminPasswordProblem` ở frontend. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0) return "Nhập mật khẩu mới.";
  if (!password.isWellFormed()) return "Mật khẩu có ký tự không hợp lệ.";
  if (password !== password.trim()) return "Mật khẩu không được bắt đầu hoặc kết thúc bằng khoảng trắng.";
  if ([...password].length < MIN_PASSWORD_CHARS) return `Mật khẩu phải có ít nhất ${MIN_PASSWORD_CHARS} ký tự.`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return `Mật khẩu quá dài (tối đa ${MAX_PASSWORD_BYTES} byte — chữ có dấu tính 2–3 byte).`;
  }
  return null;
}

async function readBody(request: Request): Promise<{ userId: string; password: string }> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) {
    throw new HttpFail(415, "unsupported_media_type", "Yêu cầu phải là JSON.");
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    throw new HttpFail(413, "payload_too_large", "Yêu cầu quá lớn.");
  }
  let text: string;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) throw new HttpFail(413, "payload_too_large", "Yêu cầu quá lớn.");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof HttpFail) throw error;
    throw new HttpFail(400, "invalid_request", "Yêu cầu không đọc được.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpFail(400, "invalid_request", "Yêu cầu không đọc được.");
  }
  if (!isObject(body) || Object.keys(body).some((k) => k !== "userId" && k !== "password")) {
    throw new HttpFail(400, "invalid_request", "Yêu cầu sai dạng.");
  }
  if (typeof body.userId !== "string" || !UUID.test(body.userId)) {
    throw new HttpFail(400, "invalid_request", "Thiếu tài khoản cần đặt lại mật khẩu.");
  }
  const problem = passwordProblem(body.password);
  if (problem) throw new HttpFail(400, "invalid_request", problem);
  return { userId: body.userId.toLowerCase(), password: body.password as string };
}

type RpcResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code: string; message: string }
  | { ok: false; status: 0; code: "network"; message: "" };

export function createHandler(deps: Dependencies = {}) {
  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  const send = deps.fetch ?? fetch;

  async function rpc(base: string, anonKey: string, bearer: string, name: string, args: Record<string, unknown>): Promise<RpcResult> {
    let response: Response;
    try {
      response = await send(`${base}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          authorization: bearer,
          "content-type": "application/json",
          "content-profile": "public",
          "accept-profile": "public",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 0, code: "network", message: "" };
    }
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.ok) return { ok: true, data };
    const code = isObject(data) && typeof data.code === "string" ? data.code : "";
    const message = isObject(data) && typeof data.message === "string" ? data.message.trim().slice(0, 200) : "";
    return { ok: false, status: response.status, code, message };
  }

  /** Lỗi của bước bắt đầu ⇒ HTTP. Chưa đổi gì, nên không bao giờ là outcome_unknown. */
  function beginFailure(r: Exclude<RpcResult, { ok: true }>): HttpFail {
    if (r.status === 401 || r.code.startsWith("PGRST3")) return new HttpFail(401, "unauthorized", LOI_PHIEN);
    switch (r.code) {
      case "42501":
        return new HttpFail(403, "forbidden", LOI_KHONG_QUYEN);
      case "22023":
        return new HttpFail(400, "invalid_request", r.message || "Yêu cầu không hợp lệ.");
      case "54000":
        return new HttpFail(429, "rate_limited", r.message || "Thao tác quá nhiều lần — thử lại sau ít phút.");
    }
    console.error(`admin-reset-user-password: begin lỗi ${r.status} ${r.code.slice(0, 16) || "-"}`);
    return new HttpFail(503, "service_unavailable", LOI_DICH_VU);
  }

  type AuthOutcome = { outcome: "SUCCEEDED" } | { outcome: "FAILED" | "UNKNOWN"; errorCode: string; fail: HttpFail };

  async function setPassword(base: string, serviceKey: string, userId: string, password: string): Promise<AuthOutcome> {
    let response: Response;
    try {
      response = await send(`${base}/auth/v1/admin/users/${userId}`, {
        method: "PUT",
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      return { outcome: "UNKNOWN", errorCode: timeout ? "auth_timeout" : "auth_unreachable", fail: new HttpFail(502, "outcome_unknown", LOI_CHUA_RO) };
    }
    // Đọc hết thân để không giữ kết nối; không log thân (có thể chứa thông tin người dùng).
    await response.arrayBuffer().catch(() => undefined);
    if (response.ok) return { outcome: "SUCCEEDED" };
    const s = response.status;
    if (s === 422) {
      return { outcome: "FAILED", errorCode: "weak_password", fail: new HttpFail(422, "weak_password", "Mật khẩu chưa đạt yêu cầu bảo mật của hệ thống — chọn mật khẩu dài hơn, khó đoán hơn.") };
    }
    if (s === 404) {
      return { outcome: "FAILED", errorCode: "user_not_found", fail: new HttpFail(400, "invalid_request", "Không tìm thấy tài khoản cần đặt lại mật khẩu.") };
    }
    if (s === 429) {
      return { outcome: "FAILED", errorCode: "auth_rate_limited", fail: new HttpFail(429, "rate_limited", "Hệ thống đăng nhập đang giới hạn — thử lại sau ít phút.") };
    }
    if (s === 400) {
      return { outcome: "FAILED", errorCode: "auth_rejected", fail: new HttpFail(400, "invalid_request", "Hệ thống đăng nhập từ chối mật khẩu này — chọn mật khẩu khác.") };
    }
    if (s === 401 || s === 403) {
      console.error(`admin-reset-user-password: Auth từ chối khoá service role (${s})`);
      return { outcome: "FAILED", errorCode: "auth_config", fail: new HttpFail(503, "service_unavailable", LOI_DICH_VU) };
    }
    console.error(`admin-reset-user-password: Auth trả ${s}`);
    return { outcome: "UNKNOWN", errorCode: "auth_unavailable", fail: new HttpFail(502, "outcome_unknown", LOI_CHUA_RO) };
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
    // Đã gửi yêu cầu đổi tới Auth chưa: sau mốc này mọi lỗi bất ngờ là "chưa rõ", không phải "chưa đổi".
    let daGoiAuth = false;
    try {
      if (request.method !== "POST") throw new HttpFail(405, "method_not_allowed", "Chỉ nhận POST.");
      const bearer = (request.headers.get("authorization") ?? "").trim();
      if (!/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(bearer)) throw new HttpFail(401, "unauthorized", LOI_PHIEN);
      const { userId, password } = await readBody(request);

      const base = env("SUPABASE_URL")?.replace(/\/+$/, "");
      const anonKey = env("SUPABASE_ANON_KEY");
      const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
      if (!base || !anonKey || !serviceKey) {
        console.error("admin-reset-user-password: thiếu biến môi trường Supabase");
        throw new HttpFail(503, "service_unavailable", LOI_DICH_VU);
      }

      const begun = await rpc(base, anonKey, bearer, "user_password_reset_begin_v1", { p_target_user_id: userId });
      if (!begun.ok) throw beginFailure(begun);
      const requestId = isObject(begun.data) ? begun.data.requestId : undefined;
      const via = isObject(begun.data) ? begun.data.via : undefined;
      // Mã chốt chỉ edge cầm (SQL giữ SHA-256): người bấm không tự chốt hộ được dù biết requestId.
      const finishToken = isObject(begun.data) ? begun.data.finishToken : undefined;
      if (typeof requestId !== "string" || !UUID.test(requestId) || !VIA.includes(via as Via)
        || typeof finishToken !== "string" || !/^[0-9a-f]{64}$/.test(finishToken)) {
        console.error("admin-reset-user-password: begin trả sai dạng");
        throw new HttpFail(503, "service_unavailable", LOI_DICH_VU);
      }

      daGoiAuth = true;
      const result = await setPassword(base, serviceKey, userId, password);
      const finished = await rpc(base, anonKey, bearer, "user_password_reset_finish_v1", {
        p_request_id: requestId,
        p_finish_token: finishToken,
        p_outcome: result.outcome,
        p_error_code: result.outcome === "SUCCEEDED" ? null : result.errorCode,
      });
      if (!finished.ok) {
        // Mật khẩu đã/không đổi là sự thật đã xảy ra; nhật ký phân quyền đã ghi ở bước bắt đầu, dòng
        // riêng còn PENDING = "chưa chốt".
        console.error(`admin-reset-user-password: finish lỗi ${finished.status} ${finished.code.slice(0, 16) || "-"}`);
      }
      if (result.outcome !== "SUCCEEDED") throw result.fail;
      return reply(200, { ok: true, via });
    } catch (error) {
      if (error instanceof HttpFail) return reply(error.status, { error: error.code, message: error.message });
      console.error(`admin-reset-user-password: lỗi không lường trước (${daGoiAuth ? "sau" : "trước"} khi gọi Auth)`);
      return daGoiAuth
        ? reply(502, { error: "outcome_unknown", message: LOI_CHUA_RO })
        : reply(503, { error: "service_unavailable", message: LOI_DICH_VU });
    }
  };
}

if (import.meta.main) Deno.serve(createHandler());
