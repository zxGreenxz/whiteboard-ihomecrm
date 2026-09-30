-- Explicit building filters must belong to the same active organization.
CREATE OR REPLACE FUNCTION app_private.rent_support_scope_v1(p_org uuid,p_building uuid,p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT auth.uid() IS NOT NULL AND COALESCE(p_org=ANY(public.my_org_ids()),false)
 AND EXISTS(SELECT 1 FROM public.buildings b JOIN public.organizations o ON o.id=b.organization_id
   WHERE b.id=p_building AND b.organization_id=p_org AND b.deleted_at IS NULL AND b.status='ACTIVE' AND o.status='ACTIVE')
 AND COALESCE(public.can_access_building(p_building),false)
 AND NOT COALESCE(public.is_super_admin() AND p_org=ANY(public.sandbox_org_ids()),false)
 AND EXISTS(SELECT 1 FROM app_private.authorized_scope_v3(p_permission,p_org) s WHERE s.org_wide OR p_building=ANY(s.building_ids));
$$;
ALTER FUNCTION app_private.rent_support_scope_v1(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.rent_support_scope_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
-- Private versioned funding input. Public draft/history/signing rows hold only customer terms.
CREATE UNIQUE INDEX IF NOT EXISTS contract_draft_versions_org_revision_key ON public.contract_draft_versions(organization_id,draft_id,revision);
CREATE TABLE IF NOT EXISTS app_private.contract_draft_rent_support_funding (
 organization_id uuid NOT NULL,draft_id uuid NOT NULL,revision integer NOT NULL,
 funding jsonb NOT NULL CHECK(jsonb_typeof(funding)='object'),
 PRIMARY KEY(organization_id,draft_id,revision),
 FOREIGN KEY(organization_id,draft_id,revision) REFERENCES public.contract_draft_versions(organization_id,draft_id,revision)
);
ALTER TABLE app_private.contract_draft_rent_support_funding OWNER TO postgres;
ALTER TABLE app_private.contract_draft_rent_support_funding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.contract_draft_rent_support_funding FROM PUBLIC,anon,authenticated,service_role;
DROP POLICY IF EXISTS contract_draft_rent_support_funding_hide_sandbox_admin ON app_private.contract_draft_rent_support_funding;
CREATE POLICY contract_draft_rent_support_funding_hide_sandbox_admin ON app_private.contract_draft_rent_support_funding AS RESTRICTIVE FOR ALL TO authenticated
 USING(NOT(public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));
DROP TRIGGER IF EXISTS immutable_snapshot ON app_private.contract_draft_rent_support_funding;
CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON app_private.contract_draft_rent_support_funding FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_immutable_v1();
DROP TRIGGER IF EXISTS immutable_truncate ON app_private.contract_draft_rent_support_funding;
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON app_private.contract_draft_rent_support_funding FOR EACH STATEMENT EXECUTE FUNCTION app_private.rent_support_immutable_v1();
CREATE OR REPLACE FUNCTION app_private.rent_support_draft_funding_fields_v1(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('payer',p->'payer','sale_party_id',p->'sale_party_id','deduction_policy',p->'deduction_policy','collection_mode',p->'collection_mode');
$$;
CREATE OR REPLACE FUNCTION app_private.rent_support_draft_payload_v1(p_org uuid,p_draft uuid,p_revision integer,p_payload jsonb,p_require_finance boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid; f jsonb; BEGIN
 SELECT building_id INTO b FROM public.contract_drafts WHERE organization_id=p_org AND id=p_draft;
 -- Preserve the established public draft read scope across building lifecycle states.
 IF b IS NULL OR NOT COALESCE(app_private.contract_draft_scope_allowed(p_org,b,'contracts.view'),false) THEN RAISE EXCEPTION 'Draft scope denied' USING ERRCODE='42501';END IF;
 IF NOT(p_payload ? 'rent_support') THEN RETURN p_payload;END IF;
 IF NOT app_private.rent_support_scope_v1(p_org,b,'income_expenses.view') THEN
   IF p_require_finance THEN RAISE EXCEPTION 'Financial view permission required for support configuration' USING ERRCODE='42501';END IF;
   RETURN app_private.rent_support_draft_customer_v1(p_payload);
 END IF;
 SELECT funding INTO f FROM app_private.contract_draft_rent_support_funding WHERE organization_id=p_org AND draft_id=p_draft AND revision=p_revision;
 IF f IS NULL THEN RAISE EXCEPTION 'Support funding snapshot missing; reload or reconcile draft' USING ERRCODE='55000';END IF;
 RETURN jsonb_set(app_private.rent_support_draft_customer_v1(p_payload),'{rent_support}',app_private.rent_support_customer_v1(p_payload->'rent_support')||f);
END $$;
-- Repair only this unmerged feature's existing full v2 snapshots; no legacy discount conversion.
INSERT INTO app_private.contract_draft_rent_support_funding(organization_id,draft_id,revision,funding)
 SELECT organization_id,draft_id,revision,app_private.rent_support_draft_funding_fields_v1(payload->'rent_support')
 FROM public.contract_draft_versions WHERE payload->'rent_support' ? 'payer'
 ON CONFLICT(organization_id,draft_id,revision) DO NOTHING;
UPDATE public.contract_drafts SET payload=app_private.rent_support_draft_customer_v1(payload) WHERE payload->'rent_support' ? 'payer';
UPDATE public.contract_draft_versions SET payload=app_private.rent_support_draft_customer_v1(payload) WHERE payload->'rent_support' ? 'payer';
UPDATE public.contract_draft_documents SET document_data=app_private.rent_support_draft_customer_v1(document_data) WHERE document_data->'rent_support' ? 'payer';
UPDATE public.contract_draft_signings SET terms=app_private.rent_support_draft_customer_v1(terms),document_data=app_private.rent_support_draft_customer_v1(document_data)
 WHERE terms->'rent_support' ? 'payer' OR document_data->'rent_support' ? 'payer';
CREATE OR REPLACE FUNCTION app_private.rent_support_draft_revision_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 NEW.payload:=app_private.rent_support_draft_customer_v1(NEW.payload);
 IF TG_OP='INSERT' THEN NEW.customer_revision:=NEW.revision;
 ELSIF app_private.rent_support_draft_customer_v1(OLD.payload) IS DISTINCT FROM NEW.payload OR OLD.template_id IS DISTINCT FROM NEW.template_id THEN NEW.customer_revision:=NEW.revision;
 ELSE NEW.customer_revision:=COALESCE(OLD.customer_revision,OLD.revision);END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_draft_public_snapshot_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='contract_draft_versions' THEN NEW.payload:=app_private.rent_support_draft_customer_v1(NEW.payload);
 ELSIF TG_TABLE_NAME='contract_draft_documents' THEN NEW.document_data:=app_private.rent_support_draft_customer_v1(NEW.document_data);
 ELSE NEW.terms:=app_private.rent_support_draft_customer_v1(NEW.terms);NEW.document_data:=app_private.rent_support_draft_customer_v1(NEW.document_data);END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rent_support_public_snapshot ON public.contract_draft_versions;
CREATE TRIGGER rent_support_public_snapshot BEFORE INSERT OR UPDATE ON public.contract_draft_versions FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_draft_public_snapshot_v1();
DROP TRIGGER IF EXISTS rent_support_public_snapshot ON public.contract_draft_documents;
CREATE TRIGGER rent_support_public_snapshot BEFORE INSERT OR UPDATE ON public.contract_draft_documents FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_draft_public_snapshot_v1();
DROP TRIGGER IF EXISTS rent_support_public_snapshot ON public.contract_draft_signings;
CREATE TRIGGER rent_support_public_snapshot BEFORE INSERT OR UPDATE ON public.contract_draft_signings FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_draft_public_snapshot_v1();
DO $$ DECLARE f text; anchor text; replacement text; BEGIN
 f:=pg_get_functiondef('public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid)'::regprocedure);
 IF position('RENT_SUPPORT_PRIVATE_DRAFT_V1' IN f)=0 THEN
 anchor:='  SELECT * INTO v_replay FROM public.contract_draft_versions WHERE request_id = p_request_id;';
 replacement:=$patch$  -- RENT_SUPPORT_PRIVATE_DRAFT_V1
  IF p_payload ? 'rent_support' OR EXISTS(SELECT 1 FROM public.contract_drafts d WHERE d.organization_id=p_organization_id AND d.id=p_draft_id AND d.payload ? 'rent_support') THEN
    IF NOT app_private.rent_support_scope_v1(p_organization_id,p_building_id,'income_expenses.view')
      OR NOT app_private.rent_support_scope_v1(p_organization_id,p_building_id,'income_expenses.create') THEN
      RAISE EXCEPTION 'Financial permissions required to edit a support draft' USING ERRCODE='42501';
    END IF;
    IF NOT(p_payload ? 'rent_support') THEN RAISE EXCEPTION 'Cannot silently remove support funding; reconcile explicitly' USING ERRCODE='22023';END IF;
  END IF;
  SELECT * INTO v_replay FROM public.contract_draft_versions WHERE request_id = p_request_id;$patch$;
 IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing save replay anchor';END IF;f:=replace(f,anchor,replacement);
 anchor:='v_replay.payload IS DISTINCT FROM p_payload';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing replay equality anchor';END IF;
 f:=replace(f,anchor,'app_private.rent_support_draft_payload_v1(p_organization_id,v_replay.draft_id,v_replay.revision,v_replay.payload,true) IS DISTINCT FROM p_payload');
 anchor:='''payload'',v_replay.payload';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing replay result anchor';END IF;
 f:=replace(f,anchor,'''payload'',app_private.rent_support_draft_payload_v1(p_organization_id,v_replay.draft_id,v_replay.revision,v_replay.payload,true)');
 anchor:='  RETURN to_jsonb(v_draft) || jsonb_build_object(''documents'',';
 IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing save result anchor';END IF;
 f:=replace(f,anchor,$patch$  IF p_payload ? 'rent_support' THEN
    INSERT INTO app_private.contract_draft_rent_support_funding(organization_id,draft_id,revision,funding)
    VALUES(p_organization_id,v_draft.id,v_draft.revision,app_private.rent_support_draft_funding_fields_v1(p_payload->'rent_support'));
  END IF;
  RETURN to_jsonb(v_draft) || jsonb_build_object('payload',app_private.rent_support_draft_payload_v1(p_organization_id,v_draft.id,v_draft.revision,v_draft.payload,true),'documents',$patch$);
 EXECUTE f;
 END IF;
 f:=pg_get_functiondef('public.list_contract_drafts(uuid,uuid)'::regprocedure);
 IF position('rent_support_draft_payload_v1' IN f)=0 THEN
 anchor:='to_jsonb(d) || jsonb_build_object(''documents'',';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing list draft projection anchor';END IF;
 f:=replace(f,anchor,'to_jsonb(d) || jsonb_build_object(''payload'',app_private.rent_support_draft_payload_v1(d.organization_id,d.id,d.revision,d.payload),''documents'',');EXECUTE f;
 END IF;
 f:=pg_get_functiondef('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])'::regprocedure);
 IF position('RENT_SUPPORT_PRIVATE_SIGN_V1' IN f)=0 THEN
 anchor:='PERFORM app_private.validate_rent_support_v1(v_terms->''rent_support'',(f->>''start_date'')::date,(f->>''end_date'')::date);';
 IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing support signing validation anchor';END IF;
 f:=replace(f,anchor,$patch$-- RENT_SUPPORT_PRIVATE_SIGN_V1: hydrate only the canonical write input, not the public signing snapshot.
    PERFORM app_private.validate_rent_support_v1(app_private.rent_support_draft_payload_v1(p_organization_id,d.id,d.revision,v_terms,true)->'rent_support',(f->>'start_date')::date,(f->>'end_date')::date);$patch$);
 anchor:='jsonb_build_object(''rent_support'',v_terms->''rent_support'',''discounts''';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing support create payload anchor';END IF;
 f:=replace(f,anchor,'jsonb_build_object(''rent_support'',app_private.rent_support_draft_payload_v1(p_organization_id,d.id,d.revision,v_terms,true)->''rent_support'',''discounts''');EXECUTE f;
 END IF;
END $$;
DO $$ DECLARE sig regprocedure; BEGIN
 FOREACH sig IN ARRAY ARRAY['app_private.rent_support_draft_funding_fields_v1(jsonb)'::regprocedure,'app_private.rent_support_draft_payload_v1(uuid,uuid,integer,jsonb,boolean)'::regprocedure,'app_private.rent_support_draft_revision_v1()'::regprocedure,'app_private.rent_support_draft_public_snapshot_v1()'::regprocedure] LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',sig);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',sig);
 END LOOP;
END $$;
