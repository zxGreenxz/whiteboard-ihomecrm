# P0d implementation report

Implemented scoped, explicit, read-only TEST adapters for the two existing money gate entry points. No application, schema, settlement policy, permission, or P0c baseline files changed. Existing invocation path remains the legacy code path; the new dispatch happens before legacy config/vault reads when `--test-scope` is present.

## Interface

`node scripts/reconcile-money.mjs --test-scope <json-path> --ca-file <pem-path> [--use-vault]`

`node scripts/reconcile-money-v2.mjs --test-scope <json-path> --ca-file <pem-path> [--use-vault]`

Scope is exactly `{ "expectedRef": "<20-character TEST ref>", "url": "https://<ref>.supabase.co", "organizationId": "<uuid>", "month": "YYYY-MM" }`; `month` is optional. Unknown fields/options, UUID subset fields, production ref, ref/URL/credential mismatch, and malformed month reject before authentication/network. Explicit env is `TEST_SUPABASE_REF`, `TEST_SUPABASE_POOLER_HOST`, `TEST_SUPABASE_DB_PASSWORD`; v1 also requires `LIFECYCLE_TEST_EMAIL`, `LIFECYCLE_TEST_PASSWORD`, `TEST_SUPABASE_PUBLISHABLE_KEY`. `--use-vault` may load TEST transport fields and TEST publishable key from the original vault; it never chooses a test actor/password. TLS uses supplied PEM and `rejectUnauthorized: true` through reviewed transport. No PAT is needed in the adapter.

Exit: 0 all assertions pass; 1 known money/source mismatch; 2 invalid config, unsafe input or execution failure; 3 missing data/schema/threshold evidence. Output has only status, reason, counts, digest, ref, mode, timestamp and safe diagnostic code. No amounts, personal rows, JWT, key or password are logged.

V1 independently queries org/date eligible SQL IDs and aggregate. Existing invoker RPC is called with these IDs in bounded chunks under a real TEST actor JWT. REST pages the exact server predicate and compares IDs/count/sum. A-after uses a **new** marker-admitted read-only transaction and reruns the original predicate/digest. V1 requires more than 1,000 actual eligible REST rows and more than one REST page. V2 derives account IDs from `public.accounts` for one org, requires both legacy and V2 view counterparts, compares full-history balances even with a month, and checks scoped posting count/sum/independent SQL ID digest against stable SQL pages in one repeatable-read transaction. V2 requires more than 1,000 posting lines; it is SQL pagination evidence, not HTTP cap evidence.

## Scoped amendment

The reviewed transport rejected uppercase literal values in `type=eq.INCOME` and `approval_status=eq.APPROVED`. The parent authorized modifying only the filter **value** token regex in `selectPage` and `selectAll` to accept `A-Z`, while keeping key syntax, delimiters, and all other allowed characters unchanged. `transport.test.mjs` now proves uppercase enum success and comma, percent-encoded, semicolon and raw OR syntax rejection before fetch. V1 REST uses the same server predicate as A.

## Verification

- TDD red: new reconcile module/export missing, uppercase filter rejected, missing V1/V2 mismatch precedence, unsafe JSON number and SQL organization boundary cases. Green: `npm exec --yes --package=node@24.18.0 -- node --test scripts/tests/contract-lifecycle/*.test.mjs` — 40/40 pass.
- `git diff --cached --check`, `node --check scripts/contract-lifecycle/reconcile.mjs` — pass before code commit.
- Mutation: `scripts/dot-bien.mjs` removed the V1 SQL `organization_id = $1 AND ` predicate; source SHA `35dc1aac696c` changed to `03bd13a66f4d`, targeted suite red on `V1 SQL source excludes`, restored original SHA; helper exit 0. This is a local oracle mutation, not a live SQL/RLS mutation.
- Live TEST at code SHA `2d5d3ae99e65941e063409a3b4b8e599e5a2c312`, Node 24.18.0, copied REAL org in TEST project `hzulujxgonszuleqticb`: v1 exit 0, 2,115 eligible vouchers, 3 REST pages, digest `184e9060c60916c8fd5090e2a4c9b0b023e623a58d6a13188dbaba8b4aa7dc27`; v2 exit 0, 17 real accounts, 3,722 posting lines, digest `8db4526c91a24153c1df7e226307e2dfee4cc6182744119e5e0d9c28d4226299`. Receipt: `docs/generated/contract-lifecycle/2026-09-28-p0d-adapter-runtime.json`. Credential injection was memory-only from the original vault via ignored local runner. No DB writes.

## Commits and remaining limits

- `2d5d3ae9 feat(contract-lifecycle): add scoped TEST money reconciliation` (six named source/test files, required Co-Authored-By trailer).
- `449de52e chore(contract-lifecycle): record scoped TEST reconcile receipt` (one named safe evidence file, required trailer).

V1 Auth/RPC/REST run during one admitted SQL snapshot, but HTTP endpoints do not share that database snapshot. Fresh A-after detects endpoint drift at two boundaries; a transient mutation that reverts between endpoints can escape detection. V2 proves SQL paging, with V1 providing HTTP cap evidence. Production gates, global `gate:truoc-push`, draft PR, independent review and release remain parent-owned and unverified by this task.
