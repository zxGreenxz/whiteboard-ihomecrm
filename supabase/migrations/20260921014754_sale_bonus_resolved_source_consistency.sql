-- T6 review round 3: validate all resolved Sale source endpoints before claims.
-- Follows 20260921012821; no data repair, source rewrite, ACL or lock changes.
BEGIN;
DO $preflight$
DECLARE r record;
BEGIN
 IF md5(pg_get_functiondef('app_private.lock_org_for_decision_v1(uuid)'::regprocedure))<>'6130719b1956a291878bed6c58800e5a' THEN RAISE EXCEPTION 'Sale consistency org lock definition drift'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('app_private.sale_bonus_source_claims_v1(uuid,uuid,uuid)','232e870a444b79dfbe32c2dfd42231b8','85c05498f001dec9b6eb581b711682a3'),
  ('app_private.guard_sale_bonus_source_claim_v1()','f804cf51e0aa37c7e7d03bd5d0760ffb','f804cf51e0aa37c7e7d03bd5d0760ffb')
 ) x(signature,old_hash,new_hash) LOOP
  IF to_regprocedure(r.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(r.signature))) NOT IN (r.old_hash,r.new_hash) THEN RAISE EXCEPTION 'Sale consistency definition drift: %',r.signature; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature) AND (p.proowner<>'postgres'::regrole OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>'postgres'::regrole OR a.is_grantable))) THEN RAISE EXCEPTION 'Sale consistency owner/ACL drift: %',r.signature; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
  ('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)','8e71112be4f8244298b347c47e15dd05'),
  ('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)','3ed571ba5d2262ec5a125a4804ef9f4a'),
  ('app_private.contract_settlement_create_facts_v1(uuid,text,uuid)','b97c2f4d3e9ff2fa3cefae1f32072c80')
 ) x(signature,expected_hash) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(r.signature) AND proowner='postgres'::regrole) OR md5(pg_get_functiondef(to_regprocedure(r.signature))) IS DISTINCT FROM r.expected_hash THEN RAISE EXCEPTION 'Sale consistency dependency drift: %',r.signature; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
  ('public.contract_deposit_links','guard_sale_bonus_link_claim','ab86554952e7a54a262dccb6c3a53e28'),
  ('app_private.sale_bonus_claims','guard_sale_bonus_deposit_claim','46eb88e01d693101f616818ffe3f2a2f'),
  ('public.income_expenses','guard_sale_bonus_voucher_claim','42753c904979bbe5a6d35a02b9c532c2')
 ) x(relation,trigger_name,expected_hash) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=r.relation::regclass AND t.tgname=r.trigger_name AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))=r.expected_hash) THEN RAISE EXCEPTION 'Sale consistency trigger drift: %',r.trigger_name; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND rolinherit) OR pg_has_role('authenticated','ie_action_snapshot_reader','SET') OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE') OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN RAISE EXCEPTION 'Sale claim source reader role drift'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)',ARRAY['postgres','authenticated','service_role']::text[]),
  ('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)',ARRAY['postgres','authenticated','service_role']::text[]),
  ('app_private.contract_settlement_create_facts_v1(uuid,text,uuid)',ARRAY['postgres','ie_action_snapshot_reader']::text[])
 ) x(signature,roles) LOOP
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=to_regprocedure(r.signature) AND (NOT a.grantee=ANY(ARRAY(SELECT role_name::regrole::oid FROM unnest(r.roles) role_name)) OR a.is_grantable)) OR EXISTS(SELECT 1 FROM unnest(r.roles) role_name WHERE NOT has_function_privilege(role_name,r.signature,'EXECUTE')) THEN RAISE EXCEPTION 'Sale claim dependency ACL drift: %',r.signature; END IF;
 END LOOP;
END $preflight$;

CREATE OR REPLACE FUNCTION app_private.sale_bonus_source_claims_v1(p_org uuid, p_contract uuid, p_deposit uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v_claims uuid[]; v_contracts uuid[]; v_deposits uuid[];
BEGIN
 -- Resolve only the same authorized source relation as the predecessor. A
 -- conflicting direct contract never expands this set or grants new authority.
 WITH selected_contracts AS (
  SELECT c.id FROM public.contracts c WHERE c.organization_id=p_org AND (
   c.id=p_contract OR c.id IN (
    SELECT d.contract_id FROM public.income_expenses d WHERE d.id=p_deposit AND d.organization_id=p_org AND d.type='INCOME'
    UNION
    SELECT l.contract_id FROM public.contract_deposit_links l JOIN public.income_expenses d ON d.id=l.income_expense_id AND d.organization_id=l.organization_id AND d.type='INCOME'
    WHERE l.organization_id=p_org AND d.id=p_deposit AND l.link_source IN ('EXPLICIT_V2','BACKFILL_REVIEWED')
   )
  )
 ), selected_deposits AS (
  SELECT d.id FROM public.income_expenses d WHERE d.organization_id=p_org AND d.type='INCOME' AND (
   d.id=p_deposit OR d.contract_id IN (SELECT id FROM selected_contracts) OR EXISTS (
    SELECT 1 FROM public.contract_deposit_links l WHERE l.organization_id=p_org AND l.income_expense_id=d.id
      AND l.contract_id IN (SELECT id FROM selected_contracts) AND l.link_source IN ('EXPLICIT_V2','BACKFILL_REVIEWED')
   )
  )
 )
 SELECT ARRAY(SELECT id FROM selected_contracts),ARRAY(SELECT id FROM selected_deposits)
 INTO v_contracts,v_deposits;
 -- Validate every endpoint in that resolved set, including sibling deposits.
 -- Checking only raw p_deposit misses D2 -> C1 -> D1.direct=C2.
 IF EXISTS (
  SELECT 1 FROM public.contract_deposit_links l
  LEFT JOIN public.income_expenses d ON d.id=l.income_expense_id
  LEFT JOIN public.contracts c ON c.id=l.contract_id
  WHERE (l.contract_id=p_contract OR d.contract_id=p_contract OR l.income_expense_id=p_deposit
    OR l.contract_id=ANY(v_contracts) OR d.contract_id=ANY(v_contracts) OR l.income_expense_id=ANY(v_deposits))
    AND (l.organization_id IS DISTINCT FROM p_org OR d.organization_id IS DISTINCT FROM p_org
      OR c.organization_id IS DISTINCT FROM p_org OR d.type IS DISTINCT FROM 'INCOME'
      OR (d.contract_id IS NOT NULL AND d.contract_id IS DISTINCT FROM l.contract_id))
 ) THEN
  RAISE EXCEPTION 'Nguồn cọc có liên kết hợp đồng mâu thuẫn. Cần đối chiếu nguồn trước khi lập phiếu.' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(array_agg(DISTINCT b.id ORDER BY b.id),'{}'::uuid[]) INTO v_claims FROM public.income_expenses b
 WHERE b.organization_id=p_org AND b.commission_kind='sale' AND b.type='EXPENSE' AND b.deleted_at IS NULL AND b.approval_status<>'CANCELLED'
 AND (b.contract_id=ANY(v_contracts) OR EXISTS (
  SELECT 1 FROM app_private.sale_bonus_claims claim WHERE claim.organization_id=p_org AND claim.bonus_voucher_id=b.id AND claim.deposit_voucher_id=ANY(v_deposits)
 ));
 RETURN v_claims;
END
$function$;
NOTIFY pgrst,'reload schema';
COMMIT;
