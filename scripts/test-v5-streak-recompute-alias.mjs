#!/usr/bin/env node
// Reapply the alias hotfix, exercise the full attendance path, then rollback.
import { readFileSync } from "node:fs";

const migrationFile =
  "supabase/migrations/20260721150000_v5_streak_recompute_alias_fix.sql";
const projectRef = readFileSync("supabase/.temp/project-ref", "utf8").trim();
const localConfig = readFileSync("CLAUDE.local.md", "utf8");
const pat = (localConfig.match(/sbp_[a-z0-9]+/) || [])[0];

if (!pat) {
  console.error("Missing Supabase PAT in CLAUDE.local.md");
  process.exit(1);
}

const migrationBody = readFileSync(migrationFile, "utf8")
  .replace(/^\uFEFF?\s*BEGIN;\s*/i, "")
  .replace(/\s*COMMIT;[\s\S]*$/i, "");

const assertions = String.raw`
DO $test$
DECLARE
  v_staff uuid;
  v_today date := public.vn_local_date(now());
  v_result jsonb;
  v_definition text;
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.v5_recompute_streak(uuid,date)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.v5_recompute_streak(uuid,date)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'client role can execute internal v5_recompute_streak';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.v5_recompute_streak(uuid,date)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role cannot execute v5_recompute_streak';
  END IF;

  v_definition := regexp_replace(
    lower(pg_get_functiondef(
      'public.v5_recompute_streak(uuid,date)'::regprocedure
    )),
    '[[:space:]]+',
    '',
    'g'
  );

  IF position(';mjsonb;' IN v_definition) > 0
    OR position(
      'selectmintov_fmfromjsonb_array_elements(v_miles)mwhere'
      IN v_definition
    ) > 0 THEN
    RAISE EXCEPTION 'ambiguous milestone variable/alias remains in function';
  END IF;

  IF position(
    'fromjsonb_array_elements(v_miles)asmilestone_item(value)'
    IN v_definition
  ) = 0 THEN
    RAISE EXCEPTION 'explicit milestone_item alias is missing';
  END IF;

  SELECT sa.staff_id
  INTO v_staff
  FROM public.staff_assignments sa
  JOIN public.profiles p ON p.id = sa.staff_id
  JOIN public.organization_memberships om
    ON om.user_id = sa.staff_id
   AND om.organization_id = 'dddd0000-0000-4000-8000-000000000001'::uuid
   AND om.status = 'ACTIVE'
  WHERE sa.staff_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.salary_monthly sm
      WHERE sm.staff_id = sa.staff_id
        AND sm.period_month = date_trunc('month', v_today)::date
        AND sm.locked_at IS NOT NULL
    )
  ORDER BY sa.staff_id
  LIMIT 1;

  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'no eligible demo staff found for streak regression test';
  END IF;

  PERFORM set_config('v5_streak_test.staff_id', v_staff::text, true);

  v_result := public.v5_tick_attendance(
    v_staff,
    v_today,
    'FULL',
    gen_random_uuid(),
    'alias regression'
  );

  IF jsonb_typeof(v_result) IS DISTINCT FROM 'object'
    OR v_result->>'ticked' IS DISTINCT FROM 'true'
    OR jsonb_typeof(v_result->'streak') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'attendance path returned invalid JSON: %', v_result;
  END IF;
END;
$test$;

SELECT set_config(
  'request.jwt.claim.sub',
  current_setting('v5_streak_test.staff_id'),
  true
);

SET LOCAL ROLE authenticated;

DO $authenticated_path$
DECLARE
  v_staff uuid := current_setting('v5_streak_test.staff_id')::uuid;
  v_summary jsonb;
BEGIN
  BEGIN
    PERFORM public.v5_recompute_streak(
      v_staff,
      date_trunc('month', public.vn_local_date(now()))::date
    );
    RAISE EXCEPTION 'authenticated executed internal v5_recompute_streak';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  v_summary := public.get_my_day_summary();
  IF jsonb_typeof(v_summary) IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_summary->'streak') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'get_my_day_summary internal streak path returned invalid JSON';
  END IF;
END;
$authenticated_path$;

RESET ROLE;
`;

const sql = `BEGIN;\n${migrationBody}\n${migrationBody}\n${assertions}\nROLLBACK;`;
const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  },
);
const body = await response.text();

if (!response.ok) {
  console.error(`V5 streak alias validation failed (${response.status})`);
  console.error(body.slice(0, 4000));
  process.exit(1);
}

console.log(
  "Validated idempotent V5 streak alias hotfix through v5_tick_attendance with ROLLBACK.",
);
