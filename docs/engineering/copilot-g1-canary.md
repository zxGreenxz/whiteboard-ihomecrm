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
for the supplied actor before login and on authenticated reload. The existing
`invoices:overdue-checked-at` session throttle also defers the invoice page's
background overdue writer. These local settings are refreshed on every document
load; neither changes a server setting. Use `COPILOT_E2E_MODEL` only for an explicitly selected
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
| `get_income_expense_layer_stats` | Reviewed dashboard signature plus `p_posting` from `src/hooks/income-expenses/queries.ts:640`; read filter extension in `supabase/migrations/20260724080000_finance_v2_stats_posting_filter.sql` |
| `get_my_context` | `src/hooks/useMyContext.ts:32`; SELECT-only body in `supabase/migrations/20260516000011_get_my_context_default_area.sql:10` |
| `get_my_assignments`, `is_admin`, `my_org_ids` | `src/hooks/useMyBuildingScope.ts:48`, `src/hooks/useIsAdmin.ts:19`, `src/hooks/useIncomeExpenseTypes.ts:80`; read bodies in migrations `20260611110000_staff_assignments_area_scope.sql:293`, `20260710150000_tenant_isolation_hardening.sql:58`, `20260713121000_sprint3b_org_autofill_and_boundary.sql:16` |
| `get_customer_stats` | `src/hooks/useCustomers.ts:347`; SQL aggregate in `supabase/migrations/20260705210000_stats_rpc_contract_customer.sql:70` |
| `get_reservation_deposit_summary`, `get_held_deposit_summary` | `src/hooks/useDeposits.ts:193`, `src/hooks/useDepositDashboard.ts:32`; SQL aggregates in `supabase/migrations/20260710170000_money_aggregate_rpcs.sql:79` and `:37` |
| `get_refund_forfeit_summary` | `src/hooks/useDepositDashboard.ts:140`; SELECT-only CTE aggregate in `supabase/migrations/20260822113000_refund_kpi_split_deposit_vs_other.sql:37` |
| `get_meter_reading_stats` | `src/hooks/useMeterReadings.ts:241`; RETURN QUERY SELECT in `supabase/migrations/20250130000004_meter_reading_rpc_functions.sql:85` |
| `get_meters_without_readings_v2` | Closed `MeterReadingForm` mounts `src/hooks/useMeters.ts:263`; SELECT-only delegate in `supabase/migrations/20260528000002_rbac_batch_c_rpc_v2.sql:160` and `get_meters_without_readings` in `20250130000004_meter_reading_rpc_functions.sql` |
| `ie_form_buildings` | Closed `IncomeExpenseForm` mounts `src/hooks/useIncomeExpenseFormScope.ts:40`; SELECT-only scoped body in `supabase/migrations/20260801090000_ie_form_lists_org_isolation.sql:53` |
| `get_acceptance_geofence_config` | Closed `TaskCompleteDialog` mounts `src/hooks/useAcceptanceGeofence.ts:30`; settings SELECT in `supabase/migrations/20260628000001_acceptance_geofence.sql:33` |
| `list_my_cashbook_access_v2`, `list_cashbook_visibility_v2` | `src/hooks/income-expenses/financeV2Mutations.ts:223` and `:248`; SELECT bodies in migrations `20260723110000_finance_v2_rls_canary.sql:246`, `20260724160000_finance_v2_cashbook_visibility_flags.sql:23` |
| `get_finance_v2_client_flags_v1` | `src/lib/financeV2Route.ts:63`; `supabase/migrations/20260730110000_ie_accounting_standard_toggle.sql:255`, using the SELECT-only resolver in `20260723170000_finance_v2_readonly_txn_fix.sql:21` |
| `zalo_get_crm_summary` | Mounted first linked conversation's CRM panel, `src/hooks/chat-zalo/useZaloCrmProfile.ts:24`; auth-scoped SELECT body in `supabase/migrations/20260813130000_zalo_gan_hoi_thoai_crm.sql:281` |

The route import audit includes eagerly mounted closed forms and RPC wrapper
calls. Only the inspected RPC names and argument keys above are admitted; every
added signature has unknown-argument and GET-execution negatives. Zalo sticker
search creates an asynchronous job, so it remains blocked along with presence,
mark-read and history loading. Receipt failures retain only a bounded `g1_` code
or a known timeout category; provider prose and raw server errors are omitted.

DEMO admission binds Copilot tools, flags, chat persistence and memory. Legacy
page queries keep their existing server authorization/RLS behavior, and several
have no organization argument. Rendered-route proofs do not certify that every
legacy page dataset is filtered by the Copilot organization selector.

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
