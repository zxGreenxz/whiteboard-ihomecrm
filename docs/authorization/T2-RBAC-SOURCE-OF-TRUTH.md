# Authorization tranche `T2` — Normalized RBAC source of truth + lifecycle/version

> Trạng thái: `IN_DESIGN`
> Production mutation: **không được phép** nếu thiếu một trường bắt buộc bên dưới. Recovery hiện `PARTIAL/BLOCKED`, production gate **NO-GO**.
> Áp production **BLOCKED** cho tới khi: recovery set `VERIFIED` **và** owner cung cấp exact commit SHA, migration SHA-256, maintenance window, canary count/VND cap (default `0` = không flip).

## 1. Scope và dependency

- **Deliverable/tranche ID:** T2 — "RBAC synchronization, staff lifecycle, authorization-version" (AUTHORIZATION-IMPLEMENTATION-STATUS.md, executive tracker; AUTHORIZATION-PLAN.md §27.5).
- **Domain:** Authorization/RBAC source-of-truth. Không đụng tiền trực tiếp, nhưng là dependency chặn của mọi tranche tiền (T1b/T3/T5/T6/T7) qua permission resolution.
- **Normative plan section:** AUTHORIZATION-PLAN.md §11.1 (nguyên tắc), §11.3–11.5 (schema normalized/scope/override), §11.6 (canonical authorization API), §11.7 (permission context + `authorization_version` invalidation), §16.4/§16.6 (backfill + dual-read/dual-write); quyết định nghiệp vụ §27.2, gate §27.6.
- **Dependencies và trạng thái:**
  - Sprint 1 organization foundation — `APPLIED` (`supabase/migrations/20260713100000_sprint1_organization_foundation.sql`): `organizations` (có cột `authorization_version bigint NOT NULL DEFAULT 1`), `organization_memberships` (partial-unique một episode ACTIVE, index `(user_id,status,organization_id)`), `legacy_owner_organization_map`, `authorization_migration_exceptions`, seed 2 org.
  - Sprint 0 fail-closed permission RPC — `APPLIED` (`20260713090000_sprint0_fail_closed_permissions.sql`): `get_my_permissions()` và bản sao `ai_copilot_perms_for()` vẫn là **live path** duy nhất phục vụ FE.
  - T0a recovery certification — `BLOCKED` (recovery `20260715T152622Z-online-unfrozen`, `ONLINE_UNFROZEN/PARTIAL`).
  - T4a JWT/concurrency/reconciliation harness — `IN_DESIGN`; cần fixture hai org thật để chạy dual-read parity + direct REST negative tests của T2.
  - T6a organization integrity + RLS v2 shadow — **không phải dependency chặn của T2** (sửa 2026-07-16 theo §27.3: chuỗi một chiều `T2 → … → T6`, T2 chạy trước). Chiều phụ thuộc thật là T6a → T2 (RLS v2 shadow của T6a dùng helper `authorize_v2`/`my_org_ids` của T2). Ở đây chỉ cần **phối hợp** để cùng một hàm derivation `organization_id` (nền Sprint-1 theo §16.2/§16.3, đã APPLIED), không có phụ thuộc runtime hai chiều.
- **In scope:**
  1. Chốt normalized RBAC làm **source of truth** cho permission: `permission_definitions` (208 key đã seed ở `20260713110100_sprint2b_seed_permission_definitions.sql`), `organization_roles`, `role_permissions` (`effect ALLOW/DENY`), `role_bindings`, `authorization_scopes`, `role_binding_scopes`, `member_permission_overrides` (+ scoped `member_override_scopes`).
  2. **Canonical admin RPC + dual-write:** mọi mutation quyền (tạo/sửa role, gán/bỏ binding, thêm/xóa scope, đặt override, suspend/revoke membership) đi qua RPC tập trung ghi đồng thời legacy (`staff_assignments`/`roles`) **và** normalized, trong cùng transaction.
  3. **Lifecycle staff:** provision/update/suspend/revoke/remove phải cập nhật normalized + legacy đồng bộ; suspend deny backend **ngay** mà không xóa identity/history (§27.2 mục 8).
  4. **Version invalidation:** bump `organizations.authorization_version` (hoặc scope-version tách) trong **cùng transaction** với mọi thay đổi membership/role/permission/binding/scope/override/area membership; đưa version vào permission context DTO; cache key `(user_id, organization_id, authorization_version)`.
  5. **Zero unexplained mismatch:** shadow-compare `effective_perms_v2(user,org)` vs `get_my_permissions()` cho toàn bộ user thật; mọi lệch phải được giải thích hoặc reconcile bằng override, trước khi bất kỳ cutover nào.
- **Out of scope:**
  - Cutover RLS/RPC sang `authorize_v2` (thuộc T6). T2 chỉ chuẩn bị source-of-truth + shadow parity; helper `authorize_v2`/`effective_perms_v2` **vẫn REVOKE khỏi client**.
  - Đổi FE `useMyPermissions`/`can()` sang DTO mới của §11.7 (thuộc T6/T5 dưới flag). T2 không flip FE.
  - Approval engine, payment v3, storage/ACL (T1b/T3/T5/T8).
  - Thay `__superadmin` sentinel cho owner (chỉ đề xuất DTO; không flip trong T2).
- **Business behavior trước thay đổi:** FE gọi `get_my_permissions()` (SECURITY DEFINER, `20260713090000`) đọc `staff_assignments.permissions` (JSONB, fallback `roles.permissions`) theo "assignment đầu tiên full-scope ưu tiên" (`ORDER BY (building_id IS NULL) DESC, created_at ASC LIMIT 1`); super admin và legacy owner allowlist nhận `{"__superadmin": true}`; shareholder/profit_manager nhận `shareholder_profit.view`. Normalized tables đã materialize (`20260713110200`) nhưng **inert** — không table/RPC/RLS nào đọc chúng; `authorize_v2` là shadow, chưa grant. Mutation quyền đi thẳng qua `staff_assignments` (hook `useStaffAssignments.ts`): provision/update/delete ghi `permissions` JSONB, **không** đụng normalized ⇒ normalized drift ngay khi owner sửa quyền sau materialize. `authorization_version` tồn tại nhưng **không có routine nào bump**; không có invalidation.
- **Business behavior sau thay đổi (đích T2):** Normalized là source of truth; mọi mutation quyền qua canonical RPC dual-write giữ legacy + normalized khớp và bump `authorization_version` cùng transaction. Suspend/revoke có hiệu lực backend ngay. Shadow parity = 0 unexplained mismatch trên user thật. FE vẫn dùng path cũ (không flip) nhưng context có thể nhận version để chuẩn bị cache invalidation. Không có behavior tiền nào đổi.
- **Ảnh hưởng nghiệp vụ/người dùng:** Trong T2 (chưa cutover), người dùng **không thấy khác biệt**: FE vẫn đọc `get_my_permissions()`. Rủi ro chính là mutation-path: nếu dual-write sai, quyền hiển thị (legacy) và quyền enforce tương lai (normalized) lệch nhau. Vì vậy T2 phải chứng minh parity trước, giữ FE nguyên, và chỉ chuẩn bị — không flip.

## 2. Immutable release identity

*(Chưa điền — chỉ owner cung cấp ngay trước apply. Không dùng branch name, "latest", glob migration hay broad `db push` làm identity.)*

- Full commit SHA: `<chưa có>`
- Exact migration path/signature: `<chưa có — mỗi migration T2 phải là 1 timestamp file cụ thể, không đặt vào supabase/migrations/ trước khi review + recovery gate đạt>`
- Migration SHA-256: `<chưa có>`
- Generated-types SHA-256: `<chưa có — regen sau mọi migration đổi schema; T2 có thể thêm cột version/bảng audit ⇒ types.ts phải regen>`
- Deployed frontend SHA: `<chưa có>`
- Recovery certification ID (`VERIFIED`): `<chưa có — hiện chỉ 20260715T152622Z-online-unfrozen = PARTIAL/BLOCKED>`
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

## 5. Test evidence trước production

- **Project restore/staging ID:** `<chưa có — cần restore project độc lập; hiện BLOCKED bởi recovery PARTIAL>`.
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
| Source of truth | `get_my_permissions()` đọc `staff_assignments.permissions`/`roles.permissions` JSONB (`20260713090000`); normalized inert (`20260713110200`). | Normalized thành source of truth; parity trước, cutover sau (T6). |
| Mutation path | `useStaffAssignments.ts` ghi thẳng `staff_assignments.permissions`, **không** đụng normalized ⇒ drift sau materialize. | Canonical admin RPC dual-write legacy + normalized cùng transaction. |
| ALLOW/DENY | `role_permissions.effect` + `member_permission_overrides.effect` đã có; deny-wins trong `effective_perms_v2`/`authorize_v2`. | Đảm bảo admin RPC ghi đúng ALLOW/DENY; scoped override qua `member_override_scopes` (bảng có sẵn, materialization hiện chỉ tạo override unscoped). |
| Scoped override | `member_override_scopes` tồn tại nhưng `20260713110200` chỉ tạo override **unscoped** (comment: "legacy per-staff perms org-wide"). | Cho phép scoped override khi nghiệp vụ cần; evaluator match đúng scope mode (§11.5). |
| Version invalidation | `organizations.authorization_version` + `organization_roles.version` + `role_bindings.version` tồn tại nhưng **không routine nào bump**; không cache key. | Bump atomic cùng transaction; DTO/cache key `(user_id,org,version)`; invalidate sau commit (§11.7). |
| Lifecycle staff | `useRemoveStaffMember` → RPC `delete_staff_member` DELETE `auth.users` cascade; suspend chưa có deny-ngay chuẩn hóa. | Suspend/revoke deny backend ngay, giữ identity/history (§27.2 mục 8); dual-write hủy binding + bump version. |
| Shadow parity | `effective_perms_v2` shadow, chưa từng compare chính thức trên user thật; sprint2e đã vá lệch `shareholder_profit.view` cho joey/nathan. | Chạy full shadow-compare mọi user thật, zero unexplained mismatch (gate §27.6). |
| `__superadmin` sentinel | `get_my_permissions` trả `{"__superadmin":true}` cho super_admin + legacy_owner_allowlist; FE `can()` short-circuit true. | §11.7 muốn bỏ sentinel cho tenant owner — **out of scope T2**, chỉ ghi nhận cho T5/T6. |

## Phụ lục B — SQL intent (chưa phải migration được duyệt)

SQL dưới đây chỉ minh họa hình dạng canonical admin RPC + version bump; **không** đặt vào `supabase/migrations/` trước khi review, restore-test và recovery gate đạt. Signature/ACL/search_path phải refresh từ live catalog.

```sql
-- MINH HỌA — version bump atomic trong cùng transaction với mutation quyền.
-- Phải do owner non-login của authorization schema sở hữu; search_path pinned;
-- chỉ grant EXECUTE cho wrapper admin có exact permission; REVOKE anon/authenticated.
create or replace function app_private.bump_authorization_version(p_org uuid)
returns bigint
language sql
security definer
set search_path to 'pg_catalog','public'
as $$
  update public.organizations
     set authorization_version = authorization_version + 1
   where id = p_org
  returning authorization_version;
$$;
-- revoke all on function app_private.bump_authorization_version(uuid)
--   from public, anon, authenticated;
```

```sql
-- MINH HỌA — dual-write role_permissions phải chạy CÙNG transaction với ghi
-- legacy roles.permissions/staff_assignments.permissions; nếu tách 2 lệnh sẽ
-- tạo split state (điều kiện abort). Không copy làm migration khi thiếu FK
-- (organization_id,id) và exact permission check của caller.
```
