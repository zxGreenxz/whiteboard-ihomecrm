-- TEST project only. The runner prepends the pending migration and wraps both in
-- ONE ROLLBACK transaction. No provider, push, production write, or fixture output.
CREATE OR REPLACE FUNCTION pg_temp.zalo_assert(p_ok boolean,p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZALO_TEST_ASSERT: %',p_label; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.zalo_denied(p_sql text,p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN RETURN; END;
  RAISE EXCEPTION 'ZALO_TEST_EXPECTED_DENIAL: %',p_label;
END $$;

DO $fixtures$
DECLARE oa uuid:='aaaa0000-0000-4000-8000-000000000001'; ob uuid:='dddd0000-0000-4000-8000-000000000001';
  ua uuid; ub uuid; aa uuid; aa2 uuid; ab uuid; ca uuid; ca2 uuid; cb uuid; cua uuid; cub uuid; ma uuid; mb uuid;
  bid uuid; rid uuid; limited uuid:=gen_random_uuid(); mem uuid; scope uuid; override_id uuid; lead uuid; perm text;
  instance uuid:=gen_random_uuid(); old_instance uuid:=gen_random_uuid(); n int;
BEGIN
  SELECT m.user_id INTO ua FROM public.organization_memberships m WHERE m.organization_id=oa AND m.status='ACTIVE'
    AND app_private.ie_actor_is_company_owner_v1(oa,m.user_id)
    AND NOT EXISTS(SELECT 1 FROM public.organization_memberships x WHERE x.user_id=m.user_id AND x.organization_id=ob AND x.status='ACTIVE')
    ORDER BY m.user_id LIMIT 1;
  SELECT m.user_id INTO ub FROM public.organization_memberships m WHERE m.organization_id=ob AND m.status='ACTIVE' ORDER BY m.user_id LIMIT 1;
  PERFORM pg_temp.zalo_assert(ua IS NOT NULL AND ub IS NOT NULL,'need two isolated fixture actors');
  INSERT INTO public.zalo_accounts(user_id,organization_id,name,status,kind) VALUES(ua,oa,'zz Zalo SQL A','connected','personal') RETURNING id INTO aa;
  INSERT INTO public.zalo_accounts(user_id,organization_id,name,status,kind) VALUES(ua,oa,'zz Zalo SQL A2','connected','personal') RETURNING id INTO aa2;
  INSERT INTO public.zalo_accounts(user_id,organization_id,name,status,kind) VALUES(ub,ob,'zz Zalo SQL B','connected','personal') RETURNING id INTO ab;
  INSERT INTO public.customers(user_id,organization_id,full_name,phone) VALUES(ua,oa,'zz Zalo SQL A','0900000001') RETURNING id INTO cua;
  INSERT INTO public.customers(user_id,organization_id,full_name,phone) VALUES(ub,ob,'zz Zalo SQL B','0900000002') RETURNING id INTO cub;
  INSERT INTO public.zalo_conversations(user_id,organization_id,account_id,thread_id,peer_name,is_sale_partner,customer_id)
    VALUES(ua,oa,aa,'zz_sql_a','zz SQL A',true,cua) RETURNING id INTO ca;
  INSERT INTO public.zalo_conversations(user_id,organization_id,account_id,thread_id,peer_name,is_sale_partner)
    VALUES(ua,oa,aa,'zz_sql_a2','zz SQL A2',true) RETURNING id INTO ca2;
  INSERT INTO public.zalo_conversations(user_id,organization_id,account_id,thread_id,peer_name,is_sale_partner,customer_id)
    VALUES(ub,ob,ab,'zz_sql_b','zz SQL B',true,cub) RETURNING id INTO cb;
  INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,status,zalo_msg_id)
    VALUES(ua,oa,aa,ca,'in','text','còn phòng không','sent','zz_sql_source_1') RETURNING id INTO ma;
  INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,status,zalo_msg_id)
    VALUES(ub,ob,ab,cb,'in','text','còn phòng không','sent','zz_sql_source_b') RETURNING id INTO mb;
  INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,status,zalo_msg_id)
    VALUES(ua,oa,aa,ca,'in','text','còn phòng không','sent','zz_sql_source_2'),
      (ua,oa,aa,ca2,'in','text','còn phòng không','sent','zz_sql_source_3'),
      (ua,oa,aa,ca2,'in','text','phòng và chuyển khoản','sent','zz_sql_source_blocked');
  INSERT INTO storage.objects(bucket_id,name) VALUES('zalo-media',aa2::text||'/automation/zz-sql.jpg'),('zalo-media',ab::text||'/automation/zz-sql.jpg');
  SELECT b.id,r.id INTO bid,rid FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id
    WHERE b.organization_id=oa AND r.organization_id=oa AND b.deleted_at IS NULL AND r.deleted_at IS NULL ORDER BY r.id LIMIT 1;
  PERFORM pg_temp.zalo_assert(bid IS NOT NULL AND rid IS NOT NULL,'need existing room for building scope proof');
  INSERT INTO storage.buckets(id,name) VALUES('room-sale-images','room-sale-images') ON CONFLICT(id) DO NOTHING;
  INSERT INTO storage.objects(bucket_id,name) VALUES('room-sale-images',aa::text||'/zz-sale.jpg');
  UPDATE public.rooms SET images=COALESCE(images,'[]')||jsonb_build_array(aa::text||'/zz-sale.jpg') WHERE id=rid;
  -- A real JWT actor with chat only, deliberately no buildings.view scope.
  INSERT INTO auth.users(id,email,aud,role) VALUES(limited,limited::text||'@zalo-sql.invalid','authenticated','authenticated');
  INSERT INTO public.organization_memberships(organization_id,user_id,member_type,status) VALUES(oa,limited,'STAFF','ACTIVE') RETURNING id INTO mem;
  INSERT INTO public.authorization_scopes(organization_id,scope_type) VALUES(oa,'ORGANIZATION') ON CONFLICT DO NOTHING;
  SELECT id INTO scope FROM public.authorization_scopes WHERE organization_id=oa AND scope_type='ORGANIZATION';
  FOREACH perm IN ARRAY ARRAY['chat_zalo.view','chat_zalo.send','leads.view'] LOOP
    INSERT INTO public.member_permission_overrides(organization_id,membership_id,permission_key,effect,scope_mode,reason)
      VALUES(oa,mem,perm,'ALLOW','ORGANIZATION','zz Zalo rollback proof') RETURNING id INTO override_id;
    INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES(oa,override_id,scope);
  END LOOP;
  INSERT INTO public.leads(user_id,organization_id,customer_name,phone,building_id) VALUES(ua,oa,'zz Zalo scope lead','0900000003',bid) RETURNING id INTO lead;
  UPDATE public.zalo_conversations SET room_id=rid WHERE id=ca;
  INSERT INTO public.zalo_worker_lease(id,instance_id,heartbeat_at,claimed_at) VALUES('singleton',instance,clock_timestamp(),clock_timestamp())
    ON CONFLICT(id) DO UPDATE SET instance_id=EXCLUDED.instance_id,heartbeat_at=EXCLUDED.heartbeat_at;
  -- Quotas include all today's existing attempts, so fixture needs no data erasure.
  SELECT count(*) INTO n FROM public.zalo_automation_runs WHERE organization_id=oa AND kind='auto_reply' AND mode='reply'
    AND created_at>=(date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh');
  PERFORM pg_temp.zalo_assert(n<999,'auto quota fixture headroom');
  INSERT INTO public.zalo_automations(user_id,organization_id,kind,enabled,config) VALUES(ua,oa,'auto_reply',true,
    jsonb_build_object('keywords',jsonb_build_array('phòng'),'blockedKeywords',jsonb_build_array('chuyển khoản'),'dailyCap',n+1,'cooldownMinutes',30))
    ON CONFLICT(organization_id,kind) DO UPDATE SET enabled=true,config=EXCLUDED.config;
  SELECT count(*) INTO n FROM public.zalo_send_queue WHERE organization_id=oa AND payload ? 'tu_dong' AND NOT COALESCE(payload->>'auto_reply'='true',false)
    AND created_at>=(date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh');
  PERFORM pg_temp.zalo_assert(n<1990,'broadcast quota fixture headroom');
  INSERT INTO public.zalo_automations(user_id,organization_id,kind,enabled,config) VALUES(ua,oa,'broadcast_vacant',true,
    jsonb_build_object('recipients',jsonb_build_array(ca,ca2),'antiSpam',jsonb_build_object('dailyCap',n+8,'allowedHours',jsonb_build_object('from','00:00','to','23:59'))))
    ON CONFLICT(organization_id,kind) DO UPDATE SET enabled=true,config=EXCLUDED.config;
  PERFORM set_config('zalo_test.ua',ua::text,true); PERFORM set_config('zalo_test.ub',ub::text,true);
  PERFORM set_config('zalo_test.aa',aa::text,true); PERFORM set_config('zalo_test.aa2',aa2::text,true); PERFORM set_config('zalo_test.ab',ab::text,true);
  PERFORM set_config('zalo_test.ca',ca::text,true); PERFORM set_config('zalo_test.ca2',ca2::text,true); PERFORM set_config('zalo_test.cb',cb::text,true);
  PERFORM set_config('zalo_test.cua',cua::text,true); PERFORM set_config('zalo_test.cub',cub::text,true);
  PERFORM set_config('zalo_test.ma',ma::text,true); PERFORM set_config('zalo_test.mb',mb::text,true);
  PERFORM set_config('zalo_test.bid',bid::text,true); PERFORM set_config('zalo_test.rid',rid::text,true);
  PERFORM set_config('zalo_test.limited',limited::text,true); PERFORM set_config('zalo_test.lead',lead::text,true);
  PERFORM set_config('zalo_test.instance',instance::text,true); PERFORM set_config('zalo_test.old_instance',old_instance::text,true);
END $fixtures$;

DO $config_bounds$
BEGIN
  PERFORM pg_temp.zalo_assert(app_private.zalo_config_int_v1(NULL,50,1000)=50,'missing config uses default');
  PERFORM pg_temp.zalo_assert(app_private.zalo_config_int_v1('null',50,1000)=1,'explicit null clamps like Number(null)');
  PERFORM pg_temp.zalo_assert(app_private.zalo_config_int_v1('" "',50,1000)=1,'empty numeric input clamps to min');
  PERFORM pg_temp.zalo_assert(app_private.zalo_config_int_v1('-5',50,1000)=1,'daily cap min is one');
  PERFORM pg_temp.zalo_assert(app_private.zalo_config_int_v1('999999999999',50,1000)=1000,'large cap clamps before integer cast');
  PERFORM pg_temp.zalo_assert(app_private.zalo_config_int_v1('999999999999',30,1440)=1440,'cooldown max is 1440');
  PERFORM pg_temp.zalo_assert(app_private.zalo_config_int_v1('2.5',30,1440)=3,'fraction rounds like worker');
END $config_bounds$;

-- Real authenticated role + a real account's JWT subject. No postgres bypass.
SET LOCAL ROLE authenticated;
DO $authenticated$
DECLARE ca uuid:=current_setting('zalo_test.ca')::uuid; cb uuid:=current_setting('zalo_test.cb')::uuid;
  ua uuid:=current_setting('zalo_test.ua')::uuid; r jsonb; m public.zalo_messages;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',ua::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',ua,'role','authenticated')::text,true);
  PERFORM pg_temp.zalo_assert(public.zalo_can('send','aaaa0000-0000-4000-8000-000000000001'),'fixture actor can send');
  PERFORM pg_temp.zalo_assert((SELECT count(*)=1 FROM public.zalo_conversations WHERE id=ca),'own-org read allowed');
  PERFORM pg_temp.zalo_assert((SELECT count(*)=0 FROM public.zalo_conversations WHERE id=cb),'cross-org read denied');
  r:=public.zalo_get_crm_summary(ca);
  PERFORM pg_temp.zalo_assert(r#>>'{customer,id}'=current_setting('zalo_test.cua'),'own CRM read allowed');
  PERFORM pg_temp.zalo_assert(public.zalo_get_crm_summary(cb) IS NULL,'cross-org CRM denied');
  PERFORM pg_temp.zalo_denied(format('UPDATE public.zalo_conversations SET customer_id=%L WHERE id=%L',current_setting('zalo_test.cub'),ca),'browser cannot forge CRM reference');
  PERFORM pg_temp.zalo_denied(format('UPDATE public.zalo_conversations SET is_sale_partner=false WHERE id=%L',ca),'browser cannot bypass automation permission');
  PERFORM pg_temp.zalo_denied('INSERT INTO public.zalo_send_queue(payload) VALUES(''{}'')','browser cannot insert queue');
  PERFORM pg_temp.zalo_denied('TRUNCATE public.zalo_messages','browser cannot truncate messages');
  PERFORM pg_temp.zalo_denied(format('SELECT public.zalo_enqueue_auto_reply_v1(%L,''test'',''zz_sql_source_1'')',ca),'worker RPC denied to browser');
  PERFORM pg_temp.zalo_denied(format('SELECT public.zalo_worker_finalize_send_v1(%L,%L,''[]'')',gen_random_uuid(),gen_random_uuid()),'finalize receipt RPC denied to browser');
  PERFORM pg_temp.zalo_denied(format('SELECT public.zalo_link_conversation(%L,%L)',ca,current_setting('zalo_test.cub')),'link RPC rejects cross-org');
  m:=public.zalo_send_message(p_conversation_id=>ca,p_body=>'zz approved RPC send');
  PERFORM pg_temp.zalo_assert(m.id IS NOT NULL AND m.status='pending','approved send RPC still works after revoke');
  PERFORM public.zalo_set_conversation_flags(ca,true,false,false);
  PERFORM pg_temp.zalo_assert((SELECT is_pinned FROM public.zalo_conversations WHERE id=ca),'flags RPC still works');
END $authenticated$;
DO $building_scope$
DECLARE r jsonb; actor uuid:=current_setting('zalo_test.limited')::uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  PERFORM pg_temp.zalo_assert(public.zalo_can('view','aaaa0000-0000-4000-8000-000000000001'),'limited actor can view chat');
  PERFORM pg_temp.zalo_assert(NOT public.can_access_building(current_setting('zalo_test.bid')::uuid),'limited actor cannot access building');
  r:=public.zalo_get_crm_summary(current_setting('zalo_test.ca')::uuid);
  PERFORM pg_temp.zalo_assert((SELECT count(*)=1 FROM public.zalo_conversations WHERE id=current_setting('zalo_test.ca')::uuid),'limited actor can see this conversation');
  PERFORM pg_temp.zalo_assert(r->'room' IS NULL,'CRM summary hides same-org room outside building scope');
  PERFORM pg_temp.zalo_denied(format('SELECT public.zalo_link_conversation(%L,NULL,%L)',current_setting('zalo_test.ca'),current_setting('zalo_test.lead')),'CRM link checks building scope for same-org lead');
END $building_scope$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true);

SET LOCAL ROLE service_role;
DO $service_scope$
DECLARE ca uuid:=current_setting('zalo_test.ca')::uuid; aa uuid:=current_setting('zalo_test.aa')::uuid;
  oa uuid:='aaaa0000-0000-4000-8000-000000000001';
BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM pg_temp.zalo_denied(format('UPDATE public.zalo_conversations SET customer_id=%L WHERE id=%L',current_setting('zalo_test.cub'),ca),'service writes still reject CRM cross-org');
  PERFORM pg_temp.zalo_denied(format('UPDATE public.zalo_conversations SET account_id=%L WHERE id=%L',current_setting('zalo_test.ab'),ca),'service writes reject account cross-org');
  PERFORM pg_temp.zalo_assert(public.zalo_worker_attachment_allowed_v1(oa,aa,'zalo-media',current_setting('zalo_test.aa2')||'/automation/zz-sql.jpg'),'generated image shared inside org');
  PERFORM pg_temp.zalo_assert(NOT public.zalo_worker_attachment_allowed_v1(oa,aa,'zalo-media',current_setting('zalo_test.ab')||'/automation/zz-sql.jpg'),'foreign account media denied');
  PERFORM pg_temp.zalo_assert(public.zalo_worker_attachment_allowed_v1(oa,aa,'room-sale-images',aa::text||'/zz-sale.jpg'),'own room sale image allowed');
  PERFORM pg_temp.zalo_assert(NOT public.zalo_worker_attachment_allowed_v1('dddd0000-0000-4000-8000-000000000001',current_setting('zalo_test.ab')::uuid,'room-sale-images',aa::text||'/zz-sale.jpg'),'foreign room sale image denied');
  PERFORM pg_temp.zalo_assert(NOT public.zalo_worker_attachment_allowed_v1(oa,aa,'customer-images',aa::text||'/zz-sale.jpg'),'private customer bucket denied');
  PERFORM pg_temp.zalo_denied(format('INSERT INTO public.zalo_send_queue(user_id,organization_id,account_id,conversation_id,payload) VALUES(%L,%L,%L,%L,%L)',
    current_setting('zalo_test.ua'),oa,aa,ca,jsonb_build_object('message_ids',jsonb_build_array(current_setting('zalo_test.mb')))::text),'foreign message_ids denied');
  PERFORM pg_temp.zalo_denied(format('INSERT INTO public.zalo_send_queue(user_id,organization_id,account_id,conversation_id,payload) VALUES(%L,%L,%L,%L,%L)',
    current_setting('zalo_test.ua'),oa,aa,ca,jsonb_build_object('attachments',jsonb_build_array(jsonb_build_object('bucket','zalo-media','path',current_setting('zalo_test.ab')||'/automation/zz-sql.jpg')))::text),'foreign attachment denied in queue trigger');
END $service_scope$;

DO $atomic$
DECLARE ca uuid:=current_setting('zalo_test.ca')::uuid; ca2 uuid:=current_setting('zalo_test.ca2')::uuid;
  r jsonb; again jsonb; inst uuid:=current_setting('zalo_test.instance')::uuid; old_inst uuid:=current_setting('zalo_test.old_instance')::uuid;
  j uuid; j2 uuid; j3 uuid;
BEGIN
  r:=public.zalo_enqueue_auto_reply_v1(ca,'zz atomic reply','zz_sql_source_1');
  PERFORM pg_temp.zalo_assert(r->>'status'='queued','auto reply reservation allowed');
  again:=public.zalo_enqueue_auto_reply_v1(ca,'zz atomic reply retry','zz_sql_source_1');
  PERFORM pg_temp.zalo_assert((again->>'reused')::boolean AND again->>'job_id'=r->>'job_id','same source deduplicates');
  again:=public.zalo_enqueue_auto_reply_v1(ca,'zz cooldown','zz_sql_source_2');
  PERFORM pg_temp.zalo_assert(again->>'status'='skipped' AND again->>'reason' LIKE '%chống lặp%','cooldown is checked in DB');
  again:=public.zalo_enqueue_auto_reply_v1(ca2,'zz quota','zz_sql_source_3');
  PERFORM pg_temp.zalo_assert(again->>'status'='skipped' AND again->>'reason' LIKE '%trần%','org quota reserved atomically');
  again:=public.zalo_enqueue_auto_reply_v1(ca2,'zz blocked','zz_sql_source_blocked');
  PERFORM pg_temp.zalo_assert(again->>'status'='skipped' AND again->>'reason' LIKE '%người thật%','blocked keyword rechecked from source');
  UPDATE public.zalo_automations SET config=jsonb_set(config,'{blockedKeywords}','[]') WHERE organization_id='aaaa0000-0000-4000-8000-000000000001' AND kind='auto_reply';
  again:=public.zalo_enqueue_auto_reply_v1(ca2,'zz blocked empty','zz_sql_source_blocked');
  PERFORM pg_temp.zalo_assert(again->>'status'='skipped' AND again->>'reason' LIKE '%người thật%','empty blocked list restores money-contract defaults');
  UPDATE public.zalo_automations SET config=jsonb_set(config,'{blockedKeywords}','["  ",null,""]') WHERE organization_id='aaaa0000-0000-4000-8000-000000000001' AND kind='auto_reply';
  again:=public.zalo_enqueue_auto_reply_v1(ca2,'zz blocked blank','zz_sql_source_blocked');
  PERFORM pg_temp.zalo_assert(again->>'status'='skipped' AND again->>'reason' LIKE '%người thật%','blank blocked list restores money-contract defaults');
  PERFORM pg_temp.zalo_assert((SELECT count(*)=1 FROM public.zalo_messages WHERE id=(r->>'message_id')::uuid AND status='pending'),'atomic reply message exists');
  PERFORM pg_temp.zalo_assert((SELECT count(*)=1 FROM public.zalo_send_queue WHERE id=(r->>'job_id')::uuid),'atomic reply queue exists');
  PERFORM pg_temp.zalo_assert((SELECT count(*)=1 FROM public.zalo_automation_runs WHERE id=(r->>'run_id')::uuid),'atomic reply log exists');
  -- The eight-second auto-reply delay may legitimately cross local midnight.
  UPDATE public.zalo_send_queue SET created_at=clock_timestamp()-interval '1 day',not_before=clock_timestamp()-interval '1 second' WHERE id=(r->>'job_id')::uuid;
  PERFORM public.zalo_worker_claim_job_v1((r->>'job_id')::uuid,inst);
  PERFORM pg_temp.zalo_assert(public.zalo_worker_begin_provider_v1((r->>'job_id')::uuid,inst),'auto reply may cross midnight with actual-day cap');
  UPDATE public.zalo_conversations SET is_sale_partner=false WHERE id=ca;
  r:=public.zalo_enqueue_broadcast_v1(ca,'zz broadcast',clock_timestamp(),'zz-broadcast-1'); j:=(r->>'job_id')::uuid;
  PERFORM pg_temp.zalo_assert(r->>'status'='queued','explicit broadcast recipient needs no sale flag');
  again:=public.zalo_enqueue_broadcast_v1(ca,'zz retry same request',clock_timestamp(),'zz-broadcast-1');
  PERFORM pg_temp.zalo_assert((again->>'reused')::boolean AND again->>'job_id'=r->>'job_id','broadcast timeout idempotency');
  again:=public.zalo_enqueue_broadcast_v1(ca,'zz tomorrow',clock_timestamp()+interval '1 day','zz-broadcast-future');
  PERFORM pg_temp.zalo_assert(again->>'status'='skipped','broadcast cannot schedule stale next-day room info');
  r:=public.zalo_worker_claim_job_v1(j,old_inst);
  PERFORM pg_temp.zalo_assert(NOT (r->>'ok')::boolean,'stale instance cannot claim');
  r:=public.zalo_worker_claim_job_v1(j,inst);
  PERFORM pg_temp.zalo_assert((r->>'ok')::boolean,'lease owner claims');
  r:=public.zalo_worker_claim_job_v1(j,inst);
  PERFORM pg_temp.zalo_assert(NOT (r->>'ok')::boolean,'second claim cannot race');
  PERFORM pg_temp.zalo_assert(public.zalo_worker_begin_provider_v1(j,inst),'provider boundary starts under lease');
  r:=public.zalo_enqueue_broadcast_v1(ca,'zz pre-provider',clock_timestamp(),'zz-broadcast-2'); j2:=(r->>'job_id')::uuid;
  PERFORM public.zalo_worker_claim_job_v1(j2,inst);
  UPDATE public.zalo_worker_lease SET instance_id=old_inst,heartbeat_at=clock_timestamp() WHERE id='singleton';
  PERFORM pg_temp.zalo_assert(NOT public.zalo_worker_begin_provider_v1(j2,inst),'old instance is fenced before provider');
  r:=public.zalo_worker_recover_jobs_v1(old_inst);
  PERFORM pg_temp.zalo_assert((SELECT status='failed' AND result->>'outcome'='unknown' FROM public.zalo_send_queue WHERE id=j),'after-provider crash stays unknown, never requeued');
  PERFORM pg_temp.zalo_assert((SELECT status='queued' AND processing_instance_id IS NULL FROM public.zalo_send_queue WHERE id=j2),'before-provider crash safely requeued');
  PERFORM pg_temp.zalo_assert((SELECT status='failed' FROM public.zalo_messages WHERE id=(SELECT message_id FROM public.zalo_send_queue WHERE id=j)),'unknown message no longer hangs pending');
  PERFORM set_config('zalo_test.stop_job',j2::text,true);
  UPDATE public.zalo_worker_lease SET instance_id=inst,heartbeat_at=clock_timestamp() WHERE id='singleton';
END $atomic$;
DO $echo_receipt$
DECLARE ca uuid:=current_setting('zalo_test.ca')::uuid; aa uuid:=current_setting('zalo_test.aa')::uuid;
  inst uuid:=current_setting('zalo_test.instance')::uuid; ua uuid:=current_setting('zalo_test.ua')::uuid;
  r jsonb; receipts jsonb; j uuid; m uuid; echo uuid; echo_job uuid; n int;
BEGIN
  r:=public.zalo_enqueue_broadcast_v1(ca,'zz echo first',clock_timestamp(),'zz-echo-broadcast'); j:=(r->>'job_id')::uuid; m:=(r->>'message_id')::uuid;
  PERFORM pg_temp.zalo_assert(r->>'status'='queued','echo regression enqueue');
  PERFORM public.zalo_worker_claim_job_v1(j,inst);
  PERFORM pg_temp.zalo_assert(public.zalo_worker_begin_provider_v1(j,inst),'echo regression provider starts');
  UPDATE public.zalo_messages SET media_url='https://self.invalid/permanent.jpg',media_meta='{"storage":"canonical"}' WHERE id=m;
  INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,status,zalo_msg_id,zalo_raw,media_url,media_meta,reactions)
    VALUES(ua,'aaaa0000-0000-4000-8000-000000000001',aa,ca,'out','text','zz echo first','seen','zz_provider_echo','{"msgId":"zz_provider_echo"}',
      'https://provider.invalid/expiring.jpg','{"width":800}','{"heart":1}') RETURNING id INTO echo;
  INSERT INTO public.zalo_send_queue(user_id,organization_id,account_id,conversation_id,message_id,channel,payload,status)
    VALUES(ua,'aaaa0000-0000-4000-8000-000000000001',aa,ca,echo,'personal',jsonb_build_object('message_ids',jsonb_build_array(echo)),'sent') RETURNING id INTO echo_job;
  receipts:=jsonb_build_array(jsonb_build_object('message_id',m,'zalo_msg_id','zz_provider_echo','cli_msg_id','zz_cli_echo'));
  BEGIN
    PERFORM public.zalo_worker_finalize_send_v1(j,inst,jsonb_build_array(jsonb_build_object('message_id',m,'zalo_msg_id','  ')));
    RAISE EXCEPTION 'ZALO_TEST_ASSERT: missing provider receipt was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM pg_temp.zalo_assert((SELECT status='processing' FROM public.zalo_send_queue WHERE id=j),'missing provider ID cannot mark queue sent');
  PERFORM pg_temp.zalo_denied(format('SELECT public.zalo_worker_finalize_send_v1(%L,%L,%L::jsonb)',j,inst,
    jsonb_build_array(jsonb_build_object('message_id',current_setting('zalo_test.mb'),'zalo_msg_id','forged'))),'finalize rejects message outside exact job set');
  r:=public.zalo_worker_finalize_send_v1(j,inst,receipts);
  PERFORM pg_temp.zalo_assert((r->>'ok')::boolean,'echo merge finalize allowed');
  PERFORM pg_temp.zalo_assert((SELECT status='seen' AND client_dedup_key='automation:broadcast:zz-echo-broadcast'
    AND media_url='https://self.invalid/permanent.jpg' AND media_meta->>'width'='800' AND reactions->>'heart'='1' AND zalo_msg_id='zz_provider_echo'
    FROM public.zalo_messages WHERE id=m),'canonical id/key/media and seen metadata survive echo');
  PERFORM pg_temp.zalo_assert(NOT EXISTS(SELECT 1 FROM public.zalo_messages WHERE id=echo),'duplicate echo merged once');
  PERFORM pg_temp.zalo_assert((SELECT message_id=m AND payload->'message_ids' ? m::text FROM public.zalo_send_queue WHERE id=echo_job),'echo queue refs moved before delete cascade');
  PERFORM pg_temp.zalo_assert((SELECT message_id=m AND status='sent' AND result->>'outcome'='sent' FROM public.zalo_send_queue WHERE id=j),'original queue receipt survives and completes atomically');
  r:=public.zalo_worker_finalize_send_v1(j,inst,receipts);
  PERFORM pg_temp.zalo_assert((r->>'ok')::boolean AND (r->>'reused')::boolean,'finalize retry is idempotent');
  r:=public.zalo_enqueue_broadcast_v1(ca,'zz echo first retry',clock_timestamp(),'zz-echo-broadcast');
  PERFORM pg_temp.zalo_assert((r->>'reused')::boolean AND (r->>'job_id')::uuid=j AND (r->>'message_id')::uuid=m,'echo-first request retry retains original single job');
  SELECT count(*) INTO n FROM public.zalo_send_queue WHERE organization_id='aaaa0000-0000-4000-8000-000000000001'
    AND payload ? 'tu_dong' AND NOT COALESCE(payload->>'auto_reply'='true',false)
    AND created_at>=(date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh');
  UPDATE public.zalo_automations SET config=jsonb_set(config,'{antiSpam,dailyCap}',to_jsonb(n)) WHERE organization_id='aaaa0000-0000-4000-8000-000000000001' AND kind='broadcast_vacant';
  r:=public.zalo_enqueue_broadcast_v1(ca,'zz cap after echo',clock_timestamp(),'zz-cap-after-echo');
  PERFORM pg_temp.zalo_assert(r->>'status'='skipped' AND r->>'reason' LIKE '%trần%','echo merge keeps daily quota receipt');
  UPDATE public.zalo_automations SET config=jsonb_set(config,'{antiSpam,dailyCap}',to_jsonb(n+3)) WHERE organization_id='aaaa0000-0000-4000-8000-000000000001' AND kind='broadcast_vacant';
END $echo_receipt$;
RESET ROLE;

-- Failure injected between message and queue insert must roll back the message.
CREATE OR REPLACE FUNCTION pg_temp.zalo_queue_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.payload->>'body'='zz_zalo_force_rollback' THEN RAISE EXCEPTION 'fixture queue fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER zzzz_zalo_fixture_queue_fault BEFORE INSERT ON public.zalo_send_queue FOR EACH ROW EXECUTE FUNCTION pg_temp.zalo_queue_fault();
SET LOCAL ROLE service_role;
DO $rollback$
BEGIN
  BEGIN
    PERFORM public.zalo_enqueue_broadcast_v1(current_setting('zalo_test.ca')::uuid,'zz_zalo_force_rollback',clock_timestamp(),'zz-rollback');
    RAISE EXCEPTION 'ZALO_TEST_ASSERT: injected fault was not reached';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM pg_temp.zalo_assert((SELECT count(*)=0 FROM public.zalo_messages WHERE body='zz_zalo_force_rollback'),'queue fault rolls message back');
END $rollback$;
RESET ROLE;
DROP TRIGGER zzzz_zalo_fixture_queue_fault ON public.zalo_send_queue;

SET LOCAL ROLE authenticated;
DO $stop$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',current_setting('zalo_test.ua'),true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('zalo_test.ua'),'role','authenticated')::text,true);
  r:=public.zalo_dung_khan_cap('aaaa0000-0000-4000-8000-000000000001');
  PERFORM pg_temp.zalo_assert((r->>'da_huy')::int>=1,'stop cancels queued automated jobs');
  PERFORM pg_temp.zalo_assert((SELECT status='failed' AND result->>'outcome'='cancelled' FROM public.zalo_send_queue WHERE id=current_setting('zalo_test.stop_job')::uuid),'stop keeps cancellation receipt instead of deleting quota evidence');
END $stop$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $after_stop$
DECLARE r jsonb;
BEGIN
  r:=public.zalo_enqueue_broadcast_v1(current_setting('zalo_test.ca')::uuid,'zz after stop',clock_timestamp(),'zz-after-stop');
  PERFORM pg_temp.zalo_assert(r->>'status'='skipped','cannot enqueue after stop');
END $after_stop$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ZALO_SQL_PASS: role/JWT scope, RPC-only writes, attachment ownership, atomic reservation/rollback, quota, source/request dedup, lease fencing, recovery, emergency stop'; END $$;
