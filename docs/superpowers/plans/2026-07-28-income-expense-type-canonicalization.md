# Income/Expense Type Canonicalization Implementation Plan

> **[LỊCH SỬ — ĐÃ SHIP 28/07/2026]** Migration `20260728180000` là canonical. Hiện hành: `docs/he-thong/08-thu-chi-so-quy.md`. Giữ làm bằng chứng, không cập nhật nữa.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicate organization-level income/expense category IDs with one audited canonical ID and prevent the duplicates from returning.

**Architecture:** An atomic PostgreSQL migration computes a deterministic duplicate-to-canonical map, snapshots every moved reference, validates accounting and finance-role invariants, rewrites live foreign keys, deletes duplicate master rows, and installs a normalized unique index. React mutation hooks only translate database uniqueness violations; organization-aware SQL writers remain the sole creators of system categories.

**Tech Stack:** PostgreSQL/Supabase migrations, TypeScript, React Query, Vitest, Node.js Management API harness, Playwright fleet.

---

## File map

- Create `supabase/migrations/20260728180000_income_expense_type_canonicalization.sql`: schema, merge/repair audits, canonical merge, reference rewrites, uniqueness, and writer redefinitions.
- Create `src/lib/__tests__/incomeExpenseTypeCanonicalizationMigration.test.ts`: static contract for the migration.
- Create `src/lib/incomeExpenseTypeErrors.ts`: pure SQL-error-to-message mapping.
- Create `src/lib/__tests__/incomeExpenseTypeErrors.test.ts`: duplicate and fallback error behavior.
- Modify `src/hooks/useIncomeExpenseTypes.ts`: use the pure error mapper for create/update and update stale duplicate-data comments.
- Modify `src/hooks/income-expenses/queries.ts`: document sibling expansion as legacy compatibility rather than expected data shape.
- Create `scripts/apply-income-expense-type-canonicalization.mjs`: hash-gated dry-run, rollback validation, and live apply.
- Create `scripts/__tests__/income-expense-type-canonicalization-rollout.test.mjs`: CLI, hash, atomic wrapper, and secret-redaction contracts.
- Modify `.e2e-fleet/specs/business-performance.spec.ts`: assert one visible row per normalized category.
- Regenerate `src/integrations/supabase/types.ts` after live schema apply.
- Modify `src/hooks/useManagerSalary.ts`, `src/hooks/useMaintenanceBatch.ts`, and
  `src/copilot/tools/writeTools.ts`: keep legacy/client type writers in the
  voucher building or invoice organization.
- Create organization-scope regression contracts under `src/hooks/__tests__/`.

### Task 1: Lock the expected behavior with failing tests

**Files:**
- Create: `src/lib/__tests__/incomeExpenseTypeCanonicalizationMigration.test.ts`
- Create: `src/lib/__tests__/incomeExpenseTypeErrors.test.ts`
- Create: `scripts/__tests__/income-expense-type-canonicalization-rollout.test.mjs`

- [ ] **Step 1: Write the migration contract test**

Read `20260728180000_income_expense_type_canonicalization.sql` and assert all of these independent contracts:

```ts
expect(sql).toMatch(/create or replace function public\.normalize_income_expense_type_name/i);
expect(sql).toMatch(/create table (?:if not exists )?public\.income_expense_type_merge_audit/i);
expect(sql).toMatch(/moved_item_ids\s+uuid\[\]/i);
expect(sql).toMatch(/finance_role_assignments_before\s+jsonb/i);
expect(sql).toMatch(/alter column organization_id set not null/i);
expect(sql).toMatch(/alter table public\.income_expense_items disable trigger user/i);
expect(sql).toMatch(/alter table public\.income_expense_items enable trigger user/i);
expect(sql).toMatch(/update public\.finance_reporting_role_assignments/i);
expect(sql).toMatch(/delete from public\.income_expense_types/i);
expect(sql).toMatch(/create unique index income_expense_types_org_side_normalized_name_uq/i);
expect(sql).toMatch(/create or replace function public\.seed_commission_expense_types/i);
expect(sql).toMatch(/create or replace function public\.create_commission_voucher/i);
expect(sql).toMatch(/create or replace function public\.resolve_fixed_expense_type/i);
expect(sql).toMatch(/drop trigger if exists on_auth_user_created_seed_commission_types/i);
expect(sql).toMatch(/raise exception[^;]+conflicting is_deposit/is);
expect(sql).toMatch(/raise exception[^;]+finance reporting role/is);
```

Also assert ordering by comparing string indexes: audit insert before item update, item update before duplicate delete, duplicate delete before unique index, and `DISABLE TRIGGER USER` before `ENABLE TRIGGER USER`.

- [ ] **Step 2: Write pure error-mapping tests**

```ts
expect(incomeExpenseTypeErrorMessage({ code: "23505" }, "fallback")).toBe(
  "Hạng mục này đã tồn tại trong tổ chức",
);
expect(incomeExpenseTypeErrorMessage({ message: "DB unavailable" }, "fallback")).toBe(
  "DB unavailable",
);
expect(incomeExpenseTypeErrorMessage({}, "fallback")).toBe("fallback");
```

- [ ] **Step 3: Write rollout-script tests**

Test exported `buildIncomeExpenseTypeCanonicalizationRollout`, `parseCanonicalizationArgs`, and `main` with injected config/execute/log functions. Assert:

```js
expect(rollout.migrations).toHaveLength(1);
expect(rollout.applySql).toMatch(/^BEGIN;/);
expect(rollout.applySql).toMatch(/COMMIT;$/);
expect(rollout.rollbackSql).toMatch(/ROLLBACK;$/);
expect(() => parseCanonicalizationArgs([])).toThrow(/requires/i);
await expect(main(["--apply", "--expected-sha256", "0".repeat(64)], deps))
  .rejects.toThrow(/hash mismatch/i);
```

- [ ] **Step 4: Run tests and verify RED**

Run:

```powershell
npx vitest run src/lib/__tests__/incomeExpenseTypeCanonicalizationMigration.test.ts src/lib/__tests__/incomeExpenseTypeErrors.test.ts scripts/__tests__/income-expense-type-canonicalization-rollout.test.mjs
```

Expected: fail because the migration, helper, and rollout module do not exist.

### Task 2: Build the canonicalization migration core

**Files:**
- Create: `supabase/migrations/20260728180000_income_expense_type_canonicalization.sql`
- Test: `src/lib/__tests__/incomeExpenseTypeCanonicalizationMigration.test.ts`

- [ ] **Step 1: Add the normalization and audit schema**

Use one standalone `BEGIN;`/`COMMIT;` wrapper. Define an immutable helper whose result is identical in grouping and uniqueness:

```sql
CREATE OR REPLACE FUNCTION public.normalize_income_expense_type_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT regexp_replace(public.nrm_vn(p_name), '[[:space:]]+', ' ', 'g')
$$;
```

Create `public.income_expense_type_merge_audit` with UUID primary key, organization ID, duplicate/canonical UUIDs without type foreign keys, normalized name, side, integer item/role counts, `uuid[] moved_item_ids`, JSONB metadata snapshots, JSONB finance-role snapshots, migration version, and `merged_at`. Enable RLS and revoke all access from `PUBLIC`, `anon`, and `authenticated`.

- [ ] **Step 2: Backfill and enforce organization scope**

Backfill null organizations deterministically from active membership, then profile organization, then the existing production fallback. Use a `DO` gate to reject any remaining null. Apply:

```sql
ALTER TABLE public.income_expense_types
  ALTER COLUMN organization_id SET NOT NULL;
```

Before the merge, reject any item whose own organization differs from its parent
voucher. For a legacy item whose type organization differs from its voucher,
create or reuse the same normalized identity in the voucher organization, snapshot
the move in `income_expense_type_reference_repair_audit`, and include that move in
the trigger-disabled rewrite and invariant checks. Reject duplicate groups whose
`bool_or(is_deposit)` differs from `bool_and(is_deposit)`.

- [ ] **Step 3: Build the deterministic temporary map**

Create a transaction-local temp table with `duplicate_type_id`, `canonical_type_id`, organization, side, normalized name, item count, and role count. Rank each identity group by:

```sql
ORDER BY
  role_reference_count DESC,
  item_reference_count DESC,
  system_only DESC,
  COALESCE(is_default, false) DESC,
  is_restricted DESC,
  force_approval DESC,
  created_at ASC,
  id ASC
```

Only `row_number() > 1` becomes a duplicate mapping. Insert one permanent audit row per mapping before any live reference changes; collect exact item IDs with `array_agg(item.id ORDER BY item.id)` and role rows with ordered `jsonb_agg(to_jsonb(assignment))`.

- [ ] **Step 4: Merge metadata and validate projected role intervals**

Update only canonical rows. OR the protective flags except `is_deposit`, keep the canonical display name, and fill blank category/description from the highest-ranked non-empty member. Build projected finance-role rows using `COALESCE(map.canonical_type_id, assignment.income_expense_type_id)`. Raise `23514` if two projected non-identical rows overlap; identify conflicts with `daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')`.

- [ ] **Step 5: Rewrite live references without mutating accounting snapshots**

Delete projected exact duplicate finance-role rows with `row_number()` and then update remaining assignments to the canonical ID. Assert all non-internal triggers on `income_expense_items` are enabled, snapshot item count, `sum(amount)`, and counts by `accounting_class`, then execute:

```sql
ALTER TABLE public.income_expense_items DISABLE TRIGGER USER;
UPDATE public.income_expense_items item
SET income_expense_type_id = map.canonical_type_id
FROM pg_temp.income_expense_type_merge_map map
WHERE item.income_expense_type_id = map.duplicate_type_id;
ALTER TABLE public.income_expense_items ENABLE TRIGGER USER;
```

Constraint triggers remain enabled. Compare all snapshots after the update and raise on any difference.

- [ ] **Step 6: Delete duplicates and install the race-safe guard**

Delete only IDs present in the temp map, assert no live reference remains, assert every normalized group now has count one, then create:

```sql
CREATE UNIQUE INDEX income_expense_types_org_side_normalized_name_uq
ON public.income_expense_types (
  organization_id,
  lower(btrim(type)),
  public.normalize_income_expense_type_name(name)
);
```

### Task 3: Make system category writers organization-aware

**Files:**
- Modify: `supabase/migrations/20260728180000_income_expense_type_canonicalization.sql`
- Test: `src/lib/__tests__/incomeExpenseTypeCanonicalizationMigration.test.ts`

- [ ] **Step 1: Redefine commission seeding**

Keep the public signature `seed_commission_expense_types(uuid)`. Derive exactly one active organization from `organization_memberships`/`profiles`, take an organization-and-normalized-name advisory transaction lock, and insert `Hoa hồng môi giới` plus `Thưởng nóng Sale` only when no organization row exists. Include `organization_id` in inserts and retain the existing EXECUTE revocations.

- [ ] **Step 2: Stop per-auth-user category creation**

Drop `on_auth_user_created_seed_commission_types` on `auth.users`. Keep lazy seeding in the commission writer because auth-user creation occurs before a reliable organization membership exists.

- [ ] **Step 3: Redefine `create_commission_voucher`**

Copy the current effective function signature and grants from `20260709110001_create_commission_voucher_rpc.sql`. Preserve authorization, advisory locking, idempotency, voucher fields, and status behavior exactly. Add `c.organization_id` to the contract record and replace both type lookups:

```sql
WHERE t.organization_id = v_contract.organization_id
  AND lower(t.type) = 'expense'
  AND public.normalize_income_expense_type_name(t.name) =
      public.normalize_income_expense_type_name(v_type_name)
```

Call the redefined seed helper only when absent, then reselect by organization.

- [ ] **Step 4: Redefine `resolve_fixed_expense_type`**

Preserve the signature and category-key validation from `20260708130100_nrm_vn_resolve_fixed_expense_type.sql`. Resolve the owner's active organization, lock by `(organization, category_key)`, query matching types by organization instead of `user_id`, and include `organization_id` in the fallback insert. Preserve its revoke/grant boundary.

- [ ] **Step 5: Run static migration test and verify GREEN**

Run:

```powershell
npx vitest run src/lib/__tests__/incomeExpenseTypeCanonicalizationMigration.test.ts
```

Expected: all migration structure and ordering assertions pass.

- [ ] **Step 6: Commit migration plus migration test**

Stage only the migration and its test, then commit:

```text
fix(finance): hợp nhất hạng mục thu chi theo tổ chức

Co-Authored-By: Codex <noreply@openai.com>
```

### Task 4: Surface duplicate errors cleanly in React

**Files:**
- Create: `src/lib/incomeExpenseTypeErrors.ts`
- Create: `src/lib/__tests__/incomeExpenseTypeErrors.test.ts`
- Modify: `src/hooks/useIncomeExpenseTypes.ts`
- Modify: `src/hooks/income-expenses/queries.ts`

- [ ] **Step 1: Implement the pure mapper**

```ts
type SupabaseLikeError = { code?: unknown; message?: unknown } | null | undefined;

export function incomeExpenseTypeErrorMessage(
  error: SupabaseLikeError,
  fallback: string,
): string {
  if (error?.code === "23505") return "Hạng mục này đã tồn tại trong tổ chức";
  return typeof error?.message === "string" && error.message.trim()
    ? error.message
    : fallback;
}
```

- [ ] **Step 2: Use it in create and update mutations**

Replace raw `error.message || fallback` toast calls in both mutations. Do not add a client pre-check. Update comments so client dedup/sibling expansion are described as rollout compatibility, not a supported permanent duplicate model.

- [ ] **Step 3: Run helper and existing hook tests**

```powershell
npx vitest run src/lib/__tests__/incomeExpenseTypeErrors.test.ts src/hooks/__tests__/useIncomeExpenseTypes.property.test.ts src/hooks/__tests__/useIncomeExpenses.property.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit React error handling**

```text
fix(finance): báo rõ hạng mục trùng trong tổ chức

Co-Authored-By: Codex <noreply@openai.com>
```

### Task 5: Add hash-gated rollback/apply automation

**Files:**
- Create: `scripts/apply-income-expense-type-canonicalization.mjs`
- Create: `scripts/__tests__/income-expense-type-canonicalization-rollout.test.mjs`

- [ ] **Step 1: Build one-migration rollout artifacts**

Reuse `loadMigrationBodies` and `buildRolloutSql` from `apply-accounting-rollout.mjs`, and `loadAdminConfig`/`executeManagementQuery` from `test-business-performance-authz.mjs`. Export:

```js
export const CANONICALIZATION_MIGRATION =
  "supabase/migrations/20260728180000_income_expense_type_canonicalization.sql";

export function buildIncomeExpenseTypeCanonicalizationRollout() {
  const migrations = loadMigrationBodies([CANONICALIZATION_MIGRATION]);
  const applySql = buildRolloutSql(migrations);
  const rollbackSql = buildRolloutSql(migrations, { rollback: true, notify: false });
  const sha256 = createHash("sha256").update(applySql).digest("hex");
  return { migrations, applySql, rollbackSql, sha256 };
}
```

Support exactly `--dry-run`, `--rollback --expected-sha256 <hash>`, and `--apply --expected-sha256 <hash>`. Refuse unexpected project refs through the imported admin executor. Never log PAT contents.

- [ ] **Step 2: Complete rollout tests and verify GREEN**

```powershell
npx vitest run scripts/__tests__/income-expense-type-canonicalization-rollout.test.mjs
node scripts/apply-income-expense-type-canonicalization.mjs --dry-run
```

Expected: unit tests pass and dry-run prints one stable SHA-256 without making a network request.

- [ ] **Step 3: Commit rollout automation**

```text
chore(finance): thêm rollout an toàn cho hợp nhất hạng mục

Co-Authored-By: Codex <noreply@openai.com>
```

### Task 6: Validate live, regenerate types, and prove the UI result

**Files:**
- Modify: `src/integrations/supabase/types.ts`
- Modify: `.e2e-fleet/specs/business-performance.spec.ts`
- Modify: `docs/superpowers/specs/2026-07-28-income-expense-type-canonicalization-design.md` if implementation evidence requires a correction

- [ ] **Step 1: Run rollback-only live validation**

Load `SUPABASE_PAT` from the root `CLAUDE.local.md` without printing it. Run dry-run,
copy its hash, then run `--rollback --expected-sha256 <hash>`. Expected: the actual
production duplicate set and known DEMO-to-PROD legacy type references pass every
invariant and the transaction rolls back.

- [ ] **Step 2: Run independent review before irreversible apply**

Request an independent reviewer to inspect migration safety, organization scoping, trigger handling, writer compatibility, and test gaps. Resolve every high/medium finding and repeat rollback validation.

- [ ] **Step 3: Apply atomically**

Run `--apply --expected-sha256 <same fresh hash>`. Expected: one atomic commit and PostgREST schema reload. Query the audit table through the management endpoint and verify mappings exist for the known commission and rent duplicates.

- [ ] **Step 4: Regenerate Supabase types**

Run:

```powershell
npm run gen:types
```

Verify the exact generated header remains first and `income_expense_type_merge_audit` plus non-null `income_expense_types.organization_id` are represented.

- [ ] **Step 5: Add the E2E uniqueness assertion**

In the desktop Business Performance Chi structure test, normalize all visible
expense row headers and assert that the normalized set has the same size as the
row list. Also assert the two reported names never render more than once:

```ts
expect(new Set(normalizedExpenseNames).size).toBe(normalizedExpenseNames.length);
expect(await page.getByText("Hoa hồng môi giới", { exact: true }).count())
  .toBeLessThanOrEqual(1);
expect(await page.getByText("Tiền nhà", { exact: true }).count())
  .toBeLessThanOrEqual(1);
```

Keep the existing console-error tracker active. The exact existence/count and
amount invariants for these two PROD categories are verified through live SQL,
because the DEMO reporting fixture does not contain an item for every PROD name.

After type regeneration, fix every client writer surfaced by the new non-null
`organization_id` contract. Salary, maintenance, and Copilot fallbacks must never
resolve a type from a different organization; mixed-organization batches fail
closed instead of creating cross-organization item references.

- [ ] **Step 6: Run verification gates**

```powershell
npx vitest run src/lib/__tests__/incomeExpenseTypeCanonicalizationMigration.test.ts src/lib/__tests__/incomeExpenseTypeErrors.test.ts scripts/__tests__/income-expense-type-canonicalization-rollout.test.mjs src/hooks/__tests__/useIncomeExpenseTypes.property.test.ts src/hooks/__tests__/useIncomeExpenses.property.test.ts src/components/finance-performance/__tests__/RevenueCostStructureTab.test.tsx
npm run typecheck:baseline
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
```

Do not use `reconcile-money` as a blocker per user instruction. Run the headless fleet against the Business Performance spec with 8 workers and all three finance personas. Expected: targeted tests green, type baseline unchanged, ACL/view gates green, E2E green, and no console errors.

- [ ] **Step 7: Verify live aggregation invariants**

For July 2026 production, verify:

- one normalized `Hoa hồng môi giới` row whose amount equals the pre-merge sum of all three IDs;
- one normalized `Tiền nhà` row whose amount equals the pre-merge sum of both IDs;
- total Chi is unchanged;
- no duplicate normalized identity remains in either production or demo organization.

- [ ] **Step 8: Final scoped commit and push**

Stage only the E2E spec, generated types, and any scoped amendments. Commit with the Codex trailer, inspect `git diff origin/main...HEAD`, then push this branch's commits to `origin/main` as required by the repository workflow.
