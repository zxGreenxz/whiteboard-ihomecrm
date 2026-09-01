# Audit hệ thống AI và lộ trình tối ưu bám sát codebase, web app và nghiệp vụ

> **[LỊCH SỬ — snapshot 20/07/2026]** Audit/roadmap AI bất biến. Hiện hành: `docs/he-thong/21-ai-copilot.md` + `docs/ai-copilot/README.md`. Giữ làm bằng chứng, không cập nhật nữa.

> Ngày audit: 2026-07-20<br>
> Repository: `whiteboard-ihomecrm`<br>
> Nhánh/commit quan sát: `release/meter-domain` / `6acd7b4`<br>
> Phạm vi: working tree hiện tại, bao gồm frontend, Supabase migrations/functions, các SQL prepared, worker Zalo, tài liệu hệ thống và test liên quan.<br>
> Phương pháp: static review code + đối chiếu chéo ba lượt khảo sát độc lập + chạy unit test AI cục bộ. Không truy vấn production DB, không gọi provider AI thật và không thay đổi hạ tầng live.

## 1. Kết luận điều hành

Hệ thống hiện có một **AI Copilot pilot đa-provider dùng tool-calling**, không phải một nền tảng AI doanh nghiệp hoàn chỉnh và cũng **không còn RAG/embedding runtime** như một số tài liệu cũ mô tả.

Những phần đã có giá trị tốt:

- Chat tiếng Việt, chọn model/provider, lịch sử hội thoại và tool nghiệp vụ.
- JWT mới cho từng request cloud, entitlement, permission, RLS, rate limit và quota.
- Proxy giữ API key cloud ở Edge Function secrets, không đưa key provider xuống browser.
- Một số tool đọc dùng đúng nguồn dữ liệu nghiệp vụ như `get_my_available_rooms`, `invoicesListQuery`, `fa_monthly_pnl`.
- Có ý thức draft-first, audit và idempotency cho write tool, dù cách triển khai hiện tại chưa đủ an toàn.

Tuy nhiên, **chưa nên mở rộng quyền tự động hoặc rollout rộng** trước khi xử lý các điểm P0 sau:

1. UI-control đang dùng blacklist theo text/ARIA và có thể click vào control ghi DB ngay, ví dụ switch trạng thái phòng.
2. LLM proxy không xác nhận model thuộc allowlist; model lạ nhận giá `0`, có thể vượt kiểm soát chi phí/quota.
3. Markdown từ model có thể tạo link `javascript:`/`data:` và chạy trong origin của ứng dụng.
4. AI write đang insert trực tiếp nhiều bảng, không transaction và không đi qua canonical writer/approval engine mới.
5. Nguồn sự thật schema production bị chia giữa `supabase/migrations`, SQL hand-applied và `scripts/authz-prepared`; restore/replay chưa tái tạo chắc chắn hệ thống sống.

Đánh giá định tính hiện tại:

| Lớp | Mức sẵn sàng | Nhận định |
|---|---:|---|
| Chat read-only có tool | Pilot có kiểm soát | Có thể dùng hẹp sau khi khóa model/link/PII |
| UI-control | Chưa an toàn | Nên tắt production cho tới khi chuyển sang allowlist deny-by-default |
| AI write | Chưa đạt | Phải thay bằng RPC transaction + intent/confirmation server-side |
| Grounding nghiệp vụ | Hạn chế | 6 tool đọc, 1 tool ghi; chưa phủ đa số domain |
| Multi-tenant/org | Chưa hoàn chỉnh | Cột org đã thêm nhưng runtime AI chưa truyền/enforce đầy đủ |
| DLP/retention/governance | Chưa đạt enterprise | Masking hẹp, chưa có data policy/provider policy/TTL |
| Evaluation/observability | Mỏng | Có usage log cơ bản, gần như chưa có eval/E2E/adversarial test |
| RAG/knowledge base | Không tồn tại runtime | Legacy đã drop; `huong_dan` chỉ khớp tên file và cắt Markdown |

## 2. Trạng thái thật: đang có, đã bỏ và mới chỉ nằm trong tài liệu

### 2.1 Runtime AI hiện hành

| Thành phần | Trạng thái | Bằng chứng chính |
|---|---|---|
| Launcher toàn app | Đang dùng | `src/App.tsx:45`, `src/App.tsx:457`, `src/copilot/CopilotLauncher.tsx:19` |
| Chat panel | Đang dùng | `src/copilot/ChatPanel.tsx:108` |
| Chat engine/tool loop | Đang dùng | `src/copilot/chatEngine.ts:69` |
| UI-control PageAgent | Experimental | `src/copilot/createAgent.ts:27`, `src/copilot/ChatPanel.tsx:263` |
| Tool registry | Đang dùng | `src/copilot/tools/registry.ts:67` |
| Write tool phiếu thu/chi | Đang có trong registry | `src/copilot/tools/writeTools.ts:60` |
| Cloud LLM proxy | Đang có | `supabase/functions/llm-proxy/index.ts:184` |
| Local Ollama | Đang hỗ trợ chat trực tiếp localhost | `src/copilot/copilotConfig.ts:17`, `src/copilot/ollama.ts:29` |
| Admin AI | Đang có | `src/copilot/admin/AiCopilotAdminPage.tsx:505`, route `src/App.tsx:402` |
| Usage/quota/chat persistence | Đang có | `supabase/migrations/20260710200000_ai_copilot_backend.sql:21` |
| Write audit | Đang có | `supabase/migrations/20260711050000_ai_write_audit.sql:8` |

### 2.2 Legacy đã bị loại khỏi runtime

Migration `supabase/migrations/20260710190000_drop_legacy_ai_assistant.sql:14` đã drop:

- `ai_conversations`
- `ai_messages`
- `ai_memory_embeddings`
- `ai_usage_stats`
- `search_similar_memories`
- `get_conversation_context`

Vì vậy, các mô tả sau hiện **không còn đúng**:

- AI chat qua Edge Function `ai-chat`.
- Tạo vector qua `ai-embeddings`.
- Knowledge Base per-user trên `ai_memory_embeddings`.
- RAG bằng pgvector cho câu trả lời hiện tại.
- API key provider được người dùng nhập/lưu trong bảng `ai_api_keys`.

Các tài liệu đang lệch trạng thái gồm:

- `docs/resident-docs/AI_ASSISTANT_GUIDE.md`
- `docs/resident-docs/AI_API_KEYS_SETUP.md`
- `supabase/functions/README.md`
- một số đoạn trong `docs/CODEBASE_STRUCTURE.md`, `docs/DATABASE_SCHEMA.md` và tài liệu hệ thống cũ.

### 2.3 `huong_dan` hiện tại không phải RAG

Tool `huong_dan` tại `src/copilot/tools/registry.ts:224`:

1. Glob toàn bộ file top-level `docs/he-thong/*.md` ở build time.
2. Chuẩn hóa tên file và tìm substring theo chủ đề.
3. Chọn đúng một file đầu tiên khớp.
4. Trả tối đa 8.000 ký tự đầu.

Không có chunking, embedding, semantic search, reranking, ACL theo tài liệu, freshness, version selection hoặc citation theo đoạn. Đây là **keyword file lookup**, không phải retrieval-augmented generation.

## 3. Bối cảnh codebase và quy trình nghiệp vụ mà AI phải tôn trọng

### 3.1 Nền tảng web

- Frontend: React 18, TypeScript, Vite, React Router, TanStack Query, shadcn/Radix.
- Backend: Supabase PostgreSQL, RLS, RPC, trigger, Edge Functions và Storage.
- Hạ tầng bổ sung: Vercel, Cloudflare R2/storage gateway, Node worker Zalo, Vercel Cron/worker watchdog cho lương V5.
- `src/App.tsx` có khoảng 135 khai báo `<Route`, gồm route sống, redirect legacy và route công khai.
- Repository có 362 file SQL trong `supabase/migrations`, 24 SQL prepared trong `scripts/authz-prepared`, 5 Edge Function directory và 65 file test frontend.

### 3.2 Các domain nghiệp vụ chính

AI phải bám mô hình domain đã được codebase phân tách:

1. Tổ chức, membership, RBAC, staff và quyền theo tòa.
2. Tòa nhà, tầng, phòng, dịch vụ và trạng thái phòng.
3. Lead, khách hàng, người thuê, phương tiện và hồ sơ cư trú.
4. Cọc giữ chỗ, hợp đồng, gia hạn, chuyển nhượng và thanh lý.
5. Công tơ, chỉ số, hóa đơn, thanh toán và tiền thừa.
6. Thu chi, sổ quỹ, bàn giao, đối soát và approval engine.
7. Công việc, sự cố, tài sản, bảo trì và kho vật tư.
8. Lương, thưởng, cổ đông, lợi nhuận và ví cá nhân.
9. Kênh công khai, Sale Phòng, Thu Tiền mobile và Chat Zalo.
10. Báo cáo BĐS/tài chính, dashboard và thông báo.

Tài liệu domain nền hiện nằm tại `docs/he-thong/README.md` và `docs/he-thong/00-tong-quan.md`, nhưng các quyết định authorization/canonical writer mới nhất còn nằm trong `docs/authorization` và `scripts/authz-prepared`.

### 3.3 Cảnh báo nguồn sự thật database

Đây là rủi ro cross-cutting ảnh hưởng trực tiếp tới AI:

- `.github/workflows/supabase-migrate.yml:21` chạy `supabase db push` khi push migration.
- `supabase/migrations-archive/README.md:11` lại ghi production được apply trực tiếp qua Management API và `schema_migrations` không phản ánh đủ.
- `scripts/authz-prepared/prod-snapshot/README.md:10` thừa nhận nhiều function/table production không có migration nguồn.
- Các writer/approval API mới như payment v4, approval inbox v2 và nhiều hardening fix nằm trong `scripts/authz-prepared`, không nằm trọn trong migration chain.

Kết quả: một AI tool có thể được viết theo function đang có trên production nhưng function đó không tồn tại ở môi trường dựng mới; hoặc ngược lại, CI/replay có thể đưa schema về trạng thái khác production. Trước khi mở rộng AI write, phải giải quyết nguồn sự thật DB.

## 4. Kiến trúc AI hiện tại

### 4.1 Luồng tổng

```text
Authenticated browser
  |
  +-- CopilotLauncher
  |     session + route + entitlement + permission UI gate
  |
  +-- ChatPanel
        |
        +-- Chat mode
        |     chatEngine -> @page-agent/llms -> llm-proxy
        |                                      |
        |                                      +-- verify JWT
        |                                      +-- provider lookup
        |                                      +-- reserve_ai_usage
        |                                      +-- upstream /chat/completions
        |                                      +-- finalize_ai_usage
        |     model tool-call -> domain registry -> Supabase session -> RLS/RPC
        |     messages -> ai_chat_threads / ai_chat_messages
        |
        +-- UI-control mode
              PageAgent -> DOM snapshot -> maskPii -> same llm-proxy
              built-in DOM actions + domain registry tools
              route guard + interactive blacklist

Local Ollama path:
  browser -> http://localhost:11434/v1
  (không qua llm-proxy/reserve/log server)
```

### 4.2 Chat end-to-end

1. Launcher xác nhận session và ẩn trên route public tại `src/copilot/CopilotLauncher.tsx:23`.
2. `GatedLauncher` yêu cầu entitlement chat và `ai_copilot.view` tại `src/copilot/CopilotLauncher.tsx:47`.
3. Panel nạp thread mới nhất tại `src/copilot/ChatPanel.tsx:132`.
4. `runChatTurn` dựng system prompt, context và tool tại `src/copilot/chatEngine.ts:93`.
5. Context được giới hạn 12 block/16.000 ký tự và giữ cặp tool-call/tool tại `src/copilot/chatEngine.ts:38`.
6. `makeCopilotFetch` lấy JWT mới và gắn feature/task ID tại `src/copilot/copilotConfig.ts:38`.
7. Proxy kiểm JWT bằng `auth.getUser` tại `supabase/functions/llm-proxy/index.ts:195`.
8. Proxy reserve usage qua `reserve_ai_usage` tại `supabase/functions/llm-proxy/index.ts:254`.
9. Model gọi tool; registry lọc tool theo quyền rồi kiểm lại lúc execute tại `src/copilot/tools/registry.ts:271`.
10. Tool chạy bằng Supabase session của user, vì vậy RLS/RPC là lớp cuối.
11. Model phải gọi `respond` để kết thúc; tối đa 6 vòng tại `src/copilot/chatEngine.ts:117`.
12. Lịch sử được insert vào `ai_chat_messages` tại `src/copilot/chatEngine.ts:187`.
13. Lỗi save history bị nuốt tại `src/copilot/ChatPanel.tsx:201`.

### 4.3 UI-control end-to-end

1. Chỉ hiện toggle khi entitlement và quyền `ai_copilot.ui_control` pass tại `src/copilot/ChatPanel.tsx:115`.
2. Mỗi lệnh tạo agent mới và reset history tại `src/copilot/ChatPanel.tsx:167`.
3. PageAgent nhận toàn bộ domain tools từ registry tại `src/copilot/createAgent.ts:42`.
4. DOM snapshot được mask ba loại PII tại `src/copilot/createAgent.ts:52`.
5. `execute_javascript` bị vô hiệu hóa tại `src/copilot/createAgent.ts:64`.
6. Route được giới hạn vào `/apartments`, `/invoices`, `/customers` tại `src/copilot/safetyGuard.ts:61`.
7. Blacklist tìm button/link/menuitem/submit theo regex text/ARIA tại `src/copilot/safetyGuard.ts:17`.

Điểm quan trọng: cơ chế hiện tại là **denylist heuristic**, không phải capability allowlist. Nó không chứng minh được “chỉ điều hướng và lọc”.

### 4.4 Provider hiện tại

Cloud routing trong `supabase/functions/llm-proxy/index.ts:39` gồm:

- OpenRouter
- Groq
- Gemini OpenAI-compatible
- DeepSeek
- OpenAI
- Qwen DashScope
- Anthropic shim
- 9Router self-host nếu có `NINEROUTER_BASE_URL`

Local:

- Ollama tại `http://localhost:11434/v1`.

Seed `supabase/migrations/20260710200000_ai_copilot_backend.sql:347` bật OpenRouter và mock, tạo sẵn provider khác ở trạng thái tắt. `supabase/migrations/20260712020000_9router_cloud_vps.sql:11` chuyển 9Router sang cloud/VPS.

### 4.5 Tool nghiệp vụ hiện có

| Tool | Loại | Nguồn dữ liệu/side effect | Permission |
|---|---|---|---|
| `phong_trong` | Read | RPC `get_my_available_rooms` | `rooms.view` |
| `tim_khach_hang` | Read | Query `customers`; che một phần SĐT | `customers.view` |
| `tim_hoa_don` | Read | Tái dùng `invoicesListQuery` | `invoices.view` |
| `hop_dong_sap_het_han` | Read | Query `contracts` ACTIVE | `reports_real_estate.expiring` |
| `doanh_thu_thang` | Read | RPC `fa_monthly_pnl`/`fa_monthly_pnl_accrual` | `reports_finance.analysis` |
| `huong_dan` | Read docs | Build-time Markdown glob | Không có permission riêng |
| `tao_phieu_thu_chi_nhap` | Write | Direct insert audit/voucher/item | `income_expenses.create` |
| `mo_trang` | UI-only | React Router navigate | Quyền view module đích |

Chưa có tool cho lead, cọc, meter, payment, approval inbox, task, asset, material, salary, profit, Zalo, handover hoặc reconciliation.

## 5. Đối chiếu AI với 10 luồng nghiệp vụ thật

### 5.1 Tòa/phòng và trạng thái phòng

**Luồng thật**

- Route chính: `/buildings`, `/apartments`, `/sale-phong` tại `src/App.tsx:285`.
- Contract ACTIVE làm phòng OCCUPIED; khi rời active-set chỉ trả AVAILABLE nếu không còn hợp đồng khác.
- Cọc giữ chỗ có thể chuyển AVAILABLE sang RESERVED; predicate hiện tính cả phiếu UNAPPROVED và chỉ loại CANCELLED/deleted.
- Switch trạng thái phòng tại `src/components/rooms/RoomListTable.tsx:79` ghi ngay qua `src/hooks/useRooms.ts:227`.

**AI hiện có**

- Tool `phong_trong` đọc phòng trống và sắp trống.
- UI-control có quyền tương tác DOM trang `/apartments`.

**Nên phát triển**

- Gợi ý phòng phù hợp theo nhu cầu lead: ngân sách, ngày vào, diện tích, khu vực, sức chứa.
- Phát hiện trạng thái bất thường: AVAILABLE nhưng có contract ACTIVE, RESERVED quá hạn, phòng sắp trống chưa có lịch xử lý.
- Giải thích nguồn trạng thái bằng link đến contract/cọc liên quan.

**Không cho AI tự làm**

- Đổi AVAILABLE/UNAVAILABLE/MAINTENANCE.
- Reserve/release phòng.
- Bỏ qua khóa giữ phòng hoặc cạnh tranh nhiều nhân viên.

### 5.2 Lead -> cọc

**Luồng thật**

- `useLeads` còn CRUD trực tiếp.
- `ConvertLeadDialog` dùng đường legacy tạo/chọn tenant, insert `deposits` PENDING rồi update lead CONVERTED; chuỗi không atomic.
- Luồng cọc mới lại dùng `income_expenses` + item `is_deposit`.

**Khoảng trống nghiệp vụ**

- Hai nguồn cọc chưa thống nhất.
- Convert lead có thể partial success.
- Dữ liệu lead chưa nối chắc với cọc canonical.

**Nên phát triển**

- Phân loại lead, duplicate detection, tóm tắt nhu cầu, gợi ý bước tiếp theo.
- Chuẩn bị “conversion packet” gồm khách, phòng, tiền cọc, điều kiện thiếu và cảnh báo trùng.
- Soạn tin nhắn follow-up nhưng bắt buộc người dùng duyệt trước khi gửi.

**Không cho AI tự làm**

- Chuyển lead thành khách/cọc.
- Thu cọc, reserve phòng hoặc đổi lead state cuối.

### 5.3 Cọc giữ chỗ

**Luồng thật**

- `CreateDepositDialog` tạo phiếu INCOME không contract và item cọc.
- `src/lib/reservationHold.ts:16` gọi RPC hold 24 giờ nhưng wrapper có nhánh fail-open khi RPC/network không đáp ứng.

**Nên phát triển**

- Checklist trước cọc: phòng có đang bị giữ, số tiền hợp lệ, khách trùng, thiếu số điện thoại, nguồn tiền/sổ quỹ.
- Cảnh báo hold gần hết hạn và cọc mồ côi quá lâu.
- Đối chiếu cọc với contract đã ký nhưng chưa link.

**Không cho AI tự làm**

- Thu, hoàn, bỏ cọc.
- Tiêu thụ hold hoặc giải phóng phòng.

### 5.4 Tạo và quản lý hợp đồng

**Luồng thật**

- `useContracts` hiện còn chuỗi client nhiều bước: kiểm đại diện, kiểm contract cùng phòng, insert contract, link customer/service, đổi phòng OCCUPIED, tạo hóa đơn đầu best-effort.
- Deposit receipt sau submit cũng có thể lỗi riêng.
- Atomic `create_contract_v1` tồn tại trong prod snapshot/prepared SQL nhưng chưa thấy caller FE rõ ràng.

**Nên phát triển**

- Preflight hợp đồng: dữ liệu thiếu, cọc thiếu, phòng đang giữ, service thiếu, ngày billing mâu thuẫn.
- So sánh điều khoản với mẫu chuẩn và highlight khác biệt.
- Tóm tắt lịch sử gia hạn/chuyển nhượng/thanh lý.
- Soạn draft hợp đồng hoặc biên bản từ dữ liệu đã xác nhận.

**Không cho AI tự làm**

- Kích hoạt, gia hạn, chuyển nhượng, thanh lý hoặc xóa hợp đồng.
- Tự quyết định phí phạt, hoàn cọc hoặc công nợ.

### 5.5 Công tơ -> chỉ số -> hóa đơn

**Luồng thật**

- Chỉ số mới/bulk đang insert APPROVED/self-approved trong `src/hooks/useMeterReadings.ts:263`.
- Invoice create ưu tiên `create_invoice_v1`, nhưng fallback có thể insert header/credit/items nhiều bước.
- Một số lỗi `42501` bị xem là tín hiệu coexistence/fallback tại `src/lib/canonicalFallback.ts:16`.

**Nên phát triển**

- Phát hiện chỉ số tăng giảm bất thường, missing reading, đồng hồ đảo số, ảnh không khớp số nhập.
- Tạo batch review, không tự duyệt.
- Giải thích hóa đơn theo nguồn meter/service/rent/credit.
- So sánh invoice với tháng trước và contract terms.

**Không cho AI tự làm**

- Duyệt chỉ số/hóa đơn.
- Tự sửa consumption hoặc total.
- Tự sinh invoice nếu chưa qua preflight và writer transaction.

### 5.6 Thu tiền, payment và sổ quỹ

**Luồng thật**

- Payment v4 canonical atomically tạo payment, cập nhật invoice, tạo voucher/items và kiểm idempotency/permission.
- FE vẫn tính revenue/deposit split ở client trước khi gọi writer.
- Có fallback xuống v3/legacy; v3 dùng permission khác rộng hơn `thu_tien.collect`.

**Nên phát triển**

- Giải thích khoản cần thu, đề xuất phân bổ và phát hiện thanh toán trùng.
- OCR biên lai theo chế độ “đề xuất dữ liệu”, không tự ghi.
- Đối chiếu payment-voucher-invoice-account và phát hiện mismatch.

**Không cho AI tự làm**

- Ghi nhận thu tiền, hoàn tác, refund hoặc đổi sổ quỹ.
- Tự quyết định phân bổ cọc/doanh thu khi có mơ hồ.

### 5.7 Thu chi và approval engine

**Luồng thật**

- `src/hooks/income-expenses/mutations.ts:41` ưu tiên `create_income_expense_v1` cho phiếu eligible.
- Birth policy trong `scripts/authz-prepared/t5_24_ie_birth_status_policy.sql` tự duyệt phiếu thường dưới ngưỡng, để UNAPPROVED với hạng mục force-approval hoặc chi vượt ngưỡng.
- Approval inbox dùng `list_my_pending_approvals_v1`, `decide_financial_request_v2`, `withdraw_financial_request_v1` tại `src/hooks/useApprovals.ts`.
- Maker-checker và engine guard nằm trong `scripts/authz-prepared/t5_26_engine_guard_inbox.sql`.

**AI hiện có**

- Chỉ có `tao_phieu_thu_chi_nhap`, nhưng đi direct DML và luôn ép UNAPPROVED/account null.

**Nên phát triển**

- Tự phân loại hạng mục và cảnh báo restricted/force-approval.
- Chuẩn bị approval packet: nguồn, số tiền, đối tượng, lịch sử, chứng từ, rule match và anomaly.
- Tóm tắt lý do duyệt/từ chối cho checker.
- Gợi ý bản nháp qua writer riêng `create_ai_financial_draft_v1`, không direct insert.

**Không cho AI tự làm**

- Approve/reject/post.
- Chọn người duyệt hoặc bypass maker-checker.
- Ghi vào sổ quỹ khi chưa có người xác nhận.

### 5.8 Bàn giao và đối soát

**Luồng thật**

- Đây là luồng hai bên chặt nhất: source book owner tạo bàn giao, receiver revalidate snapshot và xác nhận.
- Hệ thống khóa voucher, tạo transfer pair và loại khỏi P&L.

**Nên phát triển**

- Tóm tắt chênh lệch, voucher chưa bàn giao, snapshot mismatch.
- Gợi ý nguyên nhân và danh sách chứng từ cần kiểm.

**Không cho AI tự làm**

- Confirm/cancel handover hoặc reconciliation.
- Thay receiver, tài khoản hoặc số tiền.

### 5.9 Công việc, tài sản, kho, lương và lợi nhuận

**Nên phát triển**

- Triage sự cố, gợi ý job type/SLA/người phù hợp.
- Nhận diện ảnh bảo trì/tài sản ở chế độ đề xuất.
- Phát hiện vật tư bất thường, job hoàn thành nhưng thiếu usage, asset quá hạn bảo trì.
- Giải thích công thức lương/lợi nhuận từ ledger đã khóa.
- Phát hiện gaming/anomaly, không tự kết luận gian lận.

**Không cho AI tự làm**

- Complete/approve job có thưởng.
- Lock lương, chi lương, khóa/chia lợi nhuận hoặc tạo payout.

### 5.10 Chat Zalo

**Luồng thật**

- Route `/chat-zalo` gated bằng `chat_zalo.view`.
- FE gọi RPC gửi; worker dùng service-role, claim queue rồi gửi qua zca-js.
- Worker chưa quan sát thấy consumer thực cho `zalo_automations`; linkage inbound tới customer/lead/contract/room chưa hoàn chỉnh.

**Nên phát triển**

- Phân loại intent, sentiment, urgency.
- Gợi ý link customer/lead/contract và nêu confidence.
- Tóm tắt hội thoại và soạn reply draft.
- Tạo `zalo_ai_drafts`/intent queue với reviewer, TTL, version và audit.

**Không cho AI tự làm**

- Gửi tin trực tiếp cho khách.
- Tự hứa giá, hoàn tiền, gia hạn, thanh lý hoặc xác nhận pháp lý.
- Chạy AI với service-role trực tiếp trên toàn DB.

## 6. Finding register

### 6.1 P0 - Phải khóa trước khi rollout rộng

#### P0-01: UI-control có thể mutation DB ngoài guard

**Bằng chứng**

- Guard chỉ quét text/ARIA và một số selector tại `src/copilot/safetyGuard.ts:17`.
- Không có component nào khác trong `src` gắn `data-ai-risk` hoặc capability marker.
- Switch phòng tại `src/components/rooms/RoomListTable.tsx:79` không có text/ARIA rõ ràng.
- Click switch gọi `RoomsPage.handleToggleStatus` tại `src/pages/rooms/RoomsPage.tsx:161`.
- Mutation ghi trực tiếp bảng `rooms` tại `src/hooks/useRooms.ts:227`.
- Các nút icon edit/payment/delete trong `src/components/invoices/InvoiceListTable.tsx:287` cũng không có text/ARIA để regex nhận diện chắc chắn.
- `toPageAgentTools` còn cấp cả write tool cho PageAgent tại `src/copilot/tools/registry.ts:294`.

**Tác động**

- Model lỗi hoặc prompt injection có thể đổi trạng thái phòng, mở flow thanh toán/xóa hoặc gọi write tool.
- Cam kết UI “chỉ điều hướng & lọc” không được machine-enforce.

**Xử lý bắt buộc**

1. Tắt `ui_control_enabled` ở production và entitlement pilot cho tới khi vá xong.
2. Đổi từ blacklist sang allowlist: mặc định mọi `button`, `switch`, `menuitem`, input mutation đều không tương tác.
3. Chỉ element có `data-ai-allow="navigate|filter|open-readonly"` mới được PageAgent index.
4. Loại toàn bộ write tool khỏi adapter UI-control.
5. Tách registry thành `chatReadTools`, `chatDraftTools`, `uiSafeTools`; không dùng một registry chung mặc định.
6. E2E adversarial test phải chứng minh không có row DB nào đổi sau task UI-control.

**Tiêu chí đóng**

- 0 mutation trong test trên `/apartments`, `/invoices`, `/customers`.
- Agent không thấy switch/button không được allow.
- Rời route hoặc gặp dialog mutation phải dừng fail-closed.

#### P0-02: Model allowlist và quota/cost có thể bị bypass

**Bằng chứng**

- `findPricing` trả `{0,0}` nếu model không có trong registry tại `supabase/functions/llm-proxy/index.ts:74`.
- Proxy chỉ kiểm provider enabled/data class tại `supabase/functions/llm-proxy/index.ts:224`.
- `modelId` tùy ý vẫn được forward upstream tại `supabase/functions/llm-proxy/index.ts:323`.
- Mock được seed `enabled=true` tại `supabase/migrations/20260710200000_ai_copilot_backend.sql:347`; UI chỉ ẩn mock, không chặn API.

**Tác động**

- User có entitlement/JWT có thể gọi model đắt không được admin duyệt bằng key hệ thống.
- Reservation tính giá 0; daily cap mất ý nghĩa.
- Model không đủ capability có thể gây lỗi tool loop hoặc trả output không tương thích.

**Xử lý bắt buộc**

- Validate server-side `modelId` phải tồn tại trong `prov.models` và enabled riêng.
- Chuẩn hóa model registry thành bảng quan hệ hoặc JSON schema có constraint.
- Tắt mock trong mọi environment production.
- Thêm capability: tools, stream, context, vision, feature allowlist, data policy.
- Reject model unknown trước khi reserve.

#### P0-03: Link do model sinh có thể chạy script trong origin app

**Bằng chứng**

- `MiniMarkdown` đưa trực tiếp `href` từ model vào `<a>` tại `src/copilot/ChatPanel.tsx:64`.
- Không lọc `javascript:`, `data:`, `vbscript:`, protocol-relative hoặc external domain.
- Supabase session được persist ở localStorage tại `src/integrations/supabase/client.ts:11`.
- `vercel.json` chưa có Content-Security-Policy.

**Tác động**

- Người dùng click link độc hại có thể thực thi code trong origin, đọc session/local data hoặc dẫn đến phishing.

**Xử lý bắt buộc**

- Parse bằng `new URL` với base app.
- Chỉ cho route relative thuộc route allowlist và `https://` thuộc domain allowlist.
- Reject scheme khác, `//host`, control chars và encoded bypass.
- Với external link: `target="_blank"`, `rel="noopener noreferrer"`, hiển thị domain.
- Thêm CSP phù hợp và unit test payload độc hại.

#### P0-04: AI write không transaction và bypass canonical writer

**Bằng chứng**

- UI chuẩn ưu tiên `create_income_expense_v1` tại `src/hooks/income-expenses/mutations.ts:41`.
- AI insert audit tại `src/copilot/tools/writeTools.ts:99`.
- Sau đó insert voucher tại `src/copilot/tools/writeTools.ts:126`.
- Sau đó insert item tại `src/copilot/tools/writeTools.ts:149`.
- Cuối cùng mới update `entity_id` tại `src/copilot/tools/writeTools.ts:158`.
- Canonical writer hiện có org, permission, validation, payload hash, claim/freeze và birth policy trong `scripts/authz-prepared/t5_24_ie_birth_status_policy.sql`.

**Tác động**

- Audit insert thành công nhưng voucher lỗi: retry báo “đã tạo” dù không có entity.
- Voucher thành công nhưng item lỗi: để lại voucher mồ côi/amount sai.
- Không đi qua birth status threshold, force category, canonical ownership, hash-chain và approval engine.
- Khi drain direct DML theo `T7_PREPARED_drain_legacy_dml.sql`, AI write sẽ gãy.

**Xử lý bắt buộc**

- Xóa direct DML khỏi `writeTools.ts`.
- Tạo RPC transaction `create_ai_income_expense_draft_v1` hoặc mở rộng canonical writer bằng source `AI_COPILOT`.
- RPC phải validate org, permission, building/type/account, threshold/rule, payload hash và idempotency.
- Header + items + intent + audit + request approval phải cùng transaction.
- Retry trả đúng kết quả đã commit; operation lỗi phải cho retry, không giả thành success.

#### P0-05: Source of truth schema/release không tái lập chắc chắn

**Bằng chứng**

- Workflow tự `db push`: `.github/workflows/supabase-migrate.yml:21`.
- Repo nói live apply Management API: `supabase/migrations-archive/README.md:11`.
- Prod snapshot nói nhiều function/table không có migration: `scripts/authz-prepared/prod-snapshot/README.md:10`.

**Tác động**

- Staging/DR/new tenant có thể thiếu writer mà AI dựa vào.
- Fallback client có thể âm thầm chạy đường legacy rộng hơn.
- Migration push tự động có thể replay hoặc lệch production.

**Xử lý bắt buộc**

1. Tạm dừng auto `supabase db push` production.
2. Dump/baseline schema live thành migration nguồn có kiểm soát.
3. Đưa toàn bộ `t5_20+`, approval v2, payment v4 và hardening sống vào migration chain.
4. Tạo test restore DB trắng và parity catalog.
5. Deploy qua staging, dry-run, backup, environment approval và post-deploy probes.

### 6.2 P1 - Phải xử lý trước khi AI có write/dữ liệu nhạy cảm

#### P1-01: Confirmation hai bước chỉ là prompt convention

- `xac_nhan` là boolean model tự sinh tại `src/copilot/tools/writeTools.ts:21`.
- Không có intent row, nonce, payload hash khóa hoặc proof user đã xác nhận ở lượt trước.
- Model có thể gọi `xac_nhan=true` ngay lần đầu.
- UI-control reset history mỗi task nhưng vẫn được cấp write tool.

Thiết kế đúng phải là:

1. `prepare_action` tạo `ai_action_intent` server-side, trạng thái `PREVIEWED`, payload hash, TTL, org/user/tool.
2. UI render preview từ payload canonical, không từ prose model.
3. User bấm nút xác nhận thật hoặc nhập xác nhận được UI map vào intent ID.
4. `execute_action(intent_id, confirmation_token)` re-check permission/rule/version và commit qua writer RPC.
5. Intent one-time, hết hạn, chống replay và audit append-only.

#### P1-02: Org/multi-tenant chưa chảy xuyên AI

**Bằng chứng**

- Migration chỉ thêm `organization_id` nullable vào bảng AI tại `supabase/migrations/20260713120000_sprint3a_org_rollout_all_tables.sql:17`.
- Trigger/boundary Sprint 3b không gồm bảng AI tại `supabase/migrations/20260713121000_sprint3b_org_autofill_and_boundary.sql:51`.
- `createThread`, `saveMessages`, `ai_write_audit` không set active org.
- Quota tenant vẫn lấy owner đầu tiên từ `staff_assignments` tại `supabase/migrations/20260710200000_ai_copilot_backend.sql:266`.
- Entitlement PK chỉ theo user; settings là singleton toàn hệ.

**Rủi ro**

- Thread org A có thể trở thành latest context khi user chuyển sang org B.
- Usage/audit mới có thể có org null.
- User đa-org không có entitlement/quota/model policy độc lập.
- Aggregate tool có thể gom mọi scope user thay vì active org.

**Đích**

- Active organization bắt buộc trong UI session và mọi request AI.
- Composite keys `(organization_id, user_id)` cho entitlement.
- Settings/quota/provider policy theo org, cộng global platform cap.
- Thread/message/usage/action/audit `organization_id NOT NULL`.
- Tool bắt buộc nhận `ToolCtx.organizationId`; RPC filter/enforce org.
- Không dùng hard-code PROD fallback; unresolved org phải fail và audit.

#### P1-03: Usage accounting fail-open khi thiếu usage

- Stream chỉ yêu cầu `include_usage` cho một số provider tại `supabase/functions/llm-proxy/index.ts:327`.
- Khi không có usage, `lastUsage` null và real cost thành 0 tại `supabase/functions/llm-proxy/index.ts:371`.
- Non-stream thiếu usage cũng ghi cost 0 tại `supabase/functions/llm-proxy/index.ts:435`.
- DB quota dùng `COALESCE(cost_usd, reserved_cost_usd)`; số 0 không fallback về reserved.

Đích:

- Nếu usage thiếu: giữ `cost_usd=NULL`, status `usage_unknown`, quota vẫn giữ reserved.
- Reconcile định kỳ với provider bill hoặc usage API.
- Pricing phải finite, nonnegative, versioned và có effective date.
- 9Router/VPS phải có internal cost allocation dù token price external là 0.

#### P1-04: DLP, retention và provider governance chưa đủ

- `maskPii` chỉ che SĐT, CCCD 12 số và STK có từ khóa tại `src/copilot/maskPii.ts:4`.
- Tên, email, địa chỉ, ngày sinh, mã hợp đồng, ghi chú, tài chính và metadata khác vẫn có thể ra cloud.
- Tool outputs được lưu nguyên vào chat history.
- Chưa có TTL, delete/export UI, legal basis/consent hoặc provider retention policy.

Đích:

- Data classification theo field/domain: PUBLIC, INTERNAL, CONFIDENTIAL, PII, FINANCIAL, AUTHORIZATION.
- Mỗi tool khai báo output schema và data classes.
- Provider/model khai báo allowed data classes, retention mode, region, training opt-out.
- Redaction/minimization theo mục đích; không gửi field không cần.
- Chat TTL theo org, purge job, delete/export và legal hold nếu cần.
- Không log prompt/tool output nhạy cảm ở console.

#### P1-05: Tài liệu kỹ thuật nội bộ bị bundle vào frontend

- `import.meta.glob('/docs/he-thong/*.md')` tại `src/copilot/tools/registry.ts:53` đưa tài liệu vào build client.
- Một số file chứa chi tiết RLS, audit, production behavior và implementation internals.
- Tool không có permission riêng.

Đích:

- Tạo corpus riêng `docs/ai-knowledge-approved` chỉ chứa nội dung đã duyệt cho end-user.
- Serve từ backend authenticated endpoint; không bundle raw vào SPA.
- Metadata: org, audience, effective date, owner, revision, source path, sensitivity.
- Citation bắt buộc tới source/revision.

#### P1-06: Client-controlled feature header

Proxy phân loại `chat`/`ui_control` chỉ theo `x-copilot-feature` tại `supabase/functions/llm-proxy/index.ts:239`. Client tùy biến có thể gửi workload automation dưới nhãn chat để né entitlement feature.

Đích:

- Tạo server-issued short-lived task token gắn user/org/feature/model/tool policy.
- Proxy verify token và body contract.
- UI-control chỉ được cấp model/tool/action schema riêng.

#### P1-07: Local Ollama bypass server governance

Chat local tại `src/copilot/chatEngine.ts:79` không qua reserve/proxy, nên không có kill switch per-request, entitlement tức thời, quota, rate limit hoặc usage log.

Đích:

- Production mặc định tắt local provider hoặc thêm RPC authorize/log zero-cost trước mỗi turn.
- Local chỉ được read-only; không cấp write tools.
- Model selection phải revalidate provider enabled/capability trước mỗi task.

#### P1-08: AI audit không append-only

Policy `ai_write_audit_update_own` tại `supabase/migrations/20260711050000_ai_write_audit.sql:30` cho user update row của mình, không giới hạn chỉ `entity_id`.

Đích:

- Client không được update audit.
- Audit chỉ ghi qua SECURITY DEFINER RPC tối thiểu.
- Event append-only, hash-chain hoặc immutable ledger; payload sensitive được tokenize/redact.

#### P1-09: Zalo worker có blast radius lớn

- Worker giữ service-role tại `worker/index.js:33`.
- Session cookie ghi plaintext tại `worker/index.js:404`.
- Queue claim `queued -> processing` tại `worker/index.js:484` nhưng không thấy lease/stale recovery rõ ràng.

Đích:

- Worker role/RPC tối thiểu, không dùng service-role cho mọi thao tác.
- Session encrypt-at-rest, file permission chặt, secret rotation.
- Queue có `locked_at`, `lease_owner`, retry/backoff, stale requeue và dead-letter.
- AI draft service tách khỏi transport worker.

#### P1-10: Fallback `42501` có thể làm yếu authorization

`isCanonicalFallbackSignal` coi mọi `42501` là coexistence signal tại `src/lib/canonicalFallback.ts:16`. Nếu canonical writer từ chối quyền thật, frontend có thể thử legacy direct path.

Đích:

- Writer trả error code riêng cho rollout-off/coexistence, ví dụ `P0001 canonical_not_active`.
- `42501` luôn là permission denied, tuyệt đối không fallback.
- Telemetry mọi fallback và gate CI yêu cầu 0 fallback trước khi drain legacy DML.

### 6.3 P2 - Nâng chất lượng, vận hành và khả năng mở rộng

#### P2-01: Observability thiếu ngữ cảnh AI/nghiệp vụ

Usage hiện có token, cost, latency, task ID nhưng thiếu:

- organization/thread/route/prompt version.
- tool name, tool latency, result size, data class.
- provider request ID, retry count, model capability version.
- action intent/approval/request/entity liên quan.
- quality score, citation coverage, user feedback.

#### P2-02: Test coverage chưa tương xứng blast radius

Unit test AI hiện tại `src/copilot/__tests__/copilot.test.ts` có 19 test và đã pass trong audit, nhưng chủ yếu test helper thuần.

Chưa có automated coverage cho:

- proxy JWT/model allowlist/body limit/error mapping.
- quota concurrency/tenant attribution/missing usage.
- RLS cross-org trên bảng AI.
- PageAgent adversarial DOM/prompt injection.
- write transaction/intent/retry/audit immutability.
- unsafe Markdown URL.
- provider tool-calling contract.
- E2E launcher/chat/UI-control.
- retention/purge.

#### P2-03: Request schema/DoS control còn thiếu

Proxy đọc JSON body tùy ý tại `supabase/functions/llm-proxy/index.ts:207`, chưa giới hạn rõ:

- body bytes.
- số messages/tools.
- tổng chars/tokens.
- tool schema complexity.
- lower bound `max_tokens`.
- stream idle/max-duration.

#### P2-04: Provider config chưa có schema/capability/health

Admin chỉ kiểm `models` là array tại `src/copilot/admin/AiCopilotAdminPage.tsx:325`. Chưa có:

- JSON schema.
- duplicate ID check.
- price range.
- health/circuit breaker.
- tool/stream/context capability.
- approved features/data classes.
- model deprecation/migration policy.

#### P2-05: Chat persistence và lifecycle mỏng

- Chỉ load thread mới nhất.
- Không có list/search/rename/delete/archive/export.
- Save lỗi bị nuốt.
- Không retention/purge.
- Title lấy từ user text đầu, có thể chứa PII.
- 200 message load limit nhưng DB giữ vô hạn.

#### P2-06: Drift comment/tài liệu/dependency

- Comment `ChatPanel` nói read-only nhưng registry có write tool.
- UI label nói chỉ navigation/filter nhưng prompt cho form-fill và PageAgent có write tool.
- `ollama.ts` còn comment 9Router local trong khi 9Router đã chuyển cloud.
- Code import trực tiếp `@page-agent/llms` nhưng `package.json` chỉ khai báo `page-agent`; nên khai báo dependency trực tiếp để tránh transitive drift.

## 7. Nguyên tắc kiến trúc đích

1. **AI không phải authority nghiệp vụ.** AI chỉ hiểu ngôn ngữ, lập kế hoạch và đề xuất; DB/RPC quyết quyền, trạng thái và invariant.
2. **Read trước, draft sau, post cuối cùng bởi workflow người thật.** Không đưa autonomous posting vào giai đoạn gần.
3. **Mọi write là business command.** Không cho AI direct table DML.
4. **Org và permission bắt buộc ở mọi lớp.** UI gate không phải security boundary.
5. **Deny-by-default cho tool và UI action.** Chỉ capability được khai báo rõ mới hiện cho model.
6. **Structured output, không parse prose để ghi DB.** Preview và execute dùng schema canonical.
7. **Idempotent, transactional, auditable.** Retry không tạo trùng và không biến lỗi thành success.
8. **Data minimization.** Chỉ gửi field cần thiết cho provider được phép.
9. **Live facts luôn qua tool/RPC.** RAG chỉ dùng cho SOP/chính sách/hướng dẫn, không dùng để bịa số vận hành.
10. **Evaluation là release gate.** Model/provider mới không được bật chỉ vì trả lời demo tốt.

## 8. Kiến trúc mục tiêu

```text
Web/PWA
  |
  +-- AI Session Context
  |     user_id + organization_id + permissions_version + active_route
  |
  +-- AI Orchestrator API
        |
        +-- AuthN/AuthZ/Entitlement Policy
        +-- Request & Data Classification
        +-- Prompt/Model/Provider Policy
        +-- Tool Registry (server-owned capability manifest)
        +-- Conversation/Retention Service
        +-- Action Intent Service
        +-- Evaluation/Telemetry hooks
        |
        +-- Read tools -----------------> domain RPC/read model -> RLS/org scope
        +-- Draft commands -------------> canonical writer RPC -> approval engine
        +-- Knowledge retrieval --------> curated docs + ACL + citation
        +-- LLM Gateway ----------------> approved provider/model
        |
        +-- Audit/Usage/Event ledger

Background services
  +-- usage reconciliation
  +-- retention/purge
  +-- embeddings/index refresh for approved corpus
  +-- evaluation runs
  +-- anomaly jobs/outbox consumers
  +-- Zalo AI draft worker (không gửi trực tiếp)
```

### 8.1 Vì sao nên có AI orchestrator server-side

Hiện model loop và tool execution nằm phần lớn ở browser. Điều này làm client tự khai feature, giữ tool registry, tự quản confirmation và có thể gọi provider local ngoài governance.

Orchestrator server-side giúp:

- Enforce org/entitlement/model/tool policy ở một nơi.
- Không bundle tài liệu kỹ thuật và tool schema nhạy cảm.
- Ghi telemetry nhất quán.
- Quản action intent/confirmation.
- Cắt dữ liệu trước khi ra provider.
- Chuyển provider/model mà không redeploy frontend.

Frontend vẫn có thể giữ streaming UI và voice input; nhưng command authority ở server.

## 9. Thiết kế dữ liệu đề xuất

Không nên khôi phục nguyên schema legacy `ai_memory_embeddings`. Nên thiết kế mới theo org, audience và governance.

### 9.1 Cấu hình và entitlement

```text
ai_org_settings
  organization_id PK/FK
  chat_enabled
  ui_control_enabled
  write_draft_enabled
  daily_user_cap_usd
  daily_org_cap_usd
  retention_days
  allowed_data_classes[]
  default_model_policy_id

ai_entitlements
  organization_id
  user_id
  chat_enabled
  ui_control_enabled
  write_draft_enabled
  valid_from / valid_to
  granted_by / reason
  UNIQUE (organization_id, user_id)
```

Global platform kill switch/cap vẫn tồn tại riêng, không gộp vào org setting.

### 9.2 Provider/model registry

```text
ai_providers
  provider PK
  enabled
  base_url_secret_ref
  data_region
  retention_mode
  training_opt_out
  health_status

ai_models
  provider
  model_id
  enabled
  input_price / output_price
  context_tokens / max_output_tokens
  supports_tools / supports_stream / supports_vision
  allowed_features[]
  allowed_data_classes[]
  quality_tier
  effective_from / effective_to
  UNIQUE(provider, model_id)
```

### 9.3 Conversation

```text
ai_threads
  id
  organization_id
  user_id
  title_redacted
  prompt_policy_version
  retention_until

ai_messages
  thread_id
  organization_id
  role
  content_encrypted_or_redacted
  tool_call metadata
  data_classes[]
  model/provider
  created_at
```

### 9.4 Action intent và audit

```text
ai_action_intents
  id
  organization_id
  user_id
  tool_name
  canonical_payload jsonb
  payload_hash
  status PREVIEWED|CONFIRMED|EXECUTING|SUCCEEDED|FAILED|EXPIRED|CANCELLED
  expires_at
  confirmed_at / confirmation_method
  entity_type / entity_id
  writer_operation_id

ai_action_events
  intent_id
  seq
  event_type
  actor_user_id
  detail_redacted
  prev_hash / event_hash
```

### 9.5 Knowledge corpus

```text
ai_knowledge_documents
  id
  organization_id nullable for global docs
  source_path/source_url
  title
  audience
  sensitivity
  revision
  effective_from/effective_to
  owner_user_id
  status DRAFT|APPROVED|RETIRED

ai_knowledge_chunks
  document_id
  chunk_no
  text
  tsvector
  embedding optional
  metadata/citation anchor
```

Bắt đầu bằng Postgres FTS + metadata filter. Chỉ thêm embedding sau khi có corpus sạch, eval retrieval và policy provider embedding.

## 10. Contract chuẩn cho mọi AI tool

Mỗi tool phải khai báo machine-readable metadata, không chỉ `description`:

```ts
interface AiToolDefinition<Input, Output> {
  name: string;
  version: string;
  mode: 'READ' | 'DRAFT' | 'COMMAND';
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'PROHIBITED_AUTONOMOUS';
  requiredPermission: { module: string; action: string };
  requiredScopes: ('ORGANIZATION' | 'BUILDING' | 'ACCOUNT' | 'ENTITY')[];
  allowedFeatures: ('chat' | 'ui_control')[];
  inputSchema: unknown;
  outputSchema: unknown;
  inputDataClasses: string[];
  outputDataClasses: string[];
  writerRpc?: string;
  requiresIntent: boolean;
  requiresHumanConfirmation: boolean;
  requiresApprovalEngine: boolean;
  maxRows: number;
  timeoutMs: number;
  execute(ctx: ServerToolContext, input: Input): Promise<Output>;
}
```

### 10.1 Quy tắc READ tool

- Luôn filter `organization_id`/scope rõ ràng.
- Giới hạn rows/fields.
- Không trả raw row `*`.
- Output có source IDs/links và `as_of`.
- Số liệu tài chính phải dùng RPC/report source giống UI.
- Không dùng LLM để cộng/trừ khi DB có thể tính.

### 10.2 Quy tắc DRAFT tool

- Chỉ tạo intent hoặc entity draft qua canonical RPC.
- Không set APPROVED/POSTED/PAID/OCCUPIED/TERMINATED.
- Không chọn account/approver mơ hồ.
- Preview structured và payload hash cố định.
- User confirmation không được model tự khai.

### 10.3 Quy tắc COMMAND tool

Trong giai đoạn hiện tại, không cấp COMMAND tool cho model. Những command tài chính/pháp lý/trạng thái chỉ được UI gọi trực tiếp sau human action và server re-check.

## 11. Roadmap phát triển theo giai đoạn

### Giai đoạn 0 - Containment ngay (0-3 ngày)

1. Tắt UI-control production.
2. Tắt mock provider production.
3. Vá URL sanitizer cho ChatPanel.
4. Enforce model allowlist trong proxy.
5. Nếu usage thiếu, giữ reservation thay vì ghi cost 0.
6. Loại write tool khỏi PageAgent; nếu cần, tạm tắt write tool toàn bộ.
7. Tạm dừng workflow `supabase db push` production cho tới khi baseline xong.

**File chính**

- `src/copilot/ChatPanel.tsx`
- `src/copilot/createAgent.ts`
- `src/copilot/tools/registry.ts`
- `supabase/functions/llm-proxy/index.ts`
- `supabase/migrations/*ai*`
- `.github/workflows/supabase-migrate.yml`

### Giai đoạn 1 - Nền an toàn và nguồn sự thật (1-3 tuần)

1. Baseline/squash schema production và test restore DB trắng.
2. Thiết kế org-aware AI tables/settings/entitlements/quota.
3. Tạo server orchestrator hoặc Edge Function AI API có task token.
4. Chuyển provider/model registry sang schema validate.
5. Thêm request limits, error normalization, circuit breaker và usage unknown state.
6. Thêm data classification/DLP/retention.
7. Tạo central telemetry và alert.

### Giai đoạn 2 - Copilot read-only bám nghiệp vụ (3-6 tuần)

Ưu tiên tool ít rủi ro, giá trị cao:

1. `lead_summary_and_next_action`
2. `room_match_for_lead`
3. `customer_360_summary`
4. `contract_preflight`
5. `meter_anomaly_check`
6. `invoice_explain`
7. `payment_reconciliation_check`
8. `approval_packet_summary`
9. `cashbook_handover_diff`
10. `task_triage`
11. `zalo_reply_draft`

Mọi tool trả evidence IDs/link và không mutation.

### Giai đoạn 3 - Knowledge grounding có citation (5-8 tuần)

1. Tạo corpus đã duyệt, không dùng toàn bộ `docs/he-thong` trực tiếp.
2. Metadata/audience/effective date/revision.
3. FTS trước; embedding sau khi eval chứng minh cần thiết.
4. Citation theo chunk và cảnh báo tài liệu hết hiệu lực.
5. SOP global tách khỏi chính sách từng organization.

### Giai đoạn 4 - Draft commands qua approval (8-12 tuần)

Chỉ sau khi Giai đoạn 0-3 đạt gate:

- Draft phiếu thu/chi qua canonical RPC.
- Draft reply Zalo, không gửi.
- Draft contract/notice/template.
- Draft job/task.
- Draft correction proposal cho meter/invoice.

Tất cả dùng intent, confirmation, idempotency, transaction, audit và approval engine khi cần.

### Giai đoạn 5 - Analytics/anomaly/background (sau 12 tuần)

- Scheduled anomaly detection qua outbox/job queue.
- Theo dõi churn/occupancy/cash-flow risk.
- OCR meter/receipt với human verification.
- Quality feedback loop và model routing theo task.
- Không triển khai autonomous money/legal actions nếu chưa có governance riêng được phê duyệt.

## 12. Backlog cụ thể theo file/module

| Ưu tiên | Hạng mục | File/module hiện tại | Thay đổi đề xuất |
|---|---|---|---|
| P0 | Tắt UI-control | `ai_copilot_settings`, `ChatPanel.tsx` | Default OFF; chỉ bật sau capability E2E |
| P0 | UI allowlist | `safetyGuard.ts`, UI components | `data-ai-allow`; deny all interactive by default |
| P0 | Tách PageAgent tools | `registry.ts`, `createAgent.ts` | Chỉ `uiSafeTools`; loại write |
| P0 | Safe links | `ChatPanel.tsx` | URL parser + route/domain allowlist + tests |
| P0 | Model allowlist | `llm-proxy/index.ts` | Reject unknown model, capability validation |
| P0 | Cost fail-closed | `llm-proxy/index.ts`, usage RPC | `usage_unknown`, keep reserved cost |
| P0 | AI write RPC | `writeTools.ts`, SQL mới | Không direct DML; transaction canonical |
| P0 | DB baseline | migrations/workflows | Một source of truth, restore test |
| P1 | Org-aware AI | AI migrations, chatEngine, proxy | Org required end-to-end |
| P1 | Action intent | DB + orchestrator + UI | Preview/confirm/execute server-side |
| P1 | Audit immutable | `ai_write_audit` | Append-only RPC/hash-chain |
| P1 | DLP | `maskPii.ts`, registry/orchestrator | Field classification + minimization |
| P1 | Curated KB | `registry.ts`, docs | Backend corpus + citations |
| P1 | Provider schema | admin page + DB | `ai_models`, capabilities/pricing/policy |
| P1 | Local governance | `chatEngine.ts`, `useAiProviders.ts` | Reauthorize/log; read-only or disable prod |
| P1 | Fallback codes | `canonicalFallback.ts`, writers | Không fallback mọi `42501` |
| P1 | Worker hardening | `worker/index.js` | Least privilege, encrypted session, leases |
| P2 | Telemetry | usage tables/proxy/tools | org/thread/tool/prompt/provider IDs |
| P2 | Evals | `src/copilot/__tests__`, integration suite | Golden, permission, PII, injection, parity |
| P2 | Chat lifecycle | ChatPanel + DB | list/search/delete/export/TTL |
| P2 | Docs cleanup | legacy AI docs | Archive/update current architecture |

## 13. Evaluation và test plan

### 13.1 Unit

- Model parser/allowlist và pricing validation.
- URL sanitizer với encoded `javascript`, `data`, `//evil`, control chars.
- PII redaction theo field và free text.
- Tool metadata/risk/permission filtering.
- Intent state machine, TTL, payload hash, replay.
- Cost calculation khi usage missing/cached/streamed.

### 13.2 Integration Edge/RPC

- 401 JWT thiếu/sai.
- 403 entitlement/permission/org sai.
- Unknown provider/model fail-closed.
- Model disabled sau khi panel đang mở có hiệu lực ngay.
- Quota race 20 request song song không vượt cap.
- Missing usage giữ reserved cost.
- Cross-org negative matrix cho thread/message/usage/action/audit.
- AI draft writer rollback toàn bộ khi item/audit/request lỗi.
- Duplicate idempotency trả cùng entity đã commit.
- `42501` không fallback legacy.

### 13.3 E2E browser

- Launcher đúng theo session/entitlement/quyền/org.
- Chat phòng trống/doanh thu đối chiếu cùng source với UI.
- Unsafe model link không click/chạy được.
- Prompt injection trong customer name/note không làm tool trái phép.
- UI-control không thể đổi switch phòng, mở payment mutation, xóa invoice hoặc submit form.
- Chuyển route giữa task dừng.
- Chuyển organization không mang history/tool result org cũ.
- Revoke entitlement giữa task chặn request tiếp theo.

### 13.4 Business golden cases

Tạo bộ case từ dữ liệu đã ẩn danh:

- Phòng trống/sắp trống.
- Cọc giữ chỗ và contract cọc thiếu.
- Hợp đồng sắp hết hạn.
- Meter anomaly.
- Invoice paid/partial/unpaid.
- P&L cash/accrual.
- Approval special category/threshold.
- Payment-voucher-account parity.
- Cash handover difference.
- Salary/profit explanation.

Mỗi case phải có expected source IDs và số liệu DB, không chỉ expected prose.

## 14. Observability, SLO và cảnh báo

### 14.1 Metrics tối thiểu

- request count/error/rate limit/quota denial theo org/user/provider/model/feature.
- prompt/completion/cached tokens và reserved/actual cost.
- latency proxy/upstream/tool/end-to-end.
- tool call success/denial/timeout/result size.
- action intent preview/confirm/success/fail/expire.
- citation count/source freshness.
- PII redaction count và blocked data policy.
- queue lag/stale jobs cho Zalo/background.
- usage_unknown và reconciliation variance.

### 14.2 SLO đề xuất cho pilot

| Chỉ số | Mục tiêu ban đầu |
|---|---:|
| Unauthorized cross-org data | 0 tuyệt đối |
| Autonomous prohibited mutation | 0 tuyệt đối |
| Unknown model accepted | 0 |
| AI write partial commit | 0 |
| Citation coverage cho câu hỏi SOP | >= 95% |
| Numeric parity với report source | 100% golden cases |
| P95 chat read-only | < 12 giây |
| Usage log completeness | >= 99,5% |
| Missing usage ghi cost 0 | 0 |

### 14.3 Alert

- Model/provider price drift hoặc cost vượt reserved.
- Nhiều `usage_unknown`.
- Tăng đột biến token/tool rounds.
- Repeated permission denial/prompt injection signature.
- Action intent fail/replay.
- Pending reservation quá 5 phút.
- Zalo processing lease stale.
- Cross-org policy test fail trong CI.

## 15. Governance và phân quyền AI

### 15.1 Vai trò đề xuất

- Platform AI Admin: provider/model/global cap, không mặc nhiên có quyền dữ liệu tenant.
- Organization Owner: bật/tắt use case, retention, model policy cho org.
- AI Operator: xem usage/quality, không sửa provider secret.
- Tool Owner theo domain: phê duyệt schema/tool version/eval.
- Security/Data Steward: data class, retention, provider approval.
- End User: chỉ tool theo permission nghiệp vụ hiện có.

### 15.2 Ma trận autonomy

| Nhóm hành động | AI tự đọc | AI đề xuất | AI tạo draft | AI execute |
|---|---:|---:|---:|---:|
| Tìm kiếm/tóm tắt dữ liệu được quyền | Có | Có | N/A | N/A |
| Gợi ý phòng/lead/task | Có | Có | Có thể lưu note draft | Không tự đổi state |
| Soạn tài liệu/tin nhắn | Có | Có | Có | Chỉ người dùng gửi |
| Tạo phiếu thu/chi | Có preflight | Có | Có qua intent/RPC | Không post/approve |
| Thu/hoàn tiền | Có giải thích | Có proposal | Không | Không |
| Hợp đồng/thanh lý | Có summary/preflight | Có proposal | Draft văn bản | Không đổi state |
| Approval | Có summary | Có risk flags | Không | Không |
| RBAC/org/settings | Có giải thích | Có diff proposal | Không | Không |
| Bàn giao/đối soát | Có diff | Có proposal | Không | Không confirm |
| Zalo | Có classify/summarize | Có draft | Có draft queue | Không gửi tự động |

## 16. Tiêu chí hoàn thành theo mốc

### Gate A - Cho chat read-only pilot rộng hơn

- P0 model allowlist/cost/link đã đóng.
- UI-control OFF.
- Org context và RLS AI pass negative tests.
- Curated tool outputs không lộ field ngoài allowlist.
- Golden numeric parity pass.
- Retention và delete tối thiểu có hiệu lực.

### Gate B - Cho AI tạo draft

- Canonical transactional writer RPC.
- Action intent + confirmation server-side.
- Audit immutable.
- Approval engine integration.
- Retry/idempotency/rollback tests pass.
- Không direct DML từ AI bundle.

### Gate C - Cho background/anomaly jobs

- Job queue có lease/retry/dead-letter.
- Tool/model version pinned.
- Evaluation dataset và rollback/canary.
- Central observability/alert.
- Data retention và provider policy được duyệt.

### Gate D - Bất kỳ autonomous action nào

Hiện không khuyến nghị. Chỉ xem xét khi có use case riêng, risk assessment, legal/compliance approval, deterministic guard, maker-checker, canary, kill switch và audit độc lập.

## 17. Thứ tự triển khai khuyến nghị

1. Khóa UI-control, mock, unsafe link và unknown model.
2. Sửa usage fail-open và request limits.
3. Hợp nhất nguồn sự thật DB/release.
4. Org-aware AI data/entitlement/quota.
5. Orchestrator + tool capability manifest.
6. DLP/retention/provider policy.
7. Mở rộng read tools theo domain và golden eval.
8. Curated knowledge + citation.
9. Action intent + canonical draft writer.
10. Zalo draft/anomaly/background sau khi queue và worker được harden.

## 18. Các quyết định doanh nghiệp cần chốt

Đội kỹ thuật không nên tự suy đoán các chính sách sau:

1. Tổ chức nào được dùng cloud AI và provider nào được phê duyệt.
2. Dữ liệu nào được phép rời hệ thống: tên, SĐT, địa chỉ, hợp đồng, tài chính, ảnh.
3. Thời hạn lưu chat/tool output và quyền export/delete.
4. AI draft phiếu có luôn UNAPPROVED hay phải đi cùng birth policy/ngưỡng hiện hành với source riêng.
5. Ai được xem usage/cost theo org, team và platform.
6. Zalo draft có bắt buộc checker thứ hai cho nhóm tin nhạy cảm hay không.
7. Mức confidence tối thiểu để gợi ý link lead/customer/contract.
8. Chính sách model fallback khi provider lỗi.
9. Có cho Ollama/local ở production hay không.
10. Mục tiêu chi phí/tháng, latency và chất lượng theo từng use case.

## 19. Verification đã thực hiện trong audit

- Đọc và đối chiếu AI runtime, proxy, migrations, prepared SQL, routes, hooks và tài liệu nghiệp vụ.
- Kiểm tra working tree trước khi tạo tài liệu; không sửa các thay đổi có sẵn của người dùng.
- Chạy:

```text
npx vitest run src/copilot/__tests__/copilot.test.ts
```

Kết quả: **1 file pass, 19/19 test pass**.

Điều chưa được xác minh độc lập:

- Trạng thái flag/entitlement/provider trên production DB hiện tại.
- Catalog production có khớp hoàn toàn snapshot ngày 2026-07-19 hay không.
- API key/provider billing/retention thật.
- E2E browser với model thật.
- RLS/permission negative test live cho các bảng AI.

## 20. Kết luận cuối

Hướng phát triển đúng cho codebase này không phải “thêm thật nhiều agent tự thao tác”, mà là:

1. Khóa chặt gateway, org, data và UI capability.
2. Dùng AI làm lớp hiểu ngôn ngữ và chuẩn bị quyết định.
3. Dùng RPC/canonical writer/approval engine làm authority nghiệp vụ.
4. Mở rộng read tool theo từng domain, có source/citation và eval.
5. Chỉ cho tạo draft sau khi có intent, confirmation, transaction và audit immutable.

Nếu đi theo thứ tự này, AI sẽ bám đúng hệ thống web và quy trình doanh nghiệp thay vì tạo thêm một luồng song song khó kiểm soát.
