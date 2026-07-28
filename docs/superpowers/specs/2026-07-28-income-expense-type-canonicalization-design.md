# Canonicalize Income/Expense Types — Design

**Date:** 2026-07-28  
**Scope:** `income_expense_types` within one organization and one Thu/Chi side  
**Status:** Approved for autonomous implementation by the user's instruction to complete the fix without repeated confirmation gates.

## Problem

`income_expense_types` was originally seeded per user. The organization rollout later attached those rows to organizations without merging rows that represented the same category. Consequently, several IDs in one organization can have the same visible name and side.

The reporting RPC correctly groups by `income_expense_type_id`, so duplicate master rows become duplicate chart rows. July 2026 production evidence includes multiple rows for both `Hoa hồng môi giới` and `Tiền nhà`. Client-side deduplication hides some of the same master-data defect in pickers, while finance reporting, role mapping, filtering, and system writers still see distinct IDs.

## Goals

- Make one canonical category ID represent one normalized name, organization, and Thu/Chi side.
- Preserve voucher amounts, accounting snapshots, organization boundaries, and historical audit payloads.
- Move all live relational references from duplicate IDs to the canonical ID.
- Prevent new duplicates at the database boundary, including concurrent inserts.
- Keep commission and fixed-expense system writers working after categories become organization-scoped.
- Return a clear application error when a user tries to create or rename a category to a name that already exists.

## Non-goals

- Do not merge categories across organizations or across Thu versus Chi.
- Do not merge merely similar business concepts with different normalized names.
- Do not rewrite immutable JSON audit records or historical report snapshots.
- Do not change voucher amounts or use monetary reconciliation differences as a rollout blocker.
- Do not redesign the Business Performance page.

## Considered approaches

### 1. Aggregate by name only in UI/RPC

This is the smallest patch, but duplicate IDs remain in filters, role assignments, writers, and future reports. It also silently makes a display string the accounting identity. Rejected.

### 2. Canonical-ID migration with a database uniqueness boundary

Choose one deterministic canonical row, record the mapping, move references, delete duplicates, and add a unique normalized key. This fixes the source of the problem and lets all consumers continue grouping by ID. Selected.

### 3. Permanent alias rows (`merged_into_id`)

This preserves every master row but requires every current and future query to resolve aliases. Missing alias logic in one writer or report would reintroduce the defect. Rejected as unnecessary permanent complexity.

## Identity and normalization

The canonical identity is:

```text
(organization_id, lower(trim(type)), normalized_name)
```

`normalized_name` reuses `public.nrm_vn(name)` for case and Vietnamese diacritic normalization, then trims and collapses internal whitespace. An immutable helper dedicated to category identity keeps the unique-index expression and migration grouping identical.

`organization_id` must be present. The migration first fills any legacy null using the same active-membership/profile fallback already used by the organization rollout, then aborts if a row still cannot be scoped. It sets the column `NOT NULL` only after the invariant succeeds; the existing BEFORE INSERT organization autofill remains responsible for legacy insert callers that omit the column.

## Canonical row selection

For every duplicate identity group, choose one row deterministically in this order:

1. highest number of finance-role assignments;
2. highest number of `income_expense_items` references;
3. `system_only`, `is_default`, then other protective flags;
4. oldest `created_at`;
5. smallest UUID as the stable tie-breaker.

This preserves the ID already carrying the most operational meaning and minimizes reference rewrites. A group with conflicting `is_deposit` values aborts because deposit versus P&L is an accounting-semantic boundary, not presentation metadata. Before deleting compatible duplicates, merge the remaining protective boolean metadata with logical OR (`system_only`, `is_default`, `is_restricted`, `hide_in_report`, and `force_approval`). Preserve the canonical display name and prefer the canonical non-empty category/description, falling back to the most-referenced non-empty duplicate.

## Audit and reference migration

Create `income_expense_type_merge_audit` as an append-only migration audit containing:

- organization and normalized identity;
- duplicate ID and canonical ID;
- pre-merge reference counts;
- full duplicate/canonical metadata snapshots and finance-role assignment snapshots;
- merge timestamp and migration version.

The audit stores historical UUID values without a foreign key to the deleted duplicate row.

Current relational references are:

- `income_expense_items.income_expense_type_id`;
- `finance_reporting_role_assignments.income_expense_type_id` plus its organization-scoped composite foreign key.

Before moving finance-role assignments, validate that collapsing a duplicate group will not create overlapping effective periods with incompatible roles. Abort the whole transaction with a diagnostic if it would. Assignments with an identical role and effective range are recorded in the audit, reduced deterministically to one row, and moved to the canonical ID; all other non-overlapping assignments move unchanged.

Updating item category IDs must not recalculate posted accounting snapshots or mutate voucher lifecycle state. The migration therefore verifies that all user triggers on `income_expense_items` are enabled, temporarily disables user triggers only for the ID rewrite, preserves `accounting_class` and all amounts, then re-enables them. Constraint triggers remain active. Postconditions compare row counts, amount sums, accounting-class counts, and organization ownership before and after the rewrite.

Audit-log JSON and historical snapshot JSON remain unchanged because they describe the state recorded at that time and are not live foreign-key references.

## Duplicate prevention

After references are moved and duplicate master rows are removed, add a unique expression index over the canonical identity. This is the final race-safe guard for inserts and renames.

The application create/update hooks continue to rely on the database as the source of truth. They translate the unique-violation constraint into a clear Vietnamese message that the category already exists in the organization. Client-side checks are not used as the concurrency boundary.

Existing picker deduplication may remain temporarily as defensive compatibility, but comments must no longer describe duplicate rows as expected behavior. Item filtering should work with the canonical ID; any retained sibling expansion is compatibility-only and covered by tests.

## System writer compatibility

The two effective legacy writers that still resolve categories by `user_id` must become organization-aware:

- `seed_commission_expense_types(uuid)` and `create_commission_voucher(...)` resolve `Hoa hồng môi giới` / `Thưởng nóng Sale` by contract organization;
- `resolve_fixed_expense_type(uuid,text)` resolves fixed-expense categories in the owner's active organization.

The auth-user trigger must not create one row per user after uniqueness becomes organization-scoped. It should either resolve/reuse the existing organization category or be removed when organization membership does not yet exist; lazy organization-aware writers remain responsible for ensuring required system categories.

Other current finance writers already query by `organization_id` and will reuse the canonical row once the unique guard exists.

## Failure handling and rollout

The migration is atomic. It aborts without partial changes when any of these gates fail:

- an unscoped category cannot be assigned to an organization;
- a referenced duplicate belongs to a different organization than its parent record;
- finance-role mappings conflict after canonicalization;
- a user trigger needed for normal operation was already disabled;
- reference counts, monetary sums, accounting snapshots, or duplicate-count postconditions differ unexpectedly.

Rollout order:

1. run static migration tests and a rollback-only database compile;
2. run a read-only live preflight and record the exact merge set;
3. apply the migration atomically;
4. regenerate Supabase types because an audit table and possibly a `NOT NULL` schema change are introduced;
5. run authorization/ACL gates, targeted unit tests, type baseline, and headless Business Performance E2E;
6. verify the live category breakdown has one row per normalized category and unchanged totals;
7. commit and push only scoped files.

## Test strategy

- Static migration tests assert normalization, deterministic ranking, audit insertion, both reference rewrites, trigger safety, metadata merge, unique prevention, and transaction postconditions.
- Rollback database tests seed duplicate names with case/diacritic/whitespace variants, assign item references, and verify one canonical row with unchanged totals.
- Conflict tests prove the migration refuses incompatible finance-role intervals.
- Hook tests prove create and rename surface a friendly duplicate message for SQLSTATE `23505` while other errors remain unchanged.
- Writer tests prove commission and fixed-expense flows reuse the organization canonical row.
- Headless E2E verifies the Chi structure shows a single `Hoa hồng môi giới` and a single `Tiền nhà` row, with no console errors.
