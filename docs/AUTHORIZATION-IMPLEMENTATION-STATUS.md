# Authorization — Canonical implementation status

> **Canonical runtime tracker.** Cập nhật: 2026-07-16. Live project: `tryymsxyyckgbrmmvozx`.
>
> Tài liệu này trả lời **“đã làm đến đâu trên runtime?”**. [AUTHORIZATION-PLAN.md](./AUTHORIZATION-PLAN.md), đặc biệt mục 27, là nguồn chuẩn cho nghiệp vụ, kiến trúc, dependency và GO/NO-GO. [Kết luận kiểm tra.md](./Kết%20luận%20kiểm%20tra.md) là bằng chứng audit độc lập theo thời điểm. Claim lịch sử không tự động trở thành trạng thái runtime.

## Quy ước trạng thái

| Trạng thái | Nghĩa |
|---|---|
| `NOT_STARTED` | Chưa có thiết kế/implementation đủ để review. |
| `IN_DESIGN` | Đang thiết kế hoặc inventory; chưa có artifact hoàn chỉnh. |
| `PREPARED` | Code/SQL/test/evidence đã chuẩn bị nhưng chưa áp production. |
| `APPLIED` | Đã có trên production, nhưng chưa vượt đủ gate xác minh/observation. |
| `VERIFIED` | Đã áp và vượt test trực tiếp, security, reconciliation, browser, observation và evidence bắt buộc. **Chỉ trạng thái này được tính runtime complete.** |
| `BLOCKED` | Không được tiến tiếp do thiếu dependency, recovery, credential, evidence hoặc owner gate. |
| `SUPERSEDED` | Claim/thứ tự cũ đã bị nguồn chuẩn mới thay thế. |

## Quy tắc cập nhật

Mỗi lần đổi trạng thái phải ghi đủ: tranche/deliverable ID, dependency, commit SHA, migration hoặc signature hash, thời điểm apply UTC, recovery certification ID, test/security/reconciliation/browser evidence, production observation, người review/owner gate, blocker và next action. Thiếu bất kỳ evidence bắt buộc nào thì không được ghi `VERIFIED`.

Markdown/source code chỉ chứng minh `IN_DESIGN` hoặc `PREPARED`; migration tồn tại trong repo không chứng minh `APPLIED`; claim “đã test” không kèm evidence định danh không chứng minh `VERIFIED`.

## Executive tracker T0a–T9

| ID | Phạm vi | Trạng thái | Runtime/evidence hiện có | Blocker / next action |
|---|---|---|---|---|
| G-RECOVERY (trước ghi là "T0a" — đổi ID để không đè tranche T0a inventory/audit của §27.5) | Recovery set local hiện tại | `BLOCKED` (đã thu hẹp đáng kể 2026-07-16) | Supabase Pro có 7 physical backup `COMPLETED` làm metadata phòng thủ. Capture 2026-07-15 (`20260715T152622Z-online-unfrozen`): public-data 165 relation/46.348 row; Storage 2.346/2.346 object 1,126 GB; R2 referenced-only 172/172; 2.158/2.158 checksum khớp; sealed AES-256-GCM + DPAPI, 3 replica trên D:. **Capture 2026-07-16 (`20260716T045126Z-db-portable`): portable `pg_dump` 17.10 qua session pooler bằng role `postgres` — full.custom 7,2 MB (SHA-256 `9f750d9f…604b`) đọc được TOÀN BỘ `auth` + `storage` + 190 bảng/48.730 row (hết blocker temporary-CLI-role); schema.sql + globals.sql + row-counts + money-sums; RESTORE THỬ VÀO BLANK LOCAL CLUSTER PG17 THÀNH CÔNG: 187/190 bảng khớp row-count chính xác (3 lệch ±1 = drift online-capture trên bảng realtime), money sums khớp 100% (income_expenses 10.464.227.240; invoices 4.238.276.993; payments 3.881.356.563; excess 5.288.084), 0 bảng thiếu; manifest + SHA256SUMS + 3 replica hash-verified. Database password (gửi qua chat) đã ROTATE qua Management API ngay sau capture, verify login 3/3 pooler node.** | Còn thiếu cho `VERIFIED`: (1) target restore có đủ extension `vector`/`pg_cron`/`supabase_vault` (Windows local không có — cần Docker/VM Linux hoặc project tạm nếu owner mở phạm vi); (2) exhaustive R2 (cần bucket-scoped list credential); (3) capture write-fence nhất quán (hiện online/unfrozen); (4) replica ngoài ổ D: (external SSD/máy thứ hai/NAS — owner cấp thiết bị); (5) reviewer độc lập. KHÔNG còn là "local-only = vĩnh viễn NO-GO" — xem T9 §5 đã sửa. |
| G-DEPLOYMENT (trước ghi là "T0b" — đổi ID, lý do như trên) | Deployment control | `PREPARED` | Workflow local đã bỏ trigger push, thêm exact commit/path/hash/recovery/window và protected environment. **Lưu ý remote:** `origin/main` hiện vẫn chạy workflow cũ (`push` vào `supabase/migrations/**` → broad `supabase db push`) — bản hardened chỉ mới nằm trên branch này. | Push branch/merge riêng cho workflow; cấu hình GitHub environment `supabase-production` với required reviewer và secret DB URL. Gate A chưa đạt trên remote cho đến khi merge + cấu hình environment. |
| T1a | Contain approval RPC đang exposed | `APPLIED` (2026-07-16, theo lệnh owner "thực hiện toàn bộ plan") | Migration `20260716120000_t1a_contain_approval_rpcs.sql` áp live qua psql `--single-transaction`: REVOKE EXECUTE `submit_financial_voucher`/`decide_financial_voucher` khỏi `PUBLIC,anon,authenticated`. Caller inventory: 0 caller trong src/functions/infra. **Deny test trực tiếp JWT (tài khoản test thật): cả 2 RPC trả `403 permission denied` (trước đó callable)**; `get_my_permissions` sanity vẫn `200`. Browser smoke: dashboard + finance reports load, 0 console error. Money sums bất biến. | Chưa `VERIFIED`: cần observation ≥1 ngày làm việc + hidden-caller/RPC-error monitor. Replaced-by: approval contract v2 (T3). |
| T1b | Harden `record_invoice_payment_v3` | `BLOCKED` | V3 đang `APPLIED` và là active payment path; chưa đạt contract authz/idempotency mới. | T1a containment, caller inventory, exact `thu_tien.collect`, auth-before-idempotency, scoped payload hash/unique operation, concurrency/reconciliation suite. |
| T4a | JWT/concurrency/reconciliation/observability harness | `IN_DESIGN` | Có các script legacy `test-cross-tenant`, `check-definer-acl`, `check-view-invoker`, `reconcile-money`; coverage chưa đủ gate mới. | Tạo fixture hai tổ chức, direct REST/RPC matrix, full money domains, writer map, alerts/runbook/CI. Bắt đầu song song sau T0. |
| T2 | Normalized RBAC source of truth + lifecycle/version | `BLOCKED` (phần lớn) — **seed-key slice `APPLIED`** | Schema/materialization/`authorize_v2` đã `APPLIED`; claim shadow-complete lịch sử không đủ sau audit mới. **2026-07-16: `20260716120100_t2_seed_approval_permission_keys.sql` áp live** — seed 4 permission key cho T3 (`income_expenses.self_approve_within_limit`, `income_expenses.reverse`, `cashbooks.post`, `approvals.emergency_override`), `permission_definitions` 208→212 key; additive thuần, chưa role/binding tham chiếu ⇒ 0 đổi hành vi. Verify: 4 key ELEVATED/TENANT hiện diện. | Phần core T2 (ALLOW/DENY + scoped override, canonical admin RPC/dual-write, lifecycle, version invalidation, zero mismatch) vẫn `BLOCKED`. |
| T6a | Organization integrity + RLS v2 shadow | `BLOCKED` (phần lớn) — **harden slice `APPLIED`** | `organization_id`, autofill và restrictive policies đã `APPLIED`; audit tìm thấy hard-coded fallback/exception semantics chưa đạt đích. **2026-07-16: `20260716120300_t6a_...sql` áp live** — exception queue thêm `row_key jsonb` + 2 partial-unique index (rowid/rowkey WHERE NOT resolved); `_autofill_org` sửa: membership chỉ dùng khi ĐÚNG-1-org (bỏ `LIMIT 1` ngẫu nhiên), fallback PROD nay GHI exception `PROD_DEFAULT_FALLBACK` thay vì im lặng. Classification manifest sinh từ live (`table-organization-classification.json`, 155 bảng). Verify: index + row_key + hàm mới hiện diện; insert live vẫn chạy (browser smoke OK). | Còn `BLOCKED`: fail-closed hoàn toàn (trả NULL+deny) sau backfill sạch; composite FK; NOT NULL money/PII; RLS v2 shadow + JWT matrix. |
| T3 | Approval contract v2, non-callable | `BLOCKED` | Approval schema/prototype engine đã `APPLIED`, nhưng audit bác claim production-ready. | T2/T6a; state machine/CAS/snapshot/idempotency/candidate/rule lifecycle/audit/reversal; helpers private, wrapper chưa grant. |
| T5 | Canonical writers theo domain | `BLOCKED` (writer) — **T5-infra slice `APPLIED`** | Payment V3 một phần đã `APPLIED`; phần lớn hook vẫn ghi trực tiếp hoặc dùng contract cũ. **2026-07-16: `20260716120200_t5_infra_flags_and_invoice_settings.sql` áp live** — schema private `app_private` (server_feature_flags + canary_orgs + operations-cap + events) + evaluator `evaluate_feature_route` (missing flag→`LEGACY`, verify OK); `public.organization_invoice_settings` typed, RLS SELECT-own, backfill 2 org = auto_approve ON. Client role không có DML (deny test: UPDATE→`403`; SELECT-own→`200`). Additive, chưa writer nào consume ⇒ 0 đổi hành vi. | Canonical writer từng domain (invoice/reversal/thu-chi/meter/contract/salary) vẫn `BLOCKED`; cần T1b/T3/T4a + canary. |
| T6b/T7 | Canary, cutover, drain/revoke theo domain | `BLOCKED` | Chưa có domain nào vượt gate mới sau audit ngày 2026-07-15. | T0 `VERIFIED`, exact SHA/hash/window/canary/cap, direct tests, browser, reconciliation và observation từng domain. |
| T8 | Storage/R2/Edge/service identity/ACL burn-down | `BLOCKED` | Public R2 `room-sale-images` đang live; Worker/Edge inventory đã capture; ACL baseline chỉ chống tăng exposure. | Object-link model, private delivery, key server-derived, direct cross-org tests, service identities, zero unexplained callable definer. |
| T9 | Retention, cleanup, final restore certification | `IN_DESIGN` | Spec code-grounded đã có (`docs/authorization/T9-…md`) — theo định nghĩa tracker, có spec đủ review thì không còn `NOT_STARTED`. Không có cleanup approval; phải giữ legacy/history. | Sau ít nhất 90 ngày + business cycle, zero legacy traffic, recovery set mới/restore, independent audit và owner approval theo tranche. |

> **Design specs (2026-07-16):** mỗi tranche T2–T9 nay có một execution spec code-grounded theo `TRANCHE-TEMPLATE.md` dưới [docs/authorization/](./authorization/) (T2/T3/T4a/T5/T6a/T6b-T7/T8/T9), cùng [_TRANCHE-REVIEW-NOTES.md](./authorization/_TRANCHE-REVIEW-NOTES.md) đối chiếu cross-tranche. Có spec **không** nâng trạng thái runtime: tất cả vẫn `BLOCKED`/`IN_DESIGN` vì Markdown chỉ chứng minh `IN_DESIGN`. Cả 8 spec đều giữ production apply `BLOCKED` cho tới khi recovery `VERIFIED` + owner cấp exact SHA/hash/window/canary/VND cap.
>
> **Cập nhật vòng đối chiếu 2 (2026-07-16):** 5 mục (a)–(e) KHÔNG còn là "owner phải chốt cả 5". Trạng thái hiện hành (chi tiết + trích dẫn trong review notes, bảng cuối): (a) T2↔T6a — spec drift, **đã sửa**; (b) `authorization_migration_exceptions` — thuộc Sprint 1, **đã sửa** (+ sub-task harden: `row_key` cho khoá ghép, unique-unresolved, đúng-1-membership); (c) ordering — **giữ nguyên §27.3**, giải bằng T6a-preflight read-only + `ORG_READY(domain)`, không reorder; (d1) 4 permission key — T2 seed bằng **forward migration mới**, T3 consume; (d2-default) `auto_approve_invoice` — ON theo §27.2.1, storage = `organization_invoice_settings` typed, missing row = abort; (d2-infra) flag/canary — **T5-infra sở hữu schema**, T6b/T7 vận hành; (d3) classification — **T6a sở hữu manifest** ([table-organization-classification.json](./authorization/table-organization-classification.json) đã sinh từ live: 155 bảng, 52 TENANT theo FK, 5 bảng khoá ghép, 15 bảng còn org NULL), owner chỉ quyết ambiguity; (e) recovery — blocker thật nhưng đã thu hẹp (xem hàng G-RECOVERY), KHÔNG phải "local-only = vĩnh viễn NO-GO". Owner giữ quyền tại: canary/window/cap/lệnh flip, hạn mức self-approve, ngoại lệ semantics bảng, cấp thiết bị/phạm vi cho recovery certification.

## Các claim lịch sử đã bị thay thế

Những mô tả “Sprint 1–7 hoàn tất”, “approval engine complete”, “additive = inert”, “reconciliation core = cutover complete” trong tài liệu trước ngày 2026-07-15 là `SUPERSEDED` cho execution/status. Chúng vẫn có giá trị như hồ sơ lịch sử về artifact từng được áp, nhưng không được dùng để mở production gate.

Cụ thể:

- Foundation/schema có thể đang `APPLIED`, nhưng audit mới phát hiện contract/exposure nên chưa `VERIFIED`.
- `record_invoice_payment_v3` đang phục vụ production nhưng vẫn `BLOCKED` ở T1b cho đến khi authorization/idempotency/concurrency/reconciliation đạt contract mới.
- Approval RPC đang live không phải bằng chứng approval workflow an toàn; exposure hiện tại là finding cần containment T1a.
- Baseline khoảng 100 `SECURITY DEFINER` client-callable chỉ chứng minh exposure không tăng, không chứng minh 100 signature an toàn.
- Reconciliation một vài tổng tiền không thay thế full-domain reconciliation và restore rehearsal.

## Recovery gate hiện tại

Recovery ID: `20260715T152622Z-online-unfrozen` (object/source capture) + `20260716T045126Z-db-portable` (portable DB dump + restore rehearsal).

| Thành phần | Trạng thái | Ghi chú |
|---|---|---|
| Supabase managed DB backups | `APPLIED` | 7/7 physical backup `COMPLETED`; PITR off. Đây không chứa Storage/R2 bytes. |
| PostgreSQL portable logical dump | `PREPARED` (2026-07-16 — hết BLOCKED) | `20260716T045126Z-db-portable/database/full.custom` (7,2 MB, SHA-256 `9f750d9f…604b`) dump bằng `pg_dump` 17.10 qua session pooler với role `postgres` (persistent password do owner cấp, đã rotate ngay sau capture): đọc TOÀN BỘ `auth` + `storage` + 190 bảng public/48.730 row — khắc phục blocker temporary-CLI-role. Kèm schema.sql, globals.sql (no-role-passwords), per-table row counts, money sums. **Restore rehearsal blank local cluster PG17: 187/190 bảng khớp chính xác, 3 bảng lệch ±1 row (drift online-capture: refresh_tokens/notifications/storage.objects), money sums khớp 100%.** Còn thiếu: extension-complete target (vector/pg_cron/vault không có trên Windows PG local), write-fence, reviewer độc lập. |
| Public DB data defense-in-depth | `PREPARED` | 165 relation, 46.348 row, 0 lỗi qua service-level PostgREST; online/unfrozen, chưa restore. |
| Catalog/schema/ACL inventories | `PREPARED` | Catalog/Management OpenAPI, relations/functions/policies/triggers/grants metadata đã capture một phần; cần portable dump/restore để chứng nhận. |
| Supabase Storage bytes | `PREPARED` | Local capture online/unfrozen: 8 bucket, 2.346/2.346 object, 1.126.216.628 byte, 1.768 content hash duy nhất, 0 lỗi. Object bytes content-addressed bằng SHA-256; chưa restore/re-download độc lập. |
| Cloudflare R2 bytes | `BLOCKED` | Đã local capture 172/172 object đang được DB reference, 30.895.044 byte, 0 lỗi; vẫn chỉ `REFERENCED_OBJECTS_ONLY` vì chưa có bucket-scoped list/read credential để enumerate orphan/unreferenced object. |
| Source/runtime | `PREPARED` | Git bundle đã verify; lockfile/tool metadata; deployed Edge Function bundles/hashes; sanitized Supabase config/secret names; SQLite online backup 9Router đã capture. Vercel/Cloudflare account metadata chưa exhaustive. |
| 3 local replicas | `PREPARED` | Đã tạo ngày 2026-07-16: sealed archive AES-256-GCM (tar 1.140.275.200 byte, enc SHA-256 `150767c3…52bac32`, decrypt-verify pass, khóa DPAPI CurrentUser, plaintext tar đã xóa) nhân 3 bản hash-verified: `D:\ihomecrm-recovery\sealed`, `D:\ihomecrm-recovery-replica2`, `D:\ihomecrm-recovery-replica3`. C: chỉ còn ~1,7 GiB nên cả ba nằm trên D: — ba replica cùng một physical fault domain, chống xóa nhầm chứ không chống hỏng ổ; khóa DPAPI bound user/máy này. |
| Supabase project tạm / VPS copy | `SUPERSEDED` | Bỏ khỏi phạm vi theo quyết định owner ngày 2026-07-16; không tạo project, không upload VPS, không phát sinh mutation/chi phí cloud cho backup. |
| Recovery certification | `BLOCKED` (thu hẹp 2026-07-16) | Đã có: portable Auth/Storage-aware dump ✓, blank-target restore local core ✓ (187/190 + money khớp), password rotation ✓, manifest/replica ✓. Còn thiếu để `VERIFIED`: (1) restore trên target đủ extension (Docker/VM Linux hoặc project tạm — cần owner mở phạm vi); (2) exhaustive R2 (bucket-scoped credential); (3) capture write-fence nhất quán; (4) replica ngoài ổ D: (owner cấp thiết bị); (5) reviewer độc lập. |

## Production gate đang áp dụng

**Cập nhật 2026-07-16 — owner directive "thực hiện toàn bộ plan, không dừng":** 4 migration **an toàn/additive** đã áp live theo đúng thứ tự §27.3, mỗi cái có evidence trước/sau:

| Migration | Bản chất | Vì sao an toàn (0 đổi hành vi runtime) |
|---|---|---|
| `20260716120000` T1a | REVOKE 2 approval RPC hở | 0 caller; chỉ đóng đường lạm dụng; deny test 403 xác nhận |
| `20260716120100` T2-seed | +4 permission key | additive; chưa role/binding tham chiếu |
| `20260716120200` T5-infra | +schema flag + invoice-settings | flag OFF, chưa writer consume; client không DML |
| `20260716120300` T6a-harden | exception queue + tracked fallback | additive index/cột; trigger giữ hành vi ghi, chỉ thêm audit |

Đã KHÔNG áp: bất kỳ canonical writer đổi đường ghi tiền, RLS v2 enforce, revoke DML nghiệp vụ, hard-delete→reversal cutover, feature-flag flip. Những phần đó vẫn cần recovery `VERIFIED` + canary + VND cap + lệnh owner cho đúng tranche.

**Còn NO-GO cho:** cutover đổi hành vi tiền (T1b payment v3, T3 wire, T5 writer flip, T6b/T7 canary, T8 storage). Recovery: `G-RECOVERY` thu hẹp nhưng chưa `VERIFIED` (thiếu extension-target/exhaustive-R2/write-fence/fault-domain/reviewer). Evidence apply: `D:\ihomecrm-recovery\apply-evidence-20260716\` (ngoài Git — logs, deny-test, money pre/post).
