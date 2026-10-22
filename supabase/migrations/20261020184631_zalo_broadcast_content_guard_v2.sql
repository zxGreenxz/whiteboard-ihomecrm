-- Queue metadata belongs to the same transaction as the canonical enqueue.
-- Keep requestKey identity stable across retries: never replace already queued
-- content or attach a new snapshot to an old image/body.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE OR REPLACE FUNCTION app_private.zalo_attach_broadcast_content_guard_v1(p_result jsonb,p_guard jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE q public.zalo_send_queue;
BEGIN
 IF jsonb_typeof(p_guard) IS DISTINCT FROM 'object' OR p_guard->'version' IS DISTINCT FROM '1'::jsonb
  OR jsonb_typeof(p_guard->'fingerprint') IS DISTINCT FROM 'string' OR (p_guard->>'fingerprint') !~ '^[a-f0-9]{64}$'
  OR p_guard-ARRAY['version','fingerprint']<>'{}'::jsonb
  THEN RAISE EXCEPTION 'Thiếu phiên bản nội dung sale đã dựng' USING ERRCODE='22023';END IF;
 IF p_result->>'status' IS DISTINCT FROM 'queued' THEN RETURN p_result;END IF;
 SELECT * INTO q FROM public.zalo_send_queue WHERE id=(p_result->>'job_id')::uuid FOR UPDATE;
 IF NOT FOUND OR q.payload->'tu_dong' IS DISTINCT FROM 'true'::jsonb OR q.payload->'auto_reply'='true'::jsonb
  THEN RAISE EXCEPTION 'Không xác nhận được hàng đợi phòng trống' USING ERRCODE='PT409';END IF;
 IF p_result->'reused'='true'::jsonb THEN
  IF q.payload->'sale_content_guard' IS DISTINCT FROM p_guard THEN
   RETURN jsonb_build_object('status','skipped','reason','Nội dung lượt này đã thay đổi; không thay bản cũ hoặc tự gửi thêm');
  END IF;
  RETURN p_result;
 END IF;
 UPDATE public.zalo_send_queue SET payload=payload||jsonb_build_object('sale_content_guard',p_guard) WHERE id=q.id;
 RETURN p_result;
END $fn$;
CREATE OR REPLACE FUNCTION public.zalo_enqueue_broadcast_v2(p_conversation_id uuid,p_body text,p_not_before timestamptz,
 p_request_key text,p_attachment jsonb,p_content_guard jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 RETURN app_private.zalo_attach_broadcast_content_guard_v1(
  public.zalo_enqueue_broadcast_v1(p_conversation_id,p_body,p_not_before,p_request_key,p_attachment),p_content_guard);
END $fn$;
CREATE OR REPLACE FUNCTION public.zalo_enqueue_broadcast_oneshot_v2(p_oneshot_id uuid,p_instance_id uuid,p_conversation_id uuid,
 p_body text,p_not_before timestamptz,p_request_key text,p_attachment jsonb,p_content_guard jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 RETURN app_private.zalo_attach_broadcast_content_guard_v1(
  public.zalo_enqueue_broadcast_oneshot_v1(p_oneshot_id,p_instance_id,p_conversation_id,p_body,p_not_before,p_request_key,p_attachment),p_content_guard);
END $fn$;
ALTER FUNCTION app_private.zalo_attach_broadcast_content_guard_v1(jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.zalo_attach_broadcast_content_guard_v1(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.zalo_enqueue_broadcast_v2(uuid,text,timestamptz,text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION public.zalo_enqueue_broadcast_oneshot_v2(uuid,uuid,uuid,text,timestamptz,text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.zalo_enqueue_broadcast_v2(uuid,text,timestamptz,text,jsonb,jsonb),
 public.zalo_enqueue_broadcast_oneshot_v2(uuid,uuid,uuid,text,timestamptz,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_enqueue_broadcast_v2(uuid,text,timestamptz,text,jsonb,jsonb),
 public.zalo_enqueue_broadcast_oneshot_v2(uuid,uuid,uuid,text,timestamptz,text,jsonb,jsonb) TO service_role;
COMMIT;
NOTIFY pgrst,'reload schema';
