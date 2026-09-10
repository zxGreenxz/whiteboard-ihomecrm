-- Private helpers only. They provide identity; existing RPC permission and
-- possession checks remain authoritative. No RLS policy is replaced here.
CREATE OR REPLACE FUNCTION app_private.active_working_membership_v1(p_user uuid, p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    JOIN public.organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
    WHERE m.user_id=p_user AND m.organization_id=p_org AND m.status='ACTIVE'
      AND coalesce(m.valid_from,'-infinity'::timestamptz)<=now()
      AND (m.valid_to IS NULL OR m.valid_to>now())
  );
$fn$;
REVOKE ALL ON FUNCTION app_private.active_working_membership_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.working_organization_v1(p_required boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_requested text;
  v_org uuid;
  v_orgs uuid[];
BEGIN
  IF v_actor IS NULL THEN
    IF p_required THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
    RETURN NULL;
  END IF;
  v_requested := nullif(nullif(current_setting('request.headers',true),'')::jsonb->>'x-ihomecrm-organization-id','');
  IF v_requested IS NOT NULL THEN
    BEGIN v_org := v_requested::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Công ty làm việc không hợp lệ' USING ERRCODE='22023';
    END;
    IF NOT app_private.active_working_membership_v1(v_actor,v_org) THEN
      RAISE EXCEPTION 'Không còn quyền làm việc trong công ty đã chọn' USING ERRCODE='42501';
    END IF;
    RETURN v_org;
  END IF;
  SELECT array_agg(DISTINCT m.organization_id) INTO v_orgs
  FROM public.organization_memberships m
  WHERE m.user_id=v_actor AND app_private.active_working_membership_v1(v_actor,m.organization_id);
  IF cardinality(v_orgs)=1 THEN RETURN v_orgs[1]; END IF;
  IF p_required THEN
    RAISE EXCEPTION 'Hãy chọn công ty làm việc trong Tài khoản trước khi tiếp tục' USING ERRCODE='22023';
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION app_private.working_organization_v1(boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.salary_subject_organization_v1(p_staff uuid,p_period date,p_account uuid DEFAULT NULL,p_selected uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org uuid; v_orgs uuid[]; v_selected uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_staff IS NULL OR p_period IS NULL THEN RAISE EXCEPTION 'Thiếu nhân viên hoặc kỳ lương' USING ERRCODE='22023'; END IF;
  -- A persisted monthly row owns its company, even after a staff member moves.
  SELECT array_agg(DISTINCT organization_id) INTO v_orgs
    FROM public.salary_monthly WHERE staff_id=p_staff AND period_month=p_period;
  IF v_orgs IS NOT NULL THEN
    IF cardinality(v_orgs)<>1 OR v_orgs[1] IS NULL THEN
      RAISE EXCEPTION 'Bảng lương chưa có công ty rõ ràng; cần kiểm tra trước khi thao tác' USING ERRCODE='22023';
    END IF;
    v_org := v_orgs[1];
  ELSE
    v_selected := coalesce(p_selected,app_private.working_organization_v1(false));
    SELECT array_agg(DISTINCT organization_id) INTO v_orgs
      FROM public.manager_salary_config
     WHERE staff_id=p_staff AND organization_id IS NOT NULL AND is_active
       AND effective_from<=p_period AND (effective_to IS NULL OR effective_to>=p_period)
       AND (v_selected IS NULL OR organization_id=v_selected);
    IF cardinality(v_orgs)=1 THEN v_org := v_orgs[1];
    ELSIF cardinality(v_orgs)>1 THEN
      RAISE EXCEPTION 'Nhân viên có cấu hình lương ở nhiều công ty; hãy chọn công ty' USING ERRCODE='22023';
    ELSIF v_selected IS NOT NULL AND app_private.active_working_membership_v1(p_staff,v_selected) THEN
      v_org := v_selected;
    ELSE
      SELECT array_agg(DISTINCT organization_id) INTO v_orgs
        FROM public.organization_memberships
       WHERE user_id=p_staff AND app_private.active_working_membership_v1(p_staff,organization_id);
      IF cardinality(v_orgs)=1 AND (v_selected IS NULL OR v_selected=v_orgs[1]) THEN v_org := v_orgs[1]; END IF;
    END IF;
  END IF;
  IF v_org IS NULL OR NOT app_private.active_working_membership_v1(auth.uid(),v_org) THEN
    RAISE EXCEPTION 'Không xác định được công ty lương hợp lệ cho thao tác này' USING ERRCODE='42501';
  END IF;
  IF p_account IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts WHERE id=p_account AND organization_id=v_org AND deleted_at IS NULL
  ) THEN RAISE EXCEPTION 'Sổ quỹ không thuộc công ty của bảng lương' USING ERRCODE='42501'; END IF;
  RETURN v_org;
END;
$fn$;
REVOKE ALL ON FUNCTION app_private.salary_subject_organization_v1(uuid,date,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
