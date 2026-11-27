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
  thread text;
  target jsonb;
  scopes jsonb;
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
  -- Scope is shared by the physical group, even when two company accounts join it.
  -- Merge only the edited keys under the same row lock as recipient membership.
  IF p_changes ? 'groupBuildings' THEN
    IF jsonb_typeof(p_changes->'groupBuildings') IS DISTINCT FROM 'object' OR
       jsonb_typeof(p_expected->'groupBuildings') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Phạm vi tòa không hợp lệ' USING ERRCODE='22023';
    END IF;
    scopes:=COALESCE(a.config->'groupBuildings','{}'::jsonb);
    FOR thread,target IN SELECT key,value FROM jsonb_each(p_changes->'groupBuildings') LOOP
      IF NOT EXISTS (SELECT FROM public.zalo_conversations c WHERE c.thread_id=thread
        AND c.thread_type='group' AND c.account_id=p_account_id AND c.organization_id=p_organization_id) THEN
        RAISE EXCEPTION 'Nhóm không thuộc nick đang sửa' USING ERRCODE='42501';
      END IF;
      IF target <> 'null'::jsonb AND (jsonb_typeof(target)<>'string' OR NOT EXISTS (
        SELECT FROM public.buildings b WHERE b.id=(target #>> '{}')::uuid AND b.organization_id=p_organization_id
        AND NOT b.is_virtual AND b.deleted_at IS NULL AND public.can_access_building(b.id))) THEN
        RAISE EXCEPTION 'Tòa không còn thuộc danh sách của công ty' USING ERRCODE='22023';
      END IF;
      IF NOT ((p_expected->'groupBuildings') ? thread) OR
         (COALESCE(scopes->thread,'null'::jsonb) IS DISTINCT FROM target AND
          COALESCE(scopes->thread,'null'::jsonb) IS DISTINCT FROM p_expected->'groupBuildings'->thread) THEN
        RAISE EXCEPTION 'Tòa của nhóm vừa thay đổi. Mở lại để lấy cài đặt mới.' USING ERRCODE='40001';
      END IF;
      scopes:=CASE WHEN target='null'::jsonb THEN scopes-thread ELSE jsonb_set(scopes,ARRAY[thread],target) END;
    END LOOP;
    a.config:=jsonb_set(a.config,'{groupBuildings}',scopes);
    p_changes:=p_changes-'groupBuildings';
  END IF;
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

-- Older CRM and Hermes clients replace the shared template. Only the account-scoped
-- RPC above may alter the building of a group.
CREATE OR REPLACE FUNCTION public.zalo_luu_tu_dong_hoa(
  p_kind            text,
  p_enabled         boolean,
  p_config          jsonb DEFAULT NULL,
  p_organization_id uuid  DEFAULT NULL
)
RETURNS public.zalo_automations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_row  public.zalo_automations;
  v_org  uuid;
  v_orgs uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('broadcast_vacant','auto_reply') THEN
    RAISE EXCEPTION 'Loại tự động hoá không hợp lệ: %', p_kind USING ERRCODE = '22023';
  END IF;
  -- config phải là OBJECT: mảng/số/chuỗi lọt vào đây thì worker đọc ra rác và
  -- im lặng dùng mặc định — hỏng kiểu ở biên thì chặn ngay tại biên.
  IF p_config IS NOT NULL AND jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'Cấu hình phải là đối tượng JSON (nhận: %)', jsonb_typeof(p_config) USING ERRCODE = '22023';
  END IF;

  IF p_organization_id IS NOT NULL THEN
    IF NOT COALESCE(public.zalo_can('manage_automation', p_organization_id), false) THEN
      RAISE EXCEPTION 'Bạn không có quyền quản lý tự động hoá trong tổ chức này' USING ERRCODE = '42501';
    END IF;
    v_org := p_organization_id;
  ELSE
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('manage_automation') o;
    IF v_orgs IS NULL OR array_length(v_orgs, 1) IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Không xác định được tổ chức — truyền p_organization_id (bạn thuộc nhiều tổ chức hoặc chưa được cấp quyền).' USING ERRCODE = '23502';
    END IF;
    v_org := v_orgs[1];
  END IF;

  INSERT INTO public.zalo_automations(user_id, organization_id, kind, enabled, config)
  VALUES (auth.uid(), v_org, p_kind, p_enabled,
    CASE WHEN p_kind = 'broadcast_vacant' THEN COALESCE(p_config, '{}'::jsonb) - 'groupBuildings'
         ELSE COALESCE(p_config, '{}'::jsonb) END)
  ON CONFLICT (organization_id, kind) DO UPDATE
    SET enabled    = EXCLUDED.enabled,
        -- Không truyền config = chỉ bật/tắt, GIỮ NGUYÊN cấu hình cũ.
        config     = CASE
          WHEN p_config IS NULL THEN public.zalo_automations.config
          WHEN p_kind = 'broadcast_vacant' AND public.zalo_automations.config ? 'groupBuildings'
            THEN EXCLUDED.config || jsonb_build_object('groupBuildings', public.zalo_automations.config->'groupBuildings')
          ELSE EXCLUDED.config
        END,
        updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_luu_tu_dong_hoa(text, boolean, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_luu_tu_dong_hoa(text, boolean, jsonb, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_luu_tu_dong_hoa(text, boolean, jsonb, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_luu_tu_dong_hoa(text, boolean, jsonb, uuid) TO authenticated, service_role;
