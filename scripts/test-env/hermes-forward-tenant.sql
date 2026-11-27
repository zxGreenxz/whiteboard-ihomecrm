-- Run against the isolated TEST database with test-env:thu-sql (rollback).
DO $demo$
DECLARE
 today date := (statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
 org constant uuid := 'dddd0000-0000-4000-8000-000000000001';
 actor uuid; assistant uuid; sid uuid:=gen_random_uuid(); conn uuid:=gen_random_uuid();
 za uuid:=gen_random_uuid(); chat uuid:=gen_random_uuid(); cu uuid:=gen_random_uuid();
 bid uuid; rid uuid:=gen_random_uuid(); second_room uuid:=gen_random_uuid(); lease1 uuid:=gen_random_uuid(); lease2 uuid:=gen_random_uuid();
 args jsonb; binding jsonb; mem jsonb; c app_private.hermes_connections; pol app_private.hermes_org_policies;
 draft jsonb; written jsonb; retry jsonb; opts jsonb; request_key uuid:=gen_random_uuid();
 marker text:='1730000001111'; original text:='79000000000000001'; ref text; digest text:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 task_content text:='Máy lạnh phòng DEMO đang rò nước';
BEGIN
 IF to_regclass('test_env.danh_dau') IS NULL OR NOT EXISTS(SELECT FROM public.organizations WHERE id=org AND is_demo) THEN RAISE EXCEPTION 'TEST DEMO only'; END IF;
 SELECT id INTO STRICT actor FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local';
 SELECT id INTO STRICT bid FROM public.buildings WHERE organization_id=org AND deleted_at IS NULL AND name='DEMO Toà A';
 INSERT INTO app_private.hermes_assistants(organization_id,user_id) VALUES(org,actor) ON CONFLICT(organization_id,user_id) DO NOTHING;
 SELECT id INTO STRICT assistant FROM app_private.hermes_assistants WHERE organization_id=org AND user_id=actor AND state='ACTIVE';
 INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at) VALUES(sid,assistant,org,actor,sid,'ACTIVE','{}',now()+interval '1 hour');
 INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id,permission_mode,scope_mode)
  VALUES(conn,assistant,org,actor,'ACTIVE',sid,digest,now()+interval '1 hour',gen_random_uuid(),'inherit_crm','unrestricted') RETURNING * INTO c;
 INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES(digest,conn,now()+interval '1 hour');
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','session_id',sid)::text,true);
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 SELECT * INTO c FROM app_private.hermes_connections WHERE id=conn;
 mem:=app_private.hermes_member_v1(actor,org); pol:=app_private.hermes_effective_org_policy_v1(org,c.read_capabilities,c.action_capabilities,c.scope_ids);
 binding:=jsonb_build_object('connectionId',conn,'tokenDigest',digest,'expectedEpoch',c.epoch,'expectedPolicyVersion',pol.version,'expectedMembershipId',mem->>'membershipId','expectedAuthorizationVersion',(mem->>'authorizationVersion')::bigint,'expectedSessionRevision',1);
 ref:=marker||'.'||encode(sha256(convert_to(original,'UTF8')),'hex');
 INSERT INTO public.zalo_accounts(id,user_id,organization_id,kind,name,zalo_uid,status) VALUES(za,actor,org,'personal','DEMO forward','111222','connected');
 INSERT INTO public.zalo_conversations(id,user_id,organization_id,account_id,thread_type,thread_id,peer_name,peer_zalo_uid) VALUES(chat,actor,org,za,'user','222333','DEMO forward','222333');
 INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,zalo_msg_id,zalo_raw)
 VALUES(actor,org,za,chat,'in','text',task_content,original,jsonb_build_object('ts',marker));
 SET LOCAL ROLE authenticated;
 opts:=public.hermes_zalo_forward_tenant_v1(binding,ref);
 IF opts#>>'{summary,match}' IS DISTINCT FROM 'ask_customer' THEN RAISE EXCEPTION 'unlinked chat must ask customer'; END IF;
 RESET ROLE;
 INSERT INTO public.customers(id,organization_id,user_id,full_name,phone) VALUES(cu,org,actor,'Khách QA forward','00000009139');
 UPDATE public.zalo_conversations SET customer_id=cu WHERE id=chat;
 SET LOCAL ROLE authenticated;
 IF public.hermes_zalo_forward_tenant_v1(binding,ref)#>>'{summary,match}' IS DISTINCT FROM 'ask_room' THEN RAISE EXCEPTION 'linked customer without lease must ask room'; END IF;
 RESET ROLE;
 INSERT INTO public.rooms(id,building_id,organization_id,name,rent_price,deposit_amount,status)
 VALUES(rid,bid,org,'Hermes QA A',1000,1000,'AVAILABLE'),(second_room,bid,org,'Hermes QA B',1000,1000,'AVAILABLE');
 INSERT INTO public.contracts(id,organization_id,user_id,room_id,contract_number,status,signed_date,start_date,end_date,rent_price)
 VALUES(lease1,org,actor,rid,'QA-FW-A','ACTIVE',today,today-10,today+20,1000),
 (lease2,org,actor,second_room,'QA-FW-B','ACTIVE',today,today+1,today+30,1000);
 INSERT INTO public.contract_customers(contract_id,customer_id,organization_id,is_representative)
 VALUES(lease1,cu,org,true),(lease2,cu,org,true);
 SET LOCAL ROLE authenticated;
 opts:=public.hermes_zalo_forward_tenant_v1(binding,ref);
 IF opts#>>'{summary,match}' IS DISTINCT FROM 'matched' OR opts#>>'{items,0,roomId}' IS DISTINCT FROM rid::text THEN RAISE EXCEPTION 'exact source/current room'; END IF;
 IF public.hermes_zalo_forward_tenant_v1(binding,replace(ref,marker,'1730000001112'))#>>'{summary,match}' IS DISTINCT FROM 'ask_customer' THEN RAISE EXCEPTION 'same id different timestamp'; END IF;
 RESET ROLE;
 INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,zalo_msg_id,zalo_raw)
 VALUES(actor,org,za,chat,'out','text','Đã ghi nhận yêu cầu DEMO','79000000000000003',jsonb_build_object('ts',marker));
 SET LOCAL ROLE authenticated;
 IF public.hermes_zalo_forward_tenant_v1(binding,marker||'.'||encode(sha256(convert_to('79000000000000003','UTF8')),'hex'))#>>'{items,0,roomId}' IS DISTINCT FROM rid::text THEN RAISE EXCEPTION 'outbound source must resolve its linked customer'; END IF;
 RESET ROLE;
 INSERT INTO public.job_types(organization_id,user_id,name,is_active) VALUES(org,actor,'Sửa chữa QA forward',true);
 args:=jsonb_build_object('buildingName',opts#>>'{items,0,buildingName}','roomName',opts#>>'{items,0,roomName}',
   'jobType','Sửa chữa QA forward','content',task_content,'assigneeName','tôi');
 SET LOCAL ROLE authenticated;
 draft:=public.hermes_task_action_v1(binding,'task.create','auto',request_key,args,NULL,NULL);
 IF draft->>'kind' IS DISTINCT FROM 'preview' THEN RAISE EXCEPTION 'expected task preview, got %',draft->>'kind'; END IF;
 written:=public.hermes_task_action_v1(binding,'task.create','apply',request_key,args,draft->'resolved',draft->>'basis');
 retry:=public.hermes_task_action_v1(binding,'task.create','apply',request_key,args,draft->'resolved',draft->>'basis');
 RESET ROLE;
 IF written->>'kind' IS DISTINCT FROM 'applied' OR retry->>'kind' IS DISTINCT FROM 'applied' OR
   (SELECT count(*) FROM public.jobs WHERE room_id=rid AND assignee_id=actor AND code IS NOT NULL)<>1 THEN RAISE EXCEPTION 'one job, correct room/assignee'; END IF;
 UPDATE public.contracts SET start_date=today-4, commission_change_reason='Điều chỉnh ngày trong fixture DEMO' WHERE id=lease2;
 SET LOCAL ROLE authenticated;
 opts:=public.hermes_zalo_forward_tenant_v1(binding,ref);
 IF opts#>>'{summary,match}' IS DISTINCT FROM 'choose_room' OR jsonb_array_length(opts->'items')<>2 THEN RAISE EXCEPTION 'two rooms must require selection'; END IF;
 BEGIN
   PERFORM public.hermes_zalo_forward_tenant_v1(binding||jsonb_build_object('connectionId',gen_random_uuid()),ref);
   RAISE EXCEPTION 'foreign binding accepted';
 EXCEPTION WHEN SQLSTATE 'PT409' OR insufficient_privilege THEN NULL; END;
 RESET ROLE;
 -- The same client message ID and timestamp in a different, unlinked chat are ambiguous.
 INSERT INTO public.zalo_conversations(id,user_id,organization_id,account_id,thread_type,thread_id,peer_name)
 VALUES(sid,actor,org,za,'user','222334','DEMO other chat');
 INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,zalo_msg_id,cli_msg_id,zalo_raw)
 VALUES(actor,org,za,sid,'in','text',task_content,'79000000000000002',original,jsonb_build_object('ts',marker));
 SET LOCAL ROLE authenticated;
 IF public.hermes_zalo_forward_tenant_v1(binding,ref)#>>'{summary,match}' IS DISTINCT FROM 'ask_customer' THEN RAISE EXCEPTION 'ambiguous original must ask customer'; END IF;
 RESET ROLE;
 INSERT INTO public.customers(id,organization_id,user_id,full_name,phone) VALUES(za,org,actor,'Khách DEMO B','00000009140');
 UPDATE public.zalo_conversations SET customer_id=za WHERE id=sid;
 UPDATE public.zalo_messages SET hidden_at=now() WHERE conversation_id=sid;
 SET LOCAL ROLE authenticated;
 IF public.hermes_zalo_forward_tenant_v1(binding,ref)#>>'{summary,match}' IS DISTINCT FROM 'ask_customer' THEN RAISE EXCEPTION 'hidden conflicting chat must prevent a match'; END IF;
 RESET ROLE;
 UPDATE public.zalo_messages SET hidden_at=now() WHERE account_id=za AND (zalo_msg_id=original OR cli_msg_id=original);
 SET LOCAL ROLE authenticated;
 IF public.hermes_zalo_forward_tenant_v1(binding,ref)#>>'{summary,match}' IS DISTINCT FROM 'ask_customer' THEN RAISE EXCEPTION 'hidden message must not identify customer'; END IF;
 RESET ROLE;
 UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='contracts.view';
 SET LOCAL ROLE authenticated;
 BEGIN
   PERFORM public.hermes_zalo_forward_tenant_v1(binding,ref);
   RAISE EXCEPTION 'missing contracts grant accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 RESET ROLE;
 RAISE NOTICE 'TEST DEMO: unlinked/hidden/foreign references, one/current/future/multiple rooms, one canonical task after retry';
END $demo$;
