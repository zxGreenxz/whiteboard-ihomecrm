-- Missing handover readings remain visible even after the old exit is settled.
-- Read-only operational queue; no invoices, settlement or room status writes.
CREATE OR REPLACE FUNCTION public.list_contract_meter_followups_v1(
  p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT 10,p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_offset IS NULL OR p_offset<0 THEN
    RAISE EXCEPTION 'Phân trang không hợp lệ' USING ERRCODE='22023';
  END IF;
  WITH eligible AS MATERIALIZED (
    SELECT s.id,s.contract_id,c.contract_number,b.name building_name,r.name room_name,s.effective_on,s.state
    FROM public.contract_meter_boundary_sets s
    JOIN public.contracts c ON c.id=s.contract_id AND c.organization_id=s.organization_id AND c.deleted_at IS NULL
    JOIN public.rooms r ON r.id=s.room_id AND r.organization_id=s.organization_id AND r.deleted_at IS NULL
    JOIN public.buildings b ON b.id=s.building_id AND b.organization_id=s.organization_id AND b.deleted_at IS NULL
    WHERE s.organization_id=p_organization_id AND s.kind='MOVE_OUT' AND s.state IN ('MISSING','REVIEW')
      AND (COALESCE(cardinality(p_building_ids),0)=0 OR s.building_id=ANY(p_building_ids))
      AND public.can_access_building(s.building_id)
      AND NOT COALESCE(public.is_super_admin() AND s.organization_id=ANY(public.sandbox_org_ids()),false)
      AND EXISTS(SELECT 1 FROM app_private.authorized_scope_v3('contracts.view',p_organization_id) a
        WHERE a.org_wide OR s.building_id=ANY(a.building_ids))
  ), page AS (SELECT * FROM eligible ORDER BY effective_on,id LIMIT p_limit OFFSET p_offset)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY effective_on,id) FROM page),'[]'::jsonb),
    'total',(SELECT count(*) FROM eligible),'limit',p_limit,'offset',p_offset) INTO result;
  RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.list_contract_meter_followups_v1(uuid,uuid[],integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.list_contract_meter_followups_v1(uuid,uuid[],integer,integer) TO authenticated;
