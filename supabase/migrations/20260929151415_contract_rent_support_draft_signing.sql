ALTER TABLE public.contract_drafts ADD COLUMN IF NOT EXISTS customer_revision integer CHECK(customer_revision>0);
CREATE OR REPLACE FUNCTION app_private.rent_support_draft_customer_v1(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT (p-'rent_support') || CASE WHEN p ? 'rent_support' THEN jsonb_build_object('rent_support',app_private.rent_support_customer_v1(p->'rent_support')) ELSE '{}'::jsonb END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_draft_revision_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='INSERT' THEN NEW.customer_revision:=NEW.revision;
 ELSIF app_private.rent_support_draft_customer_v1(OLD.payload) IS DISTINCT FROM app_private.rent_support_draft_customer_v1(NEW.payload) OR OLD.template_id IS DISTINCT FROM NEW.template_id THEN NEW.customer_revision:=NEW.revision;
 ELSE NEW.customer_revision:=COALESCE(OLD.customer_revision,OLD.revision);END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rent_support_draft_revision ON public.contract_drafts;
CREATE TRIGGER rent_support_draft_revision BEFORE INSERT OR UPDATE ON public.contract_drafts FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_draft_revision_v1();
-- Patch the effective installed functions, preserving all subsequent canonical engine patches.
-- Exact anchors are mandatory; an unknown baseline aborts installation.
DO $$ DECLARE f text; anchor text; replacement text; BEGIN
 f:=pg_get_functiondef('public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid)'::regprocedure);
 IF position('RENT_SUPPORT_DRAFT_V2' IN f)=0 THEN
 anchor:='''owner'',''editor_state''';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing draft allowlist anchor';END IF;
 f:=replace(f,anchor,'''owner'',''editor_state'',''rent_support''');
 anchor:='  IF p_expected_revision IS NULL THEN';
 replacement:=$patch$  -- RENT_SUPPORT_DRAFT_V2
  IF p_payload ? 'rent_support' THEN
    PERFORM app_private.validate_rent_support_v1(p_payload->'rent_support',NULLIF(p_payload->'form'->>'start_date','')::date,NULLIF(p_payload->'form'->>'end_date','')::date);
    IF NOT app_private.rent_support_scope_v1(p_organization_id,p_building_id,'income_expenses.create') THEN RAISE EXCEPTION 'Financial permission required for support configuration' USING ERRCODE='42501';END IF;
    IF COALESCE((p_payload->'form'->>'discount_months')::numeric,0)<>0 OR COALESCE((p_payload->'form'->>'discount_amount_per_month')::numeric,0)<>0 THEN RAISE EXCEPTION 'V2 schedule cannot also use legacy discount' USING ERRCODE='22023';END IF;
  END IF;
  IF p_expected_revision IS NULL THEN$patch$;
 IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing draft validation anchor';END IF;f:=replace(f,anchor,replacement);EXECUTE f;
 END IF;
 f:=pg_get_functiondef('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure);
 IF position('RENT_SUPPORT_SIGN_V2' IN f)=0 THEN
 anchor:='AND draft_id=d.id AND revision=d.revision';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing signing document anchor';END IF;
 f:=replace(f,anchor,'AND draft_id=d.id AND revision BETWEEN COALESCE(d.customer_revision,d.revision) AND d.revision');
 anchor:='  v_payload:=jsonb_build_object';
 IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing signing payload anchor';END IF;
 f:=replace(f,anchor,$patch$  -- RENT_SUPPORT_SIGN_V2
  IF v_terms ? 'rent_support' THEN
    PERFORM app_private.validate_rent_support_v1(v_terms->'rent_support',(f->>'start_date')::date,(f->>'end_date')::date);
    IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'RENT_SUPPORT_WRITERS_DISABLED' USING ERRCODE='55000';END IF;
  END IF;
  v_payload:=jsonb_build_object$patch$);
 anchor:='||(p_creation_options-''first_invoice''-''deposit_receipts''-''existing_deposit_voucher_ids'')';
 IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing signing options anchor';END IF;
 f:=replace(f,anchor,$patch$|| CASE WHEN v_terms ? 'rent_support' THEN jsonb_build_object('rent_support',v_terms->'rent_support','discounts',jsonb_build_object('version',2,'kind','RENT_SUPPORT_SCHEDULE')) ELSE '{}'::jsonb END
    ||(p_creation_options-'first_invoice'-'deposit_receipts'-'existing_deposit_voucher_ids')$patch$);EXECUTE f;
 END IF;
 f:=pg_get_functiondef('public.create_contract_v2(jsonb,text)'::regprocedure);
 IF position('RENT_SUPPORT_CREATE_V2' IN f)=0 THEN
 anchor:='BEGIN';
 f:=overlay(f placing $patch$BEGIN
  -- RENT_SUPPORT_CREATE_V2
  IF v_contract_json ? 'rent_support' THEN
    PERFORM app_private.validate_rent_support_v1(v_contract_json->'rent_support');
    IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'RENT_SUPPORT_WRITERS_DISABLED' USING ERRCODE='55000';END IF;
    IF v_contract_json ? 'discounts' AND v_contract_json->'discounts' NOT IN ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'{"version":2,"kind":"RENT_SUPPORT_SCHEDULE"}'::jsonb)
      AND (COALESCE((v_contract_json->'discounts'->>'months')::numeric,0)<>0 OR COALESCE((v_contract_json->'discounts'->>'amount_per_month')::numeric,0)<>0) THEN RAISE EXCEPTION 'V2 schedule cannot also use legacy discount' USING ERRCODE='22023';END IF;
    v_contract_json:=jsonb_set(v_contract_json,'{discounts}','{"version":2,"kind":"RENT_SUPPORT_SCHEDULE"}');
  ELSIF v_contract_json->'discounts'->>'version'='2' THEN
    RAISE EXCEPTION 'Support marker requires schedule' USING ERRCODE='22023';
  END IF;$patch$ from position(anchor IN f) for length(anchor));
 anchor:=') RETURNING id INTO v_contract_id;';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing canonical contract persistence anchor';END IF;
 f:=replace(f,anchor,$patch$) RETURNING id INTO v_contract_id;
  IF v_contract_json ? 'rent_support' THEN
    IF NOT app_private.rent_support_scope_v1(v_org,v_building_id,'income_expenses.create') THEN RAISE EXCEPTION 'Financial permission required for support' USING ERRCODE='42501';END IF;
    PERFORM app_private.persist_contract_rent_support_v1(v_org,v_contract_id,v_contract_json->'rent_support');
  END IF;$patch$);EXECUTE f;
 END IF;
END $$;
ALTER FUNCTION app_private.rent_support_draft_customer_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.rent_support_draft_revision_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.rent_support_draft_customer_v1(jsonb),app_private.rent_support_draft_revision_v1() FROM PUBLIC,anon,authenticated,service_role;
