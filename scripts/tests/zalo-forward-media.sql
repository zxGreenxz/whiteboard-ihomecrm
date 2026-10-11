-- TEST-only synthetic Zalo rows, real authenticated/service roles and JWTs.
-- The runner overlays migrations and wraps the complete proof in ROLLBACK.
CREATE OR REPLACE FUNCTION pg_temp.forward_assert(p_ok boolean,p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FORWARD_ASSERT: %',p_label; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.forward_denied(p_sql text,p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value THEN RETURN; END;
  RAISE EXCEPTION 'FORWARD_EXPECTED_DENIAL: %',p_label;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.fid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT current_setting('forward_test.'||p_key)::uuid $$;

DO $fixtures$
DECLARE oa uuid:='aaaa0000-0000-4000-8000-000000000001'; ob uuid:='dddd0000-0000-4000-8000-000000000001';
  ua uuid; ub uuid; aa uuid:=gen_random_uuid(); aa2 uuid:=gen_random_uuid(); offa uuid:=gen_random_uuid(); ab uuid:=gen_random_uuid();
  src uuid:=gen_random_uuid(); dst uuid:=gen_random_uuid(); dst2 uuid:=gen_random_uuid(); dst3 uuid:=gen_random_uuid(); offc uuid:=gen_random_uuid(); foreignc uuid:=gen_random_uuid();
  img uuid:=gen_random_uuid(); img2 uuid:=gen_random_uuid(); vid uuid:=gen_random_uuid(); voice uuid:=gen_random_uuid(); fileid uuid:=gen_random_uuid();
  caption_a uuid:=gen_random_uuid(); caption_b uuid:=gen_random_uuid(); caption_repeat uuid:=gen_random_uuid();
  hidden uuid:=gen_random_uuid(); pending uuid:=gen_random_uuid(); recalled uuid:=gen_random_uuid(); foreignm uuid:=gen_random_uuid(); instance uuid:=gen_random_uuid(); k text; val uuid;
BEGIN
  SELECT m.user_id INTO ua FROM public.organization_memberships m WHERE m.organization_id=oa AND m.status='ACTIVE'
    AND app_private.ie_actor_is_company_owner_v1(oa,m.user_id)
    AND NOT EXISTS(SELECT 1 FROM public.organization_memberships x WHERE x.user_id=m.user_id AND x.organization_id=ob AND x.status='ACTIVE') ORDER BY m.user_id LIMIT 1;
  SELECT user_id INTO ub FROM public.organization_memberships WHERE organization_id=ob AND status='ACTIVE' ORDER BY user_id LIMIT 1;
  PERFORM pg_temp.forward_assert(ua IS NOT NULL AND ub IS NOT NULL,'two isolated actors available');
  INSERT INTO public.zalo_accounts(id,user_id,organization_id,name,status,kind) VALUES
    (aa,ua,oa,'zz Forward source','connected','personal'),(aa2,ua,oa,'zz Forward destination','connected','personal'),
    (offa,ua,oa,'zz Forward offline','disconnected','personal'),(ab,ub,ob,'zz Forward other org','connected','personal');
  INSERT INTO public.zalo_conversations(id,user_id,organization_id,account_id,thread_id,thread_type,peer_name) VALUES
    (src,ua,oa,aa,'zz_forward_src','user','zz Source'),(dst,ua,oa,aa,'zz_forward_dst','user','zz Destination'),
    (dst2,ua,oa,aa2,'zz_forward_dst2','group','zz Group other account'),(dst3,ua,oa,aa2,'zz_forward_dst3','group','zz Atomic recipient'),
    (offc,ua,oa,offa,'zz_forward_off','user','zz Offline'),(foreignc,ub,ob,ab,'zz_forward_other','group','zz Foreign');
  INSERT INTO public.zalo_messages(id,user_id,organization_id,account_id,conversation_id,direction,msg_type,body,media_url,media_label,media_meta,status,hidden_at) VALUES
    (img,ua,oa,aa,src,'in','image','Nội dung album','https://example.invalid/image.jpg',NULL,NULL,'sent',NULL),
    (img2,ua,oa,aa,src,'in','image','[Hình ảnh]','https://example.invalid/image2.jpg',NULL,NULL,'seen',NULL),
    (caption_a,ua,oa,aa,src,'in','image','  Góc cửa sổ  ','https://example.invalid/caption-a.jpg',NULL,NULL,'sent',NULL),
    (caption_b,ua,oa,aa,src,'in','image','Khu bếp','https://example.invalid/caption-b.jpg',NULL,NULL,'sent',NULL),
    (caption_repeat,ua,oa,aa,src,'in','image','Góc cửa sổ','https://example.invalid/caption-repeat.jpg',NULL,NULL,'sent',NULL),
    (vid,ua,oa,aa,src,'in','video','[Video]','https://example.invalid/video.mp4',NULL,'{"thumb":"https://example.invalid/thumb.jpg"}','delivered',NULL),
    (voice,ua,oa,aa,src,'in','voice','[Tin nhắn thoại]','https://example.invalid/voice.mp3',NULL,NULL,'sent',NULL),
    (fileid,ua,oa,aa,src,'in','file','Gửi bạn tài liệu','https://example.invalid/file.pdf','file.pdf','{"filename":"file.pdf"}','sent',NULL),
    (hidden,ua,oa,aa,src,'in','image','[Hình ảnh]','https://example.invalid/hidden.jpg',NULL,NULL,'sent',clock_timestamp()),
    (pending,ua,oa,aa,src,'out','image','[Hình ảnh]','https://example.invalid/pending.jpg',NULL,NULL,'pending',NULL),
    (recalled,ua,oa,aa,src,'in','sys','Tin đã thu hồi','https://example.invalid/recalled.jpg',NULL,NULL,'sent',NULL),
    (foreignm,ub,ob,ab,foreignc,'in','image','[Hình ảnh]','https://example.invalid/foreign.jpg',NULL,NULL,'sent',NULL);
  INSERT INTO public.zalo_worker_lease(id,instance_id,heartbeat_at,claimed_at) VALUES('singleton',instance,clock_timestamp(),clock_timestamp())
    ON CONFLICT(id) DO UPDATE SET instance_id=EXCLUDED.instance_id,heartbeat_at=EXCLUDED.heartbeat_at;
  FOR k,val IN SELECT * FROM (VALUES('ua',ua),('ub',ub),('aa',aa),('ab',ab),('src',src),('dst',dst),('dst2',dst2),('dst3',dst3),('offc',offc),('foreignc',foreignc),
    ('img',img),('img2',img2),('caption_a',caption_a),('caption_b',caption_b),('caption_repeat',caption_repeat),('vid',vid),('voice',voice),('file',fileid),('hidden',hidden),('pending',pending),('recalled',recalled),('foreignm',foreignm),('instance',instance)) f(k,v) LOOP
    PERFORM set_config('forward_test.'||k,val::text,true);
  END LOOP;
END $fixtures$;

SET LOCAL ROLE authenticated;
DO $accept_and_dedup$
DECLARE req uuid:=gen_random_uuid(); r jsonb; retry jsonb; receipt jsonb; target uuid; source uuid; kind text; before_count int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',pg_temp.fid('ua')::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.fid('ua'),'role','authenticated')::text,true);
  PERFORM pg_temp.forward_assert(public.zalo_can('send','aaaa0000-0000-4000-8000-000000000001'),'actor can send own org');
  r:=public.zalo_forward_media_v1(ARRAY[pg_temp.fid('img'),pg_temp.fid('img2')],ARRAY[pg_temp.fid('dst'),pg_temp.fid('dst2'),pg_temp.fid('offc'),pg_temp.fid('foreignc')],req);
  PERFORM pg_temp.forward_assert((SELECT count(*)=2 FROM jsonb_array_elements(r->'recipients') WHERE value->>'status'='queued'),'same-org personal and cross-account group queued');
  PERFORM pg_temp.forward_assert((SELECT count(*)=2 FROM jsonb_array_elements(r->'recipients') WHERE value->>'status'='rejected' AND length(value->>'error')>0),'foreign and disconnected targets have individual errors');
  FOR receipt IN SELECT value FROM jsonb_array_elements(r->'recipients') WHERE value->>'status'='queued' LOOP
    PERFORM pg_temp.forward_assert(jsonb_array_length(receipt->'message_ids')=3 AND receipt->>'caption_message_id'=receipt#>>'{message_ids,2}' AND receipt->>'reused'='false','album retains two image rows plus last caption row');
    PERFORM pg_temp.forward_assert((SELECT q.payload->'source_message_ids'=to_jsonb(ARRAY[pg_temp.fid('img'),pg_temp.fid('img2')]) AND q.payload->>'kind'='forward_media' AND q.payload->>'caption'='Nội dung album' FROM public.zalo_send_queue q WHERE q.id=(receipt->>'job_id')::uuid),'source order and album caption snapshot retained');
    PERFORM pg_temp.forward_assert((SELECT count(*)=2 FROM public.zalo_messages m WHERE receipt->'message_ids' ? m.id::text AND m.msg_type='image' AND m.direction='out' AND m.body='[Hình ảnh]'),'media caption not duplicated on canonical images');
  END LOOP;
  retry:=public.zalo_forward_media_v1(ARRAY[pg_temp.fid('img'),pg_temp.fid('img2')],ARRAY[pg_temp.fid('foreignc'),pg_temp.fid('offc'),pg_temp.fid('dst2'),pg_temp.fid('dst')],req);
  PERFORM pg_temp.forward_assert((SELECT count(*)=2 FROM jsonb_array_elements(retry->'recipients') x WHERE x.value->>'reused'='true'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(r->'recipients') y WHERE y.value->>'job_id'=x.value->>'job_id' AND y.value->'message_ids'=x.value->'message_ids')),'exact target set retries reuse both receipts regardless target order');
  SELECT count(*) INTO before_count FROM public.zalo_send_queue WHERE account_id IN (pg_temp.fid('aa'),(SELECT account_id FROM public.zalo_conversations WHERE id=pg_temp.fid('dst2')));
  retry:=public.zalo_forward_media_v1(ARRAY[pg_temp.fid('img'),pg_temp.fid('img2')],ARRAY[pg_temp.fid('dst'),pg_temp.fid('dst2'),pg_temp.fid('dst3')],req);
  PERFORM pg_temp.forward_assert((SELECT count(*)=3 FROM jsonb_array_elements(retry->'recipients') WHERE value->>'status'='rejected') AND
    (SELECT count(*)=before_count FROM public.zalo_send_queue WHERE account_id IN (pg_temp.fid('aa'),(SELECT account_id FROM public.zalo_conversations WHERE id=pg_temp.fid('dst2')))),'changed target set does not append new jobs');
  retry:=public.zalo_forward_media_v1(ARRAY[pg_temp.fid('img2'),pg_temp.fid('img')],ARRAY[pg_temp.fid('dst'),pg_temp.fid('dst2'),pg_temp.fid('offc'),pg_temp.fid('foreignc')],req);
  PERFORM pg_temp.forward_assert((SELECT bool_and(value->>'status'='rejected') FROM jsonb_array_elements(retry->'recipients')),'source order collision rejected');
  FOR kind,source IN SELECT * FROM (VALUES('video',pg_temp.fid('vid')),('voice',pg_temp.fid('voice')),('file',pg_temp.fid('file'))) f(k,s) LOOP
    receipt:=public.zalo_forward_media_v1(ARRAY[source],ARRAY[pg_temp.fid('dst2')],gen_random_uuid())#>'{recipients,0}';
    PERFORM pg_temp.forward_assert(receipt->>'status'='queued' AND (SELECT msg_type=kind FROM public.zalo_messages WHERE id=(receipt#>>'{message_ids,0}')::uuid),'video voice file preserve original type');
    PERFORM pg_temp.forward_assert(jsonb_array_length(receipt->'message_ids')=CASE WHEN kind='file' THEN 2 ELSE 1 END,'file meaningful caption has separate receipt');
  END LOOP;
  PERFORM set_config('forward_test.request',req::text,true); PERFORM set_config('forward_test.original',r::text,true);
  PERFORM pg_temp.forward_denied(format('SELECT public.zalo_forward_media_v1(ARRAY[%L]::uuid[],ARRAY[%L]::uuid[],gen_random_uuid())',pg_temp.fid('foreignm'),pg_temp.fid('dst')),'actor cannot forward other org source');
  FOREACH source IN ARRAY ARRAY[pg_temp.fid('hidden'),pg_temp.fid('pending'),pg_temp.fid('recalled')] LOOP
    PERFORM pg_temp.forward_denied(format('SELECT public.zalo_forward_media_v1(ARRAY[%L]::uuid[],ARRAY[%L]::uuid[],gen_random_uuid())',source,pg_temp.fid('dst')),'hidden pending recalled source rejected');
  END LOOP;
  PERFORM pg_temp.forward_denied(format('SELECT public.zalo_forward_media_v1(ARRAY[%L,%L]::uuid[],ARRAY[%L]::uuid[],gen_random_uuid())',pg_temp.fid('img'),pg_temp.fid('vid'),pg_temp.fid('dst')),'mixed source types rejected');
  PERFORM pg_temp.forward_denied(format('SELECT public.zalo_forward_media_v1(ARRAY[%L,%L]::uuid[],ARRAY[%L]::uuid[],gen_random_uuid())',pg_temp.fid('img'),pg_temp.fid('img'),pg_temp.fid('dst')),'duplicate source IDs rejected');
  PERFORM pg_temp.forward_denied('INSERT INTO public.zalo_send_queue(payload) VALUES(''{}'')','browser cannot bypass RPC');
  PERFORM set_config('request.jwt.claim.sub',pg_temp.fid('ub')::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.fid('ub'),'role','authenticated')::text,true);
  PERFORM pg_temp.forward_denied(format('SELECT public.zalo_forward_media_v1(ARRAY[%L]::uuid[],ARRAY[%L]::uuid[],gen_random_uuid())',pg_temp.fid('img'),pg_temp.fid('dst')),'unauthorized JWT cannot forward source');
END $accept_and_dedup$;
RESET ROLE;

-- Queue insertion failure after canonical messages were inserted must erase
-- exactly that recipient's partial writes, while the other recipient succeeds.
CREATE OR REPLACE FUNCTION pg_temp.forward_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.conversation_id=pg_temp.fid('dst3') THEN RAISE EXCEPTION 'injected queue failure' USING ERRCODE='55000'; END IF; RETURN NEW; END $$;
CREATE TRIGGER zzz_forward_test_failure BEFORE INSERT ON public.zalo_send_queue FOR EACH ROW EXECUTE FUNCTION pg_temp.forward_inject_failure();
SET LOCAL ROLE authenticated;
DO $atomic$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',pg_temp.fid('ua')::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.fid('ua'),'role','authenticated')::text,true);
  r:=public.zalo_forward_media_v1(ARRAY[pg_temp.fid('img2')],ARRAY[pg_temp.fid('dst'),pg_temp.fid('dst3')],gen_random_uuid());
  PERFORM pg_temp.forward_assert((SELECT count(*)=1 FROM jsonb_array_elements(r->'recipients') WHERE value->>'status'='queued'),'independent recipient survives another queue failure');
  PERFORM pg_temp.forward_assert((SELECT count(*)=0 FROM public.zalo_messages WHERE conversation_id=pg_temp.fid('dst3')) AND
    (SELECT count(*)=0 FROM public.zalo_send_queue WHERE conversation_id=pg_temp.fid('dst3')),'recipient failure leaves no orphan pending messages or job');
END $atomic$;
RESET ROLE;
DROP TRIGGER zzz_forward_test_failure ON public.zalo_send_queue;

SET LOCAL ROLE service_role;
DO $service_guard$
DECLARE q public.zalo_send_queue; jid uuid; rec jsonb; receipts jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','',true); PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  SELECT * INTO q FROM public.zalo_send_queue WHERE conversation_id=pg_temp.fid('dst') AND payload ? 'caption_message_id' ORDER BY created_at,id LIMIT 1;
  PERFORM pg_temp.forward_denied(format('UPDATE public.zalo_send_queue SET payload=jsonb_set(payload,''{source_message_ids}'',%L::jsonb)-''caption_message_id''-''caption'' WHERE id=%L',jsonb_build_array(pg_temp.fid('foreignm'),pg_temp.fid('foreignm'))::text,q.id),'duplicate foreign source rejected');
  -- One source and one destination gives the org mutation no other shape guard
  -- to hide behind; a weakened org predicate must fail this exact assertion.
  SELECT * INTO q FROM public.zalo_send_queue WHERE conversation_id=pg_temp.fid('dst') AND NOT payload ? 'caption_message_id' ORDER BY created_at,id LIMIT 1;
  PERFORM pg_temp.forward_denied(format('UPDATE public.zalo_send_queue SET payload=jsonb_set(payload,''{source_message_ids}'',%L::jsonb) WHERE id=%L',jsonb_build_array(pg_temp.fid('foreignm'))::text,q.id),'service queue rejects foreign source');
  SELECT id INTO jid FROM public.zalo_send_queue WHERE conversation_id=pg_temp.fid('dst2') AND payload ? 'caption_message_id' AND jsonb_array_length(payload->'source_message_ids')=2 LIMIT 1;
  PERFORM pg_temp.forward_assert((public.zalo_worker_claim_job_v1(jid,pg_temp.fid('instance'))->>'ok')::boolean,'forward uses existing claim lease');
  PERFORM pg_temp.forward_assert(public.zalo_worker_begin_provider_v1(jid,pg_temp.fid('instance')),'eligible forward begins provider');
  SELECT jsonb_agg(jsonb_build_object('message_id',value,'zalo_msg_id','zz-forward-receipt-'||value,'cli_msg_id',NULL) ORDER BY ord) INTO receipts
    FROM public.zalo_send_queue x,jsonb_array_elements_text(x.payload->'message_ids') WITH ORDINALITY a(value,ord) WHERE x.id=jid;
  PERFORM pg_temp.forward_assert(public.zalo_worker_finalize_send_v1(jid,pg_temp.fid('instance'),receipts)->>'status'='sent','album images and caption finalize atomically');
  UPDATE public.zalo_messages SET hidden_at=clock_timestamp() WHERE id=pg_temp.fid('img');
  SELECT id INTO jid FROM public.zalo_send_queue WHERE conversation_id=pg_temp.fid('dst') AND payload ? 'caption_message_id' LIMIT 1;
  PERFORM pg_temp.forward_assert((public.zalo_worker_claim_job_v1(jid,pg_temp.fid('instance'))->>'ok')::boolean,'source hidden after enqueue does not erase receipt');
  PERFORM pg_temp.forward_denied(format('SELECT public.zalo_worker_begin_provider_v1(%L,%L)',jid,pg_temp.fid('instance')),'provider boundary rechecks hidden source');
  PERFORM pg_temp.forward_assert((SELECT provider_started_at IS NULL FROM public.zalo_send_queue WHERE id=jid),'denied boundary has no provider timestamp');
END $service_guard$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $hidden_replay$
DECLARE r jsonb; original jsonb:=current_setting('forward_test.original')::jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',pg_temp.fid('ua')::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.fid('ua'),'role','authenticated')::text,true);
  r:=public.zalo_forward_media_v1(ARRAY[pg_temp.fid('img'),pg_temp.fid('img2')],ARRAY[pg_temp.fid('dst'),pg_temp.fid('dst2'),pg_temp.fid('offc'),pg_temp.fid('foreignc')],pg_temp.fid('request'));
  PERFORM pg_temp.forward_assert((SELECT count(*)=2 FROM jsonb_array_elements(r->'recipients') x WHERE x.value->>'reused'='true' AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(original->'recipients') y WHERE x.value->>'job_id'=y.value->>'job_id' AND x.value->'message_ids'=y.value->'message_ids')),'receipt replay survives hidden source and sent job');
END $hidden_replay$;
DO $distinct_captions$
DECLARE r jsonb; q public.zalo_send_queue; ids uuid[];
BEGIN
  r:=public.zalo_forward_media_v1(ARRAY[pg_temp.fid('caption_a'),pg_temp.fid('caption_b')],ARRAY[pg_temp.fid('dst2')],gen_random_uuid())#>'{recipients,0}';
  SELECT * INTO q FROM public.zalo_send_queue WHERE id=(r->>'job_id')::uuid;
  PERFORM pg_temp.forward_assert(r->>'status'='queued' AND jsonb_array_length(r->'message_ids')=3
    AND q.payload->>'caption'=E'Góc cửa sổ\nKhu bếp'
    AND (SELECT body=E'Góc cửa sổ\nKhu bếp' FROM public.zalo_messages WHERE id=(r->>'caption_message_id')::uuid),
    'all distinct image captions survive in source order');
  r:=public.zalo_forward_media_v1(ARRAY[pg_temp.fid('caption_a'),pg_temp.fid('caption_b'),pg_temp.fid('caption_repeat')],ARRAY[pg_temp.fid('dst2')],gen_random_uuid())#>'{recipients,0}';
  SELECT * INTO q FROM public.zalo_send_queue WHERE id=(r->>'job_id')::uuid;
  PERFORM pg_temp.forward_assert(jsonb_array_length(r->'message_ids')=4 AND q.payload->>'caption'=E'Góc cửa sổ\nKhu bếp'
    AND (SELECT count(*)=1 FROM public.zalo_messages m WHERE q.payload->'message_ids' ? m.id::text AND m.msg_type='text'),
    'only exact trimmed repeated captions are deduplicated into one text receipt');
  r:=public.zalo_forward_media_v1(ARRAY[pg_temp.fid('caption_b'),pg_temp.fid('caption_a')],ARRAY[pg_temp.fid('dst2')],gen_random_uuid())#>'{recipients,0}';
  PERFORM pg_temp.forward_assert((SELECT payload->>'caption'=E'Khu bếp\nGóc cửa sổ' FROM public.zalo_send_queue WHERE id=(r->>'job_id')::uuid),
    'caption order follows requested image order');
END $distinct_captions$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'FORWARD_SQL_PASS: role/JWT scope, all media kinds, album/file captions, partial atomicity, request collisions, hidden replay, worker boundary and receipts'; END $$;
