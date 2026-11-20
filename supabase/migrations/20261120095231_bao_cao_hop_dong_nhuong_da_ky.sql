CREATE OR REPLACE FUNCTION public.real_estate_renewals_transfers_v1(
  p_organization_id uuid,p_building_ids uuid[],p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(kind text,event_id uuid,contract_id uuid,contract_number text,event_date date,rent_price numeric,
  room_id uuid,room_name text,building_id uuid,building_name text,customer_id uuid,customer_name text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE
  v_key constant text := 'reports_real_estate.renewals_transfers';
  v_context jsonb;
  v_scope jsonb;
  v_buildings uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501';
  END IF;
  -- The org-specific context uses the actor's actual membership and permission even for platform admins.
  -- Its scopeSets only compress buildingIds when orgWide is effective with no narrower DENY.
  v_context:=public.get_authorization_context_v1(p_organization_id);
  IF v_context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR v_context->>'membershipId' IS NULL
     OR v_context->>'isOffboarded' IS DISTINCT FROM 'false' OR v_context->'permissions'->>v_key IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501';
  END IF;
  v_scope:=v_context->'scopeSets'->((v_context->'scopes'->>v_key)::integer);
  IF jsonb_typeof(v_scope) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501';
  END IF;
  SELECT ARRAY(
    SELECT b.id FROM public.buildings b WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL
      AND (v_scope->>'orgWide'='true' OR (v_scope->'buildingIds') ? (b.id::text))
      AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids)) AND public.can_access_building(b.id)
  ) INTO v_buildings;
  IF cardinality(v_buildings)=0 THEN RETURN; END IF;

  RETURN QUERY
  WITH visible_signings AS MATERIALIZED (
    SELECT s.draft_id,s.contract_id,s.room_id,s.building_id,s.received_on,s.terms
    FROM public.contract_draft_signings s
    WHERE s.organization_id=p_organization_id AND s.building_id=ANY(v_buildings)
  ), signed AS MATERIALIZED (
    SELECT (link->>'id')::uuid AS link_id,(link->>'old_contract_id')::uuid AS old_contract_id,
      s.contract_id AS new_contract_id,s.room_id,s.received_on,
      (SELECT j->>'id' FROM jsonb_array_elements(s.terms->'customers') j WHERE j->>'is_representative'='true' LIMIT 1) AS representative_id,
      (s.terms->'form'->>'rent_price')::numeric AS signed_rent
    FROM visible_signings s CROSS JOIN LATERAL jsonb_array_elements(
      public.read_contract_transfer_links_v1(p_organization_id,NULL,s.draft_id,NULL)) link
    WHERE link->>'state'='LINKED' AND (link->>'new_contract_id')::uuid=s.contract_id
      AND (link->>'new_draft_id')::uuid=s.draft_id AND (link->>'room_id')::uuid=s.room_id
      AND (link->>'building_id')::uuid=s.building_id
  ), legacy AS MATERIALIZED (
    SELECT t.id,t.contract_id,t.transfer_date,t.new_tenant_id,t.new_room_id,t.new_rent_price
    FROM public.contract_transfers t
    JOIN public.contracts c ON c.id=t.contract_id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL
    WHERE (t.organization_id=p_organization_id OR t.organization_id IS NULL)
      AND t.transfer_type IN ('TENANT_CHANGE','BOTH_CHANGE') AND t.status IN ('APPROVED','COMPLETED')
  ), events(kind,event_id,contract_id,event_date,room_id,rent_price,representative_id,has_recorded_party) AS (
    SELECT 'RENEWAL'::text,e.id,e.contract_id,e.extension_date,NULL::uuid,e.new_rent_price,NULL::text,false
    FROM public.contract_extensions e WHERE e.status IN ('APPROVED','COMPLETED')
    UNION ALL
    SELECT 'TRANSFER',s.link_id,s.new_contract_id,s.received_on,s.room_id,s.signed_rent,s.representative_id,true FROM signed s
    UNION ALL
    SELECT 'TRANSFER',t.id,t.contract_id,t.transfer_date,t.new_room_id,t.new_rent_price,t.new_tenant_id::text,true
    FROM legacy t WHERE NOT EXISTS (
      SELECT 1 FROM signed s WHERE t.contract_id IN (s.old_contract_id,s.new_contract_id)
        AND t.transfer_date=s.received_on AND t.new_tenant_id::text=s.representative_id)
    UNION ALL
    -- Older records can have only the status and its last timestamp. A known
    -- transfer is stronger evidence than that fallback, including outside the chosen date range.
    SELECT 'TRANSFER',c.id,c.id,(c.updated_at AT TIME ZONE COALESCE((SELECT tz.timezone FROM public.organization_timezones tz WHERE tz.organization_id=p_organization_id),'Asia/Ho_Chi_Minh'))::date,NULL::uuid,c.rent_price,NULL::text,false
    FROM public.contracts c WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text='TRANSFERRED'
      AND NOT EXISTS (SELECT 1 FROM legacy t WHERE t.contract_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM signed s WHERE c.id IN (s.old_contract_id,s.new_contract_id))
  )
  SELECT e.kind,e.event_id,c.id,c.contract_number,e.event_date,COALESCE(e.rent_price,c.rent_price),
    r.id,r.name,b.id,b.name,cu.id,cu.full_name,c.organization_id
  FROM events e
  JOIN public.contracts c ON c.id=e.contract_id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL
  JOIN public.rooms r ON r.id=COALESCE(e.room_id,c.room_id) AND r.building_id=ANY(v_buildings)
  JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=p_organization_id
  LEFT JOIN LATERAL (
    SELECT cc.customer_id FROM public.contract_customers cc
    JOIN public.customers customer ON customer.id=cc.customer_id AND customer.organization_id=p_organization_id AND customer.deleted_at IS NULL
    WHERE NOT e.has_recorded_party AND cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1
  ) rep ON true
  LEFT JOIN public.customers cu ON cu.id=COALESCE(e.representative_id::uuid,rep.customer_id)
    AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL
  WHERE (p_from IS NULL OR e.event_date>=p_from) AND (p_to IS NULL OR e.event_date<=p_to)
  ORDER BY e.event_date DESC,e.kind,c.contract_number,e.event_id;
END $fn$;
REVOKE ALL ON FUNCTION public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date) TO authenticated;
