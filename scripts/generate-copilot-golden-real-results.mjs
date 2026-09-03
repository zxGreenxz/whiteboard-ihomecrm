#!/usr/bin/env node
// Task G4 — sinh `--results <json>` cho lane real-model của
// `run-copilot-golden-eval.mjs`, bằng cách gọi MODEL THẬT qua `llm-proxy` sản
// xuất, dùng ĐÚNG system prompt + bộ tool production (nạp qua vite-node từ
// chính `src/copilot/*`, không chép lại).
//
// ĐO CÁI GÌ — đọc trước khi tin con số
//   Lane mock của run-copilot-golden-eval.mjs suy CẢ NĂM trường của `actual`
//   (toolPath, outcome, emptyState, forbidden, oracle.scenario) từ VĂN BẢN câu
//   hỏi bằng regex (inferMockToolPath/inferMockOutcome/...) — nó không nói
//   chuyện với model nào cả. Script này thay đúng MỘT trong năm trục đó bằng
//   tín hiệu THẬT: `toolPath`, lấy từ tool_calls một model thật
//   (mặc định openrouter:nvidia/nemotron-3-super-120b-a12b:free, gọi qua
//   edge function `llm-proxy` sản xuất bằng JWT người dùng thật — 9Router đang
//   chết, xem CLAUDE.local.md) trả về khi nhận ĐÚNG system prompt + tool
//   catalog sản xuất (src/copilot/chatEngine.ts + src/copilot/tools/registry.ts,
//   nạp SỐNG qua vite-node) và `input` của ca làm tin nhắn user.
//
//   Bốn trường còn lại (outcome/emptyState/forbidden/oracle.scenario) được
//   điền bằng CHÍNH các hàm inferMock*() của lane mock (import thẳng từ
//   run-copilot-golden-eval.mjs, không viết lại). Đây KHÔNG phải vòng tròn:
//   các hàm đó phân loại TAXONOMY của câu hỏi (không phụ thuộc model nào) —
//   đúng cách trường `expected.*` của corpus được tạo ra, và
//   check-golden-eval-report.mjs đã canh lane mock ở 0 fail trên CI, tức corpus
//   ĐÃ khớp các hàm này tuyệt đối. Nên bốn trường đó LUÔN khớp `expected` ở
//   đây, và trục DUY NHẤT có thể làm một ca FAIL trong báo cáo này là
//   `toolPath` — đúng thứ script đo THẬT: model thật có chọn đúng tool mà
//   corpus nói là đúng không?
//
//   KHÔNG THỰC THI TOOL NÀO. Script chỉ bắt tool_calls của MỘT lượt hoàn tất
//   rồi dừng — không RPC nào chạy, không đổi dữ liệu sản xuất. Có chủ ý: golden
//   eval ở đây là bài kiểm ĐỊNH TUYẾN, đúng phạm vi lane mock đã phủ; chạy hết
//   vòng lặp multi-round thật (runChatTurn) cho 71 ca sẽ thực thi tool thật —
//   kể cả tool GHI (ghi_nho/quen/lap_ke_hoach) — không có cách nào giữ idempotent.
//
// DÙNG
//   node scripts/generate-copilot-golden-real-results.mjs \
//     --email <email> --password <password> \
//     --org dddd0000-0000-4000-8000-000000000001 \
//     --provider-model openrouter:nvidia/nemotron-3-super-120b-a12b:free \
//     --results-out <tmp.json> [--limit N] [--delay-ms 1500]
//
// Credential từ flag hoặc env COPILOT_REAL_EVAL_EMAIL/PASSWORD — KHÔNG hardcode,
// KHÔNG in ra log/console.

import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inferMockOutcome,
  inferMockEmptyState,
  inferMockForbidden,
  inferMockScenario,
} from './run-copilot-golden-eval.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2);
    out[key] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

async function login(gotrueBase, apikey, email, password) {
  const res = await fetch(`${gotrueBase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.access_token) {
    throw new Error(`Đăng nhập thất bại (HTTP ${res.status}): ${body?.msg || body?.error_description || 'không rõ'}`);
  }
  return body.access_token;
}

async function callRpc(restBase, apikey, jwt, name, args) {
  const res = await fetch(`${restBase}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'public',
      'Accept-Profile': 'public',
    },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`RPC ${name} thất bại HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** Nạp system prompt + tool catalog production qua vite-node — không chép lại. */
function buildPromptsViaViteNode({ perms, availability, organizationId, cases }) {
  const tmpDir = join(repoRoot, '.tmp-copilot-loaders');
  mkdirSync(tmpDir, { recursive: true });
  const inputPath = join(tmpDir, '__g4_real_lane_input.json');
  const loaderPath = join(tmpDir, '__g4_real_lane_loader.mts');
  const inputPathEsc = inputPath.replace(/\\/g, '\\\\');
  writeFileSync(inputPath, JSON.stringify({ perms, availability, organizationId, cases }), 'utf8');
  const source = [
    "import { readFileSync } from 'node:fs';",
    "import { buildRegistry, toLlmTools } from '../src/copilot/tools/registry';",
    "import { CHAT_SYSTEM_PROMPT, TU_DIEN_NGHIEP_VU, VI_DU_MAU } from '../src/copilot/systemPromptVi';",
    "import { dongNangLuc, dongHomNay, dongKy, toolSangKhaiBao } from '../src/copilot/chatEngine';",
    "import { dongGhiNho } from '../src/copilot/memoryClient';",
    "import { taoRequestContext, quetKyTrongCau, soKyRiengBiet } from '../src/copilot/temporalContext';",
    "import { parseCopilotAvailability } from '../src/copilot/featureFlags';",
    "",
    `const input = JSON.parse(readFileSync('${inputPathEsc}', 'utf8'));`,
    // RPC get_my_copilot_availability_v1 trả snake_case (fetched_at/organization_id)
    // — parseCopilotAvailability() là bộ nạp THẬT (chấp cả hai kiểu khoá, kiểm
    // hạn dùng), dùng nó thay vì tin JSON thô: bản trước truyền thẳng JSON thô và
    // buildRegistry() lặng lẽ trả 0 tool vì copilotAvailabilitySnapshotIsFresh()
    // không nhận field fetched_at.
    "const availability = parseCopilotAvailability(input.availability);",
    "const ctx = {",
    "  perms: input.perms,",
    "  organizationId: input.organizationId,",
    "  isSuperAdmin: !!(input.perms && input.perms.__superadmin),",
    "  availability,",
    "  thread: null,",
    "};",
    "const registry = buildRegistry(availability);",
    "const toolMap = toLlmTools(registry, ctx);",
    "const khaiBao = toolSangKhaiBao(toolMap);",
    "const ctxThoiGian = taoRequestContext();",
    "const outCases = input.cases.map((c) => {",
    "  const dsKy = quetKyTrongCau(c.input, ctxThoiGian);",
    "  const nhieuKy = soKyRiengBiet(dsKy) > 1;",
    "  const heThong = [",
    "    CHAT_SYSTEM_PROMPT,",
    "    TU_DIEN_NGHIEP_VU,",
    "    VI_DU_MAU,",
    "    dongNangLuc(Object.keys(toolMap)),",
    "    dongHomNay(),",
    "    dongKy(dsKy, nhieuKy),",
    "    dongGhiNho([]),",
    "  ].filter(Boolean).join('\\n\\n');",
    "  return { id: c.id, heThong };",
    "});",
    "console.log(JSON.stringify({ tools: khaiBao, toolCount: Object.keys(toolMap).length, cases: outCases }));",
  ].join('\n');
  writeFileSync(loaderPath, source, 'utf8');
  try {
    const res = spawnSync('npx', ['vite-node', '.tmp-copilot-loaders/__g4_real_lane_loader.mts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
      throw new Error(`vite-node loader thất bại (exit ${res.status}):\n${String(res.stderr ?? '').slice(0, 4000)}`);
    }
    const lastLine = String(res.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    if (!lastLine) throw new Error('vite-node loader không in gì ra stdout.');
    return JSON.parse(lastLine);
  } finally {
    rmSync(inputPath, { force: true });
    rmSync(loaderPath, { force: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callModelOnce({ llmProxyBase, apikey, jwt, organizationId, providerModel, tools, heThong, userText, taskId }) {
  const body = {
    model: providerModel,
    messages: [
      { role: 'system', content: heThong },
      { role: 'user', content: userText },
    ],
    stream: false,
    max_tokens: 4096,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const t0 = Date.now();
  const res = await fetch(`${llmProxyBase}/chat/completions`, {
    method: 'POST',
    headers: {
      apikey,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'x-copilot-feature': 'chat',
      'x-task-id': taskId,
      'x-organization-id': organizationId,
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, ok: res.ok, body: parsed, rawText: text, latencyMs };
}

async function callModelWithRetry(params, maxAttempts = 4) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const r = await callModelOnce(params);
    if (r.ok) return r;
    // 429 (rate limit) / 5xx từ proxy hoặc upstream — thử lại có backoff. Lỗi
    // 4xx khác (400/401/403) không tự chữa được bằng thử lại.
    if (r.status === 429 || r.status >= 500) {
      lastErr = r;
      const backoffMs = Math.min(30_000, 2000 * 2 ** (attempt - 1));
      await sleep(backoffMs);
      continue;
    }
    return r;
  }
  return lastErr;
}

function buildInputHash(str) {
  // Không cần crypto mạnh — chỉ để dedupe log, dùng độ dài + vài ký tự.
  return `${str.length}:${str.slice(0, 12)}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const email = args.email || process.env.COPILOT_REAL_EVAL_EMAIL;
  const password = args.password || process.env.COPILOT_REAL_EVAL_PASSWORD;
  const organizationId = args.org || 'dddd0000-0000-4000-8000-000000000001';
  const providerModel = args['provider-model'] || 'openrouter:nvidia/nemotron-3-super-120b-a12b:free';
  const resultsOut = args['results-out'];
  const limit = args.limit ? Number(args.limit) : null;
  const delayMs = args['delay-ms'] ? Number(args['delay-ms']) : 1200;

  if (!email || !password) {
    console.error('Thiếu --email/--password (hoặc env COPILOT_REAL_EVAL_EMAIL/PASSWORD).');
    process.exitCode = 2;
    return;
  }
  if (!resultsOut) {
    console.error('Thiếu --results-out <file.json>.');
    process.exitCode = 2;
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
    || (readFileSync(join(repoRoot, '.env'), 'utf8').match(/VITE_SUPABASE_URL="([^"]+)"/)?.[1]);
  const apikey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    || (readFileSync(join(repoRoot, '.env'), 'utf8').match(/VITE_SUPABASE_PUBLISHABLE_KEY="([^"]+)"/)?.[1]);
  if (!supabaseUrl || !apikey) throw new Error('Không đọc được VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY từ .env.');
  const llmProxyBase = `${supabaseUrl}/functions/v1/llm-proxy`;

  console.error(`[1/5] Đăng nhập ${email}…`);
  const jwt = await login(supabaseUrl, apikey, email, password);

  console.error('[2/5] Đọc get_my_permissions + get_my_copilot_availability_v1…');
  const perms = await callRpc(supabaseUrl, apikey, jwt, 'get_my_permissions', {});
  const availability = await callRpc(supabaseUrl, apikey, jwt, 'get_my_copilot_availability_v1', { p_organization_id: organizationId });

  const golden = JSON.parse(readFileSync(join(repoRoot, 'tooling', 'copilot-golden-eval.json'), 'utf8'));
  let cases = golden.cases;
  if (limit) cases = cases.slice(0, limit);

  console.error(`[3/5] Nạp system prompt + tool catalog thật qua vite-node cho ${cases.length} ca…`);
  const loaded = buildPromptsViaViteNode({
    perms,
    availability,
    organizationId,
    cases: cases.map((c) => ({ id: c.id, input: c.input })),
  });
  console.error(`      tool catalog: ${loaded.toolCount} tool khả dụng cho actor này.`);
  const promptById = new Map(loaded.cases.map((c) => [c.id, c.heThong]));

  console.error(`[4/5] Gọi model thật (${providerModel}) cho từng ca (không thực thi tool nào)…`);
  const results = [];
  const raw = [];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    const heThong = promptById.get(c.id);
    if (!heThong) throw new Error(`Thiếu system prompt cho ca ${c.id} (lỗi loader).`);
    const taskId = `g4-golden-real-${c.id}-${Date.now().toString(36)}`;
    process.stderr.write(`      ${c.id} (${i + 1}/${cases.length})… `);
    let r;
    try {
      r = await callModelWithRetry({
        llmProxyBase, apikey, jwt, organizationId, providerModel,
        tools: loaded.tools, heThong, userText: c.input, taskId,
      });
    } catch (e) {
      r = { ok: false, status: 0, body: null, rawText: String(e?.message ?? e), latencyMs: 0 };
    }
    if (!r || !r.ok) {
      console.error(`BLOCKED (HTTP ${r?.status ?? '—'}): ${String(r?.rawText ?? '').slice(0, 200)}`);
      // Không đo được (mạng/hạn mức) — KHÔNG suy ra toolPath rỗng: rỗng trông
      // như "model không gọi tool nào", một khẳng định ta không hề có bằng
      // chứng. Dùng đúng toolPath MONG ĐỢI làm giá trị trung tính, để
      // validateGoldenCaseResult() không tự bịa ra một "toolPath mismatch" cho
      // một ca ta chưa từng hỏi được model — status 'blocked' đã nói đủ.
      results.push({
        id: c.id,
        status: 'blocked',
        latencyMs: r?.latencyMs ?? 0,
        toolPath: c.toolPath ?? [],
        outcome: inferMockOutcome(c.input),
        emptyState: inferMockEmptyState(c.input),
        forbidden: inferMockForbidden(c.input) !== null,
        oracle: { scenario: inferMockScenario(c.input) },
        blockedReason: (() => {
          try { return JSON.parse(r?.rawText ?? '')?.error?.code ?? `http_${r?.status ?? 'network_error'}`; }
          catch { return `http_${r?.status ?? 'network_error'}`; }
        })(),
      });
      raw.push({ id: c.id, input: c.input, expectedToolPath: c.toolPath, error: String(r?.rawText ?? '').slice(0, 500) });
    } else {
      const msg = r.body?.choices?.[0]?.message;
      const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      const toolPath = toolCalls
        .map((tc) => tc?.function?.name)
        .filter((name) => typeof name === 'string' && name.length > 0);
      console.error(`ok (${r.latencyMs}ms, tools=${JSON.stringify(toolPath)})`);
      results.push({
        id: c.id,
        status: 'pass',
        latencyMs: r.latencyMs,
        toolPath,
        outcome: inferMockOutcome(c.input),
        emptyState: inferMockEmptyState(c.input),
        forbidden: inferMockForbidden(c.input) !== null,
        oracle: { scenario: inferMockScenario(c.input) },
      });
      raw.push({
        id: c.id,
        input: c.input,
        expectedToolPath: c.toolPath,
        actualToolPath: toolPath,
        content: msg?.content ?? null,
        reasoning: msg?.reasoning ?? null,
        finishReason: r.body?.choices?.[0]?.finish_reason ?? null,
        usage: r.body?.usage ?? null,
      });
    }
    if (i < cases.length - 1) await sleep(delayMs);
  }

  console.error(`[5/5] Ghi ${resultsOut}`);
  writeFileSync(resultsOut, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  if (args['raw-out']) {
    writeFileSync(String(args['raw-out']), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  }
  const blocked = results.filter((r) => r.status === 'blocked').length;
  console.error(`Xong: ${results.length} ca, ${blocked} blocked (lỗi mạng/HTTP — xem log phía trên).`);
}

main().catch((e) => {
  console.error(`Lỗi: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
