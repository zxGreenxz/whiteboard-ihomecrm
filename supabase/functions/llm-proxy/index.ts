// llm-proxy — Phase 1 (docs/ai-copilot/PLAN.md v2.1 §Phase 1)
// Flow: CORS → JWT → chặn stream → parse provider:model → ai_providers check
//   → reserve_ai_usage (RPC atomic: kill switch/entitlement/permission/rate/quota 3 cấp,
//     KHÔNG cache — thu hồi hiệu lực ngay)
//   → clamp/normalize → fetch upstream (KHÔNG retry — LLM class client đã retry 2)
//   → normalize response → finalize_ai_usage qua waitUntil.
// Lỗi map: copilot_disabled/not_entitled/not_permitted/daily_quota → 403 (non-retryable);
//          rate_limited → 429; stream/local_only/bad model → 400.
// Provider "mock" CHỈ dev/test (vẫn qua đủ gate) — tắt bằng ai_providers.enabled.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const ALLOWED_HEADERS =
  'authorization, x-client-info, apikey, content-type, x-copilot-feature, x-task-id, x-mock-step, x-mock-cost';

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

interface ModelPricing { input_price: number; output_price: number }

function findPricing(models: unknown, modelId: string): ModelPricing {
  if (Array.isArray(models)) {
    const m = models.find((x) => x && typeof x === 'object' && (x as any).id === modelId);
    if (m) {
      return {
        input_price: Number((m as any).input_price) || 0,
        output_price: Number((m as any).output_price) || 0,
      };
    }
  }
  return { input_price: 0, output_price: 0 };
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') return openaiError(405, 'Method not allowed', 'method_not_allowed');

  const path = new URL(req.url).pathname;
  if (!path.endsWith('/chat/completions')) {
    return openaiError(404, `Unknown path: ${path}`, 'not_found');
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return openaiError(401, 'Missing authorization header', 'unauthorized');

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return openaiError(401, 'Invalid JWT', 'unauthorized');
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return openaiError(400, 'Invalid JSON body', 'invalid_json');
  }

  if (body.stream === true) {
    return openaiError(400, 'Streaming is not supported', 'stream_not_supported');
  }

  const rawModel = String(body.model ?? '');
  const sep = rawModel.indexOf(':');
  if (sep <= 0) {
    return openaiError(400, `Model must be "provider:model-id", got "${rawModel}"`, 'bad_model');
  }
  const provider = rawModel.slice(0, sep);
  const modelId = rawModel.slice(sep + 1);

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

  // Ước lượng chi phí reservation: prompt chars/4 × giá in + max_tokens × giá out (USD/1M)
  const pricing = findPricing(prov.models, modelId);
  const promptChars = JSON.stringify(body.messages ?? []).length;
  const maxOut = Math.min(typeof body.max_tokens === 'number' ? (body.max_tokens as number) : 4096, 4096);
  let estCost =
    (promptChars / 4 / 1e6) * pricing.input_price + (maxOut / 1e6) * pricing.output_price;
  // Dev/test: mock cho phép ép est cost qua header để test quota/race
  if (provider === 'mock') {
    const forced = parseFloat(req.headers.get('x-mock-cost') ?? '');
    if (!Number.isNaN(forced)) estCost = forced;
  }

  // Reserve — TOÀN BỘ gate atomic trong 1 RPC, không cache
  const { data: reservationId, error: reserveError } = await admin.rpc('reserve_ai_usage', {
    p_user_id: userId,
    p_feature: feature,
    p_provider: provider,
    p_model: modelId,
    p_task_id: taskId,
    p_est_cost_usd: estCost,
  });
  if (reserveError) {
    const msg = reserveError.message ?? '';
    if (msg.includes('copilot_disabled')) return openaiError(403, 'Copilot is disabled', 'copilot_disabled');
    if (msg.includes('not_entitled')) return openaiError(403, 'User is not entitled to use copilot', 'not_entitled');
    if (msg.includes('not_permitted')) return openaiError(403, 'Missing ai_copilot permission', 'not_permitted');
    if (msg.includes('rate_limited')) return openaiError(429, 'Rate limit exceeded, retry later', 'rate_limited');
    // daily_quota → 403 CHỦ Ý (không 429): quota ngày không reset sớm, LLM class retry 429 vô ích
    if (msg.includes('daily_quota')) return openaiError(403, 'Daily USD quota exceeded', 'daily_quota');
    return openaiError(500, `Reserve failed: ${msg}`, 'internal');
  }

  const finalize = (fields: {
    prompt?: number; completion?: number; total?: number; cached?: number;
    cost: number | null; latency: number; status: string; error?: string;
  }) => {
    const p = admin.rpc('finalize_ai_usage', {
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
      if (error) console.error('finalize_ai_usage failed:', error.message);
    });
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    else void p;
  };

  const t0 = Date.now();

  // Mock: trả scripted response, vẫn finalize đủ vòng đời
  if (provider === 'mock') {
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
  const apiKey = Deno.env.get(upstream.envKey);
  if (!apiKey) {
    finalize({ cost: 0, latency: 0, status: 'upstream_error', error: 'no api key' });
    return openaiError(403, `Provider "${provider}" has no API key configured`, 'provider_disabled');
  }

  // Clamp/normalize per-provider (thay modelPatch — chết sau proxy)
  const outBody: Record<string, unknown> = { ...body, model: modelId };
  delete outBody.n;
  outBody.max_tokens = maxOut;   // Anthropic shim ĐÒI max_tokens — luôn set

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${upstream.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...upstream.extraHeaders,
      },
      body: JSON.stringify(outBody),
      signal: controller.signal,
    });
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
    try { usage = JSON.parse(text)?.usage ?? {}; } catch { /* giữ {} */ }
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
  }
});
