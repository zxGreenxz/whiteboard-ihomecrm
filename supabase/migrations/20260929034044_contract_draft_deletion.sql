-- Delete only unsigned drafts. Retain versions/files as an audit trail, deny reuse.
ALTER TABLE public.contract_drafts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.contract_drafts ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE public.contract_drafts DROP CONSTRAINT IF EXISTS contract_drafts_signing_state_check;
ALTER TABLE public.contract_drafts ADD CONSTRAINT contract_drafts_signing_state_check CHECK (
  (status='EDITABLE' AND converted_contract_id IS NULL AND deleted_at IS NULL AND deleted_by IS NULL)
  OR (status='SIGNED' AND converted_contract_id IS NOT NULL AND deleted_at IS NULL AND deleted_by IS NULL)
  OR (status='DELETED' AND converted_contract_id IS NULL AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
);

-- Narrow, checked changes to the existing boundaries. No new trigger chain.
DO $patch$
DECLARE p record; definition text;
BEGIN
  FOR p IN SELECT * FROM (VALUES
    ('app_private.contract_draft_scope_allowed(uuid,uuid,text)',
     $old$p_action IN ('contracts.view', 'contracts.create', 'contracts.edit', 'contracts.print')$old$,
     $new$p_action IN ('contracts.view', 'contracts.create', 'contracts.edit', 'contracts.print', 'contracts.delete')$new$),
    ('app_private.guard_signed_contract_draft_v1()',
     $old$IF OLD.status='SIGNED' THEN RAISE EXCEPTION 'Bản nháp đã ký không thể sửa hoặc xoá' USING ERRCODE='55000'; END IF;$old$,
     $new$IF OLD.status IN ('SIGNED','DELETED') THEN RAISE EXCEPTION 'Bản nháp đã ký hoặc đã xoá không thể thay đổi' USING ERRCODE='55000'; END IF;$new$),
    ('public.list_contract_drafts(uuid,uuid)',
     $old$FROM public.contract_drafts d WHERE d.organization_id = p_organization_id$old$,
     $new$FROM public.contract_drafts d WHERE d.organization_id = p_organization_id AND d.status <> 'DELETED'$new$),
    ('public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid)',
     $old$SELECT * INTO v_draft FROM public.contract_drafts WHERE id = v_replay.draft_id;$old$,
     $new$SELECT * INTO v_draft FROM public.contract_drafts WHERE id = v_replay.draft_id;
    IF v_draft.status='DELETED' THEN RAISE EXCEPTION 'Bản nháp đã được xoá' USING ERRCODE='55000'; END IF;$new$),
    ('public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb)',
     $old$SELECT * INTO v_draft FROM public.contract_drafts WHERE id = p_draft_id AND organization_id = p_organization_id FOR UPDATE;$old$,
     $new$SELECT * INTO v_draft FROM public.contract_drafts WHERE id = p_draft_id AND organization_id = p_organization_id AND status <> 'DELETED' FOR UPDATE;$new$),
    ('app_private.contract_draft_storage_allowed(text,boolean)',
     $old$SELECT * INTO v_draft FROM public.contract_drafts WHERE id = v_parts[3]::uuid AND organization_id = v_parts[1]::uuid AND building_id = v_parts[2]::uuid;$old$,
     $new$SELECT * INTO v_draft FROM public.contract_drafts WHERE id = v_parts[3]::uuid AND organization_id = v_parts[1]::uuid AND building_id = v_parts[2]::uuid AND status <> 'DELETED';$new$)
  ) AS changes(signature,old_text,new_text) LOOP
    definition := pg_get_functiondef(p.signature::regprocedure);
    IF position(p.new_text IN definition)>0 THEN CONTINUE; END IF;
    IF position(p.old_text IN definition)=0 THEN RAISE EXCEPTION 'Draft delete migration: unexpected definition %',p.signature; END IF;
    EXECUTE replace(definition,p.old_text,p.new_text);
  END LOOP;
END $patch$;

CREATE OR REPLACE FUNCTION public.delete_contract_draft_v1(
  p_organization_id uuid,p_draft_id uuid,p_expected_revision integer
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.contract_drafts%ROWTYPE; allowed boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Cần đăng nhập' USING ERRCODE='28000'; END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<1 THEN RAISE EXCEPTION 'Thiếu phiên bản nháp' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO d FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(p_organization_id,d.building_id,'contracts.delete') THEN
    RAISE EXCEPTION 'Không có quyền xoá bản nháp' USING ERRCODE='42501';
  END IF;
  SELECT a.allowed INTO allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.delete',d.building_id,NULL) a;
  IF NOT COALESCE(allowed,false) THEN RAISE EXCEPTION 'Không có quyền xoá bản nháp' USING ERRCODE='42501'; END IF;
  IF d.revision<>p_expected_revision THEN RAISE EXCEPTION 'Bản nháp đã thay đổi; tải lại trước khi xoá' USING ERRCODE='40001'; END IF;
  IF d.status='DELETED' THEN RETURN jsonb_build_object('draft_id',d.id,'deleted',true); END IF;
  IF d.status<>'EDITABLE' OR d.converted_contract_id IS NOT NULL THEN
    RAISE EXCEPTION 'Bản nháp đã ký không thể xoá' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.contract_transfer_links WHERE new_draft_id=d.id AND state='LINKED') THEN
    RAISE EXCEPTION 'Hủy liên kết nhượng trước khi xoá bản nháp' USING ERRCODE='55000';
  END IF;
  UPDATE public.contract_drafts SET status='DELETED',deleted_at=clock_timestamp(),deleted_by=auth.uid(),updated_at=clock_timestamp() WHERE id=d.id;
  RETURN jsonb_build_object('draft_id',d.id,'deleted',true);
END $$;
REVOKE ALL ON FUNCTION public.delete_contract_draft_v1(uuid,uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.delete_contract_draft_v1(uuid,uuid,integer) TO authenticated;
COMMENT ON FUNCTION public.delete_contract_draft_v1(uuid,uuid,integer) IS 'Soft-delete an unsigned draft using existing contracts.delete building scope and expected revision; retain audit history.';
NOTIFY pgrst,'reload schema';
