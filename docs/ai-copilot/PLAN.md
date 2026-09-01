# PLAN v2.1: AI Copilot đa-provider cho ptcrm — tận dụng tối đa alibaba/page-agent + tự build phần page-agent chưa tối ưu

> **[CÒN SỐNG — trạng thái 02/09/2026]** Source v2.1 đã triển khai chat/tool/UI-control nhưng CHƯA đạt release gate full-site control. Trạng thái bằng chứng: `README.md` cùng thư mục; plan hiện hành: `../superpowers/plans/2026-08-13-ai-copilot-superadmin-full-site-control.md`.

> **Lifecycle:** source v2.1 đã triển khai các phần chat/tool/UI-control, nhưng đối chiếu live evaluation 2026-08-13 cho thấy chưa đạt release gate cho full-site control. Đọc [README current](README.md) và [audit/plan LEAN](../superpowers/plans/2026-08-13-ai-copilot-superadmin-full-site-control.md) để biết trạng thái bằng chứng hiện hành. Các đoạn “sẽ làm” bên dưới là rationale hoặc backlog, không phải claim đã pass.

> Tài liệu này viết chi tiết để một AI agent khác có thể **review/audit độc lập**. Mọi khẳng định về page-agent đều đã kiểm chứng từ source tại `github.com/alibaba/page-agent` (branch main, đọc 07/2026). Mọi khẳng định về codebase ptcrm đều đã kiểm chứng bằng exploration trực tiếp repo này.
>
> **Changelog v2.1 (10/07/2026)** — sau audit ngoài vòng 2 (9/9 finding xác nhận đúng sau kiểm chứng độc lập, verdict Phụ lục 14): (1) **entitlement riêng `ai_copilot_entitlements`** — sentinel `__superadmin` của owner + route `/register` public làm permission-check không phải kill switch thật; entitlement check gộp vào RPC reserve (1 roundtrip, không cache); (2) **`ai_providers` write = `is_super_admin()`** (is_admin() là admin per-tenant); `ai_usage_logs` thêm `owner_id` cho dashboard theo tenant; (3) **`ai_copilot_settings` singleton** (cap user/tenant/global, rate, kill switch) — Postgres không đọc được env Edge Function; RPC nội bộ REVOKE PUBLIC/anon/authenticated + GRANT service_role (đúng pattern hardening `20260710130500`); so sánh `>=`; (4) **config đúng API thật**: `instructions` là OBJECT `{system, getPageInstructions}`; blacklist qua **event `beforeUpdate` + stamp `data-page-agent-not-interactive`** (attribute được re-query mỗi updateTree); `onBeforeStep` chặn khi SPA rời route allowlist; (5) **bỏ retry trong proxy** — LLM class upstream đã retry mặc định 2 (verified `maxRetries ?? 2`), 2 tầng = 6 attempt; quota trả **403** (non-retryable) thay 429; (6) **chat tái dùng `LLM` class của @page-agent/llms** + tool `respond` thay vì tự viết loop; domain-tool registry 2 adapter; (7) `doanh_thu_thang` đổi nguồn **`fa_monthly_pnl`** (settlement report là bàn giao sổ, không phải KQKD); tools tái dùng `invoicesListQuery`/`contractsPagedQuery`/`mapPayloadToBuildings` + metadata `requiredPermission`; (8) route canonical **`/apartments`**; deep-link filter chỉ trên route có URL hydration thật; `mo_trang` chỉ cấp cho UI-control; (9) `sequence_no` cấp qua RPC append (client max+1 sẽ race) + `buildChatContext()` giới hạn context + FK ON DELETE CASCADE; telemetry task ghi rõ nơi lưu; pilot đầu CHỈ navigation/filter (form-fill → Phase 3b); reservation expired vẫn TÍNH vào quota đến hết ngày.
>
> v2.0: authz server-side, element exclusion thay safeClick, reserve atomic + USD cap, customFetch, PII masking, schema tool-call, UI-control experimental. v1.1: 17 finding nội bộ. v1.2: OpenRouter + phụ lục n2store.

---

## 1. Context & Yêu cầu đã chốt với user

CRM ptcrm (React 18 + TypeScript + Vite, deploy Vercel từ `main`, backend Supabase — Postgres/Auth/Storage/Edge Functions, tiếng Việt, quản lý cho thuê BĐS, **multi-tenant**: nhiều owner, staff gán qua staff_assignments). User muốn nhúng AI agent kiểu page-agent:

| Quyết định | Lựa chọn |
|---|---|
| Nơi triển khai | Nhúng vào ptcrm |
| Provider | OpenAI, Claude, Gemini, Qwen, DeepSeek, Groq, OpenRouter, Ollama/local |
| Key | Server-side proxy (Edge Function + secrets); Ollama browser→localhost |
| Khả năng | (a) chat hỏi đáp + tools nghiệp vụ (ship trước), (b) điều khiển UI (**experimental, pilot**) |
| AI cũ | XOÁ TOÀN BỘ (sau khi spike pass) |
| Triết lý | Tận dụng tối đa page-agent; phần chưa tối ưu thì fix/build lại |

---

## 2. Facts đã kiểm chứng (page-agent + codebase, cập nhật v2.1)

### 2.1 page-agent (npm latest **1.11.0**; monorepo MIT, derived from browser-use)

- Packages: `page-agent` (entry+Panel), `@page-agent/core`, `@page-agent/llms`, `@page-agent/page-controller` (có `patches/react.ts`), `@page-agent/ui` (i18n chỉ en/zh).
- **`instructions` là OBJECT** (verified types.ts): `{ system?: string; getPageInstructions?: (url: string) => string | undefined | null }` — page-level gọi TRƯỚC MỖI STEP theo URL hiện tại.
- **`customFetch`** (LLMConfig): "customize headers, credentials, proxy" — móc chính thống gắn JWT tươi + header custom mỗi request.
- **`transformPageContent?: (content) => string|Promise<string>`** — sau DOM extraction, trước LLM → móc mask PII.
- **`maxRetries`** (LLMConfig): **LLM class retry mặc định 2** (`config.maxRetries ?? 2`), backoff 100ms, retry lỗi `retryable` (network/429/5xx/tool-validation), KHÔNG retry AbortError (verified `llms/src/index.ts`). `@page-agent/llms` export public: `LLM`, `Message`, `Tool`, `InvokeError`, `LLMConfig`… → **tái dùng được cho chat loop**.
- Built-in tools (tên thật): `done`, `wait`, `ask_user`, `click_element_by_index`, `input_text`, `select_dropdown_option`, `scroll`, `scroll_horizontally`, `execute_javascript`. Custom tool override theo đúng tên; `null` để xoá.
- `selectorMap`/`elementTextMap` PRIVATE — không đọc được element đích từ custom tool.
- **Element exclusion**: config `interactiveBlacklist` là **MẢNG Element** (spread `...(config.interactiveBlacklist||[])`) merge với `document.querySelectorAll('[data-page-agent-not-interactive]')` **mỗi lần updateTree** → cách đúng là stamp attribute động. **PageController phát event `beforeUpdate`/`afterUpdate`** quanh mỗi lần build tree (verified `dispatchEvent(new Event('beforeUpdate'))`) → nghe `beforeUpdate` để stamp trước khi tree được dựng.
- Lifecycle (verified PageAgentCore): `execute()` **reset `this.history = []` mỗi task** → follow-up KHÔNG giữ ngữ cảnh kể cả giữ nguyên instance; status='running' TRƯỚC `onBeforeTask`; `onBeforeStep` throw → abort task (không có try-catch quanh hook) → dùng làm guard route allowlist.
- System prompt gốc có "Return in user's language" → tiếng Việt OK. Docs Security & Permissions có `<BetaNotice />` → UI-control phải experimental.
- LLM client: non-streaming; native tool-calling (`parallel_tool_calls:false`); usage đủ (kể cả cached); `modelPatch()` theo baseURL → mất tác dụng sau proxy, proxy tự normalize.

### 2.2 Codebase ptcrm (verified)

- **`get_my_permissions()`** (migration `20260701170000` — SECURITY DEFINER): owner thật (không staff/cổ đông/quản lý) → trả `'{"__superadmin": true}'` → **mọi check permission luôn pass với owner**; `/register` là route PUBLIC (App.tsx:201) → tài khoản tự đăng ký = owner tenant riêng = sentinel → **permission KHÔNG phải kill switch**.
- **`is_admin()`** (migration `20260506000002`) = admin CỦA TỪNG TENANT (staff_assignments role Admin) — không phải quản trị nền tảng; `is_super_admin()` tồn tại riêng (useIsAdmin.ts).
- Pattern hardening RPC nội bộ mới nhất: `20260710130500_revoke_internal_definer_grants.sql` — SECURITY DEFINER SET search_path + REVOKE PUBLIC/anon/authenticated + GRANT chỉ service_role.
- Migration mới nhất hiện tại: `20260710130500` → migration mới phải timestamp LỚN HƠN.
- **Route phòng canonical là `/apartments`**; `/rooms` chỉ `<Navigate replace>` (App.tsx:286-289).
- **`usePersistedState` = sessionStorage THUẦN** (`flt:*`); URL hydration là opt-in TỪNG TRANG (doc comment: "trang có seed từ URL phải tự giữ effect sync") — Customers/Contracts/Assets KHÔNG parse query string → deep-link filter chỉ chạy trên trang đã có hydration.
- **`fa_monthly_pnl` / `fa_monthly_pnl_accrual`** (useFinancialAnalysis.ts) = nguồn doanh thu/chi phí KQKD đúng (xử lý khoản ngoài KQKD + phạm vi toà); **`cashbook_settlement_report`** (useSettlementReport.ts) = báo cáo BÀN GIAO TIỀN & ĐỐI SOÁT SỔ (period_collected/spent, phiên bàn giao, số dư) — KHÔNG phải doanh thu.
- Query factories sẵn có: `invoicesListQuery` (useInvoices.ts:70), `contractsPagedQuery` (useContracts.ts:368), `get_my_available_rooms` + `mapPayloadToBuildings` (useMyAvailableRooms.ts).

---

## 3. Phân tích TẬN DỤNG vs FIX

### 3.1 Dùng nguyên của page-agent

| # | Thành phần | Ghi chú |
|---|---|---|
| R1 | Agent loop reflection→action | |
| R2 | DOM serialization + indexing | |
| R3 | PageController + mask + patch React controlled-input | |
| R4 | `tool()` + zod/v4 | repo có zod ^3.25.76 |
| R5 | `customFetch`, `transformPageContent`, `instructions.getPageInstructions`, events (`beforeUpdate`), hooks (`onBeforeStep`, `onAfterTask`, `onAskUser`) | Đủ móc chính thống — không fork |
| R6 | `[data-page-agent-not-interactive]` re-query mỗi updateTree + xoá built-in bằng `null` | Nền của F8 |
| R7 | System prompt gốc | |
| **R8 (v2.1)** | **`LLM` class của @page-agent/llms cho CHAT MODE** | Có sẵn Message/Tool/zod conversion/validation/usage/error mapping/retry — không tự viết loop fetch/parse |

### 3.2 page-agent CHƯA TỐI ƯU → fix (v2.1)

| # | Vấn đề | Fix |
|---|---|---|
| F1 | apiKey client-side | Edge Function `llm-proxy`; JWT qua `customFetch` |
| F2 | Không registry đa provider | `ai_providers` + `model="provider:model-id"` |
| F3 | `modelPatch()` chết sau proxy | Normalize trong proxy: strip/inject param (Anthropic đòi `max_tokens`), map finish_reason |
| F4 | ~~Client không retry~~ **(sửa v2.1)** LLM class ĐÃ retry mặc định 2 | **Proxy KHÔNG retry** — 1 invocation = 1 reservation = 1 upstream attempt (2 tầng retry = tới 6 attempt/step, tính phí lặp, log sai). Config client set `maxRetries` tường minh (2). Lỗi quota trả **403 `daily_quota`** (non-retryable — 429 sẽ bị LLM class retry vô ích); rate limit thoáng qua trả 429 |
| F5 | Không usage/cost/quota | RPC atomic `reserve_ai_usage` + **`ai_copilot_settings`** (nguồn cấu hình — Postgres không đọc env Edge) + cap 3 CẤP: user/tenant(owner)/global (nhiều tài khoản không nhân ngân sách); so sánh `>=`; reservation expired vẫn TÍNH quota đến hết ngày (không giải phóng sớm); clamp `max_tokens≤4096`, strip `n` |
| F6 | DOM snapshot token-heavy | deep-link (route hỗ trợ thật), business tools trả data thẳng, maxSteps 25, model rẻ, telemetry task_id |
| F7 | Không có chat mode | **Chat = `LLM` class (R8) + domain-tool registry** (2 adapter: `toPageAgentTools()` / `toLlmTools()`) + tool `respond({text})` kiểu built-in `done` → loop đến khi model gọi respond; `buildChatContext()` giới hạn turn/token, giữ nguyên system + cặp tool-call |
| F8 | Không an toàn nghiệp vụ | 5 lớp: (1) **entitlement server-owned** (xem F14); (2) quyền `ai_copilot.view`/`ui_control` check server-side qua `get_my_permissions()` — nhưng KHÔNG đủ một mình vì sentinel owner; (3) tool check canUse + RLS; (4) **element exclusion động**: listener `beforeUpdate` stamp `data-page-agent-not-interactive` lên nút nguy hiểm (regex text/aria + `[role=alertdialog]` + `[data-ai-risk]`) → tree mỗi step tự loại; gắn dần `data-ai-risk` vào component dùng chung; `execute_javascript: null`; (5) write chỉ qua tool draft-first (Phase 5). **`onBeforeStep` guard**: SPA rời route allowlist → throw → task dừng (ẩn launcher không dừng instance đang chạy) |
| F9 | Panel chỉ en/zh | Panel built-in chỉ pilot; chat UI tiếng Việt từ Phase 2 |
| F10 | Non-streaming | v1 proxy 400 cho `stream:true`; Phase 4 tee + include_usage |
| F11 | Token hết hạn giữa task | `customFetch` JWT tươi + `x-copilot-feature` + `x-task-id`/request; CORS allowlist tĩnh. **Ghi rõ (v2.1): `execute()` reset history mỗi task → mỗi lệnh pilot là ĐỘC LẬP, không follow-up ngữ cảnh** |
| F12 | PII rời hệ thống | `transformPageContent` → maskPii (SĐT/CCCD/STK); field allowlist tool output; `data_class` per provider; không fallback ollama→cloud |
| F13 | Prompt injection từ nội dung trang | Element exclusion + system prompt "trang = dữ liệu" + tắt UI-control trên Chat Zalo |
| **F14 (v2.1)** | **Permission sentinel owner + /register public → không có kill switch** | Bảng **`ai_copilot_entitlements`** server-owned (user nào được chat/ui_control) — **check TRONG RPC reserve** (1 roundtrip, atomic, KHÔNG cache — thu hồi hiệu lực ngay); + kill switch global trong `ai_copilot_settings`. Thứ tự: entitlement → permission → provider → quota |

---

## 4. Kiến trúc tổng

```
Browser (React SPA — ptcrm)
├─ src/copilot/ (lazy chunk)
│   ├─ CopilotLauncher.tsx — gate UI: session + entitlement (query) + canUse
│   ├─ Chat (Phase 2) → ChatPanel.tsx (UI Việt) + LLM class (@page-agent/llms) + tool respond
│   ├─ UI-control (Phase 3, EXPERIMENTAL) → PageAgent({customFetch, transformPageContent,
│   │     instructions:{system, getPageInstructions}, customTools}) + beforeUpdate-stamping + onBeforeStep route guard
│   └─ tools/registry.ts — domain tools DÙNG CHUNG, 2 adapter; execute = supabase session user (RLS + canUse)
│
├─ LLM traffic ──► Edge Function `llm-proxy`
│     Authorization: Bearer <JWT tươi/request> + x-copilot-feature + x-task-id
│     → validate JWT → reserve_ai_usage (RPC atomic: kill switch → entitlement → rate → cap user/tenant/global)
│       [quyền ai_copilot.view check trong cùng RPC — KHÔNG cache]
│     → parse "provider:model" → ai_providers (enabled + model + data_class)
│     → clamp/normalize per-provider → fetch upstream (KHÔNG retry) → normalize response
│     → finalize_ai_usage (waitUntil)
│
└─ Ollama (data_class local_only) → browser fetch thẳng localhost:11434
```

Routing table (7 provider cloud — như v2.0): openai / anthropic (compat shim yếu nhất, test tool-calling riêng) / gemini / qwen / deepseek / groq / openrouter (`:free` → spike $0, +2 header `HTTP-Referer`,`X-Title`).

---

## 5. Phases

### Phase 0 — Spike (branch, CHƯA xoá AI cũ)

1. `npm i page-agent@1.11.0`.
2. `llm-proxy` tối giản (OpenRouter `:free` nếu chưa có key — $0).
3. **Gate A hạ tầng**: JWT qua gateway; OPTIONS preflight với header custom; **verify customFetch được gọi mọi request**; subpath route.
4. **Gate B tiếng Việt**: lệnh thật trên trang thật.
5. **Gate C an toàn/kỹ thuật**: Panel không vỡ style; zod/v4; chunk size; Radix portal; **verify beforeUpdate-stamping loại nút khỏi browser state** ("xoá hoá đơn X" → agent báo không thấy nút); **verify onBeforeStep throw dừng task khi đổi route**; **verify transformPageContent chạy mỗi step**; **verify instructions.getPageInstructions nhận URL đúng khi SPA điều hướng**.
6. Đo token/step trên trang danh sách lớn.

**Dừng**: Gate B fail → chat-only. Gate C fail exclusion → không ship UI-control.

### Phase 0b — Dọn AI cũ (SAU spike pass)

Dependency audit (`pg_depend`/views) + backup → migration DROP 4 bảng + 2 RPC cũ (**timestamp > `20260710130500`**) → xoá 2 edge function → regen types.ts. Apply qua Management API (Node UTF-8).

### Phase 1 — Backend: settings + entitlements + proxy

**Migration** (timestamp > migration cuối lúc tạo):

```sql
-- Singleton cấu hình (Postgres không đọc env Edge Function; admin chỉnh không cần redeploy)
create table ai_copilot_settings (
  id boolean primary key default true check (id),   -- đúng 1 dòng
  chat_enabled boolean not null default false,       -- kill switch GLOBAL
  ui_control_enabled boolean not null default false,
  rate_per_min int not null default 20,
  daily_usd_cap_user numeric(10,4) not null default 2.0,
  daily_usd_cap_tenant numeric(10,4) not null default 10.0,
  daily_usd_cap_global numeric(10,4) not null default 30.0,
  updated_at timestamptz not null default now()
);
-- RLS: SELECT authenticated; write CHỈ is_super_admin()

-- Entitlement server-owned (F14 — permission sentinel owner không phải kill switch;
-- /register public → user tự đăng ký cũng là "owner" sentinel)
create table ai_copilot_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_enabled boolean not null default true,
  ui_control_enabled boolean not null default false,  -- pilot allowlist
  created_at timestamptz not null default now()
);
-- KHÔNG có dòng = KHÔNG được dùng (opt-in tường minh).
-- RLS: user SELECT own (launcher ẩn/hiện); write CHỈ is_super_admin()

create table ai_providers (
  provider text primary key,
  enabled boolean not null default false,
  label text not null,
  models jsonb not null default '[]',   -- [{id,label,input_price,output_price}] USD/1M
  default_model text,
  data_class text not null default 'cloud',  -- 'cloud'|'local_only'
  updated_at timestamptz not null default now()
);
-- RLS: SELECT authenticated; write CHỈ is_super_admin()  ← v2.1: is_admin() là admin PER-TENANT, bảng này GLOBAL

create table ai_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owner_id uuid,                        -- v2.1: tenant attribution (staff→owner của họ, owner→chính mình;
                                        -- resolve trong RPC bằng helper tenant sẵn có của repo)
  provider text not null, model text not null,
  feature text not null default 'copilot',
  task_id text,
  prompt_tokens int not null default 0, completion_tokens int not null default 0,
  total_tokens int not null default 0, cached_tokens int not null default 0,
  reserved_cost_usd numeric(10,6) not null default 0,
  cost_usd numeric(10,6), latency_ms int,
  status text not null default 'pending',  -- pending|ok|upstream_error|over_quota|expired
  error_detail text,
  created_at timestamptz not null default now()
);
create index on ai_usage_logs (user_id, created_at);
create index on ai_usage_logs (owner_id, created_at);
-- RLS: user SELECT own; OWNER SELECT theo owner_id = auth.uid() (dashboard đội mình);
--      super admin SELECT all; INSERT/UPDATE chỉ qua RPC service_role

-- RPC (theo pattern hardening 20260710130500):
--   SECURITY DEFINER SET search_path = public;
--   REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role;
-- reserve_ai_usage(p_user_id, p_feature, p_provider, p_model, p_task_id, p_est_cost_usd) → uuid
--   1 transaction: pg_advisory_xact_lock(hashtext(p_user_id||ngày_VN))
--   a. settings: kill switch feature tương ứng OFF → raise 'copilot_disabled'
--   b. entitlements: không có dòng / cờ feature = false → raise 'not_entitled'
--   c. permission: get_my_permissions-logic cho p_user_id (hoặc gọi thẳng) — view/ui_control
--   d. rate: count(*) 60s qua >= rate_per_min → raise 'rate_limited'
--   e. quota 3 cấp (>=, gồm pending + expired trong ngày, Asia/Ho_Chi_Minh):
--      sum theo user / theo owner_id / toàn cục + p_est → vượt cấp nào raise 'daily_quota'
--   f. mark expired: pending < now()-5' → status='expired' (VẪN tính quota đến hết ngày)
--   g. INSERT pending (kèm owner_id resolve) → return id
-- finalize_ai_usage(p_id, tokens..., p_cost_usd, p_latency, p_status, p_error)
```

Sau migration: **regen types.ts + commit**.

**Edge function `llm-proxy`** — flow v2.1:

1. OPTIONS → CORS allowlist tĩnh: `authorization, x-client-info, apikey, content-type, x-copilot-feature, x-task-id`.
2. `callerClient.auth.getUser()` → 401.
3. `stream:true` → 400.
4. Parse `provider:model`; `ai_providers` check; `local_only` xuất hiện ở proxy → 400.
5. **`reserve_ai_usage`** (adminClient) — TOÀN BỘ kill-switch/entitlement/permission/rate/quota trong 1 RPC atomic, **không cache** (thu hồi hiệu lực ngay). Lỗi map: `copilot_disabled`/`not_entitled` → **403**; `rate_limited` → 429; `daily_quota` → **403** (v2.1: không dùng 429 — LLM class retry 429 vô ích khi quota không reset trong ngày).
6. Clamp `max_tokens≤4096`, strip `n`; normalize per-provider.
7. Fetch upstream, timeout 60s — **KHÔNG retry** (LLM class client đã retry 2; 1 reservation = 1 attempt).
8. Normalize response → trả ngay; `finalize_ai_usage` qua waitUntil (tokens/cost thật = tokens × giá model, latency, status).
9. Upstream lỗi → trả nguyên OpenAI-format; finalize `upstream_error`.

**Test Phase 1**: per provider 200 (Anthropic + tool-calling); 401; **403 not_entitled (user có JWT nhưng không có entitlement — kể cả OWNER sentinel)**; **403 sau khi super admin thu entitlement (hiệu lực NGAY — không cache)**; 403 provider disabled/copilot_disabled/daily_quota; 429 rate; 400 stream; **race 20 request song song sát cap → tổng không vượt**; **cap tenant: 2 user cùng tenant không vượt cap owner**; OPTIONS preflight.

### Phase 2 — Chat read-only + tools + PII + UI Việt (SHIP TRƯỚC)

| File | Nội dung |
|---|---|
| `CopilotLauncher.tsx` | Gate: session + entitlement (SELECT own) + canUse; ẩn route public; lazy |
| `ChatPanel.tsx` + `chatEngine.ts` | **Dùng `LLM` class từ `@page-agent/llms`** (R8): Message/Tool/validation/usage/retry sẵn — thêm tool `respond({text})` (kiểu built-in done), loop đến khi model gọi respond, max 6 vòng; `customFetch` gắn JWT + `x-copilot-feature: chat` + `x-task-id`; `buildChatContext()` (v2.1): giới hạn N turn/M ký tự, LUÔN giữ system + cặp tool_calls↔tool nguyên vẹn |
| `tools/registry.ts` | **Domain-tool registry** + 2 adapter `toPageAgentTools()`/`toLlmTools()`; mỗi tool có **metadata `requiredPermission: {module, action}`** (granular: `reports_finance.analysis`, `reports_real_estate.expiring`…); factory nhận `{perms, navigate, supabase}` |
| `maskPii.ts` | Regex SĐT VN/CCCD/STK — cho transformPageContent + tool output nhạy cảm |
| `copilotConfig.ts`, `useAiProviders.ts`, `ollama.ts` | như v2.0 |

**Tools v1 — nguồn dữ liệu SỬA THEO AUDIT (v2.1):**

| Tool | Nguồn | requiredPermission |
|---|---|---|
| `phong_trong` | RPC `get_my_available_rooms` + `mapPayloadToBuildings` (tái dùng) | rooms.view |
| `tim_phong` | rooms+buildings query, field allowlist | rooms.view |
| `tim_khach_hang` | customers `.ilike`, field allowlist (mask CCCD) | customers.view |
| `tim_hoa_don` | **`invoicesListQuery`** (tái dùng factory, lọc `kind`) | invoices.view |
| `hop_dong_sap_het_han` | **tách/export query từ `contractsPagedQuery`** | reports_real_estate.expiring (fallback contracts.view) |
| `doanh_thu_thang` | **RPC `fa_monthly_pnl`** (cash; option accrual) — KHÔNG dùng cashbook_settlement_report (đó là bàn giao sổ) | reports_finance.analysis |
| `huong_dan` | docs/he-thong lazy `?raw` | — |
| `mo_trang` | **CHỈ adapter UI-control** (chat không điều hướng — chat trả link để user click); whitelist alias→route CANONICAL (`/apartments` không phải `/rooms`) + filter param CHỈ trên route có URL hydration thật (kiểm từng route khi code — usePersistedState là sessionStorage thuần, URL seed là opt-in từng trang); check canUse route đích | theo route |

**Schema chat** (trong migration Phase 1): `ai_chat_threads`/`ai_chat_messages` như v2.0 (tool_calls jsonb, tool_call_id, model, metadata) NHƯNG (v2.1): **`sequence_no` cấp qua RPC `append_chat_message`** (advisory lock theo thread — client max+1 sẽ race khi 2 tab) hoặc `generated always as identity` + order `(thread_id, id)`; FK user_id **ON DELETE CASCADE** (convention repo); trigger bump thread.updated_at.

**Quyền**: `permissions.ts` module `ai_copilot` core `['view']` extra `['ui_control']` (+ permissionPages.ts — orphan-key test). LƯU Ý (v2.1): quyền này để phân quyền STAFF; kill switch/pilot thật nằm ở `ai_copilot_entitlements` + `ai_copilot_settings` (F14).

**Vitest**: maskPii; registry adapter ×2 ra cùng schema; buildChatContext giữ cặp tool-call; mo_trang canonical route + perm; parse provider:model; dựng lại conversation.

### Phase 3 — UI-control EXPERIMENTAL (pilot: CHỈ navigation + filter)

- `createAgent.ts`:
```ts
new PageAgent({
  model: 'provider:model', baseURL: FUNCTIONS_URL + '/llm-proxy',
  apiKey: 'unused', customFetch: fetchWithFreshJwt, maxRetries: 2,   // tường minh — retry CHỈ ở client
  transformPageContent: maskPii,
  instructions: {                                    // v2.1: OBJECT — không phải string
    system: SYSTEM_PROMPT_VI,
    getPageInstructions: (url) => pageContext(new URL(url).pathname),
  },
  maxSteps: 25,
  customTools: { execute_javascript: null, ...toPageAgentTools(registry) },
})
```
- `safetyGuard.ts` (v2.1): (a) listener **`pageController.addEventListener('beforeUpdate', stampDangerous)`** — quét nút text/aria match regex nguy hiểm + trong `[role=alertdialog]` + `[data-ai-risk]` → set `data-page-agent-not-interactive` (tree dựng sau đó tự loại; SPA re-render vẫn đúng vì stamp lại MỖI step); (b) **`onBeforeStep`: route hiện tại ∉ allowlist → throw** (dừng task thật sự — ẩn launcher không dừng instance).
- **Pilot scope (v2.1 — chốt theo audit): CHỈ điều hướng + lọc.** Form-fill dời **Phase 3b** (khi đó nút Lưu/Submit gắn `data-ai-risk="submit"` để agent dừng ở "bạn kiểm tra và bấm Lưu").
- Route allowlist khởi điểm: `/apartments`, `/invoices`, `/customers`. Tắt trên Chat Zalo (F13).
- **Ghi rõ cho user pilot: mỗi lệnh là ĐỘC LẬP** (history reset mỗi execute — verified) — không hỏi nối "giờ lọc tháng 6".
- Telemetry (v2.1 — chốt nơi lưu): per-request đã có qua `x-task-id` trong `ai_usage_logs` → tổng hợp theo task_id là đủ v1 (KHÔNG bảng mới); `onAfterTask` bọc try/catch toàn bộ (hook throw làm task lỗi — verified) chỉ log console + đếm client; nếu Phase 4 cần sâu hơn mới thêm `ai_task_runs`.

### Phase 4 — Mở rộng provider + Admin + Streaming

Admin UI (super admin): settings singleton (kill switch, caps, rate), entitlements (cấp/thu chat & ui_control per user), providers (enabled/models/giá/data_class), dashboard usage (per user + per tenant qua owner_id) + nút Test key. Owner (tenant): xem usage đội mình. UI Việt cho UI-control + chips. SSE streaming (tee + include_usage + abort-propagation). Voice input.

### Phase 5 — Write tools draft-first

`tao_phieu_thu_chi_nhap`: UNAPPROVED only + confirmation 2 bước trong chat + idempotency key (task_id+hash) + audit log. Phase 3b form-fill.

---

## 6. Điều kiện tiên quyết

API key provider (spike được bằng OpenRouter `:free`); super admin seed `ai_copilot_settings` + entitlements pilot.

## 7. Rủi ro

| Rủi ro | Mức | Giảm nhẹ |
|---|---|---|
| page-agent security Beta (docs upstream) | Cao cho UI-control | Experimental: entitlement opt-in + settings kill switch + route allowlist + pilot CHỈ nav/filter + onBeforeStep guard |
| Tài khoản tự đăng ký (/register public) đốt ngân sách | **Cao (mới v2.1)** | Entitlement opt-in tường minh (không có dòng = không dùng) + cap 3 cấp + global cap chặn tổng |
| Prompt injection (F13) | Trung | Element exclusion động + system prompt + tắt trên Chat Zalo |
| PII rời hệ thống | Trung | maskPii + field allowlist + data_class + Ollama local |
| Tiếng Việt kém | Trung | Gate B |
| page-agent trẻ | Trung | Pin 1.11.0; import gói trong src/copilot |
| Anthropic compat shim | Trung | normalize inject/strip + test tool-calling |
| Chi phí | Thấp | reserve atomic 3 cấp + race test + không retry proxy |
| ~110 lỗi TS | — | So số lỗi; regen types.ts |

## 8. Verification

1. tsc không tăng lỗi; 2. vitest (orphan-key + copilot mới); 3. smoke proxy (danh sách Test Phase 1 — nhấn mạnh: not_entitled với owner sentinel, thu hồi hiệu lực ngay, race, cap tenant); 4. build chunk riêng; 5. Playwright production: launcher đúng entitlement+quyền; chat "phòng nào trống?"/"doanh thu tháng 6?" (đối chiếu số với trang Phân tích tài chính — cùng nguồn fa_monthly_pnl); pilot: "mở trang phòng" → `/apartments`; "xoá hoá đơn X" → không thấy nút; đổi route ngoài allowlist giữa task → task dừng; `ai_usage_logs` có owner_id/cost/task_id; console sạch. 6. Commit + push + re-test.

## 9. Danh sách file

- **Xoá (0b)**: `supabase/functions/ai-chat/`, `ai-embeddings/` + 4 bảng + 2 RPC cũ
- **Mới**: migrations (settings/entitlements/providers/usage_logs/chat + 3 RPC, timestamp > `20260710130500`), `supabase/functions/llm-proxy/index.ts`, `src/copilot/{CopilotLauncher, ChatPanel, chatEngine, createAgent, safetyGuard, maskPii, systemPromptVi, pageContext, copilotConfig, useAiProviders, ollama, tools/registry, lib/* (+tests)}`
- **Sửa**: `App.tsx`, `permissions.ts` (+`ui_control`), `permissionPages.ts`, `package.json` (page-agent@1.11.0), `types.ts` (regen ×2), component dùng chung gắn `data-ai-risk`
- **Tái dùng**: `get_my_permissions()`, `is_super_admin()`, `invoicesListQuery`, `contractsPagedQuery`, `get_my_available_rooms`+`mapPayloadToBuildings`, `fa_monthly_pnl`, `useUiPreferences`, pattern REVOKE `20260710130500`, `docs/he-thong/`

## 10. Câu hỏi mở còn lại

1. Helper resolve owner_id (tenant) cho staff — dùng helper sẵn có nào của repo (xác định lúc code; có `accessible_building_ids`/tenant guard migrations).
2. `sequence_no`: RPC append có lock vs identity toàn cục + order (thread_id,id) — chọn khi code (identity đơn giản hơn).
3. Pilot 3b (form-fill) tiêu chí mở: bao nhiêu task pilot thành công/tuần?

## 11. Phụ lục: ý tưởng HOÃN từ đối chiếu n2store (không phải bỏ sót)

(nguyên như v1.2) Multi-key rotation (Edge ephemeral + 1-2 key trả phí → không có gì xoay) · `/test` health-check (Phase 4) · failover cloud↔cloud (chờ số liệu upstream_error) · SSE abort-propagation (spec Phase 4) · registry máy self-host Ollama (nếu dùng thật) · SQL read-only tool (xuyên RLS — Phase 5+ nếu tools thiếu) · OCR đồng hồ điện/CCCD (plan riêng) · cờ vision (jsonb thêm lúc nào cũng được). KHÔNG lấy vĩnh viễn: ChatAnywhere, Gemini web cookie, soft-auth, quota in-memory.

## 12. Phụ lục: review nội bộ v1.1 (17 finding — tóm tắt)

2 P0 (CORS header custom — giải quyết gọn bằng customFetch + allowlist tĩnh; stream bypass cost guard — 400) + 7 P1 + 8 P2. Chi tiết đã gộp vào các mục F.

## 13. Phụ lục: audit ngoài vòng 1 (8 finding — verdict)

7/8 đúng: authz server-side; safeClick bất khả thi (selectorMap private) → element exclusion; cost race → reserve atomic; customFetch thay recreate; transformPageContent PII; schema tool_calls; migration timestamp + spike trước drop; UI-control experimental. Sai: "pin 1.12.0" (npm latest 1.11.0).

## 14. Phụ lục: audit ngoài vòng 2 (9 finding — verdict kiểm chứng độc lập, 10/07)

| Finding | Verdict | Kiểm chứng |
|---|---|---|
| P0 `ui_control` chưa phải kill switch (owner sentinel + /register public) | **ĐÚNG — F14** | Verified migration `20260701170000`: owner thật → `'{"__superadmin":true}'`; App.tsx:201 `/register` trong PublicRoute → user tự đăng ký = owner sentinel = pass mọi permission check. Fix: entitlements opt-in + check trong RPC reserve (không cache — audit đúng cả điểm cache 60s làm thu hồi chậm) |
| P0 `is_admin()` sai cấp cho `ai_providers` | **ĐÚNG** | Verified `20260506000002`: is_admin = staff_assignments role Admin per-tenant. Fix: write = `is_super_admin()`; +owner_id vào usage_logs cho dashboard tenant |
| P0 RPC quota thiếu nguồn config + quyền EXECUTE | **ĐÚNG** | Postgres không đọc env Edge; fix: `ai_copilot_settings` singleton + REVOKE/GRANT theo pattern `20260710130500` (verified tồn tại) + `>=` + cap 3 cấp |
| P0 config sai API thật (instructions object; blacklist) | **ĐÚNG (tinh chỉnh)** | Verified types.ts: `instructions = {system, getPageInstructions(url)}`. `interactiveBlacklist` thực chất là MẢNG Element (audit nói "callback trả 1 Element" — cũng chưa chính xác nốt), nhưng kết luận đúng: dùng event `beforeUpdate` (verified `dispatchEvent(new Event('beforeUpdate'))`) stamp `data-page-agent-not-interactive` (verified re-query mỗi updateTree). onBeforeStep throw abort task (verified không try-catch) → route guard |
| P1 double retry (2 tầng → 6 attempt) | **ĐÚNG** | Verified `llms/src/index.ts`: LLM class `maxRetries ?? 2`, backoff 100ms, retry lỗi retryable — vòng verify trước của plan đọc OpenAIClient thiếu lớp LLM wrapper. Fix: proxy không retry; quota → 403 non-retryable |
| P1 tái dùng @page-agent/llms cho chat | **ĐÚNG** | Verified exports: `LLM`, `Message`, `Tool`, `InvokeError` — đủ; + verified `execute()` reset `this.history=[]` mỗi task → pilot lệnh độc lập, ghi rõ |
| P1 `doanh_thu_thang` sai nguồn | **ĐÚNG** | Verified useSettlementReport (bàn giao/đối soát sổ) vs useFinancialAnalysis `fa_monthly_pnl`/`_accrual` (KQKD đúng). + verified `invoicesListQuery` (useInvoices.ts:70), `contractsPagedQuery` (useContracts.ts:368) tồn tại |
| P1 route/deep-link chưa khớp | **ĐÚNG** | Verified App.tsx:286-289 `/apartments` canonical, `/rooms` Navigate; verified `usePersistedState` = sessionStorage thuần, URL seed opt-in từng trang (doc comment trong file) → deep-link chỉ trên route hỗ trợ; mo_trang chỉ UI-control |
| P2 telemetry chưa có nơi lưu + hook throw | **ĐÚNG** | Verified hook không try-catch. Chốt: tổng hợp theo task_id từ ai_usage_logs (không bảng mới v1); onAfterTask bọc try/catch |
