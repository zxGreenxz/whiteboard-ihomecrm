-- REVERT of supabase/migrations/20261111015658_hermes_learning_digest_window_v1.sql — prepared 11/11/2026 next to the forward file;
-- NOT a migration (it lives outside supabase/migrations on purpose and is applied only by an explicit owner decision).
-- Restores app_private.hermes_learning_action_step_v1 to the exact body of 20261105025453 (learning.digest marks announced_at at any
-- hour again). The two window helpers stay in place, unused and without any grantee: nothing is dropped and no data is written.
-- Pins the body it replaces: the forward body (md5 eaa04e7f508280eeaf11d386ce2a8309) is restored; the old body (md5 64102acc22a0369df53745da554d8247)
-- means the revert already ran ⇒ no change; any other body stops (the step was edited outside these files).
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs hermes_learning_digest_window_revert_v1`
-- gives; add its provenance entry and doc counts like the forward file; move the step pin of
-- scripts/__tests__/hermes-durable-forward-fixture.mjs to the new file (the forward body becomes a superseded pin); then run it through
-- the migrate:forward lane. The connector may keep the learning_digest_outside_window reason: an unused code is harmless.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE v_step text;
BEGIN
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO v_step FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)');
  IF v_step IS NULL OR v_step NOT IN ('eaa04e7f508280eeaf11d386ce2a8309','64102acc22a0369df53745da554d8247') THEN
    RAISE EXCEPTION 'hermes_learning_action_step_body_drift: %',COALESCE(v_step,'missing'); END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_learning_action_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,
  p_params jsonb,p_resolved jsonb,p_expected_basis text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_actor uuid; v_now timestamptz:=clock_timestamp(); v_ids uuid[]; v_seqs bigint[]; v_numbers bigint[];
  v_decision text; v_note text; v_basis text; v_items jsonb; v_total bigint; v_input jsonb; v_write boolean; v_begin jsonb; v_outcome jsonb;
  v_constraint text; v_warnings jsonb:='[]'::jsonb; v_approved text; v_rejected text; v_missing text;
BEGIN
  -- NULL không bao giờ lọt: NOT IN với NULL cho NULL (không RAISE), nên mọi tham số bắt buộc kiểm IS NULL trước.
  IF p_action IS NULL OR p_action NOT IN ('learning.digest','learning.decide') OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply')
    OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL))
    OR (p_action='learning.digest' AND EXISTS(SELECT 1 FROM jsonb_object_keys(p_params))) THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  -- learning.decide: số = seq của công ty (trùng số trên web và tin tối), 1–20 số khác nhau tối đa 7 chữ số; decision; note tuỳ chọn.
  IF p_action='learning.decide' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_params) k WHERE k NOT IN ('numbers','decision','note'))
      OR jsonb_typeof(p_params->'numbers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_params->'numbers') NOT BETWEEN 1 AND 20
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_params->'numbers') e WHERE jsonb_typeof(e)<>'number' OR e::text !~ '^[1-9][0-9]{0,6}$')
      OR jsonb_typeof(p_params->'decision') IS DISTINCT FROM 'string' OR p_params->>'decision' NOT IN ('approve','reject')
      OR (p_params ? 'note' AND jsonb_typeof(p_params->'note') NOT IN ('string','null'))
      OR char_length(COALESCE(p_params->>'note',''))>500 OR COALESCE(p_params->>'note','') ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
      RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
    SELECT array_agg(DISTINCT (e::text)::bigint ORDER BY (e::text)::bigint) INTO v_numbers FROM jsonb_array_elements(p_params->'numbers') e;
    IF cardinality(v_numbers)<>jsonb_array_length(p_params->'numbers') THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
    v_decision:=p_params->>'decision';
    v_note:=NULLIF(regexp_replace(COALESCE(p_params->>'note',''),'^[[:space:]]+|[[:space:]]+$','','g'),'');
  END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  v_org:=(ctx->>'organizationId')::uuid;
  -- Cùng cổng người với trang web Bài học chờ duyệt; người duyệt là chính người của kết nối.
  v_actor:=app_private.hermes_learning_admin_v1(v_org);
  IF v_actor IS DISTINCT FROM (ctx->>'userId')::uuid THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
  -- Cùng khoá với nạp, đọc và quyết định của web: số thứ tự, trạng thái và biên nhận đọc trên cùng một ảnh (hai lời gọi cùng requestId
  -- đi tuần tự: lời gọi sau thấy biên nhận của lời gọi trước).
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-learning:'||v_org::text,0));
  v_input:=CASE p_action WHEN 'learning.decide' THEN jsonb_build_object('params',p_params,'resolved',p_resolved) ELSE jsonb_build_object('params',p_params) END;
  -- Lượt có thể ghi: lượt 2, hoặc auto của digest khi chính sách là reversible + never (siết thành always ⇒ xem trước, không đánh dấu).
  v_write:=p_phase='apply' OR (p_action='learning.digest' AND p_phase='auto'
    AND COALESCE(ctx->>'actionClass'='reversible' AND ctx->>'confirm'='never',false));
  -- Lượt ghi đã có biên nhận ⇒ phát lại / xung đột TRƯỚC mọi phép so trạng thái: chính lượt đã ghi làm đổi trạng thái mà basis băm.
  IF v_write AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts WHERE organization_id=v_org AND user_id=v_actor AND request_id=p_request_id) THEN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,v_input);
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409';
  END IF;

  IF p_action='learning.digest' THEN
    -- Trần 10 = số dòng tin tối liệt kê được (LEARNING_DIGEST_MAX_ITEMS): mục được đánh dấu không bao giờ hiện lại ở tin sau. Chỉ đề xuất
    -- còn chờ: đề xuất đã quyết định trên web trước khi được báo thì guard cấm đánh dấu — chọn nó sẽ làm hỏng mọi tin tối sau.
    SELECT COALESCE(array_agg(c.id ORDER BY c.seq),'{}'::uuid[]) INTO v_ids FROM (SELECT r.id,r.seq FROM app_private.hermes_learning_proposals r
      WHERE r.organization_id=v_org AND r.status='pending' AND r.announced_at IS NULL ORDER BY r.seq LIMIT 10) c;
    v_basis:=md5(jsonb_build_array(p_action,to_jsonb(v_ids))::text);
    IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    IF NOT v_write THEN
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved','{}'::jsonb,'confirm','required',
        'preview',jsonb_build_object('action',p_action,'newCount',cardinality(v_ids)),'warnings','[]'::jsonb);
    END IF;
  ELSE
    SELECT COALESCE(array_agg(r.id ORDER BY r.seq),'{}'::uuid[]),COALESCE(array_agg(r.seq ORDER BY r.seq),'{}'::bigint[]) INTO v_ids,v_seqs
      FROM app_private.hermes_learning_proposals r WHERE r.organization_id=v_org AND r.seq=ANY(v_numbers) AND r.status='pending';
    -- basis = đúng tập đề xuất còn chờ người dùng đã xem (id theo số) + quyết định + ghi chú; đổi giữa hai lượt ⇒ lệch.
    v_basis:=md5(jsonb_build_array(p_action,v_decision,v_note,to_jsonb(v_ids),to_jsonb(v_seqs))::text);
    IF p_phase='apply' THEN
      IF cardinality(v_ids)=0 OR p_expected_basis IS DISTINCT FROM v_basis OR p_resolved->'proposalIds' IS DISTINCT FROM to_jsonb(v_ids)
        OR p_resolved->'numbers' IS DISTINCT FROM to_jsonb(v_seqs) THEN
        RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    ELSE
      IF cardinality(v_ids)=0 THEN RETURN jsonb_build_object('kind','needs_input','reason','learning_not_pending'); END IF;
      SELECT string_agg('#'||r.seq,', ' ORDER BY r.seq) FILTER (WHERE r.status='approved'),
        string_agg('#'||r.seq,', ' ORDER BY r.seq) FILTER (WHERE r.status='rejected') INTO v_approved,v_rejected
        FROM app_private.hermes_learning_proposals r WHERE r.organization_id=v_org AND r.seq=ANY(v_numbers);
      SELECT string_agg('#'||n,', ' ORDER BY n) INTO v_missing FROM unnest(v_numbers) n
        WHERE NOT EXISTS(SELECT 1 FROM app_private.hermes_learning_proposals r WHERE r.organization_id=v_org AND r.seq=n);
      IF v_approved IS NOT NULL THEN v_warnings:=v_warnings||to_jsonb('Đã duyệt trước đó, không đổi được: '||v_approved||'.'); END IF;
      IF v_rejected IS NOT NULL THEN v_warnings:=v_warnings||to_jsonb('Đã bỏ trước đó, không đổi được: '||v_rejected||'.'); END IF;
      IF v_missing IS NOT NULL THEN v_warnings:=v_warnings||to_jsonb('Không có đề xuất số: '||v_missing||'.'); END IF;
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'confirm','required',
        'resolved',jsonb_build_object('proposalIds',to_jsonb(v_ids),'numbers',to_jsonb(v_seqs)),
        'preview',jsonb_build_object('action',p_action,'decision',CASE v_decision WHEN 'approve' THEN 'DUYỆT' ELSE 'BỎ' END,
          'items',(SELECT jsonb_agg(jsonb_build_object('number',r.seq,
            'kind',CASE r.kind WHEN 'skill_crm_write' THEN 'Skill' WHEN 'memory_crm_write' THEN 'Bộ nhớ' ELSE 'Cảnh báo kiểm học' END,
            'title',left(r.title,120)) ORDER BY r.seq) FROM app_private.hermes_learning_proposals r WHERE r.organization_id=v_org AND r.id=ANY(v_ids)),
          'note',v_note,
          'effect',CASE v_decision WHEN 'approve' THEN 'Duyệt chỉ ghi nhận bài học đúng; điều phối viên đưa vào hướng dẫn chuẩn.'
            ELSE 'Bỏ chỉ ghi nhận quyết định; bài học vẫn ở trợ lý tới khi điều phối viên gỡ.' END),
        'warnings',v_warnings);
    END IF;
  END IF;

  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,v_input);
  IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
  IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
  IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
  BEGIN
    IF p_action='learning.digest' THEN
      UPDATE app_private.hermes_learning_proposals SET announced_at=v_now WHERE organization_id=v_org AND id=ANY(v_ids);
      SELECT count(*) INTO v_total FROM app_private.hermes_learning_proposals WHERE organization_id=v_org AND status='pending';
      SELECT COALESCE(jsonb_agg(jsonb_build_object('seq',r.seq,'kind',r.kind,'title',r.title,'content',left(r.content,300)) ORDER BY r.seq),'[]'::jsonb)
        INTO v_items FROM app_private.hermes_learning_proposals r WHERE r.organization_id=v_org AND r.id=ANY(v_ids);
      v_outcome:=jsonb_build_object('kind','applied','link','/settings/hermes?tab=bai-hoc','result',jsonb_build_object(
        'announcedAt',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'pendingTotal',v_total,'items',v_items));
    ELSE
      PERFORM app_private.hermes_learning_apply_v1(v_actor,v_org,v_ids,v_decision,p_params->>'note',p_request_id,'hermes_connector');
      v_outcome:=jsonb_build_object('kind','applied','link','/settings/hermes?tab=bai-hoc','result',jsonb_build_object(
        'decision',v_decision,'numbers',to_jsonb(v_seqs),'count',cardinality(v_ids)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Lỗi tạm (tranh chấp, deadlock, chờ khoá, ngữ cảnh đổi) KHÔNG chốt biên nhận: cả giao dịch lùi, cùng requestId gọi lại được.
    IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
    v_outcome:=jsonb_build_object('kind','rejected','reason',app_private.hermes_action_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,'')));
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome,SQLSTATE,SQLERRM);
  END;
  RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
END $fn$;

ALTER FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
BEGIN
  IF (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_catalog.pg_proc p
      WHERE p.oid='app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure) IS DISTINCT FROM '64102acc22a0369df53745da554d8247'
    OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass
      AND objid='public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid='app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure)
    OR NOT has_function_privilege('authenticated','app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_learning_digest_window_revert_check_failed'; END IF;
END $check$;

COMMIT;
