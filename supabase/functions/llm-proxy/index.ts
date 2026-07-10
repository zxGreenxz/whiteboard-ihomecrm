// llm-proxy — Phase 0 SPIKE (tối giản, xem docs/ai-copilot/PLAN.md §Phase 0)
// - JWT bắt buộc, CORS allowlist header tĩnh, chặn stream, subpath /chat/completions
// - provider "mock" CHỈ phục vụ spike Gate A/C khi chưa có API key (xoá ở Phase 1)
// - provider cloud tối giản: openrouter / groq / gemini / deepseek / openai (key từ secrets)
// Phase 1 sẽ thay bằng bản đầy đủ: ai_providers + reserve_ai_usage/finalize_ai_usage.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';

const ALLOWED_HEADERS =
  'authorization, x-client-info, apikey, content-type, x-copilot-feature, x-task-id, x-mock-step';

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

// ── Provider routing tối giản (spike) ─────────────────────────────────────
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
};

// ── Mock provider (SPIKE ONLY) ─────────────────────────────────────────────
// model = "mock:<script>" với script = chuỗi action phân cách "-", ví dụ:
//   mock:done            → done ngay
//   mock:wait-wait-done  → 2 bước wait rồi done
// Bước hiện tại đọc từ header x-mock-step (spike page tự đếm qua customFetch).
// usage.prompt_tokens = ước lượng chars/4 của messages — phục vụ đo token/step.
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
    // input_text vào element index 1 (spike page: ô "Ô nhập thử")
    action = { input_text: { index: 1, text: 'spike đã nhập 0912345678' } };
  } else if (actionName === 'echo') {
    // Trả nguyên văn user prompt trong done.text — dùng để kiểm tra
    // transformPageContent/getPageInstructions có vào prompt hay không.
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

  return json(200, {
    id: `mock-${step}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: String(body.model ?? 'mock'),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_mock_${step}`,
              type: 'function',
              function: { name: 'AgentOutput', arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: estPromptTokens,
      completion_tokens: 60,
      total_tokens: estPromptTokens + 60,
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') return openaiError(405, 'Method not allowed', 'method_not_allowed');

  // Subpath route: client OpenAI-compat gọi {baseURL}/chat/completions
  const path = new URL(req.url).pathname;
  if (!path.endsWith('/chat/completions')) {
    return openaiError(404, `Unknown path: ${path}`, 'not_found');
  }

  // JWT bắt buộc
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return openaiError(401, 'Missing authorization header', 'unauthorized');

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return openaiError(401, 'Invalid JWT', 'unauthorized');

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return openaiError(400, 'Invalid JSON body', 'invalid_json');
  }

  if (body.stream === true) {
    return openaiError(400, 'Streaming is not supported', 'stream_not_supported');
  }

  // model = "provider:model-id"
  const rawModel = String(body.model ?? '');
  const sep = rawModel.indexOf(':');
  if (sep <= 0) {
    return openaiError(400, `Model must be "provider:model-id", got "${rawModel}"`, 'bad_model');
  }
  const provider = rawModel.slice(0, sep);
  const modelId = rawModel.slice(sep + 1);

  if (provider === 'mock') return mockResponse(req, body, modelId);

  const upstream = UPSTREAMS[provider];
  if (!upstream) return openaiError(403, `Provider "${provider}" not available`, 'provider_disabled');

  const apiKey = Deno.env.get(upstream.envKey);
  if (!apiKey) {
    return openaiError(403, `Provider "${provider}" has no API key configured`, 'provider_disabled');
  }

  // Clamp cơ bản (spike): max_tokens ≤ 4096, bỏ n
  const outBody: Record<string, unknown> = { ...body, model: modelId };
  delete outBody.n;
  const mt = typeof outBody.max_tokens === 'number' ? (outBody.max_tokens as number) : undefined;
  outBody.max_tokens = Math.min(mt ?? 4096, 4096);

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
    return new Response(text, {
      status: res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return openaiError(502, `Upstream error: ${msg}`, 'upstream_error');
  } finally {
    clearTimeout(timer);
  }
});
