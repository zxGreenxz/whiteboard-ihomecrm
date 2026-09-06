# Copilot ledger evidence audit

Run `scripts/copilot-ledger-audit.mjs` with an authenticated superadmin account.
The script logs in through GoTrue using the publishable key in `.env`; business
data is read only through `copilot_ledger_audit_page_v1`. Service role and Management
API tokens are not used. Deploy the forward migration
`20260906144028_copilot_ledger_audit_read_v1.sql` through the reviewed migration lane
before running this version. Existing UI RPCs remain compatible.

Set `COPILOT_LEDGER_AUDIT_SYSADMIN_EMAIL` and
`COPILOT_LEDGER_AUDIT_SYSADMIN_PASSWORD` locally, then run:

```powershell
node scripts/copilot-ledger-audit.mjs --org dddd0000-0000-4000-8000-000000000001 --since 2026-09-01T00:00:00Z --until 2026-09-06T00:00:00Z --out evidence/copilot-ledger.json
```

The bounds are inclusive lower/exclusive upper, shared by both source streams.
`--days 14` supplies a lower bound relative to `--until` (or the run start time).
An explicit `--since` overrides days. Maximum window: 366 days. Timestamps must
include timezone. Pagination preserves PostgreSQL microseconds and uses
`(created_at, id)`; tenant filters exclude global policy events. Registry and
window counts are checked on every page; drift or a missing page fails closed.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Complete evidence for the requested window, no detected violations |
| 1 | Invalid configuration, bounds or authentication before report creation |
| 2 | Proven violation(s); also inspect `incomplete` for simultaneous evidence gaps |
| 3 | Incomplete evidence; cannot call the window clean |

The registry comes from the database on each run, including disabled actions.
Every direct L5 step requires valid step-up evidence, or an eligible standing
grant; `pin_always` excludes grants. The existing DB CHECK currently makes all
direct L5 actions non-grantable. This audit does not change that policy.
Plan and ledger actor/org, audit references, and authoritative entity org are
compared without returning other organizations' identities. Only registry-owned
public entity tables with an organization column can currently be compared;
missing rows, unsupported entities and unreadable sources are explicit gaps.

`action_executed` is a wrapper event and intentionally records click consent.
The engine's correlated `step_done` or `step_unknown_effect` carries actual plan consent. Idempotent
engine replays may reference an older audit without another wrapper event.
The audit checks duplicate audit keys, duplicate wrapper executions for one
audit, duplicate non-replay completions of a plan step, audit-to-ledger coverage,
and DONE/UNKNOWN_EFFECT steps with missing/mismatched ledger pointers. Related immutable audit
and wrapper references may predate the window for replays. A wrapper whose plan
completion is outside the requested bounds is incomplete: widen the bounds.

External actions first commit queue evidence in `step_unknown_effect`; this is
not proof of the external effect succeeding. Pending effects are counted in
`externalEffects.pending` and make the report incomplete. A `step_reconciled`
event has no top-level audit/entity/digest fields: the RPC links it to exactly
one earlier queue execution with matching plan/step/action/org, entity reference,
consent and current step ledger pointer. It reads queue audit/readback evidence
from that origin, and reports terminal DONE and FAILED separately. A reconciliation
by a different actor may be legitimate superadmin work; without historical actor
authorization evidence it is incomplete rather than automatically a wrong-actor
violation. Include the queue execution and reconciliation in the requested window.

Missing historical plans, confirmations, consent kind or readback digest flags
are classified as incomplete, not automatically as proven unintended writes.
Only boolean digest-presence flags are exposed. Raw payloads, digests, PINs,
tokens and digest-bearing idempotency keys never leave the RPC.

This is an evidence-consistency audit, not a reconstruction of arbitrary business
effects. A wrapper may call an already-completed business operation (for example
an existing refund); its event name alone does not prove another money movement.
Distinct audit keys do not prove distinct business effects. Registry and entity
lookups represent current state, not a historical policy snapshot. A historical
query spanning 14 days does not demonstrate 14 days of active canary observation;
`canaryDurationVerified` is always false. Rollout evidence must establish that
duration separately. An empty clean window does not establish exercised coverage.

Focused verification:

```powershell
node --test scripts/__tests__/copilot-ledger-audit*.test.mjs
```

PGlite tests execute the new SQL with real `anon`/`authenticated` roles and a
read-only transaction against a minimal dependency schema. They do not replay
the full production catalog or exercise GoTrue/PostgREST. Before deployment,
run the project catalog, migration-idempotency, generated-types and authenticated
HTTP preflight gates in an appropriately configured environment.
