-- Private title-owner data: never add these fields to buildings or its public projections.
CREATE TABLE IF NOT EXISTS public.building_legal_owners (
  building_id uuid PRIMARY KEY REFERENCES public.buildings(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  full_name text NOT NULL DEFAULT '' CHECK (length(full_name)<=200),
  birth_year integer CHECK (birth_year BETWEEN 1800 AND 2200),
  id_number text NOT NULL DEFAULT '' CHECK (length(id_number)<=50),
  id_issue_date date,
  id_issue_place text NOT NULL DEFAULT '' CHECK (length(id_issue_place)<=500),
  permanent_address text NOT NULL DEFAULT '' CHECK (length(permanent_address)<=1000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.building_legal_owners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS building_legal_owners_read ON public.building_legal_owners;
CREATE POLICY building_legal_owners_read ON public.building_legal_owners FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.buildings b WHERE b.id=building_id
  AND b.organization_id=building_legal_owners.organization_id AND b.deleted_at IS NULL
  AND public.can_access_building(b.id)
  AND (public.can_do_on_building('buildings','edit',b.id) OR public.can_do_on_building('customers','print',b.id))));
DROP POLICY IF EXISTS building_legal_owners_hide_sandbox_admin ON public.building_legal_owners;
CREATE POLICY building_legal_owners_hide_sandbox_admin ON public.building_legal_owners AS RESTRICTIVE FOR ALL TO authenticated
USING (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));
REVOKE ALL ON public.building_legal_owners FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.building_legal_owners TO authenticated;

CREATE OR REPLACE FUNCTION public.save_building_legal_owner(p_building_id uuid, p_owner jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.buildings%ROWTYPE;
BEGIN
  -- Lock building to serialize one-time initial entry and all concurrent owner saves.
  SELECT * INTO b FROM public.buildings WHERE id=p_building_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR b.deleted_at IS NOT NULL
    OR public.can_access_building(b.id) IS DISTINCT FROM true
    OR (public.is_super_admin() AND COALESCE(b.organization_id=ANY(public.sandbox_org_ids()),false)) THEN
    RAISE EXCEPTION 'Không có quyền lưu chủ sở hữu' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_owner) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Thông tin chủ sở hữu không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF public.can_do_on_building('buildings','edit',b.id) IS DISTINCT FROM true THEN
    -- A creator may initialize a missing owner once; later edits require buildings.edit.
    IF b.user_id IS DISTINCT FROM auth.uid()
      OR public.can_do_on_building('buildings','create',b.id) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Không có quyền sửa chủ sở hữu' USING ERRCODE='42501';
    END IF;
    IF EXISTS(SELECT 1 FROM public.building_legal_owners WHERE building_id=b.id) THEN
      -- Lost HTTP response after initial commit: same normalized payload is a no-op.
      IF EXISTS(SELECT 1 FROM public.building_legal_owners o WHERE o.building_id=b.id
        AND o.full_name=trim(COALESCE(p_owner->>'full_name',''))
        AND o.birth_year IS NOT DISTINCT FROM nullif(p_owner->>'birth_year','')::integer
        AND o.id_number=trim(COALESCE(p_owner->>'id_number',''))
        AND o.id_issue_date IS NOT DISTINCT FROM nullif(p_owner->>'id_issue_date','')::date
        AND o.id_issue_place=trim(COALESCE(p_owner->>'id_issue_place',''))
        AND o.permanent_address=trim(COALESCE(p_owner->>'permanent_address',''))) THEN RETURN; END IF;
      RAISE EXCEPTION 'Không có quyền sửa chủ sở hữu' USING ERRCODE='42501';
    END IF;
  END IF;
  INSERT INTO public.building_legal_owners(building_id,organization_id,full_name,birth_year,id_number,id_issue_date,id_issue_place,permanent_address)
  VALUES(b.id,b.organization_id,trim(COALESCE(p_owner->>'full_name','')),nullif(p_owner->>'birth_year','')::integer,
    trim(COALESCE(p_owner->>'id_number','')),nullif(p_owner->>'id_issue_date','')::date,
    trim(COALESCE(p_owner->>'id_issue_place','')),trim(COALESCE(p_owner->>'permanent_address','')))
  ON CONFLICT(building_id) DO UPDATE SET full_name=EXCLUDED.full_name,birth_year=EXCLUDED.birth_year,
    id_number=EXCLUDED.id_number,id_issue_date=EXCLUDED.id_issue_date,id_issue_place=EXCLUDED.id_issue_place,
    permanent_address=EXCLUDED.permanent_address,organization_id=EXCLUDED.organization_id,updated_at=now();
END $$;
REVOKE ALL ON FUNCTION public.save_building_legal_owner(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_building_legal_owner(uuid,jsonb) TO authenticated;
