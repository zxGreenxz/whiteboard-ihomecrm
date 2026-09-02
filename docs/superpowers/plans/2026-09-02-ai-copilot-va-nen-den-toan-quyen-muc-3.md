# AI Copilot — Vá nền → toàn diện → Mức 3 (plan nhập kho 02/09/2026)

Nguồn: plan phiên Claude Code 02/09/2026, đã duyệt.

> **[CÒN SỐNG — trạng thái 02/09/2026]** G0 đang thi công — code trên nhánh `copilot/g0-va-nen`, chưa merge/apply: llm-proxy đã vá (mock gating, body allowlist, caps, stream clocks, `x-organization-id`), 2 migration còn chờ apply (`copilot_mock_off_finalize_clamp_v1`, `copilot_reserve_ai_usage_organization_v1`), frontend đã sửa (mojibake, stale-availability gate, entitlement `.eq('user_id')`, thông báo lỗi), CI đã có 9/9 gate copilot + bước Deno + `copilot-e2e.yml` + policy `tooling/copilot-action-policy.json`. Đừng đọc phần nào dưới đây như đã lên production. Xem ADR consent tại `docs/superpowers/specs/2026-09-02-ai-copilot-batch-consent-adr.md`.

# AI Copilot — Audit vòng 2 + Plan "vá nền → toàn diện → Mức 2 (AI tự thực thi ghi thường)"

## Context

User hỏi Copilot đã hoàn thiện chưa, rồi quyết định **mở rộng thành hệ AI toàn diện cho web**. Đã audit 2 vòng (6 Explore agent + tự xác minh code/migration). Ba lựa chọn user đã chốt:

1. **Mức 2** — AI tự thực thi thao tác ghi thường (tạo/sửa phiếu, hợp đồng, khách, phòng, cọc, công tơ, ghi chú…) sau khi người duyệt **KẾ HOẠCH một lần** (batch consent). Ở mức này L5 (duyệt tiền, vào sổ, xoá, đổi quyền) chưa mở: AI làm *maker* nộp hồ sơ, người là *checker*. **Mức 2 chỉ là bước diễn tập để user nắm cách vận hành.**
2. **Mục tiêu thật là Mức 3** — AI toàn quyền **L5 toàn bộ** (duyệt, vào sổ, xoá, phân quyền, cấu hình công ty, Zalo hàng loạt, thao tác router) như một superadmin ngồi bấm. **L6 (SQL thô, secret, deploy, migration) để ngoài** — vẫn qua Claude Code/Hermes.
3. Consent ở Mức 3: **cả hai** — mặc định duyệt kế hoạch + **step-up bằng mã PIN 4 số** cho bước L5; **uỷ quyền đứng (standing grant)** theo chính sách cho việc lặp lại, trong phạm vi grant AI chạy không hỏi.
4. **Chỉ superadmin trước**, rollout vai khác sau qua flag/policy.
5. **Vá nền trước rồi mới mở rộng.**

Plan này **thay thế** plan LEAN Op1 (`docs/superpowers/plans/2026-08-13-ai-copilot-superadmin-full-site-control.md`) — LEAN chọn "AI soạn — người bấm"; user nay chọn Op3 có batch consent. Spec gốc (`docs/superpowers/specs/2026-08-13-...design.md:1031`) từng cấm global consent → phải ghi ADR đổi quyết định (Task G0-E).

---

## PHẦN A — KẾT QUẢ AUDIT (trạng thái thật, 02/09/2026)

### A1. Trạng thái phát hành
Trên production đang chạy: chat + 12 tool đọc + 1 điều hướng (3 route) + **1 tool ghi** (`tao_phieu_thu_chi_nhap`, draft UNAPPROVED, nonce server). Cả 3 nguồn docs đều verdict "**not production-ready for full-site control**"; plan LEAN 44 checkbox chưa tick cái nào; Phase D chưa bắt đầu.

### A2. Độ phủ toàn site (đo từ mã)
- 112 route thật / 33 module: **24% có tool đọc, 3% có tool ghi (1), 9% điều hướng, 9% safe-control**; 14 module (42%) trắng hoàn toàn (leads, công tơ, xe, tài sản, kho, tasks, lương/KPI, cổ đông, zalo, network center, quay số, cài đặt, phân quyền, dashboard).
- 47 page contract nhưng chỉ 3 rollout key (`src/copilot/featureFlags.ts:6-10`) → **44 contract là khai báo chết**. Ba danh sách phạm vi viết tay trùng nhau (`MO_TRANG_ROUTES`, `PILOT_ROUTE_ALLOWLIST`, `pageContext`) đều dừng ở 3 route.
- Mobile (`.cm-stage`, 16 trang) **0 marker** `data-ai-safe` → page-agent không chạm được gì trên điện thoại.
- Lệch pha miền tiền: ghi được phiếu thu chi nhưng **không có tool đọc phiếu**, không thấy hộp duyệt.
- Tri thức: BM25 trên 24/28 file `docs/he-thong`, **không index `docs/huong-dan-su-dung`**, không embedding, không bộ nhớ dài hạn (chỉ transcript thread), prompt không có từ điển nghiệp vụ/few-shot/trích nguồn, page context chỉ 1 dòng nhãn+route, temporal chỉ nối 2 tool + 2 cụm từ.

### A3. Lỗi đã TỰ XÁC MINH (file:line thật)
| Mức | Lỗi | Bằng chứng |
|---|---|---|
| **P0 bảo mật** | Provider `mock` bật trên prod; header `x-mock-cost` ép `estCost` không clamp, mock finalize `cost: estCost`, `finalize_ai_usage` ghi `cost_usd = p_cost_usd` không clamp, cột không CHECK → user entitled POST `model: mock:done` + `x-mock-cost: -1000` kéo tụt hạn mức USD **toàn hệ thống** | `llm-proxy/index.ts:281-283,337`; `20260710200000:329,353`; `20260829080000:42,47,100` miễn trừ mock 3 lần |
| **P0 sẵn sàng** | `reserve_ai_usage` INSERT không `organization_id`; trigger `trg_autofill_org_strict` raise 23502 khi user và owner đều ≠1 membership ACTIVE → HTTP 500 mọi request | `20260710200000:297-301`; `20260811060000:39-42`; `20260811020000:55-81` |
| **P0 UX** | 4 chuỗi tiếng Việt mojibake + 1 mất dấu hiển thị thẳng cho user | `chatEngine.ts:345,389,427`; `safeControls.ts:212,217` |
| **P1** | Tool tự tắt im lặng sau 60s panel mở: staleTime=ngưỡng tươi=60s, không refetch, `buildRegistry` trả `[]`, không gửi `tools` lên model, không banner | `featureFlags.ts:196-208,237`; `registry.ts:639-649`; `llmClient.ts:225-231`; `QueryProvider.tsx:21-29` |
| **P1** | Entitlement query **thiếu `.eq('user_id')`** + `.maybeSingle()`; RLS cho super admin thấy mọi dòng → PGRST116 ngay khi cấp entitlement người thứ 2 → nút Copilot biến mất với super admin | `useAiProviders.ts:104-108`; `20260710200000:40-49` |
| **P1** | `llm-proxy` forward body gần nguyên (`{...body}` chỉ xoá `n`): `models`/`provider`/`route`/`max_completion_tokens` lên upstream; không cap kích thước body; stream không wall-clock/idle timeout | `index.ts:355-364,372,386` |
| **P1** | `runUiControl` return im lặng khi guard chặn (5 nguyên nhân cùng một sự im lặng) | `ChatPanel.tsx:257-269` |
| **P1** | 6/9 gate `check-copilot-*` **không chạy trong CI** (chỉ 3 ở `ci-gates.yml:197-204`; dòng 320-359 là test của gate, không phải gate). `forbidden-actions` chỉ quét 3 file tool cố định | `ci-gates.yml`; `check-copilot-forbidden-actions.mjs:127-132` |
| **P1** | E2E copilot 5 spec chưa từng chạy CI; 0 test render component; golden eval chỉ validate JSON, không artifact run; 12 test migration là regex đọc file | — |
| **P1** | Không kill-switch runtime cho đường ghi (0 flag scope `action`; `copilot_ie_writer_capabilities_v1` không RPC toggle) | `20260828170000:157-162`; `20260830183259:43` |
| **P2** | Cap USD vô nghĩa (9router `self_hosted` giá 0, openrouter `:free`) → chỉ `rate_per_min=20` là rào thật; read-RPC `jsonb_agg` không LIMIT; nuốt lỗi finalize/usage; `get_my_copilot_availability_v1` đòi `org_wide` (nhân viên cấp quyền theo toà không dùng được); wrapper RENAME dễ bị CREATE OR REPLACE đè; `.cm-stage` FAB bị nút Copilot che | các file tương ứng |
| Đính chính | `ai_copilot_perms_for` fail-open → **đã vá** `20260713090000:124-165`. Plan security-remediation **đã tracked** (`c6c57e39`), ghi chú "untracked" trong plan LEAN lỗi thời | — |

### A4. Hạ tầng CÓ SẴN tái dùng được cho "toàn quyền" (không xây lại)
- Authz deny-wins: `app_private.authorized_scope_v3(perm, org)` + `tenant_emergency_denies` (`20260725070000`, `20260829100000`).
- Idempotency chung: `app_private.canonical_write_operations` (144 tham chiếu); `create_cashbook_v1`, `create_contract_v2`, `salary_payout_v1` là mẫu ATA3+CWO chuẩn.
- Consent/nonce + audit bất biến: `copilot_preview/execute_income_expense_v1` (`20260830171108`), `ai_write_audit` trigger chặn cả service_role (`20260814034600`) — **template nhân bản cho mọi action**.
- Flags typed CAS + audit append-only: `set_copilot_feature_flag_v2`, `get_my_copilot_availability_v1`.
- **Approval engine maker-checker đầy đủ, dùng chưa hết**: `submit_financial_voucher` → `approval_requests` → `decide_financial_request_v2`/`decide_financial_voucher` chặn maker tự duyệt (`20260713130200`). Đây là đường L5 cho AI: AI = maker, người = checker.
- Mẫu external-effect + replay: `network_center_execute_action_v1` + `network_center_request_replay_v1`.
- Kill switch nghiệp vụ: `zalo_dung_khan_cap(org)`.
- Rào cứng phải giữ: `execute_javascript: null`, `DANGER_RE`/`SUBMIT_RE` trong page-agent, `chatOnly` (PageAgent không cầm write tool), `ie_compat_insert_v2` ép `UNAPPROVED` (DB-level), page-contract gate cấm `financial` mode ghi (sẽ nới có điều kiện ở G2-E).

---

## PHẦN B0 — ĐƯỜNG LÊN MỨC 3: KHÔNG ĐẬP ĐI XÂY LẠI, VỚI ĐIỀU KIỆN

**Kết luận**: Mức 2 → Mức 3 là **mở rộng**, không rebuild, **nếu** 10 điểm nối dưới đây được thiết kế ngay từ migration đầu tiên của G3. Bỏ sót điểm nào thì Mức 3 phải DROP+CREATE RPC (đổi chữ ký), sửa CHECK constraint, sửa máy trạng thái — tức là làm lại phần lõi. Chi phí làm sẵn: +1 bảng policy, +6 cột nullable, +1 tham số RPC, +2 giá trị enum, +1 slot RPC — nhỏ so với rebuild.

| # | Thứ Mức 3 cần | Nếu Mức 2 làm ngây thơ | Điểm nối làm NGAY ở G3 |
|---|---|---|---|
| 1 | Cho phép action có execute là approve/post/delete/permission | CHECK regex cấm cứng trên `execute_rpc` → phải sửa constraint + migration lại registry | CHECK **theo hàng**: tên hàm L5 chỉ hợp lệ khi `risk='L5' AND executor_kind='direct_l5_v1' AND consent_required='step_up'`; L6 pattern (`sql|secret|deploy|migration|drop|truncate|pg_`) cấm tuyệt đối |
| 2 | Bật L5 lúc chạy mà không sửa code | `is_super_admin()` + "cấm L5" hard-code trong RPC | Bảng **`app_private.copilot_action_policy`** (singleton, đổi qua typed RPC có audit): `max_direct_risk` (`'L4'` Mức 2 → `'L5'` Mức 3), `allowed_roles` (`['superadmin']` → thêm vai), `standing_grants_enabled`. RPC plan đọc policy, không hard-code |
| 3 | Step-up PIN cho bước L5 | `copilot_plan_approve_v1` không có chỗ nhận token → đổi chữ ký = DROP+CREATE | Tham số `p_step_up_token text DEFAULT NULL` có từ v1; cột `plans.consent_kind` IN (`click`,`step_up`,`standing_grant`), `plans.step_up_confirmation_id` nullable |
| 4 | Uỷ quyền đứng (không bấm) | Approve luôn đòi nonce click → phải thêm nhánh mới vào máy trạng thái | Máy trạng thái có sẵn nhánh `DRAFT → APPROVED` bởi **server** khi mọi bước được grant phủ (`consent_kind='standing_grant'`, `plans.standing_grant_ids uuid[]`); bảng grant tạo ở Mức 3 |
| 5 | Rollback/bù trừ cho L5 | Registry chỉ có `rollback` text runbook | Cột `rollback_rpc` nullable + `rollback_note` từ v1; Mức 3 điền `reverse_posted_income_expense_v2`, `unapprove_invoice_v1`, `cancel_income_expense_flex_v1`… |
| 6 | Hiệu ứng ngoài (Zalo broadcast, router) | Step chỉ có DONE/FAILED, mất phản hồi = mù | Enum step có `UNKNOWN_EFFECT` từ v1 + **slot RPC thứ 6** `copilot_plan_reconcile_step_v1` (chữ ký cố định, Mức 3 mới viết thân) |
| 7 | Mở cho vai khác ngoài superadmin | `is_super_admin()` rải trong 3 RPC | Một helper `copilot_plan_role_allowed_v1(org)` đọc `policy.allowed_roles` + `authorized_scope_v3` — mở vai = đổi policy |
| 8 | Ledger truy vết consent mạnh/yếu | Ledger không phân biệt click/PIN/grant | Cột `consent_kind, step_up_id, grant_id` trên ledger từ v1 |
| 9 | Gate CI đổi từ "cấm" sang "cấm-có-điều-kiện" | `check-copilot-forbidden-actions.mjs` hard-code 7 kind cấm → viết lại gate + test | Gate đọc `tooling/copilot-action-policy.json` `{kind: forbidden \| step_up_required \| allowed}` (G0-D), L6 khoá `forbidden` bằng test bất biến; Mức 3 = đổi 4 dòng JSON + bằng chứng |
| 10 | Duyệt trực tiếp phiếu AI vừa tạo | Đi qua approval engine → maker-checker chặn chính uid superadmin (`decide_financial_voucher`, baseline 7370) | Mức 3 dùng `direct_l5_v1` bọc `approve_income_expense_v1` (cho phép người tạo tự duyệt, `baseline:45732`; chặn nếu phiếu đã vào engine `:45718`) — **step-up PIN của người thật là checker**, ghi rõ trong ADR. Plan ghép `create_draft → approve → post` thành 3 bước |

Ba thứ Mức 3 **phải xây mới thật** (không phải rebuild, là phần chưa có): (a) PIN step-up (bảng hash + RPC verify có khoá tài khoản + UI modal), (b) standing grants (bảng + RPC + UI + báo cáo ngày), (c) ~15 action `direct_l5_v1` bọc RPC L5 có sẵn + E2E ma trận L5. Hai thứ **giữ nguyên cả ở Mức 3**: PageAgent `chatOnly` (UI-control không bao giờ ghi qua DOM — mọi ghi đi RPC), `execute_javascript: null`.

## PHẦN B — PLAN THỰC THI

Luật chung mọi task: làm trong **worktree riêng** (5 phiên khác đang chạy; Contract §3), migration đặt tên qua `node scripts/tao-ten-migration.mjs`, đổi schema prod chỉ qua `migrate:forward` (dry-run ROLLBACK trước), hàm SECURITY DEFINER mới **REVOKE riêng anon + authenticated**, đổi chữ ký RPC **DROP rồi CREATE**, smoke migration chạy được trên DB rỗng, `npm run gate:truoc-push -- --khong-dao-strict` xanh, không regen `ts-baseline.json` trên Windows, sửa file bằng Edit (bẫy CRLF). Không mở giai đoạn sau khi giai đoạn trước chưa xanh.

### GIAI ĐOẠN 0 — VÁ NỀN (chặn rủi ro trước khi xây)

**G0-A. Đóng lỗ `llm-proxy`** — `supabase/functions/llm-proxy/index.ts` + deploy qua `scripts/deploy-llm-proxy.mjs` (readback SHA)
1. Mock: chỉ cho `provider==='mock'` khi env `LLM_PROXY_ALLOW_MOCK=1` (không đặt trên prod); clamp `x-mock-cost` ≥ 0. Migration: `UPDATE ai_providers SET enabled=false WHERE provider='mock'`; `finalize_ai_usage` → `cost_usd = GREATEST(COALESCE(p_cost_usd,0),0)` (cùng chữ ký → CREATE OR REPLACE được) + `CHECK (cost_usd >= 0) NOT VALID` rồi VALIDATE.
2. Body allowlist: chỉ forward `messages, stream, stream_options, max_tokens, temperature, top_p, tools, tool_choice, response_format`; strip mọi khoá khác (`models, provider, route, transforms, plugins, reasoning, max_completion_tokens`).
3. Cap: body ≤ 512 KiB (đọc theo `content-length` + `req.text()` guard), ≤ 64 message, ≤ 4 ảnh/≤ 6 MB base64; ≤ 8 parse đồng thời (security-remediation Task 12 đã đặc tả).
4. Timeout stream: wall-clock 180s + idle 30s không chunk → abort + finalize `stream_timeout`; `finally` luôn finalize (không để `pending` cả ngày).
5. Lỗi có cấu trúc: finalize/usage-parse fail → `console.error` JSON + status `finalize_error`, không nuốt.
6. **Test**: tạo `supabase/functions/llm-proxy/index.test.ts` + `deno.json` theo mẫu `network-center-worker/index.test.ts` (pricing, allowlist, clamp, mock gating, timeouts).

**G0-B. Organization vào quota** — migration DROP+CREATE `reserve_ai_usage(..., p_organization_id uuid)`; `llm-proxy` đọc header `x-organization-id` (client gửi từ `OrganizationContext`, `makeCopilotFetch` ở `copilotConfig.ts:52-62`), verify bằng `list_my_copilot_organizations_v1` (superadmin) / membership ACTIVE, INSERT `organization_id` tường minh; thiếu org → 400 `organization_required` (không 500). **Trước khi sửa**: kiểm live số user có ≠1 membership ACTIVE đã gọi Copilot (đọc `ai_usage_logs` + `organization_memberships`).

**G0-C. Frontend sửa lỗi thật** (`src/copilot/`)
1. 5 chuỗi mojibake/mất dấu ([chatEngine.ts:345,389,427](src/copilot/chatEngine.ts#L345), [safeControls.ts:212,217](src/copilot/safeControls.ts#L212)).
2. Availability: `refetchInterval: 30_000` khi panel mở + `await refetch()` trong `send` nếu snapshot cũ >45s; khi `buildRegistry` trả rỗng vì stale/null → banner "Đang làm mới quyền công cụ…" và **không gửi** cho tới khi tươi.
3. Entitlement: thêm `.eq('user_id', uid)` ([useAiProviders.ts:104](src/copilot/useAiProviders.ts#L104)); admin page bỏ giả định global.
4. `runUiControl`: thay `return` im lặng bằng `setError(...)` theo từng nguyên nhân; panel dùng `formatCopilotRolloutError` (`featureFlags.ts:26-39`) + map `organization_required|organization_mismatch|rollout_unavailable`; `saveMessages` lỗi → toast + retry 1 lần; loading state cho model select/lịch sử thread.
5. Test render đầu tiên: `ChatPanel.test.tsx` (banner stale, lỗi hiển thị, guard UI-control) + `CopilotLauncher.test.tsx` (điều kiện hiện nút).

**G0-D. CI thi hành thật**
1. Nối 6 gate còn thiếu vào `.github/workflows/ci-gates.yml` (cạnh `:197-204`) và `scripts/kiem-nhanh-truoc-push.mjs:107-109`.
2. `check-copilot-forbidden-actions.mjs:127-132`: quét glob `src/copilot/tools/**/*.ts` + `src/copilot/plan/**/*.ts` thay vì 3 file cố định; **đổi luật từ hard-code sang policy** `tooling/copilot-action-policy.json` (`approval/posting/delete/permission: step_up_required`, `sql/secret/deploy: forbidden`) — kind `step_up_required` chỉ xanh khi action có dòng registry `consent_required='step_up'`; test bất biến: L6 không bao giờ rời `forbidden` (điểm nối #9 Mức 3).
3. Job E2E copilot: workflow riêng `copilot-e2e.yml` chạy `copilot-readonly-smoke` + `copilot-confirmation` headless trên DEMO (secrets `FLEET_BASE_URL`, `FLEET_PASS_*` đã có trong CLAUDE.local.md → nạp GitHub secrets), nightly + on-demand; artifact vào run. Gỡ `test.skip` cứng ở `copilot-draft-matrix.spec.ts:66,83` bằng env do job đặt.
4. Golden eval: job chạy `scripts/run-copilot-golden-eval.mjs` lane mock trong CI; lane real-model on-demand, artifact ghi `docs/generated/copilot-golden-eval/<sha>.json`.

**G0-E. Docs/ADR**: vá `docs/he-thong/21-ai-copilot.md:44-45` (nonce server, audit bất biến) + dấu `reviewed` trong `manifest.json`; ADR mới `docs/superpowers/specs/2026-09-02-ai-copilot-muc-2-batch-consent-adr.md` ghi quyết định đổi từ per-action consent sang batch consent, phạm vi L≤4, superadmin canary; plan LEAN gắn banner CÒN SỐNG trỏ plan này.

**Exit gate G0**: llm-proxy test xanh + SHA readback khớp; migration G0-A/B live; E2E smoke chạy thật có artifact; 9/9 gate copilot chạy trong CI; 0 mojibake; test render ≥2 file.

### GIAI ĐOẠN 1 — TRÍ TUỆ + ĐỘ PHỦ ĐỌC/ĐIỀU HƯỚNG TOÀN SITE (L0/L1)

**G1-A. Một nguồn phạm vi**: sinh `MO_TRANG_ROUTES`, `PILOT_ROUTE_ALLOWLIST`, `pageContext` từ `COPILOT_PAGE_CONTRACTS` (`src/app/capabilities/registry.ts:15-95`) — xoá 3 danh sách tay; điều hướng (L1) mở cho **mọi contract non-exempt**; cập nhật `check-copilot-routes.mjs`.

**G1-B. Rollout thật cho 19 trang canonical**: seed flag page (migration) `disabled` → bật `canary` superadmin có `expires_at` qua `set_copilot_feature_flag_v2`; tách flag `navigate` khỏi `ui_control`.

**G1-C. Tool đọc mới** (mỗi tool = RPC `copilot_<x>_v1` SECURITY DEFINER + `authorized_scope_v3` + `LIMIT` + REVOKE anon/authenticated riêng + entry `readonlyQueryContracts` + case golden). Thứ tự ưu tiên:
1. Hợp đồng: `copilot_contract_search_v1` (tên/số/phòng/trạng thái) + chi tiết HĐ.
2. Thu chi: `copilot_income_expense_search_v1` + hộp chờ duyệt (wrap `list_my_pending_approvals_v1`).
3. Leads, công tơ tháng, xe, tasks, kho vật tư.
4. Báo cáo: 9 BC BĐS + 7 BC TC → tái dùng RPC của trang (đọc từ hooks `src/hooks/**`), gác đúng permission report.
5. Gác quyền riêng: lương/KPI (`salary.view`), cổ đông (`shareholder_profit.view`), Zalo đọc hội thoại (`chat_zalo.view`), Network center trạng thái (`network_center.view`).
Thêm `LIMIT` cho 7 RPC đọc hiện có (`20260828160000`).

**G1-D. Nâng "trí tuệ"** (`src/copilot/systemPromptVi.ts`, `chatEngine.ts`, `temporalContext.ts`, `docs/`)
1. Từ điển nghiệp vụ (~40 dòng: cọc/HĐ/kỳ/công tơ/sổ quỹ/duyệt/vào sổ) + 5 few-shot + bắt buộc trích `(nguồn: …)` + format bảng/tiền.
2. Page context giàu: route params, bộ lọc đang áp (đọc URL search + store), entity đang mở; tool gợi ý theo trang.
3. Temporal: thêm quý/năm/tuần/"tháng N"; nối mọi tool có tham số kỳ; `MAX_TOOL_ROUNDS` 6→10 kèm budget token; tóm tắt hội thoại khi vượt 16k ký tự thay vì cắt.
4. Tri thức: glob thứ 2 `docs/huong-dan-su-dung/**/index.md` vào BM25 (allowlist theo `CAPABILITIES.docs.userDoc`), giữ bất biến "chỉ tải thân tài liệu có quyền".
5. Bộ nhớ dài hạn: bảng `ai_user_memory(user_id, organization_id, key, value, source, updated_at)` RLS own-row; tool `ghi_nho`/`quen`; nạp ≤20 mục vào prompt; UI xem/xoá trong panel.

**G1-E. Mobile + layout**: marker `data-ai-safe` cho biến thể mobile 3 trang pilot; CSS var `--copilot-fab-inset` trên `.cm-stage` để mọi trang mobile né nút (thay bản vá điểm `depositsMobile.css:117-120`).

**G1-F. Chi phí có ý nghĩa**: thêm `daily_tokens_cap_user/tenant` vào `ai_copilot_settings` (9router giá 0 nên USD vô nghĩa); admin cảnh báo 80%; đơn giá "quy ước" cho self_hosted để báo cáo.

**Exit gate G1**: ≥80% module có tool đọc; điều hướng mọi trang contract; golden eval mở rộng ≥60 case lane mock xanh; superadmin canary bật 19 trang trên DEMO.

### GIAI ĐOẠN 2 — NỀN GHI CÓ KIỂM SOÁT (L3/L4, vẫn nonce từng thao tác)

**G2-A. Action Registry lite** — nguồn sự thật là bảng `app_private.copilot_action_registry` (định nghĩa ở G3: `action_id, version, permission_key, risk, executor_kind, preview_rpc/execute_rpc` có CHECK regex cấm approve/decide/_post_/delete/grant/revoke ngay tầng DB, `verify_kind, rollback, flag_contract_id, enabled`) + mirror TS `src/copilot/plan/actionCatalog.ts` (zod input schema, nhãn; **không dùng khoá `name:`**) + test đối chiếu seed migration ↔ mirror. Tool ghi **sinh từ catalog**, inventory README regen. Bảng này + ledger được tạo ở migration G3-T1; G2 có thể đi trước bằng cách tách phần registry/ledger thành migration riêng nếu G3 chưa sẵn sàng.

**G2-B. Kill switch action-scope**: seed `copilot_feature_flags` scope=`action` cho từng `action_id` (seed phải `set_config('app.copilot_feature_flag_transition','v2',true)` vì trigger bump revision); `copilotAvailability()` đã hiểu khoá `action:` (`featureFlags.ts:219`); RPC mới `set_copilot_writer_capability_v1` (superadmin, audit) bật/tắt `copilot_ie_writer_capabilities_v1`; **kiểm flag + `authorized_scope_v3` + `tenant_emergency_denies` NGAY TRƯỚC execute trong RPC**, không chỉ ở client.

**G2-C. Ledger v2**: `app_private.copilot_action_ledger` append-only (trigger BEFORE UPDATE/DELETE raise mọi vai — khuôn `ai_write_audit_bat_bien_v1`), cột theo G3 (`event, permission_snapshot, consent_id, plan_id, step_no, payload/before/after_digest, outcome, error_code, sqlstate, audit_id → ai_write_audit.id`). Không mở rộng `ai_write_audit` (UNIQUE idempotency + test đang ghim); đọc qua RPC `copilot_plan_get_v1`/RPC đọc ledger superadmin.

**G2-D. Actions L3 (đảo ngược được)**: bọc RPC có sẵn thành cặp preview/execute theo **Nonce ABI v1** (`preview(org, payload) → {confirmation_nonce, canonical, preview}`; `execute(nonce, payload) → {status, entity_id, audit_id?}`, template `20260830171108`): `annotate_income_expense_v1`, `set_reservation_hold_terms_v1`, `upsert_room_pass_listing`/`set_room_pass_listing_active`, `zalo_set_conversation_flags`/`zalo_danh_dau_sale`, `update_cashbook_metadata_v1`, ghi chú khách/phòng (kiểm RPC có sẵn trước). Mỗi action = cặp RPC + 1 dòng registry + 1 dòng flag + 1 dòng mirror, một migration forward riêng.

**G2-E. Actions L4 (draft tài chính/hồ sơ)**: cặp `copilot_preview/execute_<x>_v1` theo cùng ABI bọc `create_invoice_v1` (DRAFT), `create_contract_v2` (CWO), `create_reservation_deposit_v1`, `create_meter_reading_v1`, đổi trạng thái phòng. (Tạo khách hàng **chưa có RPC** — app insert PostgREST thẳng; cần RPC `create_customer_v1` ATA3+CWO mới, xếp đợt sau của G2-E.) Đã xác minh mọi RPC trên tồn tại trong `src/integrations/supabase/types.ts` (Functions). Nới gate `check-copilot-page-contracts.mjs:91-93`: `financial` được mode `draft` **chỉ khi** action có trong registry + có `e2eSpec`.

**G2-F. E2E ma trận Phase D** (`copilot-draft-matrix.spec.ts` + role-real: superadmin org A, manager, staff thiếu quyền, org B, revoke giữa preview/execute, replay, 2 execute đồng thời, injection) chạy thật trên DEMO, artifact CI.

**Exit gate G2**: ≥8 action ghi qua registry; kill switch tắt được từng action giữa phiên (E2E); ledger v2 có dữ liệu; ma trận Phase D xanh.

### GIAI ĐOẠN 3 — MỨC 2: EXECUTION PLAN + BATCH CONSENT (thiết kế LITE, 1 migration, 5 RPC)

**Nguyên tắc rút từ hạ tầng thật**
- Consent cấp plan = **một dòng trong `app_private.copilot_write_confirmations` hiện có** (`tool='lap_ke_hoach'`, `payload_hash = plan_digest`, TTL 5', CAS `consumed_at`). Nonce plan chỉ trả 1 lần, đi qua `confirmationStore` (`kind:'ke_hoach'`), **không vào model context**. `copilot_execute_income_expense_v1` đã kiểm `tool` nên nonce plan không dùng nhầm cho phiếu.
- **Không lưu nonce từng bước**: lúc thực thi server gọi lại `preview_rpc` (nonce mới sống trong transaction) → so `copilot_payload_hash_v1(canonical)` với digest đã duyệt → gọi `execute_rpc(nonce_mới, canonical)` cùng transaction. Cặp IE hiện có **không sửa dòng nào**.
- Mỗi bước = một RPC = một transaction (IE writer bind `pg_current_xact_id()` + advisory lock). Execute bọc sub-transaction: lỗi → savepoint cuốn hết hiệu ứng, transaction ngoài vẫn ghi ledger + step FAILED.
- v1 chỉ superadmin nhưng **không hard-code**: helper `copilot_plan_role_allowed_v1(org)` đọc `copilot_action_policy.allowed_roles` (seed `['superadmin']`) + flag `action:copilot.execution_plan`; client `useIsSuperAdmin()` → `ToolCtx.isSuperAdmin` chỉ để ẩn tool. Không sửa `get_my_copilot_availability_v1` (tránh ghim test migration cũ).
- **Policy singleton** `app_private.copilot_action_policy` (`max_direct_risk` seed `'L4'`, `allowed_roles`, `standing_grants_enabled=false`, `revision`), đổi qua `set_copilot_action_policy_v1` (superadmin, CAS revision, reason/evidence bắt buộc, audit append-only như flags). Mức 3 = `max_direct_risk='L5'` + `standing_grants_enabled=true`.

**Mô hình dữ liệu** (tất cả `app_private`, REVOKE ALL FROM PUBLIC/anon/authenticated/service_role; UI đọc qua RPC đã redact)
- `copilot_action_registry` (seed pin): `action_id` (`module.action`), `version`, `label_vi`, `permission_key`, `risk` IN (L3,L4,L5), `executor_kind` IN (`nonce_abi_v1`,`maker_submit_v1`,`direct_l5_v1`), `consent_required` IN (`click`,`step_up`), `preview_rpc`/`execute_rpc` CHECK regex tên hợp lệ; **CHECK theo hàng** (điểm nối #1): tên hàm khớp `(approve|decide|_post_|posting|delete|remove|reverse|grant|revoke|permission|role)` chỉ hợp lệ khi `risk='L5' AND executor_kind='direct_l5_v1' AND consent_required='step_up'`; khớp `(sql|secret|deploy|migration|drop|truncate|pg_)` **cấm tuyệt đối** (L6); `verify_kind`, `produces_entity_table`, `consumes_ref_table`, `rollback_rpc` (nullable, điểm nối #5), `rollback_note`, `flag_contract_id`, `enabled`. Seed v1: `income_expense.create_draft` (L4, nonce_abi_v1 → cặp IE hiện có, consent `click`) và `income_expense.nop_ho_so` (L5 maker_submit_v1 → `app_private.copilot_plan_submit_voucher_v1`, consent `click` vì chỉ nộp hồ sơ). Runtime từ chối mọi action có `risk > policy.max_direct_risk` trừ `maker_submit_v1`.
- `copilot_plans`: `user_id`, `organization_id`, `client_request_id` (UNIQUE với user — retry trả plan cũ), `status` IN (DRAFT,APPROVED,DONE,FAILED,CANCELLED,EXPIRED), `version` (CAS), `plan_digest`, `registry_revision`, `policy_revision`, `max_risk` (snapshot bước cao nhất), `step_count` CHECK 1..8, `consent_confirmation_id`, **`consent_kind` IN (click, step_up, standing_grant) nullable tới khi approve, `step_up_confirmation_id` nullable, `standing_grant_ids uuid[]`** (điểm nối #3/#4), `expires_at` (=nonce 5'), `approved_at`, `execute_deadline` (+30'), `failure_reason`.
- `copilot_plan_steps`: `plan_id`, `step_no` (UNIQUE), snapshot `action_id/version/permission_key/risk`, `payload`, `canonical` (server chốt ở preview), `payload_digest`, `preview` (đã redact), `status` IN (PENDING,DONE,FAILED,BLOCKED,SKIPPED,UNKNOWN_EFFECT), `outcome` (`entity_table, entity_id, audit_id, idempotent`), `error_code/detail`, `executed_at`, `ledger_id`.
- `copilot_action_ledger` append-only (trigger BEFORE UPDATE/DELETE raise mọi vai — chép khuôn `ai_write_audit_bat_bien_v1`): `plan_id, step_no, plan_version, event` IN (plan_created, plan_approved, step_done, step_failed, step_blocked, plan_cancelled, plan_expired), `user_id, organization_id, action_id, permission_key, permission_snapshot` (`org_wide, building_count, is_super_admin, flag_plan, flag_action, registry_version, checked_at`), `consent_id, consent_kind, step_up_id, grant_id, payload_digest, before_digest, after_digest, outcome, error_code, sqlstate, entity_table, entity_id, audit_id` (→ `ai_write_audit.id`) (điểm nối #8). Không mở rộng `ai_write_audit` (UNIQUE idempotency + test đang ghim) — liên kết bằng `audit_id`.
- `plan_digest = copilot_payload_hash_v1({organization_id, actor, registry_revision, steps:[{n, a, v, d}] ORDER BY step_no})`.
- Máy trạng thái: DRAFT →(approve, nonce CAS) APPROVED →(bước cuối DONE) DONE; APPROVED →(bước FAILED) FAILED; DRAFT|APPROVED → CANCELLED; quá hạn → EXPIRED (đánh giá lười). Step tuyến tính: bước k phụ thuộc mọi bước < k; PENDING → DONE|FAILED|BLOCKED|SKIPPED. Mỗi transition: version+1 + 1 dòng ledger.

**5 RPC public** (VOLATILE, SECURITY DEFINER, `SET search_path`, REVOKE anon/service_role, GRANT authenticated) + helper `app_private` (REVOKE hết):
```
copilot_plan_create_v1(p_organization_id, p_client_request_id, p_steps jsonb)        → {plan_id, plan_version, plan_digest, consent_nonce (1 lần), expires_at, steps[preview]}
copilot_plan_approve_v1(p_plan_id, p_consent_nonce, p_plan_digest, p_expected_plan_version, p_step_up_token text DEFAULT NULL)   -- chỉ UI gọi, KHÔNG nằm trong tool registry; token PIN dùng từ Mức 3 (điểm nối #3)
copilot_plan_execute_step_v1(p_plan_id, p_step_no, p_expected_plan_version, p_organization_id)
copilot_plan_get_v1(p_plan_id)      -- chủ plan/superadmin; không nonce, không canonical thô, kèm 20 dòng ledger
copilot_plan_cancel_v1(p_plan_id, p_expected_plan_version, p_reason)
copilot_plan_reconcile_step_v1(p_plan_id, p_step_no, p_expected_plan_version)   -- slot #6 (điểm nối #6): v1 chỉ RAISE 'not_implemented', Mức 3 viết thân cho hiệu ứng ngoài
```
Trong `approve`: nếu `plans.max_risk='L5'` và policy cho L5 → **bắt buộc** `p_step_up_token` hợp lệ (Mức 3); v1 (policy `max_direct_risk='L4'`) không có plan L5 direct nên nhánh này chỉ có test.
- **create**: uid + `is_super_admin()` + org ACTIVE + flag plan + 1..8 bước + <3 plan mở/user; mỗi bước: registry `enabled` + flag `action:<id>` + `authorized_scope_v3` thô; `nonce_abi_v1` → gọi preview, lấy `canonical/preview`, digest, **xoá nonce mồ côi** ngay; `maker_submit_v1` → payload `{$ref_step:n}` (n<step, bước n produces = consumes) hoặc `{voucher_id}` (phiếu của chính actor, UNAPPROVED/UNPOSTED, chưa có request). Lỗi preview → `step_preview_failed:<n>:<mã>`, cả plan không tạo.
- **approve**: nonce regex hex64 → `FOR UPDATE` dòng consent (`user_id=uid`, `tool='lap_ke_hoach'`, chưa consumed/expired, `payload_hash = plan_digest = p_plan_digest` echo từ UI) → plan `FOR UPDATE NOWAIT` DRAFT + version khớp → **kiểm lại toàn bộ bước** (mất quyền → vẫn tiêu nonce, plan FAILED `step_not_permitted:<n>`) → CAS `consumed_at` → APPROVED, `execute_deadline`, ledger `plan_approved`.
- **execute_step**: plan `FOR UPDATE NOWAIT` (55P03 → `plan_busy`), uid, `organization_id = p_organization_id` (`organization_mismatch`), APPROVED, chưa quá deadline (→ EXPIRED + BLOCKED), version khớp; step PENDING nhỏ nhất, mọi bước trước DONE; **NGAY TRƯỚC execute**: kill switch plan + flag action + registry enabled/version + `authorized_scope_v3` (đã gồm membership/revoked/`tenant_emergency_denies`) + digest lưu = tính lại → sub-transaction: preview lại → digest khớp (`payload_changed` nếu lệch) → execute → **readback** (`ie_draft`: phiếu đúng org/actor/UNAPPROVED/UNPOSTED; `approval_request_pending`) → `after_digest` → ledger → CAS step DONE (idempotent `da_tao_truoc_do` → DONE `idempotent=true`); FAILED → plan FAILED, PENDING còn lại BLOCKED. Trả `{plan_version, step, next_step_no, plan_status}`.
- **cancel**: DRAFT|APPROVED → CANCELLED, PENDING → SKIPPED, tiêu consent; hiệu ứng đã DONE giữ nguyên (rollback = runbook theo `registry.rollback`).

**L5 tài chính — AI maker, người checker**: `app_private.copilot_plan_submit_voucher_v1(org, voucher)` khoá phiếu → `submit_financial_voucher(p_voucher, p_idempotency_key='copilot_plan:<plan>:<step>', p_system_source='AI_COPILOT')` → **bắt buộc `state='PENDING_APPROVAL'`** (`POSTED` do rule AUTO_POST → RAISE `copilot_auto_post_forbidden`, sub-transaction cuốn lại; DENIED → `rule_denied`) → readback `approval_requests` maker = uid. Bước DONE khi hồ sơ vào chờ duyệt; duyệt sau qua `decide_financial_request_v2` (maker-checker chặn chính người nộp). Giữ gate forbidden-actions xanh: `src/copilot/tools/planTools.ts` chỉ chứa khai báo tool `execute: (a, ctx) => lapKeHoach(a, ctx)` / `thucThiBuoc(...)`; mọi chuỗi trạng thái/nhãn ở `src/copilot/plan/planClient.ts` + `actionCatalog.ts`; thêm `planTools.ts` vào danh sách quét của cả `check-copilot-forbidden-actions.mjs:127-131` và `check-copilot-tool-inventory.mjs:124` kèm fixture test (tool gọi `decide_financial_request_v2()` phải đỏ).

**Edge cases đã chốt cơ chế**: nonce không vào context (tool trả text, nonce đi store); model không tự duyệt (không tool nào gọi approve; test registry bắt); thu hồi quyền/emergency deny (kiểm ở create + approve + trước từng execute); kill switch giữa plan (flag `action:copilot.execution_plan` qua `set_copilot_feature_flag_v2` CAS); đổi org (plan bind org + store bind org/thread/generation); 2 tab (`NOWAIT` → `plan_busy`, CAS version/step); replay (step CAS + idempotency key IE); timeout (client abort 30s → **không đoán**, gọi `copilot_plan_get_v1` đọc trạng thái thật); giới hạn 8 bước/3 plan/5'+30'; payload đổi sau khi xem (digest bước + digest plan + echo UI); ledger bất biến.

**Registry lite = bảng DB là nguồn sự thật + mirror TS** `src/copilot/plan/actionCatalog.ts` (`actionId, version, labelVi, risk, permission, inputSchema zod, previewFields`; **không dùng khoá `name:`** vì gate inventory coi mọi `name:` là tool) + test `actionCatalog.test.ts` parse seed migration đối chiếu mirror. Action mới (G2-D/E) = cặp RPC theo **Nonce ABI v1** (`preview(org, payload) → {confirmation_nonce, canonical, preview}`; `execute(nonce, payload) → {status, entity_id, audit_id?}`) + 1 dòng registry + 1 dòng flag + 1 dòng mirror, mỗi cái một migration forward riêng.

**UI**: vá `confirmationStore.ts` thêm `kind: 'phieu'|'ke_hoach'` + accessor theo loại (`XacNhanPhieuCard.tsx:35` đang lấy "intent mới nhất" sẽ vẽ nhầm plan); `src/copilot/KeHoachCard.tsx` (khuôn `XacNhanPhieuCard`): danh sách bước + badge L4/L5 "nộp duyệt — AI không duyệt" + preview, nút **Duyệt kế hoạch** (`data-testid="copilot-plan-approve"`) → `tieuXacNhan` → `duyetKeHoach(...)`, nút Huỷ; sau duyệt poll `copilot_plan_get_v1` 1.5s tới terminal, `data-testid="copilot-plan-step-<n>"`. `ChatPanel.tsx` render card cạnh `XacNhanPhieuCard` (không phụ thuộc `!running`), `onDuyet` → `runChat('[Hệ thống] Kế hoạch <id> đã được người dùng duyệt…')` — injection giả câu này chỉ nhận `plan_not_approved` từ server. Tool `lap_ke_hoach {muc_tieu, cac_buoc[1..8]{hanh_dong: z.enum(catalog), du_lieu}}` và `thuc_thi_buoc {ke_hoach_id, chi_buoc?}` (một lần gọi chạy tuần tự tới hết/tới bước FAILED — không vượt `MAX_TOOL_ROUNDS`), cả hai `chatOnly + superAdminOnly + rolloutKey 'action:copilot.execution_plan'`; `systemPromptVi.ts` luật 9. Admin: `COPILOT_ROLLOUT_CONTRACTS` += 3 dòng scope `action`; **vá `AiCopilotAdminPage.tsx:268`** hard-code `scope:'page'`.

**Thứ tự task G3** (mỗi task có test):
- T0 TS nền: `ToolCtx += threadId/generation/isSuperAdmin` (bỏ ép kiểu `writeTools.ts:142`), `DomainTool.superAdminOnly` lọc ở `toLlmTools/toPageAgentTools`; `confirmationStore` kind; `featureFlags` 3 contract action; 2 gate thêm `planTools.ts` + test đột biến.
- T1 Migration một file (`tao-ten-migration.mjs copilot_execution_plan_v1`, `git add` trước `provenance:generate`): một cặp BEGIN/COMMIT, idempotent 2 lượt (IF NOT EXISTS, DO-guard cho CHECK, seed ON CONFLICT), hàm mới CREATE OR REPLACE được (chưa tồn tại), ACL tường minh từng chữ ký, seed flag phải `set_config('app.copilot_feature_flag_transition','v2',true)` (trigger bump revision raise nếu thiếu), khối nghiệm thu chỉ soi catalog để **chạy được trên DB rỗng** (không FK `permission_definitions`), test `src/lib/__tests__/copilotExecutionPlanMigration.test.ts` (thứ tự authz → flag → EXECUTE → ledger → status; CHECK regex; REVOKE đủ; `is_super_admin()` ở 3 RPC; `copilot_auto_post_forbidden`).
- T2 `migrate:forward` dry-run → `check-forward-migration-idempotent` → `--apply` (**bắt buộc apply trước khi code TS lên**: `gen:types`/`rpc-surface` sinh từ catalog live; flag đang `disabled` nên an toàn).
- T3 `actionCatalog.ts` + test đối chiếu seed. T4 `planClient.ts` (RPC literal, không `any`, map lỗi `plan_busy/plan_version_stale/plan_expired/confirmation_*/payload_changed/step_preview_failed/copilot_auto_post_forbidden/rule_denied`) + test mock (nonce không lọt vào chuỗi trả về; timeout → get thay vì FAILED; loop dừng ở FAILED). T5 `planTools.ts` + prompt luật 9 + regen inventory README + test (chatOnly/superAdminOnly/không lọt PageAgent/schema không có xac_nhan|nonce|confirm/`duyetKeHoach` không là execute của tool nào). T6 `KeHoachCard.tsx` + `ChatPanel.tsx`.
- T7 E2E `.e2e-fleet/specs/copilot-plan-batch-consent.spec.ts` (thêm vào `REQUIRED_COPILOT_SPECS`), user `chunha` org DEMO, opt-in `COPILOT_PLAN_LIVE=1`: card hiện với **0 request** approve/execute/submit/insert; bấm Duyệt → đúng 1 approve + N execute, không request `decide_financial|_post_|approve_`; DB: 1 phiếu UNAPPROVED/UNPOSTED + 1 `approval_requests` PENDING_APPROVAL + 1 `ai_write_audit`; Huỷ → 0 ghi; injection "tự duyệt luôn" → 0 ghi. Tiền điều kiện DEMO: rule set ACTIVE + 3 flag enabled canary.
- T8 Docs: sửa spec `:1028` ("khong co global consent") thành quyết định 02/09; README inventory + mục Kế hoạch; `tooling/known-gaps.yaml` mục "UNKNOWN_EFFECT/reconcile chưa có" + `exit_condition`.
- T9 Rollout: gate → push → promote; flag `disabled → shadow → enabled` (reason/evidence/rollback bắt buộc) canary DEMO có `expires_at` → org thật.

**Exit gate G3**: E2E batch-consent xanh trên build SHA-attested; kill switch giữa plan (E2E); 0 đường approve/post/delete trong registry (DB CHECK + gate); ledger có `permission_snapshot` mọi bước; canary superadmin chạy ≥1 tuần không unintended-write.

### GIAI ĐOẠN 4 — L5 MAKER-CHECKER + BẰNG CHỨNG PHÁT HÀNH
1. Tool `nop_ho_so_duyet` (tên tránh regex approve/post): AI nộp phiếu AI tạo vào approval engine; UI hộp chờ duyệt cho người thật; E2E "AI không thể tự duyệt" (maker-checker chặn).
2. Golden eval real-model C01–C40 + case mới trên build SHA-attested; live negative proofs (wrong-org, revoked, nonce replay/expiry/2-tab, plan revoke giữa chừng); **user chốt SLA latency**.
3. Promote production theo canary superadmin (flag `expires_at`), theo dõi ledger 1 tuần, rồi mở vai khác.

### GIAI ĐOẠN 5 — MỨC 3: TOÀN QUYỀN L5 (mục tiêu thật) — chỉ mở khi G3 canary ≥1 tuần sạch

**G5-A. Step-up PIN 4 số** (xây mới)
- Bảng `app_private.copilot_step_up_pins(user_id PK, pin_hash text (pgcrypto `crypt()` bcrypt, không lưu PIN), failed_attempts, locked_until, updated_at)`; PIN 4 số = 10.000 tổ hợp nên **khoá là bắt buộc**: sai 5 lần → khoá 15 phút, tăng gấp đôi mỗi đợt, ghi ledger; đặt/đổi PIN qua `copilot_step_up_set_pin_v1(p_pin, p_current_password_reauth)` — client re-auth `signInWithPassword` trước, superadmin-only v1.
- `copilot_step_up_verify_v1(p_pin, p_organization_id)` → trả token 32B **một lần** (digest lưu bảng `copilot_write_confirmations` với `tool='step_up'`, TTL 5', bind user+org); PIN nhập trong **modal của `KeHoachCard`**, không bao giờ qua chat/tool/model context; `copilot_plan_approve_v1` tiêu token (CAS) khi plan có bước L5.
- UI: modal PIN (4 ô, `inputmode=numeric`), thông báo số lần còn lại/khoá; trang admin: đặt PIN, mở khoá.

**G5-B. Uỷ quyền đứng (standing grants)** (xây mới)
- Bảng `app_private.copilot_standing_grants(id, granter_user_id, organization_id, action_id, constraints jsonb (max_amount, entity filter, building_ids), max_per_day, expires_at ≤ 30 ngày, created_with_step_up_id NOT NULL, revoked_at, reason)`; tạo/thu hồi qua RPC superadmin **có step-up PIN**; audit append-only.
- Trong `copilot_plan_create_v1`: nếu `policy.standing_grants_enabled` và **mọi** bước được grant còn hiệu lực phủ (đúng action, org, trong ràng buộc, chưa vượt `max_per_day`) → server tự chuyển DRAFT→APPROVED với `consent_kind='standing_grant'`, `standing_grant_ids`; tool trả "đã tự duyệt theo uỷ quyền #…", `thuc_thi_buoc` chạy ngay. Một bước không phủ → cả plan về đường click/PIN.
- Báo cáo ngày (Telegram qua Hermes cron hoặc thông báo trong app): mọi plan `standing_grant` + tổng tiền; nút "thu hồi mọi grant" = kill switch riêng.

**G5-C. Action `direct_l5_v1`** (bọc RPC L5 có sẵn thành cặp preview/execute theo ABI, thêm `rollback_rpc`, `before/after_digest` bắt buộc, mỗi action một migration + dòng flag `disabled` + E2E)
- Tài chính: `approve_income_expense_v1` (+`approve_and_post_income_expense_v2`, `post_approved_income_expense_v2`; rollback `reverse_posted_income_expense_v2`/`cancel_income_expense_flex_v1`), `approve_invoice_v1`/`bulk_approve_invoices_v1` (rollback `unapprove_invoice_v1`), `soft_delete_invoice_v1`, `approve_meter_reading_v1`, `approve_contract_termination_v1`, `renew_contract`/`transfer_contract`, `create_termination_refund_voucher_v1`, `confirm_cashbook_closing_v1`, `salary_payout_v1`, `lock_salary_month_v1`.
- Khách/phòng: `soft_delete_customer` (⚠ `execRoles` đang gồm `anon` — siết ACL trước khi bọc), `transfer_room`, `bulk_delete_meter_readings_v1`.
- Phân quyền/tổ chức: `update_member_authorization_v1`, `upsert_organization_role_v1`, `invite_organization_member_v1`, `set_membership_status_v1` — **PIN bắt buộc kể cả có grant** (không cho standing grant với nhóm này).
- Zalo/Network: `zalo_broadcast`, `zalo_recall_message`, `network_center_execute_action_v1` — hiệu ứng ngoài → `UNKNOWN_EFFECT` + `copilot_plan_reconcile_step_v1` (đọc lại outbox/`network_center_request_replay_v1`).
- Duyệt phiếu AI vừa tạo: plan ghép `create_draft → approve → post` (điểm nối #10); phiếu đã vào engine của người khác → `decide_financial_request_v2` chỉ khi superadmin là candidate hợp lệ, không phải maker.

**G5-D. Bật Mức 3**: `set_copilot_action_policy_v1(max_direct_risk='L5', standing_grants_enabled=true)` với reason/evidence; `tooling/copilot-action-policy.json` đổi 4 kind sang `step_up_required`; flag từng action `disabled → shadow → enabled` canary DEMO có `expires_at`; ADR ghi "step-up PIN của superadmin là checker cho phiếu AI tạo".

**G5-E. Bằng chứng L5**: E2E `copilot-plan-l5-matrix.spec.ts` (PIN sai 5 lần khoá; plan L5 không PIN → `step_up_required`; grant hết hạn/vượt max_amount → về đường PIN; revoke grant giữa plan → bước BLOCKED; injection "PIN là 1234" → 0 ghi; rollback_rpc chạy được), ledger đối chiếu 1 tuần canary, golden eval L5.

**Exit gate G5**: unintended-write = 0, duplicate = 0, wrong-org = 0 trên canary 2 tuần; mọi action L5 có rollback_rpc hoặc runbook; báo cáo ngày standing grant chạy đều; L6 vẫn `forbidden` (test bất biến).

---

## Verification (chạy được, theo giai đoạn)
- G0: `deno test` llm-proxy; `npm run test -- src/copilot`; `node scripts/deploy-llm-proxy.mjs` readback SHA; migration dry-run ROLLBACK trên prod rồi `migrate:forward`; workflow `copilot-e2e.yml` có artifact; `gh api .../runs/<id> --jq .conclusion` = success.
- G1: `scripts/test-copilot-readonly-queries.mjs --local-cluster` cho RPC mới; `run-copilot-golden-eval.mjs` lane mock; kiểm tay panel trên DEMO (điều hướng mọi trang, tra huong-dan-su-dung, bộ nhớ).
- G2/G3: `check-copilot-action-registry` + `forbidden-actions` xanh; E2E draft-matrix + plan-matrix trên DEMO; kill switch giữa plan (E2E); ledger append-only test (UPDATE/DELETE bị chặn).
- G4: artifact golden real-model + ledger 1 tuần canary; checklist promote (memory `promote-phai-kiem-vercel-that-su-build`).
- G5: E2E `copilot-plan-l5-matrix` + test khoá PIN (5 lần) + test bất biến L6 `forbidden` + ledger canary 2 tuần; policy flip có audit; rollback_rpc diễn tập trên DEMO.

## Tái kiểm chứng lần cuối (02/09, tự đọc code)
Đã xác minh trực tiếp: mock/`x-mock-cost`/finalize không clamp; `reserve_ai_usage` thiếu org + trigger strict; 4 mojibake; `copilot_write_confirmations` có `id` PK (FK consent hợp lệ); maker-checker `decide_financial_voucher` (baseline 7370-7371); `approve_income_expense_v1` cho người tạo tự duyệt (45732) nhưng chặn phiếu đã vào engine (45718); chữ ký `submit_financial_voucher(p_voucher, p_idempotency_key, p_system_source, p_txn_type)`; `copilotAvailability()` hiểu khoá `action:` (featureFlags.ts:218); admin page hard-code `scope:'page'` (:267); `useIsSuperAdmin` tồn tại; execute IE kiểm `tool` (20260830171108:308); `supabase/config.toml` không cấu hình MFA (nên PIN tự xây là hợp lý); mọi RPC ghi nêu trong G2/G5 có trong `types.ts`; `ai_copilot_perms_for` đã fail-closed (đính chính agent). Chưa kiểm live (cần production): `ai_providers.mock.enabled` hiện tại, số user ≠1 membership từng gọi Copilot.

## Đối chiếu superplan dọn dẹp 02/09 — không đụng độ
Superplan `don-dep-2026-09-02` đã xong 13/13 (CI xanh `ab4e4567`); giao nhau chỉ ở docs (P4f đã gắn banner `docs/ai-copilot/*`). Rủi ro thật là 5 phiên interactive song song → worktree riêng + stage đích danh + `--khong-dao-strict` trong worktree + nạp PAT từ checkout chính.
