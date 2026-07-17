# Authorization tranche `T2` — Normalized RBAC source of truth + lifecycle/version

> Trạng thái: `IN_DESIGN`
> Production mutation: **không được phép** nếu thiếu một trường bắt buộc bên dưới. Recovery local hiện `ACCEPTED_LOCAL` theo owner gate 2026-07-16 nhưng không thay thế exact-source/JWT/concurrency evidence; production gate core T2 vẫn **NO-GO**.
> Áp production **BLOCKED** cho tới khi owner cung cấp exact commit SHA, migration SHA-256, maintenance window và gate/canary cụ thể; default count/VND cap `0` = không flip. Chuẩn recovery `VERIFIED` chặt vẫn chưa đạt và giới hạn `ACCEPTED_LOCAL` phải được ghi trong evidence.

## 1. Scope và dependency

- **Deliverable/tranche ID:** T2 — "RBAC synchronization, staff lifecycle, authorization-version" (AUTHORIZATION-IMPLEMENTATION-STATUS.md, executive tracker; AUTHORIZATION-PLAN.md §27.5).
- **Domain:** Authorization/RBAC source-of-truth. Không đụng tiền trực tiếp, nhưng là dependency chặn của mọi tranche tiền (T1b/T3/T5/T6/T7) qua permission resolution.
- **Normative plan section:** AUTHORIZATION-PLAN.md §11.1 (nguyên tắc), §11.3–11.5 (schema normalized/scope/override), §11.6 (canonical authorization API), §11.7 (permission context + `authorization_version` invalidation), §16.4/§16.6 (backfill + dual-read/dual-write); quyết định nghiệp vụ §27.2, gate §27.6.
- **Dependencies và trạng thái:**
  - Sprint 1 organization foundation — `APPLIED` (`supabase/migrations/20260713100000_sprint1_organization_foundation.sql`): `organizations` (có cột `authorization_version bigint NOT NULL DEFAULT 1`), `organization_memberships` (partial-unique một episode ACTIVE, index `(user_id,status,organization_id)`), `legacy_owner_organization_map`, `authorization_migration_exceptions`, seed 2 org.
  - Sprint 0 fail-closed permission RPC — `APPLIED` (`20260713090000_sprint0_fail_closed_permissions.sql`): `get_my_permissions()` là live permission path của frontend; `ai_copilot_perms_for(uuid)` là bản sao phục vụ backend/copilot qua service-side caller, không phải frontend caller. Cả hai vẫn phải được inventory và giữ tương thích tới cutover.
  - Recovery local — `ACCEPTED_LOCAL` theo owner gate 2026-07-16; portable dump + blank local restore + money reconciliation đã có, nhưng chuẩn `VERIFIED` chặt chưa đạt và không tự chứng nhận T2 exact source.
  - T4a JWT/concurrency/reconciliation harness — `IN_DESIGN`; cần fixture hai org thật để chạy dual-read parity + direct REST negative tests của T2.
  - T6a organization integrity + RLS v2 shadow — **không phải dependency chặn của T2** (sửa 2026-07-16 theo §27.3: chuỗi một chiều `T2 → … → T6`, T2 chạy trước). Chiều phụ thuộc thật là T6a → T2 (RLS v2 shadow của T6a dùng helper `authorize_v2`/`my_org_ids` của T2). Ở đây chỉ cần **phối hợp** để cùng một hàm derivation `organization_id` (nền Sprint-1 theo §16.2/§16.3, đã APPLIED), không có phụ thuộc runtime hai chiều.
- **In scope:**
  1. Chốt normalized RBAC làm **source of truth** cho permission: `permission_definitions` (208 key gốc đã seed ở `20260713110100_sprint2b_seed_permission_definitions.sql`, thêm 4 key T3 ở forward migration `20260716120100`), `organization_roles`, `role_permissions` (`effect ALLOW/DENY`), `role_bindings`, `authorization_scopes`, `role_binding_scopes`, `member_permission_overrides` (+ scoped `member_override_scopes`).
  1b. Bốn key T3 `income_expenses.self_approve_within_limit`, `cashbooks.post`, `approvals.emergency_override`, `income_expenses.reverse` đã được seed bằng forward migration `20260716120100_t2_seed_approval_permission_keys.sql` và đang `APPLIED`; T3 chỉ consume, không seed lại. Forward registry tranche kế tiếp phải thêm `cashbooks.manage_custody` và sửa `cashbooks.create.scope_kinds` thành **chỉ `ORGANIZATION`**; tạo một cashbook mới không thể được authorize bằng scope của một cashbook đã tồn tại.
  2. **Canonical admin RPC + dual-write:** mọi mutation quyền (tạo/sửa role, gán/bỏ binding, thêm/xóa scope, đặt override, suspend/revoke membership) đi qua RPC tập trung ghi đồng thời legacy (`staff_assignments`/`roles`) **và** normalized, trong cùng transaction.
  3. **Lifecycle staff:** provision/update/suspend/revoke/remove phải cập nhật normalized + legacy đồng bộ; suspend deny backend **ngay** mà không xóa identity/history (§27.2 mục 8).
  4. **Version invalidation:** bump `organizations.authorization_version` (hoặc scope-version tách) trong **cùng transaction** với mọi thay đổi membership/role/permission/binding/scope/override/area membership; đưa version vào permission context DTO; cache key `(user_id, organization_id, authorization_version)`.
  5. **Zero unexplained mismatch:** shadow-compare `effective_perms_v2(user,org)` vs `get_my_permissions()` cho toàn bộ user thật; mọi lệch phải được giải thích hoặc reconcile bằng override, trước khi bất kỳ cutover nào.
- **Out of scope:**
  - Cutover RLS/RPC sang `authorize_v2` (thuộc T6). T2 chỉ chuẩn bị source-of-truth + shadow parity; helper `authorize_v2`/`effective_perms_v2` **vẫn REVOKE khỏi client**.
  - Đổi FE `useMyPermissions`/`can()` sang DTO mới của §11.7 (thuộc T6/T5 dưới flag). T2 không flip FE.
  - Approval engine, payment v3, storage/ACL (T1b/T3/T5/T8).
  - Thay `__superadmin` sentinel cho owner (chỉ đề xuất DTO; không flip trong T2).
- **Business behavior trước thay đổi:** FE gọi `get_my_permissions()` (SECURITY DEFINER, `20260713090000`) đọc `staff_assignments.permissions` (JSONB, fallback `roles.permissions`) theo "assignment đầu tiên full-scope ưu tiên" (`ORDER BY (building_id IS NULL) DESC, created_at ASC LIMIT 1`); super admin và legacy owner allowlist nhận `{"__superadmin": true}`; shareholder/profit_manager nhận `shareholder_profit.view`. Normalized tables đã materialize (`20260713110200`) nhưng chưa là source of truth cho frontend, RLS hoặc admin mutation. Chúng không globally inert: prototype `submit_financial_voucher` đọc `effective_perms_v2` khi materialize approval candidates; T1a đã revoke prototype khỏi client nhưng dependency source vẫn tồn tại. Mutation quyền đi thẳng qua `staff_assignments` (hook `useStaffAssignments.ts`): provision/update/delete ghi `permissions` JSONB, **không** đụng normalized ⇒ normalized drift ngay khi owner sửa quyền sau materialize. `authorization_version` tồn tại nhưng **không có routine nào bump**; không có invalidation.
- **Business behavior sau thay đổi (đích T2):** Normalized là source of truth; mọi mutation quyền qua canonical RPC dual-write giữ legacy + normalized khớp và bump `authorization_version` cùng transaction. Suspend/revoke có hiệu lực backend ngay. Shadow parity = 0 unexplained mismatch trên user thật. FE vẫn dùng path cũ (không flip) nhưng context có thể nhận version để chuẩn bị cache invalidation. Không có behavior tiền nào đổi.
- **Ảnh hưởng nghiệp vụ/người dùng:** Trong T2 (chưa cutover), người dùng **không thấy khác biệt**: FE vẫn đọc `get_my_permissions()`. Rủi ro chính là mutation-path: nếu dual-write sai, quyền hiển thị (legacy) và quyền enforce tương lai (normalized) lệch nhau. Vì vậy T2 phải chứng minh parity trước, giữ FE nguyên, và chỉ chuẩn bị — không flip.

## 2. Immutable release identity

*(Chưa điền — chỉ owner cung cấp ngay trước apply. Không dùng branch name, "latest", glob migration hay broad `db push` làm identity.)*

- Full commit SHA: `<chưa có>`
- Exact migration path/signature: `<chưa có — mỗi migration T2 phải là 1 timestamp file cụ thể, không đặt vào supabase/migrations/ trước khi review + recovery gate đạt>`
- Migration SHA-256: `<chưa có>`
- Generated-types SHA-256: `<chưa có — regen sau mọi migration đổi schema; T2 có thể thêm cột version/bảng audit ⇒ types.ts phải regen>`
- Deployed frontend SHA: `<chưa có>`
- Recovery reference: `20260715T152622Z-online-unfrozen` + `20260716T045126Z-db-portable`, owner state `ACCEPTED_LOCAL`; strict `VERIFIED` certification vẫn `<chưa có>`
- Maintenance-window ID: `<chưa có>`
- Operator: `<chưa có>`
- Reviewer: `<chưa có>`
- Owner approval reference: `<chưa có — phê duyệt tài liệu ≠ phê duyệt apply>`

## 3. Live precheck

Chạy read-only ngay trước prepare/apply, capture vào evidence sanitized (không credential/JWT/PII):

- **UTC/local start time:** `<ghi lúc chạy>`.
- **Exact live signatures/owners/search paths/grants:** refresh từ live catalog:
  - `public.get_my_permissions()` và `public.ai_copilot_perms_for(uuid)` — xác nhận vẫn là bản fail-closed của `20260713090000` (SECURITY DEFINER, `search_path 'public','auth'`, nhánh cuối gọi `legacy_owner_allowlist`).
  - `public.effective_perms_v2(uuid,uuid)` và `public.authorize_v2(text,uuid,text,uuid)` — xác nhận `REVOKE ALL … FROM PUBLIC, anon, authenticated` còn nguyên (SECURITY DEFINER, `search_path 'pg_catalog','public'`).
  - Grant thực tế trên 8 bảng RBAC + `permission_definitions`: xác nhận `REVOKE ALL FROM anon,authenticated` + `GRANT SELECT TO authenticated` + policy `<t>_select_super USING is_super_admin()` (từ `20260713110000`), **không** có policy INSERT/UPDATE/DELETE cho client.
- **Active callers/writers:** inventory từ code + catalog + runtime log:
  - Đọc: `src/hooks/useMyPermissions.ts` (RPC `get_my_permissions`), `ai_copilot_perms_for` (edge/AI backend).
  - Ghi legacy: `src/hooks/useStaffAssignments.ts` — `useCreateStaffAssignment`, `useUpdateStaffAssignment`, `useProvisionStaff` (edge fn `admin-create-user` + insert `staff_assignments` với `permissions` snapshot), `useUpdateStaffMember` (diff insert/delete/update + re-snapshot), `useUpdateStaffPermissions` (UPDATE `permissions` mọi row), `useDeleteStaffAssignment`, `useRemoveStaffMember` (RPC `delete_staff_member` → DELETE `auth.users` cascade).
  - Bất kỳ edge/cron/service writer nào chạm `staff_assignments`/`roles`/`shareholders`/`profit_managers`.
- **Migration-ledger state:** xác nhận `20260713110000/110100/110200/110300/110400` đã `APPLIED`; ledger không có T2 migration mới chưa duyệt.
- **Pre-state table/object/count/hash:** count + hash cho `organization_roles`, `role_permissions`, `role_bindings`, `authorization_scopes`, `role_binding_scopes`, `member_permission_overrides`, `member_override_scopes`, `permission_definitions`; và legacy `staff_assignments`, `roles`, `organization_memberships`.
- **Financial reconciliation baseline:** T2 không đụng tiền; vẫn chạy `node scripts/reconcile-money.mjs` để chốt baseline bất biến (delta phải = 0 sau apply).
- **Browser/runtime baseline:** login test account, chụp permission-gated UI (nút theo `can()`), console/network sạch.
- **Monitoring healthy:** RPC error rate, deny rate baseline.
- **Managed backup reference:** 7/7 physical backup `COMPLETED` (metadata phòng thủ, không thay recovery `VERIFIED`).

## 4. Change contract

- **Server-derived organization/actor/resources:** actor = `auth.uid()`; org = ACTIVE membership từ `organization_memberships` (không nhận org/owner id từ client). Với materialization/backfill, org của legacy owner resolve qua `legacy_owner_organization_map`, staff qua `organization_memberships.user_id = staff_id AND status='ACTIVE'` (đúng như `20260713110200`).
- **Exact permission và resource scope:** admin RPC mutation quyền yêu cầu exact permission quản trị (đề xuất `users.edit`/`users.create` từ registry §2b; **owner không auto-bypass** — seed như normalized role capability, §11.5). Scope: chỉ trong org của actor.
- **State/version/CAS rules:**
  - `organization_roles.version`, `role_bindings.version` (đã có cột) dùng làm optimistic token cho update role/binding; expected_version mismatch ⇒ conflict.
  - `organizations.authorization_version` bump atomic `= authorization_version + 1` trong **cùng transaction** với mọi mutation quyền (§11.7). Backend **không** tin version client gửi.
- **Lock order:** lock `organizations` row (version bump) → membership → role/binding → scope/override, thứ tự cố định để tránh deadlock giữa hai admin đồng thời.
- **Idempotency scope, canonical payload hash và conflict behavior:** admin mutation là owner-initiated, thấp tần suất; dùng `expected_version` làm CAS thay vì idempotency-key. Materialize/backfill migration đã `ON CONFLICT DO NOTHING`/`DO UPDATE` (idempotent) — giữ nguyên tính chất đó cho re-run.
- **Atomic effects:** một mutation quyền phải commit cùng nhau: (a) ghi legacy (`staff_assignments`/`roles`) + (b) ghi normalized (`role_permissions`/`role_bindings`/`role_binding_scopes`/`member_permission_overrides`) + (c) bump `authorization_version`; rollback toàn bộ nếu bất kỳ bước lỗi. **Không** cho phép nửa legacy nửa normalized.
- **Audit/provenance:** mỗi mutation ghi actor, org, membership, before/after (role/binding/scope/override), reason, timestamp, version cũ→mới; append-only, không PII/secret. `member_permission_overrides` đã có `reason`, `created_by`, `created_at`.
- **External outbox/side effects:** phát invalidation cache permission **sau commit** (theo `(user_id, org, authorization_version)`); không side effect đồng bộ bên trong `authorize()`/policy (§11.6).
- **Forward-fix/reversal behavior:** T2 không tạo tiền, nên "reversal" = sửa xuôi override/binding + bump version, giữ history. Không xóa row lịch sử membership REVOKED để "rollback".
- **Feature flag default:** OFF. FE vẫn đọc `get_my_permissions()`. Không grant `authorize_v2`/`effective_perms_v2` cho client trong T2.

### 4.1 Elevated money-writer resolver là hard dependency của T5 thu-chi

T2 phải cung cấp một private API version mới (không silently đổi contract của helper shadow hiện tại) cho các writer elevated. Hình dạng dự kiến:

```text
app_private.authorize_tenant_action_v3(
  actor, organization, permission_key,
  building_id nullable, cashbook_id nullable
) → table (allowed boolean, authorization_version bigint,
           nearest_deadline timestamptz, decision_reason text)
```

(Không phải `→ boolean`: cache identity yêu cầu version + nearest_deadline trả về cùng quyết định — kể cả khi deny vì witness chưa active, activation deadline vẫn phải được trả. Shape này khớp B.3.)

Resource dimension bắt buộc phải lấy từ metadata `permission_definitions.scope_kinds` và closure server-side; caller không được tự đổi `resource_type/resource_id` để chọn scope dễ hơn. `income_expenses.create`/`restricted_create` cần building; `cashbooks.post` cần exact `CASHBOOK`. Organization/building allow không thay thế cashbook match.

**Precedence fail-closed trong cùng một snapshot/witness statement:**

1. organization suspended hoặc emergency deny đã được schema hoá;
2. matching active member `DENY`;
3. matching active role `DENY`;
4. matching active member `ALLOW`;
5. matching active role `ALLOW`;
6. default deny.

Không dùng `effective_perms_v2` để flatten trước khi authorize vì flatten làm mất scope/provenance; không dùng `public.authorize_v2` hiện tại vì helper đó return member ALLOW trước role DENY và không match `member_override_scopes` đầy đủ. Resolver elevated phải chọn + `FOR SHARE` đúng witness graph trong **một statement**, không tách nhiều candidate-lock statement rồi `EXISTS` ở snapshot mới; final evaluator phải chạy sau mọi conflict/advisory wait của writer.

**Tenant OWNER normalized, không shortcut:**

- mỗi organization có stable system-owner role identity;
- mỗi active `organization_memberships.member_type='OWNER'` có active normalized binding dù không có `staff_assignments`;
- owner capabilities là explicit `role_permissions` TENANT đã review, không phải `OWNER → true`;
- owner vẫn chịu member/role deny, scope, cashbook possession, maker-checker và cross-org closure;
- `public.super_admins`/`is_super_admin()` không tạo tenant permission. Platform emergency action dùng endpoint/context riêng có audit.

**Cashbook permission và possession là hai quan hệ độc lập:**

- materialize một `authorization_scopes(scope_type='CASHBOOK')` cho mỗi live `accounts` row có organization xác định, nhưng scope chỉ giới hạn **permission**; scope/binding không tự chứng minh ai đang nắm sổ;
- tạo relation riêng `cashbook_possession_bindings(organization_id, cashbook_id, membership_id, possession_kind, valid_from, valid_to, version, granted_by, reason, …)`, ban đầu chỉ nhận `CUSTODIAN|OPERATOR`; FK composite cùng organization và history không hard-delete;
- action nhạy cảm do registry khai báo phải đồng thời có exact permission (`cashbooks.post` cho posting, `cashbooks.manage_custody` cho chuyển giao) với scope khớp **và** active possession kind được action chấp nhận; possession một mình không cấp permission, AREA/BUILDING permission không suy ra possession;
- `accounts.user_id` và `account_shared_users` chỉ sinh **candidate** migration/reconciliation. Candidate phải lưu evidence, confidence và trạng thái `PENDING_REVIEW|APPROVED|REJECTED|AMBIGUOUS`; chỉ candidate đã review mới materialize active possession;
- owner/share khác org, membership thiếu, nhiều mapping mâu thuẫn hoặc org không xác định đi vào exception queue và fail closed; không auto-materialize org-wide possession;
- cashbook scope FK hiện không khai báo `ON DELETE CASCADE`, nên backfill scope có thể làm hard-delete account trước đây thành lỗi FK. Trước backfill phải chuyển lifecycle cashbook sang archive/transfer hoặc định nghĩa cleanup canonical có audit; không gọi bước này là hoàn toàn inert;
- lifecycle create/share/unshare/archive/transfer/custody phải lock organization trước, cập nhật permission scope + possession + candidate/review history và bump `authorization_version` trong cùng transaction;
- **inventory writer thực tế (trace 2026-07-17) mà lifecycle canonical phải thay/đóng:** `useCreateAccount` insert trực tiếp với `organization_id = NULL` và owner do client chọn; `useUpdateAccount` cho client-sent `user_id` (owner transfer) không CAS/audit; `useDeleteAccount` soft-delete không guard balance/share đang active; RLS hiện còn cho **hard DELETE qua REST** (owner + `staff_can('cashbooks','delete')`) cascade `account_shared_users` và sẽ vỡ FK CASHBOOK scope; `auth.users` delete CASCADE `accounts` (đường hủy dữ liệu tenant im lặng — phải đổi RESTRICT); share/unshare mutate `account_shared_users` trực tiếp không candidate reconciliation; `create_opening_adjustment` (GRANT authenticated) tạm NULL rồi re-set `lock_date`. Mọi path trên phải hoặc route qua canonical RPC hoặc bị guard trước khi normalized possession được coi là source of truth.

**Mutation/version lifecycle:** mọi insert/update/delete trên membership, role permission, binding, binding scope, member override, override scope, cashbook possession và area-building relationship phải đi qua canonical RPC hoặc guard đồng bộ; lock order parent-before-child `organization → membership/role → binding/override/possession → scope edges`; bump version cùng transaction. Direct legacy mutation chưa drain thì normalized data chưa thể gọi là source of truth.

**Cache và invalidation:** authorization context/cache identity tối thiểu là `(user_id, organization_id, authorization_version, nearest_deadline)`, trong đó `nearest_deadline` là thời điểm tương lai gần nhất có thể đổi quyết định do cả activation lẫn expiration: `membership.valid_from/valid_to`, `role_bindings.valid_from/valid_to`, `member_permission_overrides.expires_at`, possession `valid_from/valid_to` và emergency-deny `active_from/expires_at`. Cache không được sống quá deadline dù version không đổi; nếu decision hiện tại là deny vì witness chưa active, deadline activation vẫn phải được trả về. Mọi mutation hiệu lực bump version atomic; notification Realtime/outbox chỉ phát sau commit. Consumer phải coi notification là hint và luôn so version server-side, không dùng notification làm source of truth.

**OWNER semantic identity:** thêm `organization_roles.system_key` nullable với partial unique `(organization_id, system_key)` cho system role; system OWNER dùng `system_key='TENANT_OWNER'`, không dựa vào tên hiển thị hay UUID ngẫu nhiên. Mỗi ACTIVE membership `member_type='OWNER'` có binding tới role này; role có explicit reviewed `role_permissions`. OWNER vẫn chịu DENY/scope/possession/maker-checker. Transfer ownership và last-owner protection chạy qua canonical lifecycle RPC, giữ membership history và bump version.

**Witness/concurrency:** resolver elevated không thể tự khóa được những row **chưa tồn tại** dưới READ COMMITTED. Canonical authorization mutation phải lock row organization đầu tiên, còn writer phải giữ shared organization row lock từ quyết định cuối tới effect; mutation lấy exclusive organization lock trước khi thêm/xóa witness. Quy tắc này đóng phantom ALLOW/DENY và thống nhất lock order, thay vì hy vọng nhiều `PERFORM ... FOR SHARE` rời rạc tạo một snapshot.

### 4.2 Gate riêng trước khi T5 thu-chi được rời `BLOCKED`

- active OWNER không có `staff_assignments` được allow đúng tenant qua `TENANT_OWNER` binding explicit;
- cross-tenant OWNER bị deny;
- suspended/closed organization hoặc emergency deny thắng mọi ALLOW;
- member DENY thắng role ALLOW;
- role DENY thắng member ALLOW;
- scoped member override chỉ match đúng scope;
- expired/future membership/binding/override/possession bị deny theo `clock_timestamp()` và cache hết hạn không muộn hơn `nearest_deadline`;
- building allow không cấp cashbook; cashbook A không cấp B;
- permission không possession bị deny; possession không permission bị deny; legacy share thay đổi không tự đổi quyết định v3;
- platform super-admin không tenant membership/grant bị deny;
- revocation hoặc witness mới commit trước effect làm writer dùng version/snapshot mới; organization lock loại phantom witness;
- mọi mutation effective bump đúng một generation/version và invalidation chỉ phát sau commit;
- shadow/reconciliation có zero unexplained mismatch và zero ambiguous legacy cashbook grant được auto-allow.

## 5. Test evidence trước production

- **Project restore/staging ID:** `<chưa có cho T2 exact-source tests>`. Recovery local hiện `ACCEPTED_LOCAL` theo owner gate ngày 2026-07-16 nhưng không tự thay thế disposable PostgreSQL/JWT/concurrency evidence của tranche này.
- **Unit/property tests:** dual-write RPC giữ legacy↔normalized khớp cho mọi thao tác (create/update/suspend/revoke/remove); property test random sequence mutation ⇒ `effective_perms_v2` == chiếu từ legacy `get_my_permissions()` (trừ mismatch được whitelist giải thích).
- **Direct JWT REST/RPC matrix:** JWT staff/owner/shareholder/orphan gọi trực tiếp 8 bảng RBAC ⇒ chỉ SELECT khi `is_super_admin()`, mọi DML client bị deny; gọi `effective_perms_v2`/`authorize_v2` trực tiếp ⇒ deny (permission denied for function).
- **Cross-org/foreign-resource tests:** trên hai organization thật (seed từ Sprint 1), admin RPC của org A không sửa được role/binding/scope/override của org B; composite FK `(organization_id,id)` chặn binding trỏ chéo org.
- **Concurrent/retry/rollback-injection tests:** hai admin đồng thời sửa cùng role/binding ⇒ CAS conflict, không lost update; bump `authorization_version` không mất tăng dưới concurrency (lock org row); inject failure sau ghi legacy trước ghi normalized ⇒ rollback toàn bộ (không nửa vời).
- **`npm run typecheck:baseline`:** phải không tăng lỗi so với `ts-baseline.txt`.
- **`npx tsc --noEmit -p tsconfig.app.json`:** xanh phần T2 chạm.
- **Related/full Vitest:** `npx vitest run` cho test RBAC/permission liên quan.
- **`npm run lint` / `npm run build`:** xanh.
- **`node scripts/check-definer-acl.mjs`:** mọi SECURITY DEFINER T2 thêm/sửa có ACL explicit, search_path pinned; baseline exposure không tăng.
- **`node scripts/check-view-invoker.mjs`:** chạy nếu T2 đụng VIEW (nếu shadow-compare dùng view).
- **Generated Supabase type drift:** regen `npm run gen:types` sau migration; `src/integrations/supabase/types.ts` không drift; thêm lại comment header.
- **Full money reconciliation:** `node scripts/reconcile-money.mjs` delta = 0 (T2 không đụng tiền — chứng minh không side effect).
- **Browser happy/edge/deny và console/network:** owner sửa quyền staff → staff thấy đúng quyền qua `get_my_permissions()`; suspend staff → deny; console/network sạch.
- **Reviewer verdict:** `<chưa có>`.

## 6. Canary và production gate

- **Canary organization/users:** `<chưa có — owner chốt>`.
- **Transaction count cap:** `0` (default).
- **VND cap:** `0` (default — T2 không đụng tiền; cap giữ 0 vẫn bắt buộc như gate).
- **Observation interval:** `<chưa có — tối thiểu một ngày làm việc theo dõi mismatch/deny/RPC error>`.
- **Expansion approval:** `<chưa có>`.
- **Old writer drain proof:** chứng minh không còn writer ghi thẳng `staff_assignments`/`roles` ngoài canonical RPC (inventory §3).
- **Exact revoke/policy/signature:** T2 **không** revoke DML domain nào (đó là T6/T7). Giữ `authorize_v2`/`effective_perms_v2` REVOKE khỏi client.

**Default nếu chưa được owner chốt: canary count = `0`, VND cap = `0`, flag = `OFF`, không apply/flip.**

## 7. Mandatory abort

Abort ngay khi có một trong các điều kiện:

- unauthorized hoặc cross-org success (admin org A sửa được RBAC org B; direct DML client vào bảng RBAC thành công);
- shadow parity xuất hiện mismatch **chưa giải thích** giữa `effective_perms_v2` và `get_my_permissions` sau dual-write;
- dual-write để lại trạng thái nửa legacy nửa normalized (orphan/split operation);
- `authorization_version` không bump hoặc bump mất tăng dưới concurrency;
- suspend/revoke không deny backend ngay, hoặc xóa nhầm identity/history;
- financial reconciliation delta khác 0 (bằng chứng side effect ngoài ý muốn);
- unexpected legacy writer ghi thẳng `staff_assignments`/`roles` ngoài canonical RPC;
- backup/object hash mismatch;
- canary happy path (owner sửa quyền) bị deny không giải thích;
- 3 RPC failure liên tiếp hoặc >1% trong 5 phút;
- p95 >2× baseline trong 10 phút;
- mất monitoring/backup/audit telemetry.

Khi abort: disable canary/flag, freeze mutation-quyền, giữ evidence; **không** xóa/sửa row lịch sử membership/override để rollback. Reconcile normalized↔legacy, forward-fix bằng override/binding + bump version.

## 8. Post-apply evidence

- **Apply start/end UTC:** `<chưa có>`.
- **Catalog/signature/grant pre/post diff:** grant 8 bảng RBAC + `permission_definitions` không đổi (SELECT super-only); `get_my_permissions`/`ai_copilot_perms_for` signature không đổi; `authorize_v2`/`effective_perms_v2` vẫn REVOKE client; RPC admin mới có ACL đúng.
- **Direct API deny/allow result:** JWT matrix §5 tái chạy sau apply.
- **Browser result:** owner sửa/suspend quyền → hiệu lực đúng qua path cũ; console/network sạch.
- **Reconciliation delta:** money delta = 0; RBAC count/hash legacy↔normalized parity.
- **Runtime error/latency/deny metrics:** RPC error, deny rate, p95 trong observation interval.
- **Hidden caller/legacy writer result:** không phát hiện writer thẳng `staff_assignments`/`roles` ngoài canonical RPC.
- **Observation completed at:** `<chưa có>`.
- **Final reviewer:** `<chưa có>`.
- **Final state (`APPLIED` hoặc `VERIFIED`):** giữ `APPLIED` cho tới khi vượt đủ observation + parity; chỉ `VERIFIED` khi zero unexplained mismatch, direct tests, browser, reconciliation, observation và evidence đầy đủ.
- **Tracker update commit:** cập nhật AUTHORIZATION-IMPLEMENTATION-STATUS.md hàng T2.

Evidence không được chứa credential, JWT, signed URL, private object path hoặc PII.

---

## Phụ lục A — Gap map (real code → đích T2)

| Chủ đề | Hiện trạng (đã đọc) | Gap phải đóng ở T2 |
|---|---|---|
| Source of truth | `get_my_permissions()` đọc legacy JSONB; normalized chưa là source of truth và chưa được frontend/RLS dùng, nhưng prototype approval RPC vẫn đọc `effective_perms_v2` (`20260713130200`). | Normalized thành source of truth; parity trước, cutover sau (T6). Không gọi model này hoàn toàn inert hoặc không có RPC consumer. |
| Mutation path | `useStaffAssignments.ts` ghi thẳng `staff_assignments.permissions`, **không** đụng normalized ⇒ drift sau materialize. | Canonical admin RPC dual-write legacy + normalized cùng transaction. |
| ALLOW/DENY | `role_permissions.effect` + `member_permission_overrides.effect` đã có; deny-wins trong `effective_perms_v2`/`authorize_v2`. | Đảm bảo admin RPC ghi đúng ALLOW/DENY; scoped override qua `member_override_scopes` (bảng có sẵn, materialization hiện chỉ tạo override unscoped). |
| Scoped override | `member_override_scopes` tồn tại nhưng `20260713110200` chỉ tạo override **unscoped** (comment: "legacy per-staff perms org-wide"). | Cho phép scoped override khi nghiệp vụ cần; evaluator match đúng scope mode (§11.5). |
| Version invalidation | `organizations.authorization_version` + `organization_roles.version` + `role_bindings.version` tồn tại nhưng **không routine nào bump**; không cache key. | Bump atomic cùng transaction; DTO/cache key `(user_id,org,version)`; invalidate sau commit (§11.7). |
| Lifecycle staff | `useRemoveStaffMember` → RPC `delete_staff_member` DELETE `auth.users` cascade; suspend chưa có deny-ngay chuẩn hóa. | Suspend/revoke deny backend ngay, giữ identity/history (§27.2 mục 8); dual-write hủy binding + bump version. |
| Shadow parity | `effective_perms_v2` shadow, chưa từng compare chính thức trên user thật; sprint2e đã vá lệch `shareholder_profit.view` cho joey/nathan. | Chạy full shadow-compare mọi user thật, zero unexplained mismatch (gate §27.6). |
| `__superadmin` sentinel | `get_my_permissions` trả `{"__superadmin":true}` cho super_admin + legacy_owner_allowlist; FE `can()` short-circuit true. | §11.7 muốn bỏ sentinel cho tenant owner — **out of scope T2**, chỉ ghi nhận cho T5/T6. |

## Phụ lục B — SQL intent review-only (chưa phải migration được duyệt)

> **PREPARATION ONLY / NO-GO:** các block dưới đây là nguồn để review contract, không phải migration được phép chạy. Không copy vào `supabase/migrations/`, không grant, không route, không apply production. Exact migration chỉ được tách từ source đã review sau preflight live catalog, disposable PostgreSQL/JWT/concurrency suite và gate recovery/owner. Mọi placeholder owner role/permission snapshot phải được thay bằng evidence exact-source; không dùng broad `db push`.

### B.1 Registry, system role và cashbook possession

```sql
begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated, service_role;

-- Registry mô tả cách resolver match scope/possession; default giữ tương thích
-- cho 208 key đã seed. cashbooks.post/manage_custody là exact CASHBOOK.
alter table public.permission_definitions
  add column if not exists scope_match_mode text not null default 'ANY_MATCH',
  add column if not exists requires_cashbook_possession boolean not null default false,
  add column if not exists accepted_possession_kinds text[] not null default array[]::text[];

alter table public.permission_definitions
  drop constraint if exists permission_definitions_scope_match_mode_check,
  add constraint permission_definitions_scope_match_mode_check
    check (scope_match_mode in ('ANY_MATCH','ALL_PRESENT')),
  drop constraint if exists permission_definitions_possession_contract_check,
  add constraint permission_definitions_possession_contract_check check (
    (not requires_cashbook_possession and cardinality(accepted_possession_kinds) = 0)
    or (
      requires_cashbook_possession
      and 'CASHBOOK' = any(scope_kinds)
      and cardinality(accepted_possession_kinds) > 0
      and accepted_possession_kinds <@ array['CUSTODIAN','OPERATOR']::text[]
    )
  );

insert into public.permission_definitions
  (key, resource, action, sensitivity, permission_domain, scope_kinds,
   is_active, scope_match_mode, requires_cashbook_possession,
   accepted_possession_kinds)
values
  ('cashbooks.manage_custody', 'cashbooks', 'manage_custody', 'ELEVATED',
   'TENANT', array['CASHBOOK']::text[], true, 'ANY_MATCH', true,
   array['CUSTODIAN']::text[])
on conflict (key) do update set
  resource = excluded.resource,
  action = excluded.action,
  sensitivity = excluded.sensitivity,
  permission_domain = excluded.permission_domain,
  scope_kinds = excluded.scope_kinds,
  is_active = excluded.is_active,
  scope_match_mode = excluded.scope_match_mode,
  requires_cashbook_possession = excluded.requires_cashbook_possession,
  accepted_possession_kinds = excluded.accepted_possession_kinds;

update public.permission_definitions
   set scope_kinds = array['ORGANIZATION']::text[],
       scope_match_mode = 'ANY_MATCH',
       requires_cashbook_possession = false,
       accepted_possession_kinds = array[]::text[]
 where key = 'cashbooks.create';

update public.permission_definitions
   set scope_kinds = array['CASHBOOK']::text[],
       scope_match_mode = 'ANY_MATCH',
       requires_cashbook_possession = true,
       accepted_possession_kinds = array['CUSTODIAN','OPERATOR']::text[]
 where key = 'cashbooks.post';

-- Tenant role không được nhận key PLATFORM chỉ vì FK registry cho phép.
do $tenant_role_permission_preflight$
begin
  if exists (
    select 1
      from public.role_permissions rp
      join public.permission_definitions pd on pd.key = rp.permission_key
     where pd.permission_domain <> 'TENANT'
  ) then
    raise exception 'T2 preflight: tenant role contains PLATFORM permission'
      using errcode = '23514';
  end if;
end;
$tenant_role_permission_preflight$;

create or replace function app_private.guard_tenant_role_permission_domain()
returns trigger
language plpgsql
security invoker
set search_path to 'pg_catalog', 'public'
as $fn$
begin
  if not exists (
    select 1
      from public.permission_definitions pd
     where pd.key = new.permission_key
       and pd.permission_domain = 'TENANT'
  ) then
    raise exception 'tenant organization role cannot receive platform permission'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists a00_guard_tenant_role_permission_domain
  on public.role_permissions;
create trigger a00_guard_tenant_role_permission_domain
before insert or update of permission_key on public.role_permissions
for each row execute function app_private.guard_tenant_role_permission_domain();
alter table public.role_permissions
  enable always trigger a00_guard_tenant_role_permission_domain;

-- Stable semantic identity; display name không tham gia authorization.
alter table public.organization_roles
  add column if not exists system_key text,
  add column if not exists status text not null default 'ACTIVE';

alter table public.organization_roles
  drop constraint if exists organization_roles_status_check,
  add constraint organization_roles_status_check
    check (status in ('ACTIVE','RETIRED')),
  drop constraint if exists organization_roles_system_key_check,
  add constraint organization_roles_system_key_check check (
    system_key is null
    or (is_system and system_key ~ '^[A-Z][A-Z0-9_]{2,63}$')
  );

create unique index if not exists organization_roles_system_key_uidx
  on public.organization_roles (organization_id, system_key)
  where system_key is not null;

-- Live có nhiều open legacy binding cùng membership/role do từng building/area
-- assignment. Chỉ canonical nonlegacy binding mới được unique theo role.
create unique index if not exists role_bindings_one_open_canonical_role_uidx
  on public.role_bindings (organization_id, membership_id, role_id)
  where legacy_assignment_id is null and valid_to is null;

-- Shape hiện tại chỉ cho một parent override/(member,key), nên không biểu diễn
-- đồng thời scoped ALLOW A + scoped DENY B. Forward DDL thay index trước resolver.
alter table public.member_permission_overrides
  add column if not exists scope_mode text not null default 'ORGANIZATION';

alter table public.member_permission_overrides
  drop constraint if exists member_permission_overrides_scope_mode_check,
  add constraint member_permission_overrides_scope_mode_check
    check (scope_mode in ('ORGANIZATION','SCOPED'));

drop index if exists public.member_overrides_unique_uidx;
create unique index if not exists member_overrides_effect_scope_mode_uidx
  on public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, scope_mode);

-- Canonical mutation RPC/deferred invariant phải bảo đảm parent ORGANIZATION có
-- đúng organization edge; parent SCOPED có >=1 edge, mọi edge thuộc scope kind
-- registry cho phép, và không tạo hai parent cùng effect/mode chồng scope.
--
-- REVIEW 2026-07-17 (adversarial, 5 defect xác nhận) — shape trên CHƯA đủ:
-- (a) Index full (không partial) mâu thuẫn lifecycle append-only: sau khi một
--     scoped ALLOW hết hạn, row chết chiếm slot vĩnh viễn → grant→revoke→
--     re-grant vi phạm unique. Sửa: thêm cột `revoked_at timestamptz`, index
--     đổi thành partial `WHERE revoked_at IS NULL`; mutation = close-then-insert
--     (set revoked_at + insert row mới), không ON CONFLICT DO UPDATE; reap
--     expired row (expires_at <= now) trước insert vào cùng slot.
-- (b) `scope_mode` hiện chỉ là uniqueness metadata — không constraint nào ràng
--     nó với edges và resolver không đọc nó. Bắt buộc: deferrable constraint
--     trigger (INITIALLY DEFERRED) enforce tại commit: ORGANIZATION ⇒ đúng 1
--     edge scope_type='ORGANIZATION'; SCOPED ⇒ ≥1 edge, mọi edge <> ORGANIZATION;
--     mọi edge scope_type ∈ scope_kinds của key. Diệt zero-edge parent,
--     mislabeled mode và duplicate witness ORG-edge-under-SCOPED.
-- (c) Edge không mang expires_at/reason/created_by — một parent/effect/mode
--     ép mọi scope chung lifetime/provenance. Quyết định NGAY: hoặc chấp nhận
--     giới hạn "một lifetime per (effect,mode)" ghi vào contract, hoặc chuyển
--     expires_at/reason xuống edge — không để lộ ra ở T5.
-- (d) Writers cũ upsert theo key cũ `(org,membership,permission_key)`
--     (20260713110200:81, 20260713110400:23) — sau khi swap index, các ON
--     CONFLICT target đó không còn tồn tại; mọi re-run/repair sẽ error. Exact
--     migration phải rewrite các seed đó hoặc ghi rõ chúng frozen-historical.
-- (e) (ORG,ALLOW)+(ORG,DENY) đồng thời cho một key là hợp lệ (deny-wins, dùng
--     cho suspension tạm) — ghi là intentional; RPC yêu cầu flag/reason khi tạo
--     effect thứ hai.

-- Permission scope và business custody là hai witness độc lập.
create table if not exists public.cashbook_possession_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  cashbook_id uuid not null,
  membership_id uuid not null,
  possession_kind text not null
    check (possession_kind in ('CUSTODIAN','OPERATOR')),
  valid_from timestamptz not null default clock_timestamp(),
  valid_to timestamptz,
  version bigint not null default 1 check (version > 0),
  granted_by uuid,
  reason text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (organization_id, id),
  foreign key (organization_id, cashbook_id)
    references public.accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, membership_id)
    references public.organization_memberships(organization_id, id)
      on delete restrict,
  check (valid_to is null or valid_to > valid_from)
);

create unique index if not exists cashbook_possession_one_open_kind_uidx
  on public.cashbook_possession_bindings
    (organization_id, cashbook_id, membership_id, possession_kind)
  where valid_to is null;

create index if not exists cashbook_possession_resolver_idx
  on public.cashbook_possession_bindings
    (organization_id, membership_id, cashbook_id, valid_from, valid_to);

-- Legacy account owner/share chỉ tạo candidate; tuyệt đối không insert thẳng vào
-- cashbook_possession_bindings. candidate_key/evidence phải deterministic và đã
-- secret/PII-sanitize trước khi ghi.
create table if not exists app_private.cashbook_possession_candidates (
  id uuid primary key default gen_random_uuid(),
  candidate_key text not null unique,
  organization_id uuid not null references public.organizations(id)
    on delete restrict,
  cashbook_id uuid not null,
  membership_id uuid,
  proposed_kind text not null
    check (proposed_kind in ('CUSTODIAN','OPERATOR')),
  source_kind text not null
    check (source_kind in ('ACCOUNT_OWNER','LEGACY_SHARE')),
  source_relation text not null,
  source_row_id uuid not null,
  source_user_id uuid not null,
  status text not null default 'PENDING_REVIEW'
    check (status in ('PENDING_REVIEW','APPROVED','REJECTED','AMBIGUOUS')),
  evidence jsonb not null default '{}'::jsonb,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, cashbook_id)
    references public.accounts(organization_id, id) on delete restrict,
  foreign key (organization_id, membership_id)
    references public.organization_memberships(organization_id, id)
      on delete restrict,
  check (
    (status = 'PENDING_REVIEW' and reviewed_at is null)
    or (status <> 'PENDING_REVIEW' and reviewed_at is not null
        and review_reason is not null)
  )
);

-- Emergency deny là organization/permission wide; không phải platform-owner
-- shortcut. Mutation phải lock organization FOR UPDATE trước.
create table if not exists app_private.tenant_emergency_denies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id)
    on delete restrict,
  permission_key text references public.permission_definitions(key)
    on delete restrict,
  active_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  reason text not null,
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at is null or expires_at > active_from)
);

create index if not exists tenant_emergency_denies_active_idx
  on app_private.tenant_emergency_denies
    (organization_id, permission_key, active_from, expires_at);

revoke all on public.cashbook_possession_bindings
  from public, anon, authenticated, service_role;
revoke all on app_private.cashbook_possession_candidates,
  app_private.tenant_emergency_denies
  from public, anon, authenticated, service_role;

commit;
```

### B.2 Backfill fail-closed cho scope, `TENANT_OWNER` và witness graph

```sql
begin;

-- Preflight phải abort thay vì gán mù org. Exact migration ghi exception rows
-- sanitized rồi dừng nếu còn account/area/building mapping NULL hoặc cross-org.
do $preflight$
begin
  if exists (
    select 1 from public.accounts a where a.organization_id is null
  ) then
    raise exception 'T2 preflight: account organization unresolved'
      using errcode = '23514';
  end if;
  if exists (
    select 1
      from public.account_shared_users asu
      left join public.accounts a on a.id = asu.account_id
     where asu.organization_id is null
        or a.id is null
        or asu.organization_id is distinct from a.organization_id
  ) then
    raise exception 'T2 preflight: cashbook share organization unresolved/mismatched'
      using errcode = '23514';
  end if;
  if exists (
    select 1
      from public.area_buildings ab
      join public.areas a on a.id = ab.area_id
      join public.buildings b on b.id = ab.building_id
     where ab.organization_id is null
        or ab.organization_id is distinct from a.organization_id
        or ab.organization_id is distinct from b.organization_id
  ) then
    raise exception 'T2 preflight: area/building organization mismatch'
      using errcode = '23514';
  end if;
end;
$preflight$;

insert into public.authorization_scopes
  (organization_id, scope_type, cashbook_id)
select a.organization_id, 'CASHBOOK', a.id
  from public.accounts a
 where a.organization_id is not null
on conflict do nothing;

-- Existing unscoped legacy overrides are made explicitly ORGANIZATION-scoped;
-- after this step an override with zero scope edges is not an authorization witness.
update public.member_permission_overrides
   set scope_mode = 'ORGANIZATION'
 where scope_mode is distinct from 'ORGANIZATION'
   and not exists (
     select 1 from public.member_override_scopes mos
      where mos.override_id = member_permission_overrides.id
   );

insert into public.member_override_scopes
  (organization_id, override_id, scope_id)
select o.organization_id, o.id, s.id
  from public.member_permission_overrides o
  join public.authorization_scopes s
    on s.organization_id = o.organization_id
   and s.scope_type = 'ORGANIZATION'
 where o.scope_mode = 'ORGANIZATION'
   and not exists (
     select 1 from public.member_override_scopes mos
      where mos.override_id = o.id
   )
on conflict do nothing;

-- Precheck display-name collision vì partial system_key conflict target không bắt
-- unique (organization_id, lower(name)). Không repurpose role legacy theo tên.
do $tenant_owner_name_preflight$
begin
  if exists (
    select 1
      from public.organization_roles r
     where lower(r.name) = lower('Chủ sở hữu tổ chức')
       and r.system_key is distinct from 'TENANT_OWNER'
  ) then
    raise exception 'T2 preflight: TENANT_OWNER display name collides'
      using errcode = '23505';
  end if;
end;
$tenant_owner_name_preflight$;

insert into public.organization_roles
  (organization_id, name, is_system, system_key, status)
select o.id, 'Chủ sở hữu tổ chức', true, 'TENANT_OWNER', 'ACTIVE'
  from public.organizations o
on conflict (organization_id, system_key)
  where system_key is not null do nothing;

-- Exact reviewed allowlist; tuyệt đối không SELECT mọi TENANT permission vì key
-- mới về sau không được tự cấp cho owner chỉ do registry insert.
--
-- REVIEW 2026-07-17 — defect/gap xác nhận trên allowlist + shape:
-- (a) SILENT-NARROWING: CTE `verified` join registry và insert những gì sống
--     sót — typo/thiếu seed/is_active=false làm grant co lại IM LẶNG. Exact
--     migration BẮT BUỘC: assert sha256(string_agg(key, e'\n' ORDER BY key))
--     + count khớp literal đã review, và RAISE nếu verified_count <>
--     reviewed_count (liệt kê key thiếu). Không bao giờ insert subset.
-- (b) `cashbooks.manage_custody` CHƯA có trong live registry (chỉ B.1 review-
--     only seed nó) — nếu B.1 chưa applied, CTE sẽ drop nó im lặng (11/12).
--     B.1 phải APPLIED + hash-recorded TRƯỚC B.2, encode bằng preflight check
--     (column/key exists), không phải convention.
-- (c) THIẾU key theo contract: `thu_tien.collect` (T1b thay invoices.edit —
--     owner không có nó sẽ KHÔNG thu được tiền hóa đơn sau T1b; thêm hoặc ghi
--     deferral tường minh bind vào T1b); users lifecycle (suspend/revoke/remove
--     — quyết định tường minh có/không `users.delete`); mapping key cho
--     withdraw/cancel của T3 chưa chốt — không hash-freeze allowlist khi
--     contract tiêu thụ chưa chốt.
-- (d) Allowlist này CHỈ cho elevated v3 resolver domain thu-chi/cashbook —
--     không phải full owner permission set; T6 cutover cần reviewed owner set
--     riêng (nếu không sẽ brick owner UI khi flip get_my_permissions).
-- (e) `approvals.emergency_override` là standing ALLOW → runtime controls của
--     T3 (owner-là-maker không né force-approval, reason≥20, re-auth, alert
--     tần suất) trở thành load-bearing và phải nằm trong gate tests.
-- (f) Backfill là one-shot: org/cashbook/OWNER-membership mới sau backfill
--     không tự có role/edge/binding — canonical lifecycle RPC phải live trước
--     khi bất kỳ enforcement nào đọc normalized; backfill cũng phải bump
--     authorization_version (prototype còn đọc effective_perms_v2).
with reviewed_owner_permissions(permission_key) as (
  values
    ('income_expenses.create'::text),
    ('income_expenses.edit'::text),
    ('income_expenses.approve'::text),
    ('income_expenses.cancel'::text),
    ('income_expenses.self_approve_within_limit'::text),
    ('income_expenses.reverse'::text),
    ('cashbooks.create'::text),
    ('cashbooks.post'::text),
    ('cashbooks.manage_custody'::text),
    ('approvals.emergency_override'::text),
    ('users.create'::text),
    ('users.edit'::text)
), verified as (
  select p.permission_key
    from reviewed_owner_permissions p
    join public.permission_definitions pd
      on pd.key = p.permission_key
     and pd.permission_domain = 'TENANT'
     and pd.is_active
)
insert into public.role_permissions
  (organization_id, role_id, permission_key, effect)
select r.organization_id, r.id, p.permission_key, 'ALLOW'
  from public.organization_roles r
  cross join verified p
 where r.system_key = 'TENANT_OWNER'
   and r.status = 'ACTIVE'
on conflict (organization_id, role_id, permission_key) do nothing;

-- Exact migration phải assert reviewed allowlist count/hash trước INSERT; danh sách
-- trên còn là design allowlist, chưa phải owner-approved release identity.

insert into public.role_bindings
  (organization_id, membership_id, role_id, valid_from, valid_to)
select m.organization_id, m.id, r.id, m.valid_from, m.valid_to
  from public.organization_memberships m
  join public.organization_roles r
    on r.organization_id = m.organization_id
   and r.system_key = 'TENANT_OWNER'
   and r.status = 'ACTIVE'
 where m.member_type = 'OWNER'
   and m.status = 'ACTIVE'
   -- KHÔNG filter valid_from/valid_to tại thời điểm seed: copy nguyên window
   -- membership để membership OWNER future-activation vẫn có binding chờ sẵn;
   -- resolver temporal predicates + boundaries xử lý activation (nếu filter ở
   -- đây, owner active tương lai sẽ deny vô hạn mà không có activation deadline).
   and not exists (
     -- Rerun-idempotent theo WINDOW-OVERLAP, không theo "active now": binding
     -- copy nguyên [m.valid_from, m.valid_to) — gồm cả future-activation và
     -- finite valid_to — nên điều kiện loại trừ phải là "đã tồn tại nonlegacy
     -- binding cùng (org, membership, role) có window giao với window membership".
     -- Nếu chỉ loại trừ open (valid_to IS NULL) hoặc active-now, membership
     -- finite/future sẽ bị seed trùng mỗi lần rerun (partial unique index chỉ
     -- phủ open bindings, không chặn duplicate finite/future).
     select 1
       from public.role_bindings rb
      where rb.organization_id = m.organization_id
        and rb.membership_id = m.id
        and rb.role_id = r.id
        and rb.legacy_assignment_id is null
        and rb.valid_from < coalesce(m.valid_to, 'infinity'::timestamptz)
        and coalesce(rb.valid_to, 'infinity'::timestamptz) > m.valid_from
   );

-- Tenant capability thông thường nhận ORGANIZATION scope. Exact CASHBOOK permission
-- cần edge CASHBOOK riêng; edge vẫn chưa đủ post nếu thiếu active possession.
insert into public.role_binding_scopes
  (organization_id, role_binding_id, scope_id)
select rb.organization_id, rb.id, s.id
  from public.role_bindings rb
  join public.organization_roles r
    on r.organization_id = rb.organization_id and r.id = rb.role_id
  join public.authorization_scopes s
    on s.organization_id = rb.organization_id
   and s.scope_type in ('ORGANIZATION','CASHBOOK')
 where r.system_key = 'TENANT_OWNER'
   and rb.legacy_assignment_id is null
on conflict do nothing;

-- Legacy owner/share chỉ sinh candidate snapshot; không FK vào source row vì
-- account_shared_users bị DELETE/CASCADE. Evidence giữ source_row_id dạng UUID.
insert into app_private.cashbook_possession_candidates (
  candidate_key, organization_id, cashbook_id, membership_id,
  proposed_kind, source_kind, source_relation, source_row_id, source_user_id,
  status, evidence
)
select
  md5(concat_ws('|','ACCOUNT_OWNER',a.organization_id::text,a.id::text,a.user_id::text)),
  a.organization_id, a.id, m.id,
  'CUSTODIAN', 'ACCOUNT_OWNER', 'accounts', a.id, a.user_id,
  'PENDING_REVIEW',
  jsonb_build_object('captured_at',clock_timestamp())
from public.accounts a
join public.organization_memberships m
  on m.organization_id = a.organization_id
 and m.user_id = a.user_id
 and m.status = 'ACTIVE'
where a.deleted_at is null
on conflict (candidate_key) do nothing;

insert into app_private.cashbook_possession_candidates (
  candidate_key, organization_id, cashbook_id, membership_id,
  proposed_kind, source_kind, source_relation, source_row_id, source_user_id,
  status, evidence
)
select
  md5(concat_ws('|','LEGACY_SHARE',asu.organization_id::text,
    asu.account_id::text,asu.id::text,asu.user_id::text)),
  asu.organization_id, asu.account_id, m.id,
  'OPERATOR', 'LEGACY_SHARE', 'account_shared_users', asu.id, asu.user_id,
  'PENDING_REVIEW',
  jsonb_build_object('captured_at',clock_timestamp())
from public.account_shared_users asu
join public.accounts a
  on a.organization_id = asu.organization_id
 and a.id = asu.account_id
 and a.deleted_at is null
join public.organization_memberships m
  on m.organization_id = asu.organization_id
 and m.user_id = asu.user_id
 and m.status = 'ACTIVE'
on conflict (candidate_key) do nothing;

-- Không block nào chuyển candidate thành active possession. Review APPROVED phải
-- qua canonical RPC, lock organization, kiểm mapping còn hiệu lực, append audit,
-- materialize possession và bump authorization_version đúng một lần.

commit;
```

**Defects B.1/B.2 xác nhận bởi vòng review 2026-07-17 (sửa trước khi tách migration):**

1. *(rerun fail-open)* Block UPDATE chuyển `scope_mode='SCOPED'` zero-edge → `'ORGANIZATION'` là dead-code lần đầu nhưng nguy hiểm khi rerun sau khi canonical RPC tồn tại: SCOPED ALLOW transient zero-edge bị promote org-wide im lặng. Giới hạn UPDATE vào legacy rows (theo reason/created_at) hoặc RAISE thay vì convert.
2. *(silent no-op)* B.2 giả định mọi org có row `authorization_scopes` ORGANIZATION — chỉ đúng cho org tồn tại lúc sprint2c. Org mới hơn: override không edge (DENY biến mất), TENANT_OWNER binding không org edge (owner denied). Preflight phải assert coverage hoặc re-insert ORGANIZATION scope cho mọi org trước backfill.
3. *(intent mismatch)* Materialize CASHBOOK scope hiện KHÔNG filter `accounts.deleted_at` — trái với "mỗi live accounts row" ở §4.1; thêm filter hoặc ghi tường minh scope cho account archive.
4. *(hardening)* `cashbook_possession_bindings` là bảng public không có `ENABLE ROW LEVEL SECURITY` — khác mọi bảng RBAC sprint2a; bảo vệ hiện chỉ bằng grants. Bật RLS + policy super-only SELECT như sibling.
5. *(doc overstatement)* B.3 chỉ FOR SHARE row `organizations` — KHÔNG lock witness graph (locking clause không áp cho CTE/join phụ). Diễn đạt §4.1 "FOR SHARE đúng witness graph" phải sửa lại: correctness dựa hoàn toàn vào protocol B.4 (mọi witness mutation lấy org FOR UPDATE trước).
6. *(guard RLS)* `guard_tenant_role_permission_domain` SECURITY INVOKER đọc `permission_definitions` có RLS super-only — writer không phải owner sẽ thấy 0 row → 42501 misleading (fail-closed nhưng sai thông điệp). Ghi assumption "mọi writer là owner-context" hoặc đọc qua path owner-safe.
7. *(coverage)* Domain guard chỉ trên `role_permissions`; flip `permission_definitions.permission_domain` hoặc insert PLATFORM key vào `member_permission_overrides` bypass invariant (resolver filter TENANT giữ fail-closed nhưng registry invariant hở).
8. *(ledger ordering)* `CREATE SCHEMA app_private` hiện chỉ có trong B.1; artifact T5 `20260716180000` tham chiếu `app_private` nhưng timestamp SỚM HƠN migration T2 tương lai → naive full replay fail. Exact T2 migration phải tự chứa `CREATE SCHEMA IF NOT EXISTS app_private` hoặc ghi rõ hazard ordering.
9. *(legacy arbiter)* Drop `member_overrides_unique_uidx` vô hiệu ON CONFLICT target của `20260713110200:81`/`20260713110400:23` cho mọi re-run/repair sau này — ghi rõ frozen-historical hoặc rewrite khi tách migration.

### B.3 Resolver v3: một statement, DENY precedence, organization-first lock

```sql
create or replace function app_private.authorize_tenant_action_v3(
  p_actor uuid,
  p_organization_id uuid,
  p_permission_key text,
  p_building_id uuid default null,
  p_cashbook_id uuid default null
) returns table (
  allowed boolean,
  authorization_version bigint,
  nearest_deadline timestamptz,
  decision_reason text
)
language sql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
with
at as materialized (
  select clock_timestamp() as evaluated_at
),
-- FOR SHARE phải được writer giữ trong cùng transaction từ decision cuối đến
-- effect. Mọi canonical auth mutation lấy cùng organization FOR UPDATE trước.
locked_org as materialized (
  select o.id, o.authorization_version
    from public.organizations o, at
   where o.id = p_organization_id
     and o.status = 'ACTIVE'
   for share
),
permission as materialized (
  select pd.*
    from public.permission_definitions pd
    join locked_org lo on true
   where pd.key = p_permission_key
     and pd.permission_domain = 'TENANT'
     and pd.is_active
),
membership as materialized (
  select m.*
    from public.organization_memberships m
    join locked_org lo on lo.id = m.organization_id
    cross join at
   where m.user_id = p_actor
     and m.status = 'ACTIVE'
     and m.valid_from <= at.evaluated_at
     and (m.valid_to is null or m.valid_to > at.evaluated_at)
),
target as materialized (
  select
    (p_building_id is null or exists (
       select 1 from public.buildings b
        where b.id = p_building_id
          and b.organization_id = p_organization_id
     ))
    and
    (p_cashbook_id is null or exists (
       select 1 from public.accounts a
        where a.id = p_cashbook_id
          and a.organization_id = p_organization_id
          and a.deleted_at is null
     )) as valid
),
member_statements as materialized (
  select distinct o.effect, o.expires_at
    from membership m
    join public.member_permission_overrides o
      on o.organization_id = m.organization_id
     and o.membership_id = m.id
     and o.permission_key = p_permission_key
    join public.member_override_scopes mos
      on mos.organization_id = o.organization_id
     and mos.override_id = o.id
    join public.authorization_scopes s
      on s.organization_id = mos.organization_id
     and s.id = mos.scope_id
    join permission pd on s.scope_type = any(pd.scope_kinds)
    cross join at
   where (o.expires_at is null or o.expires_at > at.evaluated_at)
     and (
       (pd.requires_cashbook_possession
         and p_cashbook_id is not null
         and s.scope_type = 'CASHBOOK'
         and s.cashbook_id = p_cashbook_id)
       or
       (not pd.requires_cashbook_possession and (
         (s.scope_type = 'ORGANIZATION'
           and p_building_id is null and p_cashbook_id is null)
         or (s.scope_type = 'ORGANIZATION'
           and (p_building_id is not null or p_cashbook_id is not null))
         or (s.scope_type = 'BUILDING'
           and s.building_id = p_building_id)
         or (s.scope_type = 'AREA' and p_building_id is not null and exists (
           select 1 from public.area_buildings ab
            where ab.organization_id = p_organization_id
              and ab.area_id = s.area_id
              and ab.building_id = p_building_id
         ))
         or (s.scope_type = 'CASHBOOK'
           and s.cashbook_id = p_cashbook_id)
       ))
     )
),
role_statements as materialized (
  select distinct rp.effect, rb.valid_from, rb.valid_to
    from membership m
    join public.role_bindings rb
      on rb.organization_id = m.organization_id
     and rb.membership_id = m.id
    join public.organization_roles r
      on r.organization_id = rb.organization_id
     and r.id = rb.role_id
     and r.status = 'ACTIVE'
    join public.role_permissions rp
      on rp.organization_id = rb.organization_id
     and rp.role_id = rb.role_id
     and rp.permission_key = p_permission_key
    join public.role_binding_scopes rbs
      on rbs.organization_id = rb.organization_id
     and rbs.role_binding_id = rb.id
    join public.authorization_scopes s
      on s.organization_id = rbs.organization_id
     and s.id = rbs.scope_id
    join permission pd on s.scope_type = any(pd.scope_kinds)
    cross join at
   where rb.valid_from <= at.evaluated_at
     and (rb.valid_to is null or rb.valid_to > at.evaluated_at)
     and (
       (pd.requires_cashbook_possession
         and p_cashbook_id is not null
         and s.scope_type = 'CASHBOOK'
         and s.cashbook_id = p_cashbook_id)
       or
       (not pd.requires_cashbook_possession and (
         (s.scope_type = 'ORGANIZATION'
           and p_building_id is null and p_cashbook_id is null)
         or (s.scope_type = 'ORGANIZATION'
           and (p_building_id is not null or p_cashbook_id is not null))
         or (s.scope_type = 'BUILDING'
           and s.building_id = p_building_id)
         or (s.scope_type = 'AREA' and p_building_id is not null and exists (
           select 1 from public.area_buildings ab
            where ab.organization_id = p_organization_id
              and ab.area_id = s.area_id
              and ab.building_id = p_building_id
         ))
         or (s.scope_type = 'CASHBOOK'
           and s.cashbook_id = p_cashbook_id)
       ))
     )
),
emergency as materialized (
  select exists (
    select 1
      from app_private.tenant_emergency_denies d
      join locked_org lo on lo.id = d.organization_id
      cross join at
     where (d.permission_key is null or d.permission_key = p_permission_key)
       and d.active_from <= at.evaluated_at
       and (d.expires_at is null or d.expires_at > at.evaluated_at)
  ) as denied
),
possession as materialized (
  select
    case
      when not coalesce((select requires_cashbook_possession from permission), false)
        then true
      when p_cashbook_id is null then false
      else exists (
        select 1
          from public.cashbook_possession_bindings cp
          join membership m
            on m.organization_id = cp.organization_id
           and m.id = cp.membership_id
          join permission pd
            on cp.possession_kind = any(pd.accepted_possession_kinds)
          cross join at
         where cp.cashbook_id = p_cashbook_id
           and cp.valid_from <= at.evaluated_at
           and (cp.valid_to is null or cp.valid_to > at.evaluated_at)
      )
    end as accepted
),
boundaries as materialized (
  select min(x.boundary) as nearest_deadline
    from (
      -- Membership activation cũng phải invalidate cached deny; không chỉ expiry.
      select m0.valid_from as boundary
        from public.organization_memberships m0
       where m0.organization_id = p_organization_id
         and m0.user_id = p_actor
      union all
      select m0.valid_to
        from public.organization_memberships m0
       where m0.organization_id = p_organization_id
         and m0.user_id = p_actor
      union all
      select rb.valid_from
        from public.role_bindings rb
        join public.organization_memberships m0
          on m0.organization_id = rb.organization_id
         and m0.id = rb.membership_id
       where m0.user_id = p_actor
         and rb.organization_id = p_organization_id
      union all
      select rb.valid_to
        from public.role_bindings rb
        join public.organization_memberships m0
          on m0.organization_id = rb.organization_id
         and m0.id = rb.membership_id
       where m0.user_id = p_actor
         and rb.organization_id = p_organization_id
      union all
      select o.expires_at
        from public.member_permission_overrides o
        join public.organization_memberships m0
          on m0.organization_id = o.organization_id
         and m0.id = o.membership_id
       where m0.user_id = p_actor
         and o.organization_id = p_organization_id
         and o.permission_key = p_permission_key
      union all
      select cp.valid_from
        from public.cashbook_possession_bindings cp
        join public.organization_memberships m0
          on m0.organization_id = cp.organization_id
         and m0.id = cp.membership_id
       where m0.user_id = p_actor
         and cp.organization_id = p_organization_id
         and cp.cashbook_id = p_cashbook_id
      union all
      select cp.valid_to
        from public.cashbook_possession_bindings cp
        join public.organization_memberships m0
          on m0.organization_id = cp.organization_id
         and m0.id = cp.membership_id
       where m0.user_id = p_actor
         and cp.organization_id = p_organization_id
         and cp.cashbook_id = p_cashbook_id
      union all
      select d.active_from from app_private.tenant_emergency_denies d
       where d.organization_id = p_organization_id
         and (d.permission_key is null or d.permission_key = p_permission_key)
      union all
      select d.expires_at from app_private.tenant_emergency_denies d
       where d.organization_id = p_organization_id
         and (d.permission_key is null or d.permission_key = p_permission_key)
    ) x, at
   where x.boundary > at.evaluated_at
),
facts as materialized (
  select
    exists (select 1 from member_statements where effect = 'DENY') as member_deny,
    exists (select 1 from role_statements where effect = 'DENY') as role_deny,
    exists (select 1 from member_statements where effect = 'ALLOW') as member_allow,
    exists (select 1 from role_statements where effect = 'ALLOW') as role_allow
)
select
  case
    when not exists (select 1 from locked_org) then false
    when not exists (select 1 from permission) then false
    when not exists (select 1 from membership) then false
    when not coalesce((select valid from target), false) then false
    when (select denied from emergency) then false
    when facts.member_deny then false
    when facts.role_deny then false
    when not (select accepted from possession) then false
    when facts.member_allow then true
    when facts.role_allow then true
    else false
  end as allowed,
  (select authorization_version from locked_org),
  (select nearest_deadline from boundaries),
  case
    when not exists (select 1 from locked_org) then 'ORGANIZATION_INACTIVE_OR_MISSING'
    when not exists (select 1 from permission) then 'PERMISSION_INACTIVE_OR_MISSING'
    when not exists (select 1 from membership) then 'MEMBERSHIP_INACTIVE_OR_MISSING'
    when not coalesce((select valid from target), false) then 'TARGET_CROSS_ORG_OR_MISSING'
    when (select denied from emergency) then 'EMERGENCY_DENY'
    when facts.member_deny then 'MEMBER_DENY'
    when facts.role_deny then 'ROLE_DENY'
    when not (select accepted from possession) then 'POSSESSION_MISSING'
    when facts.member_allow then 'MEMBER_ALLOW'
    when facts.role_allow then 'ROLE_ALLOW'
    else 'DEFAULT_DENY'
  end as decision_reason
from facts;
$fn$;

revoke all on function app_private.authorize_tenant_action_v3(
  uuid, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;
```

**Known defects đã xác nhận trong resolver trên (PHẢI sửa trước khi tách migration/compile — hợp nhất từ vòng review 40-luồng 2026-07-17):**

1. **`scope_mode='ORGANIZATION'` override bị drop:** `member_statements` inner-join `member_override_scopes`, nhưng mọi override legacy materialized (`20260713110200`) là unscoped — không có edge row. Kết quả: member ALLOW **và member DENY** org-wide biến mất khỏi witness set; DENY không được enforce. Sửa: branch theo `scope_mode` — `ORGANIZATION` mode match org-wide không cần edge; `SCOPED` mode mới join qua edges. Hard gate: B.2 backfill edges phải chạy TRƯỚC khi B.3 được exercise, và deferred invariant "open override phải có đúng edge theo scope_mode" phải schema-enforced (không chỉ RPC discipline). Resolver phải fail hard (không silently drop) khi gặp open override zero-edge — zero-edge DENY im lặng là fail-open.
2. **DENY match quá hẹp cho permission cần possession:** với `requires_cashbook_possession=true`, cả ALLOW lẫn DENY hiện chỉ match edge `CASHBOOK = p_cashbook_id`. Một DENY ở scope ORGANIZATION/BUILDING/AREA phủ target sẽ bị bỏ qua → không chặn được posting; org-wide DENY cho possession key hiện **không biểu diễn được**. Sửa: tách match rule — **DENY match rộng** (scope phủ target là đủ, gồm ORGANIZATION-mode); **ALLOW cho possession-required key vẫn phải có edge CASHBOOK đúng target**. Cần tách `member_deny/member_allow` và `role_deny/role_allow` thành các CTE có điều kiện match riêng.
3. **Version/witness snapshot skew (HIGH):** `FOR SHARE` organizations nằm trong CÙNG statement với witness evaluation. Dưới READ COMMITTED, nếu resolver block trên org lock trong khi canonical mutation commit, EvalPlanQual re-read org row → trả `authorization_version` MỚI nhưng witness CTEs vẫn đọc snapshot CŨ: witness vừa bị revoke vẫn cho ALLOW gắn version mới → poison cache. Sửa: writer lấy org `FOR SHARE` ở statement TRƯỚC, rồi mới chạy witness statement (snapshot mới sau lock); hoặc re-read `authorization_version` sau evaluation và retry khi mismatch.
4. **Omitted-dimension bypass (HIGH):** không có required-dimension enforcement — caller truyền `p_building_id=NULL` cho key cần building sẽ được ORGANIZATION-scope ALLOW match trong khi BUILDING/AREA-scoped DENY không thể match (`s.building_id = NULL` fail). "Cần building" hiện chỉ là caller discipline. Sửa: thêm registry metadata `required_dimensions text[]` và deny khi dimension bắt buộc NULL (mirror `requires_cashbook_possession` ép `p_cashbook_id`).
5. **NULL `valid_from` drop witness:** `role_bindings.valid_from` nullable (CHECK live tolerate NULL); điều kiện `rb.valid_from <= evaluated_at` làm binding NULL-valid_from — kể cả DENY — biến mất. Sửa: backfill + `SET NOT NULL`, hoặc treat NULL = always-active ở cả allow lẫn deny.
6. **`ALL_PRESENT` chỉ chặn lúc migration:** preflight abort không ngăn registry UPDATE sau này. Thêm `CHECK (scope_match_mode = 'ANY_MATCH')` cho tới khi implement.
7. **Possession coalesce mỏng manh:** `not coalesce((select requires_cashbook_possession from permission), false)` trả `accepted=true` khi permission CTE rỗng — chỉ CASE ordering che. Sửa: possession fail-closed độc lập khi permission missing.
8. **Boundaries over-broad (LOW, availability-only):** các arm role_bindings/override/possession chưa filter `p_organization_id` (đã vá một phần ở SQL trên) và membership arm không filter status — deadline có thể bị kéo sớm bởi org khác; hướng an toàn (cache hết hạn sớm), giữ ghi chú.
9. **Registry mutation không bump version:** thay đổi `scope_kinds`/`is_active`/`scope_match_mode`/`requires_cashbook_possession` và insert `tenant_emergency_denies` đổi quyết định mà không invalidate cache `(user, org, version)`. Narrowing `scope_kinds` còn silently deactivate DENY edges hiện hữu (fail-open). Sửa: registry mutation phải scan dormant/newly-active edges, route DENY-dormancy vào exception queue (abort mặc định), và bump version mọi org bị ảnh hưởng (hoặc thêm global registry generation vào cache key). Emergency-deny insert cũng phải bump version.
10. **Instantaneous change không có boundary + không nằm trong bump list (FAIL-OPEN):** `organizations.status` (suspend/close), emergency-deny insert/early-revoke, `organization_roles` create/RETIRE và registry flips đều là thay đổi TỨC THỜI — không xuất hiện trong `boundaries`. Danh sách bump ở mục "Mutation/version lifecycle" phải được mở rộng tường minh với cả bốn loại; cached ALLOW với `nearest_deadline = NULL` sẽ sống vô hạn qua một emergency deny nếu không bump. Gate test: insert emergency deny → version bump atomic; suspend org → version bump.
11. **Resolver phải trả `evaluated_at`:** `clock_timestamp()` được capture TRƯỚC khi block trên org lock; caller không thể implement lease-margin/skew đúng nếu không biết thời điểm evaluation DB-side. Thêm cột `evaluated_at timestamptz` vào RETURNS TABLE.
12. **Clock divergence với shadow parity:** v3 dùng `clock_timestamp()`, legacy `authorize_v2`/`effective_perms_v2` dùng `now()` (transaction-start) — witness hết hạn giữa transaction dài cho v2-ALLOW/v3-DENY. Parity harness phải whitelist class này hoặc chỉ compare trong fresh short transactions.
13. **Gate §4.2 thiếu emergency-deny activation/expiry:** bổ sung "future emergency-deny `active_from` phải deny-với-deadline; `expires_at` phải nằm trong nearest_deadline" vào gate list.

`scope_match_mode='ALL_PRESENT'` chưa được evaluator trên consume; exact migration phải hoặc implement aggregation theo từng dimension, hoặc abort nếu registry có row `ALL_PRESENT`. Không được để metadata quảng cáo semantics mà resolver không thực thi:

```sql
do $scope_mode_preflight$
begin
  if exists (
    select 1 from public.permission_definitions
     where is_active and scope_match_mode = 'ALL_PRESENT'
  ) then
    raise exception 'authorize_tenant_action_v3: ALL_PRESENT not implemented'
      using errcode = '0A000';
  end if;
end;
$scope_mode_preflight$;
```

### B.4 Version/lock protocol và owner lifecycle

```sql
-- Primitive chỉ dành cho canonical mutation wrappers. Gọi sau khi wrapper đã
-- SELECT organization FOR UPDATE; UPDATE này là atomic invalidation cùng tx.
create or replace function app_private.bump_authorization_version(p_org uuid)
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare v_version bigint;
begin
  perform 1 from public.organizations where id = p_org for update;
  if not found then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;

  update public.organizations
     set authorization_version = authorization_version + 1,
         updated_at = clock_timestamp()
   where id = p_org
  returning authorization_version into v_version;
  return v_version;
end;
$fn$;

revoke all on function app_private.bump_authorization_version(uuid)
  from public, anon, authenticated, service_role;
```

**Invariant bổ sung cho bump/lock protocol (review 2026-07-17):**

1. *(HIGH — at-least-once unenforced)* Không có backstop nào bắt buộc bump: live path `useStaffAssignments` và bất kỳ RPC quên bump nào để cache sống với quyền đã revoke. Exact migration phải thêm verify-only statement trigger trên các bảng witness (raise nếu transaction mutate witness mà không touch `organizations.authorization_version`) + tx-local memo trong primitive để nested wrapper được exactly-once.
2. *(anti-upgrade-deadlock — invariant PHẢI nêu tên)* Canonical mutation RPC lấy org `FOR UPDATE` TRƯỚC mọi lời gọi resolver/authorize; không bao giờ resolver-first (FOR SHARE) rồi mới FOR UPDATE trong cùng transaction — hai admin đồng thời sẽ deadlock upgrade SHARE→UPDATE.
3. *(create-shaped idempotency)* `expected_version` CAS chỉ phủ update; canonical CREATE ops cần natural unique key + no-bump-on-no-op để retry không double-create/double-bump.
4. *(outbox/TTL)* Invalidation sau commit phải có durable outbox hoặc TTL bound cho server-side cache — mất notification không được nghĩa là staleness vô hạn.
5. *(multi-org lock order)* Nếu op nào lock ≥2 organizations (transfer cross-org, platform op): lock theo uuid tăng dần.
6. *(recovery)* Restore/PITR có thể rewind version → cache cũ "hợp lệ" trở lại; runbook recovery phải có bước flush cache hoặc version-jump.
7. *(candidate review DDL gaps — đóng khi tách migration)* candidates cần: unique/supersede theo (org, cashbook, membership, proposed_kind) cho open candidates; CHECK `status='APPROVED' → membership_id IS NOT NULL`; cột `materialized_binding_id` link exactly-once; `reviewed_by NOT NULL` khi terminal + guard `reviewed_by <> source_user_id` (maker-checker); version/updated_at cho optimistic locking; invalidation khi source biến mất hoặc account soft-delete sau capture; quyết định tường minh single-vs-multi CUSTODIAN per cashbook (index hiện chỉ unique per kind+membership).

Exact canonical admin/lifecycle RPC phải dùng lock order duy nhất:

```text
organization FOR UPDATE
→ membership/role
→ binding/override/possession
→ scope edge
→ legacy + normalized mutation
→ append audit
→ bump authorization_version đúng một lần
→ commit; notification/outbox chỉ sau commit
```

Mọi `OWNER ACTIVE → SUSPENDED/REVOKED`, đổi `member_type`, transfer ownership hoặc organization bootstrap phải đóng/mở `TENANT_OWNER` binding trong cùng transaction, giữ history và kiểm last-active-owner bằng deferred invariant. Không hard-delete membership/binding/possession để rollback. Writer elevated lấy `organization FOR SHARE` ở **final decision** và giữ lock đến sau effect; canonical mutation lấy `FOR UPDATE`, nên phantom ALLOW/DENY chưa tồn tại cũng không thể commit chen giữa decision và effect. Row lock không ngăn `valid_to` tự hết hạn: writer vẫn phải kiểm `nearest_deadline`/lease margin sau mọi điểm block và ngay trước operation completion.

Không thay implementation `public.authorize_v2` hay `public.effective_perms_v2` trong tranche này: chúng tiếp tục shadow/revoked vì approval prototype hiện còn tham chiếu `effective_perms_v2`. Không grant private helper cho client/service role; wrapper T5/T6 cùng trusted owner gọi nội bộ. `scripts/check-definer-acl.mjs` phải được mở rộng để kiểm `app_private`, `PUBLIC`, `anon`, `authenticated`, `service_role` và pinned `search_path` trước khi SQL này được tách thành migration.
