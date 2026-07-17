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
| `check-definer-acl.mjs` | PASS (100 khớp baseline, không exposure mới) |
| Money reconciliation | invoices/payments khớp baseline 100%; income_expenses +3 voucher test concurrency (harness-only residue, DB disposable) |

**Tổng: 58 assertion PASS across 7 suite trên exact-source restore.**

## Còn thiếu trước khi bất kỳ file nào thành migration

- Fresh evidence phải chạy lại trên đúng revision cuối (hash bind trong EVIDENCE-INDEX).
- `CREATE UNIQUE INDEX CONCURRENTLY` cho `income_expenses_org_id_uidx` ở bước non-transactional riêng (harness dùng plain build).
- Trên Supabase: `revoke ie_canonical_writer from postgres` sau ownership transfer (harness để nguyên vì postgres local là superuser).
- Audit-chain (A.5), approval state machine v2, receipt RPC, rollout CAS RPC: chưa nằm trong bộ prepared này.
- Owner gate + canary/cap + window cho từng slice; recovery `VERIFIED` cho money cutover.
