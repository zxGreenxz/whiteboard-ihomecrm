-- Hermes học có kiểm duyệt — đợt 3 (docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md mục 4): tin Zalo 21:00 "Bài học Hermes chờ duyệt" và
-- duyệt qua Zalo, cắm vào khung thao tác ghi chung crm_action_* (20261021133823). Trang `learning`, hai thao tác:
--  - learning.digest (reversible; chính sách dự kiến never): tối đa 10 đề xuất CHỜ của công ty chưa báo (announced_at trống), theo số
--    — đúng số dòng tin tối liệt kê được (LEARNING_DIGEST_MAX_ITEMS của infra/hermes-broker/learning-digest.mjs; mục đã đánh dấu không
--    bao giờ hiện lại ở tin sau nên mục nào đánh dấu cũng phải có số trong tin), đánh dấu đã báo và trả {announcedAt, pendingTotal,
--    items:[{seq,kind,title,content ≤ 300 ký tự}]}; connector dựng tin tất định. Phần vượt trần sang tối sau. Không có mục mới ⇒ items
--    rỗng (tin null, cron không gửi). Cùng requestId ⇒ phát lại đúng kết quả cũ (sổ biên nhận chung).
--  - learning.decide (reversible; chính sách dự kiến always): {numbers 1–20 = số seq của công ty, decision approve|reject, note ≤ 500}.
--    LUÔN xem trước, kể cả khi chính sách là never (quyết định là một lần và bất biến): từng số → DUYỆT/BỎ, số không còn chờ vào cảnh
--    báo; lượt 2 gửi đúng bản đã giải + basis (băm trạng thái các đề xuất đã chọn) — lệch ⇒ state_changed; ghi qua lõi dùng chung
--    app_private.hermes_learning_apply_v1(..., 'hermes_connector') như trang web ghi với 'crm_ui'.
--  1. Cột announced_at (mốc "đã báo", đặt đúng một lần khi đề xuất còn chờ) + guard bất biến cho phép đúng bước đó; quyết định giữ
--     nguyên mốc đã báo, nội dung vẫn không đổi được, không xoá.
--  2. Khoá assistant.learning_review (mode action) seed TẮT. File này KHÔNG chèn dòng app_private.hermes_action_policies: migration BẬT
--     riêng (sau lượt kiểm cuối) chèn hai dòng và bật khoá; tới lúc đó guard chung từ chối mọi lời gọi (42501), thao tác không sống.
--  3. Bước DEFINER: guard chung (binding, registry, trần công ty, khoá kết nối, quyền CRM users.edit) → cổng người của trang web
--     (hermes_learning_admin_v1: thành viên, chưa nghỉ việc, require_perm_v1 users.edit sau khoá công ty) → khoá công ty của kho đề xuất
--     → phát lại theo requestId → basis → ghi → biên nhận. Vỏ public INVOKER thân SQL-standard gắn OID bước này lúc tạo (authenticated
--     không có USAGE app_private).
-- Chưa áp TEST/production. Không DROP. Idempotent (chạy lại an toàn; khoá đã bật giữ nguyên).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE v_guard text;
BEGIN
  IF to_regclass('app_private.hermes_learning_proposals') IS NULL OR to_regclass('app_private.hermes_capabilities') IS NULL
    OR to_regclass('app_private.hermes_action_policies') IS NULL OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR to_regrole('hermes_learning_ingest') IS NULL
    OR to_regprocedure('app_private.hermes_action_guard_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_learning_admin_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_learning_apply_v1(uuid,uuid,uuid[],text,text,uuid,text)') IS NULL
    OR to_regprocedure('app_private.hermes_learning_guard_v1()') IS NULL THEN
    RAISE EXCEPTION 'hermes_learning_action_dependency_missing'; END IF;
  -- Ghim md5 thân guard trước khi CREATE OR REPLACE (khuôn C2 20261104231450): thân 20261031041523 đang chạy (đo trên production và
  -- TEST 05/11) hoặc thân mới của file này (lượt hai chạy lại). Thân khác ⇒ guard đã bị sửa ngoài migration — dừng, không đè.
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO v_guard FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('app_private.hermes_learning_guard_v1()');
  IF v_guard IS NULL OR v_guard NOT IN ('54e4b8fc6831348bd4e2df411bde6fdb','e55ad2c8914b850b1c335fdd7ed224f3') THEN
    RAISE EXCEPTION 'hermes_learning_guard_body_drift: %',COALESCE(v_guard,'missing'); END IF;
END $requires$;

ALTER TABLE app_private.hermes_learning_proposals ADD COLUMN IF NOT EXISTS announced_at timestamptz;

-- Bất biến như 20261031041523 cộng đúng một bước: đánh dấu "đã báo" một lần khi còn chờ (trống → có mốc, không kèm quyết định, không
-- đổi gì khác). Quyết định một lần pending → approved|rejected giữ nguyên mốc đã báo. Mọi sửa khác, quyết định lại và xoá vẫn bị chặn.
CREATE OR REPLACE FUNCTION app_private.hermes_learning_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF TG_OP<>'UPDATE' OR OLD.status<>'pending'
    OR (NEW.id,NEW.organization_id,NEW.user_id,NEW.assistant_id,NEW.profile,NEW.seq,NEW.kind,NEW.title,NEW.content,NEW.source,
      NEW.detected_at,NEW.ingested_at,NEW.dedupe_key) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.user_id,OLD.assistant_id,
      OLD.profile,OLD.seq,OLD.kind,OLD.title,OLD.content,OLD.source,OLD.detected_at,OLD.ingested_at,OLD.dedupe_key)
    OR (NEW.status='pending' AND (OLD.announced_at IS NOT NULL OR NEW.announced_at IS NULL))
    OR (NEW.status<>'pending' AND NEW.announced_at IS DISTINCT FROM OLD.announced_at)
    THEN RAISE EXCEPTION 'hermes_learning_immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $fn$;

-- Khoá riêng Hermes, seed TẮT. Chỉ chèn khi chưa có: chạy lại không bắn trigger chiếu lại kết nối, không tắt khoá đã bật.
DO $seed$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='assistant.learning_review') THEN
    INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('assistant.learning_review','action',false);
  END IF;
END $seed$;

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

-- Đầu hàm theo đúng khuôn lane migrate:forward nhận cho thân SQL-standard ghi; mọi tên trong thân ghi đủ schema và gắn OID lúc tạo.
-- Câu lệnh được ghim băm ở scripts/hermes-task-function-contract.mjs.
CREATE OR REPLACE FUNCTION public.hermes_learning_action_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb DEFAULT NULL,p_expected_basis text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  SELECT app_private.hermes_learning_action_step_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis);
END;

ALTER FUNCTION app_private.hermes_learning_guard_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
ALTER FUNCTION public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_learning_guard_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới authenticated nên cần EXECUTE trên đúng bước DEFINER nó gắn OID (tới qua OID, không qua tên). Guard, biên nhận,
-- lõi quyết định và ánh xạ lý do chỉ bước DEFINER gọi.
GRANT EXECUTE ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
BEGIN
  IF (SELECT count(*) FROM app_private.hermes_capabilities WHERE capability='assistant.learning_review' AND mode='action')<>1
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app_private.hermes_learning_proposals'::regclass AND attname='announced_at'
      AND atttypid='timestamptz'::regtype AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app_private.hermes_learning_proposals'::regclass AND tgname='hermes_learning_proposals_guard'
      AND tgfoid='app_private.hermes_learning_guard_v1()'::regprocedure AND NOT tgisinternal AND tgenabled<>'D')
    -- Vỏ public: INVOKER + thân SQL-standard (OID gắn lúc tạo) tới đúng bước DEFINER.
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND NOT prosecdef AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass
      AND objid='public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid='app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure)
    OR NOT has_function_privilege('authenticated','public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('hermes_learning_ingest','public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('hermes_learning_ingest','app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_learning_apply_v1(uuid,uuid,uuid[],text,text,uuid,text)','EXECUTE')
    OR has_table_privilege('authenticated','app_private.hermes_learning_proposals','UPDATE')
    OR has_table_privilege('hermes_learning_ingest','app_private.hermes_learning_proposals','UPDATE') THEN
    RAISE EXCEPTION 'hermes_learning_action_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
