# T6R — shared reservation pending/refund workflow

Review base: 14bfaae0bac7e78f42c0ef2fd2e7f14f0521e86f. Owned implementation only; root integrates the source form and owns generic controller review follow-ups. No shared schema/business writes, no service-role writer tests. Disposable PostgreSQL17 localhost55488/postgres and PostgREST16.3 localhost55489 only. Fixture organizations/users randomized and cleaned.

## Delivered behavior

- Existing LATER remains an obligation. Explicit pending creation creates exactly one REFUND leg/voucher, UNAPPROVED/PENDING/UNPOSTED with NULL account, no posting or cash effect. Recipient name/bank/account are captured at birth. Full remaining is frozen from the real ledger; no editable amount or retained split in the new form.
- Shared snapshot carries authoritative nullable reservationRefund capability (settlement/source/basis/current/full remaining). Missing/invalid capability never enables reservation money actions. Only current REFUND gets approve-only, atomic approve+post, post-only, request changes, same-ID resubmit and reverse. Source voucher/OFFSET/REVENUE/edit/cancel/unapprove remain guarded.
- Shared controller dispatches those six commands to execute_reservation_refund_action_v1 using original selected identity, all three CAS versions, frozen source basis/remaining and caller key. Existing shared evidence, dialogs, custody and refresh/unknown behavior remain. No generic fallback after source refusal.
- Request changes and resubmit reuse shared review semantics under a narrowly proven outer reservation operation/token. ID, code, total, source remain unchanged; review cannot patch financial fields, approve or post.
- The specialized backend opens the existing settlement token only after actual source RLS + room→org→source→settlement locks, received proof/basis and source-claim checks, flow ownership, permissions and current route. It delegates to existing canonical money/review writers. Canonical posting gets RESERVATION_REFUND source_kind only inside the exact outer operation/token; generic reservation guards are unchanged.
- Old NOW/pay retains immediate approve/pay semantics. Its REFUND birth reuses the pending core and then performs its original account/approval/posting work. Old pay rejects an existing live pending or approved-unposted refund rather than creating another leg. Old reversed historical legs and old/new-key behavior remain covered.

## Binding permission matrix

| Operation | Required authority before cached replay |
|---|---|
| Pending create | active source/building access + deposits.refund; no approve |
| Approve / atomic approve+post / request changes | source access + income_expenses.approve; atomic also real custody |
| Post-only | source access + exact real cashbook custody/period; no approve/deposits.refund/edit |
| Reverse | source access + income_expenses.reverse + original cashbook custody/period |
| Resubmit | source access + original maker; maker-NULL legacy requires income_expenses.edit |

All operation authorities are checked before replay. Existing NOW/pay still needs deposits.refund and approve. Ownership is never relabeled and the generic owner guard is not bypassed.

## Root integration API and metadata ownership

Component: src/components/thu-tien/ReservationRefundCreateForm.tsx.
Props: sourceRef: Extract<SettlementSourceRef,{kind:'reservation_refund'}>, onCreated({outcome:'created'|'existing',voucherId}), refreshRequired:()=>Promise<void>, onBusyChange?:(blocked:boolean)=>void.
Include all union fields (organizationId, sourceVoucherId, settlementId, refundVoucherId); nullable fields stay nullable. It opens an authoritative existing voucher through onCreated after required refresh, never creates/resubmits on an existing claim. RHF+Zod validates recipient/bank pair; unknown outcomes remain locked and reconciliation only reads.

New production modules for root strict registry: reservationRefundWorkflow.ts, reservationRefundRepository.ts, useReservationRefundCreate.ts, ReservationRefundCreateForm.tsx. Direct strict compilation of these four and transitive imports passed. Unit tests are app-unit. New local operator harnesses: scripts/test-reservation-refund-workflow-local.mjs, scripts/test-reservation-refund-workflow-schema-local.mjs, scripts/test-reservation-refund-workflow-mutations-local.mjs. Root owns global test-matrix/strict registration, generated types/surfaces/provenance and shared release gates.

Migration: supabase/migrations/20260921015956_reservation_refund_pending_workflow.sql (official generator allocation). Before/after definition hashes and exact owners/ACLs pin all reused writers/helpers, exact source trigger definitions/enabled state, token write isolation and existing no-login reader role. No new table or broad private grant. New function ownership explicitly postgres or existing least-privileged reader; non-superuser first/reapply proved this (an initial default-owner defect was caught and fixed).

## Verification evidence

All Node commands used exact Node24.18.0 via npx --yes --package=node@24.18.0 node.

- TDD RED: missing pending/action RPC; old pay actually created a duplicate live REFUND; policy/context rejected valid reservation review/money; controller called generic hooks; missing form/hook. Each was observed before implementation, then GREEN.
- Local JWT harness exit0: pending birth/no money/recipient; two creation windows same ID/one leg; source permission revoked before pending replay; old-pay duplicate rejection; request/resubmit preserves ID/code/amount/source and no approval/posting; maker versus legacy edit and expired membership; generic approve denied; approve-only with no refund authority; FINALIZED evidence/custody/period/CAS; post by a distinct non-maker actor with only view permissions + exact custody; reverse/refund obligation; old cached posting key after reverse no repay; two fresh payout windows exactly one posting; partial obligation 40 of received100 pays full remaining40; locked atomic rollback; unchanged NOW and old pay reverse/new-key semantics; source/leg manual SQL freeze; hidden pending ID omitted; received basis drift; forged token denied; actual reader JSON parsed by production TS and exact claim adapter.
- Actual JWT contract creation positive control then concurrent contract-signing versus settlement: exactly one source consumer, no deadlock. Cross-org source/action and non-maker resubmit denied.
- Schema harness exit0: exact predecessor first apply + reapply; all definition pins; modified/new ACL drift; reader role, source trigger and token ACL drift; transitive STABLE checker; first/reapply under NOSUPERUSER CREATEROLE BYPASSRLS deployment principal modeling measured shared privileges. All rehearsals rolled back.
- Four backend mutations killed by actual JWT harness; exact DB definitions restored in finally. Reuses bam/bienDoi from scripts/dot-bien.mjs. Source permission digest00474f84fc0f→8b48d8bb8fb6; remaining CAS00474f84fc0f→8531cbcf5b8a; old-pay pending guard209487372276→697769a04966; posting CAS339dfc8eb663→60a770376c9c.
- scripts/dot-bien.mjs CLI snapshot remaining/total validator mutation: digest0aeebf72664f→9cd604742d01, snapshot test RED by exact test name, restored digest, exit0.
- Scoped UI/domain/controller + existing reservation regression: 10 files /182 tests PASS; repository result validation11 additional tests PASS (193 total distinct tests). Includes approve/post/atomic/reverse specialized dispatch, no fallback, mandatory refresh, synchronous double-submit lock and unknown outcomes. Existing reservation UI warnings about Dialog description/React Router future flags were observed; no failing assertions.
- Full app tsc -p tsconfig.app.json --noEmit exit0 (session15520). Direct new-module strict tsc using ignored t6r-strict.json exit0. Owned TS ESLint exit0. git diff --check clean.

## Remaining integrated/release work (not claimed complete)

Root must wire the new source form into ContractSettlementModal/page; this commit deliberately does not edit that file or PeriodFee/T10. Shared Thu chi hosts inherit commands through the existing controller, but browser E2E for the integrated new entry has not run. No shared apply/live DEMO fixture, production reconcile-money v1/v2, preview build/bundle, backup/deploy, PR or production release in this task. New reader/source permissions are fail closed pending reviewed migration deployment; no synthetic legacy route fallback. Root's separately identified generic canonical-only and partial-cancel findings are untouched.
