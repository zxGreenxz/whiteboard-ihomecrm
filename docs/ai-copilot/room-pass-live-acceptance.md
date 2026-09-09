# Room-pass live acceptance operator contract

Task17 source harness for the Task16 room_pass.set_active contract. Source tests are not live acceptance. The CLI defaults to a dry-run inventory; --prepare allocates a durable journal without contacting a server. Live execution is an explicitly imported operator API, not a credential-loading CLI.

## Operator wiring

Import runRoomPassAcceptance from scripts/copilot-room-pass-live-acceptance.mjs. Supply a prepared run and journalPath, ordinary authenticated transport, a distinct authorized adminTransport/adminActorId for DEMO member authorization, disallowedTransport/disallowedActorId, reviewed management transport, browser callback, and admission. Admission contains reviewed=true, sourceSha, buildSha, organizationId=DEMO, actorId and administrativeFixtureReviewed=true. Root must independently verify these assertions and the deployed build before invoking it.

createRoomPassTransport accepts explicit in-memory credentials, verifyTerminal and readFlag callbacks. Wire readFlag as context => readRoomPassFlag(management, context). This exact action-row administrative SELECT also reads the rollout sequence; authenticated has no SELECT privilege on copilot_feature_flags. All flag transitions still use authenticated set_copilot_feature_flag_v2 CAS. No privilege grant is needed.

For createRoomPassManagementTransport, supply executeManagementQuery from scripts/apply-accounting-rollout.mjs. Its bounded failure envelope is exercised by the session tests and recognized by the denial decoder; similarly named helpers with other envelopes leave failures unknown. Each authenticated SQL participant calls txid_current before action execution, making its distinct transaction visible even while waiting to acquire the nonce row lock.

The browser callback owns one headless Playwright process for .e2e-fleet/specs/copilot-room-pass-consent.spec.ts, with FLEET_ROOM_PASS_JOURNAL and existing build/model/fleet controls. It must verify process termination, successful exit, build attestation and the safe emitted receipt, then return the exact fields checked at the callback call site. It must not fabricate a receipt from source tests. The spec pins DEMO through an init script, reloads after login to restore the choice cleared by unauthenticated organization bootstrap, and verifies the actual DEMO availability response before model calls. Existing fleet trace and screenshot restrictions apply.

## Fixture and control ownership

The isolated browser sets the existing actor-specific `schedNotif:lastRun` localStorage throttle before login. This defers the dashboard's unrelated daily notification writer in that browser only; it neither changes server settings nor exempts notification writes from the guard. The browser proof covers Copilot consent, not the dashboard scheduler.

Every ID and intended mutation is persisted before a request. Two owned DEMO buildings, one room and an inactive canonical listing use synthetic contacts. Cleanup performs a fresh confirmed hide, canonical listing delete, then UI-style soft deletion of the room and buildings; three parent tombstones and immutable audit/ledger history remain. Concurrent/unowned rows stop cleanup. The journal records every retained ID.

Flag activation is action-scoped, DEMO-only, expiring within 15 minutes. It starts disabled, renews before long phases, and finishes disabled. CAS refuses concurrent control changes. Original semantic metadata is restored when possible through a permitted transition; historical revisions/timestamps cannot be erased. Already-disabled controls are not reopened to restore metadata.

Emergency fixtures are new exact owned IDs only, with bounded clocks and whole-row CAS removal. Existing emergencies are untouched. Scoped revocation creates one owned authorization scope and uses the existing authenticated member API to add/remove a short-lived scoped DENY. It preserves roles and rejects concurrent membership/binding changes. This tests DEMO scope removal, not removal of the global superadmin role. Revoked authorization history and its scope are retained.

## Acceptance and recovery

The exported REQUIRED_CASES enumerates 25 mandatory cases: fresh consent, replay, second stale nonce, ABA, active uniqueness, role and scope denial, flag and emergency controls, three real plan paths, actual browser consent, independent-session races and lock-wait clock expiry. Success requires every case plus fixture cleanup and disabled control restoration.

Independent SQL calls use ordinary authenticated role and distinct observed backend/transaction IDs. The holder must be seen sleeping after acquiring owned row locks, and the executor must have an actual blocking edge before releasing it. Promise overlap or PGlite tests do not establish this proof. Query text, credentials, contacts and nonces are not persisted.

Unknown transport/process outcomes block further business writes. recoverRoomPassRun is cleanup-only and requires independently verified terminal evidence for the original operator, unknown requests, SQL sessions and browser before reconciliation. No original setup request or consent nonce is retried. Exact ownership/CAS readback precedes compensation. The journal lock is deliberately retained after uncertainty; only the operator may clear it after independently proving all old processes/transactions terminal. A timeout alone is not evidence.

## Continuing completed cases

After a failed run is terminal and its cleanup is verified, pass `resume: { journalPaths: [latestJournal, ...ancestorJournals] }` to the operator API. Every path must be an actual durable journal, starting with the latest run and including its complete ancestry. The loader rejects unfinished controls, unknown operations, mismatched actor/org/source/build, missing ancestors, cycles, duplicate IDs and missing original case proofs before any request or lease is acquired. It keeps original counts, plan IDs, browser build proof and observed lock barriers, with the origin journal's SHA-256 digest. Later continuations recheck those digests. A list of pass labels is not accepted as evidence.

The first three toggle/replay cases and the two scope-revocation cases are journaled atomically. Historical prefixes stopping inside one of those groups are rejected before writes. Recovery remains cleanup-only; acceptance continues in a new owned fixture after recovery, keeping verified completed cases. A new control transition clears any earlier `restored` claim before its CAS request is sent.

## Verification limits

The [September 9 live acceptance receipt](../generated/copilot-room-pass-acceptance-2026-09-09.json) records completed Task17 cases, original journal digests, runtime build, harness source digests, fixture cleanup and disabled control restoration. Its scope is this action only; full-plan acceptance remains false.

Injected transport tests exercise safety oracles, journaling, cleanup and observed-session orchestration. Local PGlite exercises exact emergency fixture SQL/CAS only. Root must review administrative SQL, wire real transports and independently verify browser/process evidence before any live run. This source delivery does not prove live concurrency, real browser completion, deployed behavior, or acceptance of the wider project.

## R1 recovery and browser regressions

Pending flag reconciliation is independent of the HTTP acknowledgement: a successful CAS followed by failed readback still requires verified terminal evidence under pending.operationId (or control:<runId> if execution never acquired an operation ID). Exact old/intended metadata and revision are checked before adoption. A rejected CAS can reconcile only to the unchanged old row. Acknowledged CAS cannot be treated as absent. Concurrent changes remain an operator conflict. Pending controls also retain the journal lease.

The browser guard chains reads through route.fallback so the actual model pin remains active. POST is also used by read RPCs: the guard explicitly allows reviewed dashboard reports with known argument keys, empty-argument identity reads, and DEMO-scoped availability/auth/memory reads. Business writes default to denial, with explicit exceptions for exact owned room-pass preview, fresh actor/DEMO chat thread creation and messages belonging to a thread created by this browser. Only one exact nonce/payload executor is allowed after click; all other direct/domain/RPC writes are counted and aborted. Unknown necessary runtime calls require source review of the allowlist, not a broad bypass.

Run node scripts/check-room-pass-browser-loopback.mjs for the real headless Chromium route-order regression. It binds only 127.0.0.1, rejects external origins, imports the actual model-pin and guard helpers, and proves financial writes never reach its synthetic server. It requires a locally installed Playwright Chromium; it does not load fleet credentials or invoke a model. CI Node tests exercise the guard behavior without requiring Chromium.
