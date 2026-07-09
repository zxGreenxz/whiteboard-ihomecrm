# PLAN: AI Copilot đa-provider cho ptcrm — tận dụng tối đa alibaba/page-agent + tự build phần page-agent chưa tối ưu

> Tài liệu này viết chi tiết để một AI agent khác có thể **review/audit độc lập**. Mọi khẳng định về page-agent đều đã kiểm chứng từ source tại `github.com/alibaba/page-agent` (branch main, đọc 07/2026). Mọi khẳng định về codebase ptcrm đều đã kiểm chứng bằng exploration trực tiếp repo này.

---

## 1. Context & Yêu cầu đã chốt với user

CRM ptcrm (React 18 + TypeScript + Vite, deploy Vercel từ `main`, backend Supabase — Postgres/Auth/Storage/Edge Functions, tiếng Việt, quản lý cho thuê BĐS). User muốn nhúng AI agent kiểu page-agent vào CRM:

| Quyết định | Lựa chọn của user |
|---|---|
| Nơi triển khai | Nhúng vào CRM ptcrm (không làm library riêng) |
| Provider | TẤT CẢ: OpenAI GPT, Anthropic Claude, Google Gemini, Qwen, DeepSeek, Groq, Ollama/local |
| Quản lý API key | Server-side proxy (Supabase Edge Function + secrets), KHÔNG lộ key ra browser. Ngoại lệ: Ollama browser→localhost |
| Khả năng v1 | (a) điều khiển UI bằng lệnh tiếng Việt + (b) custom tools nghiệp vụ + (c) chat hỏi đáp dữ liệu |
| AI cũ trong repo | **XOÁ TOÀN BỘ, làm mới hoàn toàn** (không tận dụng migration 026 / ai-chat / ai-embeddings cũ) |
| Triết lý | Tận dụng tối đa code có sẵn của page-agent; phần nào page-agent chưa tối ưu thì fix/build lại tối ưu hơn |

---

## 2. Facts đã kiểm chứng về page-agent (nguồn: source code)

### 2.1 Kiến trúc package (monorepo npm workspaces, MIT, derived from browser-use)

| Package | Nội dung | File chính |
|---|---|---|
| `page-agent` | Entry chính + UI Panel built-in | `packages/page-agent/src/PageAgent.ts` |
| `@page-agent/core` | Agent loop không UI | `packages/core/src/PageAgentCore.ts`, `prompts/system_prompt.md`, `tools/index.ts`, `types.ts` |
| `@page-agent/llms` | LLM client OpenAI-compatible | `packages/llms/src/OpenAIClient.ts`, `utils.ts` (modelPatch), `errors.ts` |
| `@page-agent/page-controller` | DOM ops + mask hiệu ứng | `packages/page-controller/src/PageController.ts`, `dom/`, `mask/`, **`patches/react.ts` + `patches/antd.ts`** |
| `@page-agent/ui` | Panel + i18n (chỉ en-US/zh-CN) | `packages/ui/src/` |

### 2.2 Config & API (từ `core/src/types.ts` + docs)

- `new PageAgent({ model, baseURL, apiKey, language: 'en-US'|'zh-CN', maxSteps (default 40), stepDelay (default 0.4s), customTools, instructions })` — gọi endpoint **OpenAI-compatible `POST {baseURL}/chat/completions`**.
- Custom tools: `tool({ description, inputSchema: zod (import từ zod/v4, hỗ trợ zod 3 >=3.25.0 và zod 4), execute: async (input, {signal}) => string })`; override built-in bằng cùng tên; **tắt built-in bằng `null`** (vd `execute_javascript: null`).
- Events từ PageAgentCore: `statuschange` (idle→running→completed/error/stopped), `historychange` (persisted, vào memory LLM), `activity` (transient: thinking/executing/executed/retrying/error), `dispose`. State: `agent.history`, `agent.status`.
- Hooks: `onBeforeStep/onAfterStep/onBeforeTask/onAfterTask/onDispose`, `agent.onAskUser(question, options)`.
- UI thay được hoàn toàn: PageAgentCore + PageController + UI riêng (docs advanced/custom-ui có ví dụ React hook).

### 2.3 Hành vi LLM client (từ `llms/src/OpenAIClient.ts`)

- **Non-streaming** (1 request/step, chờ full response).
- **Native tool-calling** (`tools` param, `parallel_tool_calls: false`, 1 tool/step); `zodToOpenAITool()`; hỗ trợ `toolChoiceName` (named tool_choice) trừ khi `disableNamedToolChoice`.
- Track usage đầy đủ: prompt/completion/total/cached/reasoning tokens.
- **Không retry transient error trong client** (core có retry ở tầng task — event `retrying` attempt/maxAttempts).
- **`modelPatch()` nhận diện provider THEO baseURL** để vá quirk (vd Gemini `finish_reason: "function_call"`).

### 2.4 System prompt (từ `core/src/prompts/system_prompt.md`)

- ~2.500 từ tiếng Anh; agent loop nhận history + state + browser state (URL, element đánh index `[n]`, cây thụt lề, `*` = element mới).
- **Có sẵn "Use the language that user is using. Return in user's language"** → tiếng Việt được hỗ trợ ở tầng prompt gốc (không cần fork để agent trả lời tiếng Việt).
- Ràng buộc: chỉ tương tác element có index; bỏ cuộc khi gặp captcha; `done` khi xong/fail.

---

## 3. Phân tích TẬN DỤNG vs FIX — phần cốt lõi để audit

### 3.1 Dùng nguyên của page-agent (không viết lại)

| # | Thành phần | Lý do dùng nguyên |
|---|---|---|
| R1 | Agent loop reflection→action (`PageAgentCore`) | Mental model reflection (evaluation/memory/next_goal) đã tinh chỉnh từ browser-use, tự viết lại kém hơn chắc chắn |
| R2 | DOM serialization + indexing (`page-controller/dom/`) | Bài toán khó nhất của GUI agent; đã kế thừa từ browser-use production-tested |
| R3 | `PageController` + mask/cursor hiệu ứng | Click/type/scroll + visual feedback sẵn, có **patch React controlled-input** (`patches/react.ts`) — CRM này là React nên patch này quan trọng |
| R4 | Hệ thống `tool()` + zod/v4 → OpenAI tool schema | Chuẩn, có validation; repo ptcrm đã có `zod@^3.25.76` (đủ điều kiện `zod/v4` subpath) |
| R5 | Event system + hooks an toàn (`onBeforeStep`, `onAskUser`) | Đủ hook để gắn guard + UI riêng, không cần fork |
| R6 | Cơ chế xoá/override built-in tools (`execute_javascript: null`) | Đúng cái cần cho an toàn |
| R7 | System prompt gốc (đã có "return in user's language") | Không fork ở v1; bổ sung ngữ cảnh qua `instructions` chính thống |

### 3.2 page-agent CHƯA TỐI ƯU → ta fix/build lại (mỗi dòng là 1 hạng mục audit)

| # | Điểm chưa tối ưu của page-agent | Ảnh hưởng nếu để nguyên | Fix của ta |
|---|---|---|---|
| F1 | **Thiết kế apiKey client-side** — key nằm trong JS browser | Lộ key = ai mở DevTools cũng lấy được, không kiểm soát chi phí | **Edge Function `llm-proxy`**: browser gửi JWT Supabase làm `apiKey` (đúng wire-format `Authorization: Bearer` mà cả page-agent lẫn Supabase gateway cùng hiểu); proxy validate JWT → thay bằng key thật từ secrets |
| F2 | **Chỉ 1 model/baseURL tĩnh, không có registry đa provider** | Muốn đổi AI phải sửa code | Bảng `ai_providers` (admin bật/tắt, danh sách model, default) + quy ước `model = "provider:model-id"` proxy tách và route; user tự chọn model qua `ui_preferences` |
| F3 | **`modelPatch()` vá quirk theo baseURL** — đi qua proxy thì baseURL luôn là proxy → toàn bộ patch provider MẤT TÁC DỤNG | Gemini/Anthropic có thể lỗi lặt vặt (finish_reason, param không hỗ trợ) mà client không tự vá | **Chuyển việc chuẩn hoá vào proxy** (đúng chỗ hơn): proxy biết provider thật → strip param không hỗ trợ per-provider, map finish_reason về chuẩn OpenAI, đảm bảo response trả về LUÔN đúng format OpenAI thuần |
| F4 | **LLM client không retry transient error** (429/5xx throw ngay) | Task đứt giữa chừng vì 1 lần rate-limit | Proxy retry 1 lần cho 429/5xx (backoff ngắn), vẫn trả lỗi chuẩn nếu fail — page-agent core retry tầng task vẫn hoạt động như lớp thứ 2 |
| F5 | **Không track usage/cost, không quota** | Nhân viên xài thả ga = cháy ví | Proxy insert `ai_usage_logs` mỗi request (đọc `usage` từ response) + **cost guard**: cap token/ngày/user, vượt → 429 kèm message tiếng Việt |
| F6 | **DOM snapshot mỗi step, token-heavy** — trang CRM có bảng hàng trăm dòng → snapshot rất lớn, đắt & chậm, và không nén được từ ngoài | Mỗi lệnh tốn nhiều token, chậm trên trang danh sách | Giảm nhu cầu snapshot bằng thiết kế: (a) tool `mo_trang` điều hướng thẳng thay vì để agent click sidebar nhiều step; (b) **business tools trả dữ liệu trực tiếp** thay vì bắt agent đọc bảng trên màn hình; (c) `maxSteps: 25`; (d) default model rẻ+nhanh (Groq/DeepSeek); (e) theo dõi thực tế qua `ai_usage_logs` để quyết có cần fork DOM-pruning không (để sau, KHÔNG fork sớm) |
| F7 | **Không có mode chat hỏi đáp** — chỉ là task executor trên DOM | "Doanh thu tháng này?" mà đi click UI là vòng vèo, sai bản chất | Tự build **chat loop function-calling** (fetch tới cùng proxy, `tools` = JSON Schema sinh từ CHÍNH zod schema của tools qua `z.toJSONSchema`) — dùng chung registry tools với mode điều khiển, max 6 vòng tool |
| F8 | **Không có khái niệm phân quyền/an toàn nghiệp vụ** — agent bấm được mọi thứ user bấm được | Agent có thể bấm nút Xoá/Duyệt | 4 lớp: (1) quyền `ai_copilot.view` mới quyết ai được dùng; (2) mọi tool `execute` check `canUse(perms, module, 'view')` trước khi query; (3) `customTools: { execute_javascript: null }` + `instructions` cấm bấm Xoá/Huỷ/Duyệt khi chưa xác nhận + guard `onBeforeStep`; (4) mọi query chạy bằng session user → **RLS Postgres là lớp chặn cuối** (server-side, không bypass được) |
| F9 | **UI Panel chỉ i18n en-US/zh-CN** | Nhãn nút tiếng Anh/Trung trên CRM tiếng Việt | v1 chấp nhận Panel built-in (agent vẫn trả lời tiếng Việt); **Phase 4 build UI tiếng Việt riêng** bằng PageAgentCore + events theo đúng docs custom-ui (đã có ví dụ React hook) — quyết định dựa trên feedback thật, không build trước |
| F10 | **Non-streaming** | Chat Q&A chờ lâu mới thấy chữ | Action loop giữ non-streaming (bản chất từng step, OK). Proxy **pass-through SSE sẵn** (`if body.stream → pipe upstream.body`); ChatPanel bật streaming ở Phase 4 (repo chưa có SSE precedent nào — tách rủi ro khỏi v1) |
| F11 | **Không xử lý token hết hạn giữa task** (apiKey tĩnh theo instance) | JWT Supabase sống ~1h; task giữa chừng có thể 401 | **Tạo agent mới mỗi task** với token tươi từ `supabase.auth.getSession()` (construction rẻ; supabase-js tự refresh nền) |
| F12 | **Gửi DOM + dữ liệu màn hình lên LLM bên thứ 3** (bản chất mọi GUI agent) | Rủi ro riêng tư dữ liệu khách thuê | Admin kiểm soát provider nào được bật (`ai_providers.enabled`); **Ollama local** là lối thoát cho dữ liệu nhạy cảm; ghi rõ trong docs nội bộ |

---

## 4. Kiến trúc tổng

```
Browser (React SPA — ptcrm)
├─ src/copilot/ (lazy chunk, page-agent dynamic-import khi mở lần đầu)
│   ├─ CopilotLauncher.tsx — nút nổi, gate: session + canUse('ai_copilot','view') + ≥1 provider enabled; ẩn trên route public
│   ├─ Mode "Điều khiển trang" → new PageAgent({...}) — UI Panel built-in (v1)
│   ├─ Mode "Hỏi đáp dữ liệu" → ChatPanel.tsx + chatLoop.ts (function-calling)
│   └─ tools/businessTools.ts — registry DÙNG CHUNG 2 mode; execute = supabase-js session user ⇒ RLS + canUse
│
├─ LLM traffic ──► Supabase Edge Function `llm-proxy`
│     baseURL = https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/llm-proxy
│     apiKey  = user access_token (JWT)
│     POST .../llm-proxy/chat/completions
│     → validate JWT → parse "provider:model" → check ai_providers → cost guard
│     → fetch provider (secret server) → chuẩn hoá response về OpenAI format → log ai_usage_logs
│
└─ Ngoại lệ: provider "ollama" → browser fetch thẳng http://localhost:11434/v1 (không qua proxy)
```

### Routing table trong proxy

| provider | baseURL upstream | secret (Supabase Function secrets) |
|---|---|---|
| openai | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| anthropic | `https://api.anthropic.com/v1` (OpenAI-compat chính thức) | `ANTHROPIC_API_KEY` |
| gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` |
| qwen | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| deepseek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |

Ghi chú audit: cả 6 endpoint đều nhận `Authorization: Bearer <key>` + body OpenAI chuẩn → proxy chỉ cần 1 code path fetch + lớp normalize per-provider (F3).

---

## 5. Phases triển khai (mỗi phase ship độc lập được)

### Phase 0 — Dọn sạch AI cũ + Spike khả thi (~1 ngày)

**0a. Dọn AI cũ** (commit riêng `chore(ai): gỡ toàn bộ AI assistant cũ chưa dùng`):
- Kiểm tra qua Management API: 4 bảng `ai_conversations`, `ai_messages`, `ai_memory_embeddings`, `ai_usage_stats` rỗng/không FE nào gọi (đã xác minh: 0 caller trong `src/`).
- Migration `supabase/migrations/20260709000000_drop_legacy_ai.sql`: `DROP TABLE ... CASCADE` 4 bảng + `DROP FUNCTION search_similar_memories, get_conversation_context`. Apply qua Management API bằng Node script UTF-8 (convention repo — schema_migrations stale).
- Xoá `supabase/functions/ai-chat/`, `supabase/functions/ai-embeddings/` trong repo + `supabase functions delete` trên project. Cập nhật `supabase/functions/README.md`.

**0b. Spike (branch/chưa push đến khi pass) — 5 gate:**
1. `npm i page-agent` (pin exact version; xác nhận tên package & exports thực tế trên npm registry).
2. Deploy `llm-proxy` tối giản (chỉ OpenAI); `supabase secrets set OPENAI_API_KEY=...`.
3. Gate A — hạ tầng: JWT-as-apiKey qua gateway OK (kể cả CORS preflight từ localhost + ptcrm.vercel.app). Nếu gateway `verify_jwt` chặn kiểu request nào đó → deploy `--no-verify-jwt`, function TỰ validate JWT (bảo mật tương đương, ghi rõ trong code comment). Subpath `/functions/v1/llm-proxy/chat/completions` route được (match `pathname.endsWith('/chat/completions')`).
4. Gate B — chất lượng tiếng Việt: trên dev server, lệnh thật "mở trang hoá đơn rồi lọc phòng 101", "điền form tạo khách hàng tên Nguyễn Văn A" — agent hiểu + phản hồi tiếng Việt (system prompt gốc đã có "return in user's language"; `instructions` tiếng Việt bổ sung ngữ cảnh CRM).
5. Gate C — kỹ thuật: Panel built-in không vỡ style CRM (desktop + mobile viewport); `import { z } from 'zod/v4'` resolve; đo size lazy chunk; test click vào Radix Select/Dialog (portal) trên trang hoá đơn.

**Điều kiện dừng**: Gate B fail hẳn (agent không dùng được tiếng Việt) → báo user, đề xuất hạ scope UI-control xuống experimental, ưu tiên mode Hỏi đáp.

### Phase 1 — Backend: `llm-proxy` + schema DB mới

**Migration `20260709000001_ai_copilot.sql`** (schema MỚI hoàn toàn — không dính gì bảng cũ):

```sql
-- ai_providers: registry provider/model, admin quản
create table ai_providers (
  provider text primary key check (provider in ('openai','anthropic','gemini','qwen','deepseek','groq','ollama')),
  enabled boolean not null default false,
  label text not null,
  models jsonb not null default '[]',        -- [{id, label}]
  default_model text,
  updated_at timestamptz not null default now()
);
-- RLS: SELECT cho authenticated; INSERT/UPDATE/DELETE chỉ admin (dùng hàm admin-check sẵn có của repo)
-- Seed 7 dòng enabled=false

-- ai_usage_logs: audit + cost guard
create table ai_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  provider text not null,
  model text not null,
  feature text not null check (feature in ('copilot','chat')),
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  total_tokens int not null default 0,
  status text not null default 'ok',          -- ok | upstream_error | over_quota
  created_at timestamptz not null default now()
);
create index on ai_usage_logs (user_id, created_at);
-- RLS: user SELECT own; admin SELECT all; KHÔNG có INSERT policy (chỉ service role ghi)

-- ai_chat_threads / ai_chat_messages: lịch sử mode Hỏi đáp (bảng MỚI thay bảng cũ đã drop)
create table ai_chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table ai_chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references ai_chat_threads(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')),
  content text not null,
  tool_name text,
  created_at timestamptz not null default now()
);
-- RLS: user own toàn bộ (qua thread.user_id)
```

**Edge function `supabase/functions/llm-proxy/index.ts`** — clone skeleton `send-push` (corsHeaders inline, OPTIONS→200, adminClient service-role + callerClient bound JWT):

Flow tuần tự:
1. OPTIONS → 200 corsHeaders.
2. `callerClient.auth.getUser()` fail → 401.
3. Parse body; tách `model` tại dấu `:` **đầu tiên** → `(provider, realModel)`.
4. adminClient đọc `ai_providers`: provider phải `enabled` + realModel thuộc `models` → sai thì 403.
5. **Cost guard (F5)**: `sum(total_tokens)` hôm nay của user từ `ai_usage_logs`; vượt `DAILY_TOKEN_CAP` (Deno.env, default 500k) → 429 message tiếng Việt.
6. **Normalize request per-provider (F3)**: rewrite `body.model = realModel`; strip param provider không hỗ trợ (bảng cấu hình nhỏ trong code, vd Anthropic-compat không nhận `frequency_penalty`).
7. `fetch(base + '/chat/completions', { headers: { Authorization: Bearer <secret> }, body })`; **retry 1 lần nếu 429/5xx (F4)**, backoff 1s.
8. `body.stream === true` → pipe `upstream.body` về nguyên trạng với header SSE (F10). Ngược lại: đọc JSON, **normalize response về OpenAI chuẩn (F3)** (finish_reason map), insert `ai_usage_logs` (feature từ header `x-copilot-feature`, default `'copilot'` — page-agent không set custom header được, chat loop của ta thì set), trả về.
9. Upstream lỗi hẳn → trả nguyên status + body lỗi OpenAI-format, log `status='upstream_error'`.

Deploy: `supabase functions deploy llm-proxy` + set secrets các provider user có key.

**Test Phase 1**: curl trực tiếp với JWT thật (từng provider enabled), JWT hết hạn→401, provider disabled→403, vượt cap→429.

### Phase 2 — FE: nhúng PageAgent (UI built-in) + quyền

Thư mục mới `src/copilot/`:

| File | Nội dung |
|---|---|
| `CopilotLauncher.tsx` | Nút nổi góc phải dưới (mobile offset trên tab bar, dùng `usePhoneViewport()` từ `src/hooks/use-mobile.tsx`); toggle bật/tắt agent; render null khi: chưa login / thiếu quyền / 0 provider enabled / route public (`/r/:`, `/c/:`, `/login`, `/phongtrong`). `React.lazy` toàn bộ; `import('page-agent')` khi bật lần đầu |
| `createAgent.ts` | Factory mỗi task (F11): `getSession()` → token tươi → `new PageAgent({ model: 'provider:model', baseURL: FUNCTIONS_URL + '/llm-proxy', apiKey: token, language: 'en-US', instructions: SYSTEM_PROMPT_VI, maxSteps: 25, stepDelay: 0.4, customTools })`; `dispose()` khi tắt/logout |
| `systemPromptVi.ts` | `instructions` tiếng Việt: ngữ cảnh CRM (domain thuê phòng, tên các trang chính), luật an toàn F8 ("TUYỆT ĐỐI không bấm nút Xoá/Huỷ/Duyệt/Thanh lý khi user chưa xác nhận rõ ràng"), "luôn trả lời tiếng Việt" |
| `copilotConfig.ts` + `useAiProviders.ts` | React Query hook đọc `ai_providers`; chọn model: `useUiPreferences()` key `ai_copilot_model` ("provider:model") → fallback default_model của provider enabled đầu tiên. Dùng `profiles.ui_preferences` jsonb SẴN CÓ, KHÔNG tạo bảng mới |
| `ollama.ts` | Provider ollama: baseURL `http://localhost:11434/v1`, apiKey `'ollama'`, model user tự gõ trong popover cài đặt; kèm hướng dẫn `OLLAMA_ORIGINS=https://ptcrm.vercel.app ollama serve` (Chrome cho https→http://localhost; Safari không — ghi chú trong UI) |

**Quyền** (repo có test orphan-key ÉP sửa cả 2 file — `src/lib/__tests__/permissionPages.test.ts`):
- `src/lib/permissions.ts`: thêm module `{ key: 'ai_copilot', label: 'Trợ lý AI', core: ['view'] }` vào PERMISSION_GROUPS.
- `src/lib/permissionPages.ts`: thêm PermissionPage tương ứng.
- `src/App.tsx`: mount `<Suspense fallback={null}><CopilotLauncher/></Suspense>` TRONG `<BrowserRouter>` ngay sau `<Suspense><Routes/></Suspense>` (cần `useNavigate`/`useLocation`).

### Phase 3 — Tools nghiệp vụ + Chat hỏi đáp

**`src/copilot/tools/businessTools.ts`** — registry dùng nguyên `tool()` + `z` từ `zod/v4` (R4), dùng chung 2 mode. Mỗi `execute`: (1) check `canUse(perms, module, 'view')` → thiếu quyền trả `"Bạn không có quyền xem <mục>."`; (2) query bằng supabase client session user (RLS chặn cuối — F8); (3) kết quả text tiếng Việt gọn, limit dòng cứng, tiền format VND; (4) honor `ctx.signal`.

| Tool | Description (model đọc) | Nguồn dữ liệu | Quyền |
|---|---|---|---|
| `phong_trong` | Liệt kê phòng trống/sắp trống kèm giá, toà | RPC `get_my_available_rooms` (sẵn có) | rooms |
| `tim_phong` | Tìm phòng theo mã/toà → trạng thái, giá, khách đang thuê | rooms+buildings `.ilike` limit 20 | rooms |
| `tim_khach_hang` | Tìm khách theo tên/SĐT | customers `.ilike` limit 20 | customers |
| `tim_hoa_don` | Tra hoá đơn theo phòng/khách/tháng/trạng thái | invoices query (lọc `kind` — hoá đơn thanh lý là kind riêng) | invoices |
| `hop_dong_sap_het_han` | HĐ đáo hạn trong N ngày | contracts query | contracts |
| `doanh_thu_thang` | Tổng thu/chi theo tháng | RPC `cashbook_settlement_report` (sẵn có) | reports_finance |
| `mo_trang` | Mở trang CRM theo tên tiếng Việt | whitelist alias→route + `navigate()` (F6: đỡ N step click) | — |

**`src/copilot/chatLoop.ts` + `ChatPanel.tsx`** (F7): vòng lặp fetch tới llm-proxy, `tools` = JSON Schema sinh từ CHÍNH zod schema trên qua `z.toJSONSchema` (1 nguồn schema duy nhất cho cả 2 mode — điểm audit: không duplicate schema), max 6 vòng tool, header `x-copilot-feature: chat`; system prompt domain CRM; lưu `ai_chat_threads`/`ai_chat_messages` bằng client user (RLS). v1 non-streaming.

**Launcher**: toggle 2 mode "Điều khiển trang" / "Hỏi đáp dữ liệu".

**Vitest** (style `src/lib/__tests__/`, hàm pure đặt `src/copilot/lib/`): parse `provider:model` (model chứa `:` → split lần đầu), whitelist `mo_trang`, zod schema accept/reject, message từ chối quyền.

### Phase 4 — Admin + tối ưu (từng mục độc lập)

1. Section Settings admin-only: bật/tắt provider, sửa models/default (ghi `ai_providers`, RLS ép admin), bảng tổng hợp `ai_usage_logs` per user/ngày.
2. Popover chọn model per-user trong Launcher → `useSetUiPreference('ai_copilot_model', ...)`.
3. **UI tiếng Việt riêng thay Panel built-in (F9)**: PageAgentCore + PageController + subscribe `statuschange/historychange/activity` theo docs custom-ui — CHỈ làm nếu feedback thật cho thấy panel en gây khó.
4. SSE streaming cho ChatPanel (proxy đã sẵn — F10).
5. Cap token/ngày chuyển từ env sang cấu hình admin.
6. Nếu `ai_usage_logs` cho thấy token/step quá cao trên trang danh sách → cân nhắc fork/PR DOM-pruning (F6, quyết định bằng số liệu).

---

## 6. Điều kiện tiên quyết user chuẩn bị

- API key thật từng provider muốn bật (OpenAI/Anthropic/Gemini/DashScope/DeepSeek/Groq) — bật dần được, kiến trúc không đổi.

## 7. Rủi ro & giảm nhẹ (tóm tắt cho auditor)

| Rủi ro | Mức | Giảm nhẹ |
|---|---|---|
| Tiếng Việt kém với prompt en gốc | Trung | Gate B Phase 0 chặn trước khi build tiếp; prompt gốc đã có "return in user's language" |
| page-agent trẻ, API đổi | Trung | Pin version; mọi import gói trong `src/copilot/` (1 chỗ swap) |
| Agent click trong Radix portal fail | Trung | Test Gate C; fallback = business tools làm thay thao tác dữ liệu |
| Provider compat lệch chuẩn OpenAI | Thấp | Lớp normalize trong proxy (F3), sửa per-provider khi lỗi cụ thể |
| Drop bảng AI cũ mất dữ liệu | Thấp | Xác minh bảng rỗng + 0 FE caller trước khi drop |
| Chi phí LLM vượt kiểm soát | Thấp | Cost guard + log từ ngày đầu (F5) |
| ~110 lỗi TS pre-existing | — | So SỐ LỖI trước/sau (`npx tsc --noEmit -p tsconfig.app.json`), không đòi 0 |

## 8. Verification (theo CLAUDE.md workflow)

1. `npx tsc --noEmit -p tsconfig.app.json` — không tăng lỗi so baseline.
2. `npx vitest run` — suite cũ (orphan-key test chứng minh quyền nối đủ 2 file) + test copilot mới.
3. Smoke proxy bằng curl: mỗi provider enabled 200; JWT hỏng 401; provider disabled 403; vượt cap 429; bảng cũ đã drop.
4. `npm run build` — copilot là chunk riêng, main bundle không phình.
5. Playwright trên ptcrm.vercel.app (tài khoản test): login → widget hiện đúng quyền (và ẨN với role thiếu quyền) → lệnh "mở trang hoá đơn" điều hướng đúng → hỏi "phòng nào đang trống?" ra dữ liệu thật → `ai_usage_logs` có dòng mới → console không error.
6. Commit style repo (`feat(copilot): ...` Việt-Anh), push main → Vercel auto-deploy, re-test production.

## 9. Danh sách file (cho auditor đối chiếu scope)

- **Xoá**: `supabase/functions/ai-chat/`, `supabase/functions/ai-embeddings/` (+ delete trên Supabase; drop 4 bảng + 2 RPC cũ)
- **Mới**: `supabase/migrations/20260709000000_drop_legacy_ai.sql`, `supabase/migrations/20260709000001_ai_copilot.sql`, `supabase/functions/llm-proxy/index.ts`, `src/copilot/{CopilotLauncher.tsx, createAgent.ts, systemPromptVi.ts, copilotConfig.ts, useAiProviders.ts, ollama.ts, chatLoop.ts, ChatPanel.tsx, tools/businessTools.ts, lib/*.ts (+tests)}`
- **Sửa**: `src/App.tsx`, `src/lib/permissions.ts`, `src/lib/permissionPages.ts`, `package.json` (+`page-agent`), `supabase/functions/README.md`
- **Tham chiếu pattern sẵn có**: `supabase/functions/send-push/index.ts` (auth skeleton), `src/hooks/useMyAvailableRooms.ts` (RPC hook), `src/components/auth/RequirePermission.tsx`, `useUiPreferences`

## 10. Câu hỏi mở cho auditor

1. Quy ước `model = "provider:model-id"` vs custom header/param riêng — chọn model-prefix vì page-agent không cho set custom header; auditor thấy cách nào sạch hơn?
2. Cost guard đặt cap theo token/ngày/user — có nên thêm cap theo tiền (USD) quy đổi per-model không, hay để Phase 4?
3. v1 dùng UI Panel built-in (en) — chấp nhận được với người dùng Việt trong giai đoạn thử nghiệm?
4. Có nên thêm RPC `ai_search_*` dedicated ngay từ Phase 3 thay vì `.ilike` từ browser (hiệu năng + kiểm soát cột lộ ra) — plan hiện để "khi nào chậm mới thêm"?
