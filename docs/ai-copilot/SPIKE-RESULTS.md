# Phase 0 Spike — Kết quả (10/07/2026)

> Spike theo `PLAN.md` v2.1 §Phase 0, chạy trên branch `feat/ai-copilot-spike`.
> **Chưa có LLM API key** (secrets project không có key nào, không có Ollama local)
> → Gate A + phần lớn Gate C chạy bằng **provider `mock`** trong `llm-proxy`
> (mock trả completion OpenAI-format với tool_call `AgentOutput` — đủ để verify
> toàn bộ plumbing client vì các cơ chế cần test đều nằm client-side).
> **Gate B (tiếng Việt) + đo token thật: CHỜ KEY** — xem mục "Còn lại".

## Hạ tầng đã dựng

| Thành phần | Trạng thái |
|---|---|
| `page-agent@1.11.0` | Cài đúng pin, zod 3.25.76 thoả peer dep (`zod/v4` subpath OK) |
| `supabase/functions/llm-proxy` (v2, tối giản) | DEPLOYED (verify_jwt=true). JWT check, CORS allowlist header tĩnh, chặn `stream:true`, parse `provider:model`, clamp `max_tokens≤4096` + strip `n`, upstream timeout 60s KHÔNG retry, provider mock (spike-only) + openrouter/groq/gemini/deepseek/openai (chờ key secrets) |
| `scripts/deploy-edge-fn.mjs` | Deploy edge fn qua Management API (không cần CLI/Docker) — tái dùng Phase 1 |
| `src/copilot/SpikePage.tsx` + route `/copilot-spike` | Trang spike + diagnostics client-side (xoá khi ship) |

## Gate A — Hạ tầng: **PASS**

| Test | Kết quả |
|---|---|
| OPTIONS preflight với header custom (`x-copilot-feature`, `x-task-id`) | 204, `access-control-allow-headers` trả đủ |
| POST không JWT | 401 (gateway chặn trước cả function) |
| JWT user thật qua proxy | 200, function xác thực `auth.getUser` OK |
| **customFetch được gọi MỌI request** | fetchCount khớp số step ở mọi scenario (1/2/3 request); mọi request đều có JWT tươi từ `supabase.auth.getSession()` + đủ header custom (proxy echo lại xác nhận) |
| Subpath route `{baseURL}/chat/completions` | Hoạt động (function nhận path `/llm-proxy/chat/completions`) |
| `stream:true` | 400 `stream_not_supported` |
| Provider chưa có key | 403 `provider_disabled` |

## Gate C — An toàn/kỹ thuật: **PASS (phần không cần model thật)**

| Test | Kết quả |
|---|---|
| **Element exclusion động** | Nút "Xoá hoá đơn TEST-001" (match regex text) và nút gắn `data-ai-risk` xuất hiện trong browser state **chỉ là text thường, KHÔNG có index tương tác** → agent không thể click (click chỉ qua index). Nút thường vẫn index bình thường. |
| **onBeforeStep route guard** | Task 4 bước, rời trang giữa chừng → hook throw → task dừng thật (`agent.status='error'`, execute() throw ra ngoài), chỉ 2/4 request đã đi |
| **transformPageContent chạy mỗi step** | Counter khớp số step; SĐT `0901234567` VÀ CCCD bị mask thành `[SĐT đã ẩn]` trong prompt (verify từ request body trước khi gửi) |
| **instructions.getPageInstructions nhận URL đúng** | Được gọi mỗi step với `window.location.href` hiện tại; marker xuất hiện trong `<page_instructions>` của prompt |
| `instructions.system` | Vào `<system_instructions>` trong prompt ✓ |
| Panel không vỡ style | Screenshot OK: panel nổi đè UI app + dialog Radix cùng lúc, hiển thị step history + error rõ ràng. **0 console errors** toàn phiên test |
| zod/v4 | Không xung đột (repo zod 3.25.76) |
| Chunk size | `page-agent-*.js` chunk riêng lazy **127.7 kB (35.1 kB gzip)**; SpikePage 6.3 kB; bundle chính không đổi |
| **Click/input thật trên React 18** | `click_element_by_index` bấm đúng nút (counter +1), `input_text` set value đúng (native setter + event) — patch React controlled input hoạt động |

## Đo token/step (ước lượng chars/4 — cần key để đo bằng tokenizer thật)

| Trang | Prompt chars | Ước lượng token/step |
|---|---|---|
| `/copilot-spike` (trang nhỏ) | ~11.3k | ~2.9k |
| `/apartments` (273 căn hộ, danh sách lớn) | **~62.9k** | **~16.5k** |

→ Xác nhận F6 của plan: DOM snapshot token-heavy trên trang danh sách; bắt buộc
deep-link + business tools trả data thẳng + model rẻ + maxSteps thấp cho UI-control.
(Tiếng Việt tokenize kém hơn tiếng Anh — số thật có thể cao hơn ước lượng 4 chars/token.)

## ⚠️ Lệch so với PLAN v2.1 (phát hiện khi đọc source bản npm)

**npm 1.11.0 KHÔNG có cơ chế `[data-page-agent-not-interactive]`** — đó là code
trên branch main chưa release (plan §2.1/F8 verify từ main). Bản 1.11.0 có tương đương:

- `interactiveBlacklist?: (Element | (() => Element))[]` trong config, được đọc lại
  **mỗi lần updateTree** (`getFlatTree` resolve mảng + thunk mỗi call).
- `PageController` dispatch event **`beforeUpdate`/`afterUpdate`** quanh mỗi updateTree
  (verified `page-controller.js:1852`).

→ **Cách làm đã verify chạy đúng**: giữ MẢNG blacklist sống truyền vào config, listener
`beforeUpdate` repopulate in-place (quét regex text/aria + `[data-ai-risk]` +
`[role=alertdialog]`). Hiệu quả y hệt stamping attribute. `safetyGuard.ts` Phase 3
viết theo cách này. Khi upstream release bản có attribute thì chuyển sau (không blocking).

Ghi chú phụ: text của nút bị loại VẪN hiện trong browser state (chỉ mất index tương tác).
An toàn click = đạt; nhưng prompt-injection qua text vẫn cần lớp F13 như plan.

## Còn lại của Phase 0 (CHỜ LLM API KEY)

1. **Gate B tiếng Việt**: lệnh thật trên trang thật với model thật.
2. Đo token thật (usage từ provider) trên `/apartments`.
3. Test tool-calling per-provider (nhất là Anthropic compat shim — khi có key Anthropic).

Cách nạp key khi có: `Supabase Dashboard → Edge Functions → Secrets` hoặc
Management API, tên biến: `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` /
`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`. Rồi chạy lại spike với model
`openrouter:qwen/qwen3-235b-a22b:free` (hoặc tương đương) trên `/copilot-spike`.

**Điều kiện sang Phase 0b (xoá AI cũ) theo plan: Gate B pass.**
