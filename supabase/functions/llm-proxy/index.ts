// llm-proxy — Phase 1 + streaming Phase 4 (docs/ai-copilot/PLAN.md v2.1)
// Flow: CORS → JWT → parse provider:model → ai_providers check
//   → reserve_ai_usage (RPC atomic: kill switch/entitlement/permission/rate/quota 3 cấp,
//     KHÔNG cache — thu hồi hiệu lực ngay)
//   → clamp/normalize → fetch upstream (KHÔNG retry — LLM class client đã retry 2)
//   → non-stream: normalize response → finalize qua waitUntil
//   → stream (Phase 4): pipe SSE về client, TEE parse usage (stream_options
//     include_usage) → finalize khi flush; client abort → propagate lên upstream.
// Lỗi map: copilot_disabled/not_entitled/not_permitted/daily_quota/daily_token_quota → 403 (non-retryable);
//          rate_limited → 429; local_only/bad model → 400.
// Provider "mock" CHỈ dev/test (vẫn qua đủ gate) — tắt bằng ai_providers.enabled.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

// `x-organization-id`: công ty đang làm việc (G0-B). Header phải nằm trong
// allow-list CORS trước, nếu không preflight chặn ngay ở trình duyệt và lỗi trông
// như "server không nhận request" chứ không như "thiếu header".
export const ALLOWED_HEADERS =
  'authorization, x-client-info, apikey, content-type, x-copilot-feature, x-task-id, x-mock-step, x-mock-cost, x-organization-id';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': ALLOWED_HEADERS,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const openaiError = (status: number, message: string, code: string) =>
  json(status, { error: { message, type: 'invalid_request_error', code } });

interface UpstreamDef {
  baseURL: string;
  envKey: string;
  extraHeaders?: Record<string, string>;
}
const UPSTREAMS: Record<string, UpstreamDef> = {
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    extraHeaders: { 'HTTP-Referer': 'https://ptcrm.vercel.app', 'X-Title': 'ptcrm Copilot' },
  },
  groq: { baseURL: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY' },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
  },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY' },
  openai: { baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY' },
  qwen: {
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envKey: 'QWEN_API_KEY',
  },
  anthropic: {
    // Anthropic OpenAI-compat shim — YẾU NHẤT trong 7 provider; test tool-calling
    // riêng khi có key (plan §4). Đòi max_tokens (đã clamp luôn set).
    baseURL: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
  },
};

// 9Router self-host trên VPS (OpenAI-compatible). Chỉ kích hoạt khi secret
// NINEROUTER_BASE_URL được nạp (vd https://ai.chillhome.io.vn/v1) — và provider
// '9router' trong DB phải đổi data_class 'local_only' → 'cloud' để đi qua proxy.
const NINEROUTER_BASE = Deno.env.get('NINEROUTER_BASE_URL');
if (NINEROUTER_BASE) {
  UPSTREAMS['9router'] = { baseURL: NINEROUTER_BASE, envKey: 'NINEROUTER_API_KEY' };
}

type PricingMode = 'metered' | 'free' | 'self_hosted' | 'unknown';
interface ModelPricing { pricing_mode: Exclude<PricingMode, 'unknown'>; input_price: number; output_price: number }

/**
 * Giá của model, hoặc `null` nếu model KHÔNG có trong danh sách của provider.
 *
 * Phân biệt "không tìm thấy" với "giá bằng 0" là điểm mấu chốt. Bản cũ trả
 * `{0,0}` cho cả hai, nên một `modelId` lạ vẫn được chuyển tiếp lên upstream và
 * được ước lượng chi phí bằng 0 — tức là đi qua toàn bộ hạn mức USD ba cấp mà
 * không tốn đồng nào của hạn mức. Ai sửa được request (hoặc sửa được
 * `profiles.ui_preferences.copilotModel`) là chọn được model tuỳ ý, kể cả model
 * đắt mà admin chưa bao giờ bật.
 */
function findPricing(models: unknown, modelId: string): ModelPricing | null {
  if (!Array.isArray(models)) return null;
  const m = models.find((x) => x && typeof x === 'object' && (x as any).id === modelId);
  if (!m) return null;
  const mode = (m as any).pricing_mode;
  const input = (m as any).input_price;
  const output = (m as any).output_price;
  if (!['metered', 'free', 'self_hosted', 'unknown'].includes(mode)) return null;
  if (mode === 'unknown') return null;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return null;
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) return null;
  if (mode === 'metered' && (input <= 0 || output <= 0)) return null;
  return { pricing_mode: mode, input_price: input, output_price: output };
}

// ── Cửa vào: hàm THUẦN, test được không cần mạng ──────────────────────────
// Toàn bộ khối này cố ý không đụng `Deno`, `fetch` hay `admin` — index.test.ts
// gọi thẳng vào đây. Không tách sang file riêng được: đường deploy
// (scripts/deploy-llm-proxy.mjs) chỉ đóng gói ĐÚNG index.ts, một import cạnh
// bên sẽ chết trên server chứ không chết ở đây.

/** Ước lượng chi phí reservation: prompt chars/4 × giá in + max_tokens × giá out (USD/1M). */
export function tinhEstCost(pricing: ModelPricing, promptChars: number, maxOut: number): number {
  return (promptChars / 4 / 1e6) * pricing.input_price + (maxOut / 1e6) * pricing.output_price;
}

/**
 * Chi phí ép qua header `x-mock-cost` (dev/test quota/race).
 *
 * Bản cũ nhận thẳng `parseFloat(...)`, nên `x-mock-cost: -5` ghi -5 USD vào
 * `ai_usage_logs` — HOÀN LẠI hạn mức ngày thay vì tiêu nó. Ai gọi được proxy là
 * tự nạp thêm quota cho mình. Clamp về 0 ở đây, và migration
 * `20260902123939_copilot_mock_off_finalize_clamp_v1` clamp lần nữa ở DB: header
 * chỉ là một trong nhiều đường vào cột đó.
 */
export function clampMockCost(header: string | null, estCost: number): number {
  const forced = parseFloat(header ?? '');
  // NaN (không gửi header / rác) và ±Infinity đều KHÔNG phải "ép giá" — giữ dự toán.
  if (!Number.isFinite(forced)) return estCost;
  return Math.max(0, forced);
}

/**
 * Công ty đang làm việc, đọc từ header `x-organization-id`.
 *
 * Trả `null` cho mọi thứ không phải một uuid: thiếu header, chuỗi rỗng, chuỗi
 * rác. Chặn hình dạng Ở ĐÂY chứ không để `reserve_ai_usage` chặn, vì một chuỗi
 * lạ đi tiếp sẽ về dưới dạng lỗi kiểu dữ liệu của Postgres — thông báo đó nói về
 * `uuid` chứ không nói rằng người dùng chưa chọn công ty, và nó lọt nguyên văn
 * ra ngoài. Hàm THUẦN để test được: đây là chỗ quyết định, không phải chỗ nối mạng.
 *
 * Chuẩn hoá về chữ thường và cắt khoảng trắng: hoa/thường là chuyện của bàn phím,
 * không phải chuyện của quyền — `p_organization_id` là `uuid` nên Postgres coi
 * hai dạng là một, và giữ nguyên chỉ làm log khó đối chiếu.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function docOrganizationId(headers: Headers): string | null {
  const raw = (headers.get('x-organization-id') ?? '').trim().toLowerCase();
  return UUID_RE.test(raw) ? raw : null;
}

/** Mock CHỈ chạy khi deployment bật tường minh — xem chú thích ở chỗ gọi. */
export function mockDuocPhep(
  getEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
): boolean {
  return getEnv('LLM_PROXY_ALLOW_MOCK') === '1';
}

/**
 * Khoá được phép chuyển tiếp lên upstream.
 *
 * Bản cũ forward `{ ...body }` (chỉ xoá `n`), tức là mọi khoá client gửi đều tới
 * upstream: `models`/`route`/`provider` của OpenRouter đổi hẳn model thật sự chạy
 * — vòng qua bảng giá đã duyệt và qua ước lượng chi phí; `transforms`/`plugins`
 * bật tính năng tính tiền riêng; `user` gắn định danh tuỳ ý vào tài khoản trả tiền.
 * Danh sách CHO PHÉP thay vì danh sách cấm: khoá mới của upstream mặc định bị bỏ,
 * không mặc định lọt.
 */
export const TRUONG_BODY_HOP_LE = [
  'messages',
  'stream',
  'stream_options',
  'max_tokens',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
  'response_format',
] as const;

export function chonTruongBodyHopLe(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TRUONG_BODY_HOP_LE) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

export const GIOI_HAN_BODY_BYTES = 524_288; // 512 KiB
export const GIOI_HAN_SO_MESSAGE = 64;
export const GIOI_HAN_SO_ANH = 4;
export const GIOI_HAN_TONG_ANH_KY_TU = 6 * 1024 * 1024; // 6 MB base64

export interface LoiKichThuoc { status: number; message: string; code: string }

/** Đếm ảnh nhúng trong `messages` (data: URI hoặc URL trong `image_url`). */
function gomAnh(messages: unknown): { so: number; tongKyTu: number } {
  let so = 0;
  let tongKyTu = 0;
  if (!Array.isArray(messages)) return { so, tongKyTu };
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const phan of content) {
      if (!phan || typeof phan !== 'object') continue;
      const anh = (phan as { image_url?: unknown }).image_url;
      const url = typeof anh === 'string'
        ? anh
        : typeof (anh as { url?: unknown })?.url === 'string'
          ? (anh as { url: string }).url
          : null;
      if (url === null) continue;
      so += 1;
      tongKyTu += url.length;
    }
  }
  return { so, tongKyTu };
}

/**
 * Trần kích thước đầu vào. `null` = đạt.
 *
 * Thứ tự có chủ ý: chặn theo BYTE trước, rồi mới đếm message và ảnh. Hệ quả cần
 * biết: với trần body 512 KiB, ngưỡng 6 MB ảnh không bao giờ tự chạm được qua
 * HTTP — nó là lớp thứ hai, để trần body nới ra sau này thì ảnh vẫn có trần
 * riêng. Ngưỡng SỐ ảnh thì chạm được thật (4 URL http ngắn lọt thoải mái 512 KiB).
 */
export function kiemKichThuocBody(text: string, messages: unknown): LoiKichThuoc | null {
  const soByte = new TextEncoder().encode(text).length;
  if (soByte > GIOI_HAN_BODY_BYTES) {
    return { status: 413, message: 'Request body too large', code: 'body_too_large' };
  }
  if (Array.isArray(messages) && messages.length > GIOI_HAN_SO_MESSAGE) {
    return { status: 400, message: `Too many messages (max ${GIOI_HAN_SO_MESSAGE})`, code: 'too_many_messages' };
  }
  const anh = gomAnh(messages);
  if (anh.so > GIOI_HAN_SO_ANH || anh.tongKyTu > GIOI_HAN_TONG_ANH_KY_TU) {
    return { status: 400, message: `Too many or too large images (max ${GIOI_HAN_SO_ANH})`, code: 'too_many_images' };
  }
  return null;
}

/**
 * Đọc body với trần BYTE THẬT — không phải trần đo sau khi đã trót nạp hết.
 *
 * `req.text()` gom trọn body vào bộ nhớ rồi mới trả chuỗi, nên mọi phép kiểm
 * `text.length` sau đó là kiểm MUỘN: một request không khai `content-length`
 * (chunked) lọt qua phép chặn rẻ ở đầu handler và vẫn nằm nguyên trong isolate
 * trước khi bị 413. Nhân với semaphore 8 luồng thì trần 512 KiB không chặn gì cả.
 *
 * Hàm này đếm khi đọc: chunk nào đẩy tổng vượt trần thì DỪNG ngay, không nối vào
 * chuỗi, và `cancel()` nguồn để phần còn lại không bị kéo về. Bộ nhớ tối đa vì
 * thế là trần + đúng một chunk, chứ không phải kích thước body.
 *
 * `TextDecoder({ stream: true })` giữ ký tự nhiều byte bị cắt ngang biên chunk —
 * ghép sai chỗ đó tạo ra ký tự thay thế U+FFFD và JSON.parse hỏng ngẫu nhiên
 * theo cách chia gói của mạng.
 */
export async function docBodyCoTran(
  body: ReadableStream<Uint8Array> | null,
  gioiHanBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (body === null) return { ok: true, text: '' };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let tong = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      tong += value.byteLength;
      if (tong > gioiHanBytes) return { ok: false };
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); // xả nốt ký tự dở dang cuối luồng
    return { ok: true, text };
  } finally {
    // Gọi cả trên đường thành công (lúc đó là no-op) lẫn đường vượt trần/lỗi.
    try { await reader.cancel(); } catch { /* nguồn đã đóng hoặc đã lỗi */ }
  }
}

/**
 * Bề mặt TỐI THIỂU của client admin mà handler dùng.
 *
 * Khai riêng để test tiêm được một client giả — nếu không, ba thứ đắt nhất của
 * đợt này (finalize đúng một lần, semaphore nhả trên đường lỗi, cổng mock đứng
 * TRƯỚC reserve) chỉ được "kiểm" bằng cách đọc lại code.
 */
export interface KetQuaRpc { data: unknown; error: { message?: string } | null }
export interface DongProvider {
  provider: string;
  enabled: boolean;
  models: unknown;
  data_class: string;
}
export interface AdminToiThieu {
  auth: {
    getUser(token: string): Promise<{
      data: { user: { id: string } | null } | null;
      error: { message?: string } | null;
    }>;
  };
  from(bang: string): {
    select(cot: string): {
      eq(cot: string, giaTri: string): {
        maybeSingle(): Promise<{ data: DongProvider | null; error: { message?: string } | null }>;
      };
    };
  };
  rpc(ten: string, args: Record<string, unknown>): PromiseLike<KetQuaRpc>;
}

/** Thứ handler đi mượn của thế giới bên ngoài. Bỏ trống = dùng đồ thật. */
export interface PhuThuoc {
  admin?: AdminToiThieu;
  getEnv?: (key: string) => string | undefined;
  fetchImpl?: typeof fetch;
}

export const TIMEOUT_KET_NOI_MS = 60_000;
export const TIMEOUT_STREAM_TONG_MS = 180_000;
export const TIMEOUT_STREAM_IM_MS = 30_000;

export interface DongHoStream {
  /** Có chunk mới → dời hạn im lặng. Đồng hồ TỔNG không dời. */
  datLai(): void;
  /** Dọn cả hai đồng hồ (bắt buộc gọi, kể cả đường lỗi). */
  don(): void;
}

/**
 * Hai đồng hồ cho một stream đang chạy.
 *
 * Bản cũ `clearTimeout(timer)` ngay khi upstream trả header, với lý do "stream
 * sống lâu hơn 60s là bình thường" — đúng, nhưng sau dòng đó KHÔNG còn đồng hồ
 * nào. Một upstream treo giữa chừng giữ nguyên một reservation `pending` và một
 * kết nối, vô hạn. Hai hạn khác nhau vì hai kiểu hỏng khác nhau: TỔNG chặn
 * stream chạy mãi, IM LẶNG chặn stream đứng hình mà chưa đóng.
 */
export function taoDongHoStream(
  khiHetGio: (lyDo: 'tong' | 'im') => void,
  tongMs: number = TIMEOUT_STREAM_TONG_MS,
  imMs: number = TIMEOUT_STREAM_IM_MS,
): DongHoStream {
  let daBan = false;
  // `ReturnType<typeof setTimeout>` chứ không phải `number`: trong Deno nó là
  // `Timeout`, không phải số như trên trình duyệt — ghim `number` làm type-check đỏ.
  let dongHoIm: ReturnType<typeof setTimeout> | undefined;
  const ban = (lyDo: 'tong' | 'im') => {
    if (daBan) return;
    daBan = true;
    don();
    khiHetGio(lyDo);
  };
  const dongHoTong: ReturnType<typeof setTimeout> = setTimeout(() => ban('tong'), tongMs);
  function don() {
    clearTimeout(dongHoTong);
    if (dongHoIm !== undefined) clearTimeout(dongHoIm);
    dongHoIm = undefined;
  }
  const datLai = () => {
    if (daBan) return;
    if (dongHoIm !== undefined) clearTimeout(dongHoIm);
    dongHoIm = setTimeout(() => ban('im'), imMs);
  };
  datLai();
  return { datLai, don };
}

// ── Mock provider (dev/test — vẫn qua đủ gate reserve/finalize) ────────────
function mockResponse(req: Request, body: Record<string, unknown>, script: string) {
  const step = parseInt(req.headers.get('x-mock-step') ?? '0', 10) || 0;
  const actions = script.split('-');
  const actionName = actions[Math.min(step, actions.length - 1)] || 'done';
  const promptChars = JSON.stringify(body.messages ?? []).length;
  const estPromptTokens = Math.ceil(promptChars / 4);
  const diag = {
    step,
    auth: req.headers.get('authorization') ? 'yes' : 'no',
    feature: req.headers.get('x-copilot-feature') ?? null,
    task: req.headers.get('x-task-id') ?? null,
    prompt_chars: promptChars,
  };

  let action: Record<string, unknown>;
  const clickMatch = actionName.match(/^click(\d+)$/);
  if (actionName === 'wait') {
    action = { wait: { seconds: 1 } };
  } else if (clickMatch) {
    action = { click_element_by_index: { index: parseInt(clickMatch[1], 10) } };
  } else if (actionName === 'input') {
    action = { input_text: { index: 1, text: 'spike đã nhập 0912345678' } };
  } else if (actionName === 'navphong') {
    // dev/test UI-control: gọi mo_trang → /apartments. page-agent không gửi
    // x-mock-step, nên suy step từ URL nhúng trong prompt: đã ở /apartments → done.
    const promptText = JSON.stringify(body.messages ?? []);
    action = promptText.includes('/apartments')
      ? { done: { text: 'Đã mở trang danh sách phòng.', success: true } }
      : { mo_trang: { trang: 'phong' } };
  } else if (actionName === 'echo') {
    const messages = body.messages as { role: string; content?: string }[];
    const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
    action = { done: { text: `MOCK_ECHO ${JSON.stringify(diag)}\n---USER PROMPT---\n${userMsg}`, success: true } };
  } else {
    action = { done: { text: `MOCK_DONE ${JSON.stringify(diag)}`, success: true } };
  }

  const args = {
    evaluation_previous_goal: step === 0 ? 'Bắt đầu task.' : `Đã xong bước ${step - 1}.`,
    memory: `mock step ${step}`,
    next_goal: actionName === 'done' ? 'Hoàn tất.' : `Thực hiện ${actionName}.`,
    action,
  };

  return {
    id: `mock-${step}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: String(body.model ?? 'mock'),
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_mock_${step}`,
          type: 'function',
          function: { name: 'AgentOutput', arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: estPromptTokens, completion_tokens: 60, total_tokens: estPromptTokens + 60 },
  };
}

// Mock streaming (dev/test Phase 4): 3 chunk content + chunk usage + [DONE]
function mockStreamResponse(
  body: Record<string, unknown>,
  estCost: number,
  finalize: (f: { prompt?: number; completion?: number; total?: number; cached?: number; cost: number | null; latency: number; status: string; error?: string }) => void,
  t0: number,
) {
  const promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  const enc = new TextEncoder();
  const chunk = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
  const base = { id: 'mock-stream', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: String(body.model ?? 'mock') };
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const piece of ['Xin ', 'chào từ ', 'mock stream.']) {
        ctrl.enqueue(chunk({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
        await new Promise((r) => setTimeout(r, 120));
      }
      ctrl.enqueue(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      ctrl.enqueue(chunk({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 8, total_tokens: promptTokens + 8 } }));
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
      ctrl.close();
      finalize({ prompt: promptTokens, completion: 8, total: promptTokens + 8, cost: estCost, latency: Date.now() - t0, status: 'ok' });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

/** Trần parse ĐỒNG THỜI: một instance chỉ giải nén ngần này body cùng lúc. */
export const TRAN_PARSE_DONG_THOI = 8;
let dangParse = 0;
/** Chỉ dùng cho test: chứng minh semaphore được nhả cả trên đường lỗi. */
export const dangParseHienTai = (): number => dangParse;

export const xuLyYeuCau = async (req: Request, deps?: PhuThuoc): Promise<Response> => {
  const getEnv = deps?.getEnv ?? ((key: string) => Deno.env.get(key));
  const goiMang = deps?.fetchImpl ?? fetch;
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') return openaiError(405, 'Method not allowed', 'method_not_allowed');

  const path = new URL(req.url).pathname;
  if (!path.endsWith('/chat/completions')) {
    return openaiError(404, `Unknown path: ${path}`, 'not_found');
  }

  // Trần theo `content-length` TRƯỚC khi đọc byte nào: phép từ chối rẻ nhất, và
  // nó che luôn vòng gọi getUser bên dưới.
  const khaiDoDai = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(khaiDoDai) && khaiDoDai > GIOI_HAN_BODY_BYTES) {
    return openaiError(413, 'Request body too large', 'body_too_large');
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return openaiError(401, 'Missing authorization header', 'unauthorized');

  // `??` ngắn mạch: có client tiêm vào thì KHÔNG gọi createClient, nên test không
  // cần SUPABASE_URL/SERVICE_ROLE_KEY. Một lần ép kiểu duy nhất ở đúng đường nối
  // này — generic của supabase-js rộng hơn bề mặt handler thật sự dùng.
  const admin: AdminToiThieu = deps?.admin ?? (createClient(
    getEnv('SUPABASE_URL')!,
    getEnv('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  ) as unknown as AdminToiThieu);
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return openaiError(401, 'Invalid JWT', 'unauthorized');
  const userId = userData.user.id;

  // Đọc + parse body dưới một semaphore: JSON.parse là công việc ĐỒNG BỘ, nó giữ
  // nguyên isolate. Không có trần này thì vài chục request nặng cùng lúc làm mọi
  // request khác (kể cả request rẻ) chờ theo — một instance chết vì CPU chứ không
  // vì hạn mức nào.
  let body: Record<string, unknown>;
  if (dangParse >= TRAN_PARSE_DONG_THOI) {
    return openaiError(429, 'Too many concurrent requests, retry later', 'busy');
  }
  dangParse += 1;
  try {
    let doc: { ok: true; text: string } | { ok: false };
    try {
      doc = await docBodyCoTran(req.body, GIOI_HAN_BODY_BYTES);
    } catch {
      // Luồng body đứt/lỗi giữa chừng. `finally` bên dưới vẫn nhả semaphore.
      return openaiError(400, 'Invalid JSON body', 'invalid_json');
    }
    if (!doc.ok) return openaiError(413, 'Request body too large', 'body_too_large');
    const text = doc.text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return openaiError(400, 'Invalid JSON body', 'invalid_json');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return openaiError(400, 'Invalid JSON body', 'invalid_json');
    }
    body = parsed as Record<string, unknown>;
    const loiKichThuoc = kiemKichThuocBody(text, body.messages);
    if (loiKichThuoc) {
      return openaiError(loiKichThuoc.status, loiKichThuoc.message, loiKichThuoc.code);
    }
  } finally {
    dangParse -= 1;
  }

  const wantStream = body.stream === true;

  const rawModel = String(body.model ?? '');
  const sep = rawModel.indexOf(':');
  if (sep <= 0) {
    return openaiError(400, `Model must be "provider:model-id", got "${rawModel}"`, 'bad_model');
  }
  const provider = rawModel.slice(0, sep);
  const modelId = rawModel.slice(sep + 1);

  // Mock đi qua đủ gate, nhưng nó KHÔNG gọi upstream: chi phí do header quyết
  // định và kịch bản do modelId quyết định. Với một dòng `ai_providers` bật nhầm
  // (seed gốc đặt `enabled = true`), bất kỳ ai có JWT đều gọi được. Công tắc thật
  // phải nằm ở DEPLOYMENT — biến môi trường không sửa được từ giao diện admin —
  // và phải chặn TRƯỚC reserve, kẻo mỗi lần thử là một dòng usage rác.
  if (provider === 'mock' && !mockDuocPhep(getEnv)) {
    return openaiError(403, 'Mock provider is disabled', 'provider_disabled');
  }

  // Provider registry (DB — admin đổi không cần redeploy)
  const { data: prov, error: provError } = await admin
    .from('ai_providers')
    .select('provider, enabled, models, data_class')
    .eq('provider', provider)
    .maybeSingle();
  if (provError) return openaiError(500, `Provider lookup failed: ${provError.message}`, 'internal');
  if (!prov || !prov.enabled) {
    return openaiError(403, `Provider "${provider}" not available`, 'provider_disabled');
  }
  if (prov.data_class === 'local_only') {
    // Ollama/local: browser gọi thẳng localhost — xuất hiện ở proxy là sai cấu hình
    return openaiError(400, `Provider "${provider}" is local-only`, 'local_only');
  }

  const feature = req.headers.get('x-copilot-feature') === 'ui_control' ? 'ui_control' : 'chat';
  const taskId = req.headers.get('x-task-id');

  // Công ty phải được NÓI, không được suy. `reserve_ai_usage` ghi thẳng giá trị
  // này vào `ai_usage_logs.organization_id`; bỏ trống thì trigger
  // `autofill_org_strict` phải đoán từ `user_id`, và nó chỉ đoán được với người
  // thuộc đúng MỘT công ty — với người đa tổ chức thì hoặc 500 (23502) hoặc ghi
  // hạn mức vào công ty họ không chọn. Chặn TRƯỚC reserve: một reservation cho
  // request không bao giờ chạy vẫn giữ hạn mức ngày suốt 5 phút.
  const organizationId = docOrganizationId(req.headers);
  if (!organizationId) {
    return openaiError(400, 'Organization is required', 'organization_required');
  }

  // Model phải nằm trong danh sách admin đã bật cho provider này.
  // Provider "mock" là ngoại lệ CÓ CHỦ Ý: modelId của nó là kịch bản dev/test
  // ("echo", "navphong", "click3-input-done"…), không phải tên model, nên không
  // liệt kê được. Nó vẫn qua đủ gate reserve/finalize, và tắt bằng
  // ai_providers.enabled — đó mới là công tắc của nó.
  const pricing = provider === 'mock'
    ? { pricing_mode: 'free' as const, input_price: 0, output_price: 0 }
    : findPricing(prov.models, modelId);
  if (!pricing) {
    const listed = Array.isArray(prov.models) && prov.models.some((m: any) => m?.id === modelId);
    if (listed) {
      return openaiError(400, `Model "${modelId}" has invalid or unknown pricing metadata`, 'bad_pricing');
    }
    return openaiError(
      400,
      `Model "${modelId}" is not enabled for provider "${provider}"`,
      'bad_model',
    );
  }

  const promptChars = JSON.stringify(body.messages ?? []).length;
  const maxOut = Math.min(typeof body.max_tokens === 'number' ? (body.max_tokens as number) : 4096, 4096);
  let estCost = tinhEstCost(pricing, promptChars, maxOut);
  // Dev/test: mock cho phép ép est cost qua header để test quota/race — đã clamp ≥ 0.
  if (provider === 'mock') estCost = clampMockCost(req.headers.get('x-mock-cost'), estCost);

  // Reserve — TOÀN BỘ gate atomic trong 1 RPC, không cache
  const { data: reservationId, error: reserveError } = await admin.rpc('reserve_ai_usage', {
    p_user_id: userId,
    p_feature: feature,
    p_provider: provider,
    p_model: modelId,
    p_task_id: taskId,
    p_est_cost_usd: estCost,
    p_organization_id: organizationId,
  });
  if (reserveError) {
    const msg = reserveError.message ?? '';
    // Hàng rào thứ hai cho tổ chức: cửa ở trên chỉ kiểm HÌNH DẠNG, còn ai được
    // làm việc cho công ty nào thì chỉ database biết. Và proxy có thể được deploy
    // lại từ một bản cũ hơn migration — lúc đó `organization_required` về từ RPC
    // là thứ duy nhất còn nói đúng chuyện.
    if (msg.includes('organization_required')) return openaiError(400, 'Organization is required', 'organization_required');
    // 403 chứ KHÔNG 500: chọn nhầm công ty là chuyện người dùng sửa được, còn
    // 500 nói server hỏng và LLM class sẽ retry một việc không bao giờ qua.
    if (msg.includes('organization_forbidden')) return openaiError(403, 'No access to the selected organization', 'organization_forbidden');
    if (msg.includes('copilot_disabled')) return openaiError(403, 'Copilot is disabled', 'copilot_disabled');
    if (msg.includes('not_entitled')) return openaiError(403, 'User is not entitled to use copilot', 'not_entitled');
    if (msg.includes('not_permitted')) return openaiError(403, 'Missing ai_copilot permission', 'not_permitted');
    if (msg.includes('rate_limited')) return openaiError(429, 'Rate limit exceeded, retry later', 'rate_limited');
    // daily_token_quota ĐỨNG TRƯỚC daily_quota. Hôm nay hai chuỗi không lồng
    // nhau, nhưng chuỗi con là cách khớp mong manh: đổi tên mã một lần là cửa
    // USD nuốt luôn cửa token, và người dùng đọc "hết hạn mức chi phí" trong khi
    // hai provider đang bật đều báo giá 0 — họ chưa tiêu một xu nào.
    // 403 (không 429) cùng lý do với daily_quota: trần ngày không reset sớm.
    if (msg.includes('daily_token_quota')) return openaiError(403, 'Daily token quota exceeded', 'daily_token_quota');
    // daily_quota → 403 CHỦ Ý (không 429): quota ngày không reset sớm, LLM class retry 429 vô ích
    if (msg.includes('daily_quota')) return openaiError(403, 'Daily USD quota exceeded', 'daily_quota');
    return openaiError(500, `Reserve failed: ${msg}`, 'internal');
  }

  // ĐÚNG MỘT LẦN. Reservation là một dòng `pending` đang giữ hạn mức: gọi hai lần
  // ghi đè số liệu lần trước (một lần abort + một lần flush là ca có thật ở
  // stream), không gọi lần nào thì dòng đó `pending` vĩnh viễn và hạn mức ngày
  // không bao giờ nhả. Guard ở đây thay vì ở từng chỗ gọi, để đường mới thêm sau
  // này cũng được che.
  let daFinalize = false;
  const finalize = (fields: {
    prompt?: number; completion?: number; total?: number; cached?: number;
    cost: number | null; latency: number; status: string; error?: string;
  }) => {
    if (daFinalize) return;
    daFinalize = true;
    // `Promise.resolve`: `rpc()` khai kiểu PromiseLike, mà `EdgeRuntime.waitUntil`
    // đòi Promise thật.
    const p: Promise<void> = Promise.resolve(admin.rpc('finalize_ai_usage', {
      p_id: reservationId,
      p_prompt_tokens: fields.prompt ?? 0,
      p_completion_tokens: fields.completion ?? 0,
      p_total_tokens: fields.total ?? 0,
      p_cached_tokens: fields.cached ?? 0,
      p_cost_usd: fields.cost,
      p_latency_ms: fields.latency,
      p_status: fields.status,
      p_error: fields.error ?? null,
    }).then(({ error }) => {
      // Log CÓ CẤU TRÚC: dòng này là dấu vết duy nhất của một reservation kẹt
      // `pending`. Văn xuôi thì không lọc được theo reservation trong log viewer.
      if (error) {
        console.error(JSON.stringify({
          evt: 'finalize_failed',
          reservationId,
          provider,
          model: modelId,
          status: fields.status,
          err: error.message?.slice(0, 300) ?? null,
        }));
      }
    }));
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    else void p;
  };

  const t0 = Date.now();

  // Mock: trả scripted response, vẫn finalize đủ vòng đời
  if (provider === 'mock') {
    if (wantStream) return mockStreamResponse(body, estCost, finalize, t0);
    const resBody = mockResponse(req, body, modelId);
    finalize({
      prompt: resBody.usage.prompt_tokens,
      completion: resBody.usage.completion_tokens,
      total: resBody.usage.total_tokens,
      cost: estCost,
      latency: Date.now() - t0,
      status: 'ok',
    });
    return json(200, resBody);
  }

  const upstream = UPSTREAMS[provider];
  if (!upstream) {
    finalize({ cost: 0, latency: 0, status: 'upstream_error', error: 'no upstream route' });
    return openaiError(403, `Provider "${provider}" has no upstream route`, 'provider_disabled');
  }
  const apiKey = getEnv(upstream.envKey);
  if (!apiKey) {
    finalize({ cost: 0, latency: 0, status: 'upstream_error', error: 'no api key' });
    return openaiError(403, `Provider "${provider}" has no API key configured`, 'provider_disabled');
  }

  // Clamp/normalize per-provider (thay modelPatch — chết sau proxy).
  // `model` do proxy đặt, KHÔNG lấy của client: chuỗi client gửi là "provider:model".
  const outBody: Record<string, unknown> = { ...chonTruongBodyHopLe(body), model: modelId };
  outBody.max_tokens = maxOut;   // Anthropic shim ĐÒI max_tokens — luôn set
  // include_usage để chunk cuối mang usage (chỉ set cho provider chắc chắn hỗ trợ)
  const daXinUsage = wantStream && ['openrouter', 'openai', 'groq', 'deepseek'].includes(provider);
  if (daXinUsage) outBody.stream_options = { include_usage: true };

  const controller = new AbortController();
  // Client abort (Dừng trong UI) → propagate lên upstream (Phase 4)
  try {
    req.signal.addEventListener('abort', () => controller.abort());
  } catch { /* signal không khả dụng — bỏ qua */ }
  // Timeout: non-stream 60s trọn request; stream chỉ áp cho lúc chờ headers
  // (sau đó chuyển sang cặp đồng hồ tổng/im lặng, xem taoDongHoStream).
  const timer = setTimeout(() => controller.abort(), TIMEOUT_KET_NOI_MS);
  let streamDangChay = false;
  try {
    const res = await goiMang(`${upstream.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...upstream.extraHeaders,
      },
      body: JSON.stringify(outBody),
      signal: controller.signal,
    });

    if (wantStream) {
      // KHÔNG clearTimeout ở đây nữa: `finally` phía dưới gỡ đồng hồ chờ-header
      // đúng lúc handler trả về, và cặp đồng hồ stream bên dưới nhận ca ngay
      // trong cùng lượt đồng bộ này — không có khoảng nào stream chạy không đồng hồ.
      if (!res.ok || !res.body) {
        const errText = await res.text();
        finalize({
          cost: 0, latency: Date.now() - t0, status: 'upstream_error',
          error: `HTTP ${res.status}: ${errText.slice(0, 500)}`,
        });
        return new Response(errText, {
          status: res.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // TEE: pass-through bytes, đồng thời parse SSE tìm chunk usage cuối
      streamDangChay = true;
      const decoder = new TextDecoder();
      let sseBuf = '';
      let lastUsage: any = null;
      let soChunkHong = 0;
      let dieuKhienTee: TransformStreamDefaultController<Uint8Array> | null = null;
      const doFinalize = (ketCuc: 'ok' | 'client_abort' | 'stream_timeout', chiTiet?: string) => {
        dongHo.don();
        const coUsage = lastUsage !== null;
        // Không có usage mà KHÔNG biết chi phí thật ⇒ ghi theo dự toán, không ghi 0.
        // Ghi 0 là biếu không một lượt gọi: hạn mức ngày cộng thêm đúng 0 đồng.
        const realCost = coUsage
          ? ((lastUsage?.prompt_tokens ?? 0) / 1e6) * pricing.input_price +
            ((lastUsage?.completion_tokens ?? 0) / 1e6) * pricing.output_price
          : estCost;
        // Chỉ coi là hỏng khi ta ĐÃ XIN usage mà vẫn không có: với provider không
        // hỗ trợ include_usage, thiếu usage là chuyện bình thường, không phải lỗi.
        const thieuUsage = !coUsage && daXinUsage && ketCuc === 'ok';
        if (thieuUsage || soChunkHong > 0) {
          console.error(JSON.stringify({
            evt: 'usage_parse_failed',
            reservationId,
            provider,
            model: modelId,
            stream: true,
            ketCuc,
            chunk_hong: soChunkHong,
            co_usage: coUsage,
          }));
        }
        finalize({
          prompt: lastUsage?.prompt_tokens ?? 0,
          completion: lastUsage?.completion_tokens ?? 0,
          total: lastUsage?.total_tokens ?? 0,
          cached: lastUsage?.prompt_tokens_details?.cached_tokens ?? 0,
          cost: realCost,
          latency: Date.now() - t0,
          status: ketCuc === 'stream_timeout' ? 'stream_timeout' : (thieuUsage ? 'finalize_error' : 'ok'),
          error: ketCuc === 'ok' ? (thieuUsage ? 'usage_parse_failed' : undefined) : (chiTiet ?? ketCuc),
        });
      };
      const dongHo = taoDongHoStream((lyDo) => {
        // Hết giờ: chốt sổ, đóng ĐẸP phía client (terminate → client thấy hết
        // stream, không thấy kết nối đứt), rồi cắt upstream.
        doFinalize('stream_timeout', lyDo === 'tong' ? 'wall_clock_180s' : 'idle_30s');
        try { dieuKhienTee?.terminate(); } catch { /* stream đã đóng — bỏ qua */ }
        try { controller.abort(); } catch { /* đã abort — bỏ qua */ }
      });
      const tee = new TransformStream<Uint8Array, Uint8Array>({
        start(ctrl) { dieuKhienTee = ctrl; },
        transform(chunk, ctrl) {
          dongHo.datLai();
          ctrl.enqueue(chunk);
          sseBuf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = sseBuf.indexOf('\n')) >= 0) {
            const line = sseBuf.slice(0, nl).trim();
            sseBuf = sseBuf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              if (parsed?.usage) lastUsage = parsed.usage;
            } catch { soChunkHong += 1; } // chunk dở — đếm để log, không chặn stream
          }
        },
        flush() { doFinalize('ok'); },
      });
      // Client ngắt giữa chừng → vẫn finalize với usage đã gom được
      try {
        req.signal.addEventListener('abort', () => doFinalize('client_abort'));
      } catch { /* bỏ qua */ }
      return new Response(res.body.pipeThrough(tee), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': res.headers.get('Content-Type') ?? 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });
    }

    const text = await res.text();

    if (!res.ok) {
      finalize({
        cost: 0, latency: Date.now() - t0, status: 'upstream_error',
        error: `HTTP ${res.status}: ${text.slice(0, 500)}`,
      });
      // Trả nguyên body lỗi OpenAI-format của upstream
      return new Response(text, {
        status: res.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let usage: any = {};
    let loiParse: string | null = null;
    try {
      usage = JSON.parse(text)?.usage ?? {};
    } catch (e) {
      loiParse = e instanceof Error ? e.message : String(e);
    }
    if (loiParse !== null) {
      // Upstream trả 200 với thân KHÔNG phải JSON: một lượt gọi đã tiêu thật mà ta
      // không đọc được usage. Bản cũ nuốt lỗi và ghi cost 0 — dòng usage trông
      // như một lượt gọi miễn phí, và hạn mức ngày không hề nhúc nhích.
      console.error(JSON.stringify({
        evt: 'usage_parse_failed',
        reservationId,
        provider,
        model: modelId,
        stream: false,
        so_ky_tu: text.length,
        err: loiParse.slice(0, 300),
      }));
      finalize({
        cost: estCost, // không biết thật ⇒ tính theo dự toán đã reserve, KHÔNG phải 0
        latency: Date.now() - t0,
        status: 'finalize_error',
        error: `usage_parse_failed: ${loiParse.slice(0, 300)}`,
      });
      return new Response(text, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const realCost =
      ((usage.prompt_tokens ?? 0) / 1e6) * pricing.input_price +
      ((usage.completion_tokens ?? 0) / 1e6) * pricing.output_price;
    finalize({
      prompt: usage.prompt_tokens ?? 0,
      completion: usage.completion_tokens ?? 0,
      total: usage.total_tokens ?? 0,
      cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
      cost: realCost,
      latency: Date.now() - t0,
      status: 'ok',
    });
    return new Response(text, {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finalize({ cost: 0, latency: Date.now() - t0, status: 'upstream_error', error: msg });
    return openaiError(502, `Upstream error: ${msg}`, 'upstream_error');
  } finally {
    clearTimeout(timer);
    // Lưới cuối: reservation đã tạo mà handler thoát chưa chốt sổ thì dòng đó
    // `pending` vĩnh viễn và hạn mức ngày không nhả. Trừ đường stream — ở đó
    // handler CỐ Ý trả về trước khi stream chạy xong, và doFinalize chốt sau.
    if (!daFinalize && !streamDangChay) {
      finalize({
        cost: estCost,
        latency: Date.now() - t0,
        status: 'finalize_error',
        error: 'handler thoát mà chưa finalize',
      });
    }
  }
};

if (import.meta.main) {
  // Bọc lambda: Deno truyền `ServeHandlerInfo` làm tham số thứ hai, đừng để nó
  // rơi vào chỗ của `deps`.
  Deno.serve((req) => xuLyYeuCau(req));
}
