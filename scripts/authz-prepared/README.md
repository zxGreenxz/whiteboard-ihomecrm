# authz-prepared — PREPARED SQL cho chương trình authorization (KHÔNG phải migration)

> **TUYỆT ĐỐI KHÔNG apply thư mục này lên production.** Đây là exact reviewed
> source đã compile/behavior-test trên **disposable PostgreSQL 17 harness**
> (restore từ portable dump `9f750d9f…604b`, cluster local 127.0.0.1:55432).
> Production apply yêu cầu: owner gate theo đúng tranche (SHA + migration
> SHA-256 + maintenance window + canary/cap), tách từng file thành timestamped
> migration, chạy qua workflow hardened `psql --single-transaction` — xem
> `docs/authorization/T2-RBAC-SOURCE-OF-TRUTH.md` và `T3-APPROVAL-CONTRACT-V2.md`.

## Trình tự cài đặt (harness)

```text
(restore dump + globals + pre-fns + replay 20260716120100 seed)
→ t2_01_registry_override_possession.sql   -- registry metadata, override lifecycle, possession, emergency
→ t2_02_backfill_owner_and_candidates.sql  -- fail-closed backfill: scope edges, TENANT_OWNER, candidates
→ t2_03_resolver_v3.sql                    -- authorize_tenant_action_v3 + lock_org_for_decision_v1
→ 20260716120200 (T5-infra, đã APPLIED prod) + 20260716180000 (artifact BLOCKED)
→ t3_01_role_sidecar_claim.sql             -- role ie_canonical_writer, sidecar, claim helper, full freeze
→ t3_02_wrapper_reown.sql                  -- re-own wrapper + grants/policies tối thiểu
→ t3_04_audit_chain.sql                    -- durable audit + SHA-256 hash chain (A.5) + writer-monopoly guard
→ t3_05_receipt_rpc.sql                    -- attach_payment_receipt_v1 atomic (A.7) + payments canonical guard
→ t3_03_writer_with_claim.sql              -- writer với T3 claim + audit qua chain primitive (GENERATED — sửa build-t3-03.mjs)
```

> **Thứ tự:** t3_04 (audit chain) phải cài TRƯỚC t3_03 vì writer regenerated
> gọi `append_income_expense_event_v1` thay cho direct audit INSERT (guard
> writer-monopoly sẽ reject direct INSERT). build-t3-03.mjs đã sinh đúng lời gọi.

## Kết quả test trên harness (2026-07-17, exact-source restore)

| Suite | Kết quả |
|---|---|
| `t2_90_resolver_decision_tests.sql` | 14/14 PASS (owner allow, dimension-missing deny, cross-org, stranger, possession gate, ORG-mode DENY, revoke/re-grant lifecycle, scoped DENY, emergency deny + future activation deadline, unknown key, cashbook A≠B) |
| `t3_90_containment_tests.sql` | 14/14 PASS (capability gate 42501, claim, double-claim, parent/item freeze mọi op, legacy approve không promote, sidecar immutable, replica-mode ALWAYS, upsert arm, legacy unmarked tự do, FK restrict) |
| `t3_91_writer_e2e_tests.sql` | 8/8 PASS (create→claim atomic, marker+event, ledger exactly-once, replay immutable, different-payload 23505, row+items frozen, ACL deny) |
| `t3_92_concurrency_tests.mjs` | 3/3 PASS (duplicate-key race 2 session → 1 voucher/1 op/1 marker; claimant-abort handover; freeze race cross-session 55000) |
| `t3_93_audit_chain_tests.sql` | 6/6 PASS (chain link, verifier valid, unchained-INSERT reject, append-only, client RPC routes-through-chain + lifecycle-forge deny, subject-delete audit retention) |
| `t3_94_receipt_tests.sql` | 5/5 PASS (atomic attach payment+voucher, idempotent no-dup, invalid-URL reject, canonical-voucher blocks receipt + direct payment UPDATE/DELETE, stranger deny) |
| `t4a_01_security_matrix.mjs` | 8/8 PASS (cross-org, RBAC DML deny, app_private deny, claim/writer ACL, capability-role invariants, ENABLE ALWAYS, suspended-org) |
| `t3_95_approval_v2_tests.sql` | 10/10 PASS (maker-checker deny self-approve, version-CAS conflict, snapshot-hash revalidation, exactly-once posting, re-decide-after-POSTED deny, reversal linked+negated+REVERSED-once, double-reversal deny, self-approve 0-limit deny, no-possession deny, possession+within-limit posts) |
| `t5_90_rollout_cas_tests.sql` | 8/8 PASS (stale-CAS 40001, ON-without-identity deny, CANARY-without-window deny, valid ON bumps+events, monotonic reuse deny, event append-only, cap negative-amount deny, cap append-only) |
| `check-definer-acl.mjs` | PASS (100 khớp baseline, không exposure mới) |
| Money reconciliation | payments sum khớp baseline 100%; income_expenses chỉ lệch do voucher test (harness-only residue, DB disposable) |

| `t3_96_candidate_tests.sql` | 7/7 PASS (materialize 3 candidates exclude maker, generation bump, close prior gen, current-gen eligibility, QUORUM(2) satisfaction, impossible-quorum fail-closed, zero-candidate fail-closed) |
| `t3_97_emergency_tests.sql` | 6/6 PASS (short-reason deny, stale-reauth deny, non-owner deny, valid owner posts+bypass+event, event append-only, re-emergency-after-posted deny) — validates T2 resolver grants `approvals.emergency_override` via TENANT_OWNER binding |
| `t3_98_rule_governance_tests.sql` | 7/7 PASS (publish-without-fallback deny, publish→ACTIVE, unique resolution, published-rule immutable, v2 retires v1 atomically, retired-set undeletable, no-ACTIVE fail-closed) |
| `t3_99_transition_tests.sql` | 5/5 PASS (direct transition frozen, token-authorized posts, token no-leak, forged-token cannot alter payload, items stay frozen) |

**Tổng: 132 assertion PASS across 16 suite (14 SQL + 2 JS) trên exact-source restore.**

## Slice bổ sung vòng 2 (2026-07-17, sau audit đối kháng 10-luồng)

Vòng re-audit tìm ra bug mà test xanh bỏ sót — đã sửa + thêm slice:

```text
→ t3_11_submit_request.sql             -- submit_financial_request_v1: front-half approval engine
                                          (rule eval AUTO_POST/DENY/REQUIRE_APPROVAL, submission_no,
                                          steps + candidate materialization, idempotent). e2e 7/7.
→ t1b_01_record_payment_v4.sql         -- T1b hardened payment: authorize (thu_tien.collect) TRƯỚC
                                          idempotency, org-derived-from-building, durable ledger claim,
                                          same-key/diff-payload 23505, org-stamp mọi effect, atomic. 7/7.
→ t5_02_invoice_reversal_writers.sql   -- create_invoice_v1 (server-decide APPROVED/DRAFT từ
                                          auto_approve_invoice, live partial-unique period) +
                                          reverse_invoice_payment_v3 (FORWARD-FIX: không hard-delete —
                                          refund voucher 'Tiền thối' mà recompute trừ; payments có
                                          CHECK amount>0 nên không dùng negative payment; anti-double +
                                          idempotent replay). 6/6.
```

**Defect audit đã sửa (test cũ bỏ sót):** decide bỏ qua quorum/eligibility/multi-step
(C1/F2/H5) → giờ enforce đầy đủ; transition guard denylist→allowlist (Finding 1/2);
self-approve force-class từ item type + exact permission + anti-split (H3/H4/M8);
snapshot fail-closed (H2); rule-set immutability allowlist + fallback-đúng-một (H6/M7);
AMBIGUOUS candidate CHECK (F13, sẽ abort trên prod data); restore_income_expense
audit qua chain (F1); resolver pre-lock trong materialize (F12); maker exclude theo
user_id (M10).

## Slice bổ sung (approval engine đầy đủ + rollout)

```text
→ t3_06_approval_v2_statemachine.sql   -- REVERSED state, exactly-once posting (GET DIAGNOSTICS),
                                          snapshot revalidation, maker-checker, self-approve-within-limit
                                          (held-cashbook + versioned limit), reversal link; posting
                                          transition qua t3_10 cho canonical rows. Private, non-callable.
→ t3_07_candidate_materialization.sql  -- materialize candidate từ approval_step_approvers (MEMBER/ROLE/
                                          PERMISSION/CASHBOOK/AREA/BUILDING) qua T2 resolver; generation
                                          bump; ANY/ALL/QUORUM satisfaction; fail-closed zero/impossible.
→ t3_08_emergency_override.sql         -- emergency_approve_financial_v1: OWNER + reason≥20 + reauth +
                                          resolver-checked + owner-không-là-maker; bypass steps; event ledger.
→ t3_09_rule_governance.sql            -- publish_rule_set_v1 DRAFT→ACTIVE→RETIRED atomic; published
                                          immutable; resolve_active_rule_set_v1 fail-closed unique.
→ t3_10_canonical_transition.sql       -- freeze-exempt transition qua transaction-scoped token
                                          (KHÔNG GUC/identity); payload vẫn frozen kể cả khi authorized.
→ t5_01_rollout_cas.sql                -- set_feature_route_v1 CAS + release-identity gate + event;
                                          cap/event ledger append-only + non-negative CHECK.
```

> **Thứ tự cài thêm:** t3_10 (transition) TRƯỚC t3_06 (posting gọi nó); t3_07/08/09 độc lập sau t3_06. Trên harness reinstall theo dependency order — xem lệnh trong session log.

## Còn thiếu trước khi bất kỳ file nào thành migration

- Fresh evidence phải chạy lại trên đúng revision cuối (hash bind trong EVIDENCE-INDEX).
- `CREATE UNIQUE INDEX CONCURRENTLY` cho `income_expenses_org_id_uidx` ở bước non-transactional riêng (harness dùng plain build).
- Trên Supabase: `revoke ie_canonical_writer from postgres` sau ownership transfer (harness để nguyên vì postgres local là superuser).
- Audit-chain (A.5), approval state machine v2, receipt RPC, rollout CAS RPC: chưa nằm trong bộ prepared này.
- Owner gate + canary/cap + window cho từng slice; recovery `VERIFIED` cho money cutover.
