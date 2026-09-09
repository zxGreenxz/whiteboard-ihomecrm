# G1 canary acceptance

The opt-in headless spec `.e2e-fleet/specs/copilot-g1-canary.spec.ts` measures 24
cases: the 19 canonical destinations, three mobile pilot controls, authorized
invoice documentation, and the memory panel. It does not run room-pass acceptance,
change rollout flags, create business fixtures, or exercise memory writes.

Navigation uses the shipped chat tool: at most five unfinished destinations per
Gemini prompt. Each proof requires an observed `mo_trang` call, its matching tool
reply in the next model request, the rendered link, an actual link click, and a
mounted page witness at the exact destination. Visiting a route with `page.goto`
is used only for independent mobile geometry/control checks. These proofs cover
chat navigation; they do not claim PageAgent UI-control navigation or G4 real-model
golden acceptance.

## Operator inputs

Use the existing `auth.ts` sysadmin credentials and Vercel preview bypass setup.
Keep secrets in the operator environment. Do not put passwords, tokens, cookies,
headers, or model transcripts in these JSON files.

`FLEET_G1_CONFIG` is an absolute path to this nonsecret configuration:

```json
{
  "sourceSha": "<exact reviewed 40-character commit SHA>",
  "actorId": "<verified sysadmin UUID>",
  "organizationId": "dddd0000-0000-4000-8000-000000000001",
  "baseUrl": "https://<exact-reviewed-preview-host>",
  "supabaseOrigin": "https://<project-ref>.supabase.co"
}
```

`FLEET_G1_FLAGS` is an absolute path to the operator's fresh read-only Management
API flag baseline, using the existing preflight receipt shape:

```json
{
  "observedAt": "<UTC timestamp>",
  "actorId": "<same verified sysadmin UUID>",
  "flags": [{
    "scope": "page", "contract_id": "rooms.list", "state": "enabled",
    "revision": 123, "canary_org": "dddd0000-0000-4000-8000-000000000001",
    "expires_at": "<actual bounded expiry>"
  }],
  "availability": {
    "actor_user_id": "<same actor>",
    "organization_id": "dddd0000-0000-4000-8000-000000000001",
    "revision": 456,
    "digest": "<actual server digest>",
    "states": { "page:rooms.list": "enabled" }
  }
}
```

The example abbreviates the arrays. Actual input must contain all 19 canonical
page flags plus `copilot.navigation`. Additional page/action rows in the baseline
are permitted, but never substitute for a required key. All 20 required rows must
be enabled, canary-scoped to DEMO, with positive revisions and actual expiry
(maximum 14 days from admission, at least 30 seconds remaining). Existing authorized
canaries can be reused. No ownership of a flag transition is inferred from the
current test actor.

The Management baseline must be under one hour old. The spec compares its server
availability digest/global revision with fresh browser RPC responses before every
proof. The browser also verifies the authenticated user, superadmin status,
organization authorization, selected-org availability, and deployed build SHA.
Authenticated SELECT on `copilot_feature_flags` is deliberately not attempted.
Apply any planned flag changes before capturing this baseline. Drift stops the
attempt; capture a new baseline before resuming.

`FLEET_G1_RECEIPT` is an absolute path to an output file in an existing directory
outside source control. The same path resumes partial progress. Existing proofs
must validate and match the exact build, actor, org, origins, model, and 20 selected
flag rows including their revisions/expiry. Passed proofs remain unchanged; only
unfinished route keys enter new prompts. The baseline's digest/revision for each
attempt remains in its receipt. This permits unrelated flag changes between
attempts only when the newly verified selected 20 rows remain identical.

```powershell
$env:FLEET_G1_LIVE = '1'
$env:FLEET_WORKERS = '1'
$env:EXPECTED_SOURCE_SHA = '<exact reviewed SHA>'
$env:FLEET_BASE_URL = 'https://<exact-reviewed-preview-host>'
$env:FLEET_G1_CONFIG = 'C:/path/to/g1-config.json'
$env:FLEET_G1_FLAGS = 'C:/path/to/g1-flags-preflight.json'
$env:FLEET_G1_RECEIPT = 'C:/path/to/g1-acceptance.json'
node node_modules/@playwright/test/cli.js test --config .e2e-fleet/playwright.config.ts --workers 1 --retries 0 copilot-g1-canary.spec.ts
```

The existing pinned Gemini preference is rewritten only in this browser's profile
read response. The existing browser-local scheduled-notification throttle is set
for the supplied actor before login and on authenticated reload. Neither operation
changes a server setting. Use `COPILOT_E2E_MODEL` only for an explicitly selected
supported Gemini candidate; there is no automatic fallback.

Receipts contain case IDs, flags, identities, geometry, request path/status
diagnostics, owned chat thread IDs, and hashes of tool/stream evidence. They do not
contain model text, documentation bodies, memory contents or business row data.
Receipt hashes detect accidental alteration; they are not cryptographic signatures
or independent server attestations. Keep the operator's baseline with the receipt.
Chat persistence is counted separately from prohibited writes. The spec does not
delete chat history; the exact newly created thread IDs are supplied for the
operator's existing owned-chat retention/cleanup policy.

A lock next to the receipt prevents concurrent use. Normal exit removes it. After
a crash, confirm the recorded process and browser have terminated before removing
that exact lock; the harness will not infer recovery from an elapsed timeout.

## Request guard and scope

`scripts/lib/copilot-g1-guard.mjs` blocks every unrecognized POST/PATCH/PUT/DELETE,
including notification, profile, memory, plan and financial writes. Only fresh
owned DEMO chat thread/message inserts and the DEMO LLM proxy are admitted as
non-read activity. GET/HEAD table reads use the existing room-pass boundary;
GET RPC execution is denied. Cross-origin mutating requests and unknown Edge
functions are denied. A blocked request or failed REST response fails the attempt.

The explicit POST read signatures currently cover:

| Read RPCs | Source reviewed |
| --- | --- |
| `get_my_permissions`, `is_super_admin`, `business_performance_organizations_v1`, `list_my_copilot_organizations_v1`, `is_org_owner_self_v1`, `is_company_owner_self_v1`, `get_copilot_action_policy_v1` | Existing reviewed `copilotRoomPassGuard.ts` identity bootstrap |
| `get_authorization_context_v1`, `get_my_copilot_availability_v1`, `copilot_memory_list_v1` | Existing scoped room-pass reads, exact DEMO argument |
| `get_dashboard_summary`, `revenue_by_month` | `src/hooks/useDashboard.ts` |
| `get_contract_stats` | `src/hooks/useContracts.ts:472` |
| `get_invoice_statistics_v2`, `invoice_active_payment_methods` | `src/hooks/useInvoices.ts` |
| `get_income_expense_layer_stats` | Existing reviewed dashboard read signature in `copilotRoomPassGuard.ts` |

There is no caller-supplied POST allowlist. If another route requires a POST read,
inspect the exact source and SQL body, add its argument signature and a negative
guard test, then resume. Names beginning with `get`/`list` are not proof of safety.
The guard never permits `mark_overdue_invoices_v1`, `zalo_mark_read`, chat presence
writers, financial approval, or business mutations to make a page pass.

The memory case proves an authenticated DEMO list read, panel visibility, and one
delete control per returned item, including the empty state. It does not click
delete or create memory. The mobile cases verify editable safe search controls,
fill/restore, hit testing, viewport, shared bottom padding and FAB non-overlap;
they do not click business action controls. Knowledge proves the permitted guide
tool and its rendered citation on the superadmin session; unauthorized-user
document-body nonloading remains covered by the existing local permission tests.

## Local verification

```powershell
node --test scripts/__tests__/copilot-g1-acceptance.test.mjs scripts/__tests__/copilot-g1-guard.test.mjs
npm run typecheck:e2e
node node_modules/@playwright/test/cli.js test --config .e2e-fleet/playwright.config.ts --list copilot-g1-canary.spec.ts
```

These commands require no credentials or live calls. A discovered spec or passing
local tests are not live acceptance evidence. The final release still needs a
complete receipt from the reviewed deployed build, with zero prohibited requests.
