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
| T0a | Recovery set local hiện tại | `BLOCKED` | Supabase Pro có 7 physical backup `COMPLETED` làm metadata phòng thủ. Local capture ngày 2026-07-15: public-data 165 relation/46.348 row; Supabase Storage 2.346/2.346 object, 1.126.216.628 byte, 0 lỗi; R2 referenced-only 172/172 object, 30.895.044 byte, 0 lỗi; source/Edge/runtime metadata đã capture. Ngày 2026-07-16 (local-only theo owner): 2.158/2.158 checksum khớp manifest (`ARTIFACT_INTEGRITY_VERIFIED_RECOVERY_STILL_PARTIAL`); sealed archive AES-256-GCM đã decrypt-verify, khóa bọc DPAPI CurrentUser, plaintext tar đã xóa; 3 replica hash-verified trên D:. | Portable PostgreSQL dump vẫn bị temporary CLI role từ chối đọc `auth`/một số bảng; R2 chưa exhaustive; capture online/unfrozen; 3 replica cùng một physical disk (không phải 3 fault domain); khóa DPAPI bound user/máy này; 2 secret-scan finding cần rotation review; không còn blank-target cloud restore trong phạm vi hiện tại. Recovery là `ONLINE_UNFROZEN/PARTIAL`, không phải full/certified backup. |
| T0b | Deployment control | `PREPARED` | Workflow local đã bỏ trigger push, thêm exact commit/path/hash/recovery/window và protected environment. | Review workflow; cấu hình GitHub environment `supabase-production` với required reviewer và secret DB URL; merge riêng. Gate A chưa đạt trên remote cho đến khi commit/push và cấu hình environment. |
| T1a | Contain approval RPC đang exposed | `BLOCKED` | Prototype approval RPC đã `APPLIED` từ Sprint 4; audit 2026-07-15 xác nhận submit/decide callable bởi `authenticated` với contract không đủ. | T0a phải `VERIFIED`; refresh live signatures/callers; chuẩn bị signature-specific revoke; test restore; owner duyệt exact production window/hash. |
| T1b | Harden `record_invoice_payment_v3` | `BLOCKED` | V3 đang `APPLIED` và là active payment path; chưa đạt contract authz/idempotency mới. | T1a containment, caller inventory, exact `thu_tien.collect`, auth-before-idempotency, scoped payload hash/unique operation, concurrency/reconciliation suite. |
| T4a | JWT/concurrency/reconciliation/observability harness | `IN_DESIGN` | Có các script legacy `test-cross-tenant`, `check-definer-acl`, `check-view-invoker`, `reconcile-money`; coverage chưa đủ gate mới. | Tạo fixture hai tổ chức, direct REST/RPC matrix, full money domains, writer map, alerts/runbook/CI. Bắt đầu song song sau T0. |
| T2 | Normalized RBAC source of truth + lifecycle/version | `BLOCKED` | Schema/materialization/`authorize_v2` đã `APPLIED`; claim shadow-complete lịch sử không đủ sau audit mới. | ALLOW/DENY + scoped override, canonical admin RPC/dual-write, lifecycle, version invalidation và zero unexplained mismatch. |
| T6a | Organization integrity + RLS v2 shadow | `BLOCKED` | `organization_id`, autofill và restrictive policies đã `APPLIED`; audit tìm thấy hard-coded fallback/exception semantics chưa đạt đích. | Classify tables; authoritative derivation; backfill/constraints; fail-closed exception queue; shadow-only RLS v2 và JWT tests. |
| T3 | Approval contract v2, non-callable | `BLOCKED` | Approval schema/prototype engine đã `APPLIED`, nhưng audit bác claim production-ready. | T2/T6a; state machine/CAS/snapshot/idempotency/candidate/rule lifecycle/audit/reversal; helpers private, wrapper chưa grant. |
| T5 | Canonical writers theo domain | `BLOCKED` | Payment V3 một phần đã `APPLIED`; phần lớn hook vẫn ghi trực tiếp hoặc dùng contract cũ. | Hoàn thành T1b/T3/T4a; chuẩn bị từng domain, flag mặc định OFF, regen types, view/financial checks. |
| T6b/T7 | Canary, cutover, drain/revoke theo domain | `BLOCKED` | Chưa có domain nào vượt gate mới sau audit ngày 2026-07-15. | T0 `VERIFIED`, exact SHA/hash/window/canary/cap, direct tests, browser, reconciliation và observation từng domain. |
| T8 | Storage/R2/Edge/service identity/ACL burn-down | `BLOCKED` | Public R2 `room-sale-images` đang live; Worker/Edge inventory đã capture; ACL baseline chỉ chống tăng exposure. | Object-link model, private delivery, key server-derived, direct cross-org tests, service identities, zero unexplained callable definer. |
| T9 | Retention, cleanup, final restore certification | `NOT_STARTED` | Không có cleanup approval; phải giữ legacy/history. | Sau ít nhất 90 ngày + business cycle, zero legacy traffic, recovery set mới/restore, independent audit và owner approval theo tranche. |

> **Design specs (2026-07-16):** mỗi tranche T2–T9 nay có một execution spec code-grounded theo `TRANCHE-TEMPLATE.md` dưới [docs/authorization/](./authorization/) (T2/T3/T4a/T5/T6a/T6b-T7/T8/T9), cùng [_TRANCHE-REVIEW-NOTES.md](./authorization/_TRANCHE-REVIEW-NOTES.md) đối chiếu cross-tranche. Có spec **không** nâng trạng thái runtime: tất cả vẫn `BLOCKED`/`IN_DESIGN` vì Markdown chỉ chứng minh `IN_DESIGN`. Cả 8 spec đều giữ production apply `BLOCKED` cho tới khi recovery `VERIFIED` + owner cấp exact SHA/hash/window/canary/VND cap. Trước khi bất kỳ tranche nào rời `IN_DESIGN`, owner phải chốt 5 mục (a)–(e) trong review notes: (a) dependency T2↔T6a hai chiều; (b) tồn tại/ownership `authorization_migration_exceptions` (T2 vs T6a) đối chiếu live catalog; (c) sign-off reorder §27.3/§27.5 (T6a-trước-T3, tách T4a/T6a/T6b); (d) unbuilt infra mà tranche sau ngầm giả định (seed permission-key của T3, feature-flag/canary infra của T6b-T7, table classification của T6a); (e) xung đột terminal-gate T9 giữa quyết định local-only và yêu cầu blank-restore/3 fault domain.

## Các claim lịch sử đã bị thay thế

Những mô tả “Sprint 1–7 hoàn tất”, “approval engine complete”, “additive = inert”, “reconciliation core = cutover complete” trong tài liệu trước ngày 2026-07-15 là `SUPERSEDED` cho execution/status. Chúng vẫn có giá trị như hồ sơ lịch sử về artifact từng được áp, nhưng không được dùng để mở production gate.

Cụ thể:

- Foundation/schema có thể đang `APPLIED`, nhưng audit mới phát hiện contract/exposure nên chưa `VERIFIED`.
- `record_invoice_payment_v3` đang phục vụ production nhưng vẫn `BLOCKED` ở T1b cho đến khi authorization/idempotency/concurrency/reconciliation đạt contract mới.
- Approval RPC đang live không phải bằng chứng approval workflow an toàn; exposure hiện tại là finding cần containment T1a.
- Baseline khoảng 100 `SECURITY DEFINER` client-callable chỉ chứng minh exposure không tăng, không chứng minh 100 signature an toàn.
- Reconciliation một vài tổng tiền không thay thế full-domain reconciliation và restore rehearsal.

## Recovery gate hiện tại

Recovery ID đang capture: `20260715T152622Z-online-unfrozen`.

| Thành phần | Trạng thái | Ghi chú |
|---|---|---|
| Supabase managed DB backups | `APPLIED` | 7/7 physical backup `COMPLETED`; PITR off. Đây không chứa Storage/R2 bytes. |
| PostgreSQL portable logical dump | `BLOCKED` | Temporary CLI role không có quyền lock/read `auth` và một số table; artifact `full.custom` thất bại không được dùng. |
| Public DB data defense-in-depth | `PREPARED` | 165 relation, 46.348 row, 0 lỗi qua service-level PostgREST; online/unfrozen, chưa restore. |
| Catalog/schema/ACL inventories | `PREPARED` | Catalog/Management OpenAPI, relations/functions/policies/triggers/grants metadata đã capture một phần; cần portable dump/restore để chứng nhận. |
| Supabase Storage bytes | `PREPARED` | Local capture online/unfrozen: 8 bucket, 2.346/2.346 object, 1.126.216.628 byte, 1.768 content hash duy nhất, 0 lỗi. Object bytes content-addressed bằng SHA-256; chưa restore/re-download độc lập. |
| Cloudflare R2 bytes | `BLOCKED` | Đã local capture 172/172 object đang được DB reference, 30.895.044 byte, 0 lỗi; vẫn chỉ `REFERENCED_OBJECTS_ONLY` vì chưa có bucket-scoped list/read credential để enumerate orphan/unreferenced object. |
| Source/runtime | `PREPARED` | Git bundle đã verify; lockfile/tool metadata; deployed Edge Function bundles/hashes; sanitized Supabase config/secret names; SQLite online backup 9Router đã capture. Vercel/Cloudflare account metadata chưa exhaustive. |
| 3 local replicas | `PREPARED` | Đã tạo ngày 2026-07-16: sealed archive AES-256-GCM (tar 1.140.275.200 byte, enc SHA-256 `150767c3…52bac32`, decrypt-verify pass, khóa DPAPI CurrentUser, plaintext tar đã xóa) nhân 3 bản hash-verified: `D:\ihomecrm-recovery\sealed`, `D:\ihomecrm-recovery-replica2`, `D:\ihomecrm-recovery-replica3`. C: chỉ còn ~1,7 GiB nên cả ba nằm trên D: — ba replica cùng một physical fault domain, chống xóa nhầm chứ không chống hỏng ổ; khóa DPAPI bound user/máy này. |
| Supabase project tạm / VPS copy | `SUPERSEDED` | Bỏ khỏi phạm vi theo quyết định owner ngày 2026-07-16; không tạo project, không upload VPS, không phát sinh mutation/chi phí cloud cho backup. |
| Recovery certification | `BLOCKED` | Local capture chỉ có thể chốt `PARTIAL/CAPTURED_UNVERIFIED`; không được nâng `VERIFIED` khi thiếu portable Auth/Storage-aware PostgreSQL dump, exhaustive R2 và independent blank restore. |

## Production gate đang áp dụng

Hiện trạng chương trình: **NO-GO cho production authorization cutover**.

Không apply T1a hoặc tranche tiền nào khi chưa có recovery `VERIFIED`. Mỗi tranche production vẫn cần exact SHA/hash, backup certification ID, maintenance window, canary organization/users, count/VND cap, owner approval và evidence. Phê duyệt tài liệu không phải blanket approval cho production mutation.
