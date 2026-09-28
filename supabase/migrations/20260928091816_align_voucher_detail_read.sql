-- Read a voucher as one snapshot, using its existing parent RLS as authority.
-- No parent policies, picker grants, financial writes, or data backfills change.
-- Applied inside the forward lane transaction (no top-level transaction here).
DO $preflight$
DECLARE definition text; original text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.income_expense_items i JOIN public.income_expenses v ON v.id=i.income_expense_id
    WHERE i.organization_id IS NULL OR i.organization_id IS DISTINCT FROM v.organization_id) THEN
    RAISE EXCEPTION 'Voucher item organization mismatch; investigate before migration';
  END IF;
  -- Freeze the exact old read predicate for append BEFORE broadening reads.
  IF to_regprocedure('app_private.ie_supplement_can_append_scope_v1(uuid)') IS NULL THEN
    definition := pg_get_functiondef('app_private.ie_supplement_can_read_v1(uuid)'::regprocedure);
    IF md5(definition) <> '5c4fb57c9402738da0c580cc8de336a3' THEN
      RAISE EXCEPTION 'Supplement read definition drift';
    END IF;
    EXECUTE replace(definition,'FUNCTION app_private.ie_supplement_can_read_v1(', 'FUNCTION app_private.ie_supplement_can_append_scope_v1(');
  ELSE
    definition := pg_get_functiondef('app_private.ie_supplement_can_append_scope_v1(uuid)'::regprocedure);
    IF md5(replace(definition,'FUNCTION app_private.ie_supplement_can_append_scope_v1(', 'FUNCTION app_private.ie_supplement_can_read_v1(')) <> '5c4fb57c9402738da0c580cc8de336a3' THEN
      RAISE EXCEPTION 'Supplement append scope definition drift';
    END IF;
  END IF;
  definition := pg_get_functiondef('public.append_income_expense_supplement_v1(uuid,text,jsonb,text)'::regprocedure);
  original := replace(definition,'app_private.ie_supplement_can_append_scope_v1(p_voucher)', 'app_private.ie_supplement_can_read_v1(p_voucher)');
  -- TEST sync changes only the known storage URL; both reviewed definitions.
  IF md5(original) NOT IN ('1ee00680550483cf98171b1e8395a8b7','bcaa4023e2d7d0341039e606c0ac92d2') THEN
    RAISE EXCEPTION 'Supplement append definition drift';
  END IF;
  EXECUTE replace(definition,'app_private.ie_supplement_can_read_v1(p_voucher)', 'app_private.ie_supplement_can_append_scope_v1(p_voucher)');
END
$preflight$;
REVOKE ALL ON FUNCTION app_private.ie_supplement_can_append_scope_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ie_detail_reader') THEN
    CREATE ROLE ie_detail_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ie_detail_reader'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolinherit)) THEN
    RAISE EXCEPTION 'Voucher detail reader role attribute drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid='ie_detail_reader'::regrole AND member<>'postgres'::regrole)
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='ie_detail_reader'::regrole AND (roleid<>'authenticated'::regrole OR admin_option))
    OR has_schema_privilege('ie_detail_reader','public','CREATE')
    OR has_schema_privilege('ie_detail_reader','app_private','CREATE') THEN
    RAISE EXCEPTION 'Voucher detail reader membership/schema drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee='ie_detail_reader'::regrole)
    OR EXISTS (SELECT 1 FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE a.grantee='ie_detail_reader'::regrole)
    OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE a.grantee='ie_detail_reader'::regrole AND (a.is_grantable OR p.oid NOT IN (
        COALESCE(to_regprocedure('app_private.ie_supplement_can_read_v1(uuid)'),0),
        COALESCE(to_regprocedure('app_private.ie_detail_metadata_v1(uuid,uuid[])'),0),
        COALESCE(to_regprocedure('public.read_income_expense_details_v1(uuid,uuid[])'),0)))) THEN
    RAISE EXCEPTION 'Voucher detail reader privilege drift';
  END IF;
END
$role$;
GRANT authenticated TO ie_detail_reader;
GRANT ie_detail_reader TO postgres WITH INHERIT TRUE, SET TRUE;
GRANT USAGE ON SCHEMA public,auth,app_private TO ie_detail_reader;

-- Remain under every existing child restrictive policy and the exact parent RLS.
ALTER POLICY income_expense_items_select_rbac ON public.income_expense_items
  USING (EXISTS (SELECT 1 FROM public.income_expenses v
    WHERE v.id=income_expense_items.income_expense_id
      AND v.organization_id=income_expense_items.organization_id));

CREATE OR REPLACE FUNCTION app_private.ie_supplement_can_read_v1(p_voucher uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on AS $read$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.income_expenses v WHERE v.id=p_voucher);
$read$;
GRANT CREATE ON SCHEMA app_private TO ie_detail_reader;
ALTER FUNCTION app_private.ie_supplement_can_read_v1(uuid) OWNER TO ie_detail_reader;
REVOKE CREATE ON SCHEMA app_private FROM ie_detail_reader;
REVOKE ALL ON FUNCTION app_private.ie_supplement_can_read_v1(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION app_private.ie_supplement_can_read_v1(uuid) TO authenticated;

ALTER POLICY income_expense_supplements_select ON public.income_expense_supplements
  USING (EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.id=income_expense_supplements.income_expense_id
    AND v.organization_id=income_expense_supplements.organization_id));
ALTER POLICY income_expense_revisions_select ON public.income_expense_revisions
  USING (EXISTS (SELECT 1 FROM public.income_expenses v WHERE v.id=income_expense_revisions.income_expense_id
    AND v.organization_id=income_expense_revisions.organization_id));

-- Storage retains its existing bucket/org boundary and immutability predicates.
-- Add relation integrity because this existing function runs as its privileged owner.
DO $storage$
DECLARE definition text; original text;
BEGIN
  definition := pg_get_functiondef('app_private.ie_supplement_storage_can_read_v1(text,text)'::regprocedure);
  original := replace(definition,
    'app_private.ie_supplement_can_read_v1(s.income_expense_id) AND s.organization_id = (SELECT v.organization_id FROM public.income_expenses v WHERE v.id=s.income_expense_id)',
    'app_private.ie_supplement_can_read_v1(s.income_expense_id)');
  IF md5(original) <> '53f98441792028155efc0e01efabee96' THEN
    RAISE EXCEPTION 'Supplement storage definition drift';
  END IF;
  EXECUTE replace(original,'app_private.ie_supplement_can_read_v1(s.income_expense_id)',
    'app_private.ie_supplement_can_read_v1(s.income_expense_id) AND s.organization_id = (SELECT v.organization_id FROM public.income_expenses v WHERE v.id=s.income_expense_id)');
END
$storage$;

-- Only the non-bypass reader can invoke this bridge, after filtering IDs through
-- parent RLS. The bridge projects labels/counts only, never building/type records.
CREATE OR REPLACE FUNCTION app_private.ie_detail_metadata_v1(p_organization_id uuid,p_voucher_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $metadata$
  SELECT COALESCE(jsonb_object_agg(v.id,jsonb_build_object(
    'building_name',b.name,
    'building_missing',v.building_id IS NOT NULL AND b.id IS NULL,
    'expected_item_count',(SELECT count(*) FROM public.income_expense_items i WHERE i.income_expense_id=v.id),
    'scope_mismatch',EXISTS(SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id=v.id AND i.organization_id IS DISTINCT FROM v.organization_id),
    'types',COALESCE((SELECT jsonb_object_agg(i.id,jsonb_build_object('type_name',t.name,'category',t.category,'is_deposit',t.is_deposit))
      FROM public.income_expense_items i LEFT JOIN public.income_expense_types t ON t.id=i.income_expense_type_id AND t.organization_id=v.organization_id
      WHERE i.income_expense_id=v.id AND i.organization_id=v.organization_id),'{}'::jsonb)
  )),'{}'::jsonb)
  FROM public.income_expenses v LEFT JOIN public.buildings b ON b.id=v.building_id AND b.organization_id=v.organization_id
  WHERE v.id=ANY(p_voucher_ids) AND v.organization_id=p_organization_id;
$metadata$;
REVOKE ALL ON FUNCTION app_private.ie_detail_metadata_v1(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.ie_detail_metadata_v1(uuid,uuid[]) TO ie_detail_reader;

CREATE OR REPLACE FUNCTION public.read_income_expense_details_v1(p_organization_id uuid,p_voucher_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private SET row_security=on AS $details$
DECLARE visible_ids uuid[]; metadata jsonb; rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated organization required' USING ERRCODE='42501';
  END IF;
  IF p_voucher_ids IS NULL OR cardinality(p_voucher_ids)>200 OR array_position(p_voucher_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'At most 200 non-null voucher IDs required' USING ERRCODE='22023';
  END IF;
  -- STABLE keeps these SELECTs on the caller statement snapshot. No independent
  -- membership timestamp rule: the parent policies own all permission semantics.
  SELECT COALESCE(array_agg(v.id),'{}'::uuid[]) INTO visible_ids FROM public.income_expenses v
    WHERE v.id=ANY(p_voucher_ids) AND v.organization_id=p_organization_id;
  metadata := app_private.ie_detail_metadata_v1(p_organization_id,visible_ids);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'header',to_jsonb(v)||jsonb_build_object('total_amount',v.total_amount::text,'kqkd_amount',v.kqkd_amount::text),
    'items',items.rows,'building_name',meta.value->'building_name',
    'expected_item_count',(meta.value->>'expected_item_count')::integer,
    'items_complete',items.n=(meta.value->>'expected_item_count')::integer AND NOT (meta.value->>'scope_mismatch')::boolean,
    'issues',to_jsonb(array_remove(ARRAY[
      CASE WHEN items.n<>(meta.value->>'expected_item_count')::integer THEN 'ITEMS_INCOMPLETE' END,
      CASE WHEN (meta.value->>'scope_mismatch')::boolean THEN 'SCOPE_MISMATCH' END,
      CASE WHEN (meta.value->>'building_missing')::boolean OR items.missing_type THEN 'RELATED_DATA_UNAVAILABLE' END
    ],NULL))
  ) ORDER BY v.id),'[]'::jsonb) INTO rows
  FROM public.income_expenses v
  CROSS JOIN LATERAL (SELECT metadata->v.id::text AS value) meta
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS n,
      COALESCE(bool_or(meta.value->'types'->i.id::text->>'type_name' IS NULL),false) AS missing_type,
      COALESCE(jsonb_agg(to_jsonb(i)||jsonb_build_object('quantity',i.quantity::text,'unit_price',i.unit_price::text,'amount',i.amount::text)
        || COALESCE(meta.value->'types'->i.id::text,jsonb_build_object('type_name',NULL,'category',NULL,'is_deposit',NULL)) ORDER BY i.id),'[]'::jsonb) AS rows
    FROM public.income_expense_items i WHERE i.income_expense_id=v.id AND i.organization_id=v.organization_id
  ) items
  WHERE v.id=ANY(visible_ids) AND v.organization_id=p_organization_id;
  RETURN jsonb_build_object('rows',rows);
END
$details$;
GRANT CREATE ON SCHEMA public TO ie_detail_reader;
ALTER FUNCTION public.read_income_expense_details_v1(uuid,uuid[]) OWNER TO ie_detail_reader;
REVOKE CREATE ON SCHEMA public FROM ie_detail_reader;
REVOKE ALL ON FUNCTION public.read_income_expense_details_v1(uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_income_expense_details_v1(uuid,uuid[]) TO authenticated;
NOTIFY pgrst,'reload schema';
