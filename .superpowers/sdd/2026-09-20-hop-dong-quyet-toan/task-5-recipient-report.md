# T5 recipient editing — implementation and verification

New shared sparse writer update_income_expense_recipient_v1(org,voucher,expected,patch) delegates to the existing ie_compat_update_pending_v2. It authorizes actual visible row through the non-bypass shared snapshot reader, locks org and voucher, reauthorizes current building, requires editable pending/no posting/manual/unowned content, verifies all three recipient fields plus approval/posting/review versions, and accepts only changed payerName/bankName/bankAccount fields. Existing freeze, period and money guards remain. No money/items/account/source/review transition is submitted. Untouched recipient fields and full unrelated header are checked after write.

Existing legacy a86 provenance behavior is preserved only when an actual matching completed canonical birth operation exists; prior provenance cannot change. This is not a new ownership bypass. Frozen canonical or source-owned vouchers remain disabled with reason. Refund creation now needs its own birth-time recipient persistence (T6 owns that separate capability).

Shared UI/controller: editRecipient action uses the same preflight, stable selected snapshot, refresh, busy/uncertain result lifecycle on Thu chi and settlement. RHF/Zod dialog preserves account leading zeros and only submits when values changed. No blind retry after unknown keyless update. Reconciliation checks exact desired recipient plus original money/source/state before closing. Actual Supabase method receiver is retained; receiver-aware hook regression caught a P1 during independent review, then fixed.

Evidence:
- Fresh production catalog READ ONLY: compat writer MD5 c6ed1d47823837349c92e8769932053a, manual guard 99d6511dcfbecc5e1aceafb95693a70b. Artifact task-5-live-catalog.json.
- Local only: PostgreSQL17 settlement_t7 loopback55488 / PostgREST16 loopback55490.
- JWT harness PASS: editable manual update, exact header preservation, two real item identities/full rows preserved, three separate stale-version negatives, stale recipient, concurrent writes one CAS winner, wrong organization, hidden building, no edit permission, approved/owned freeze, forbidden/empty patch. Fixtures removed; final t5-% org count0.
- SQL schema harness PASS: exact reapply, first apply under nonsuperuser role, owner/ACL/definition and reader membership drift, VOLATILE SECURITY DEFINER and authenticated-only EXECUTE.
- SQL body MD5 19d5834bed3c4fdbba5c14967a796ffe.
- CAS mutation via scripts/dot-bien.mjs: source SHA edc8c06835fb -> 080020cc1f46; stale-recipient assertion failed, source restorededc8c06835fb and DB body restored19d5834... . Child Node Windows emitted abnormal exit after assertion; expected assertion text verified, not credited solely on nonzero exit.
- 111 shared UI/controller/policy/service tests9files PASS07:15:39; after receiver fix87 tests5files PASS07:19:24 including actualhook boundary.
- App TS73006 exit0 before receiver lambda fix (type-identical).
- Strict gate45689 exit0: 1318 strict +583 noUncheckedIndexedAccess,0errors. NewT5three +T6six modules registered. Type-only periodFeeOverview.expectedAmount now number|null matching actual hook; existing overview testPASS. No runtime overview behavior change.
- RPCcast0, UIrawRPC0, testmatrix769/11 PASS.
- Live stable-functions scanner printed no read locks but Node crashed on exit first attempt; PTY retry29014 pending. Newwriter volatility proved via local SQL schema/JWT, not by this live scanner.
- Independent backend review task-5-recipient-review.md APPROVED; UI review task-5-recipient-ui-review.md APPROVED after receiverfix.

Pending whole-feature requirements: authenticated browser E2E/visual/console, broader role/custody release matrix, live DEMO writer proofs after reviewed forward lane, shared-schema migration/provenance/type surfaces, full money reconciliation/sandbox leak/build/bundle/release gates, T6R reservation machine, final entry/cutover and production promotion. This chunk is not the entire production goal.
