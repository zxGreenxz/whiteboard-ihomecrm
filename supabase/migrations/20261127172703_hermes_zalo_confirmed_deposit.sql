-- Private Zalo: an immutable preview, live peer consent, then the same INCOME + room claim transaction as the web.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_deposit_intents (
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  request_id uuid NOT NULL,
  binding_id uuid NOT NULL REFERENCES app_private.hermes_zalo_bindings(id),
  binding_epoch bigint NOT NULL,
  connection_epoch bigint NOT NULL,
  payload jsonb NOT NULL,
  preview jsonb NOT NULL,
  code text NOT NULL,
  confirmation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  superseded boolean NOT NULL DEFAULT false,
  consent_message text,
  result jsonb,
  PRIMARY KEY (connection_id,request_id),
  UNIQUE (binding_id,code),
  UNIQUE (binding_id,consent_message)
);
ALTER TABLE app_private.hermes_zalo_deposit_intents OWNER TO postgres;
ALTER TABLE app_private.hermes_zalo_deposit_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hermes_zalo_deposit_intents FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_deposit_payments (
  organization_id uuid NOT NULL, account_id uuid NOT NULL, reference text NOT NULL,
  connection_id uuid NOT NULL, request_id uuid NOT NULL,
  PRIMARY KEY (organization_id,account_id,reference),
  FOREIGN KEY (connection_id,request_id) REFERENCES app_private.hermes_zalo_deposit_intents
);
ALTER TABLE app_private.hermes_zalo_deposit_payments OWNER TO postgres;
ALTER TABLE app_private.hermes_zalo_deposit_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hermes_zalo_deposit_payments FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- Separate from the retired one-step Sale receipt capability. This grant can only write a peer-approved intent.
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled)
VALUES ('deposits.zalo_confirmed_receipt','action',true) ON CONFLICT (capability) DO NOTHING;

-- Old connectors validate an exact five-key response. Negotiate the additional key without an extra network read.
-- This header selects the response shape only; the writer independently checks all grants and consent.
DO $precondition$ BEGIN
  IF (SELECT md5(replace(prosrc,chr(13),'')) FROM pg_proc WHERE oid='public.hermes_sale_capabilities_v1(uuid)'::regprocedure) NOT IN ('b8bcb1004be1555ac05dc519b09ed844','9c2ae670cb78bfae7fae65a4beef561a') THEN
    RAISE EXCEPTION 'unexpected sale capability definition';
  END IF;
END $precondition$;
CREATE OR REPLACE FUNCTION public.hermes_sale_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb;context jsonb;policy app_private.hermes_org_policies;enabled boolean;allowed boolean;key text;
 buildings uuid[];permissions jsonb:='{}';
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
 IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 context:=public.get_authorization_context_v1(p_organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
  OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'hermes_sale_context_changed' USING ERRCODE='PT409'; END IF;
 policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit'],NULL);
 FOREACH key IN ARRAY ARRAY['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit'] LOOP
  enabled:=policy.enabled AND key=ANY(policy.action_capabilities) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability=key AND cap.mode='action' AND cap.enabled);
  allowed:=COALESCE(enabled AND context->'permissions'->key='true'::jsonb,false);
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
   CROSS JOIN app_private.authorized_scope_v3(key,p_organization_id) scope WHERE allowed AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
    AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])));
  IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
  permissions:=permissions||jsonb_build_object(key,jsonb_build_object('allowed',allowed,'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings)));
 END LOOP;

 IF coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-client-info','')='hermes-sale-zalo-deposit/1' THEN
   key:='deposits.zalo_confirmed_receipt';
   enabled:=EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap
     CROSS JOIN app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY[key],NULL) pol
     WHERE cap.capability=key AND cap.mode='action' AND cap.enabled AND pol.enabled AND key=ANY(pol.action_capabilities));
   permissions:=permissions||jsonb_build_object(key,jsonb_build_object('allowed',enabled AND (permissions#>>'{deposits.create,allowed}')::boolean,
     'companyEnabled',enabled,'buildingIds',CASE WHEN enabled THEN permissions#>'{deposits.create,buildingIds}' ELSE '[]'::jsonb END));
 END IF;
 RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',permissions);
END $fn$;

-- Worker-only evidence. The provider event is already checked for a direct live DM, freshness, quote/forward and self-echo.
-- Revalidate the current worker lease, login, binding and preview. This endpoint cannot create a financial record.
CREATE OR REPLACE FUNCTION public.hermes_zalo_deposit_consent_v1(
  p_account uuid,p_instance uuid,p_generation uuid,p_sender text,p_message text,p_sent_ms bigint,p_confirmation text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE at_time timestamptz:=clock_timestamp();
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  IF p_confirmation IS NULL OR length(p_confirmation)>1600 OR p_confirmation !~ '^Xác nhận cọc [0-9A-F]{12} · ' OR p_sender !~ '^[1-9][0-9]{0,39}$' OR p_message !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_sent_ms IS NULL OR p_message IS NULL OR p_sent_ms NOT BETWEEN
    floor(extract(epoch FROM at_time-interval '5 minutes')*1000) AND floor(extract(epoch FROM at_time+interval '30 seconds')*1000) THEN RETURN false; END IF;
  UPDATE app_private.hermes_zalo_deposit_intents d SET consent_message=p_message
    FROM app_private.hermes_zalo_bindings x
    JOIN app_private.hermes_connections c ON c.id=x.connection_id AND c.epoch=x.connection_epoch AND c.state='ACTIVE'
      AND c.organization_id=x.organization_id AND c.user_id=x.user_id AND c.assistant_id=x.assistant_id
    JOIN public.zalo_accounts a ON a.id=x.account_id AND a.organization_id=x.organization_id AND a.status='connected' AND a.kind='personal'
    JOIN app_private.hermes_zalo_bots bot ON bot.account_id=a.id AND bot.organization_id=a.organization_id AND bot.enabled AND bot.version=x.bot_version
    JOIN app_private.hermes_zalo_ingress_sessions i ON i.account_id=a.id AND i.organization_id=a.organization_id
      AND i.account_owner_id=a.user_id AND i.own_uid=a.zalo_uid AND i.login_requested_at IS NOT DISTINCT FROM a.login_requested_at
    JOIN public.zalo_worker_lease lease ON lease.id='singleton' AND lease.instance_id=i.instance_id AND lease.heartbeat_at>at_time-interval '30 seconds'
    WHERE a.id=p_account AND i.generation=p_generation AND i.instance_id=p_instance AND x.sender_uid=p_sender AND x.sender_uid<>i.own_uid
      AND x.state='ACTIVE' AND d.binding_id=x.id AND d.binding_epoch=x.epoch AND d.connection_id=c.id AND d.connection_epoch=c.epoch
      AND d.code=substring(p_confirmation FROM '^Xác nhận cọc ([0-9A-F]{12}) · ')
      AND normalize(d.confirmation) = normalize(p_confirmation) AND NOT d.superseded AND d.result IS NULL AND d.expires_at>at_time AND d.consent_message IS NULL
      AND p_sent_ms>=floor(extract(epoch FROM greatest(d.created_at,i.registered_at,x.activated_at))*1000);
  RETURN FOUND;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_zalo_deposit_v1(p_binding jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE
  c app_private.hermes_connections; x app_private.hermes_zalo_bindings; draft app_private.hermes_zalo_deposit_intents;
  org uuid; rid uuid; req uuid; book uuid; bid uuid; room_label text; building_label text; account_label text;
  key text; policy app_private.hermes_org_policies; labels jsonb; base jsonb; payment jsonb; total bigint:=0; amount bigint;
  day date; move_in date; target bigint; confirm_code text; confirm_text text; at_time timestamptz; written jsonb; output jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId','roomId','payerName','payments','accountId','voucherDate','intendedMoveInOn','depositTarget']);
  req:=app_private.hermes_uuid_v1(p_input->'requestId'); rid:=app_private.hermes_uuid_v1(p_input->'roomId'); book:=app_private.hermes_uuid_v1(p_input->'accountId');
  IF jsonb_typeof(p_input->'payerName') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'payerName')) NOT BETWEEN 1 AND 120
    OR (p_input->>'payerName') ~ '[[:cntrl:]]' OR jsonb_typeof(p_input->'payments') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_input->'voucherDate') IS DISTINCT FROM 'string' OR (p_input->>'voucherDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR (p_input->'intendedMoveInOn'<>'null'::jsonb AND (p_input->>'intendedMoveInOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
  day:=(p_input->>'voucherDate')::date; move_in:=(p_input->>'intendedMoveInOn')::date;
  IF p_input->'depositTarget'<>'null'::jsonb THEN target:=app_private.hermes_integer_v1(p_input->'depositTarget'); END IF;
  IF jsonb_array_length(p_input->'payments') NOT BETWEEN 1 AND 10 OR target NOT BETWEEN 1 AND 9999999999999
    OR day NOT BETWEEN date '2000-01-01' AND date '2100-12-31' OR move_in NOT BETWEEN date '2000-01-01' AND date '2100-12-31'
    THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
  FOR payment IN SELECT value FROM jsonb_array_elements(p_input->'payments') LOOP
    PERFORM app_private.hermes_request_v1(payment,ARRAY['amount','reference']);
    amount:=app_private.hermes_integer_v1(payment->'amount');
    IF amount NOT BETWEEN 1 AND 9999999999999
      OR (payment->'reference'='null'::jsonb AND jsonb_array_length(p_input->'payments')<>1)
      OR (payment->'reference'<>'null'::jsonb AND (jsonb_typeof(payment->'reference')<>'string' OR length(btrim(payment->>'reference')) NOT BETWEEN 1 AND 80 OR payment->>'reference' ~ '[[:cntrl:]]'))
      THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
    total:=total+amount;
  END LOOP;
  IF total>9999999999999 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'payments') j GROUP BY upper(btrim(j->>'reference')) HAVING count(*)>1)
    THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;

  -- All paths lock room before org, as the canonical voucher writer does.
  SELECT organization_id INTO org FROM app_private.hermes_connections WHERE id=app_private.hermes_uuid_v1(p_binding->'connectionId') AND user_id=auth.uid();
  SELECT r.building_id,r.name,b.name INTO bid,room_label,building_label FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
    WHERE r.id=rid AND r.organization_id=org AND r.deleted_at IS NULL AND b.deleted_at IS NULL FOR NO KEY UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
  c:=app_private.hermes_sale_binding_v1(p_binding);
  IF c.organization_id IS DISTINCT FROM org THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501'; END IF;
  BEGIN
    SELECT link.* INTO STRICT x FROM app_private.hermes_zalo_bindings link
      JOIN app_private.hermes_zalo_bots bot ON bot.account_id=link.account_id AND bot.organization_id=link.organization_id
        AND bot.enabled AND bot.version=link.bot_version
      JOIN public.zalo_accounts a ON a.id=bot.account_id AND a.organization_id=bot.organization_id AND a.status='connected' AND a.kind='personal'
      WHERE link.connection_id=c.id AND link.connection_epoch=c.epoch AND link.user_id=c.user_id
        AND link.assistant_id=c.assistant_id AND link.organization_id=c.organization_id AND link.state='ACTIVE' FOR SHARE OF link,bot,a;
  EXCEPTION WHEN no_data_found THEN RAISE EXCEPTION 'hermes_zalo_denied' USING ERRCODE='42501';
    WHEN too_many_rows THEN RAISE EXCEPTION 'zalo_deposit_ambiguous' USING ERRCODE='PT409';
  END;
  key:='deposits.zalo_confirmed_receipt';
  policy:=app_private.hermes_effective_org_policy_v1(org,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF NOT policy.enabled OR NOT(key=ANY(c.action_capabilities)) OR NOT(key=ANY(policy.action_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities k WHERE k.capability=key AND k.mode='action' AND k.enabled)
    THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
  FOREACH key IN ARRAY ARRAY['deposits.create','income_expenses.create','sale_phong.lock_room'] LOOP
    IF NOT(bid=ANY(app_private.hermes_sale_buildings_v1(c,key))) THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
  END LOOP;
  IF app_private.can_v3('income_expenses.approve',bid) AND NOT(bid=ANY(app_private.hermes_sale_buildings_v1(c,'income_expenses.approve')))
    THEN RAISE EXCEPTION 'hermes_sale_approval_overlay_required' USING ERRCODE='42501'; END IF;
  SELECT a.name INTO account_label FROM public.accounts a WHERE a.id=book AND a.organization_id=org AND a.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM app_private.authorize_tenant_action_v3(auth.uid(),org,'income_expenses.create',bid,book) perm WHERE perm.allowed);
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
  labels:=jsonb_build_object('room',room_label,'building',building_label,'account',account_label);
  base:=jsonb_build_object('organizationId',org,'requestId',req,'buildingId',bid,'roomId',rid);
  SELECT * INTO draft FROM app_private.hermes_zalo_deposit_intents WHERE connection_id=c.id AND request_id=req FOR UPDATE;
  at_time:=clock_timestamp();
  IF FOUND THEN
    IF draft.payload<>p_input OR draft.binding_id<>x.id OR draft.binding_epoch<>x.epoch OR draft.connection_epoch<>c.epoch
      THEN RAISE EXCEPTION 'hermes_sale_intent_changed' USING ERRCODE='PT409'; END IF;
    IF draft.result IS NOT NULL THEN RETURN draft.result; END IF;
    IF draft.superseded OR draft.expires_at<=at_time OR draft.preview<>labels THEN RAISE EXCEPTION 'zalo_deposit_expired' USING ERRCODE='PT409'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.room_next_claims n WHERE n.room_id=rid AND n.organization_id=org AND n.status='LIVE') THEN
    RAISE EXCEPTION 'zalo_deposit_held' USING ERRCODE='PT409';
  END IF;
  IF EXISTS(SELECT 1 FROM public.room_sale_locks l WHERE l.room_id=rid AND l.organization_id=org AND l.released_at IS NULL
    AND l.expires_at>at_time AND l.locked_by IS DISTINCT FROM auth.uid()) THEN RAISE EXCEPTION 'zalo_deposit_locked' USING ERRCODE='PT409'; END IF;
  IF EXISTS(SELECT 1 FROM app_private.hermes_zalo_deposit_payments p JOIN jsonb_array_elements(p_input->'payments') j
    ON p.reference=upper(btrim(j->>'reference')) WHERE p.organization_id=org AND p.account_id=book) THEN
    RAISE EXCEPTION 'zalo_deposit_duplicate' USING ERRCODE='PT409'; END IF;
  IF draft.request_id IS NULL THEN
    UPDATE app_private.hermes_zalo_deposit_intents SET superseded=true WHERE binding_id=x.id AND NOT superseded AND result IS NULL;
    confirm_code:=upper(left(replace(gen_random_uuid()::text,'-',''),12));
    IF EXISTS(SELECT 1 FROM unnest(ARRAY[room_label,building_label,account_label,p_input->>'payerName']) s
      WHERE s IS NULL OR length(s) NOT BETWEEN 1 AND 240 OR s ~ '[[:cntrl:]]' OR position(' · ' IN s)>0) THEN
      RAISE EXCEPTION 'hermes_sale_invalid_label' USING ERRCODE='22023';
    END IF;
    confirm_text:=format('Xác nhận cọc %s · %s đ · %s / %s · Người nộp %s · Sổ %s · Ngày %s',
      confirm_code,replace(to_char(total,'FM9,999,999,999,990'),',','.'),building_label,room_label,btrim(p_input->>'payerName'),account_label,to_char(day,'YYYY-MM-DD'));
    INSERT INTO app_private.hermes_zalo_deposit_intents(connection_id,request_id,binding_id,binding_epoch,connection_epoch,payload,preview,code,confirmation,expires_at)
      VALUES(c.id,req,x.id,x.epoch,c.epoch,p_input,labels,confirm_code,confirm_text,at_time+interval '10 minutes') RETURNING * INTO draft;
  END IF;
  IF draft.consent_message IS NULL THEN RETURN base||labels||jsonb_build_object('outcome','confirmation_required',
    'confirmation',draft.confirmation,'expiresAt',draft.expires_at); END IF;

  -- The web writer owns the live room claim, voucher, approval, posting and temporary lock conversion atomically.
  written:=public.create_deposit_income_v1(org,'hermes-zalo:'||req::text,jsonb_build_object('type','INCOME','name','Cọc giữ chỗ','room_id',rid,
    'payer_name',btrim(p_input->>'payerName'),'amount',total,'account_id',book,'voucher_date',day,
    'description',(SELECT string_agg(j->>'reference',', ' ORDER BY n) FROM jsonb_array_elements(p_input->'payments') WITH ORDINALITY t(j,n))),
    '[]'::jsonb,jsonb_build_object('channel','sale','expected_hold',NULL,'intended_move_in_on',move_in,'deposit_target',target));
  IF written->>'reservation_id' IS NULL OR written->>'id' IS NULL OR written->>'code' IS NULL THEN RAISE EXCEPTION 'hermes_sale_invalid_receipt'; END IF;
  INSERT INTO app_private.hermes_zalo_deposit_payments(organization_id,account_id,reference,connection_id,request_id)
    SELECT org,book,upper(btrim(j->>'reference')),c.id,req FROM jsonb_array_elements(p_input->'payments') j WHERE j->>'reference' IS NOT NULL;
  output:=base||jsonb_build_object('outcome','applied','voucherId',written->'id','voucherCode',written->'code',
    'reservationId',written->'reservation_id','approvalStatus',written->'approval_status');
  UPDATE app_private.hermes_zalo_deposit_intents SET result=output WHERE connection_id=c.id AND request_id=req;
  RETURN output;
END $fn$;

ALTER FUNCTION public.hermes_zalo_deposit_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_zalo_deposit_consent_v1(uuid,uuid,uuid,text,text,bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_zalo_deposit_v1(jsonb,jsonb),public.hermes_zalo_deposit_consent_v1(uuid,uuid,uuid,text,text,bigint,text)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_deposit_v1(jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_deposit_consent_v1(uuid,uuid,uuid,text,text,bigint,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
