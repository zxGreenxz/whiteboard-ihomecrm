# Tranche specs — cross-tranche review notes (T2–T9)

> Review độc lập ngày 2026-07-16 trên 8 draft tranche spec (`IN_DESIGN`). Đây là lớp đối chiếu (reconciliation) — KHÔNG phải approval apply. Recovery `PARTIAL/BLOCKED`, production gate **NO-GO**. Các mục (a)–(e) ở cuối là việc owner cần chốt trước khi bất kỳ spec nào rời `IN_DESIGN`.

---

# Review: 8 draft tranche specs vs TRANCHE-TEMPLATE + AUTHORIZATION-PLAN §27

## Cross-cutting findings (read first)

**(3) CRITICAL — production-apply gate: all 8 specs PASS.** Every spec's header (or, for T4a/T9, the header plus §6) explicitly blocks any production apply/flip/drain/revoke until `recovery = VERIFIED` **and** owner supplies commit SHA + migration SHA-256 + maintenance window + canary count + VND cap (default `0` = no flip). No spec implies or enables an apply without that gate; all SQL is fenced and marked "không đặt vào `supabase/migrations/`". Minor: T4a and T9 enumerate the four owner-supplied fields only in §6/§0, not the top banner — tighten so the header alone is self-sufficient.

**(1) Dependency inconsistency — T2 ↔ T6a is bidirectional.** The chain orders `T2 → T6a`, and T6a correctly lists T2 as an upstream dependency (RLS v2 shadow needs T2 helpers). But **T2 also lists T6a as a blocking dependency** ("T2 và T6a chia sẻ derivation `organization_id`"). As written T2 can never start. Fix: demote the T2→T6a link to a soft "coordinate `organization_id` derivation" note, not a hard blocker.

**(1/4) Ordering deviates from §27.3 / §27.5 and the tracker doesn't map.** §27.3's linear order is `T2 → T3 → T4 → T5 → T6 → T7`; §27.5 has single rows `T4`, `T6`, `T7+`. The drafts (per the task chain) move org-integrity **before** T3 (`T6a → T3`), split T6 into T6a (integrity/shadow, early) + T6b (cutover, bundled with T7), and treat T4a as parallel-after-T0. This is a defensible refinement but it **contradicts the authoritative §27.3 sequence and the §27.5 tracker rows**. Needs an explicit owner-acknowledged tracker update, otherwise §27.5 rows (`T4`, `T6`, `T7+`) no longer correspond to the specs.

**(1/4) Existence conflict: `authorization_migration_exceptions`.** T2 §1 asserts it was **created in Sprint 1 and is APPLIED** (and T2 §4.1 inserts into it as existing). T6a's open_questions + §4.1 say it **does not exist in the repo** and proposes `create table if not exists …`. Two specs disagree on live reality. Must be reconciled against the live catalog before either prepares; also settle whether T2 or T6a owns the fail-closed queue (both claim/question it).

---

## Per-tranche

**T2 — RBAC source-of-truth**
- Remove the hard T6a back-dependency (see cross-cutting).
- `authorization_migration_exceptions` existence + ownership conflict with T6a (see cross-cutting).
- §2 "Deployed frontend SHA" left `<chưa có>` though T2 doesn't flip FE — mark `n/a` (as T3/T6a do) so it isn't read as a required FE deploy.
- Template coverage: complete (all 8 sections, all sub-bullets, + appendices).

**T3 — Approval contract v2**
- Four permission keys (`income_expenses.self_approve_within_limit`, `cashbooks.post`, `approvals.emergency_override`, `income_expenses.reverse`) are unseeded and back an FK (`approval_step_approvers.permission_key`). Hard blocker; **and the seed-ownership boundary between T2 and T3 is unresolved** — pin it before prepare.
- Posting source-of-truth (keep `income_expenses` ledger vs new append-only `financial_posting_events`, §12.7) is undecided; the double-post/reversal-link guard design can't be finalized until owner picks. Flag as prepare-blocking.
- Deposit 24h-hold: T3 defines only the state contract; confirm in writing that the exclusion constraint/writer is T5 (currently only cross-referenced).
- Coverage: complete (§0 + §1–8, §4 fully expanded 4.1–4.16). Aligns with §27.2 maker-checker/force-approval/emergency decisions.

**T4a — Harness**
- Section renumbering (business-behavior pulled into its own §2) shifts §2–§9 off the template's numbering; content is present but reviewers must remap. Cosmetic.
- Hard ceiling: concurrency / rollback-injection / real-JWT tests need a staging/restore target that recovery-BLOCKED prevents — T4a can only reach `PREPARED`, never full evidence, until staging exists. State this ceiling in the header.
- Full-domain reconciliation expansion depends on owner naming the source-of-truth per money domain (payments/credit, deposit, salary/profit, meter→invoice) — currently only INCOME/APPROVED is covered. Real gap.
- Keep the "merge harness ≠ recovery gate" softening tightly scoped: a merged-but-unrun harness must never be cited as gate-opening (spec says so via the INCONCLUSIVE abort — keep it prominent).

**T5 — Canonical writers**
- `auto_approve_invoice` **default is already fixed by §27.2.1 = APPROVED (ON)**; T5 lists the default itself as an open question. Only the storage location is open — assert default ON to avoid drifting from §27.2.1.
- 24h-hold schema/exclusion constraint doesn't exist; make explicit that T5 creates the exclusion constraint + writer while T3 owns the state contract.
- `useDeletePayment` currently hard-deletes payments/excess_amounts — direct conflict with §27.2.3; T5 correctly targets reversal but leaves "keep hard-delete for super-admin repair?" open. Owner decision needed.
- `useSalaryPayout` direct `payments` insert (double-writer) must route through `record_invoice_payment_v3` (T1b) — depends on T1b VERIFIED.
- Domain-slice apply order unresolved; fix to prevent half-migrated `income_expenses` orphans. Coverage otherwise complete.

**T6a — Organization integrity + RLS v2 shadow**
- Table classification for ~132 tables (TENANT_MONEY/PII vs SHARED_GLOBAL/PLATFORM) has no source-of-truth yet — hard blocker for any NOT-NULL decision; owner/T2 must classify.
- `authorization_migration_exceptions` / `authorization_rls_shadow_log` existence conflict with T2 (see cross-cutting).
- Ordering: must backfill + NOT NULL money/PII tables **before** dropping the NULL-tolerant boundary branch, or valid NULL-org rows get denied — spec's §7 abort covers it; make the sequence a numbered precondition.
- authorize_v2 shadow-log sink ownership (T2 vs T6a) unresolved. Coverage complete (§1b before/after table is a useful add).

**T6b-T7 — Canary/cutover/drain/revoke**
- Feature-flag/canary infra does not exist (no `feature_flag` table, no `auto_approve_invoice` column). T6b-T7 depends on a server-enforced flag that T5/T6a must build first — name the owning tranche; today it's a dangling dependency.
- Idempotency-key-per-call (`crypto.randomUUID()` at 3 sites) correctly made a hard precondition for T7 payment, but the fix lives in T1b/T5 (not in this batch) — confirm those specs commit to `org+operation+subject+caller+key` stable keys.
- `excess_amounts` split-effect (inserted outside the atomic RPC) — ensure T5/T1b gathers it into the canonical writer before payment canary.
- Edge/cron caller inventory for salary/profit not enumerated — required before revoking that domain. Coverage complete; correctly restates §27.1 ("flag OFF / 0 UI caller ≠ security boundary").

**T8 — Storage/R2/Edge/service + DEFINER ACL burn-down**
- SECURITY DEFINER count mismatch (baseline `100` anon vs §4.1 `110/246`) and baseline tracks only `anon`, not `authenticated`-callable — burn-down target is undefined until a live refresh; state the target metric.
- `storage_object_links` doesn't exist; depends on T2 authorize + T6a `organization_id` (consistent with chain position after T6a).
- Worker `/sign` returns 501 (Phase 2) — scope ambiguity: does T8 implement Phase 2 or split a sub-tranche? Owner must decide.
- Zalo VPS `worker/index.js` (service-role key, bypasses RLS) is in-scope for service-identity inventory but unreadable in repo — inventory is incomplete until path/host supplied.
- R2 `REFERENCED_OBJECTS_ONLY` blocks orphan enumeration → affects T8 recovery-VERIFIED and T9 orphan cleanup (cross-tranche). Coverage complete (renumbered §1b table).

**T9 — Retention, cleanup, final restore certification**
- "1 full business cycle" is unquantified — must be defined before the retention clock can start.
- Drop-list vs keep-forever not enumerated (esp. legacy `record_invoice_payment_v2`/`_atomic`) — owner must produce the explicit list.
- Storage/R2 retention window (days) undefined.
- **Terminal-gate risk:** final restore certification requires an independent blank-target restore + 3 real fault domains, but the owner's 2026-07-16 "local-only" decision + the current 3 replicas on one physical disk (D:) make recovery-VERIFIED for T9 potentially unachievable as scoped. This is the program's closing blocker — surface to owner now.
- `useCreatePayment`/`useRecordPayment` dead-path not runtime-verified (grep still shows refs) — §3 correctly demands zero-traffic proof before drop. Coverage complete (§0 invariants + §1–9).

---

## Overall verdict

The batch is **structurally sound and safe on the one non-negotiable axis**: no spec enables a production apply without recovery=VERIFIED + owner window/canary/VND cap, none plant live migrations, and all eight cover the full template (T4a/T8 renumber but omit nothing; T3/T5/T6a expand it). §27.2 business decisions (auto-approve, locked revision, compensating reversal, maker-checker/self-limit, 24h hold, per-invoice-atomic bulk, suspend≠delete) are faithfully reflected.

**Blockers before any of these leave IN_DESIGN:** (a) resolve the T2↔T6a bidirectional dependency; (b) reconcile the `authorization_migration_exceptions` existence/ownership conflict between T2 and T6a against the live catalog; (c) get owner sign-off on the §27.3/§27.5 reordering (T6a-before-T3, T4a/T6a/T6b split) and update the tracker; (d) close the "unbuilt infra" dependencies that later tranches silently assume — permission-key seeding (T3), feature-flag/canary infra (T6b-T7), table classification (T6a); and (e) escalate the T9 local-only-vs-blank-restore terminal-gate conflict. These are governance/consistency gaps, not safety regressions. **Status: NO-GO for apply (as intended); GO to circulate for owner review once (a)–(e) are annotated.**