// Exact task surfaces only. Generated from reviewed definitions and an offline
// PostgreSQL 18.3/PGlite 0.5.4 catalog, byte-matched on local PostgreSQL 17.10.
// TEST 17.6 deparse equivalence is unmeasured;
// an exact future match is required, never a permissive version fallback.
export const TASK_FUNCTIONS = Object.freeze([
  {
    "signature": "app_private.hermes_task_guard_v1(jsonb,text,jsonb,boolean)",
    "name": "app_private.hermes_task_guard_v1",
    "language": "plpgsql",
    "definer": true,
    "searchPath": "pg_catalog,public,app_private",
    "authenticated": true,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION app_private.hermes_task_guard_v1(p_binding jsonb,p_operation text,p_input jsonb,p_finish boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private"
  },
  {
    "signature": "app_private.hermes_task_insert_v1(jsonb)",
    "name": "app_private.hermes_task_insert_v1",
    "language": "plpgsql",
    "definer": false,
    "searchPath": "pg_catalog,public",
    "authenticated": true,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION app_private.hermes_task_insert_v1(p_plan jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public"
  },
  {
    "signature": "app_private.hermes_task_finish_v1(jsonb,text,jsonb)",
    "name": "app_private.hermes_task_finish_v1",
    "language": "plpgsql",
    "definer": true,
    "searchPath": "pg_catalog,public,app_private",
    "authenticated": true,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION app_private.hermes_task_finish_v1(p_binding jsonb,p_operation text,p_plan jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private"
  },
  {
    "signature": "public.hermes_task_create_action_v1(jsonb,text,jsonb)",
    "name": "public.hermes_task_create_action_v1",
    "language": "sql",
    "definer": false,
    "searchPath": "pg_catalog,public",
    "authenticated": true,
    "standard": true,
    "header": "CREATE OR REPLACE FUNCTION public.hermes_task_create_action_v1(p_binding jsonb,p_operation text,p_input jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public",
    "statement": "CREATE OR REPLACE FUNCTION public.hermes_task_create_action_v1(p_binding jsonb,p_operation text,p_input jsonb)\nRETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public\nBEGIN ATOMIC\n SELECT app_private.hermes_task_finish_v1(p_binding,p_operation,\n  app_private.hermes_task_insert_v1(app_private.hermes_task_guard_v1(p_binding,p_operation,p_input,false)));\nEND",
    "statementSha256": "863ab52a9a8fa96504a15b9eb4be87001fad51312dbe6c8db4b2370b55098657",
    "deparsedDefinition": "CREATE OR REPLACE FUNCTION public.hermes_task_create_action_v1(p_binding jsonb, p_operation text, p_input jsonb)\n RETURNS jsonb\n LANGUAGE sql\n SET search_path TO 'pg_catalog', 'public'\nBEGIN ATOMIC\n SELECT app_private.hermes_task_finish_v1(p_binding, p_operation, app_private.hermes_task_insert_v1(app_private.hermes_task_guard_v1(p_binding, p_operation, p_input, false))) AS hermes_task_finish_v1;\nEND\n",
    "deparsedSha256": "8376f52681306536722b82b77a7017cd0bdeef166c5fa6794d122ca3769ae602",
    "dependencies": [
      {
        "type": "function",
        "identity": "app_private.hermes_task_finish_v1(pg_catalog.jsonb,pg_catalog.text,pg_catalog.jsonb)",
        "deptype": "n"
      },
      {
        "type": "function",
        "identity": "app_private.hermes_task_guard_v1(pg_catalog.jsonb,pg_catalog.text,pg_catalog.jsonb,boolean)",
        "deptype": "n"
      },
      {
        "type": "function",
        "identity": "app_private.hermes_task_insert_v1(pg_catalog.jsonb)",
        "deptype": "n"
      },
      {
        "type": "schema",
        "identity": "public",
        "deptype": "n"
      }
    ]
  },
  {
    "signature": "public.hermes_task_create_capabilities_v1(uuid)",
    "name": "public.hermes_task_create_capabilities_v1",
    "language": "plpgsql",
    "definer": true,
    "searchPath": "pg_catalog,public,app_private",
    "authenticated": true,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION public.hermes_task_create_capabilities_v1(p_organization_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private",
    successors: Object.freeze({
      'supabase/migrations/20261019034254_hermes_metadata_read_snapshot_v1.sql': Object.freeze({
        bodyDigest: 'e8e9326bbff99b15e08de2603314f54844391c5e9c9e85fc2a6c00d35a6b3e6b', volatility: 's',
      }),
    }),
  },
  {
    "signature": "app_private.hermes_task_extend_options_v1(jsonb,text)",
    "name": "app_private.hermes_task_extend_options_v1",
    "language": "plpgsql",
    "definer": true,
    "searchPath": "pg_catalog,public,app_private",
    "authenticated": false,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION app_private.hermes_task_extend_options_v1(p_result jsonb,p_kind text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private"
  },
  {
    "signature": "public.hermes_org_policy_options_v5(uuid)",
    "name": "public.hermes_org_policy_options_v5",
    "language": "plpgsql",
    "definer": true,
    "searchPath": "pg_catalog,public,app_private",
    "authenticated": true,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v5(p_org uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private"
  },
  {
    "signature": "public.hermes_connection_options_v5(uuid)",
    "name": "public.hermes_connection_options_v5",
    "language": "plpgsql",
    "definer": true,
    "searchPath": "pg_catalog,public,app_private",
    "authenticated": true,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION public.hermes_connection_options_v5(p_org uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private"
  },
  {
    "signature": "public.hermes_connection_context_v5(uuid)",
    "name": "public.hermes_connection_context_v5",
    "language": "plpgsql",
    "definer": true,
    "searchPath": "pg_catalog,public,app_private",
    "authenticated": true,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION public.hermes_connection_context_v5(p_connection_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private"
  },
  {
    "signature": "app_private.hermes_task_input_guard_v1(jsonb,jsonb)",
    "name": "app_private.hermes_task_input_guard_v1",
    "language": "plpgsql",
    "definer": true,
    "searchPath": "pg_catalog,public,app_private",
    "authenticated": true,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION app_private.hermes_task_input_guard_v1(p_binding jsonb,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private"
  },
  {
    "signature": "app_private.hermes_task_assignee_member_v1(uuid,uuid)",
    "name": "app_private.hermes_task_assignee_member_v1",
    "language": "sql",
    "definer": true,
    "searchPath": "pg_catalog,public",
    "authenticated": true,
    "standard": false,
    "header": "CREATE OR REPLACE FUNCTION app_private.hermes_task_assignee_member_v1(p_user uuid,p_org uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public"
  },
  {
    "signature": "app_private.hermes_task_input_rows_v1(jsonb)",
    "name": "app_private.hermes_task_input_rows_v1",
    "language": "sql",
    "definer": false,
    "searchPath": "pg_catalog,public",
    "authenticated": true,
    "standard": true,
    "header": "CREATE OR REPLACE FUNCTION app_private.hermes_task_input_rows_v1(p_plan jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public",
    "statement": "CREATE OR REPLACE FUNCTION app_private.hermes_task_input_rows_v1(p_plan jsonb)\nRETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public\nBEGIN ATOMIC\n WITH args AS (SELECT p_plan->'input' AS input,(p_plan->>'organizationId')::uuid AS org,\n   ARRAY(SELECT jsonb_array_elements_text(p_plan->'buildingIds')::uuid) AS buildings),\n candidates AS (\n  SELECT b.id,b.name AS label FROM public.buildings b,args x WHERE x.input->>'kind'='buildings' AND b.id=ANY(x.buildings) AND b.organization_id=x.org AND b.deleted_at IS NULL\n  UNION ALL\n  SELECT r.id,r.name FROM public.rooms r,args x WHERE x.input->>'kind'='rooms' AND r.building_id=(x.input->>'buildingId')::uuid AND r.organization_id=x.org AND r.deleted_at IS NULL\n   AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=r.building_id AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))\n  UNION ALL\n  SELECT j.id,j.name FROM public.job_types j,args x WHERE x.input->>'kind'='jobTypes' AND j.organization_id=x.org\n   AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(x.input->>'buildingId')::uuid AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))\n  UNION ALL\n  SELECT p.id,p.full_name FROM public.profiles p,args x WHERE x.input->>'kind'='assignees' AND app_private.hermes_task_assignee_member_v1(p.id,x.org)\n   AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(x.input->>'buildingId')::uuid AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))\n ), selected AS MATERIALIZED (\n  SELECT id,COALESCE(label,'(Chưa đặt tên)') AS label FROM candidates,args x\n  WHERE (x.input->>'cursor' IS NULL OR id>(x.input->>'cursor')::uuid)\n   AND strpos(lower(COALESCE(label,'(Chưa đặt tên)')),lower(x.input->>'query'))>0\n  ORDER BY id LIMIT ((p_plan#>>'{input,limit}')::int+1)\n ), visible AS (SELECT * FROM selected ORDER BY id LIMIT (p_plan#>>'{input,limit}')::int)\n SELECT jsonb_build_object('organizationId',p_plan->'organizationId','kind',p_plan#>'{input,kind}','buildingId',p_plan#>'{input,buildingId}',\n  'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'label',label) ORDER BY id) FROM visible),'[]'::jsonb),\n  'nextCursor',CASE WHEN (SELECT count(*) FROM selected)>(p_plan#>>'{input,limit}')::int THEN (SELECT max(id::text) FROM visible) ELSE NULL END);\nEND",
    "statementSha256": "528ae2409e4378a7521966197d701fa63edcf732a4e5afce67c616de9d83a10b",
    "deparsedDefinition": "CREATE OR REPLACE FUNCTION app_private.hermes_task_input_rows_v1(p_plan jsonb)\n RETURNS jsonb\n LANGUAGE sql\n SET search_path TO 'pg_catalog', 'public'\nBEGIN ATOMIC\n WITH args AS (\n          SELECT (p_plan -> 'input'::text) AS input,\n             ((p_plan ->> 'organizationId'::text))::uuid AS org,\n             ARRAY( SELECT (jsonb_array_elements_text((p_plan -> 'buildingIds'::text)))::uuid AS jsonb_array_elements_text) AS buildings\n         ), candidates AS (\n          SELECT b.id,\n             b.name AS label\n            FROM public.buildings b,\n             args x\n           WHERE (((x.input ->> 'kind'::text) = 'buildings'::text) AND (b.id = ANY (x.buildings)) AND (b.organization_id = x.org) AND (b.deleted_at IS NULL))\n         UNION ALL\n          SELECT r.id,\n             r.name\n            FROM public.rooms r,\n             args x\n           WHERE (((x.input ->> 'kind'::text) = 'rooms'::text) AND (r.building_id = ((x.input ->> 'buildingId'::text))::uuid) AND (r.organization_id = x.org) AND (r.deleted_at IS NULL) AND (EXISTS ( SELECT 1\n                    FROM public.buildings b\n                   WHERE ((b.id = r.building_id) AND (b.organization_id = x.org) AND (b.deleted_at IS NULL) AND (b.id = ANY (x.buildings))))))\n         UNION ALL\n          SELECT j.id,\n             j.name\n            FROM public.job_types j,\n             args x\n           WHERE (((x.input ->> 'kind'::text) = 'jobTypes'::text) AND (j.organization_id = x.org) AND (EXISTS ( SELECT 1\n                    FROM public.buildings b\n                   WHERE ((b.id = ((x.input ->> 'buildingId'::text))::uuid) AND (b.organization_id = x.org) AND (b.deleted_at IS NULL) AND (b.id = ANY (x.buildings))))))\n         UNION ALL\n          SELECT p.id,\n             p.full_name\n            FROM public.profiles p,\n             args x\n           WHERE (((x.input ->> 'kind'::text) = 'assignees'::text) AND app_private.hermes_task_assignee_member_v1(p.id, x.org) AND (EXISTS ( SELECT 1\n                    FROM public.buildings b\n                   WHERE ((b.id = ((x.input ->> 'buildingId'::text))::uuid) AND (b.organization_id = x.org) AND (b.deleted_at IS NULL) AND (b.id = ANY (x.buildings))))))\n         ), selected AS MATERIALIZED (\n          SELECT candidates.id,\n             COALESCE(candidates.label, '(Chưa đặt tên)'::text) AS label\n            FROM candidates,\n             args x\n           WHERE ((((x.input ->> 'cursor'::text) IS NULL) OR (candidates.id > ((x.input ->> 'cursor'::text))::uuid)) AND (strpos(lower(COALESCE(candidates.label, '(Chưa đặt tên)'::text)), lower((x.input ->> 'query'::text))) > 0))\n           ORDER BY candidates.id\n          LIMIT (((hermes_task_input_rows_v1.p_plan #>> '{input,limit}'::text[]))::integer + 1)\n         ), visible AS (\n          SELECT selected.id,\n             selected.label\n            FROM selected\n           ORDER BY selected.id\n          LIMIT ((hermes_task_input_rows_v1.p_plan #>> '{input,limit}'::text[]))::integer\n         )\n  SELECT jsonb_build_object('organizationId', (p_plan -> 'organizationId'::text), 'kind', (p_plan #> '{input,kind}'::text[]), 'buildingId', (p_plan #> '{input,buildingId}'::text[]), 'items', COALESCE(( SELECT jsonb_agg(jsonb_build_object('id', visible.id, 'label', visible.label) ORDER BY visible.id) AS jsonb_agg\n            FROM visible), '[]'::jsonb), 'nextCursor',\n         CASE\n             WHEN (( SELECT count(*) AS count\n                FROM selected) > ((p_plan #>> '{input,limit}'::text[]))::integer) THEN ( SELECT max((visible.id)::text) AS max\n                FROM visible)\n             ELSE NULL::text\n         END) AS jsonb_build_object;\nEND\n",
    "deparsedSha256": "516e0b1030135a2bfc758d5553398f52c805586f88aa02882ead63d855a3587e",
    "dependencies": [
      {
        "type": "function",
        "identity": "app_private.hermes_task_assignee_member_v1(pg_catalog.uuid,pg_catalog.uuid)",
        "deptype": "n"
      },
      {
        "type": "schema",
        "identity": "app_private",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.buildings.deleted_at",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.buildings.id",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.buildings.name",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.buildings.organization_id",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.job_types.id",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.job_types.name",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.job_types.organization_id",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.profiles.full_name",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.profiles.id",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.rooms.building_id",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.rooms.deleted_at",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.rooms.id",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.rooms.name",
        "deptype": "n"
      },
      {
        "type": "table column",
        "identity": "public.rooms.organization_id",
        "deptype": "n"
      }
    ],
    // 22/10/2026 (câu 29): jobTypes/assignees with buildingId null (company catalog; tasks.create on at least one
    // building of the connection scope, checked by the guard). Same generator as the base statement (PGlite 0.5.4 /
    // PostgreSQL 18.3 catalog), byte-matched on local PostgreSQL 17.10; dependencies unchanged (the base list applies).
    successors: Object.freeze({
      'supabase/migrations/20261021172540_hermes_task_input_options_no_building_v1.sql': Object.freeze({
        statement: "CREATE OR REPLACE FUNCTION app_private.hermes_task_input_rows_v1(p_plan jsonb)\nRETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public\nBEGIN ATOMIC\n WITH args AS (SELECT p_plan->'input' AS input,(p_plan->>'organizationId')::uuid AS org,\n   ARRAY(SELECT jsonb_array_elements_text(p_plan->'buildingIds')::uuid) AS buildings),\n candidates AS (\n  SELECT b.id,b.name AS label FROM public.buildings b,args x WHERE x.input->>'kind'='buildings' AND b.id=ANY(x.buildings) AND b.organization_id=x.org AND b.deleted_at IS NULL\n  UNION ALL\n  SELECT r.id,r.name FROM public.rooms r,args x WHERE x.input->>'kind'='rooms' AND r.building_id=(x.input->>'buildingId')::uuid AND r.organization_id=x.org AND r.deleted_at IS NULL\n   AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=r.building_id AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))\n  UNION ALL\n  SELECT j.id,j.name FROM public.job_types j,args x WHERE x.input->>'kind'='jobTypes' AND j.organization_id=x.org\n   AND EXISTS(SELECT 1 FROM public.buildings b WHERE (x.input->>'buildingId' IS NULL OR b.id=(x.input->>'buildingId')::uuid) AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))\n  UNION ALL\n  SELECT p.id,p.full_name FROM public.profiles p,args x WHERE x.input->>'kind'='assignees' AND app_private.hermes_task_assignee_member_v1(p.id,x.org)\n   AND EXISTS(SELECT 1 FROM public.buildings b WHERE (x.input->>'buildingId' IS NULL OR b.id=(x.input->>'buildingId')::uuid) AND b.organization_id=x.org AND b.deleted_at IS NULL AND b.id=ANY(x.buildings))\n ), selected AS MATERIALIZED (\n  SELECT id,COALESCE(label,'(Chưa đặt tên)') AS label FROM candidates,args x\n  WHERE (x.input->>'cursor' IS NULL OR id>(x.input->>'cursor')::uuid)\n   AND strpos(lower(COALESCE(label,'(Chưa đặt tên)')),lower(x.input->>'query'))>0\n  ORDER BY id LIMIT ((p_plan#>>'{input,limit}')::int+1)\n ), visible AS (SELECT * FROM selected ORDER BY id LIMIT (p_plan#>>'{input,limit}')::int)\n SELECT jsonb_build_object('organizationId',p_plan->'organizationId','kind',p_plan#>'{input,kind}','buildingId',p_plan#>'{input,buildingId}',\n  'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'label',label) ORDER BY id) FROM visible),'[]'::jsonb),\n  'nextCursor',CASE WHEN (SELECT count(*) FROM selected)>(p_plan#>>'{input,limit}')::int THEN (SELECT max(id::text) FROM visible) ELSE NULL END);\nEND",
        statementSha256: "5b363ab367e109c5ad49ff31b39f5486d707a058480489583a85f25cf6948625",
        deparsedDefinition: "CREATE OR REPLACE FUNCTION app_private.hermes_task_input_rows_v1(p_plan jsonb)\n RETURNS jsonb\n LANGUAGE sql\n SET search_path TO 'pg_catalog', 'public'\nBEGIN ATOMIC\n WITH args AS (\n          SELECT (p_plan -> 'input'::text) AS input,\n             ((p_plan ->> 'organizationId'::text))::uuid AS org,\n             ARRAY( SELECT (jsonb_array_elements_text((p_plan -> 'buildingIds'::text)))::uuid AS jsonb_array_elements_text) AS buildings\n         ), candidates AS (\n          SELECT b.id,\n             b.name AS label\n            FROM public.buildings b,\n             args x\n           WHERE (((x.input ->> 'kind'::text) = 'buildings'::text) AND (b.id = ANY (x.buildings)) AND (b.organization_id = x.org) AND (b.deleted_at IS NULL))\n         UNION ALL\n          SELECT r.id,\n             r.name\n            FROM public.rooms r,\n             args x\n           WHERE (((x.input ->> 'kind'::text) = 'rooms'::text) AND (r.building_id = ((x.input ->> 'buildingId'::text))::uuid) AND (r.organization_id = x.org) AND (r.deleted_at IS NULL) AND (EXISTS ( SELECT 1\n                    FROM public.buildings b\n                   WHERE ((b.id = r.building_id) AND (b.organization_id = x.org) AND (b.deleted_at IS NULL) AND (b.id = ANY (x.buildings))))))\n         UNION ALL\n          SELECT j.id,\n             j.name\n            FROM public.job_types j,\n             args x\n           WHERE (((x.input ->> 'kind'::text) = 'jobTypes'::text) AND (j.organization_id = x.org) AND (EXISTS ( SELECT 1\n                    FROM public.buildings b\n                   WHERE ((((x.input ->> 'buildingId'::text) IS NULL) OR (b.id = ((x.input ->> 'buildingId'::text))::uuid)) AND (b.organization_id = x.org) AND (b.deleted_at IS NULL) AND (b.id = ANY (x.buildings))))))\n         UNION ALL\n          SELECT p.id,\n             p.full_name\n            FROM public.profiles p,\n             args x\n           WHERE (((x.input ->> 'kind'::text) = 'assignees'::text) AND app_private.hermes_task_assignee_member_v1(p.id, x.org) AND (EXISTS ( SELECT 1\n                    FROM public.buildings b\n                   WHERE ((((x.input ->> 'buildingId'::text) IS NULL) OR (b.id = ((x.input ->> 'buildingId'::text))::uuid)) AND (b.organization_id = x.org) AND (b.deleted_at IS NULL) AND (b.id = ANY (x.buildings))))))\n         ), selected AS MATERIALIZED (\n          SELECT candidates.id,\n             COALESCE(candidates.label, '(Chưa đặt tên)'::text) AS label\n            FROM candidates,\n             args x\n           WHERE ((((x.input ->> 'cursor'::text) IS NULL) OR (candidates.id > ((x.input ->> 'cursor'::text))::uuid)) AND (strpos(lower(COALESCE(candidates.label, '(Chưa đặt tên)'::text)), lower((x.input ->> 'query'::text))) > 0))\n           ORDER BY candidates.id\n          LIMIT (((hermes_task_input_rows_v1.p_plan #>> '{input,limit}'::text[]))::integer + 1)\n         ), visible AS (\n          SELECT selected.id,\n             selected.label\n            FROM selected\n           ORDER BY selected.id\n          LIMIT ((hermes_task_input_rows_v1.p_plan #>> '{input,limit}'::text[]))::integer\n         )\n  SELECT jsonb_build_object('organizationId', (p_plan -> 'organizationId'::text), 'kind', (p_plan #> '{input,kind}'::text[]), 'buildingId', (p_plan #> '{input,buildingId}'::text[]), 'items', COALESCE(( SELECT jsonb_agg(jsonb_build_object('id', visible.id, 'label', visible.label) ORDER BY visible.id) AS jsonb_agg\n            FROM visible), '[]'::jsonb), 'nextCursor',\n         CASE\n             WHEN (( SELECT count(*) AS count\n                FROM selected) > ((p_plan #>> '{input,limit}'::text[]))::integer) THEN ( SELECT max((visible.id)::text) AS max\n                FROM visible)\n             ELSE NULL::text\n         END) AS jsonb_build_object;\nEND\n",
        deparsedSha256: "b93a32d15897ae860c513f5739ba6580e798827dd80302febf62e31c091b527a",
      }),
    }),
  },
  {
    "signature": "public.hermes_task_input_options_v1(jsonb,jsonb)",
    "name": "public.hermes_task_input_options_v1",
    "language": "sql",
    "definer": false,
    "searchPath": "pg_catalog,public",
    "authenticated": true,
    "standard": true,
    "header": "CREATE OR REPLACE FUNCTION public.hermes_task_input_options_v1(p_binding jsonb,p_input jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public",
    "statement": "CREATE OR REPLACE FUNCTION public.hermes_task_input_options_v1(p_binding jsonb,p_input jsonb)\nRETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public\nBEGIN ATOMIC\n SELECT app_private.hermes_task_input_rows_v1(app_private.hermes_task_input_guard_v1(p_binding,p_input));\nEND",
    "statementSha256": "2c0559ae737e5134c5fcd3ce1b08e22a5c1ee73735518d326a5c168bd1f6e563",
    "deparsedDefinition": "CREATE OR REPLACE FUNCTION public.hermes_task_input_options_v1(p_binding jsonb, p_input jsonb)\n RETURNS jsonb\n LANGUAGE sql\n SET search_path TO 'pg_catalog', 'public'\nBEGIN ATOMIC\n SELECT app_private.hermes_task_input_rows_v1(app_private.hermes_task_input_guard_v1(p_binding, p_input)) AS hermes_task_input_rows_v1;\nEND\n",
    "deparsedSha256": "c1dd2254c039ca1f5df10904f10792c16d8885f07dc6aee3cd58c7ba7c7710cf",
    "dependencies": [
      {
        "type": "function",
        "identity": "app_private.hermes_task_input_guard_v1(pg_catalog.jsonb,pg_catalog.jsonb)",
        "deptype": "n"
      },
      {
        "type": "function",
        "identity": "app_private.hermes_task_input_rows_v1(pg_catalog.jsonb)",
        "deptype": "n"
      },
      {
        "type": "schema",
        "identity": "public",
        "deptype": "n"
      }
    ]
  }
]);

// The customer/lead action is a separate reviewed surface. Keep its catalog
// explicit so the live preflight cannot infer SECURITY DEFINER from a generic
// fallback (the canonical INSERT helper is deliberately SECURITY INVOKER).
export const CUSTOMER_FUNCTIONS = Object.freeze([
  {
    signature: 'app_private.hermes_customer_guard_v1(jsonb,text,text,jsonb,boolean)', name: 'app_private.hermes_customer_guard_v1',
    language: 'plpgsql', definer: true, searchPath: 'pg_catalog,public,app_private', authenticated: true, standard: false,
    header: 'CREATE OR REPLACE FUNCTION app_private.hermes_customer_guard_v1(p_binding jsonb,p_kind text,p_operation text,p_input jsonb,p_finish boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private',
    bodyDigest: 'ef3adc3aa8e157f0ccf4d6d00ef337bb450bd0ae38cd786dca29497a5a59fe35',
  },
  {
    signature: 'app_private.hermes_customer_insert_v1(jsonb)', name: 'app_private.hermes_customer_insert_v1',
    language: 'plpgsql', definer: false, searchPath: 'pg_catalog,public', authenticated: true, standard: false,
    header: 'CREATE OR REPLACE FUNCTION app_private.hermes_customer_insert_v1(p_plan jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public',
    bodyDigest: 'a847cfd3a9276c02372aa0e0eba06db97754c5d84aa859f74679e58048249e29',
  },
  {
    signature: 'app_private.hermes_customer_finish_v1(jsonb,text,text,jsonb)', name: 'app_private.hermes_customer_finish_v1',
    language: 'plpgsql', definer: true, searchPath: 'pg_catalog,public,app_private', authenticated: true, standard: false,
    header: 'CREATE OR REPLACE FUNCTION app_private.hermes_customer_finish_v1(p_binding jsonb,p_kind text,p_operation text,p_plan jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private',
    bodyDigest: 'bfd9769b4784af9e517ec474eb05ff5f5266964195d4bec236810a859b4d6640',
  },
  {
    signature: 'public.hermes_customer_create_action_v1(jsonb,text,text,jsonb)', name: 'public.hermes_customer_create_action_v1',
    language: 'sql', definer: false, searchPath: 'pg_catalog,public', authenticated: true, standard: true,
    header: 'CREATE OR REPLACE FUNCTION public.hermes_customer_create_action_v1(p_binding jsonb,p_kind text,p_operation text,p_input jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public',
    deparsedDefinition: "CREATE OR REPLACE FUNCTION public.hermes_customer_create_action_v1(p_binding jsonb, p_kind text, p_operation text, p_input jsonb)\n RETURNS jsonb\n LANGUAGE sql\n SET search_path TO 'pg_catalog', 'public'\nBEGIN ATOMIC\n SELECT app_private.hermes_customer_finish_v1(p_binding, p_kind, p_operation, app_private.hermes_customer_insert_v1(app_private.hermes_customer_guard_v1(p_binding, p_kind, p_operation, p_input, false))) AS hermes_customer_finish_v1;\nEND\n",
    deparsedSha256: 'e9c3bf3df9aac4c9fe0254eceb0aedb681f346a2b94f29118623587f4a4251b2',
    dependencies: [
      { type: 'function', identity: 'app_private.hermes_customer_finish_v1(pg_catalog.jsonb,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb)', deptype: 'n' },
      { type: 'function', identity: 'app_private.hermes_customer_guard_v1(pg_catalog.jsonb,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb,boolean)', deptype: 'n' },
      { type: 'function', identity: 'app_private.hermes_customer_insert_v1(pg_catalog.jsonb)', deptype: 'n' },
      { type: 'schema', identity: 'public', deptype: 'n' },
    ],
  },
  {
    signature: 'public.hermes_customer_create_capabilities_v1(uuid)', name: 'public.hermes_customer_create_capabilities_v1',
    language: 'plpgsql', definer: true, searchPath: 'pg_catalog,public,app_private', authenticated: true, standard: false,
    header: 'CREATE OR REPLACE FUNCTION public.hermes_customer_create_capabilities_v1(p_organization_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private',
    bodyDigest: 'a9229c475115460477ff596d87fb67feee857c812a67661f3d12f50b991d3829',
    successors: Object.freeze({
      'supabase/migrations/20261019034254_hermes_metadata_read_snapshot_v1.sql': Object.freeze({
        bodyDigest: 'fb237008487973741f2974effbb4b2e668afdf7e9208ece91004b31cf5349e30', volatility: 's',
      }),
    }),
  },
]);
