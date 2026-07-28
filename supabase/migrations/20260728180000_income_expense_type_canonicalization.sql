-- Canonicalize organization-scoped income/expense types.
-- One identity = (organization_id, income/expense side, normalized name).

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE public.income_expense_types IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.income_expense_items IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.finance_reporting_role_assignments IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.normalize_income_expense_type_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $normalize$
  SELECT regexp_replace(public.nrm_vn(p_name), '[[:space:]]+', ' ', 'g')
$normalize$;

REVOKE ALL ON FUNCTION public.normalize_income_expense_type_name(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_income_expense_type_name(text)
  TO authenticated;

CREATE TABLE IF NOT EXISTS public.income_expense_type_merge_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  duplicate_type_id uuid NOT NULL UNIQUE,
  canonical_type_id uuid NOT NULL,
  normalized_name text NOT NULL,
  type text NOT NULL CHECK (type IN ('income', 'expense')),
  item_reference_count bigint NOT NULL CHECK (item_reference_count >= 0),
  finance_role_reference_count bigint NOT NULL
    CHECK (finance_role_reference_count >= 0),
  moved_item_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  duplicate_before jsonb NOT NULL,
  canonical_before jsonb NOT NULL,
  finance_role_assignments_before jsonb NOT NULL DEFAULT '[]'::jsonb,
  migration_version text NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.income_expense_type_merge_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.income_expense_type_merge_audit
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.income_expense_type_merge_audit IS
  'Append-only audit for organization-level income_expense_types canonicalization. UUID snapshots intentionally survive deletion of duplicate master rows.';

CREATE TABLE IF NOT EXISTS public.income_expense_type_reference_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL UNIQUE,
  voucher_id uuid NOT NULL,
  source_type_id uuid NOT NULL,
  target_type_id uuid NOT NULL,
  source_organization_id uuid NOT NULL,
  target_organization_id uuid NOT NULL,
  item_before jsonb NOT NULL,
  source_type_before jsonb NOT NULL,
  target_type_before jsonb NOT NULL,
  migration_version text NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.income_expense_type_reference_repair_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.income_expense_type_reference_repair_audit
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.income_expense_type_reference_repair_audit IS
  'Append-only item-level audit for legacy cross-organization income_expense_type_id repairs.';

-- Finish the legacy organization rollout before making organization_id required.
UPDATE public.income_expense_types type_row
SET organization_id = resolved.organization_id
FROM (
  SELECT candidate.id,
         COALESCE(
           (
             SELECT voucher.organization_id
             FROM public.income_expense_items item
             JOIN public.income_expenses voucher
               ON voucher.id = item.income_expense_id
             WHERE item.income_expense_type_id = candidate.id
               AND voucher.organization_id IS NOT NULL
             ORDER BY voucher.created_at, voucher.id
             LIMIT 1
           ),
           (
             SELECT profile.organization_id
             FROM public.profiles profile
             WHERE profile.id = candidate.user_id
               AND profile.organization_id IS NOT NULL
             LIMIT 1
           ),
           (
             SELECT (array_agg(DISTINCT membership.organization_id))[1]
             FROM public.organization_memberships membership
             WHERE membership.user_id = candidate.user_id
               AND membership.status = 'ACTIVE'
             HAVING count(DISTINCT membership.organization_id) = 1
           ),
           'aaaa0000-0000-4000-8000-000000000001'::uuid
         ) AS organization_id
  FROM public.income_expense_types candidate
  WHERE candidate.organization_id IS NULL
) resolved
WHERE type_row.id = resolved.id
  AND type_row.organization_id IS NULL;

DO $organization_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.income_expense_types
    WHERE organization_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Unscoped income_expense_types rows remain after organization backfill'
      USING ERRCODE = '23502';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.income_expense_items item
    JOIN public.income_expenses voucher
      ON voucher.id = item.income_expense_id
    WHERE item.organization_id IS DISTINCT FROM voucher.organization_id
  ) THEN
    RAISE EXCEPTION 'Income/expense item organization mismatch with its voucher'
      USING ERRCODE = '23514';
  END IF;
END
$organization_guard$;

ALTER TABLE public.income_expense_types
  ALTER COLUMN organization_id SET NOT NULL;

-- Some DEMO fixtures historically reused a PROD type ID. Create the matching
-- organization-local master row when it does not exist. The item references are
-- moved later while item triggers are disabled, and every move is audited.
WITH mismatch_identities AS (
  SELECT DISTINCT ON (
    voucher.organization_id,
    lower(btrim(source_type.type)),
    public.normalize_income_expense_type_name(source_type.name)
  )
    voucher.organization_id AS target_organization_id,
    voucher.user_id AS target_user_id,
    source_type.id AS source_type_id
  FROM public.income_expense_items item
  JOIN public.income_expenses voucher
    ON voucher.id = item.income_expense_id
  JOIN public.income_expense_types source_type
    ON source_type.id = item.income_expense_type_id
  WHERE source_type.organization_id IS DISTINCT FROM voucher.organization_id
  ORDER BY
    voucher.organization_id,
    lower(btrim(source_type.type)),
    public.normalize_income_expense_type_name(source_type.name),
    voucher.created_at,
    item.id
),
missing_targets AS (
  SELECT mismatch_identities.*
  FROM mismatch_identities
  JOIN public.income_expense_types source_type
    ON source_type.id = mismatch_identities.source_type_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.income_expense_types target_type
    WHERE target_type.organization_id =
          mismatch_identities.target_organization_id
      AND lower(btrim(target_type.type)) = lower(btrim(source_type.type))
      AND public.normalize_income_expense_type_name(target_type.name) =
          public.normalize_income_expense_type_name(source_type.name)
  )
)
INSERT INTO public.income_expense_types (
  user_id,
  organization_id,
  name,
  type,
  category,
  description,
  is_default,
  is_deposit,
  is_restricted,
  hide_in_report,
  force_approval,
  system_only
)
SELECT
  missing_targets.target_user_id,
  missing_targets.target_organization_id,
  source_type.name,
  source_type.type,
  source_type.category,
  source_type.description,
  source_type.is_default,
  source_type.is_deposit,
  source_type.is_restricted,
  source_type.hide_in_report,
  source_type.force_approval,
  source_type.system_only
FROM missing_targets
JOIN public.income_expense_types source_type
  ON source_type.id = missing_targets.source_type_id;

DO $deposit_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.income_expense_types type_row
    GROUP BY
      type_row.organization_id,
      lower(btrim(type_row.type)),
      public.normalize_income_expense_type_name(type_row.name)
    HAVING bool_or(type_row.is_deposit) IS DISTINCT FROM bool_and(type_row.is_deposit)
  ) THEN
    RAISE EXCEPTION 'Conflicting is_deposit values in a normalized income/expense type group'
      USING ERRCODE = '23514';
  END IF;
END
$deposit_guard$;

CREATE TEMP TABLE income_expense_type_merge_map
ON COMMIT DROP
AS
WITH item_counts AS (
  SELECT item.income_expense_type_id AS type_id, count(*)::bigint AS item_count
  FROM public.income_expense_items item
  JOIN public.income_expenses voucher ON voucher.id = item.income_expense_id
  JOIN public.income_expense_types type_row
    ON type_row.id = item.income_expense_type_id
  WHERE voucher.organization_id = type_row.organization_id
  GROUP BY item.income_expense_type_id
),
role_counts AS (
  SELECT assignment.income_expense_type_id AS type_id,
         count(*)::bigint AS role_count
  FROM public.finance_reporting_role_assignments assignment
  GROUP BY assignment.income_expense_type_id
),
enriched AS (
  SELECT
    type_row.*,
    lower(btrim(type_row.type)) AS normalized_side,
    public.normalize_income_expense_type_name(type_row.name) AS normalized_name,
    COALESCE(role_counts.role_count, 0::bigint) AS role_reference_count,
    COALESCE(item_counts.item_count, 0::bigint) AS item_reference_count
  FROM public.income_expense_types type_row
  LEFT JOIN item_counts ON item_counts.type_id = type_row.id
  LEFT JOIN role_counts ON role_counts.type_id = type_row.id
),
ranked AS (
  SELECT
    enriched.*,
    first_value(enriched.id) OVER identity_window AS canonical_type_id,
    row_number() OVER identity_window AS identity_rank
  FROM enriched
  WINDOW identity_window AS (
    PARTITION BY organization_id, normalized_side, normalized_name
    ORDER BY
      role_reference_count DESC,
      item_reference_count DESC,
      system_only DESC,
      COALESCE(is_default, false) DESC,
      is_restricted DESC,
      force_approval DESC,
      created_at ASC,
      id ASC
  )
)
SELECT
  ranked.id AS duplicate_type_id,
  ranked.canonical_type_id,
  ranked.organization_id,
  ranked.normalized_side AS type,
  ranked.normalized_name,
  ranked.item_reference_count,
  ranked.role_reference_count
FROM ranked
WHERE ranked.identity_rank > 1;

CREATE UNIQUE INDEX income_expense_type_merge_map_duplicate_uq
  ON income_expense_type_merge_map(duplicate_type_id);
CREATE INDEX income_expense_type_merge_map_canonical_idx
  ON income_expense_type_merge_map(canonical_type_id);

CREATE TEMP TABLE cross_org_item_type_repair_map
ON COMMIT DROP
AS
SELECT
  item.id AS item_id,
  voucher.id AS voucher_id,
  source_type.id AS source_type_id,
  source_type.organization_id AS source_organization_id,
  target_type.target_type_id,
  voucher.organization_id AS target_organization_id
FROM public.income_expense_items item
JOIN public.income_expenses voucher
  ON voucher.id = item.income_expense_id
JOIN public.income_expense_types source_type
  ON source_type.id = item.income_expense_type_id
JOIN LATERAL (
  SELECT COALESCE(
           target_merge.canonical_type_id,
           candidate.id
         ) AS target_type_id
  FROM public.income_expense_types candidate
  LEFT JOIN income_expense_type_merge_map target_merge
    ON target_merge.duplicate_type_id = candidate.id
  WHERE candidate.organization_id = voucher.organization_id
    AND lower(btrim(candidate.type)) = lower(btrim(source_type.type))
    AND public.normalize_income_expense_type_name(candidate.name) =
        public.normalize_income_expense_type_name(source_type.name)
  ORDER BY
    (target_merge.duplicate_type_id IS NULL) DESC,
    candidate.created_at,
    candidate.id
  LIMIT 1
) target_type ON true
WHERE source_type.organization_id IS DISTINCT FROM voucher.organization_id;

CREATE UNIQUE INDEX cross_org_item_type_repair_map_item_uq
  ON cross_org_item_type_repair_map(item_id);

INSERT INTO public.income_expense_type_merge_audit (
  organization_id,
  duplicate_type_id,
  canonical_type_id,
  normalized_name,
  type,
  item_reference_count,
  finance_role_reference_count,
  moved_item_ids,
  duplicate_before,
  canonical_before,
  finance_role_assignments_before,
  migration_version
)
SELECT
  merge_map.organization_id,
  merge_map.duplicate_type_id,
  merge_map.canonical_type_id,
  merge_map.normalized_name,
  merge_map.type,
  merge_map.item_reference_count,
  merge_map.role_reference_count,
  ARRAY(
    SELECT item.id
    FROM public.income_expense_items item
    JOIN public.income_expenses voucher
      ON voucher.id = item.income_expense_id
    WHERE item.income_expense_type_id = merge_map.duplicate_type_id
      AND voucher.organization_id = merge_map.organization_id
    ORDER BY item.id
  ),
  to_jsonb(duplicate_row),
  to_jsonb(canonical_row),
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(assignment) ORDER BY assignment.id)
      FROM public.finance_reporting_role_assignments assignment
      WHERE assignment.income_expense_type_id = merge_map.duplicate_type_id
    ),
    '[]'::jsonb
  ),
  '20260728180000'
FROM income_expense_type_merge_map merge_map
JOIN public.income_expense_types duplicate_row
  ON duplicate_row.id = merge_map.duplicate_type_id
JOIN public.income_expense_types canonical_row
  ON canonical_row.id = merge_map.canonical_type_id;

INSERT INTO public.income_expense_type_reference_repair_audit (
  item_id,
  voucher_id,
  source_type_id,
  target_type_id,
  source_organization_id,
  target_organization_id,
  item_before,
  source_type_before,
  target_type_before,
  migration_version
)
SELECT
  repair_map.item_id,
  repair_map.voucher_id,
  repair_map.source_type_id,
  repair_map.target_type_id,
  repair_map.source_organization_id,
  repair_map.target_organization_id,
  to_jsonb(item),
  to_jsonb(source_type),
  to_jsonb(target_type),
  '20260728180000'
FROM cross_org_item_type_repair_map repair_map
JOIN public.income_expense_items item ON item.id = repair_map.item_id
JOIN public.income_expense_types source_type
  ON source_type.id = repair_map.source_type_id
JOIN public.income_expense_types target_type
  ON target_type.id = repair_map.target_type_id;

-- Updating is_restricted normally recomputes historical voucher flags. This
-- migration preserves existing voucher snapshots and applies merged metadata to
-- future items only.
DO $type_trigger_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'public.income_expense_types'::regclass
      AND trigger_row.tgname = 'ie_type_restricted_recompute'
      AND trigger_row.tgenabled NOT IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'ie_type_restricted_recompute is disabled before canonicalization'
      USING ERRCODE = '55000';
  END IF;
END
$type_trigger_guard$;

ALTER TABLE public.income_expense_types
  DISABLE TRIGGER ie_type_restricted_recompute;

WITH canonical_groups AS (
  SELECT DISTINCT
    merge_map.canonical_type_id,
    merge_map.organization_id,
    merge_map.type,
    merge_map.normalized_name
  FROM income_expense_type_merge_map merge_map
),
item_counts AS (
  SELECT item.income_expense_type_id AS type_id, count(*)::bigint AS item_count
  FROM public.income_expense_items item
  JOIN public.income_expenses voucher ON voucher.id = item.income_expense_id
  JOIN public.income_expense_types type_row
    ON type_row.id = item.income_expense_type_id
  WHERE voucher.organization_id = type_row.organization_id
  GROUP BY item.income_expense_type_id
),
merged_metadata AS (
  SELECT
    canonical_groups.canonical_type_id,
    bool_or(type_row.system_only) AS system_only,
    bool_or(COALESCE(type_row.is_default, false)) AS is_default,
    bool_or(type_row.is_restricted) AS is_restricted,
    bool_or(type_row.hide_in_report) AS hide_in_report,
    bool_or(type_row.force_approval) AS force_approval,
    (
      array_agg(
        NULLIF(btrim(type_row.category), '')
        ORDER BY
          (type_row.id = canonical_groups.canonical_type_id) DESC,
          COALESCE(item_counts.item_count, 0) DESC,
          type_row.created_at,
          type_row.id
      ) FILTER (WHERE NULLIF(btrim(type_row.category), '') IS NOT NULL)
    )[1] AS category,
    (
      array_agg(
        NULLIF(btrim(type_row.description), '')
        ORDER BY
          (type_row.id = canonical_groups.canonical_type_id) DESC,
          COALESCE(item_counts.item_count, 0) DESC,
          type_row.created_at,
          type_row.id
      ) FILTER (WHERE NULLIF(btrim(type_row.description), '') IS NOT NULL)
    )[1] AS description
  FROM canonical_groups
  JOIN public.income_expense_types type_row
    ON type_row.organization_id = canonical_groups.organization_id
   AND lower(btrim(type_row.type)) = canonical_groups.type
   AND public.normalize_income_expense_type_name(type_row.name) =
       canonical_groups.normalized_name
  LEFT JOIN item_counts ON item_counts.type_id = type_row.id
  GROUP BY canonical_groups.canonical_type_id
)
UPDATE public.income_expense_types canonical_row
SET
  system_only = merged_metadata.system_only,
  is_default = merged_metadata.is_default,
  is_restricted = merged_metadata.is_restricted,
  hide_in_report = merged_metadata.hide_in_report,
  force_approval = merged_metadata.force_approval,
  category = COALESCE(merged_metadata.category, canonical_row.category),
  description = COALESCE(merged_metadata.description, canonical_row.description),
  updated_at = clock_timestamp()
FROM merged_metadata
WHERE canonical_row.id = merged_metadata.canonical_type_id;

ALTER TABLE public.income_expense_types
  ENABLE TRIGGER ie_type_restricted_recompute;

DO $finance_role_guard$
BEGIN
  IF EXISTS (
    WITH projected AS (
      SELECT
        assignment.id,
        assignment.organization_id,
        COALESCE(merge_map.canonical_type_id, assignment.income_expense_type_id)
          AS income_expense_type_id,
        assignment.finance_reporting_role,
        assignment.effective_from,
        assignment.effective_to
      FROM public.finance_reporting_role_assignments assignment
      LEFT JOIN income_expense_type_merge_map merge_map
        ON merge_map.duplicate_type_id = assignment.income_expense_type_id
    )
    SELECT 1
    FROM projected left_role
    JOIN projected right_role
      ON right_role.id > left_role.id
     AND right_role.organization_id = left_role.organization_id
     AND right_role.income_expense_type_id = left_role.income_expense_type_id
     AND daterange(
           right_role.effective_from,
           COALESCE(right_role.effective_to, 'infinity'::date),
           '[]'
         ) && daterange(
           left_role.effective_from,
           COALESCE(left_role.effective_to, 'infinity'::date),
           '[]'
         )
    WHERE ROW(
            right_role.finance_reporting_role,
            right_role.effective_from,
            right_role.effective_to
          ) IS DISTINCT FROM ROW(
            left_role.finance_reporting_role,
            left_role.effective_from,
            left_role.effective_to
          )
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Finance reporting role overlap would become ambiguous after category canonicalization'
      USING ERRCODE = '23514';
  END IF;
END
$finance_role_guard$;

-- Exact role assignments that only differed by duplicate type ID collapse to
-- one deterministic row. Their original JSON is already in the merge audit.
WITH projected AS (
  SELECT
    assignment.id,
    assignment.income_expense_type_id,
    COALESCE(merge_map.canonical_type_id, assignment.income_expense_type_id)
      AS projected_type_id,
    row_number() OVER (
      PARTITION BY
        assignment.organization_id,
        COALESCE(merge_map.canonical_type_id, assignment.income_expense_type_id),
        assignment.finance_reporting_role,
        assignment.effective_from,
        assignment.effective_to
      ORDER BY
        (
          assignment.income_expense_type_id =
          COALESCE(merge_map.canonical_type_id, assignment.income_expense_type_id)
        ) DESC,
        assignment.id
    ) AS duplicate_rank
  FROM public.finance_reporting_role_assignments assignment
  LEFT JOIN income_expense_type_merge_map merge_map
    ON merge_map.duplicate_type_id = assignment.income_expense_type_id
)
DELETE FROM public.finance_reporting_role_assignments assignment
USING projected
WHERE assignment.id = projected.id
  AND projected.duplicate_rank > 1;

UPDATE public.finance_reporting_role_assignments assignment
SET income_expense_type_id = merge_map.canonical_type_id,
    updated_at = clock_timestamp()
FROM income_expense_type_merge_map merge_map
WHERE assignment.income_expense_type_id = merge_map.duplicate_type_id;

CREATE TEMP TABLE income_expense_type_item_invariants
ON COMMIT DROP
AS
WITH accounting_class_counts AS (
  SELECT item.accounting_class, count(*)::bigint AS row_count
  FROM public.income_expense_items item
  GROUP BY item.accounting_class
)
SELECT
  (SELECT count(*)::bigint FROM public.income_expense_items) AS item_count,
  (
    SELECT COALESCE(sum(item.amount), 0::numeric)
    FROM public.income_expense_items item
  ) AS amount_sum,
  COALESCE(
    (
      SELECT jsonb_object_agg(
        accounting_class_counts.accounting_class,
        accounting_class_counts.row_count
        ORDER BY accounting_class_counts.accounting_class
      )
      FROM accounting_class_counts
    ),
    '{}'::jsonb
  ) AS accounting_class_counts;

DO $item_trigger_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'public.income_expense_items'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled NOT IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'A user trigger on income_expense_items is disabled before canonicalization'
      USING ERRCODE = '55000';
  END IF;
END
$item_trigger_guard$;

ALTER TABLE public.income_expense_items DISABLE TRIGGER USER;

UPDATE public.income_expense_items item
SET income_expense_type_id = repair_map.target_type_id
FROM cross_org_item_type_repair_map repair_map
WHERE item.id = repair_map.item_id;

UPDATE public.income_expense_items item
SET income_expense_type_id = merge_map.canonical_type_id
FROM income_expense_type_merge_map merge_map
WHERE item.income_expense_type_id = merge_map.duplicate_type_id;

ALTER TABLE public.income_expense_items ENABLE TRIGGER USER;

DO $item_invariant_guard$
DECLARE
  before_state record;
  after_item_count bigint;
  after_amount_sum numeric;
  after_accounting_class_counts jsonb;
BEGIN
  SELECT * INTO STRICT before_state
  FROM income_expense_type_item_invariants;

  SELECT count(*)::bigint, COALESCE(sum(item.amount), 0::numeric)
    INTO after_item_count, after_amount_sum
  FROM public.income_expense_items item;

  SELECT COALESCE(
           jsonb_object_agg(counts.accounting_class, counts.row_count
                            ORDER BY counts.accounting_class),
           '{}'::jsonb
         )
    INTO after_accounting_class_counts
  FROM (
    SELECT item.accounting_class, count(*)::bigint AS row_count
    FROM public.income_expense_items item
    GROUP BY item.accounting_class
  ) counts;

  IF after_item_count IS DISTINCT FROM before_state.item_count
     OR after_amount_sum IS DISTINCT FROM before_state.amount_sum
     OR after_accounting_class_counts IS DISTINCT FROM
        before_state.accounting_class_counts THEN
    RAISE EXCEPTION 'Income/expense item monetary or accounting snapshot changed during type canonicalization'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.income_expense_items item
    JOIN income_expense_type_merge_map merge_map
      ON merge_map.duplicate_type_id = item.income_expense_type_id
  ) THEN
    RAISE EXCEPTION 'Duplicate income_expense_type_id references remain on items'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.income_expense_items item
    JOIN public.income_expenses voucher
      ON voucher.id = item.income_expense_id
    JOIN public.income_expense_types type_row
      ON type_row.id = item.income_expense_type_id
    WHERE type_row.organization_id IS DISTINCT FROM voucher.organization_id
       OR item.organization_id IS DISTINCT FROM voucher.organization_id
  ) THEN
    RAISE EXCEPTION 'Type organization mismatch remains after repair'
      USING ERRCODE = '23514';
  END IF;
END
$item_invariant_guard$;

DO $reference_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.finance_reporting_role_assignments assignment
    JOIN income_expense_type_merge_map merge_map
      ON merge_map.duplicate_type_id = assignment.income_expense_type_id
  ) THEN
    RAISE EXCEPTION 'Duplicate income_expense_type_id references remain on finance reporting roles'
      USING ERRCODE = '23503';
  END IF;
END
$reference_guard$;

DELETE FROM public.income_expense_types type_row
USING income_expense_type_merge_map merge_map
WHERE type_row.id = merge_map.duplicate_type_id;

DO $dedup_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.income_expense_types type_row
    GROUP BY
      type_row.organization_id,
      lower(btrim(type_row.type)),
      public.normalize_income_expense_type_name(type_row.name)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Normalized income/expense type duplicates remain after canonicalization'
      USING ERRCODE = '23505';
  END IF;
END
$dedup_guard$;

CREATE UNIQUE INDEX income_expense_types_org_side_normalized_name_uq
ON public.income_expense_types (
  organization_id,
  lower(btrim(type)),
  public.normalize_income_expense_type_name(name)
);

-- Internal resolver used by the remaining legacy writer signatures that only
-- carry user_id. Ambiguous multi-organization ownership fails closed.
CREATE OR REPLACE FUNCTION app_private.resolve_ie_type_org_for_user_v1(
  p_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, app_private, public
AS $resolve_org$
DECLARE
  v_organization_id uuid;
  v_organizations uuid[];
BEGIN
  -- profiles.organization_id is the current organization selected by the
  -- application. Historical buildings or type ownership must not make an
  -- otherwise current owner look ambiguously multi-organization.
  SELECT profile.organization_id
    INTO v_organization_id
  FROM public.profiles profile
  WHERE profile.id = p_user_id
    AND profile.organization_id IS NOT NULL;

  IF v_organization_id IS NOT NULL THEN
    RETURN v_organization_id;
  END IF;

  SELECT array_agg(DISTINCT membership.organization_id
                   ORDER BY membership.organization_id)
    INTO v_organizations
  FROM public.organization_memberships membership
  WHERE membership.user_id = p_user_id
    AND membership.status = 'ACTIVE';

  IF COALESCE(cardinality(v_organizations), 0) = 0 THEN
    RAISE EXCEPTION 'Cannot resolve a current organization for income/expense type owner %',
      p_user_id USING ERRCODE = '23514';
  END IF;
  IF cardinality(v_organizations) <> 1 THEN
    RAISE EXCEPTION 'Income/expense type owner % has multiple active organizations; an explicit organization is required',
      p_user_id USING ERRCODE = '23514';
  END IF;

  RETURN v_organizations[1];
END
$resolve_org$;

REVOKE ALL ON FUNCTION app_private.resolve_ie_type_org_for_user_v1(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.ensure_income_expense_type_v1(
  p_organization_id uuid,
  p_user_id uuid,
  p_name text,
  p_type text,
  p_category text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_is_default boolean DEFAULT false,
  p_is_deposit boolean DEFAULT false,
  p_is_restricted boolean DEFAULT false,
  p_hide_in_report boolean DEFAULT false,
  p_force_approval boolean DEFAULT false,
  p_system_only boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $ensure_type$
DECLARE
  v_type_id uuid;
  v_existing_deposit boolean;
  v_side text := lower(btrim(COALESCE(p_type, '')));
  v_normalized_name text := public.normalize_income_expense_type_name(p_name);
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Organization and owner are required for an income/expense type'
      USING ERRCODE = '23502';
  END IF;
  IF v_side NOT IN ('income', 'expense') THEN
    RAISE EXCEPTION 'Invalid income/expense type side: %', p_type
      USING ERRCODE = '23514';
  END IF;
  IF v_normalized_name = '' THEN
    RAISE EXCEPTION 'Income/expense type name cannot be empty'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_organization_id::text || ':' || v_side || ':' || v_normalized_name,
      0
    )
  );

  SELECT type_row.id, type_row.is_deposit
    INTO v_type_id, v_existing_deposit
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = p_organization_id
    AND lower(btrim(type_row.type)) = v_side
    AND public.normalize_income_expense_type_name(type_row.name) =
        v_normalized_name
  FOR UPDATE;

  IF v_type_id IS NOT NULL THEN
    IF v_existing_deposit IS DISTINCT FROM p_is_deposit THEN
      RAISE EXCEPTION 'Existing type % has incompatible is_deposit semantics',
        v_type_id USING ERRCODE = '23514';
    END IF;

    UPDATE public.income_expense_types type_row
    SET
      category = COALESCE(NULLIF(btrim(type_row.category), ''), p_category),
      description = COALESCE(NULLIF(btrim(type_row.description), ''), p_description),
      is_default = COALESCE(type_row.is_default, false) OR p_is_default,
      is_restricted = type_row.is_restricted OR p_is_restricted,
      hide_in_report = type_row.hide_in_report OR p_hide_in_report,
      force_approval = type_row.force_approval OR p_force_approval,
      system_only = type_row.system_only OR p_system_only,
      updated_at = clock_timestamp()
    WHERE type_row.id = v_type_id;

    RETURN v_type_id;
  END IF;

  INSERT INTO public.income_expense_types (
    user_id,
    organization_id,
    name,
    type,
    category,
    description,
    is_default,
    is_deposit,
    is_restricted,
    hide_in_report,
    force_approval,
    system_only
  ) VALUES (
    p_user_id,
    p_organization_id,
    btrim(p_name),
    v_side,
    NULLIF(btrim(p_category), ''),
    NULLIF(btrim(p_description), ''),
    p_is_default,
    p_is_deposit,
    p_is_restricted,
    p_hide_in_report,
    p_force_approval,
    p_system_only
  )
  RETURNING id INTO v_type_id;

  RETURN v_type_id;
END
$ensure_type$;

REVOKE ALL ON FUNCTION app_private.ensure_income_expense_type_v1(
  uuid, uuid, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.seed_commission_expense_types(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $seed_commission$
DECLARE
  v_organization_id uuid;
BEGIN
  v_organization_id := app_private.resolve_ie_type_org_for_user_v1(p_user_id);

  PERFORM app_private.ensure_income_expense_type_v1(
    p_organization_id => v_organization_id,
    p_user_id => p_user_id,
    p_name => 'Hoa hồng môi giới',
    p_type => 'expense',
    p_description => 'Tự động tạo khi tạo hợp đồng — % tiền phòng theo bậc tháng cấu hình ở tòa nhà.',
    p_force_approval => true,
    p_system_only => true
  );

  PERFORM app_private.ensure_income_expense_type_v1(
    p_organization_id => v_organization_id,
    p_user_id => p_user_id,
    p_name => 'Thưởng nóng Sale',
    p_type => 'expense',
    p_description => 'Thưởng cho Sale khi tạo hợp đồng — số tiền do người dùng nhập.',
    p_force_approval => true,
    p_system_only => true
  );
END
$seed_commission$;

REVOKE ALL ON FUNCTION public.seed_commission_expense_types(uuid)
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created_seed_commission_types ON auth.users;
DROP FUNCTION IF EXISTS public.trg_seed_commission_types_on_user_create();

CREATE OR REPLACE FUNCTION public.resolve_fixed_expense_type(
  p_owner uuid,
  p_category_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $resolve_fixed$
DECLARE
  v_type uuid;
  v_name text;
  v_category text;
  v_organization_id uuid;
BEGIN
  IF p_category_key NOT IN (
    'tien_nha', 'dien', 'nuoc', 'internet', 'quan_ly',
    've_sinh', 'cong_an', 'rac', 'thang_may'
  ) THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_category_key
      USING ERRCODE = '23514';
  END IF;

  v_organization_id := app_private.resolve_ie_type_org_for_user_v1(p_owner);

  SELECT type_row.id
    INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_organization_id
    AND lower(btrim(type_row.type)) = 'expense'
    AND public.fee_type_matches(
      p_category_key,
      type_row.category,
      type_row.name
    )
  ORDER BY
    COALESCE(type_row.is_default, false) DESC,
    type_row.created_at,
    type_row.id
  LIMIT 1;

  IF v_type IS NOT NULL THEN
    RETURN v_type;
  END IF;

  v_name := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Đóng tiền điện'
    WHEN 'nuoc'      THEN 'Đóng tiền nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản Lý'
    WHEN 've_sinh'   THEN 'Vệ sinh tòa nhà định kỳ'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Tiền rác'
    WHEN 'thang_may' THEN 'Bảo trì thang máy'
  END;
  v_category := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Điện'
    WHEN 'nuoc'      THEN 'Nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản Lý'
    WHEN 've_sinh'   THEN 'Vệ sinh'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Rác'
    WHEN 'thang_may' THEN 'Bảo Trì Thang Máy'
  END;

  RETURN app_private.ensure_income_expense_type_v1(
    p_organization_id => v_organization_id,
    p_user_id => p_owner,
    p_name => v_name,
    p_type => 'expense',
    p_category => v_category,
    p_is_restricted => (p_category_key = 'quan_ly')
  );
END
$resolve_fixed$;

REVOKE ALL ON FUNCTION public.resolve_fixed_expense_type(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fixed_expense_type(uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.create_commission_voucher(
  p_contract_id uuid,
  p_kind text,
  p_amount numeric,
  p_voucher_date date,
  p_account_id uuid DEFAULT NULL,
  p_payer_name text DEFAULT NULL,
  p_recipient_name text DEFAULT NULL,
  p_recipient_bank text DEFAULT NULL,
  p_recipient_account text DEFAULT NULL,
  p_item_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $create_commission$
DECLARE
  v_uid uuid := auth.uid();
  v_contract record;
  v_existing record;
  v_type_id uuid;
  v_type_name text;
  v_kind_label text;
  v_creator text;
  v_name text;
  v_id uuid;
  v_code text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('broker', 'sale') THEN
    RAISE EXCEPTION 'Loại hoa hồng không hợp lệ: %', COALESCE(p_kind, 'null')
      USING ERRCODE = '23514';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền hoa hồng phải lớn hơn 0'
      USING ERRCODE = '23514';
  END IF;
  IF p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Thiếu ngày chi' USING ERRCODE = '23502';
  END IF;

  SELECT
    contract_row.id,
    contract_row.contract_number,
    room_row.id AS room_id,
    building_row.id AS building_id,
    building_row.user_id AS owner_id,
    COALESCE(contract_row.organization_id, building_row.organization_id)
      AS organization_id
  INTO v_contract
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hợp đồng' USING ERRCODE = 'P0002';
  END IF;
  IF v_contract.organization_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa thuộc tổ chức'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    public.can_access_building(v_contract.building_id)
    OR public.ie_all_buildings_scope(v_contract.building_id)
    OR v_contract.owner_id = v_uid
    OR public.is_admin()
    OR public.is_super_admin()
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền chi hoa hồng cho tòa nhà này'
      USING ERRCODE = '42501';
  END IF;

  v_kind_label := CASE p_kind
    WHEN 'broker' THEN 'hoa hồng môi giới'
    ELSE 'thưởng nóng Sale'
  END;

  PERFORM pg_advisory_xact_lock(
    hashtext('commission:' || p_contract_id::text || ':' || p_kind)
  );

  SELECT voucher.code
    INTO v_existing
  FROM public.income_expenses voucher
  WHERE voucher.contract_id = p_contract_id
    AND voucher.commission_kind = p_kind
    AND voucher.deleted_at IS NULL
    AND voucher.approval_status <> 'CANCELLED'
  ORDER BY voucher.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'HĐ % đã có phiếu % (mã %). Mỗi hợp đồng chỉ chi 1 lần — không thể tạo thêm. Nếu phiếu cũ sai, hãy hủy phiếu đó trước.',
      COALESCE(v_contract.contract_number, ''),
      v_kind_label,
      v_existing.code
      USING ERRCODE = 'P0001';
  END IF;

  v_type_name := CASE p_kind
    WHEN 'broker' THEN 'Hoa hồng môi giới'
    ELSE 'Thưởng nóng Sale'
  END;

  SELECT t.id
    INTO v_type_id
  FROM public.income_expense_types AS t
  WHERE t.organization_id = v_contract.organization_id
    AND lower(btrim(t.type)) = 'expense'
    AND public.normalize_income_expense_type_name(t.name) =
        public.normalize_income_expense_type_name(v_type_name)
  ORDER BY COALESCE(t.is_default, false) DESC, t.created_at, t.id
  LIMIT 1;

  IF v_type_id IS NULL THEN
    v_type_id := app_private.ensure_income_expense_type_v1(
      p_organization_id => v_contract.organization_id,
      p_user_id => v_contract.owner_id,
      p_name => v_type_name,
      p_type => 'expense',
      p_description => CASE p_kind
        WHEN 'broker' THEN 'Tự động tạo khi tạo hợp đồng — % tiền phòng theo bậc tháng cấu hình ở tòa nhà.'
        ELSE 'Thưởng cho Sale khi tạo hợp đồng — số tiền do người dùng nhập.'
      END,
      p_force_approval => true,
      p_system_only => true
    );
  END IF;

  SELECT COALESCE(
           NULLIF(profile.full_name, ''),
           NULLIF(profile.email, ''),
           auth_user.email,
           'Người dùng'
         )
    INTO v_creator
  FROM auth.users auth_user
  LEFT JOIN public.profiles profile ON profile.id = auth_user.id
  WHERE auth_user.id = v_uid;

  v_name := btrim(
    CASE p_kind
      WHEN 'broker' THEN 'Hoa hồng môi giới HĐ '
      ELSE 'Thưởng nóng Sale HĐ '
    END || COALESCE(v_contract.contract_number, '')
  );

  INSERT INTO public.income_expenses (
    user_id,
    organization_id,
    creator_name,
    type,
    approval_status,
    name,
    building_id,
    room_id,
    tenant_id,
    contract_id,
    voucher_date,
    account_id,
    payer_name,
    receive_bank_name,
    receive_bank_account,
    notes,
    attachments,
    business_result_accounting,
    repeat_cycle,
    repeat_infinity,
    repeat_count,
    repeat_remaining,
    commission_kind,
    system_source
  ) VALUES (
    v_uid,
    v_contract.organization_id,
    v_creator,
    'EXPENSE',
    'UNAPPROVED',
    v_name,
    v_contract.building_id,
    v_contract.room_id,
    NULL,
    p_contract_id,
    p_voucher_date,
    p_account_id,
    p_payer_name,
    p_recipient_bank,
    p_recipient_account,
    CASE
      WHEN COALESCE(p_recipient_name, '') <> ''
        THEN 'Người nhận: ' || p_recipient_name
      ELSE NULL
    END,
    '[]'::jsonb,
    NULL,
    'NONE',
    false,
    0,
    0,
    p_kind,
    'contract.commission'
  )
  RETURNING id, code INTO v_id, v_code;

  INSERT INTO public.income_expense_items (
    income_expense_id,
    income_expense_type_id,
    organization_id,
    description,
    quantity,
    unit_price,
    start_date,
    end_date
  ) VALUES (
    v_id,
    v_type_id,
    v_contract.organization_id,
    COALESCE(NULLIF(p_item_description, ''), v_name),
    1,
    p_amount,
    p_voucher_date,
    p_voucher_date
  );

  RETURN jsonb_build_object('id', v_id, 'code', v_code);
END
$create_commission$;

REVOKE ALL ON FUNCTION public.create_commission_voucher(
  uuid, text, numeric, date, uuid, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_commission_voucher(
  uuid, text, numeric, date, uuid, text, text, text, text, text
) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
