BEGIN;

-- The shared queue sees only an opaque job. DM text, recipient and conversation
-- memory never enter the shared inbox, message preview or notification logs.
CREATE TABLE IF NOT EXISTS app_private.hermes_sale_questions (
  job_id uuid PRIMARY KEY REFERENCES public.zalo_send_queue(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  account_id uuid NOT NULL REFERENCES public.zalo_accounts(id),
  generation uuid NOT NULL,
  provider_id text NOT NULL,
  thread_type text NOT NULL CHECK (thread_type IN ('user','group')),
  thread_id text NOT NULL,
  sender_uid text NOT NULL,
  question text NOT NULL,
  memory jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,provider_id)
);
ALTER TABLE app_private.hermes_sale_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hermes_sale_questions FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS hermes_sale_question_context ON app_private.hermes_sale_questions
  (organization_id,account_id,thread_id,sender_uid,created_at DESC);
CREATE INDEX IF NOT EXISTS hermes_sale_question_expiry ON app_private.hermes_sale_questions(created_at);

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
      AND (p_type='user' OR (p_type='group' AND EXISTS (
        SELECT 1 FROM public.zalo_conversations c WHERE c.organization_id=p_org AND c.account_id=p_account
          AND c.thread_type='group' AND c.thread_id=p_thread AND c.is_sale_partner)))
  ) AND EXISTS (SELECT 1 FROM public.zalo_automations a WHERE a.organization_id=p_org
    AND a.kind='auto_reply' AND a.enabled AND a.config->'saleAdvisor'='true'::jsonb)
$$;
REVOKE ALL ON FUNCTION app_private.hermes_sale_channel_v1(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.zalo_sale_advice_intake_v1(p jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE
  org uuid:=(p->>'organizationId')::uuid; account uuid:=(p->>'accountId')::uuid;
  generation_id uuid:=(p->>'generation')::uuid; instance uuid:=(p->>'instanceId')::uuid;
  thread text:=p->>'threadId'; sender text:=p->>'senderUid'; typ text:=p->>'threadType';
  msg text:=p->>'messageId'; question text:=trim(p->>'question'); new_job uuid:=gen_random_uuid();
  cfg jsonb; now_at timestamptz:=clock_timestamp(); day_start timestamptz;
BEGIN
  IF NOT COALESCE(thread ~ '^[1-9][0-9]{0,39}$' AND sender ~ '^[1-9][0-9]{0,39}$'
    AND msg ~ '^[A-Za-z0-9_-]{1,128}$' AND length(question) BETWEEN 1 AND 1000
    AND to_timestamp((p->>'sentAt')::bigint/1000.0) BETWEEN now_at-interval '5 minutes' AND now_at+interval '30 seconds'
    AND (typ='group' OR (typ='user' AND thread=sender)),false)
    OR NOT app_private.hermes_sale_channel_v1(org,account,instance,generation_id,typ,thread) THEN RETURN 'inactive'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes_sale:'||org::text,0));
  SELECT config INTO cfg FROM public.zalo_automations WHERE organization_id=org AND kind='auto_reply' AND enabled FOR SHARE;
  IF cfg->'saleAdvisor' IS DISTINCT FROM 'true'::jsonb THEN RETURN 'inactive'; END IF;
  IF EXISTS(SELECT 1 FROM app_private.hermes_sale_questions WHERE account_id=account AND provider_id=msg) THEN RETURN 'duplicate'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(cfg->'blockedKeywords')='array'
    AND cfg->'blockedKeywords'<>'[]'::jsonb THEN cfg->'blockedKeywords'
    ELSE '["cọc","chuyển khoản","hợp đồng","thanh toán","hoá đơn","hóa đơn","khiếu nại","hoàn tiền"]'::jsonb END) w
    WHERE trim(w)<>'' AND strpos(lower(question),lower(trim(w)))>0) THEN RETURN 'blocked'; END IF;
  IF typ='group' AND p->>'followUp'='true' AND NOT EXISTS(SELECT 1 FROM app_private.hermes_sale_questions s
    WHERE s.organization_id=org AND s.account_id=account AND s.generation=generation_id AND s.thread_id=thread AND s.thread_type=typ
      AND s.sender_uid=sender AND s.created_at>now_at-interval '20 minutes') THEN RETURN 'unrelated'; END IF;
  day_start:=date_trunc('day',now_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF (SELECT count(*) FROM app_private.hermes_sale_questions WHERE organization_id=org AND created_at>=day_start)
    >=app_private.zalo_config_int_v1(cfg->'dailyCap',50,1000) THEN RETURN 'limited'; END IF;
  DELETE FROM app_private.hermes_sale_questions WHERE organization_id=org AND created_at<now_at-interval '2 days';
  INSERT INTO public.zalo_send_queue(id,user_id,organization_id,account_id,channel,payload,status)
    SELECT new_job,user_id,org,account,'personal','{"action":"hermes_sale_advice"}','queued'
    FROM public.zalo_accounts WHERE id=account AND organization_id=org;
  INSERT INTO app_private.hermes_sale_questions(job_id,organization_id,account_id,generation,provider_id,thread_type,thread_id,sender_uid,question)
    VALUES(new_job,org,account,generation_id,msg,typ,thread,sender,question);
  RETURN 'queued';
END $$;

-- Fetch only the exact public Sale page configured in the daily broadcast.
-- The token must belong to this org. Strip non-listable rooms and floor plans
-- before they leave the database. Recompute the page signature at send time.
CREATE OR REPLACE FUNCTION public.zalo_sale_advice_delivery_v1(p_job uuid,p_instance uuid,p_generation uuid,p_signature text DEFAULT NULL,p_memory jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE
  s app_private.hermes_sale_questions; link text; token_value text; page jsonb;
  signature text; previous jsonb; cfg jsonb; viewing_phone text;
BEGIN
  SELECT h.* INTO s FROM app_private.hermes_sale_questions h JOIN public.zalo_send_queue q ON q.id=h.job_id
    WHERE h.job_id=p_job AND h.generation=p_generation AND q.processing_instance_id=p_instance AND q.status='processing'
      AND h.organization_id=q.organization_id AND h.account_id=q.account_id AND h.created_at>clock_timestamp()-interval '5 minutes'
      AND q.payload='{"action":"hermes_sale_advice"}'::jsonb;
  IF NOT FOUND OR NOT app_private.hermes_sale_channel_v1(s.organization_id,s.account_id,p_instance,p_generation,s.thread_type,s.thread_id)
    THEN RAISE EXCEPTION 'sale_advice_inactive' USING ERRCODE='42501'; END IF;
  SELECT config INTO cfg FROM public.zalo_automations WHERE organization_id=s.organization_id AND kind='auto_reply';
  SELECT trim(config#>>'{template,shareUrl}') INTO link FROM public.zalo_automations
    WHERE organization_id=s.organization_id AND kind='broadcast_vacant';
  token_value:=substring(link FROM '^https://[A-Za-z0-9.-]+/r/([A-Za-z0-9_-]+)/?$');
  IF EXISTS (SELECT 1 FROM public.public_room_share_tokens t WHERE t.token=token_value AND t.organization_id=s.organization_id AND NOT t.revoked) THEN
    page:=public.get_public_available_rooms(token_value);
  END IF;
  -- The agreed iHome viewing number belongs only to that organization.
  -- Other organizations use the contact published on their own Sale page.
  viewing_phone:=CASE WHEN s.organization_id='aaaa0000-0000-4000-8000-000000000001'::uuid
    THEN '0923.889.880' ELSE NULLIF(trim(page#>>'{contact,phone}'),'') END;
  IF page IS NOT NULL THEN
    page:=jsonb_build_object('sale_policy',page->'sale_policy','areas',page->'areas',
      'buildings',(SELECT coalesce(jsonb_agg(b-'floor_layouts' ORDER BY b->>'id'),'[]') FROM jsonb_array_elements(page->'buildings') b),
      'rooms',(SELECT coalesce(jsonb_agg(r ORDER BY r->>'id'),'[]') FROM jsonb_array_elements(page->'rooms') r WHERE r->>'status_public' IN ('free','soon','pass')));
  ELSE link:=NULL; END IF;
  signature:=md5(jsonb_build_array(page,link,viewing_phone,cfg->'blockedKeywords')::text);
  IF p_signature IS NOT NULL THEN
    IF signature<>p_signature THEN RAISE EXCEPTION 'sale_advice_listing_changed' USING ERRCODE='PT409'; END IF;
    IF p_memory IS NOT NULL THEN
      IF jsonb_typeof(p_memory)<>'object' OR octet_length(p_memory::text)>12000 THEN RAISE EXCEPTION 'sale_advice_memory_invalid'; END IF;
      UPDATE app_private.hermes_sale_questions SET memory=p_memory WHERE job_id=p_job;
    END IF;
    RETURN jsonb_build_object('authorized',true,'threadId',s.thread_id,'threadType',s.thread_type);
  END IF;
  SELECT h.memory INTO previous FROM app_private.hermes_sale_questions h
    JOIN public.zalo_send_queue q ON q.id=h.job_id AND q.status='sent'
    WHERE h.organization_id=s.organization_id AND h.account_id=s.account_id AND h.generation=s.generation
      AND h.thread_id=s.thread_id AND h.thread_type=s.thread_type AND h.sender_uid=s.sender_uid AND h.memory IS NOT NULL
      AND h.created_at<s.created_at AND h.created_at>s.created_at-interval '20 minutes' ORDER BY h.created_at DESC LIMIT 1;
  RETURN jsonb_build_object('question',s.question,'previous',previous,'page',page,'link',link,
    'signature',signature,'viewingPhone',viewing_phone,'blockedKeywords',cfg->'blockedKeywords');
END $$;
REVOKE ALL ON FUNCTION public.zalo_sale_advice_intake_v1(jsonb),public.zalo_sale_advice_delivery_v1(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_sale_advice_intake_v1(jsonb),public.zalo_sale_advice_delivery_v1(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
