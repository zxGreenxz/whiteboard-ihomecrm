# Authorization tranche `T6a` — Organization integrity + RLS v2 shadow

> Trạng thái: `IN_DESIGN`
> Production mutation: **không được phép**. Apply/flip `BLOCKED` cho đến khi recovery `VERIFIED` và owner cung cấp exact commit SHA, migration SHA-256, maintenance window, canary count và VND cap (default `0` = không flip). Phê duyệt tài liệu này KHÔNG phải phê duyệt áp production.

## 1. Scope và dependency

- **Deliverable/tranche ID**: T6a — Organization integrity + RLS v2 shadow.
- **Domain**: tenant-boundary / organization derivation cho toàn bộ business tables; RLS v2 chạy shadow (chưa deny). Không phải payment/approval domain — không đụng contract tiền của T1b/T3/T5.
- **Normative plan section**: `docs/AUTHORIZATION-PLAN.md` §16.2 (mapping organization), §16.3 (thứ tự thêm `organization_id`), §16.6 (dual-read/dual-write shadow), §16.8 (stop-the-line), mục 27.3 (`T6 RLS v2 shadow/read validation`), 27.4 (cutover theo domain), 27.6 (cửa GO tối thiểu). Mục 27 là nguồn chuẩn và thay thế mọi câu mâu thuẫn cũ.
- **Dependencies và trạng thái**:
  - T0a recovery certification — `BLOCKED` (recovery `20260715T152622Z-online-unfrozen` = `ONLINE_UNFROZEN/PARTIAL`). Chặn mọi apply.
  - T2 RBAC source-of-truth (`is_super_admin`, `my_org_ids`, `authorize_v2`) — `BLOCKED`; RLS v2 shadow dựa trên helper của T2 nên chỉ shadow, không enforce, cho tới khi T2 hết mismatch.
  - T4a JWT/concurrency/reconciliation harness — `IN_DESIGN`; cần fixture hai organization thật cho cross-org tests của tranche này.
  - Đã `APPLIED` (nền, nhưng chưa `VERIFIED`): `20260713100000_sprint1_organization_foundation.sql` (bảng `organizations`, `organization_memberships`, `legacy_owner_organization_map`, seed 2 org `aaaa0000-…-000000000001` = `ihome-prod` và `dddd0000-…-000000000001` = `ihome-demo`, `is_super_admin`, `demo_user_ids`); `20260713120000_sprint3a_org_rollout_all_tables.sql` (ADD COLUMN `organization_id` nullable + backfill + index cho ~132 bảng); `20260713121000_sprint3b_org_autofill_and_boundary.sql` (`my_org_ids()`, `_autofill_org()`, `trg_autofill_org`, RESTRICTIVE `<t>_org_boundary` trên ~28 core tables).
- **In scope**:
  1. **Table classification**: phân loại mọi bảng đã gắn `organization_id` thành nhóm `TENANT_MONEY` / `TENANT_PII` / `TENANT_OTHER` / `SHARED_GLOBAL` / `PLATFORM` để chọn đúng chính sách derivation, constraint và shadow policy.
  2. **Authoritative derivation** thay cho hard-coded PROD default: khi parent/membership không giải quyết được org, row vào `authorization_migration_exceptions` (fail-closed), KHÔNG mặc định `aaaa0000-…-000000000001`.
  3. **Integrity assertions + constraints (chuẩn bị, review-first)**: zero-null trên money/PII table; zero cross-org mismatch parent↔child; composite `UNIQUE(organization_id,id)` + scoped FK; `NOT NULL` sau khi assertion sạch. Không apply live trong tranche này.
  4. **Fail-closed exception queue**: bảng/quy trình cho row mơ hồ; owner classify; không tự đoán.
  5. **RLS v2 shadow-only**: policy/evaluator deny-default chạy song song, GHI mismatch vào shadow log, KHÔNG deny production. Cross-org REST/RPC JWT test matrix trên hai org thật.
- **Out of scope**: bật enforce RLS v2 (deny) — thuộc T6b/T7 cutover; sửa `_autofill_org`/boundary trên production; drop/rewrite legacy policy; mọi hành vi tiền (invoice/payment/deposit/approval) — giữ nguyên theo T1b/T3/T5; retention/cleanup (T9).
- **Business behavior trước thay đổi**: `organization_id` đã tồn tại nhưng **nullable**; backfill 3a và autofill 3b dùng `COALESCE(... , 'aaaa0000-0000-4000-8000-000000000001'::uuid)` — row không resolve được org bị gán **im lặng** vào org PROD. RESTRICTIVE boundary `<t>_org_boundary` là **NULL-tolerant** (`organization_id IS NULL OR …`) nên row org NULL vượt boundary. Đây là hai finding audit ("hard-coded fallback / exception semantics chưa đạt đích") khiến T6a `BLOCKED`.
- **Business behavior sau thay đổi (đích thiết kế)**: derivation authoritative; row mơ hồ vào exception queue thay vì rơi vào PROD; money/PII table không còn org NULL; RLS v2 shadow báo cáo mọi truy cập lẽ ra bị deny mà không làm gãy production. Enforce/flip để tranche sau.
- **Ảnh hưởng nghiệp vụ/người dùng**: **0 thay đổi hành vi runtime** khi tranche ở shadow (đúng mục 27.4 bước 2 và §16.6). Người dùng không thấy khác biệt; giá trị là bằng chứng deny/mismatch = 0 trước khi bất kỳ cutover nào được xét.

## 2. Immutable release identity

Chưa đủ điều kiện phát hành. Các trường bắt buộc phải do owner cung cấp và không được suy từ branch/glob:

- Full commit SHA: `<chưa có>`
- Exact migration path/signature: `<chưa có — SQL chỉ tồn tại như fenced block trong tài liệu này; KHÔNG đặt file dưới supabase/migrations/ trước gate>`
- Migration SHA-256: `<chưa có>`
- Generated-types SHA-256: `<chưa có — tranche có thể đổi nullability/constraint ⇒ phải regen src/integrations/supabase/types.ts và ghi hash>`
- Deployed frontend SHA: `<không áp dụng — tranche server-only; nếu đụng client type thì ghi>`
- Recovery certification ID (`VERIFIED`): `<chưa có — hiện 20260715T152622Z-online-unfrozen = PARTIAL/BLOCKED>`
- Maintenance-window ID: `<chưa có>`
- Operator / Reviewer / Owner approval reference: `<chưa có>`

Không dùng branch name, "latest", glob migration hoặc broad `db push` làm release identity.

## 3. Live precheck (chạy read-only ngay trước prepare/apply; chưa được phép trong tranche IN_DESIGN)

- UTC/local start time: `<ghi khi chạy>`.
- **Exact live signatures/owners/search paths/grants**: refresh live catalog cho `public.my_org_ids()`, `public._autofill_org()`, `public.is_super_admin()`, `public.authorize_v2(text,uuid,text,uuid)` — không dùng tên trần; xác minh `SECURITY DEFINER` + pinned `search_path` + ACL. Liệt kê mọi trigger `trg_autofill_org` và policy `%_org_boundary` đang live.
- **Bảng thực có `organization_id`**: enumerate từ `information_schema.columns` (3a comment ghi ~132 bảng — con số phải lấy từ live, không tin comment). Với mỗi bảng ghi count tổng, count `organization_id IS NULL`, count org `= aaaa…001` để đo mức độ PROD-collapse hiện tại.
- **Cross-org mismatch precheck**: với mỗi child có parent FK (`buildings`/`rooms`/`contracts`/`invoices`/`income_expenses`/`accounts`/`customers`), đếm row có `child.organization_id <> parent.organization_id`. Kỳ vọng 0; khác 0 là stop-the-line (§16.8).
- **Active callers/writers**: xác nhận không có writer nào phụ thuộc hành vi "PROD default" để tồn tại.
- **Migration-ledger state**: xác nhận 3a/3b thực đã applied trên live và không có drift.
- **Pre-state hash**: catalog/policy/function/grant hashes; per-table count/hash cho money/PII table.
- **Financial reconciliation baseline**: SUM theo org/building/account/status cho INCOME/EXPENSE, invoice/payment/credit/deposit — làm baseline so sánh (delta phải = 0; tranche không đụng tiền).
- **Browser/runtime baseline + monitoring healthy + managed backup reference**: `<ghi khi chạy>`.

## 4. Change contract

- **Server-derived organization/actor/resources**: org của một row được suy theo thứ tự authoritative của §16.2: parent FK (building > room > contract > invoice > income_expense > account > customer) → `organization_memberships` ACTIVE của owner `user_id` → `legacy_owner_organization_map`. **Bỏ nhánh mặc định `aaaa0000-0000-4000-8000-000000000001`**; khi không resolve, ghi `authorization_migration_exceptions(table_name, row_pk, candidate_orgs, reason, status='OPEN')` và không gán org đoán. Lưu ý: seed có cả `ihome-prod` và `ihome-demo` + `demo_user_ids()`, nên PROD default cũ có thể misattribute row của org demo — derivation mới phải tôn trọng split demo/prod.
- **Exact permission và resource scope**: shadow RLS v2 đánh giá bằng `my_org_ids()` (membership ACTIVE) + `is_super_admin()` bypass, giống boundary hiện tại nhưng **deny-default** (bỏ nhánh `organization_id IS NULL`). Không client-callable helper mới được grant trong tranche này.
- **State/version/CAS rules**: không có state machine tiền trong T6a. Với sửa dữ liệu backfill/exception, dùng batch id để idempotent và có thể rebuild; không mutate `user_id` owner/audit hàng loạt (§16.1).
- **Lock order**: backfill/constraint chạy trong maintenance window; `SET LOCAL statement_timeout`; thêm constraint theo thứ tự parent→child để tránh khóa chéo. Không lock money row ngoài phạm vi cần thiết.
- **Idempotency scope, canonical payload hash và conflict behavior**: mọi backfill/exception job `WHERE organization_id IS NULL` hoặc theo batch id ⇒ chạy lại không đổi kết quả; exception insert dùng `ON CONFLICT (table_name, row_pk) DO NOTHING`.
- **Atomic effects**: mỗi phase (classify → assert → exception-drain → constraint) là transaction riêng có precheck/postcheck (§16.1); không gộp enforce vào cùng transaction với backfill.
- **Audit/provenance**: ghi `MIGRATION_IMPORTED`/batch count+hash cho mỗi lần đổi org; exception queue giữ candidate + evidence, append-only.
- **External outbox/side effects**: không.
- **Forward-fix/reversal behavior**: nếu constraint/enforce đã áp gây deny sai, forward-fix bằng cách phân loại exception + nới derivation, KHÔNG xóa/sửa row tiền để rollback (§16.7, mục 27.4 bước 8).
- **Feature flag default**: RLS v2 = **SHADOW/OFF** (log-only). Enforce mặc định OFF. Không flip trong T6a.

### 4.1 SQL intent — chưa phải migration được duyệt

Chỉ là fenced block minh hoạ; KHÔNG đặt dưới `supabase/migrations/` trước recovery gate + review.

```sql
-- (a) Exception queue fail-closed (thay cho hard-coded PROD default)
create table if not exists public.authorization_migration_exceptions (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_pk text not null,
  candidate_orgs uuid[] not null default '{}',
  reason text not null,
  status text not null default 'OPEN',   -- OPEN | RESOLVED | IGNORED
  created_at timestamptz not null default now(),
  resolved_by uuid, resolved_at timestamptz,
  unique (table_name, row_pk)
);

-- (b) Authoritative derivation KHÔNG default PROD: ví dụ cho income_expenses.
--     Row không resolve được -> exception, giữ organization_id NULL (chưa gán đoán).
with derived as (
  select x.id,
         coalesce(
           (select p.organization_id from public.buildings   p where p.id = x.building_id),
           (select p.organization_id from public.rooms       p where p.id = x.room_id),
           (select p.organization_id from public.contracts   p where p.id = x.contract_id),
           (select p.organization_id from public.invoices    p where p.id = x.invoice_id),
           (select p.organization_id from public.accounts    p where p.id = x.account_id),
           (select m.organization_id from public.organization_memberships m
              where m.user_id = x.user_id and m.status='ACTIVE' limit 1)
         ) as org
  from public.income_expenses x
  where x.organization_id is null
)
insert into public.authorization_migration_exceptions(table_name,row_pk,reason)
select 'income_expenses', d.id::text, 'org unresolved after authoritative derivation'
from derived d where d.org is null
on conflict (table_name,row_pk) do nothing;

-- (c) Shadow RLS v2: deny-default, LOG-ONLY (không attach làm policy enforce).
--     Đánh giá và ghi mismatch, chưa deny production.
create table if not exists public.authorization_rls_shadow_log (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  table_name text not null, row_pk text, actor uuid,
  legacy_visible boolean not null, v2_would_allow boolean not null
);
-- so sánh: legacy policy cho thấy row, nhưng v2 (deny-default, không NULL-tolerant,
--   không PROD default) sẽ deny -> ghi mismatch để phân loại (§16.6, 16.8).
```

## 5. Test evidence trước production

- **Project restore/staging ID**: `<chưa có — blank restore chưa thực hiện; recovery PARTIAL>`.
- **Unit/property tests**: derivation function (parent > membership > exception), không nhánh nào trả PROD default cho row mơ hồ; NULL-tolerant bị loại khỏi v2.
- **Direct JWT REST/RPC matrix**: hai organization thật (`ihome-prod`, `ihome-demo`) + JWT thật, non-null org. Xác minh shadow v2 báo deny đúng cho cross-org read/write mà legacy vẫn cho (đo mismatch), và không gây deny production.
- **Cross-org/foreign-resource tests**: 0 row đọc/ghi được xuyên org ở tầng đích; mọi mismatch được log và phân loại P0/P1=0 trước khi bàn tới enforce (§16.6).
- **Concurrent/retry/rollback-injection tests**: backfill/exception job chạy lại idempotent; inject lỗi giữa phase ⇒ rollback phase, không để org gán dở.
- **`npm run typecheck:baseline`** và **`npx tsc --noEmit -p tsconfig.app.json`**: xanh / không regress.
- **Related/full Vitest**: xanh.
- **`npm run lint` / `npm run build`**: xanh.
- **`node scripts/check-definer-acl.mjs`**: baseline `SECURITY DEFINER` exposure không tăng; `my_org_ids`/`is_super_admin`/`_autofill_org`/`authorize_v2` có ACL explicit + pinned search_path.
- **`node scripts/check-view-invoker.mjs`**: chạy nếu tranche đụng VIEW (GOTCHA `CREATE OR REPLACE VIEW` rớt `security_invoker=true`).
- **Generated Supabase type drift**: nếu đổi nullability/constraint ⇒ `npm run gen:types` và ghi hash; không để `types.ts` trôi.
- **Full money reconciliation**: `node scripts/reconcile-money.mjs` — delta = 0 (tranche không đụng tiền; bất kỳ delta ≠ 0 là abort).
- **Browser happy/edge/deny và console/network**: smoke các flow chính không regression (shadow không đổi hành vi).
- **Reviewer verdict**: `<chưa có>`.

## 6. Canary và production gate

- **Canary organization/users**: `<owner chốt>`.
- **Transaction count cap**: `0` (default — không flip).
- **VND cap**: `0` (default — không flip).
- **Observation interval**: `<owner chốt; tối thiểu một business cycle cho shadow mismatch = 0 trước khi bàn enforce>`.
- **Expansion approval / old writer drain proof / exact revoke/policy/signature**: `<chưa có>`.

Default nếu chưa được owner chốt: canary count = `0`, VND cap = `0`, flag = `OFF`/SHADOW, **không apply/flip**. T6a về bản chất là shadow: "GO" nghĩa là được ghi mismatch=0, không phải bật deny.

## 7. Mandatory abort

Abort ngay khi có một trong các điều kiện:

- unauthorized hoặc cross-org success (row xuyên org đọc/ghi được);
- financial drift khác 0 (tranche không được đụng tiền — bất kỳ delta là abort);
- org backfill còn null/unresolved trên money/PII table sau phase (§16.8);
- cross-org mismatch parent↔child khác 0;
- exception queue nhận row lẽ ra resolve được (derivation sai) hoặc bị bỏ qua im lặng;
- duplicate/orphan/split trong quá trình backfill;
- unexpected legacy writer phụ thuộc PROD-default để tồn tại;
- backup/object hash mismatch;
- 3 lỗi liên tiếp hoặc >1% trong 5 phút; p95 >2× baseline trong 10 phút;
- mất monitoring/backup/audit telemetry hoặc shadow log ngừng ghi.

Khi abort: tắt shadow/canary, freeze domain, giữ evidence; không xóa/sửa row tiền để rollback. Với org gán dở: dừng dual-write, giữ target để forensic (§16.7), reconcile và forward-fix.

## 8. Post-apply evidence

- Apply start/end UTC: `<ghi khi chạy>`.
- Catalog/signature/grant pre/post diff: policy `%_org_boundary`, trigger `trg_autofill_org`, function ACL, constraint mới.
- Per-table pre/post: count org NULL, count org=`aaaa…001`, cross-org mismatch — kỳ vọng NULL→0 trên money/PII, mismatch=0, exception queue = mọi row mơ hồ (không im lặng PROD).
- Direct API deny/allow result: shadow v2 báo deny đúng cross-org; production không bị deny nhầm.
- Browser result: không regression/console error.
- Reconciliation delta: 0 cho INCOME/EXPENSE, invoice/payment/credit/deposit.
- Runtime error/latency/deny metrics + hidden caller/legacy writer result: `<ghi khi chạy>`.
- Observation completed at / Final reviewer: `<chưa có>`.
- Final state: giữ `IN_DESIGN`/`PREPARED`; chỉ lên `APPLIED` sau khi thực áp có evidence, `VERIFIED` sau observation + gate mục 27.6.
- Tracker update commit: cập nhật `docs/AUTHORIZATION-IMPLEMENTATION-STATUS.md` hàng T6a.

Evidence không được chứa credential, JWT, signed URL, private object path hoặc PII.
