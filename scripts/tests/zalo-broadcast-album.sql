-- Appended to the existing security harness, inside the same TEST-only ROLLBACK.
DO $setup$
DECLARE aa uuid:=current_setting('zalo_test.aa')::uuid; i int;
BEGIN
  FOR i IN 1..8 LOOP
    INSERT INTO storage.objects(bucket_id,name) VALUES('zalo-media',aa::text||'/automation/zz-album-'||i||'.jpg');
  END LOOP;
  UPDATE public.zalo_automations SET enabled=true,
    config=jsonb_set(config,'{antiSpam,dailyCap}','2000')
    WHERE organization_id='aaaa0000-0000-4000-8000-000000000001' AND kind='broadcast_vacant';
END $setup$;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM pg_temp.zalo_denied(format('SELECT public.zalo_enqueue_broadcast_v1(%L,%L,clock_timestamp(),%L,%L::jsonb)',
    current_setting('zalo_test.ca'),'','zz-album-denied','[]'),'authenticated cannot invoke service broadcast');
END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $album$
DECLARE ca uuid:=current_setting('zalo_test.ca')::uuid; aa uuid:=current_setting('zalo_test.aa')::uuid;
  ab uuid:=current_setting('zalo_test.ab')::uuid; inst uuid:=current_setting('zalo_test.instance')::uuid;
  photos jsonb; bad jsonb; r jsonb; repeat jsonb; j public.zalo_send_queue; ids jsonb; receipts jsonb;
  n int; i int; malformed jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('bucket','zalo-media','path',aa::text||'/automation/zz-album-'||x.n||'.jpg',
    'url','https://storage.invalid/'||x.n||'.jpg','filename',x.n||'.jpg','width',640,'height',480) ORDER BY x.n)
    INTO photos FROM generate_series(1,8) x(n);
  r:=public.zalo_enqueue_broadcast_v1(ca,'',clock_timestamp(),'zz-album-eight',photos);
  PERFORM pg_temp.zalo_assert(r->>'status'='queued','album queued');
  SELECT * INTO j FROM public.zalo_send_queue WHERE id=(r->>'job_id')::uuid;
  ids:=j.payload->'message_ids';
  PERFORM pg_temp.zalo_assert(jsonb_array_length(ids)=8,'album keeps all eight canonical photos');
  PERFORM pg_temp.zalo_assert(j.payload->'attachments'=photos,'one queue job contains the full album in order');
  PERFORM pg_temp.zalo_assert((SELECT count(*)=1 FROM public.zalo_send_queue WHERE payload->>'automation_request_key'='zz-album-eight'),'one album is one queue job');
  FOR i IN 0..7 LOOP
    PERFORM pg_temp.zalo_assert((SELECT media_url=photos->i->>'url' AND msg_type='image'
      AND media_meta->>'album_index'=i::text AND media_meta->>'album_count'='8'
      FROM public.zalo_messages WHERE id=(ids->>i)::uuid),'each canonical photo retains its own source and album index');
  END LOOP;
  repeat:=public.zalo_enqueue_broadcast_v1(ca,'',clock_timestamp(),'zz-album-eight',jsonb_build_array(photos->7));
  PERFORM pg_temp.zalo_assert(repeat->>'job_id'=r->>'job_id' AND (repeat->>'reused')::boolean,'retry retains the original complete album');
  PERFORM pg_temp.zalo_assert((SELECT payload->'attachments'=photos FROM public.zalo_send_queue WHERE id=j.id),'retry does not mutate an existing album');
  -- A foreign photo in a later position must reject the complete transaction.
  bad:=jsonb_build_array(photos->0,jsonb_build_object('bucket','zalo-media','path',ab::text||'/automation/zz-sql.jpg'));
  PERFORM pg_temp.zalo_denied(format('SELECT public.zalo_enqueue_broadcast_v1(%L,%L,clock_timestamp(),%L,%L::jsonb)',ca,'','zz-album-foreign',bad),
    'later album photo from another organization');
  PERFORM pg_temp.zalo_assert(NOT EXISTS(SELECT 1 FROM public.zalo_messages WHERE client_dedup_key LIKE 'automation:broadcast:zz-album-foreign%'),'foreign album creates no orphan photo');
  FOREACH malformed IN ARRAY ARRAY['[]'::jsonb,'null'::jsonb,'true'::jsonb,photos||photos] LOOP
    BEGIN
      PERFORM public.zalo_enqueue_broadcast_v1(ca,'',clock_timestamp(),'zz-album-malformed',malformed);
      RAISE EXCEPTION 'ZALO_TEST_ASSERT: malformed album accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;
  BEGIN
    PERFORM public.zalo_enqueue_broadcast_v1(ca,'untracked caption',clock_timestamp(),'zz-album-caption',photos);
    RAISE EXCEPTION 'ZALO_TEST_ASSERT: album caption accepted without its own canonical row';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- Real existing claim/finalize path requires one receipt for each image.
  UPDATE public.zalo_worker_lease SET instance_id=inst,heartbeat_at=clock_timestamp() WHERE id='singleton';
  PERFORM public.zalo_worker_claim_job_v1(j.id,inst);
  PERFORM pg_temp.zalo_assert(public.zalo_worker_begin_provider_v1(j.id,inst),'album provider fence');
  SELECT jsonb_agg(jsonb_build_object('message_id',id,'zalo_msg_id','zz-album-provider-'||ordinality,'cli_msg_id','zz-album-client-'||ordinality) ORDER BY ordinality)
    INTO receipts FROM jsonb_array_elements_text(ids) WITH ORDINALITY x(id,ordinality);
  r:=public.zalo_worker_finalize_send_v1(j.id,inst,receipts);
  PERFORM pg_temp.zalo_assert((r->>'ok')::boolean,'all album receipts finalized');
  PERFORM pg_temp.zalo_assert((SELECT count(*)=8 FROM public.zalo_messages WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(ids)) AND status='sent' AND zalo_msg_id IS NOT NULL),'all eight provider receipts persisted');
  SELECT count(*) INTO n FROM public.zalo_send_queue WHERE organization_id=j.organization_id AND payload ? 'tu_dong'
    AND NOT COALESCE(payload->>'auto_reply'='true',false)
    AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  UPDATE public.zalo_automations SET config=jsonb_set(config,'{antiSpam,dailyCap}',to_jsonb(n)) WHERE organization_id=j.organization_id AND kind='broadcast_vacant';
  r:=public.zalo_enqueue_broadcast_v1(ca,'',clock_timestamp(),'zz-album-over-cap',photos);
  PERFORM pg_temp.zalo_assert(r->>'status'='skipped','album still respects daily quota');
END $album$;
RESET ROLE;
-- Failure after N photo rows are inserted must roll them all back.
CREATE OR REPLACE FUNCTION pg_temp.zalo_album_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.payload->>'automation_request_key'='zz-album-rollback' THEN RAISE EXCEPTION 'fixture album fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER zzzz_zalo_album_fixture_fault BEFORE INSERT ON public.zalo_send_queue FOR EACH ROW EXECUTE FUNCTION pg_temp.zalo_album_fault();
UPDATE public.zalo_automations SET config=jsonb_set(config,'{antiSpam,dailyCap}','2000') WHERE organization_id='aaaa0000-0000-4000-8000-000000000001' AND kind='broadcast_vacant';
SET LOCAL ROLE service_role;
DO $$
DECLARE photos jsonb;
BEGIN
  SELECT payload->'attachments' INTO photos FROM public.zalo_send_queue WHERE payload->>'automation_request_key'='zz-album-eight';
  BEGIN
    PERFORM public.zalo_enqueue_broadcast_v1(current_setting('zalo_test.ca')::uuid,'',clock_timestamp(),'zz-album-rollback',photos);
    RAISE EXCEPTION 'ZALO_TEST_ASSERT: album fault not reached';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM pg_temp.zalo_assert(NOT EXISTS(SELECT 1 FROM public.zalo_messages WHERE client_dedup_key LIKE 'automation:broadcast:zz-album-rollback%'),'queue failure rolls back every album photo');
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ALBUM_SQL_PASS: one complete album job, ordered canonical photos, all provider receipts, retry dedup, quota, ACL/org isolation, atomic rollback'; END $$;
