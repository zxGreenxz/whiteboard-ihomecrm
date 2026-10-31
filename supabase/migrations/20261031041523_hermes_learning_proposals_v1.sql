-- Hermes học có kiểm duyệt (31/10/2026, đợt 2 kế hoạch trị tận gốc; chủ duyệt 31/10).
-- Hermes tự học (curator sửa skill, cộng bộ nhớ). Chủ chốt "tuỳ loại": sở thích, cách nói chuyện, việc ngoài CRM tự áp dụng;
-- bài học về cách GHI dữ liệu CRM là ĐỀ XUẤT để chủ/admin xem và quyết định. Job kiểm học tập trên host VPS
-- (infra/hermes-learning-audit) phát hiện đề xuất rồi nạp vào kho này; duyệt hoặc bỏ ở Cài đặt › Hermes › "Bài học chờ duyệt".
--  1. Bảng app_private.hermes_learning_proposals: một dòng một đề xuất của một trợ lý (công ty, người dùng, trợ lý, hồ sơ Hermes),
--     số thứ tự tăng dần theo công ty (cùng số cho trang web và tin Zalo tối), khoá chống trùng (công ty, dedupe_key). Quyết định
--     một lần (pending → approved | rejected). Khung che nội dung SAU quyết định (redacted_at/redacted_by, một lần); chính sách
--     xem/lưu/xoá nội dung còn chờ chủ quyết nên trigger không cấm xoá (không có RPC nào xoá). Không cấp bảng cho vai nào.
--  2. Đọc + duyệt cho người (JWT): giữ khoá users.edit — cùng quyền quản trị chính sách Hermes của công ty — qua require_perm_v1;
--     lặp lại cùng requestId của cùng người trả lại kết quả cũ, khác nội dung ⇒ PT409. Đọc phân trang (20 đề xuất chờ, 20 dòng
--     lịch sử rút gọn) để phản hồi luôn dưới 1 MiB; kèm "lần kiểm cuối" của từng hồ sơ.
--  3. Nạp cho job host (không JWT, không service_role): vai NOLOGIN riêng hermes_learning_ingest chỉ được gọi đúng hàm nạp
--     (login riêng của job do vận hành tạo ngoài repo, thuộc vai này và KHÔNG thuộc hermes_store_executor). Người dùng phải là
--     thành viên đang hoạt động và có trợ lý ACTIVE. Mỗi lần nạp ghi "lần kiểm cuối" (kể cả không có đề xuất). Trùng khoá ⇒ bỏ qua,
--     trả riêng các khoá trùng với đề xuất ĐÃ BỎ (bài học bị bỏ mà trợ lý học lại).
-- Chưa áp TEST/production. Không DROP. Idempotent (chạy lại an toàn).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.profiles') IS NULL
    OR to_regclass('app_private.hermes_assistants') IS NULL OR to_regrole('hermes_store_executor') IS NULL
    OR to_regprocedure('app_private.hermes_member_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_request_v1(jsonb,text[])') IS NULL
    OR to_regprocedure('app_private.hermes_uuid_v1(jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_integer_v1(jsonb)') IS NULL
    OR to_regprocedure('app_private.require_perm_v1(uuid,text,text)') IS NULL
    OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.is_actor_offboarded_v1()') IS NULL THEN
    RAISE EXCEPTION 'hermes_learning_dependency_missing'; END IF;
END $requires$;

-- Vai riêng cho job nạp: không đăng nhập, không kế thừa, không đặc quyền; chỉ được gọi hàm nạp (cấp ở cuối file).
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_learning_ingest') THEN
    CREATE ROLE hermes_learning_ingest NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_learning_ingest'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='hermes_learning_ingest'::regrole) THEN
    RAISE EXCEPTION 'hermes_learning_ingest_role_unsafe'; END IF;
END $role$;

CREATE TABLE IF NOT EXISTS app_private.hermes_learning_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  assistant_id uuid NOT NULL,
  profile text NOT NULL CHECK (profile ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  seq bigint NOT NULL CHECK (seq BETWEEN 1 AND 9007199254740990),
  kind text NOT NULL CHECK (kind IN ('skill_crm_write','memory_crm_write')),
  -- Phải có ít nhất một ký tự không phải khoảng trắng (btrim chỉ cắt dấu cách: "\n\n" sẽ lọt).
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title ~ '[^[:space:]]' AND title !~ '[\x01-\x1F\x7F]'),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000 AND content ~ '[^[:space:]]'
    AND content !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),
  -- Đo trên dạng chữ (đúng thứ trang đọc trả về), không đo dạng nhị phân: trang 20 đề xuất luôn dưới trần phản hồi.
  source jsonb NOT NULL CHECK (jsonb_typeof(source)='object' AND octet_length(source::text)<=4096),
  detected_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR (char_length(decision_note) BETWEEN 1 AND 500 AND decision_note ~ '[^[:space:]]'
    AND decision_note !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')),
  decision_via text CHECK (decision_via IS NULL OR decision_via IN ('crm_ui','hermes_connector')),
  decision_request_id uuid,
  redacted_at timestamptz,
  redacted_by uuid REFERENCES auth.users(id),
  UNIQUE (organization_id,dedupe_key),
  UNIQUE (organization_id,seq),
  FOREIGN KEY (assistant_id,organization_id,user_id) REFERENCES app_private.hermes_assistants(id,organization_id,user_id),
  CHECK ((status='pending')=(decided_by IS NULL AND decided_at IS NULL AND decision_via IS NULL AND decision_request_id IS NULL)),
  CHECK (status='pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_via IS NOT NULL AND decision_request_id IS NOT NULL)),
  CHECK (status<>'pending' OR decision_note IS NULL),
  CHECK ((redacted_at IS NULL)=(redacted_by IS NULL)),
  CHECK (redacted_at IS NULL OR status<>'pending')
);
CREATE INDEX IF NOT EXISTS hermes_learning_proposals_pending ON app_private.hermes_learning_proposals(organization_id,seq) WHERE status='pending';
CREATE INDEX IF NOT EXISTS hermes_learning_proposals_history ON app_private.hermes_learning_proposals(organization_id,decided_at DESC,id DESC)
  WHERE status<>'pending';
CREATE INDEX IF NOT EXISTS hermes_learning_proposals_request ON app_private.hermes_learning_proposals(decided_by,decision_request_id)
  WHERE decision_request_id IS NOT NULL;
ALTER TABLE app_private.hermes_learning_proposals OWNER TO postgres;
ALTER TABLE app_private.hermes_learning_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_learning_proposals FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- "Lần kiểm cuối" của mỗi hồ sơ: job nạp ghi mỗi lần chạy (kể cả khi không có đề xuất), để trang web báo khi job kiểm ngừng chạy.
CREATE TABLE IF NOT EXISTS app_private.hermes_learning_audit_runs (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  profile text NOT NULL CHECK (profile ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  audit_generated_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,user_id,profile)
);
ALTER TABLE app_private.hermes_learning_audit_runs OWNER TO postgres;
ALTER TABLE app_private.hermes_learning_audit_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_learning_audit_runs FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- Quyết định chỉ đi một chiều pending → approved|rejected, đúng một lần; danh tính đề xuất không đổi. Nội dung (tiêu đề, nội dung,
-- nguồn) chỉ được che một lần SAU quyết định (redacted_at từ NULL sang có). Xoá: chưa chốt chính sách (chờ chủ) — không chặn ở đây,
-- và không có RPC nào xoá.
CREATE OR REPLACE FUNCTION app_private.hermes_learning_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF (NEW.id,NEW.organization_id,NEW.user_id,NEW.assistant_id,NEW.profile,NEW.seq,NEW.kind,NEW.detected_at,NEW.ingested_at,
      NEW.dedupe_key) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.user_id,OLD.assistant_id,OLD.profile,OLD.seq,OLD.kind,
      OLD.detected_at,OLD.ingested_at,OLD.dedupe_key)
    OR (OLD.status<>'pending' AND (NEW.status,NEW.decided_by,NEW.decided_at,NEW.decision_note,NEW.decision_via,NEW.decision_request_id)
      IS DISTINCT FROM (OLD.status,OLD.decided_by,OLD.decided_at,OLD.decision_note,OLD.decision_via,OLD.decision_request_id))
    OR (OLD.redacted_at IS NOT NULL AND (NEW.redacted_at,NEW.redacted_by) IS DISTINCT FROM (OLD.redacted_at,OLD.redacted_by))
    OR ((NEW.title,NEW.content,NEW.source) IS DISTINCT FROM (OLD.title,OLD.content,OLD.source)
      AND NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL))
    THEN RAISE EXCEPTION 'hermes_learning_immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $fn$;
CREATE OR REPLACE TRIGGER hermes_learning_proposals_guard BEFORE UPDATE OR DELETE ON app_private.hermes_learning_proposals
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_learning_guard_v1();

-- p_full=false (lịch sử): nội dung rút còn 300 ký tự, bỏ nguồn — trang đọc luôn dưới trần phản hồi.
CREATE OR REPLACE FUNCTION app_private.hermes_learning_proposal_json_v1(r app_private.hermes_learning_proposals,p_full boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('id',r.id,'seq',r.seq,'kind',r.kind,'profile',r.profile,'userId',r.user_id,
    'userName',(SELECT left(p.full_name,120) FROM public.profiles p WHERE p.id=r.user_id),
    'title',r.title,'content',CASE WHEN p_full THEN r.content ELSE left(r.content,300) END,
    'contentTruncated',NOT p_full AND char_length(r.content)>300,
    'source',CASE WHEN p_full THEN r.source ELSE '{}'::jsonb END,
    'detectedAt',to_char(r.detected_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'status',r.status,'decidedBy',r.decided_by,
    'decidedByName',(SELECT left(p.full_name,120) FROM public.profiles p WHERE p.id=r.decided_by),
    'decidedAt',to_char(r.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'note',r.decision_note,'via',r.decision_via,
    'redactedAt',to_char(r.redacted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
$fn$;

-- Người đọc/duyệt: thành viên đang hoạt động, chưa nghỉ việc, giữ users.edit của đúng công ty (chủ có mọi quyền). Kiểm thành
-- viên (đọc không khoá) TRƯỚC khi đụng khoá tổ chức: người công ty khác cầm UUID không giữ được khoá của công ty đó (như
-- 20261007003604); require_perm_v1 khoá tổ chức theo giao thức ghi rồi mới hỏi quyền trên ảnh chụp sau khoá.
CREATE OR REPLACE FUNCTION app_private.hermes_learning_admin_v1(p_org uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_actor uuid:=auth.uid();
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_org IS NULL
    THEN RAISE EXCEPTION 'hermes_learning_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_member_v1(v_actor,p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_learning_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.require_perm_v1(p_org,'users.edit','duyệt bài học của trợ lý Hermes');
  RETURN v_actor;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_learning_result_v1(p_org uuid,p_ids uuid[],p_decision text,p_replayed boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('organizationId',p_org,'decision',p_decision,'replayed',p_replayed,
    'proposals',COALESCE((SELECT jsonb_agg(app_private.hermes_learning_proposal_json_v1(r,true) ORDER BY r.seq)
      FROM app_private.hermes_learning_proposals r WHERE r.organization_id=p_org AND r.id=ANY(p_ids)),'[]'::jsonb))
$fn$;

-- Lõi quyết định dùng chung cho trang web (crm_ui) và thao tác qua connector sau này (hermes_connector). Bên gọi đã xác thực
-- người duyệt; ở đây khoá theo công ty, kiểm trạng thái và ghi một lần.
CREATE OR REPLACE FUNCTION app_private.hermes_learning_apply_v1(p_actor uuid,p_org uuid,p_ids uuid[],p_decision text,p_note text,
  p_request uuid,p_via text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_note text:=NULLIF(regexp_replace(COALESCE(p_note,''),'^[[:space:]]+|[[:space:]]+$','','g'),''); v_ids uuid[]; v_prior uuid[];
  v_status text; v_count integer;
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_actor IS NULL OR p_org IS NULL OR p_request IS NULL OR p_via IS NULL OR p_via NOT IN ('crm_ui','hermes_connector')
    OR p_decision IS NULL OR p_decision NOT IN ('approve','reject') OR p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 20
    OR array_position(p_ids,NULL) IS NOT NULL
    OR (v_note IS NOT NULL AND (char_length(v_note)>500 OR v_note ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'))
    THEN RAISE EXCEPTION 'hermes_learning_invalid' USING ERRCODE='22023'; END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_ids) x;
  IF cardinality(v_ids)<>cardinality(p_ids) THEN RAISE EXCEPTION 'hermes_learning_invalid' USING ERRCODE='22023'; END IF;
  v_status:=CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
  -- Cùng khoá với lúc nạp: số thứ tự, đọc lại và quyết định của một công ty đi tuần tự.
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-learning:'||p_org::text,0));
  SELECT array_agg(id ORDER BY id) INTO v_prior FROM app_private.hermes_learning_proposals
    WHERE decided_by=p_actor AND decision_request_id=p_request;
  IF v_prior IS NOT NULL THEN
    IF v_prior=v_ids AND NOT EXISTS(SELECT 1 FROM app_private.hermes_learning_proposals WHERE decided_by=p_actor
        AND decision_request_id=p_request AND (organization_id<>p_org OR status<>v_status
          OR decision_note IS DISTINCT FROM v_note OR decision_via<>p_via))
      THEN RETURN app_private.hermes_learning_result_v1(p_org,v_ids,p_decision,true); END IF;
    RAISE EXCEPTION 'hermes_learning_request_reused' USING ERRCODE='PT409';
  END IF;
  SELECT count(*) INTO v_count FROM (SELECT id FROM app_private.hermes_learning_proposals
    WHERE organization_id=p_org AND id=ANY(v_ids) FOR UPDATE) locked;
  IF v_count<>cardinality(v_ids) THEN RAISE EXCEPTION 'hermes_learning_not_found' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM app_private.hermes_learning_proposals WHERE organization_id=p_org AND id=ANY(v_ids) AND status<>'pending')
    THEN RAISE EXCEPTION 'hermes_learning_already_decided' USING ERRCODE='PT409'; END IF;
  UPDATE app_private.hermes_learning_proposals SET status=v_status,decided_by=p_actor,decided_at=v_now,decision_note=v_note,
    decision_via=p_via,decision_request_id=p_request WHERE organization_id=p_org AND id=ANY(v_ids);
  RETURN app_private.hermes_learning_result_v1(p_org,v_ids,p_decision,false);
END $fn$;

-- Trang web: đề xuất đang chờ (20 một trang, theo số; trang sau bằng pendingAfterSeq) + lịch sử đã quyết định (20 dòng một trang,
-- mới nhất trước, nội dung rút gọn) + lần kiểm cuối của từng hồ sơ.
CREATE OR REPLACE FUNCTION public.hermes_learning_review_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org uuid; v_cursor jsonb; v_at timestamptz; v_id uuid; v_after bigint; v_pending jsonb; v_history jsonb; v_audits jsonb;
  v_count bigint; v_rows integer; v_prows integer;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['organizationId','historyCursor','pendingAfterSeq']);
  v_org:=app_private.hermes_uuid_v1(p->'organizationId');
  v_cursor:=p->'historyCursor';
  IF v_cursor<>'null'::jsonb THEN
    IF jsonb_typeof(v_cursor) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v_cursor))<>2
      OR NOT (v_cursor ?& ARRAY['decidedAt','id']) OR jsonb_typeof(v_cursor->'decidedAt') IS DISTINCT FROM 'string'
      OR (v_cursor->>'decidedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
      THEN RAISE EXCEPTION 'hermes_learning_invalid' USING ERRCODE='22023'; END IF;
    v_at:=(v_cursor->>'decidedAt')::timestamptz; v_id:=app_private.hermes_uuid_v1(v_cursor->'id');
  END IF;
  IF p->'pendingAfterSeq'<>'null'::jsonb THEN v_after:=app_private.hermes_integer_v1(p->'pendingAfterSeq'); END IF;
  PERFORM app_private.hermes_learning_admin_v1(v_org);
  -- Cùng khoá với nạp/duyệt: số đếm và danh sách đọc trên cùng một trạng thái (không lẫn lô đang nạp dở).
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-learning:'||v_org::text,0));
  SELECT count(*) INTO v_count FROM app_private.hermes_learning_proposals WHERE organization_id=v_org AND status='pending';
  SELECT COALESCE(jsonb_agg(app_private.hermes_learning_proposal_json_v1(r,true) ORDER BY r.seq),'[]'::jsonb),count(*) INTO v_pending,v_prows
    FROM (SELECT * FROM app_private.hermes_learning_proposals WHERE organization_id=v_org AND status='pending'
      AND (v_after IS NULL OR seq>v_after) ORDER BY seq LIMIT 21) r;
  IF v_prows>20 THEN v_pending:=v_pending-20; END IF;
  SELECT COALESCE(jsonb_agg(app_private.hermes_learning_proposal_json_v1(r,false) ORDER BY r.decided_at DESC,r.id DESC),'[]'::jsonb),count(*)
    INTO v_history,v_rows
    FROM (SELECT * FROM app_private.hermes_learning_proposals WHERE organization_id=v_org AND status<>'pending'
      AND (v_at IS NULL OR (decided_at,id)<(v_at,v_id)) ORDER BY decided_at DESC,id DESC LIMIT 21) r;
  IF v_rows>20 THEN v_history:=v_history-20; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('profile',a.profile,'userId',a.user_id,
      'userName',(SELECT left(pp.full_name,120) FROM public.profiles pp WHERE pp.id=a.user_id),
      'generatedAt',to_char(a.audit_generated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'receivedAt',to_char(a.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY a.audit_generated_at DESC,a.profile,a.user_id),'[]'::jsonb) INTO v_audits
    FROM (SELECT * FROM app_private.hermes_learning_audit_runs WHERE organization_id=v_org
      ORDER BY audit_generated_at DESC,profile,user_id LIMIT 20) a;
  RETURN jsonb_build_object('organizationId',v_org,'canDecide',true,'pendingCount',v_count,'pending',v_pending,
    'nextPendingAfterSeq',CASE WHEN v_prows>20 THEN (v_pending->19->>'seq')::bigint END,'history',v_history,
    'nextHistoryCursor',CASE WHEN v_rows>20 THEN jsonb_build_object('decidedAt',v_history->19->>'decidedAt','id',v_history->19->>'id') END,
    'audits',v_audits);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_learning_decide_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org uuid; v_actor uuid; v_ids uuid[];
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['organizationId','requestId','proposalIds','decision','note']);
  IF jsonb_typeof(p->'proposalIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'proposalIds') NOT BETWEEN 1 AND 20
    OR jsonb_typeof(p->'decision') IS DISTINCT FROM 'string'
    OR (p->'note'<>'null'::jsonb AND jsonb_typeof(p->'note') IS DISTINCT FROM 'string')
    THEN RAISE EXCEPTION 'hermes_learning_invalid' USING ERRCODE='22023'; END IF;
  v_org:=app_private.hermes_uuid_v1(p->'organizationId');
  SELECT array_agg(app_private.hermes_uuid_v1(t.e) ORDER BY t.o) INTO v_ids
    FROM jsonb_array_elements(p->'proposalIds') WITH ORDINALITY AS t(e,o);
  v_actor:=app_private.hermes_learning_admin_v1(v_org);
  RETURN app_private.hermes_learning_apply_v1(v_actor,v_org,v_ids,p->>'decision',p->>'note',
    app_private.hermes_uuid_v1(p->'requestId'),'crm_ui');
END $fn$;

-- Job nạp trên host: chỉ vai hermes_learning_ingest. Tenant nằm trong payload và được kiểm ở đây: thành viên đang hoạt động +
-- trợ lý ACTIVE của đúng (công ty, người dùng). Ghi lần kiểm cuối kể cả khi lô rỗng. Trùng khoá ⇒ bỏ qua (khoá trùng với đề xuất đã
-- bỏ được trả riêng).
CREATE OR REPLACE FUNCTION app_private.hermes_store_learning_ingest_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org uuid; v_user uuid; v_assistant uuid; v_item jsonb; v_detected timestamptz; v_audit_at timestamptz; v_seq bigint;
  v_id uuid; v_status text; v_inserted jsonb:='[]'::jsonb; v_rejected jsonb:='[]'::jsonb; v_duplicates integer:=0;
BEGIN
  PERFORM app_private.hermes_request_v1(p,ARRAY['organizationId','userId','profile','auditGeneratedAt','proposals']);
  IF jsonb_typeof(p->'profile') IS DISTINCT FROM 'string' OR (p->>'profile') !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    OR jsonb_typeof(p->'proposals') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'proposals')>25
    OR jsonb_typeof(p->'auditGeneratedAt') IS DISTINCT FROM 'string'
    OR (p->>'auditGeneratedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
    THEN RAISE EXCEPTION 'hermes_learning_invalid' USING ERRCODE='22023'; END IF;
  v_audit_at:=(p->>'auditGeneratedAt')::timestamptz;
  IF v_audit_at>clock_timestamp()+interval '1 day' OR v_audit_at<clock_timestamp()-interval '400 days'
    THEN RAISE EXCEPTION 'hermes_learning_invalid' USING ERRCODE='22023'; END IF;
  v_org:=app_private.hermes_uuid_v1(p->'organizationId'); v_user:=app_private.hermes_uuid_v1(p->'userId');
  PERFORM app_private.hermes_member_v1(v_user,v_org);
  SELECT a.id INTO v_assistant FROM app_private.hermes_assistants a
    WHERE a.organization_id=v_org AND a.user_id=v_user AND a.state='ACTIVE';
  IF v_assistant IS NULL THEN RAISE EXCEPTION 'hermes_learning_denied' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-learning:'||v_org::text,0));
  INSERT INTO app_private.hermes_learning_audit_runs(organization_id,user_id,profile,audit_generated_at)
    VALUES(v_org,v_user,p->>'profile',v_audit_at)
    ON CONFLICT (organization_id,user_id,profile) DO UPDATE
      SET audit_generated_at=GREATEST(app_private.hermes_learning_audit_runs.audit_generated_at,EXCLUDED.audit_generated_at),
        received_at=clock_timestamp();
  FOR v_item IN SELECT e FROM jsonb_array_elements(p->'proposals') AS t(e) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v_item))<>6
      OR NOT (v_item ?& ARRAY['dedupeKey','kind','title','content','source','detectedAt'])
      OR jsonb_typeof(v_item->'dedupeKey') IS DISTINCT FROM 'string' OR (v_item->>'dedupeKey') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(v_item->'kind') IS DISTINCT FROM 'string' OR (v_item->>'kind') NOT IN ('skill_crm_write','memory_crm_write')
      OR jsonb_typeof(v_item->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(v_item->'content') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'source') IS DISTINCT FROM 'object' OR jsonb_typeof(v_item->'detectedAt') IS DISTINCT FROM 'string'
      OR (v_item->>'detectedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
      THEN RAISE EXCEPTION 'hermes_learning_invalid' USING ERRCODE='22023'; END IF;
    v_detected:=(v_item->>'detectedAt')::timestamptz;
    IF v_detected>clock_timestamp()+interval '1 day' OR v_detected<clock_timestamp()-interval '400 days'
      THEN RAISE EXCEPTION 'hermes_learning_invalid' USING ERRCODE='22023'; END IF;
    SELECT id,status INTO v_id,v_status FROM app_private.hermes_learning_proposals
      WHERE organization_id=v_org AND dedupe_key=v_item->>'dedupeKey';
    IF v_id IS NOT NULL THEN
      v_duplicates:=v_duplicates+1;
      IF v_status='rejected' THEN v_rejected:=v_rejected||jsonb_build_array(v_item->>'dedupeKey'); END IF;
      CONTINUE;
    END IF;
    SELECT COALESCE(max(seq),0)+1 INTO v_seq FROM app_private.hermes_learning_proposals WHERE organization_id=v_org;
    INSERT INTO app_private.hermes_learning_proposals(organization_id,user_id,assistant_id,profile,seq,kind,title,content,source,
      detected_at,dedupe_key)
      VALUES(v_org,v_user,v_assistant,p->>'profile',v_seq,v_item->>'kind',v_item->>'title',v_item->>'content',v_item->'source',
        v_detected,v_item->>'dedupeKey')
      RETURNING id INTO v_id;
    v_inserted:=v_inserted||jsonb_build_array(jsonb_build_object('id',v_id,'seq',v_seq));
  END LOOP;
  RETURN jsonb_build_object('organizationId',v_org,'inserted',v_inserted,'duplicates',v_duplicates,'rejectedDuplicates',v_rejected);
END $fn$;

ALTER FUNCTION app_private.hermes_learning_guard_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_learning_proposal_json_v1(app_private.hermes_learning_proposals,boolean) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_learning_admin_v1(uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_learning_result_v1(uuid,uuid[],text,boolean) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_learning_apply_v1(uuid,uuid,uuid[],text,text,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.hermes_learning_review_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_learning_decide_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_store_learning_ingest_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_learning_guard_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_learning_proposal_json_v1(app_private.hermes_learning_proposals,boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_learning_admin_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_learning_result_v1(uuid,uuid[],text,boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_learning_apply_v1(uuid,uuid,uuid[],text,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_learning_review_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_learning_decide_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_store_learning_ingest_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_learning_review_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_learning_decide_v1(jsonb) TO authenticated;
GRANT USAGE ON SCHEMA app_private TO hermes_learning_ingest;
GRANT EXECUTE ON FUNCTION app_private.hermes_store_learning_ingest_v1(jsonb) TO hermes_learning_ingest;

DO $check$
BEGIN
  IF to_regclass('app_private.hermes_learning_proposals') IS NULL OR to_regclass('app_private.hermes_learning_audit_runs') IS NULL
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='app_private.hermes_learning_proposals'::regclass)
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='app_private.hermes_learning_audit_runs'::regclass)
    OR has_table_privilege('authenticated','app_private.hermes_learning_proposals','SELECT')
    OR has_table_privilege('service_role','app_private.hermes_learning_proposals','SELECT')
    OR has_table_privilege('hermes_store_executor','app_private.hermes_learning_proposals','INSERT')
    OR has_table_privilege('hermes_learning_ingest','app_private.hermes_learning_proposals','INSERT')
    OR has_table_privilege('hermes_learning_ingest','app_private.hermes_learning_audit_runs','SELECT')
    OR has_table_privilege('authenticated','app_private.hermes_learning_audit_runs','SELECT')
    OR NOT has_function_privilege('authenticated','public.hermes_learning_review_v1(jsonb)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.hermes_learning_decide_v1(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_learning_review_v1(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_learning_decide_v1(jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_store_learning_ingest_v1(jsonb)','EXECUTE')
    OR has_function_privilege('service_role','app_private.hermes_store_learning_ingest_v1(jsonb)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','app_private.hermes_store_learning_ingest_v1(jsonb)','EXECUTE')
    OR NOT has_function_privilege('hermes_learning_ingest','app_private.hermes_store_learning_ingest_v1(jsonb)','EXECUTE')
    OR has_function_privilege('hermes_learning_ingest','public.hermes_learning_review_v1(jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_learning_apply_v1(uuid,uuid,uuid[],text,text,uuid,text)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','public.hermes_learning_decide_v1(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_learning_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
