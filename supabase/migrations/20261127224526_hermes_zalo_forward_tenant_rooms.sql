-- Resolve a private forward against its original CRM message, never against its text.
BEGIN;

CREATE INDEX IF NOT EXISTS zalo_messages_forward_source_idx
  ON public.zalo_messages (organization_id, (zalo_raw->>'ts'))
  WHERE msg_type IN ('text','image');

CREATE OR REPLACE FUNCTION public.hermes_zalo_forward_tenant_v1(p_binding jsonb, p_reference text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE
  c app_private.hermes_connections; policy app_private.hermes_org_policies; ctx jsonb;
  customer_scope uuid[]; contract_scope uuid[]; customer_key uuid; customer_keys uuid[]; linked boolean;
  today date;
  rooms jsonb := '[]'; match_state text := 'ask_customer'; capped boolean := false;
BEGIN
  IF p_reference IS NULL OR length(p_reference) <> 78 OR p_reference !~ '^[1-9][0-9]{12}\.[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  c := app_private.hermes_sale_binding_v1(p_binding);
  today := public.org_today_v1(c.organization_id);
  ctx := public.get_authorization_context_v1(c.organization_id);
  policy := app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  -- Same organization-wide Chat Zalo admission as the inbox, plus the two independent tenant/contract read fences.
  IF NOT coalesce(policy.enabled AND 'chat_zalo.view'=ANY(policy.read_capabilities) AND 'chat_zalo.view'=ANY(c.read_capabilities),false)
     OR NOT EXISTS (SELECT FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled)
     OR NOT EXISTS (SELECT FROM public.zalo_authorized_org_ids('view') org(id) WHERE org.id=c.organization_id)
     OR NOT EXISTS (SELECT FROM public.authorization_scopes s WHERE s.organization_id=c.organization_id
        AND s.id=ANY(c.scope_ids) AND s.id=ANY(policy.scope_ids) AND s.scope_type='ORGANIZATION' AND s.cashbook_id IS NULL) THEN
    RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501';
  END IF;
  customer_scope := app_private.hermes_full_read_scope_v1(c,policy,ctx,'customers.view');
  contract_scope := app_private.hermes_full_read_scope_v1(c,policy,ctx,'contracts.view');
  IF coalesce(cardinality(customer_scope),0)=0 OR coalesce(cardinality(contract_scope),0)=0 THEN
    RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501';
  END IF;

  SELECT array_agg(DISTINCT z.customer_id), bool_and(m.hidden_at IS NULL AND z.thread_type IS NOT DISTINCT FROM 'user' AND z.customer_id IS NOT NULL)
    INTO customer_keys,linked
    FROM public.zalo_messages m JOIN public.zalo_conversations z
      ON (z.id,z.account_id,z.organization_id)=(m.conversation_id,m.account_id,m.organization_id)
    WHERE m.organization_id=c.organization_id AND m.msg_type IN ('text','image')
      AND m.zalo_raw->>'ts'=split_part(p_reference,'.',1)
      AND (encode(sha256(convert_to(m.zalo_msg_id,'UTF8')),'hex')=split_part(p_reference,'.',2)
        OR encode(sha256(convert_to(m.cli_msg_id,'UTF8')),'hex')=split_part(p_reference,'.',2));
  IF linked AND cardinality(customer_keys)=1 THEN
    SELECT cu.id INTO customer_key FROM public.customers cu WHERE cu.id=customer_keys[1] AND cu.organization_id=c.organization_id
      AND cu.deleted_at IS NULL AND cu.user_id=ANY(public.current_visible_owner_ids());
  END IF;
  IF customer_key IS NOT NULL THEN
    -- Active membership is authoritative. Older contracts without a member list have a tenant record;
    -- use the CRM's normalized phone only when it belongs to one customer and one tenant.
    WITH contact AS (
      SELECT public.phone_digits(cu.phone) AS phone FROM public.customers cu WHERE cu.id=customer_key
    ), legacy_tenant AS (
      SELECT t.id FROM public.tenants t, contact k WHERE t.organization_id=c.organization_id AND t.deleted_at IS NULL
        AND length(k.phone)>=8 AND public.phone_digits(t.phone)=k.phone
        AND NOT EXISTS (SELECT FROM public.customers other WHERE other.organization_id=c.organization_id AND other.deleted_at IS NULL
          AND other.id<>customer_key AND public.phone_digits(other.phone)=k.phone)
        AND NOT EXISTS (SELECT FROM public.tenants other WHERE other.organization_id=c.organization_id AND other.deleted_at IS NULL
          AND other.id<>t.id AND public.phone_digits(other.phone)=k.phone)
    ), leases AS (
      SELECT cc.contract_id FROM public.contract_customers cc WHERE cc.organization_id=c.organization_id AND cc.customer_id=customer_key
      UNION ALL
      SELECT ct.id FROM public.contracts ct JOIN legacy_tenant t ON t.id=ct.tenant_id WHERE ct.organization_id=c.organization_id
        AND NOT EXISTS (SELECT FROM public.contract_customers cc WHERE cc.contract_id=ct.id AND cc.organization_id=c.organization_id)
    ), current_rooms AS (
      SELECT DISTINCT r.id,r.name,b.id building_id,b.name building_name
      FROM leases l JOIN public.contracts ct ON ct.id=l.contract_id AND ct.organization_id=c.organization_id
      JOIN public.rooms r ON r.id=ct.room_id AND r.organization_id=c.organization_id AND r.deleted_at IS NULL
      JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id AND b.deleted_at IS NULL
      WHERE ct.deleted_at IS NULL AND ct.status='ACTIVE' AND ct.start_date<=today
        AND (ct.actual_end_date IS NULL OR ct.actual_end_date>=today)
    ), visible AS (
      SELECT * FROM current_rooms WHERE building_id=ANY(customer_scope) AND building_id=ANY(contract_scope)
      ORDER BY building_name,name,id LIMIT 21
    )
    SELECT CASE WHEN EXISTS(SELECT FROM current_rooms WHERE NOT (building_id=ANY(customer_scope) AND building_id=ANY(contract_scope)))
        THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('roomId',x.id,'roomName',app_private.hermes_full_text_v1(x.name,100),
          'buildingId',x.building_id,'buildingName',app_private.hermes_full_text_v1(x.building_name,200)) ORDER BY x.building_name,x.name,x.id)
          FROM (SELECT * FROM visible ORDER BY building_name,name,id LIMIT 20) x),'[]') END,
      (SELECT count(*)>20 FROM visible) INTO rooms,capped;
    match_state := CASE jsonb_array_length(rooms) WHEN 0 THEN 'ask_room' WHEN 1 THEN 'matched' ELSE 'choose_room' END;
    capped := capped AND match_state='choose_room';
  END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain','zalo_conversations',
    'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'report','forwarded_tenant','source','crm.zalo_messages','unavailable',NULL,'summary',jsonb_build_object('match',match_state),
    'items',rooms,'offset',0,'nextOffset',NULL,'sourceCapped',capped);
END $fn$;
ALTER FUNCTION public.hermes_zalo_forward_tenant_v1(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_zalo_forward_tenant_v1(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_forward_tenant_v1(jsonb,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
