// Hàm máy chủ của trang "Báo chi nhanh" (/chi-tieu). Tách khỏi llm-proxy để Copilot không đổi một byte.
//
//   POST …/quick-entry/audio/transcriptions  { format, data (base64), language? }  ⇒ { text }
//   POST …/quick-entry/chat/completions      { messages, max_tokens? } (OpenAI)  ⇒ phản hồi OpenAI
//                                             + header x-quick-entry-model / -index / -attempts
//
// Chủ chốt 01/10/2026: CHÉP GIỌNG qua OpenRouter (khoá riêng `QUICK_ENTRY_OPENROUTER_KEY`), ĐỌC chữ/ảnh
// qua 9router (`QUICK_ENTRY_NINEROUTER_BASE_URL/_KEY`, thiếu thì dùng NINEROUTER_* của Copilot). Mỗi
// đường đi theo CHUỖI mô hình: lỗi tạm thời (mạng, hết giờ, 408/409/425/429/5xx, mô hình không có) ⇒
// thử mô hình kế; lỗi thuộc tài khoản (401/402) thì mô hình nào cũng hỏng nên dừng ngay. Thiếu cấu
// hình của đường nào thì CHỈ đường đó tắt.
//
// KHÔNG cần migration:
//   - quyền   = get_my_permissions_v2(p_org) gọi bằng JWT của chính người dùng — cùng nguồn giao diện đọc;
//               cần income_expenses.create HOẶC personal_finance.create ở công ty đang chọn;
//   - sổ phí  = ai_usage_logs, feature 'quick_entry', mỗi lần gọi mô hình một dòng (service role);
//   - trần    = số LƯỢT (task) trong ngày giờ VN đếm trên chính bảng đó (QUICK_ENTRY_DAILY_CALLS);
//   - công tắc = QUICK_ENTRY_MODE: off (mặc định) | pilot (chỉ người có Copilot) | all.
//
// Không lưu, không ghi log nội dung âm thanh hay chữ của người dùng.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-copilot-feature, x-task-id, x-organization-id, x-quick-entry-skip",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-quick-entry-model, x-quick-entry-index, x-quick-entry-attempts",
};

/** Đo 01/10/2026 trên 8 câu báo chi tiếng Việt: gpt-4o-transcribe 8/8 số tiền đúng, ~0,9 s. */
export const STT_MODELS_MAC_DINH = ["openai/gpt-4o-transcribe", "openai/gpt-4o-mini-transcribe", "google/gemini-3.5-transcribe"];
/** 9router, đo 01/10/2026 bằng prompt thật: cx/gpt-6-luna(low) đọc đúng chữ + bill có giảm giá, ~5 s.
 *  ag/* trả nội dung RỖNG với khuôn JSON nên không đưa vào chuỗi. */
export const READ_MODELS_MAC_DINH = ["cx/gpt-6-luna(low)", "cx/gpt-5.6-luna(low)"];
export const LUOT_NGAY_MAC_DINH = 150;
/** Âm thanh tối đa (560 KB) hoặc ảnh bill đã nén (≤360 KB) sau base64 + JSON vẫn dưới trần này. */
export const TRAN_BODY_BYTES = 768 * 1024;
/** Byte âm thanh THÔ. Client gợi ý 48 kbps (30 giây ≈ 180 KB) nhưng trình duyệt được phép bỏ qua gợi ý:
 *  30 giây ở 128 kbps = 480 KB + vỏ mp4 vẫn phải lọt. Client dùng đúng số này (MAX_AUDIO_BYTES). */
export const TRAN_AM_THANH_BYTES = 560_000;
export const TRAN_MAX_TOKENS = 1500;
const MOI_LAN_MS = 25_000;
const NGAN_SACH_MS = 50_000;
export const OPENROUTER = "https://openrouter.ai/api/v1";

/** Định dạng client gửi ⇒ định dạng OpenRouter nhận (iPhone ghi ra mp4 = AAC, OpenRouter gọi là m4a). */
export const DINH_DANG_AM_THANH: Record<string, string> = {
  webm: "webm",
  ogg: "ogg",
  wav: "wav",
  mp3: "mp3",
  m4a: "m4a",
  mp4: "m4a",
  aac: "aac",
};

type Route = "stt" | "read";
type Perms = Record<string, unknown> | null;

export interface PhuThuoc {
  getEnv?: (key: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  newId?: () => string;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", ...extra } });

/** Mã lỗi khớp `classifyAiError` của client (src/lib/quickEntry/errors.ts). */
const loi = (status: number, code: string, message: string) => json(status, { error: { code, message } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function docOrganizationId(headers: Headers): string | null {
  const raw = (headers.get("x-organization-id") ?? "").trim().toLowerCase();
  return UUID_RE.test(raw) ? raw : null;
}

const dsChuoi = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * "Có quyền này ở đâu đó trong công ty không" — chép đúng `canUse(perms, module, action)` không truyền toà
 * của giao diện (src/lib/permissionPages.ts): sentinel __superadmin; boolean (v1); object (v2) = org_wide
 * hoặc có ít nhất một toà/sổ; vắng khoá = không có quyền.
 */
export function coQuyen(perms: Perms, module: string, action: string): boolean {
  if (!perms || typeof perms !== "object") return false;
  if (perms.__superadmin) return true;
  const mod = perms[module];
  const raw = mod && typeof mod === "object" ? (mod as Record<string, unknown>)[action] : undefined;
  if (typeof raw === "boolean") return raw;
  if (!raw || typeof raw !== "object") return false;
  const scope = raw as { org_wide?: unknown; building_ids?: unknown; cashbook_ids?: unknown };
  if (scope.org_wide === true) return true;
  return dsChuoi(scope.building_ids).length > 0 || dsChuoi(scope.cashbook_ids).length > 0;
}

/** 00:00 hôm nay theo giờ Việt Nam (UTC+7), dạng ISO UTC. */
export function dauNgayVN(nowMs: number): string {
  const vn = nowMs + 7 * 3600_000;
  const midnightVn = vn - (vn % 86_400_000);
  return new Date(midnightVn - 7 * 3600_000).toISOString();
}

export function chuoiMoHinh(raw: string | undefined, macDinh: string[]): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:()-]+$/.test(s));
  return list.length ? [...new Set(list)].slice(0, 5) : macDinh;
}

/**
 * Lỗi upstream nào đáng thử mô hình kế. 401/402 KHÔNG có trong danh sách: đó là chuyện của khoá/tài
 * khoản (sai khoá, hết tiền) ⇒ mô hình nào cũng hỏng, thử tiếp chỉ đốt thời gian người dùng.
 */
export function nenThuMoHinhKe(status: number): boolean {
  return status === 0 || status === 400 || status === 403 || status === 404 || status === 408 || status === 409 ||
    status === 425 || status === 429 || status >= 500;
}

interface KetQuaGoi {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  cost: number;
  tokens: { prompt: number; completion: number; total: number };
}

const so = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

async function goiNhaCungCap(f: typeof fetch, base: string, key: string, path: string, payload: unknown): Promise<KetQuaGoi> {
  let res: Response;
  try {
    res = await f(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(MOI_LAN_MS),
    });
  } catch {
    return { ok: false, status: 0, body: null, cost: 0, tokens: { prompt: 0, completion: 0, total: 0 } };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const usage = (body?.usage ?? {}) as Record<string, unknown>;
  const prompt = so(usage.prompt_tokens ?? usage.input_tokens);
  const completion = so(usage.completion_tokens ?? usage.output_tokens);
  return {
    ok: res.ok,
    status: res.status,
    body,
    cost: so(usage.cost),
    tokens: { prompt, completion, total: so(usage.total_tokens) || prompt + completion },
  };
}

// ---------------------------------------------------------------------------------------------------
// Kiểm đầu vào từng route. Chỉ chuyển tiếp những khoá cần — khoá lạ của client không tới upstream.

type DauVao = { ok: true; payload: (model: string) => Record<string, unknown> } | { ok: false; res: Response };

export function dauVaoNhanGiong(body: Record<string, unknown>): DauVao {
  const fmt = DINH_DANG_AM_THANH[String(body.format ?? "").toLowerCase()];
  if (!fmt) return { ok: false, res: loi(400, "bad_request", "Định dạng âm thanh không hỗ trợ.") };
  const data = body.data;
  if (typeof data !== "string" || data.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(data)) {
    return { ok: false, res: loi(400, "bad_request", "Âm thanh phải là base64.") };
  }
  // Byte thô = 3/4 độ dài base64 trừ ký tự đệm "=" (không trừ thì bản ghi đúng trần bị báo quá dài).
  const dem = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (Math.floor((data.length * 3) / 4) - dem > TRAN_AM_THANH_BYTES) {
    return { ok: false, res: loi(413, "payload_too_large", "Đoạn ghi âm quá dài.") };
  }
  const lang = typeof body.language === "string" && /^[a-z]{2}$/.test(body.language) ? body.language : "vi";
  return { ok: true, payload: (model) => ({ model, language: lang, input_audio: { data, format: fmt } }) };
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export function dauVaoDocChu(body: Record<string, unknown>): DauVao {
  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) {
    return { ok: false, res: loi(400, "bad_request", "messages không hợp lệ.") };
  }
  let anh = 0;
  const messages: Array<{ role: "system" | "user"; content: string | Part[] }> = [];
  for (const m of raw) {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if (role !== "system" && role !== "user") return { ok: false, res: loi(400, "bad_request", "Vai tin nhắn không hợp lệ.") };
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) return { ok: false, res: loi(400, "bad_request", "Nội dung tin nhắn không hợp lệ.") };
    const parts: Part[] = [];
    for (const p of content) {
      const t = (p as { type?: unknown })?.type;
      if (t === "text" && typeof (p as { text?: unknown }).text === "string") {
        parts.push({ type: "text", text: (p as { text: string }).text });
      } else if (t === "image_url") {
        const url = (p as { image_url?: { url?: unknown } }).image_url?.url;
        if (typeof url !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/.test(url)) {
          return { ok: false, res: loi(400, "bad_request", "Ảnh phải là data URL png/jpeg/webp.") };
        }
        anh += 1;
        parts.push({ type: "image_url", image_url: { url } });
      } else {
        return { ok: false, res: loi(400, "bad_request", "Phần nội dung không hợp lệ.") };
      }
    }
    messages.push({ role, content: parts });
  }
  if (anh > 1) return { ok: false, res: loi(400, "too_many_images", "Mỗi lần chỉ gửi một ảnh.") };
  const max = Number(body.max_tokens);
  const maxTokens = Number.isInteger(max) && max > 0 ? Math.min(max, TRAN_MAX_TOKENS) : TRAN_MAX_TOKENS;
  return {
    ok: true,
    payload: (model) => ({
      model,
      messages,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      stream: false,
    }),
  };
}

// ---------------------------------------------------------------------------------------------------

export async function xuLy(req: Request, deps: PhuThuoc = {}): Promise<Response> {
  const env = deps.getEnv ?? ((k: string) => Deno.env.get(k));
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return loi(405, "method_not_allowed", "Chỉ nhận POST.");
  const path = new URL(req.url).pathname;
  const route: Route | null = path.endsWith("/audio/transcriptions") ? "stt" : path.endsWith("/chat/completions") ? "read" : null;
  if (!route) return loi(404, "not_found", "Không có đường này.");
  const khai = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(khai) && khai > TRAN_BODY_BYTES) return loi(413, "payload_too_large", "Gói gửi lên quá lớn.");

  // Công tắc và cấu hình nhà cung cấp CỦA ĐƯỜNG NÀY trước mọi truy vấn: tắt là tắt, không tốn một
  // lượt gọi database nào; thiếu khoá 9router không làm tắt chép giọng và ngược lại.
  const mode = (env("QUICK_ENTRY_MODE") ?? "off").trim();
  const ncc = route === "stt"
    ? { ten: "openrouter", base: OPENROUTER, key: (env("QUICK_ENTRY_OPENROUTER_KEY") ?? "").trim() }
    : {
      ten: "9router",
      base: (env("QUICK_ENTRY_NINEROUTER_BASE_URL") || env("NINEROUTER_BASE_URL") || "").trim().replace(/\/+$/, ""),
      key: (env("QUICK_ENTRY_NINEROUTER_KEY") || env("NINEROUTER_API_KEY") || "").trim(),
    };
  if ((mode !== "pilot" && mode !== "all") || !ncc.key || !/^https:\/\//.test(ncc.base)) {
    return loi(403, "quick_entry_disabled", "AI của Báo chi nhanh đang tắt. Bạn vẫn nhập tay được.");
  }

  const supabaseUrl = env("SUPABASE_URL") ?? "";
  const service = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apikey = env("SUPABASE_ANON_KEY") || service;
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return loi(401, "unauthorized", "Thiếu phiên đăng nhập.");

  let userId: string | null = null;
  try {
    const r = await f(`${supabaseUrl}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey } });
    const u = r.ok ? ((await r.json()) as { id?: unknown }) : null;
    userId = typeof u?.id === "string" ? u.id : null;
  } catch {
    userId = null;
  }
  if (!userId) return loi(401, "unauthorized", "Phiên đăng nhập không hợp lệ.");

  const org = docOrganizationId(req.headers);
  if (!org) return loi(400, "organization_required", "Chưa chọn công ty.");

  // Quyền đọc bằng JWT CỦA NGƯỜI DÙNG: cùng hàm, cùng kết quả giao diện đang thấy.
  let perms: Perms = null;
  try {
    const r = await f(`${supabaseUrl}/rest/v1/rpc/get_my_permissions_v2`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey, "Content-Type": "application/json", "Content-Profile": "public" },
      body: JSON.stringify({ p_org: org }),
    });
    perms = r.ok ? ((await r.json()) as Perms) : null;
  } catch {
    perms = null;
  }
  if (!coQuyen(perms, "income_expenses", "create") && !coQuyen(perms, "personal_finance", "create")) {
    return loi(403, "not_permitted", "Tài khoản chưa có quyền lập phiếu chi hay ghi Ví cá nhân.");
  }

  const svc = { Authorization: `Bearer ${service}`, apikey: service };
  if (mode === "pilot" && !perms?.__superadmin) {
    let entitled = false;
    try {
      const r = await f(
        `${supabaseUrl}/rest/v1/ai_copilot_entitlements?select=chat_enabled&user_id=eq.${userId}&limit=1`,
        { headers: { ...svc, "Accept-Profile": "public" } },
      );
      const rows = r.ok ? ((await r.json()) as Array<{ chat_enabled?: unknown }>) : [];
      entitled = rows[0]?.chat_enabled === true;
    } catch {
      entitled = false;
    }
    if (!entitled) return loi(403, "not_entitled", "Giai đoạn thử: AI chỉ mở cho tài khoản có Copilot.");
  }

  // Trần LƯỢT/ngày: đếm task khác nhau (mỗi lượt có thể thử nhiều mô hình). Không đọc được ⇒ chặn.
  const cap = Number(env("QUICK_ENTRY_DAILY_CALLS") ?? LUOT_NGAY_MAC_DINH);
  let used = Number.POSITIVE_INFINITY;
  try {
    const r = await f(
      `${supabaseUrl}/rest/v1/ai_usage_logs?select=task_id&user_id=eq.${userId}&feature=eq.quick_entry` +
        `&created_at=gte.${encodeURIComponent(dauNgayVN(now()))}&limit=5000`,
      { headers: { ...svc, "Accept-Profile": "public" } },
    );
    if (r.ok) {
      const rows = (await r.json()) as Array<{ task_id?: unknown }>;
      used = new Set(rows.map((x) => String(x.task_id ?? ""))).size;
    }
  } catch {
    used = Number.POSITIVE_INFINITY;
  }
  if (!(Number.isFinite(cap) && cap > 0) || used >= cap) {
    return loi(429, "quick_entry_daily_cap", "Hôm nay đã dùng hết lượt AI. Bạn vẫn nhập tay được.");
  }

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > TRAN_BODY_BYTES) return loi(413, "payload_too_large", "Gói gửi lên quá lớn.");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    body = parsed as Record<string, unknown>;
  } catch {
    return loi(400, "invalid_json", "Thân yêu cầu không phải JSON.");
  }

  const dauVao = route === "stt" ? dauVaoNhanGiong(body) : dauVaoDocChu(body);
  if (!dauVao.ok) return dauVao.res;

  const models = route === "stt"
    ? chuoiMoHinh(env("QUICK_ENTRY_STT_MODELS"), STT_MODELS_MAC_DINH)
    : chuoiMoHinh(env("QUICK_ENTRY_READ_MODELS"), READ_MODELS_MAC_DINH);
  const skipRaw = Number(req.headers.get("x-quick-entry-skip") ?? 0);
  const skip = route === "read" && Number.isInteger(skipRaw) ? Math.min(Math.max(skipRaw, 0), models.length - 1) : 0;
  const taskId = `qe:${newId()}`;
  const batDau = now();
  let attempts = 0;

  for (let i = skip; i < models.length; i += 1) {
    if (i > skip && now() - batDau > NGAN_SACH_MS) break;
    attempts += 1;
    const t0 = now();
    const r = await goiNhaCungCap(f, ncc.base, ncc.key, route === "stt" ? "/audio/transcriptions" : "/chat/completions", dauVao.payload(models[i]));
    const text = route === "stt"
      ? String(r.body?.text ?? "").trim()
      : String(((r.body?.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content) ?? "").trim();
    const thanhCong = r.ok && text.length > 0;

    // Sổ phí: một dòng mỗi lần gọi mô hình. Ghi hỏng không làm hỏng câu trả lời của người dùng.
    try {
      await f(`${supabaseUrl}/rest/v1/ai_usage_logs`, {
        method: "POST",
        headers: { ...svc, "Content-Type": "application/json", "Content-Profile": "public", Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: userId,
          organization_id: org,
          provider: ncc.ten,
          model: models[i],
          feature: "quick_entry",
          task_id: taskId,
          prompt_tokens: Math.round(r.tokens.prompt),
          completion_tokens: Math.round(r.tokens.completion),
          total_tokens: Math.round(r.tokens.total),
          cost_usd: Number(r.cost.toFixed(6)),
          latency_ms: Math.round(now() - t0),
          status: thanhCong ? "ok" : "upstream_error",
          error_detail: thanhCong ? null : `${route}:${r.status}`,
        }),
      });
    } catch (e) {
      console.error("quick-entry: ghi ai_usage_logs lỗi", String(e).slice(0, 200));
    }

    const meta = {
      "x-quick-entry-model": models[i],
      "x-quick-entry-index": String(i),
      "x-quick-entry-attempts": String(attempts),
    };
    if (thanhCong) {
      if (route === "stt") return json(200, { text }, meta);
      return json(200, { model: models[i], choices: [{ index: 0, message: { role: "assistant", content: text } }] }, meta);
    }
    if (r.ok || nenThuMoHinhKe(r.status)) continue;
    break;
  }
  return loi(502, "quick_entry_all_failed", "Các mô hình AI đều đang lỗi. Thử lại sau, hoặc nhập tay.");
}

if (import.meta.main) Deno.serve((req) => xuLy(req));
