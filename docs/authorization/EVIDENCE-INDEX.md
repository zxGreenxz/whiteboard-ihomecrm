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
| [ON-TARGET-VALIDATION-2026-07-17.md](./ON-TARGET-VALIDATION-2026-07-17.md) | `PREPARED + ON-TARGET VALIDATED` | Integration evidence trên Supabase thật (staging tạm, postgres non-superuser): 4 defect chỉ-Supabase + redesign A.9 capability-token + 15/15 suite (117 assertion) trên cả staging & superuser local. |
| [RUNBOOK-CUTOVER-PAYMENT.md](./RUNBOOK-CUTOVER-PAYMENT.md) | `SẴN SÀNG trừ P1 — chờ owner P1 + điền OWNER-GATE` | Runbook cutover domain #1 payment/credit: OWNER-GATE, artifact hash-pinned (7 SQL + adapter), trình tự W1–W10, observation, ABORT + forward-fix. **2026-07-17 vòng P2–P4:** P2 T1a → `VERIFIED` (ACL + deny-probe JWT thật + control 200); P3 `t0_ledger_only`/`t0_flag_hardening` sinh máy + test fresh/idempotent/probe/staging-no-op; P4 adapter fallback (29 Vitest) + **vá cross-ledger guard chống double-pay flip-race trong t1b_01** (t1b_90 8/8 staging + local). Chỉ còn P1 (merge-main untangle) là gate kỹ thuật cuối. |

> Cả 8 spec T2–T9 (2026-07-16) đều PASS cửa an toàn không thương lượng: không spec nào cho phép production apply khi thiếu recovery `VERIFIED` + owner window/canary/VND cap, không spec nào đặt migration vào `supabase/migrations/`, SQL chỉ là fenced block.
>
> **Vòng đối chiếu 2 (2026-07-16):** các blocker (a)–(e) đã reconcile — (a)/(b)/(d1)/(d2-default) sửa xong (spec drift); (c)/(d2-infra)/(d3) giải bằng safe default đúng plan (giữ thứ tự §27.3 + T6a-preflight/`ORG_READY`; T5-infra sở hữu flag schema; T6a sở hữu classification manifest); (e) thu hẹp còn 5 điều kiện kỹ thuật (extension-target, exhaustive R2, write-fence, fault-domain replica, independent reviewer). Chi tiết + sub-task harden: [_TRANCHE-REVIEW-NOTES.md](./_TRANCHE-REVIEW-NOTES.md) bảng cuối. Classification manifest (PROPOSED, chưa approve): [table-organization-classification.json](./table-organization-classification.json) — 155 bảng từ live catalog.

## Recovery evidence

Recovery artifact plaintext/mã hóa nằm ngoài Git. Repo chỉ được ghi certification ID, aggregate count/hash và sanitized report. Phạm vi 2026-07-16 là **local-only**; **cập nhật 2026-07-17: owner đã cấp một Supabase project tạm**, nên phạm vi mở rộng gồm restore vào một live Supabase target (extension-complete) — xem entry `20260717T095450Z` dưới.

### Recovery `20260717T095450Z-db-portable` — `ROUND_TRIP_PROVEN_CROSS_VALIDATED / PREPARED`

Bản dump production tươi 2026-07-17 (~09:54 UTC), `pg_dump` 17.10 custom-format qua Supavisor pooler, `-Z0` + TCP keepalive (2 bản trước — `092043Z`, `095310Z` — bị pooler idle-drop giữa stream → TOC hợp lệ nhưng `invoices/payments/rooms` rỗng; bắt bằng round-trip trên CẢ staging lẫn local, đã đánh dấu `TRUNCATED_DO_NOT_USE`).

- **Artifact:** `database/full.custom` 43.014.738 byte, SHA-256 `3dcbc76da4f921ed9bc486389a0644f6b48f54488528b9b114d73672b8805983`; 3 bản hash-verified (vẫn cùng ổ D:, chưa phải fault domain độc lập).
- **Cross-restore money invariant (2 target độc lập, cùng dump):** blank local PG 17.10 (`verify3`) và live Supabase staging (`qwxgygsewymkahiavslu`) khớp **exact**: `income_expenses` 10.492.190.716,00 · `invoices` 4.242.342.993,00 · `payments` 3.893.111.563,00 · `auth.users` 11/11.
- **`storage.objects` delta — ĐÃ ĐÓNG (điều tra id-level cùng ngày):** id-set staging == id-set backup 16/07 (2.380/2.380 tuyệt đối); cả dump tốt 17/07 lẫn dump truncated 095310Z đều đủ 2.418 → nguyên nhân là restore-đè: `public` thay trọn (tiền khớp 17/07 exact) nhưng `storage` live-Supabase không drop được → COPY đụng trùng PK → hủy toàn bảng → staging kẹt bản 16/07 (thiếu đúng 38 object tạo 16/07 04:51→17/07 09:54 UTC). Dump hoàn chỉnh, không mất dữ liệu nguồn. Đã reconcile 38 row (ON CONFLICT DO NOTHING) → staging = dump **2.418/2.418 id-level**.
- **Off-machine copy (2026-07-17):** tar artifact 44.615.680 byte (plain SHA-256 `67a4e9ff…28ddea`) → AES-256-GCM (cipher SHA-256 `bdae2c0f…1b02df`) → VPS `/root/ihomecrm-recovery/` chmod 600, remote sha256sum khớp. Khóa DPAPI CurrentUser tại `D:\ihomecrm-recovery\keys\`; raw key + plaintext wipe. **Caveat:** ciphertext off-machine chống hỏng ổ D:, nhưng khóa chỉ unwrap trên máy/user này — cần owner export key escrow (password manager/in giấy) cho fault-domain trọn vẹn.
- **Extension-complete target:** gate cũ BLOCKED do local thiếu `vector`/`pg_cron`/`supabase_vault`; staging có `pg_cron 1.6.4`/`supabase_vault 0.3.1`/`pgcrypto 1.3` → toàn bộ authz stack compile+chạy trên target đủ extension.
- **Còn `BLOCKED` cho certification tổng thể:** key escrow (trên), independent reviewer, exhaustive R2/object bytes. Chi tiết + on-target findings: [ON-TARGET-VALIDATION-2026-07-17.md](./ON-TARGET-VALIDATION-2026-07-17.md). Runbook cutover domain #1: [RUNBOOK-CUTOVER-PAYMENT.md](./RUNBOOK-CUTOVER-PAYMENT.md).

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
  - `t3_04` (`d2b0ffb31ca5a32e…`) durable audit + SHA-256 hash chain A.5: re-point live NULL-writers trước SET NOT NULL, FK de-cascade + assert, byte-level canonical serialization (UTC-pinned, org+seq trong preimage, genesis 64-zero), head bootstrap ON CONFLICT + FOR UPDATE, `pg_catalog.sha256` (no pgcrypto), chain-verify function, writer-monopoly ENABLE ALWAYS reject NULL-hash INSERT.
  - `t3_05` (`6e45fc8ea31b0254…`) `attach_payment_receipt_v1` atomic (A.7): lock payment+invoice+ALL vouchers, server-side URL validate, canonical-voucher reject, + payments guard ENABLE ALWAYS chặn direct UPDATE/DELETE khi link canonical.
  - `t3_03` (regenerated `ed60fe39e5317e3f…`, GENERATED bởi `build-t3-03.mjs` `b259718f805b503a…` từ artifact `caae2097…`) writer + T3 claim tại A.2 integration point + actor-name delegate + audit qua `append_income_expense_event_v1` (chain) thay direct INSERT.
- **Kết quả test (fresh, exact-source — 58 assertion / 7 suite):** resolver decision matrix **14/14 PASS**; T3 containment **14/14 PASS** (replica-mode, upsert-arm, legacy-unmarked compat); writer e2e **8/8 PASS** (claim atomic, replay immutable, 23505, freeze, ACL); audit chain **6/6 PASS** (link, verifier, unchained-reject, append-only, RPC routes-through-chain + lifecycle-forge deny, subject-delete retention); receipt atomicity **5/5 PASS** (atomic attach, idempotent, invalid-URL, canonical block payment DML, stranger deny); concurrency 2-session **3/3 PASS**; security matrix 2-org **8/8 PASS**; `check-definer-acl` PASS (100 = baseline); invoices/payments sum bất biến.
  - `t3_06` approval v2 private state machine: REVERSED state + reversal link (anti-double), exactly-once posting với `GET DIAGNOSTICS ROW_COUNT` assertion, snapshot-hash revalidation trên decide, submission_no allocation, maker-checker (membership+user), self-approve-within-limit (held-cashbook possession + versioned limit default 0), decision enum mở rộng CHECKER/SELF/REVERSAL. TẤT CẢ private, KHÔNG grant (non-callable theo §4.16).
  - `t5_01` rollout CAS: `set_feature_route_v1` compare-and-swap `config_version` + bắt buộc release identity (40-hex commit/64-hex migration/window/approval) cho ON/CANARY + finite window + positive caps cho CANARY + emit event; cap-ledger non-negative CHECK + append-only guard; event append-only guard.
- **Kết quả test bổ sung (fresh, exact-source):** approval v2 **10/10 PASS** (maker-checker deny, version-CAS, snapshot-mismatch, exactly-once, re-decide deny, reversal linked+negated+once, double-reversal deny, self-approve 0-limit/no-possession/within-limit); rollout CAS **8/8 PASS** (stale-CAS, ON-no-identity, CANARY-no-window, valid ON bump+event, monotonic reuse, event/cap append-only, cap non-negative). **Tổng bộ prepared: 84 assertion / 9 suite PASS.**
  - `t3_07` (`2f6dba8dc3d38665…`) candidate/step materialization T3 §4.7: union approver MEMBER/ROLE/PERMISSION(qua resolver v3)/CASHBOOK/AREA/BUILDING → distinct membership loại maker; generation bump + close prior; ANY/ALL/QUORUM satisfaction; fail-closed zero-candidate/impossible-quorum.
  - `t3_08` (`645009dc4f8bffc9…`) emergency_approve_financial_v1: OWNER + reason≥20 + reauth-fresh + resolver-checked `approvals.emergency_override` + owner-không-là-maker; bypass steps; append-only event ledger.
  - `t3_09` (`873287abeb6c4f5b…`) rule governance: publish DRAFT→ACTIVE→RETIRED atomic (retire current ACTIVE cùng transaction) + exactly-one-fallback check; published rule set/rules immutable; resolve_active_rule_set_v1 fail-closed khi không đúng một ACTIVE.
  - `t3_10` (`6a70addd36430011…`) freeze-exempt canonical transition: transaction-scoped token trong app_private (KHÔNG GUC/identity — cả hai bị review cấm) cho phép lifecycle-only UPDATE; payload (amount/items/account/building/contract/hash) vẫn frozen kể cả khi authorized; posting của t3_06 (`b3e98a2792b07e8b…`) route canonical rows qua đây.
- **Kết quả test bổ sung (fresh, exact-source):** candidate **7/7 PASS**; emergency override **6/6 PASS** (validate end-to-end T2 resolver cấp emergency permission qua TENANT_OWNER binding); rule governance **7/7 PASS**; canonical transition **5/5 PASS** (gồm forged-token-không-đổi-payload defense-in-depth).

## Vòng 2 — audit đối kháng 10-luồng + slice bổ sung (2026-07-17, wf_1429ab8f-dd8)

Re-audit 10 agent tìm ra defect mà test xanh bỏ sót; đã sửa + thêm slice, tất cả bind hash mới:

- **Defect nghiêm trọng đã sửa:** decide_financial_request_v1 bỏ qua quorum/eligibility/multi-step (C1/F2/H5 — một APPROVE bất kỳ post ngay) → giờ enforce is_eligible_current_candidate_v1 + step_is_satisfied_v1 (đếm đúng current-generation) + multi-step advancement; transition guard t3_10 denylist 11-cột → ALLOWLIST (Finding 1/2 — denylist cũ để lọt voucher_date/deleted_at/user_id/change_amount...); self-approve force-class từ item type schema-owned + exact permission qua resolver + anti-split aggregate (H3/H4/M8); snapshot fail-closed khi NULL hash (H2); rule-set immutability allowlist chặn RETIRED→ACTIVE resurrect + fallback-đúng-một (H6/M7); candidate CHECK cho AMBIGUOUS (F13 — backfill sẽ abort 23514 trên prod data có owner-không-membership); restore_income_expense audit qua chain primitive (F1 — nếu không sẽ chết trên prod sau writer-monopoly guard); resolver pre-lock trong materialize (F12); maker exclude theo user_id (M10).
- **Slice mới (compile+behavior-test):**
  - `t3_11` (`7752a6f99740bf36…`) submit_financial_request_v1: front-half approval engine — lock subject, derive org/amount/cashbook/building server-side, resolve active rule set (fail-closed), match rule theo priority, AUTO_POST/DENY/REQUIRE_APPROVAL, submission_no atomic, tạo steps + materialize candidates, idempotent one-open-subject.
  - `t1b_01` (`d2f00aaa14946ca0…`) record_invoice_payment_v4 (T1b): authorize `thu_tien.collect` TRƯỚC idempotency lookup; org derive từ buildings (không tin invoices.organization_id nullable); durable ledger claim org+op+invoice+caller+key+hash; same-key/diff-payload 23505; org-stamp mọi effect (v3 bỏ trống); atomic. Đóng 7 gap của v3.
  - `t5_02` (`38a8bdc530b723b0…`) create_invoice_v1 (server-decide APPROVED/DRAFT từ organization_invoice_settings, live partial-unique (contract,billing_month)) + reverse_invoice_payment_v3 forward-fix. **GROUNDING CORRECTION quan trọng:** payments live có CHECK amount>0 → KHÔNG dùng negative compensating payment (design ban đầu sai); forward-fix đúng là refund voucher EXPENSE 'Tiền thối' mà recompute_invoice_for_id đã trừ sẵn — original payment giữ nguyên, không hard-delete; anti-double qua app_private.payment_reversals; idempotent replay.
- **Kết quả (fresh, exact-source):** submit e2e **7/7**, T1b payment **7/7**, T5 invoice/reversal **6/6**, approval v2 **11/11** (thêm non-candidate-deny + self-approve-permission), transition **5/5** (allowlist probe 7 cột).

## Vòng 3 — 3 domain T5 còn lại (2026-07-17, grounding wf_b6155206-e45)

3 domain cuối được ground song song rồi build tuần tự (theo lựa chọn owner), tất cả PREPARED/OFF/revoked:

- `t5_03` (`646ccc6c6c1a6529…`) cashbook: create_cashbook_v1 (opening balance = initial_amount server-controlled, code auto qua trg_accounts_set_code, org derive từ single ACTIVE membership); request_opening_balance_adjustment_v1 FORWARD-FIX (voucher điều chỉnh INCOME/EXPENSE mà balance-view cộng dồn — KHÔNG overwrite initial_amount vì sẽ dịch mọi snapshot lịch sử; permission cashbooks.post + possession); lock/unlock_cashbook_period_v1 (set/clear accounts.lock_date, monotonic không lùi, live income_expenses_check_lock trigger enforce); archive_cashbook_v1 (guard: còn phiếu non-deleted thì chặn).
- `t5_04` (`e533742b8684ca8b…`) salary: salary_payout_v1 FORCE-APPROVAL — tạo phiếu lương EXPENSE UNAPPROVED rồi submit_financial_request_v1; KHÔNG bao giờ self-approve (test T1 chứng minh maker=approver → materialize zero-candidate → fail-closed đúng contract §4.6); rent-offset đi qua record_invoice_payment_v4 (loại double-writer trực tiếp payments); permission salary.distribute (không phải luong.chi như grounding ban đầu đoán — đã đối chiếu registry).
- `t5_05` (`cc8884b767bfb4ec…`) contract+deposit: create_reservation_deposit_v1 — 24h exclusive hold **server-time**, additive `public.room_reservation_holds` + **btree_gist exclusion constraint** (`room_id =`, `tstzrange(held_at,expires_at) &&`, WHERE status live) = at-most-one-live-hold-per-room, self-expiring không cần sweep; create_contract_v1 atomic (contract + contract_customers + contract_services + first invoice qua create_invoice_v1 + consume hold + room OCCUPIED là mutation CUỐI để né lock-upgrade deadlock với recompute_room_reservation); permission contracts.create/deposits.create (applied).
- **Kết quả (fresh, exact-source):** cashbook **8/8** (forward-fix adjustment, monotonic lock, guarded archive), salary **5/5** (force-approval không self-approve), contract/deposit **8/8** (24h hold, no-double-hold exclusion, atomic contract, idempotent). **Tổng bộ prepared: 143 assertion / 19 suite PASS (132 SQL + 11 JS); check-definer-acl 100=baseline.**
- **Toàn bộ 6 domain T5 nay đã có bản prepared:** income/expense (T3 engine), invoice, payment-collect (T1b) + reversal, cashbook, salary/profit-payout, contract+deposit. Còn lại trước production vẫn là: owner gate + tách migration + recovery VERIFIED + JWT/PostgREST thật + thêm thu_tien.collect vào owner allowlist.
- **Lưu ý owner-gate còn lại:** owner allowlist phải THÊM `thu_tien.collect` (nếu không owner không thu được tiền sau T1b cutover); các writer mới đều flag OFF/zero-cap/revoked; production apply vẫn cần recovery `VERIFIED` + tách migration + owner SHA/window/cap.
- **Giới hạn trung thực:** harness thiếu `vector`/`pg_cron`/`supabase_vault`; PostgREST/JWT thật chưa test (SET ROLE mô phỏng); các pass bind vào hash các file + artifact `caae2097…` — mọi edit làm evidence stale; đây là PREPARED evidence, KHÔNG phải production apply/activation. Toàn bộ chuỗi T2 resolver → T3 approval engine (claim/freeze/audit-chain/receipt/candidate/decide/self-approve/emergency/reversal/rule-governance/transition) + rollout CAS nay đã có bản prepared compile+behavior-test; còn lại trước production là: owner gate + tách timestamped migration + `CREATE INDEX CONCURRENTLY` + `revoke ie_canonical_writer from postgres` trên Supabase + recovery `VERIFIED` cho money cutover + JWT/PostgREST end-to-end trên môi trường có đủ extension.

### Đợt 2 cùng ngày (harness giữ nguyên, sau khi cài thêm A.5 + A.7):

- `t3_04_audit_chain.sql` (SHA-256 `d2b0ffb31ca5a32e…`) — A.5 đầy đủ: re-point `log_income_expense_action` (allowlist action NOTE/CANCELLED_NOTE/MANUAL_LOG, derive org từ parent) TRƯỚC
