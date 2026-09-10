DECLARE
  j jsonb := to_jsonb(NEW);
  v uuid;
  v_orgs uuid[];
BEGIN
  -- A linked monthly row is authoritative, including historical employment.
  IF j->>'salary_monthly_id' IS NOT NULL THEN
    SELECT organization_id INTO v FROM public.salary_monthly
      WHERE id=(j->>'salary_monthly_id')::uuid;
    IF v IS NULL THEN RAISE EXCEPTION 'Bảng lương liên kết chưa có công ty rõ ràng' USING ERRCODE='22023'; END IF;
  ELSIF auth.uid() IS NOT NULL AND j->>'staff_id' IS NOT NULL AND j->>'period_month' IS NOT NULL THEN
    v := app_private.salary_subject_organization_v1((j->>'staff_id')::uuid,(j->>'period_month')::date,NULL,NEW.organization_id);
  ELSIF NEW.organization_id IS NOT NULL THEN
    -- Trusted background writers already supply an explicit organization.
    RETURN NEW;
  ELSIF j->>'staff_id' IS NOT NULL THEN
    SELECT array_agg(DISTINCT organization_id) INTO v_orgs
      FROM public.manager_salary_config
     WHERE staff_id=(j->>'staff_id')::uuid AND organization_id IS NOT NULL AND is_active
       AND effective_from<=(j->>'period_month')::date
       AND (effective_to IS NULL OR effective_to>=(j->>'period_month')::date);
    IF cardinality(v_orgs)=1 THEN v := v_orgs[1];
    ELSIF cardinality(v_orgs)>1 THEN
      RAISE EXCEPTION 'Nhân viên có cấu hình lương ở nhiều công ty; đường ghi phải chỉ rõ công ty' USING ERRCODE='22023';
    ELSE
      SELECT array_agg(DISTINCT organization_id) INTO v_orgs
        FROM public.organization_memberships
       WHERE user_id=(j->>'staff_id')::uuid
         AND app_private.active_working_membership_v1(user_id,organization_id);
      IF cardinality(v_orgs)=1 THEN v := v_orgs[1]; END IF;
    END IF;
  END IF;
  IF v IS NULL THEN RAISE EXCEPTION 'Không xác định được công ty cho dòng lương' USING ERRCODE='22023'; END IF;
  IF NEW.organization_id IS NOT NULL AND NEW.organization_id<>v THEN
    RAISE EXCEPTION 'Công ty không khớp bảng lương đã có' USING ERRCODE='42501';
  END IF;
  NEW.organization_id := v;
  RETURN NEW;
END;
