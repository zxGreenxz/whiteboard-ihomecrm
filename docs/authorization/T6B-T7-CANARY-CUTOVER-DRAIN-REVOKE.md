# Authorization tranche `T6b-T7` — Per-domain canary, cutover, drain và revoke

> Trạng thái: `IN_DESIGN`
> Production mutation (flip flag / drain / revoke DML): **BLOCKED** — không được phép cho tới khi recovery set `VERIFIED` **và** owner cấp đủ exact commit SHA + migration SHA-256 + maintenance window + canary count/VND cap. Default khi thiếu bất kỳ trường nào: canary count = `0`, VND cap = `0`, flag = `OFF`, **không apply/flip**.
> Phạm vi tài liệu: đây là spec review-first cho **cơ chế thực thi cutover từng domain**, không phải cho contract writer (contract thuộc T1b/T3/T5). Không đặt bất kỳ SQL nào dưới đây vào `supabase/migrations/`.

## 1. Scope và dependency

- **Deliverable/tranche ID:** T6b (per-domain read/write cutover dưới flag) + T7 (B-money canary → flip → drain writer cũ → revoke direct DML theo domain/signature).
- **Domain:** tất cả money domain, cutover **tuần tự từng domain**, không one-shot: `invoice` → `payment/credit` → `thu-chi (income_expenses)` → `cashbook (accounts)` → `meter/invoice` → `deposit/contract` → `salary/profit`. Thứ tự này bám mục 27.4 và Sprint 7.
- **Normative plan section:** `docs/AUTHORIZATION-PLAN.md` mục 27.4 (Cutover theo domain, 8 bước), mục 27.6 (Cửa GO tối thiểu), mục 27.2 (quyết định nghiệp vụ owner), §17 Sprint 7, §18 test matrix. Runtime tracker: `docs/AUTHORIZATION-IMPLEMENTATION-STATUS.md` hàng `T6b/T7` = `BLOCKED`.
- **Dependencies và trạng thái (tất cả phải `VERIFIED` trước khi mở T7 cho domain tương ứng):**
  - `T0a` recovery certification — `BLOCKED` (recovery `20260715T152622Z-online-unfrozen` = `ONLINE_UNFROZEN/PARTIAL`; thiếu portable Auth/Storage-aware dump, R2 referenced-only, chưa blank restore). Đây là chặn cứng đầu tiên.
  - `T0b` deployment control — `PREPARED` (workflow đã bỏ push trigger; environment `supabase-production` với required reviewer **chưa** cấu hình trên remote).
  - `T1a` contain approval RPC — `BLOCKED`.
  - `T1b` harden `record_invoice_payment_v3` — `BLOCKED` (đây là active payment writer; T7 payment domain không mở khi T1b chưa `VERIFIED`).
  - `T2` RBAC source-of-truth + version invalidation — `BLOCKED`.
  - `T3` approval contract v2 (non-callable) — `BLOCKED`.
  - `T4a` JWT/concurrency/reconciliation/observability harness — `IN_DESIGN` (script legacy có: `scripts/test-cross-tenant.mjs`, `scripts/check-definer-acl.mjs`, `scripts/check-view-invoker.mjs`, `scripts/reconcile-money.mjs`, `scripts/definer-acl-baseline.json`; coverage chưa đủ gate mới).
  - `T5` canonical writer theo domain, flag OFF — `BLOCKED`.
  - `T6a` organization integrity + RLS v2 shadow — `BLOCKED`.
- **In scope:**
  - Cơ chế feature-flag server-enforced để bật canonical writer/RLS v2 guard cho **một canary organization** rồi mở rộng.
  - Quy trình 8 bước cho **mỗi** domain: inventory writer → shadow/dual-path → freeze/window → pre-state hash + reconciliation baseline → bật server guard + flip frontend flag → drain writer cũ → revoke direct DML đúng signature → reconcile post-state + observation.
  - Proof drain (0 legacy traffic) và exact per-signature `REVOKE` (không grep, không blanket `REVOKE DML`).
  - Per-domain canary count / VND cap / observation interval / abort threshold.
- **Out of scope:**
  - Nội dung contract của bản thân writer (thuộc T1b/T3/T5). T6b-T7 chỉ *cutover* writer đã `VERIFIED`.
  - Storage/R2/Edge ACL burn-down (T8).
  - Drop legacy policy/RPC/JSON snapshot/fallback (T9 — chỉ sau retention + zero legacy traffic).
  - Tạo/không tạo project tạm hay upload cloud cho recovery (owner đã đặt phạm vi local-only ngày 2026-07-16).
- **Business behavior trước thay đổi:** mọi ghi tiền đi qua đường hiện hữu. Ví dụ payment: `useInvoicePayments::useRecordPaymentRPC`, `useBulkRecordPayment`, `usePayments` (useCreatePayment) đều gọi RPC `record_invoice_payment_v3`; các domain khác còn ghi trực tiếp bảng hoặc dùng contract cũ. Không có gate canary/flag; không có drain/revoke có kiểm soát.
- **Business behavior sau thay đổi:** với **từng domain đã VERIFIED**, chỉ canonical writer (đã đạt authz/idempotency/atomic contract) được phép ghi; direct DML bị revoke theo đúng signature; flip bật dần theo canary org rồi mở rộng; nếu có bất thường thì abort = disable canary + freeze domain, **không** rollback bằng xóa/sửa row tiền.
- **Ảnh hưởng nghiệp vụ/người dùng:** trong canary window, chỉ canary org chịu đường mới; org khác giữ đường cũ tới khi expand. Sau revoke, thao tác trực tiếp không qua canonical path bị backend deny dù UI cũ từng cho. Không thay đổi số tiền của bất kỳ giao dịch đã ghi.

## 2. Immutable release identity

T6b-T7 không phải một release đơn — mỗi **(domain × bước flip/drain/revoke)** là một release riêng cần bộ định danh riêng. Owner phải cấp đủ **trước mỗi** flip; thiếu bất kỳ trường nào ⇒ default OFF/0, không apply.

- Full commit SHA (frontend chứa flag-gated canonical writer): _chưa cấp_
- Exact migration path/signature (server guard + per-signature revoke của domain đang cutover): _chưa cấp_ — phải là exact signature từ live catalog, không tên trần, không glob.
- Migration SHA-256: _chưa cấp_
- Generated-types SHA-256 (`src/integrations/supabase/types.ts` sau regen, không drift): _chưa cấp_
- Deployed frontend SHA (Vercel deployment phục vụ canary): _chưa cấp_
- Recovery certification ID (`VERIFIED`): **không tồn tại** — recovery hiện là `20260715T152622Z-online-unfrozen` = `PARTIAL/BLOCKED`. **Đây là chặn cứng.**
- Maintenance-window ID (per domain): _chưa cấp_
- Operator / Reviewer / Owner approval reference (cho **đúng** domain + đúng bước): _chưa cấp_

Không dùng branch name, "latest", glob migration, hay broad `db push` làm release identity. Phê duyệt tài liệu này **không** phải phê duyệt flip production.

## 3. Live precheck

Chạy **ngay trước mỗi** flip/drain/revoke của một domain (read-only, không mutate):

- **UTC/local start time** của precheck.
- **Exact live signatures/owners/search paths/grants** của mọi function/policy sẽ đụng trong domain — refresh từ live catalog, không tin snapshot cũ (án lệ: `CREATE OR REPLACE VIEW` làm rớt `security_invoker=true`). Chạy `node scripts/check-view-invoker.mjs` và `node scripts/check-definer-acl.mjs` để so baseline `scripts/definer-acl-baseline.json`.
- **Active callers/writers** của domain: liệt kê machine-readable từ code + PostgREST/DB logs. Payment domain đã biết writer: `useInvoicePayments.ts` (`useRecordPaymentRPC`), `useBulkRecordPayment.ts`, `usePayments.ts` (`useCreatePayment`), cùng UI `RecordPaymentDialog.tsx`, `BulkRecordPaymentDialog.tsx`, `CollectPaymentDialog.tsx`, `useQuickCollect.ts`. Precheck phải xác nhận không có writer ẩn (Edge/cron/service) ngoài inventory này.
- **Migration-ledger state**: xác nhận ledger khớp exact migration định danh ở §2, không có migration lạ chen giữa.
- **Pre-state table/object/count/hash** cho mọi bảng tiền của domain (row count + content hash) làm mốc so post-state.
- **Financial reconciliation baseline**: `node scripts/reconcile-money.mjs [YYYY-MM]` (so SUM SQL thật vs tổng-1000-dòng-đầu, bắt bug cap-1000) cho các tổng liên quan domain; ghi lại delta gốc.
- **Browser/runtime baseline**: smoke happy path của domain trên `https://ptcrm.vercel.app` bằng tài khoản test, chụp console/network không lỗi.
- **Monitoring healthy**: dashboard deny-rate / RPC-error / idempotency-conflict / p95 latency đang thu và không mất telemetry.
- **Managed backup reference**: Supabase managed DB backup gần nhất (`APPLIED`, 7/7 physical `COMPLETED`) — lưu ý backup này **không** chứa Storage/R2 bytes; đây không thay recovery `VERIFIED`.

## 4. Change contract

- **Server-derived organization/actor/resources:** flag/canary được đánh giá **phía server** theo org của actor (server-derived, không tin client). Không có "0 UI caller" hay "flag OFF ở frontend" được coi là security boundary — boundary là server guard + per-signature grant/revoke (mục 27.1).
- **Exact permission và resource scope:** cutover không nới quyền; chỉ chuyển đường ghi sang canonical writer đã mang exact permission của domain (ví dụ payment: `thu_tien.collect`, resource scope server-derived per T1b). Direct DML của bảng tiền domain bị revoke theo đúng signature.
- **State/version/CAS rules:** canary flip là thao tác cấu hình có version; bật/tắt phải idempotent và ghi version để observation gắn đúng thế hệ. Với `income_expenses` dùng chung, có thể chặn direct `APPROVED/POSTED` trước nhưng tạm cho canonical/direct `DRAFT` có guard cho tới khi mọi writer domain migrate (mục 27.4).
- **Lock order:** giữ nguyên lock order do canonical writer công bố (T1b/T3/T5); cutover không đổi thứ tự khóa row tiền.
- **Idempotency scope, canonical payload hash và conflict behavior:** cutover **kế thừa** idempotency của canonical writer; T6b-T7 không tự định nghĩa idempotency mới. **Finding cần chặn trước T7 payment:** ba call site hiện sinh `p_idempotency_key: crypto.randomUUID()` mỗi lần gọi (`useInvoicePayments.ts` dòng ~190 dùng `data.idempotency_key ?? crypto.randomUUID()`; `usePayments.ts` dòng ~135 và `useBulkRecordPayment.ts` dòng ~284 dùng random thuần) ⇒ retry mạng KHÔNG replay durable. T7 payment không được mở tới khi T1b/T5 chốt key ổn định (org+operation+subject+caller+key + payload hash).
- **Atomic effects:** cutover không được tạo hiệu ứng split. **Finding:** `useBulkRecordPayment.ts` dòng ~316 chèn `excess_amounts` **ngoài** RPC atomic ⇒ orphan risk khi lỗi giữa RPC và insert. Drain/observation của payment phải bắt tình huống này; hoặc T5 gom vào canonical writer trước.
- **Audit/provenance:** mỗi flip/drain/revoke ghi actor, org, domain, bước, version, timestamp, exact signature bị revoke, pre/post hash — append-only, không PII/secret/JWT/signed URL.
- **External outbox/side effects:** kiểm tra Edge/cron caller (ví dụ salary cron) trước khi revoke domain salary/profit; không revoke đường mà service hợp lệ còn phụ thuộc cho tới khi service migrate.
- **Forward-fix/reversal behavior:** nếu ledger mới đã post rồi phát hiện lỗi, **không** xóa/sửa row để rollback. Payment hoàn tác dùng operation/bút toán đối ứng liên kết bản gốc, nhãn "Hủy giao dịch thu tiền (tạo bút toán hoàn tác)", có anti-double-reversal (mục 27.2 điểm 3; §18.4 "hoàn tác payment hai lần trả operation cũ").
- **Feature flag default:** `OFF`. Canary count = `0`, VND cap = `0` cho tới khi owner chốt per domain.

## 5. Test evidence trước production

Bắt buộc đủ trước khi xin owner gate cho **mỗi** domain:

- **Project restore/staging ID:** chạy toàn bộ test dưới đây trên restore/staging trước; production apply chờ recovery `VERIFIED`.
- **Unit/property tests:** Vitest + fast-check cho canonical writer domain (`npx vitest run <path>`).
- **Direct JWT REST/RPC matrix:** dùng JWT thật (không service key) xác nhận allow trong scope / deny ngoài scope theo §18.2 Cartesian (role × scope × resource tenant × channel).
- **Cross-org/foreign-resource tests:** `node scripts/test-cross-tenant.mjs` mở rộng cho domain; hai organization thật, non-null org; foreign account/room/contract/item deny trước effect.
- **Concurrent/retry/rollback-injection tests:** hai collector cùng invoice; retry cùng key; inject failure từng bước phải rollback toàn operation; bulk per-invoice atomic + partial success durable (§18.4).
- **`npm run typecheck:baseline`:** không tăng lỗi so `ts-baseline.txt`.
- **`npx tsc --noEmit -p tsconfig.app.json`:** pass (root `tsc --noEmit` không check gì — không dùng).
- **Related/full Vitest:** pass.
- **`npm run lint` / `npm run build`:** pass.
- **`node scripts/check-definer-acl.mjs`:** không tăng baseline exposure.
- **`node scripts/check-view-invoker.mjs`** (nếu đụng VIEW): 0 view hở `security_invoker`.
- **Generated Supabase type drift:** regen `npm run gen:types > src/integrations/supabase/types.ts`, thêm lại comment header; 0 drift.
- **Full money reconciliation:** `node scripts/reconcile-money.mjs` pre/post khớp cho INCOME/EXPENSE, invoice/payment/credit/deposit, salary/profit, cashbook, meter/invoice, operation đối ứng; delta ngoài giao dịch test = 0.
- **Browser happy/edge/deny và console/network:** Playwright MCP trên canary; happy path + edge (retry/bulk-partial) + deny (thiếu permission) + console/network sạch.
- **Reviewer verdict:** ghi tên reviewer + verdict; markdown/source chỉ chứng minh `IN_DESIGN`/`PREPARED`, không tự thành `VERIFIED`.

## 6. Canary và production gate

- **Canary organization/users:** một org thật ít rủi ro do owner chỉ định; các org khác giữ đường cũ tới khi expand. Server-derived — client không tự chọn nhánh.
- **Transaction count cap:** default `0` (không flip). Owner phải cấp số giao dịch tối đa cho canary window mỗi domain.
- **VND cap:** default `0` (không flip). Owner phải cấp trần VND per giao dịch/tổng cho canary; vượt trần ⇒ đường cũ hoặc chờ.
- **Observation interval:** default tối thiểu một ngày làm việc quan sát trước khi mở rộng, kéo dài per domain theo business cycle; payment/thu-chi cần chu kỳ dài hơn.
- **Expansion approval:** mở rộng từ canary → toàn tenant cần owner approval riêng sau khi observation sạch; không auto-expand.
- **Old writer drain proof:** trước revoke, chứng minh **0 legacy traffic** trên đường cũ trong observation window bằng DB/PostgREST log theo signature, không chỉ grep code. Với payment: chứng minh không còn insert `payments`/`income_expenses` trực tiếp ngoài `record_invoice_payment_v3`.
- **Exact revoke/policy/signature:** `REVOKE EXECUTE`/`REVOKE`-DML theo **đúng exact signature** của domain, lấy từ live catalog; không blanket `REVOKE DML` khổng lồ, không grep đơn thuần (mục 27.4 bước 6). SQL chỉ là intent minh hoạ, chưa phải migration được duyệt:

```sql
-- INTENT MINH HOẠ — KHÔNG đặt vào supabase/migrations/ trước review + recovery VERIFIED.
-- Ví dụ payment domain: chặn direct DML sau khi drain proof = 0 legacy traffic.
-- Exact table/column/role/signature phải refresh từ live catalog ngay trước apply.
begin;

-- 1) chỉ giữ canonical writer là đường ghi (function đã VERIFIED contract ở T1b)
revoke insert, update, delete on table public.payments
  from anon, authenticated;
-- 2) bảng dùng chung: chặn direct APPROVED/POSTED, tạm cho canonical DRAFT có guard
--    (income_expenses — thực thi bằng RLS/trigger guard, không nới quyền)

commit;
```

- **Default nếu chưa được owner chốt:** canary count = `0`, VND cap = `0`, flag = `OFF`, **không apply/flip**.

## 7. Mandatory abort

Abort ngay khi có một trong các điều kiện (mục 27.4 bước 7–8, §18):

- unauthorized hoặc cross-org success (bất kỳ deny-case nào lại allow);
- financial drift khác 0 ở reconciliation pre/post;
- duplicate payment/posting/reversal (gồm double-collect do idempotency key random, double-reversal);
- orphan/split operation (ví dụ `excess_amounts` orphan khi RPC + insert tách nhau);
- unexpected legacy writer xuất hiện trong window (drain proof bị phá);
- backup/object hash mismatch;
- canary happy path bị deny không giải thích;
- 3 RPC failure liên tiếp hoặc >1% trong 5 phút;
- p95 > 2× baseline trong 10 phút;
- mất monitoring/backup/audit telemetry.

Khi abort: disable canary flag, freeze domain, giữ nguyên evidence; **không** xóa/sửa row tiền để rollback. Reconcile, forward-fix và tạo compensating reversal (operation đối ứng liên kết, có anti-double-reversal) khi cần. Nếu đã revoke mà caller hợp lệ lỗi: freeze flow, forward-fix caller theo canonical contract; chỉ khôi phục grant khi owner duyệt, **không** tự re-grant đường cũ.

## 8. Post-apply evidence

Ghi cho **mỗi** domain × bước:

- **Apply start/end UTC.**
- **Catalog/signature/grant pre/post diff:** exact signature, `has_function_privilege`/table grant trước và sau; `check-definer-acl.mjs` + `check-view-invoker.mjs` sau apply.
- **Direct API deny/allow result:** JWT thật gọi đường cũ = deny, canonical = allow.
- **Browser result:** happy/edge/deny trên canary, console/network sạch.
- **Reconciliation delta:** `reconcile-money.mjs` pre/post; delta ngoài giao dịch test = 0.
- **Runtime error/latency/deny metrics:** trong observation interval, so abort threshold.
- **Hidden caller/legacy writer result:** log chứng minh 0 legacy traffic; nếu có, ghi và forward-fix.
- **Observation completed at.**
- **Final reviewer.**
- **Final state (`APPLIED` hoặc `VERIFIED`):** chỉ `VERIFIED` sau đủ test trực tiếp + security + reconciliation + browser + observation + evidence; tracker `T6b/T7` cập nhật theo từng domain, không đánh dấu cả tranche `VERIFIED` khi còn domain chưa cutover.
- **Tracker update commit:** commit cập nhật `AUTHORIZATION-IMPLEMENTATION-STATUS.md`.

Evidence không được chứa credential, JWT, signed URL, private object path hoặc PII.