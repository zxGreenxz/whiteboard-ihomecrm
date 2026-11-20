-- The schedule is shared by the company. An editor only adds/removes
-- conversation IDs belonging to the account whose directory they opened.
CREATE OR REPLACE FUNCTION public.zalo_save_account_recipients_v1(
  p_organization_id uuid, p_account_id uuid, p_add uuid[], p_remove uuid[],
  p_expected jsonb, p_changes jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  a public.zalo_automations;
  recipients jsonb;
  shared jsonb;
  field text;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR
     NOT COALESCE(public.zalo_can('manage_automation',p_organization_id),false) THEN
    RAISE EXCEPTION 'Không có quyền quản lý tự động hoá' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT FROM public.zalo_accounts WHERE id=p_account_id AND organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'Tài khoản Zalo không thuộc công ty' USING ERRCODE='42501';
  END IF;
  IF p_add IS NULL OR p_remove IS NULL OR p_add && p_remove OR
     jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR jsonb_typeof(p_changes) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Thay đổi danh sách nhóm không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT FROM unnest(p_add || p_remove) AS ids(id)
    WHERE NOT EXISTS (SELECT FROM public.zalo_conversations c WHERE c.id=ids.id
      AND c.account_id=p_account_id AND c.organization_id=p_organization_id
      AND (c.id=ANY(p_remove) OR c.thread_type='group' OR c.is_sale_partner))) THEN
    RAISE EXCEPTION 'Người nhận không thuộc nick hoặc chưa đủ điều kiện' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.zalo_automations(user_id,organization_id,kind,enabled,config)
    VALUES(auth.uid(),p_organization_id,'broadcast_vacant',false,'{}')
    ON CONFLICT(organization_id,kind) DO NOTHING;
  SELECT * INTO STRICT a FROM public.zalo_automations WHERE organization_id=p_organization_id AND kind='broadcast_vacant' FOR UPDATE;
  IF jsonb_typeof(a.config) IS DISTINCT FROM 'object' THEN a.config:='{}'::jsonb; END IF;
  shared:=a.config || jsonb_build_object('enabled',a.enabled);
  FOR field IN SELECT jsonb_object_keys(p_changes) LOOP
    IF field NOT IN ('schedule','template','antiSpam','eventDriven','enabled')
       OR jsonb_typeof(p_changes->field) IS DISTINCT FROM (CASE WHEN field='enabled' THEN 'boolean' ELSE 'object' END) THEN
      RAISE EXCEPTION 'Trường cài đặt không hợp lệ' USING ERRCODE='22023';
    END IF;
    IF shared->field IS DISTINCT FROM p_changes->field AND shared->field IS DISTINCT FROM p_expected->field THEN
      RAISE EXCEPTION 'Cài đặt công ty vừa thay đổi. Đóng rồi mở lại để lấy bản mới.' USING ERRCODE='40001';
    END IF;
  END LOOP;
  recipients:=CASE WHEN jsonb_typeof(a.config->'recipients')='array'
    THEN a.config->'recipients' ELSE '[]'::jsonb END;
  SELECT COALESCE(jsonb_agg(val ORDER BY pos),'[]'::jsonb) INTO recipients
  FROM (
    SELECT val,min(pos) pos FROM (
      SELECT val,pos FROM jsonb_array_elements_text(recipients) WITH ORDINALITY AS old(val,pos)
      WHERE NOT EXISTS (SELECT FROM unnest(p_remove) AS gone(id) WHERE gone.id::text=old.val)
      UNION ALL
      SELECT id::text,jsonb_array_length(recipients)+pos FROM unnest(p_add) WITH ORDINALITY AS added(id,pos)
    ) items GROUP BY val
  ) ordered;
  UPDATE public.zalo_automations SET enabled=COALESCE((p_changes->>'enabled')::boolean,a.enabled),
    config=a.config || (p_changes-'enabled') || jsonb_build_object('recipients',recipients)
    WHERE id=a.id RETURNING * INTO a;
  RETURN jsonb_build_object('config',a.config,'enabled',a.enabled);
END $fn$;
REVOKE ALL ON FUNCTION public.zalo_save_account_recipients_v1(uuid,uuid,uuid[],uuid[],jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.zalo_save_account_recipients_v1(uuid,uuid,uuid[],uuid[],jsonb,jsonb) TO authenticated;

-- Repeated clicks while the same directory is loading reuse its job.
CREATE OR REPLACE FUNCTION public.zalo_sync_account_groups_v1(p_organization_id uuid,p_account_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $fn$
DECLARE
  a public.zalo_accounts;
  job_id uuid;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR
     NOT (COALESCE(public.zalo_can('send',p_organization_id),false) OR
          COALESCE(public.zalo_can('manage_automation',p_organization_id),false)) THEN
    RAISE EXCEPTION 'Không có quyền đồng bộ nhóm Zalo' USING ERRCODE='42501';
  END IF;
  SELECT * INTO a FROM public.zalo_accounts WHERE id=p_account_id AND organization_id=p_organization_id
    AND kind='personal' FOR UPDATE;
  IF NOT FOUND OR a.status IS DISTINCT FROM 'connected' THEN
    RAISE EXCEPTION 'Chọn một nick Zalo cá nhân đang kết nối để đồng bộ nhóm' USING ERRCODE='22023';
  END IF;
  SELECT id INTO job_id FROM public.zalo_send_queue WHERE organization_id=p_organization_id AND account_id=a.id
    AND payload->>'action'='sync_groups' AND status IN ('queued','processing') ORDER BY created_at LIMIT 1;
  IF job_id IS NULL THEN
    INSERT INTO public.zalo_send_queue(user_id,organization_id,account_id,channel,payload,status)
      VALUES(auth.uid(),p_organization_id,a.id,'personal',jsonb_build_object('action','sync_groups'),'queued') RETURNING id INTO job_id;
  END IF;
  RETURN job_id;
END $fn$;
REVOKE ALL ON FUNCTION public.zalo_sync_account_groups_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.zalo_sync_account_groups_v1(uuid,uuid) TO authenticated;
