# Room-pass live acceptance operator contract

Task17 source harness for the Task16 room_pass.set_active contract. Source tests are not live acceptance. The CLI defaults to a dry-run inventory; --prepare allocates a durable journal without contacting a server. Live execution is an explicitly imported operator API, not a credential-loading CLI.

## Operator wiring

Import runRoomPassAcceptance from scripts/copilot-room-pass-live-acceptance.mjs. Supply a prepared run and journalPath, ordinary authenticated transport, a distinct authorized adminTransport/adminActorId for DEMO member authorization, disallowedTransport/disallowedActorId, reviewed management transport, browser callback, and admission. Admission contains reviewed=true, sourceSha, buildSha, organizationId=DEMO, actorId and administrativeFixtureReviewed=true. Root must independently verify these assertions and the deployed build before invoking it.

createRoomPassTransport accepts explicit in-memory credentials, verifyTerminal and readFlag callbacks. Wire readFlag as context => readRoomPassFlag(management, context). This exact action-row administrative SELECT also reads the rollout sequence; authenticated has no SELECT privilege on copilot_feature_flags. All flag transitions still use authenticated set_copilot_feature_flag_v2 CAS. No privilege grant is needed.

The browser callback owns one headless Playwright process for .e2e-fleet/specs/copilot-room-pass-consent.spec.ts, with FLEET_ROOM_PASS_JOURNAL and existing build/model/fleet controls. It must verify process termination, successful exit, build attestation and the safe emitted receipt, then return the exact fields checked at the callback call site. It must not fabricate a receipt from source tests. The spec pins DEMO before login and verifies availability before model calls. Existing fleet trace and screenshot restrictions apply.

## Fixture and control ownership

Every ID and intended mutation is persisted before a request. Two owned DEMO buildings, one room and an inactive canonical listing use synthetic contacts. Cleanup performs a fresh confirmed hide, canonical listing delete, then UI-style soft deletion of the room and buildings; three parent tombstones and immutable audit/ledger history remain. Concurrent/unowned rows stop cleanup. The journal records every retained ID.

Flag activation is action-scoped, DEMO-only, expiring within 15 minutes. It starts disabled, renews before long phases, and finishes disabled. CAS refuses concurrent control changes. Original semantic metadata is restored when possible through a permitted transition; historical revisions/timestamps cannot be erased. Already-disabled controls are not reopened to restore metadata.

Emergency fixtures are new exact owned IDs only, with bounded clocks and whole-row CAS removal. Existing emergencies are untouched. Scoped revocation creates one owned authorization scope and uses the existing authenticated member API to add/remove a short-lived scoped DENY. It preserves roles and rejects concurrent membership/binding changes. This tests DEMO scope removal, not removal of the global superadmin role. Revoked authorization history and its scope are retained.

## Acceptance and recovery

The exported REQUIRED_CASES enumerates 25 mandatory cases: fresh consent, replay, second stale nonce, ABA, active uniqueness, role and scope denial, flag and emergency controls, three real plan paths, actual browser consent, independent-session races and lock-wait clock expiry. Success requires every case plus fixture cleanup and disabled control restoration.

Independent SQL calls use ordinary authenticated role and distinct observed backend/transaction IDs. The holder must be seen sleeping after acquiring owned row locks, and the executor must have an actual blocking edge before releasing it. Promise overlap or PGlite tests do not establish this proof. Query text, credentials, contacts and nonces are not persisted.

Unknown transport/process outcomes block further business writes. recoverRoomPassRun is cleanup-only and requires independently verified terminal evidence for the original operator, unknown requests, SQL sessions and browser before reconciliation. No original setup request or consent nonce is retried. Exact ownership/CAS readback precedes compensation. The journal lock is deliberately retained after uncertainty; only the operator may clear it after independently proving all old processes/transactions terminal. A timeout alone is not evidence.

## Verification limits

Injected transport tests exercise safety oracles, journaling, cleanup and observed-session orchestration. Local PGlite exercises exact emergency fixture SQL/CAS only. Root must review administrative SQL, wire real transports and independently verify browser/process evidence before any live run. This source delivery does not prove live concurrency, real browser completion, deployed behavior, or acceptance of the wider project.
