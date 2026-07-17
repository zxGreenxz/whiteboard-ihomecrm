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

> Cả 8 spec T2–T9 (2026-07-16) đều PASS cửa an toàn không thương lượng: không spec nào cho phép production apply khi thiếu recovery `VERIFIED` + owner window/canary/VND cap, không spec nào đặt migration vào `supabase/migrations/`, SQL chỉ là fenced block.
>
> **Vòng đối chiếu 2 (2026-07-16):** các blocker (a)–(e) đã reconcile — (a)/(b)/(d1)/(d2-default) sửa xong (spec drift); (c)/(d2-infra)/(d3) giải bằng safe default đúng plan (giữ thứ tự §27.3 + T6a-preflight/`ORG_READY`; T5-infra sở hữu flag schema; T6a sở hữu classification manifest); (e) thu hẹp còn 5 điều kiện kỹ thuật (extension-target, exhaustive R2, write-fence, fault-domain replica, independent reviewer). Chi tiết + sub-task harden: [_TRANCHE-REVIEW-NOTES.md](./_TRANCHE-REVIEW-NOTES.md) bảng cuối. Classification manifest (PROPOSED, chưa approve): [table-organization-classification.json](./table-organization-classification.json) — 155 bảng từ live catalog.

## Recovery evidence

Recovery artifact plaintext/mã hóa nằm ngoài Git. Repo chỉ được ghi certification ID, aggregate count/hash và sanitized report. Phạm vi từ 2026-07-16 theo quyết định owner là **local-only**: không Supabase project tạm, không upload VPS/cloud, không blank-target cloud restore trong phạm vi hiện tại.

### Recovery `20260716T045126Z-db-portable` — `PORTABLE_DUMP_PROVEN_RESTORABLE_CORE / PREPARED`

Capture + restore rehearsal 2026-07-16 (sau khi owner cấp persistent database password; password đã rotate qua Management API ngay sau capture, verify 3/3 pooler node):

- **Capture:** `pg_dump` 17.10 (custom format) qua Supavisor session pooler, role `postgres` — `database/full.custom` 7.227.674 byte, SHA-256 `9f750d9f3820174406f7b516e2a639475c1e5e1804dcfbf428e76f7ffa15604b`; TOC 4.687 dòng, 254 TABLE DATA gồm đủ `auth.*` (users/identities/sessions/refresh_tokens/…) + `storage.*` (buckets/objects/…) + toàn bộ `public`. Kèm `schema.sql` (1,96 MB), `globals.sql` (roles, no-passwords), 190 bảng/48.730 row counts, money sums nguồn.
- **Restore rehearsal (blank local target):** cluster PostgreSQL 17.10 mới `initdb` trên port riêng, database trắng. Round 2 (sau khi pre-create 2 sort function do gap TOC-order của pg_dump với generated column `rooms.name_sort`): **187/190 bảng khớp row-count chính xác, 0 bảng thiếu**; 3 bảng lệch ±1 row (`auth.refresh_tokens` 618→617, `notifications` 954→953, `storage.objects` 2381→2380) = drift online-capture trên bảng hoạt động liên tục; **money sums khớp 100%** (income_expenses 10.464.227.240,00 / invoices 4.238.276.993,00 / payments 3.881.356.563,00 / excess 5.288.084,00); 149 lỗi còn lại toàn bộ do 3 extension không có trên Windows PG local (`vector`, `pg_cron`, `supabase_vault`) — bảng phụ thuộc (AI embeddings, cron ledger, vault) cần target Linux/Docker/project-tạm cho certification cuối.
- **Artifact:** `MANIFEST.json` + `checksums/SHA256SUMS` (13 file, 9.582.134 byte) + `RESTORE-SUMMARY.json`; 3 bản hash-verified (`D:\ihomecrm-recovery\tryymsxyyckgbrmmvozx`, `…-replica2`, `…-replica3`) — vẫn cùng ổ D:, chưa phải fault domain độc lập.
- **Ý nghĩa gate:** blocker "temporary CLI role không đọc được auth/một số bảng" đã đóng; "chưa có independent blank restore" đã đóng ở mức core-local. Certification tổng thể vẫn `BLOCKED` vì: extension-complete target, exhaustive R2, write-fence, fault-domain replica, independent reviewer.

### Recovery `20260715T152622Z-online-unfrozen` — `ONLINE_UNFROZEN / PARTIAL / BLOCKED`

Aggregate đã xác minh local ngày 2026-07-16:

- Manifest: 2.158 artifact, 1.135.662.233 byte; toàn bộ 2.158 checksum SHA-256 khớp SHA256SUMS và MANIFEST.json (0 mismatch); `database_capture` được ghi trung thực `FAILED`. Verdict: `ARTIFACT_INTEGRITY_VERIFIED_RECOVERY_STILL_PARTIAL` (report: `D:\ihomecrm-recovery\reports\<id>-local-integrity.json`, ngoài Git).
- Sealed archive: tar 1.140.275.200 byte → AES-256-GCM `sealed/<id>.tar.enc` 1.140.275.237 byte, SHA-256 `150767c3…52bac32`; decrypt-verify stream pass (auth tag + plaintext hash khớp seal-meta); plaintext tar đã xóa. Khóa 32 byte bọc DPAPI CurrentUser (`keys/<id>.key.dpapi`), raw key đã wipe — archive chỉ giải mã được bởi user/máy này nếu chưa export khóa theo thủ tục riêng.
- Replica: 3 bản sealed archive hash-verified trên `D:\ihomecrm-recovery\sealed`, `D:\ihomecrm-recovery-replica2`, `D:\ihomecrm-recovery-replica3` — **cùng một physical disk/fault domain**, chỉ là replica chống xóa nhầm, không chống hỏng ổ.
- Secret scan: 2 finding (1 blob public-data pattern `generic-sk-key`, 1 `runtime/supabase/config-pooler.json` pattern `database-uri`) — chỉ ghi path/pattern, không ghi value; xử lý bằng sealed storage; cần rotation review trước certification. Giới hạn scan: bỏ qua file >5 MiB và binary/archive; Git bundle chưa chứng minh secret-free.

Vẫn `BLOCKED` cho certification vì: thiếu portable Auth/Storage-aware PostgreSQL dump; R2 chỉ referenced-only; capture online/unfrozen (không write fence); chưa có independent blank restore. Không dùng recovery này làm production gate.

Nếu sau này owner mở lại restore rehearsal, dòng certification phải gồm: certification ID; capture cutoff UTC; managed backup reference; aggregate counts/manifest hash; trạng thái các bản sao; kết quả blank restore; schema/ACL/security/money/object/browser verdict; reviewer và timestamp; đường dẫn evidence sanitized trong repo (nếu có).

## Preparation source identities — vòng review 40-luồng 2026-07-17 (branch `security/authz-preparation`)

Ràng buộc: các claim review/adapter-test của ngày 2026-07-17 chỉ có hiệu lực với ĐÚNG các hash sau. Mọi edit làm hash đổi ⇒ evidence stale, phải review/test lại.

- Base commit HEAD lúc review: `ac0bdaf6f89606f10ec6a0223eb09c817f544ba4` (các file dưới là working-tree changes/untracked TRÊN commit này, chưa được pin bằng commit riêng cho tới commit preparation kế tiếp).
- `supabase/migrations/20260716180000_t5_income_expense_create_draft_writer.sql` — 52.491 byte, SHA-256 `caae2097e4ece91e1b3867e57433a6cacf699f5f8b73da8f46a64a7cc881b8dd` (revision hiện tại; BB0C đã stale). Trạng thái: BLOCKED/IN_DESIGN, chưa apply/grant/route, chưa có compile/concurrency evidence cho revision này.
- `src/lib/incomeExpenseCreateRpc.ts` — SHA-256 `65d6b5f6929c7d75…` (adapter thuần build-args, không route write; importer duy nhất là test của nó).
- `src/lib/__tests__/incomeExpenseCreateRpc.test.ts` — SHA-256 `2ff0eda99e6ea2f1…` (31 case).
- Review program: 34 read-only agent (T2 registry/override/allowlist/binding/resolver/deadline/candidates/lifecycle/version-bump; T3 sidecar/capability/guards/truncate/claim-binding/audit-DDL/audit-chain/inventory/receipt; cross T2↔T3, T3↔T5; writer marker/attachments/final-auth/audit-integration; rollout consistency; harness/fixture/security-matrix/concurrency-matrix/evidence-manifest; secret-scan; multi-machine; frontend writer map; completeness critic) — workflow run `wf_98011a71-4ce`, 34/34 hoàn thành, 0 lỗi. Kết quả đã được hợp nhất vào T2/T3/T5 docs + tracker cùng ngày; đây là REVIEW evidence (design), KHÔNG phải compile/test/production evidence.
- Gate đã chạy trên working tree này (2026-07-17): `npm run typecheck:baseline` PASS (32 fingerprint khớp, không tăng); secret-scan toàn bộ staged diff: 0 hit; `npx vitest run --dir src/lib/__tests__ incomeExpenseCreateRpc` PASS 31/31 (lưu ý vận hành: vitest quét từ repo root sẽ treo do ~1.395 worktree agent trong `.claude/worktrees` — phải scope `--dir`). Các pass này là source-local; KHÔNG thay thế fresh PostgreSQL compile/concurrency evidence cho artifact SQL.

## Exact-source PostgreSQL 17 harness run 2026-07-17 (disposable, `20260717-b6d9608`)

- **Harness:** initdb PG 17.10 cục bộ 127.0.0.1:55432 (KHÔNG phải production; production listener 5432 không bị chạm), restore portable dump `full.custom` SHA-256 `9f750d9f…604b` (khớp manifest) + globals + pre-fns; 149 lỗi restore đều là 3 extension vắng trên Windows như đã ghi; money baseline khớp nguồn: income_expenses 10.464.227.240 / invoices 4.238.276.993 / payments 3.881.356.563. Replay seed đã-APPLIED `20260716120100` (dump chụp trước seed đó cùng ngày).
- **PREPARED SQL mới dưới `scripts/authz-prepared/`** (compile + behavior-test trên harness — KHÔNG phải migration, KHÔNG apply production):
  - `t2_01` (SHA-256 `526b0a4e114bb2fd…`) registry metadata + override lifecycle `revoked_at`/partial-unique/deferrable-invariant + possession (RLS on) + emergency denies.
  - `t2_02` (`cd679db46ea25b62…`) backfill fail-closed: org-scope coverage self-heal, allowlist count/hash assert (chặn silent-narrowing — đã bắt đúng lỗi thiếu 4 key khi dump pre-seed), TENANT_OWNER window-overlap idempotent (rerun giữ nguyên 2 bindings), candidates PENDING_REVIEW/AMBIGUOUS.
  - `t2_03` (`1cf60ddfe8a1b210…`) `authorize_tenant_action_v3` — đóng đủ 13 defect review: ORG-mode override, DENY-broad/ALLOW-exact-possession, required_dimensions, NULL valid_from, org-filtered boundaries, evaluated_at, malformed-witness raise, lock-first protocol qua `lock_org_for_decision_v1`.
  - `t3_01` (`3678af6d90154248…`) role `ie_canonical_writer` NOLOGIN/NOBYPASSRLS + sidecar + claim helper INVOKER capability-gated + lock delegates DEFINER + full-freeze ENABLE ALWAYS + ledger triggers ENABLE ALWAYS + trigger-order assert.
  - `t3_02` (`452c174755d32576…`) re-own wrapper → `ie_canonical_writer`, grants/policies tối thiểu (lock-only UPDATE `WITH CHECK (false)`), post-transfer invariants.
  - `t3_03` (`07d6d54357bbc925…`, GENERATED bởi `build-t3-03.mjs` từ artifact caae2097…) writer + T3 claim tại đúng A.2 integration point + actor-name delegate.
- **Kết quả test (fresh, exact-source):** resolver decision matrix **14/14 PASS**; T3 containment **14/14 PASS** (gồm replica-mode, upsert-arm, legacy-unmarked compatibility); writer e2e **8/8 PASS** (claim atomic, replay immutable, different-payload 23505, freeze, ACL); concurrency 2-session **3/3 PASS** (duplicate-key race, claimant-abort handover, freeze race); security matrix 2-org **8/8 PASS**; `check-definer-acl` PASS (100 = baseline); invoices/payments sum bất biến.
- **Giới hạn trung thực:** harness thiếu `vector`/`pg_cron`/`supabase_vault`; PostgREST/JWT thật chưa test (SET ROLE mô phỏng); các pass bind vào hash các file trên + artifact `caae2097…` — mọi edit làm evidence stale; đây là PREPARED evidence, KHÔNG phải production apply/activation. Audit-chain A.5, approval v2 state machine, receipt RPC, rollout CAS RPC chưa nằm trong bộ này.
