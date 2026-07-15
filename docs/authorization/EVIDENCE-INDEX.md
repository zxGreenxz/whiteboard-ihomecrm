# Authorization evidence index

> Index này chỉ trỏ tới evidence đã sanitize. Không đưa credential, JWT, signed URL, private object path hoặc PII vào repo.

## Trạng thái chương trình

- Normative plan: [AUTHORIZATION-PLAN.md](../AUTHORIZATION-PLAN.md), mục 27.
- Canonical runtime tracker: [AUTHORIZATION-IMPLEMENTATION-STATUS.md](../AUTHORIZATION-IMPLEMENTATION-STATUS.md).
- Independent audit: [Kết luận kiểm tra.md](../Kết%20luận%20kiểm%20tra.md).
- Historical inventory: [AUTHORIZATION-PREP-DOSSIER.md](../AUTHORIZATION-PREP-DOSSIER.md).
- Historical Sprint 0 dossier: [AUTHORIZATION-SPRINT0-STATUS.md](../AUTHORIZATION-SPRINT0-STATUS.md).

## Execution artifacts

| Artifact | Status | Mục đích |
|---|---|---|
| [TRANCHE-TEMPLATE.md](./TRANCHE-TEMPLATE.md) | `PREPARED` | Trường bắt buộc cho mọi tranche. |
| [T1A-CONTAIN-APPROVAL-RPCS.md](./T1A-CONTAIN-APPROVAL-RPCS.md) | `IN_DESIGN/BLOCKED` | Spec containment exposed approval RPC. |
| [T1B-PAYMENT-V3-HARDENING.md](./T1B-PAYMENT-V3-HARDENING.md) | `IN_DESIGN/BLOCKED` | Spec hardening active payment V3. |
| [T2-RBAC-SOURCE-OF-TRUTH.md](./T2-RBAC-SOURCE-OF-TRUTH.md) | `IN_DESIGN/BLOCKED` | Normalized RBAC source of truth + lifecycle/version + shadow parity. |
| [T3-APPROVAL-CONTRACT-V2.md](./T3-APPROVAL-CONTRACT-V2.md) | `IN_DESIGN/BLOCKED` | Approval contract v2 (state machine/CAS/idempotency), helpers non-callable. |
| [T4A-HARNESS-JWT-CONCURRENCY-RECONCILIATION-OBSERVABILITY.md](./T4A-HARNESS-JWT-CONCURRENCY-RECONCILIATION-OBSERVABILITY.md) | `IN_DESIGN` | Test/reconciliation/observability harness; ceiling `PREPARED` cho tới khi có staging. |
| [T5-CANONICAL-WRITERS-PER-DOMAIN.md](./T5-CANONICAL-WRITERS-PER-DOMAIN.md) | `IN_DESIGN/BLOCKED` | Canonical writer từng domain, feature flag mặc định OFF. |
| [T6A-ORG-INTEGRITY-RLS-V2-SHADOW.md](./T6A-ORG-INTEGRITY-RLS-V2-SHADOW.md) | `IN_DESIGN/BLOCKED` | Organization integrity + RLS v2 shadow-only. |
| [T6B-T7-CANARY-CUTOVER-DRAIN-REVOKE.md](./T6B-T7-CANARY-CUTOVER-DRAIN-REVOKE.md) | `IN_DESIGN/BLOCKED` | Canary/flip/drain/revoke từng domain theo thứ tự §27.3. |
| [T8-STORAGE-R2-EDGE-DEFINER-ACL.md](./T8-STORAGE-R2-EDGE-DEFINER-ACL.md) | `IN_DESIGN/BLOCKED` | Storage/R2/Edge/service identity + SECURITY DEFINER ACL burn-down. |
| [T9-RETENTION-CLEANUP-RESTORE-CERT.md](./T9-RETENTION-CLEANUP-RESTORE-CERT.md) | `NOT_STARTED/BLOCKED` | Retention, cleanup, final restore certification. |
| [_TRANCHE-REVIEW-NOTES.md](./_TRANCHE-REVIEW-NOTES.md) | `PREPARED` | Đối chiếu cross-tranche + 5 mục (a)–(e) owner phải chốt trước khi rời `IN_DESIGN`. |

> Cả 8 spec T2–T9 (2026-07-16) đều PASS cửa an toàn không thương lượng: không spec nào cho phép production apply khi thiếu recovery `VERIFIED` + owner window/canary/VND cap, không spec nào đặt migration vào `supabase/migrations/`, SQL chỉ là fenced block. Các blocker còn lại (dependency T2↔T6a, tồn tại `authorization_migration_exceptions`, reorder §27.3, unbuilt infra, terminal-gate T9 local-only) là governance/consistency — xem [_TRANCHE-REVIEW-NOTES.md](./_TRANCHE-REVIEW-NOTES.md).

## Recovery evidence

Recovery artifact plaintext/mã hóa nằm ngoài Git. Repo chỉ được ghi certification ID, aggregate count/hash và sanitized report. Phạm vi từ 2026-07-16 theo quyết định owner là **local-only**: không Supabase project tạm, không upload VPS/cloud, không blank-target cloud restore trong phạm vi hiện tại.

### Recovery `20260715T152622Z-online-unfrozen` — `ONLINE_UNFROZEN / PARTIAL / BLOCKED`

Aggregate đã xác minh local ngày 2026-07-16:

- Manifest: 2.158 artifact, 1.135.662.233 byte; toàn bộ 2.158 checksum SHA-256 khớp SHA256SUMS và MANIFEST.json (0 mismatch); `database_capture` được ghi trung thực `FAILED`. Verdict: `ARTIFACT_INTEGRITY_VERIFIED_RECOVERY_STILL_PARTIAL` (report: `D:\ihomecrm-recovery\reports\<id>-local-integrity.json`, ngoài Git).
- Sealed archive: tar 1.140.275.200 byte → AES-256-GCM `sealed/<id>.tar.enc` 1.140.275.237 byte, SHA-256 `150767c3…52bac32`; decrypt-verify stream pass (auth tag + plaintext hash khớp seal-meta); plaintext tar đã xóa. Khóa 32 byte bọc DPAPI CurrentUser (`keys/<id>.key.dpapi`), raw key đã wipe — archive chỉ giải mã được bởi user/máy này nếu chưa export khóa theo thủ tục riêng.
- Replica: 3 bản sealed archive hash-verified trên `D:\ihomecrm-recovery\sealed`, `D:\ihomecrm-recovery-replica2`, `D:\ihomecrm-recovery-replica3` — **cùng một physical disk/fault domain**, chỉ là replica chống xóa nhầm, không chống hỏng ổ.
- Secret scan: 2 finding (1 blob public-data pattern `generic-sk-key`, 1 `runtime/supabase/config-pooler.json` pattern `database-uri`) — chỉ ghi path/pattern, không ghi value; xử lý bằng sealed storage; cần rotation review trước certification. Giới hạn scan: bỏ qua file >5 MiB và binary/archive; Git bundle chưa chứng minh secret-free.

Vẫn `BLOCKED` cho certification vì: thiếu portable Auth/Storage-aware PostgreSQL dump; R2 chỉ referenced-only; capture online/unfrozen (không write fence); chưa có independent blank restore. Không dùng recovery này làm production gate.

Nếu sau này owner mở lại restore rehearsal, dòng certification phải gồm: certification ID; capture cutoff UTC; managed backup reference; aggregate counts/manifest hash; trạng thái các bản sao; kết quả blank restore; schema/ACL/security/money/object/browser verdict; reviewer và timestamp; đường dẫn evidence sanitized trong repo (nếu có).
