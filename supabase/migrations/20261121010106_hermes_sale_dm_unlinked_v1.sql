BEGIN;

-- A confirmed CRM link reserves this sender's direct messages for the private
-- assistant. Group admission uses the broker group identified by its thread ID.
CREATE OR REPLACE FUNCTION app_private.hermes_sale_channel_v1(p_org uuid,p_account uuid,p_instance uuid,p_generation uuid,p_type text,p_thread text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_private.hermes_zalo_bots b
    JOIN app_private.hermes_zalo_ingress_sessions i USING(account_id,organization_id)
    JOIN public.zalo_accounts a ON a.id=b.account_id AND a.organization_id=b.organization_id
    JOIN public.zalo_worker_lease l ON l.id='singleton' AND l.instance_id=i.instance_id
    WHERE b.enabled AND b.organization_id=p_org AND b.account_id=p_account AND a.kind='personal' AND a.status='connected'
      AND i.own_uid=a.zalo_uid AND i.account_owner_id=a.user_id AND i.login_requested_at IS NOT DISTINCT FROM a.login_requested_at
      AND i.generation=p_generation AND i.instance_id=p_instance AND l.heartbeat_at>statement_timestamp()-interval '30 seconds'
      AND ((p_type='user' AND NOT EXISTS (
        SELECT 1 FROM app_private.hermes_zalo_bindings x
        WHERE x.organization_id=p_org AND x.account_id=p_account AND x.sender_uid=p_thread AND x.state='ACTIVE'
      )) OR (p_type='group' AND EXISTS (
        SELECT 1 FROM public.zalo_conversations c WHERE c.organization_id=p_org AND c.account_id=p_account
          AND c.thread_type='group' AND c.thread_id=p_thread AND c.is_sale_partner)))
  ) AND EXISTS (SELECT 1 FROM public.zalo_automations a WHERE a.organization_id=p_org
    AND a.kind='auto_reply' AND a.enabled AND a.config->'saleAdvisor'='true'::jsonb)
$$;
ALTER FUNCTION app_private.hermes_sale_channel_v1(uuid,uuid,uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_sale_channel_v1(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

COMMIT;
