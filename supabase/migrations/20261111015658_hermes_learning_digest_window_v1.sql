-- Hermes học có kiểm duyệt — KHUNG GIỜ TIN TỐI của learning.digest (docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md mục 4.2, 4.6, 4.6.1).
-- VẤN ĐỀ. learning.digest (chính sách reversible + never) đánh dấu announced_at ngay ở lượt auto rồi trả tin cho job cron 21:00 gửi Zalo.
--   Lời gọi NGOÀI lượt chạy theo lịch — mô hình tự gọi trong hội thoại, hoặc chạy tay job khi không có adapter gửi tin — vẫn đánh dấu:
--   đề xuất rời khỏi mọi tin tối sau dù tin chưa tới chủ (sáng 11/11/2026: chạy tay 08:18 đánh dấu 3 đề xuất mà không gửi được tin;
--   nội dung chỉ tới chủ lúc 08:29 nhờ gửi lại bằng tay). announced_at bất biến khi đề xuất còn
--   chờ nên không tự sửa lại được. Tới nay chỉ có lời dặn trong prompt / skill ngăn việc này.
-- LUẬT MỚI. announced_at chỉ được learning.digest đặt khi đồng hồ database nằm trong khung [20:55:00, 21:10:00) giờ Asia/Ho_Chi_Minh:
--   đầu khung CÓ tính, cuối khung KHÔNG tính (20:54:59 ngoài; 20:55:00 trong; 21:09:59 trong; 21:10:00 và 21:10:01 ngoài). Ngoài khung,
--   lượt GHI của learning.digest (auto khi chính sách never, hoặc apply) trả {kind:'rejected', reason:'learning_digest_outside_window'}
--   TRƯỚC khi mở biên nhận: không đánh dấu, không biên nhận, không audit, không đổi dòng nào.
--  1. app_private.hermes_learning_digest_window_v1(timestamptz): phép so thuần. Tự đổi mốc sang giờ Asia/Ho_Chi_Minh trong hàm nên kết
--     quả không phụ thuộc TimeZone của phiên; NULL ⇒ false.
--  2. app_private.hermes_learning_digest_window_open_v1(): hàm (1) trên clock_timestamp() của database. Không tham số, không đọc GUC,
--     header hay bảng nào: bên gọi không có đường nào nới khung.
--  3. app_private.hermes_learning_action_step_v1: thân 20261105025453 giữ nguyên từng ký tự, thêm ĐÚNG một khối IF ngay sau khối phát
--     lại theo requestId, trước mọi phép đọc / ghi của digest.
-- VÌ SAO AN TOÀN.
--  - Chữ ký, kiểu trả về và khuôn kết quả không đổi ({kind:'rejected',reason} như state_changed / request_conflict). CREATE OR REPLACE
--    giữ OID nên vỏ public.hermes_learning_action_v1 (gắn OID lúc tạo) không phải dựng lại; OWNER / REVOKE / GRANT của bước nhắc lại y
--    như 20261105025453.
--  - requestId ĐÃ có biên nhận vẫn phát lại đúng kết quả cũ kể cả ngoài khung (phát lại không ghi gì): lượt gọi lại của chính job tối
--    không làm mất tin. Xem trước (preview; auto khi chính sách siết always) chỉ đọc, không đổi. learning.decide không đổi.
--  - Trong khung, hành vi y như trước. Mốc announced_at vẫn là đồng hồ lúc VÀO hàm (v_now) như cũ; phép so khung dùng đồng hồ SAU khi
--    đã giữ khoá công ty, nên mốc ghi có thể sớm hơn mốc so đúng bằng quãng chờ khoá.
--  - Hai hàm mới không cấp EXECUTE cho vai nào: chỉ chủ hàm (postgres) — tức bước DEFINER — gọi được.
--  - Connector bản cũ gặp mã lạ quy về crm_refused (vẫn là từ chối, không ghi); connector cùng PR có mã learning_digest_outside_window.
-- PHẠM VI. Không đổi bảng, cột, trigger guard hermes_learning_guard_v1, chính sách hay khoá; không DROP; không ghi dữ liệu. Trigger guard
--   cố ý giữ nguyên: RAISE từ trigger rơi vào khối EXCEPTION của bước và sẽ để lại biên nhận 'rejected' — trái với "ngoài khung không
--   đổi dòng nào"; đường ghi thẳng bảng của chủ bảng nằm ngoài phạm vi (không vai API nào có UPDATE).
-- Ghim md5 thân bước đang chạy = thân 20261105025453 (tính từ file đã phát hành; CHƯA đo lại trên production trong phiên soạn file — lệch
-- thì khối requires bên dưới dừng và nêu md5 lạ, không đè); lượt hai (idempotent) chấp nhận md5 thân mới.
-- Chưa áp TEST/production. Lùi: docs/plans/hermes-crm/revert/hermes_learning_digest_window_revert_v1.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE v_step text;
BEGIN
  IF to_regclass('app_private.hermes_learning_proposals') IS NULL OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('app_private.hermes_learning_proposals')
      AND attname='announced_at' AND NOT attisdropped)
    OR to_regrole('hermes_learning_ingest') IS NULL
    OR to_regprocedure('public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_guard_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_learning_admin_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_learning_apply_v1(uuid,uuid,uuid[],text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'hermes_learning_digest_window_dependency_missing'; END IF;
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO v_step FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)');
  IF v_step IS NULL OR v_step NOT IN ('64102acc22a0369df53745da554d8247','eaa04e7f508280eeaf11d386ce2a8309') THEN
    RAISE EXCEPTION 'hermes_learning_action_step_body_drift: %',COALESCE(v_step,'missing'); END IF;
END $requires$;

-- Phép so thuần: đầu khung tính, cuối khung không tính; đổi sang giờ Asia/Ho_Chi_Minh ngay tại đây (không dùng TimeZone của phiên).
CREATE OR REPLACE FUNCTION app_private.hermes_learning_digest_window_v1(p_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
  SELECT COALESCE((p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time>='20:55:00'::time
    AND (p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time<'21:10:00'::time,false)
$fn$;

-- Đồng hồ database, không tham số: bên gọi không truyền được mốc giờ, không có GUC / header nào được đọc.
CREATE OR REPLACE FUNCTION app_private.hermes_learning_digest_window_open_v1()
RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
  SELECT app_private.hermes_learning_digest_window_v1(clock_timestamp())
$fn$;

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
  -- Khung giờ tin tối (20261111015658): lượt GHI của learning.digest chỉ được nhận khi đồng hồ database nằm trong khung
  -- [20:55:00, 21:10:00) giờ Asia/Ho_Chi_Minh. Ngoài khung ⇒ từ chối TRƯỚC khi mở biên nhận: không đánh dấu, không biên nhận, không
  -- đổi dòng nào. Đặt SAU khối phát lại: requestId đã có biên nhận chỉ trả lại kết quả cũ, không bao giờ đặt announced_at.
  IF v_write AND p_action='learning.digest' AND app_private.hermes_learning_digest_window_open_v1() IS NOT TRUE THEN
    RETURN jsonb_build_object('kind','rejected','reason','learning_digest_outside_window');
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

ALTER FUNCTION app_private.hermes_learning_digest_window_v1(timestamptz) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_learning_digest_window_open_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_learning_digest_window_v1(timestamptz) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_learning_digest_window_open_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Như 20261105025453: vỏ INVOKER chạy dưới authenticated cần EXECUTE trên đúng bước DEFINER nó gắn OID. Hai hàm khung giờ KHÔNG cấp
-- cho vai nào — chỉ bước DEFINER (chủ hàm) gọi.
GRANT EXECUTE ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure AND prosecdef)
    -- Vỏ public vẫn gắn đúng OID bước này.
    OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass
      AND objid='public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid='app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure)
    OR NOT has_function_privilege('authenticated','public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR NOT has_function_privilege('authenticated','app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('service_role','app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('hermes_learning_ingest','app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    -- Hai hàm khung giờ: INVOKER, chủ postgres, không vai API / runtime nào và không PUBLIC được EXECUTE.
    OR (SELECT count(*) FROM pg_proc WHERE oid IN ('app_private.hermes_learning_digest_window_v1(timestamptz)'::regprocedure,'app_private.hermes_learning_digest_window_open_v1()'::regprocedure)
      AND NOT prosecdef AND proowner='postgres'::regrole)<>2
    OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN unnest(ARRAY['anon','authenticated','service_role','hermes_store_executor','hermes_learning_ingest']) r(role_name)
      WHERE p.oid IN ('app_private.hermes_learning_digest_window_v1(timestamptz)'::regprocedure,'app_private.hermes_learning_digest_window_open_v1()'::regprocedure) AND has_function_privilege(r.role_name::name,p.oid,'EXECUTE'))
    OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid IN ('app_private.hermes_learning_digest_window_v1(timestamptz)'::regprocedure,'app_private.hermes_learning_digest_window_open_v1()'::regprocedure) AND a.grantee=0)
    -- Biên khung trên mốc có múi giờ tường minh (không phụ thuộc TimeZone của phiên chạy migration).
    OR app_private.hermes_learning_digest_window_v1('2026-11-11 20:54:59.999999+07'::timestamptz)
    OR NOT app_private.hermes_learning_digest_window_v1('2026-11-11 20:55:00+07'::timestamptz)
    OR NOT app_private.hermes_learning_digest_window_v1('2026-11-11 13:55:00+00'::timestamptz)
    OR NOT app_private.hermes_learning_digest_window_v1('2026-11-11 21:09:59.999999+07'::timestamptz)
    OR app_private.hermes_learning_digest_window_v1('2026-11-11 21:10:00+07'::timestamptz)
    OR app_private.hermes_learning_digest_window_v1('2026-11-11 14:10:00+00'::timestamptz)
    OR app_private.hermes_learning_digest_window_v1(NULL)
    OR app_private.hermes_learning_digest_window_open_v1() IS NULL THEN
    RAISE EXCEPTION 'hermes_learning_digest_window_check_failed'; END IF;
END $check$;

COMMIT;
