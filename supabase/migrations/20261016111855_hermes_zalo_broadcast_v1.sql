-- Hermes điều khiển "Gửi ảnh phòng trống" của CRM (zalo_automations kind='broadcast_vacant'),
-- chủ dự án chốt 16/10/2026: MỘT bộ lập lịch là tự động hoá CRM. Hermes đọc cài đặt, tìm nhóm
-- nhận theo tên/phân loại, gửi ngay hoặc hẹn MỘT lần, huỷ lượt hẹn và sửa lịch định kỳ — luôn qua
-- đúng RPC của CRM, không ghi bảng zalo_* trực tiếp (trừ đọc). Lịch chữ riêng của Hermes
-- (crm_room_schedule_create/update) bị ẩn ở connector (cutover P6.06), file này không đụng tới.
--
-- public.hermes_zalo_broadcast_v1(p jsonb) — p = {binding, operation, input}, JWT người dùng:
--   status      cài đặt đã chuẩn hoá đúng luật chuanHoaBroadcast (worker/lib/automation-config.js
--               = src/components/chat-zalo/automationConfig.ts) cho giờ/thứ/người nhận; khung giờ,
--               trần ngày, dừng khẩn cấp theo đúng helper SQL đang chặn gửi; lượt một lần lấy từ
--               zalo_ds_hen_gui_phong_trong_v1; version = sha256(enabled, config) — KHÔNG gồm stats
--               nên worker ghi sổ không làm lệch version.
--   recipients  nhóm hợp lệ (thread_type='group' + is_sale_partner + nick cá nhân của công ty) kèm
--               phân loại Zalo (zalo_labels × zalo_conversations.label_ids, khoá accountId:labelId,
--               tên nick đi kèm vì hai nick có thể trùng tên phân loại).
--   send        zalo_hen_gui_phong_trong_v1(origin='hermes'); trùng requestId khác nội dung ⇒ mã
--               ma_yeu_cau_da_dung (không để lỗi 23505 thành "chưa rõ kết quả").
--   cancel      zalo_huy_hen_gui_phong_trong_v1, chỉ lượt của công ty kết nối.
--   update      đọc-sửa-ghi bằng zalo_luu_tu_dong_hoa dưới khoá 'zalo_automation:'||org (cùng khoá
--               với dừng khẩn cấp/xếp hàng): chỉ đổi enabled, schedule.time, schedule.days.<thứ>,
--               recipients; mọi khoá khác của config giữ nguyên byte. expectedVersion lệch ⇒ mã
--               cau_hinh_vua_doi (không ghi đè sửa đồng thời từ UI). Biên nhận (connection, requestId)
--               ⇒ gọi lại trả đúng kết quả cũ. Đang dừng khẩn cấp ⇒ từ chối (lưu cấu hình là hành
--               động gỡ dừng của NGƯỜI quản lý, Hermes không tự gỡ).
-- Quyền mỗi lượt (không thêm khoá capability): binding kết nối + Read chat_zalo.view
--   (hermes_schedule_actor_v1: phiên, epoch, chính sách, thành viên, authorize_tenant_action_v3,
--   overlay kết nối, trần công ty, registry); ghi thêm Action chat_zalo.manage_automation; send thêm
--   chat_zalo.send cùng bốn lớp đó. RPC CRM bên trong còn tự kiểm zalo_can theo JWT.
-- Chạy SAU 20261016101450_zalo_broadcast_oneshot_v1 và 20261016110539_zalo_broadcast_oneshot_review_fixes_v1
-- (mốc "đang dừng khẩn cấp" P2.2 do hàm zalo_dang_dung_khan_cap_v1 của file đó quyết định).
-- Mọi tham chiếu bảng/hàm zalo_* nằm trong thân plpgsql ⇒ tạo được trên baseline diễn tập.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- ---------------------------------------------------------------------------
-- 1. Biên nhận update (send dùng request_id của chính zalo_automation_oneshots)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.hermes_zalo_broadcast_receipts(
  connection_id   uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  request_id      uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id         uuid NOT NULL REFERENCES auth.users(id),
  operation       text NOT NULL CHECK (operation='update'),
  input           jsonb NOT NULL CHECK (jsonb_typeof(input)='object'),
  result          jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(connection_id,request_id)
);
ALTER TABLE app_private.hermes_zalo_broadcast_receipts OWNER TO postgres;
ALTER TABLE app_private.hermes_zalo_broadcast_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_zalo_broadcast_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- ---------------------------------------------------------------------------
-- 2. Chuẩn hoá config — cùng luật chuanHoaBroadcast (bản worker là chuẩn đọc).
-- ---------------------------------------------------------------------------
-- JS String(v ?? '') cho giá trị JSON: null → '', chuỗi giữ nguyên, số theo dạng ngắn nhất
-- (trim_scale; số mũ ≥1e21 không theo JS — config thật không có), object → '[object Object]',
-- mảng → nối các phần tử bằng dấu phẩy (phần tử null → '').
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_js_string_v1(p jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE t text:=jsonb_typeof(p);
BEGIN
  IF p IS NULL OR t='null' THEN RETURN ''; END IF;
  IF t='string' THEN RETURN p#>>'{}'; END IF;
  IF t='boolean' THEN RETURN p::text; END IF;
  IF t='number' THEN RETURN trim_scale((p#>>'{}')::numeric)::text; END IF;
  IF t='object' THEN RETURN '[object Object]'; END IF;
  RETURN COALESCE((SELECT string_agg(app_private.hermes_zalo_js_string_v1(e),',' ORDER BY i)
    FROM jsonb_array_elements(p) WITH ORDINALITY x(e,i)),'');
END $fn$;

-- JS String.prototype.trim: khoảng trắng + ký tự kết thúc dòng của ECMAScript.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_js_trim_v1(p text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT regexp_replace(p,'^['||w||']+|['||w||']+$','','g')
  FROM (SELECT ' '||chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(160)||chr(5760)||chr(8192)||'-'||chr(8202)
    ||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279) AS w) s
$fn$;

-- gioHopLe: "H:M"/"HH:MM" (sau trim) với giờ ≤ 23, phút ≤ 59 → "HH:MM"; khác → mặc định.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_gio_v1(p jsonb,p_default text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE m text[];
BEGIN
  m:=regexp_match(app_private.hermes_zalo_js_trim_v1(app_private.hermes_zalo_js_string_v1(p)),'^([0-9]{1,2}):([0-9]{1,2})$');
  IF m IS NULL OR m[1]::integer>23 OR m[2]::integer>59 THEN RETURN p_default; END IF;
  RETURN lpad(m[1]::integer::text,2,'0')||':'||lpad(m[2]::integer::text,2,'0');
END $fn$;

-- days: chỉ khi schedule.days là object; mỗi thứ đúng 'full'|'compact'|'off' thì giữ, khác → mặc định.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_ngay_v1(p_days jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT jsonb_object_agg(d.k,CASE WHEN jsonb_typeof(p_days)='object' AND jsonb_typeof(p_days->d.k)='string'
      AND p_days->>d.k IN ('full','compact','off') THEN p_days->>d.k ELSE d.v END)
  FROM (VALUES ('sun','off'),('mon','full'),('tue','compact'),('wed','compact'),('thu','compact'),('fri','compact'),('sat','compact')) d(k,v)
$fn$;

-- recipients: mảng → String(x ?? '').trim(), bỏ rỗng, bỏ trùng giữ thứ tự lần đầu; không phải mảng → rỗng.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_nguoi_nhan_v1(p jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT COALESCE((SELECT array_agg(v ORDER BY first_at) FROM (
      SELECT v,min(i) AS first_at FROM (
        SELECT app_private.hermes_zalo_js_trim_v1(app_private.hermes_zalo_js_string_v1(e)) AS v,i
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p)='array' THEN p ELSE '[]'::jsonb END) WITH ORDINALITY x(e,i)) s
      WHERE v<>'' GROUP BY v) d),'{}'::text[])
$fn$;

-- Chữ hiển thị cho Hermes: bỏ ký tự điều khiển (C0, DEL, C1, U+2028/2029), cắt theo số ký tự.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_text_v1(p text,p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE left(regexp_replace(p,
    '['||chr(1)||'-'||chr(31)||chr(127)||'-'||chr(159)||chr(8232)||chr(8233)||']','','g'),p_max) END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_zalo_iso_v1(p timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT to_char(p AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$fn$;

-- Version nội dung của lịch: chỉ (enabled, config). Không có dòng = (false, {}).
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_broadcast_version_v1(p_enabled boolean,p_config jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT encode(sha256(convert_to(jsonb_build_object('enabled',COALESCE(p_enabled,false),
    'config',COALESCE(p_config,'{}'::jsonb))::text,'UTF8')),'hex')
$fn$;

-- Nhóm hợp lệ để nhận: đúng luật của zalo_hen_gui_phong_trong_v1.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_group_ok_v1(p_org uuid,p_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  RETURN EXISTS(SELECT 1 FROM public.zalo_conversations c
    JOIN public.zalo_accounts z ON z.id=c.account_id AND z.organization_id=c.organization_id AND z.kind='personal'
    WHERE c.id=p_id AND c.organization_id=p_org AND c.thread_type='group' AND c.is_sale_partner);
END $fn$;

-- Bản xem cài đặt (status và kết quả update dùng chung).
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_broadcast_view_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE a public.zalo_automations; v_cfg jsonb; v_ids text[]; v_khung jsonb; v_rows jsonb;
BEGIN
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=p_org AND kind='broadcast_vacant';
  v_cfg:=CASE WHEN jsonb_typeof(a.config)='object' THEN a.config ELSE '{}'::jsonb END;
  v_ids:=app_private.hermes_zalo_nguoi_nhan_v1(v_cfg->'recipients');
  v_khung:=app_private.zalo_oneshot_khung_gio_v1(a.config,clock_timestamp());
  -- 50 mục đầu có dạng UUID; LIMIT giữ subquery không bị kéo phẳng nên phép ép ::uuid an toàn.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('conversationId',lower(r.x),
      'name',app_private.hermes_zalo_text_v1(cv.peer_name,200),'accountName',app_private.hermes_zalo_text_v1(z.name,200),
      'valid',COALESCE(cv.id::text=r.x AND cv.thread_type='group' AND cv.is_sale_partner AND z.kind='personal',false)) ORDER BY r.i),'[]'::jsonb)
    INTO v_rows
    FROM (SELECT u.x,u.i FROM unnest(v_ids) WITH ORDINALITY u(x,i)
          WHERE u.x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ORDER BY u.i LIMIT 50) r
    LEFT JOIN public.zalo_conversations cv ON cv.id=r.x::uuid AND cv.organization_id=p_org
    LEFT JOIN public.zalo_accounts z ON z.id=cv.account_id AND z.organization_id=p_org;
  RETURN jsonb_build_object(
    'version',app_private.hermes_zalo_broadcast_version_v1(a.enabled,a.config),
    'enabled',COALESCE(a.enabled,false),
    'emergencyStop',app_private.zalo_dang_dung_khan_cap_v1(p_org),
    'timeZone','Asia/Ho_Chi_Minh',
    'time',app_private.hermes_zalo_gio_v1(v_cfg#>'{schedule,time}','08:30'),
    'days',app_private.hermes_zalo_ngay_v1(v_cfg#>'{schedule,days}'),
    'allowedHours',jsonb_build_object('from',v_khung->>'from','to',v_khung->>'to'),
    'dailyCap',app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000),
    'queuedToday',app_private.zalo_oneshot_tin_hom_nay_v1(p_org,clock_timestamp()),
    'recipientCount',cardinality(v_ids),
    'recipients',v_rows);
END $fn$;

-- Lượt một lần (JSON snake của zalo_oneshot_json_v1) → dạng Hermes. Mã kết quả chỉ giữ khi là mã máy.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_oneshot_v1(p jsonb,p_full boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT jsonb_build_object('oneshotId',p->>'id','status',p->>'status','mode',p->>'mode',
      'runAt',app_private.hermes_zalo_iso_v1((p->>'run_at')::timestamptz),'sendNow',(p->>'send_now')::boolean,
      'origin',p->>'origin','requestId',app_private.hermes_zalo_text_v1(p->>'request_id',200),
      'createdAt',app_private.hermes_zalo_iso_v1((p->>'created_at')::timestamptz),
      'recipientCount',jsonb_array_length(p->'recipients'),
      'resultCode',CASE WHEN jsonb_typeof(p#>'{result,code}')='string' AND p#>>'{result,code}' ~ '^[a-z][a-z0-9_]{0,63}$'
        THEN p#>>'{result,code}' END)
    ||CASE WHEN p_full THEN jsonb_build_object('recipients',p->'recipients') ELSE '{}'::jsonb END
$fn$;

-- Danh sách UUID của input: mảng 1..100 phần tử, không trùng.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_ids_v1(p jsonb)
RETURNS uuid[] LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE v uuid[];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_array_length(p) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
  SELECT array_agg(app_private.hermes_uuid_v1(e) ORDER BY i) INTO v FROM jsonb_array_elements(p) WITH ORDINALITY x(e,i);
  IF (SELECT count(DISTINCT x) FROM unnest(v) x)<>cardinality(v) THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
  RETURN v;
END $fn$;

-- Gấp chữ để tìm tên nhóm/phân loại: NFD bỏ dấu kết hợp (U+0300–U+036F), đ→d, viết thường.
-- Cùng luật app_private.hermes_room_pass_fold_v1 nhưng tự đủ: file này không phụ thuộc migration tin pass.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_fold_v1(p text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT lower(translate(regexp_replace(normalize(COALESCE(p,''),NFD),'['||chr(768)||'-'||chr(879)||']','','g'),'đĐ','dd'))
$fn$;

-- Chữ tìm kiếm: chuỗi hoặc null; rỗng/quá 120 ký tự/ký tự điều khiển bị từ chối.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_query_v1(p jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
BEGIN
  IF p IS NULL OR p='null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(p)<>'string' OR char_length(p#>>'{}') NOT BETWEEN 1 AND 120 OR btrim(p#>>'{}')=''
    OR (p#>>'{}') ~ ('['||chr(1)||'-'||chr(31)||chr(127)||'-'||chr(159)||chr(8232)||chr(8233)||']') THEN
    RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
  RETURN app_private.hermes_zalo_fold_v1(p#>>'{}');
END $fn$;

-- ---------------------------------------------------------------------------
-- 3. RPC Hermes (JWT authenticated)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_zalo_broadcast_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; policy app_private.hermes_org_policies; decision record;
  receipt app_private.hermes_zalo_broadcast_receipts; a public.zalo_automations;
  op text; input jsonb; v_org uuid; v_now timestamptz:=clock_timestamp(); v_res jsonb; v_req uuid; v_ids uuid[]; v_run timestamptz;
  v_shot uuid; v_group text; v_label text; v_key text; v_limit bigint; v_sched text[]; v_groups jsonb; v_labels jsonb; v_total integer;
  v_keys text[]; v_add uuid[]; v_remove uuid[]; v_set uuid[]; v_bad uuid[]; v_base text[]; v_new text[]; v_cfg jsonb; v_old jsonb;
  v_schedule jsonb; v_enabled boolean; v_old_enabled boolean; v_changed text[]:='{}'; v_warn text[]:='{}'; v_view jsonb; v_result jsonb; v_id uuid;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>3 OR NOT(p ?& ARRAY['binding','operation','input'])
    OR jsonb_typeof(p->'operation') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'input') IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
  op:=p->>'operation'; input:=p->'input';
  IF op NOT IN ('status','recipients','send','cancel','update') THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
  -- Read cho mọi thao tác; ghi thêm Action quản lý tự động hoá; gửi thêm Action gửi tin.
  c:=app_private.hermes_schedule_actor_v1(p->'binding',false);
  IF op IN ('send','cancel','update') THEN PERFORM app_private.hermes_schedule_actor_v1(p->'binding',true); END IF;
  IF op='send' THEN
    policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
    SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'chat_zalo.send');
    IF decision.allowed IS DISTINCT FROM true OR NOT('chat_zalo.send'=ANY(c.action_capabilities)) OR NOT('chat_zalo.send'=ANY(policy.action_capabilities))
      OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.send' AND mode='action' AND enabled)
      THEN RAISE EXCEPTION 'hermes_zalo_broadcast_denied' USING ERRCODE='42501'; END IF;
  END IF;
  v_org:=c.organization_id;

  IF op='status' THEN
    IF input<>'{}'::jsonb THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
    v_res:=public.zalo_ds_hen_gui_phong_trong_v1(v_org,10);
    RETURN app_private.hermes_zalo_broadcast_view_v1(v_org)||jsonb_build_object('oneshots',
      COALESCE((SELECT jsonb_agg(app_private.hermes_zalo_oneshot_v1(x,false) ORDER BY i)
        FROM jsonb_array_elements(COALESCE(v_res->'items','[]'::jsonb)) WITH ORDINALITY y(x,i)),'[]'::jsonb));
  END IF;

  IF op='recipients' THEN
    PERFORM app_private.hermes_request_v1(input,ARRAY['groupName','labelName','labelKey','limit']);
    v_group:=app_private.hermes_zalo_query_v1(input->'groupName');
    v_label:=app_private.hermes_zalo_query_v1(input->'labelName');
    IF input->'labelKey'<>'null'::jsonb THEN
      IF jsonb_typeof(input->'labelKey')<>'string' OR input->>'labelKey' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:-?[0-9]{1,10}$'
        THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
      v_key:=input->>'labelKey';
    END IF;
    v_limit:=app_private.hermes_integer_v1(input->'limit');
    IF v_limit>50 THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
    SELECT app_private.hermes_zalo_nguoi_nhan_v1(CASE WHEN jsonb_typeof(x.config)='object' THEN x.config->'recipients' END) INTO v_sched
      FROM public.zalo_automations x WHERE x.organization_id=v_org AND x.kind='broadcast_vacant';
    v_sched:=COALESCE(v_sched,'{}'::text[]);
    WITH g AS (
      SELECT cv.id,cv.peer_name,z.id AS account_id,z.name AS account_name,
        CASE WHEN jsonb_typeof(cv.label_ids)='array' THEN cv.label_ids ELSE '[]'::jsonb END AS label_ids
      FROM public.zalo_conversations cv
      JOIN public.zalo_accounts z ON z.id=cv.account_id AND z.organization_id=cv.organization_id AND z.kind='personal'
      WHERE cv.organization_id=v_org AND cv.thread_type='group' AND cv.is_sale_partner
    ), l AS (
      SELECT lb.account_id,lb.label_id,lb.name,z.name AS account_name,lb.account_id::text||':'||lb.label_id::text AS key
      FROM public.zalo_labels lb JOIN public.zalo_accounts z ON z.id=lb.account_id AND z.organization_id=v_org AND z.kind='personal'
    ), gl AS (
      SELECT g.id AS conversation_id,l.key,l.name FROM g JOIN l ON l.account_id=g.account_id
        AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(g.label_ids) e WHERE e=l.label_id::text)
    ), ml AS (
      SELECT l.* FROM l WHERE (v_label IS NULL OR strpos(app_private.hermes_zalo_fold_v1(l.name),v_label)>0)
        AND (v_key IS NULL OR l.key=v_key)
    ), sel AS (
      SELECT g.* FROM g WHERE (v_group IS NULL OR strpos(app_private.hermes_zalo_fold_v1(g.peer_name),v_group)>0)
        AND ((v_label IS NULL AND v_key IS NULL) OR EXISTS(SELECT 1 FROM gl JOIN ml ON ml.key=gl.key WHERE gl.conversation_id=g.id))
    ), page AS (
      SELECT sel.*,row_number() OVER (ORDER BY app_private.hermes_zalo_fold_v1(sel.peer_name),sel.id) AS n FROM sel
    ), counted AS (
      SELECT ml.key,ml.name,ml.account_name,(SELECT count(*) FROM gl WHERE gl.key=ml.key)::integer AS groups FROM ml
    )
    SELECT (SELECT count(*) FROM sel)::integer,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('conversationId',page.id,'name',app_private.hermes_zalo_text_v1(page.peer_name,200),
          'accountName',app_private.hermes_zalo_text_v1(page.account_name,200),'inSchedule',page.id::text=ANY(v_sched),
          'labels',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',q.key,'name',app_private.hermes_zalo_text_v1(q.name,200)) ORDER BY q.key)
            FROM (SELECT gl.key,gl.name FROM gl WHERE gl.conversation_id=page.id ORDER BY gl.key LIMIT 10) q),'[]'::jsonb)) ORDER BY page.n)
        FROM page WHERE page.n<=v_limit),'[]'::jsonb),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('key',k.key,'name',app_private.hermes_zalo_text_v1(k.name,200),
          'accountName',app_private.hermes_zalo_text_v1(k.account_name,200),'groupCount',k.groups) ORDER BY k.ord)
        FROM (SELECT counted.*,row_number() OVER (ORDER BY app_private.hermes_zalo_fold_v1(counted.name),counted.key) AS ord FROM counted
              WHERE v_label IS NOT NULL OR v_key IS NOT NULL OR counted.groups>0) k WHERE k.ord<=50),'[]'::jsonb)
      INTO v_total,v_groups,v_labels;
    RETURN jsonb_build_object('groups',v_groups,'labels',v_labels,'total',v_total,'truncated',v_total>v_limit);
  END IF;

  IF op='send' THEN
    PERFORM app_private.hermes_request_v1(input,ARRAY['requestId','conversationIds','mode','runAt']);
    v_req:=app_private.hermes_uuid_v1(input->'requestId');
    v_ids:=app_private.hermes_zalo_ids_v1(input->'conversationIds');
    IF cardinality(v_ids)>50 OR jsonb_typeof(input->'mode') IS DISTINCT FROM 'string' OR input->>'mode' NOT IN ('full','compact')
      THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
    IF input->'runAt'='null'::jsonb THEN v_run:=NULL;
    ELSIF jsonb_typeof(input->'runAt')='string' AND input->>'runAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
      v_run:=(input->>'runAt')::timestamptz;
    ELSE RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
    IF v_run IS NOT NULL AND (v_run<v_now-interval '5 minutes' OR v_run>v_now+interval '30 days') THEN
      RETURN jsonb_build_object('ok',false,'code','gio_hen_khong_hop_le','reason','Giờ hẹn phải nằm trong 30 ngày tới.',
        'allowedHours',NULL,'suggestedRunAt',NULL,'invalidRecipients','[]'::jsonb);
    END IF;
    BEGIN
      v_res:=public.zalo_hen_gui_phong_trong_v1(v_ids,input->>'mode',v_run,v_req::text,'hermes',v_org);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok',false,'code','ma_yeu_cau_da_dung','reason','Mã yêu cầu đã dùng cho một lượt gửi khác.',
        'allowedHours',NULL,'suggestedRunAt',NULL,'invalidRecipients','[]'::jsonb);
    END;
    IF v_res->'ok'='true'::jsonb THEN
      IF v_res->'reused'='false'::jsonb THEN
        PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_ZALO_BROADCAST_SEND','zalo_automation_oneshot',(v_res#>>'{oneshot,id}')::uuid,NULL,
          jsonb_build_object('actor',auth.uid(),'connectionId',c.id,'requestId',v_req,'mode',input->>'mode','runAt',input->'runAt','recipients',cardinality(v_ids)));
      END IF;
      RETURN jsonb_build_object('ok',true,'reused',v_res->'reused'='true'::jsonb,'oneshot',app_private.hermes_zalo_oneshot_v1(v_res->'oneshot',true));
    END IF;
    RETURN jsonb_build_object('ok',false,'code',v_res->>'code','reason',app_private.hermes_zalo_text_v1(v_res->>'reason',500),
      'allowedHours',CASE WHEN jsonb_typeof(v_res->'khung_gio')='object' THEN jsonb_build_object('from',v_res#>>'{khung_gio,from}','to',v_res#>>'{khung_gio,to}') END,
      'suggestedRunAt',CASE WHEN jsonb_typeof(v_res->'goi_y_run_at')='string' THEN app_private.hermes_zalo_iso_v1((v_res->>'goi_y_run_at')::timestamptz) END,
      'invalidRecipients',CASE WHEN jsonb_typeof(v_res->'nguoi_nhan_loi')='array' THEN v_res->'nguoi_nhan_loi' ELSE '[]'::jsonb END);
  END IF;

  IF op='cancel' THEN
    PERFORM app_private.hermes_request_v1(input,ARRAY['oneshotId']);
    v_shot:=app_private.hermes_uuid_v1(input->'oneshotId');
    IF NOT EXISTS(SELECT 1 FROM public.zalo_automation_oneshots WHERE id=v_shot AND organization_id=v_org) THEN
      RETURN jsonb_build_object('ok',false,'code','khong_tim_thay','reason','Không tìm thấy lượt hẹn này trong công ty.','oneshot',NULL);
    END IF;
    v_res:=public.zalo_huy_hen_gui_phong_trong_v1(v_shot);
    IF v_res->'ok'='true'::jsonb THEN
      IF v_res->'reused'='false'::jsonb THEN
        PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_ZALO_BROADCAST_CANCEL','zalo_automation_oneshot',v_shot,NULL,
          jsonb_build_object('actor',auth.uid(),'connectionId',c.id));
      END IF;
      RETURN jsonb_build_object('ok',true,'reused',v_res->'reused'='true'::jsonb,'oneshot',app_private.hermes_zalo_oneshot_v1(v_res->'oneshot',true));
    END IF;
    RETURN jsonb_build_object('ok',false,'code',v_res->>'code','reason',app_private.hermes_zalo_text_v1(v_res->>'reason',500),
      'oneshot',CASE WHEN jsonb_typeof(v_res->'oneshot')='object' THEN app_private.hermes_zalo_oneshot_v1(v_res->'oneshot',true) END);
  END IF;

  -- update
  v_keys:=ARRAY(SELECT jsonb_object_keys(input));
  IF NOT(input ?& ARRAY['requestId','expectedVersion']) OR cardinality(v_keys)<3 OR EXISTS(SELECT 1 FROM unnest(v_keys) k
      WHERE k NOT IN ('requestId','expectedVersion','enabled','time','days','addConversationIds','removeConversationIds','setConversationIds'))
    OR jsonb_typeof(input->'expectedVersion') IS DISTINCT FROM 'string' OR input->>'expectedVersion' !~ '^[0-9a-f]{64}$'
    OR (input ? 'enabled' AND jsonb_typeof(input->'enabled')<>'boolean')
    OR (input ? 'time' AND (jsonb_typeof(input->'time')<>'string' OR input->>'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
    OR (input ? 'days' AND (jsonb_typeof(input->'days')<>'object' OR input->'days'='{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_each(input->'days') d
      WHERE d.key NOT IN ('mon','tue','wed','thu','fri','sat','sun') OR jsonb_typeof(d.value)<>'string' OR d.value#>>'{}' NOT IN ('full','compact','off'))))
    OR (input ? 'setConversationIds' AND (input ? 'addConversationIds' OR input ? 'removeConversationIds'))
    THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
  v_req:=app_private.hermes_uuid_v1(input->'requestId');
  IF input ? 'addConversationIds' THEN v_add:=app_private.hermes_zalo_ids_v1(input->'addConversationIds'); END IF;
  IF input ? 'removeConversationIds' THEN v_remove:=app_private.hermes_zalo_ids_v1(input->'removeConversationIds'); END IF;
  IF input ? 'setConversationIds' THEN v_set:=app_private.hermes_zalo_ids_v1(input->'setConversationIds'); END IF;
  IF v_add && v_remove THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;

  -- Cùng khoá với dừng khẩn cấp, xếp hàng và tạo lượt một lần.
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  SELECT * INTO receipt FROM app_private.hermes_zalo_broadcast_receipts r WHERE r.connection_id=c.id AND r.request_id=v_req FOR UPDATE;
  IF FOUND THEN
    IF receipt.input IS DISTINCT FROM input OR receipt.organization_id<>v_org OR receipt.user_id<>c.user_id THEN
      RETURN jsonb_build_object('ok',false,'code','ma_yeu_cau_da_dung','reason','Mã yêu cầu đã dùng cho một thay đổi khác.','version',NULL,'invalidRecipients','[]'::jsonb);
    END IF;
    RETURN receipt.result||jsonb_build_object('reused',true);
  END IF;
  IF app_private.zalo_dang_dung_khan_cap_v1(v_org) THEN
    RETURN jsonb_build_object('ok',false,'code','dang_dung_khan_cap','version',NULL,'invalidRecipients','[]'::jsonb,
      'reason','Tự động hoá Zalo đang DỪNG KHẨN CẤP. Người quản lý cần mở cài đặt gửi phòng trống trên CRM và lưu lại; Hermes không tự gỡ.');
  END IF;
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=v_org AND kind='broadcast_vacant' FOR UPDATE;
  IF app_private.hermes_zalo_broadcast_version_v1(a.enabled,a.config)<>input->>'expectedVersion' THEN
    RETURN jsonb_build_object('ok',false,'code','cau_hinh_vua_doi','invalidRecipients','[]'::jsonb,
      'version',app_private.hermes_zalo_broadcast_version_v1(a.enabled,a.config),
      'reason','Cài đặt gửi phòng trống vừa được sửa sau lần đọc; đọc lại rồi áp lại thay đổi.');
  END IF;
  v_old_enabled:=COALESCE(a.enabled,false);
  v_old:=CASE WHEN jsonb_typeof(a.config)='object' THEN a.config ELSE '{}'::jsonb END;
  v_cfg:=v_old;
  IF v_add IS NOT NULL OR v_remove IS NOT NULL OR v_set IS NOT NULL THEN
    SELECT array_agg(x ORDER BY x) INTO v_bad FROM unnest(COALESCE(v_set,v_add,'{}'::uuid[])) x WHERE NOT app_private.hermes_zalo_group_ok_v1(v_org,x);
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'code','nguoi_nhan_khong_hop_le','version',NULL,'invalidRecipients',to_jsonb(v_bad),
        'reason','Chỉ thêm được nhóm Zalo của công ty đã đánh dấu sale; có '||cardinality(v_bad)||' hội thoại không hợp lệ.');
    END IF;
    v_base:=app_private.hermes_zalo_nguoi_nhan_v1(v_old->'recipients');
    IF v_set IS NOT NULL THEN
      v_new:=ARRAY(SELECT x::text FROM unnest(v_set) WITH ORDINALITY u(x,i) ORDER BY i);
    ELSE
      v_new:=ARRAY(SELECT x FROM unnest(v_base) WITH ORDINALITY u(x,i) WHERE NOT(lower(x)=ANY(COALESCE(v_remove,'{}'::uuid[])::text[])) ORDER BY i)
        ||ARRAY(SELECT x::text FROM unnest(COALESCE(v_add,'{}'::uuid[])) WITH ORDINALITY u(x,i) WHERE NOT(x::text=ANY(v_base)) ORDER BY i);
    END IF;
    IF (v_set IS NOT NULL OR v_add IS NOT NULL) AND cardinality(v_new)>100 THEN
      RETURN jsonb_build_object('ok',false,'code','qua_nhieu_nguoi_nhan','version',NULL,'invalidRecipients','[]'::jsonb,
        'reason','Lịch gửi phòng trống tối đa 100 nhóm nhận.');
    END IF;
    v_cfg:=v_cfg||jsonb_build_object('recipients',to_jsonb(v_new));
  END IF;
  IF input ? 'time' OR input ? 'days' THEN
    v_schedule:=CASE WHEN jsonb_typeof(v_cfg->'schedule')='object' THEN v_cfg->'schedule' ELSE '{}'::jsonb END;
    IF input ? 'time' THEN v_schedule:=v_schedule||jsonb_build_object('time',input->'time'); END IF;
    IF input ? 'days' THEN
      v_schedule:=v_schedule||jsonb_build_object('days',CASE WHEN jsonb_typeof(v_schedule->'days')='object' THEN v_schedule->'days' ELSE '{}'::jsonb END||(input->'days'));
    END IF;
    v_cfg:=v_cfg||jsonb_build_object('schedule',v_schedule);
  END IF;
  v_enabled:=CASE WHEN input ? 'enabled' THEN (input->>'enabled')::boolean ELSE v_old_enabled END;
  IF v_enabled<>v_old_enabled THEN v_changed:=v_changed||'enabled'::text; END IF;
  IF app_private.hermes_zalo_gio_v1(v_cfg#>'{schedule,time}','08:30')<>app_private.hermes_zalo_gio_v1(v_old#>'{schedule,time}','08:30') THEN v_changed:=v_changed||'time'::text; END IF;
  IF app_private.hermes_zalo_ngay_v1(v_cfg#>'{schedule,days}')<>app_private.hermes_zalo_ngay_v1(v_old#>'{schedule,days}') THEN v_changed:=v_changed||'days'::text; END IF;
  IF app_private.hermes_zalo_nguoi_nhan_v1(v_cfg->'recipients')<>app_private.hermes_zalo_nguoi_nhan_v1(v_old->'recipients') THEN v_changed:=v_changed||'recipients'::text; END IF;
  -- Không đổi gì (sau chuẩn hoá) thì không ghi: lưu cấu hình bump updated_at, không có lý do làm vậy.
  IF cardinality(v_changed)>0 THEN
    BEGIN
      PERFORM public.zalo_luu_tu_dong_hoa('broadcast_vacant',v_enabled,v_cfg,v_org);
    EXCEPTION WHEN SQLSTATE 'PT409' THEN
      RETURN jsonb_build_object('ok',false,'code','trung_lich_hermes_cu','version',NULL,'invalidRecipients','[]'::jsonb,
        'reason','Nhóm nhận đang thuộc một lịch chữ cũ của Hermes còn hiệu lực; thu hồi lịch đó trước.');
    END;
  END IF;
  v_view:=app_private.hermes_zalo_broadcast_view_v1(v_org);
  IF NOT app_private.zalo_in_allowed_hours_v1(((date_trunc('day',v_now AT TIME ZONE 'Asia/Ho_Chi_Minh')
      +(v_view->>'time')::time) AT TIME ZONE 'Asia/Ho_Chi_Minh'),v_cfg) THEN v_warn:=v_warn||'gio_gui_ngoai_khung_gio'::text; END IF;
  IF v_enabled AND NOT EXISTS(SELECT 1 FROM unnest(app_private.hermes_zalo_nguoi_nhan_v1(v_cfg->'recipients')) x
      WHERE x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND app_private.hermes_zalo_group_ok_v1(v_org,x::uuid))
    THEN v_warn:=v_warn||'chua_co_nguoi_nhan_hop_le'::text; END IF;
  v_result:=jsonb_build_object('ok',true,'reused',false,'changed',to_jsonb(v_changed),'settings',v_view,'warnings',to_jsonb(v_warn));
  INSERT INTO app_private.hermes_zalo_broadcast_receipts(connection_id,request_id,organization_id,user_id,operation,input,result)
    VALUES(c.id,v_req,v_org,c.user_id,'update',input,v_result);
  IF cardinality(v_changed)>0 THEN
    SELECT id INTO v_id FROM public.zalo_automations WHERE organization_id=v_org AND kind='broadcast_vacant';
    PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_ZALO_BROADCAST_UPDATE','zalo_automation',v_id,NULL,
      jsonb_build_object('actor',auth.uid(),'connectionId',c.id,'requestId',v_req,'changed',to_jsonb(v_changed)));
  END IF;
  RETURN v_result;
END $fn$;

-- ---------------------------------------------------------------------------
-- 4. Chủ sở hữu, ACL và tự kiểm catalog (chạy được trên database rỗng)
-- ---------------------------------------------------------------------------
ALTER FUNCTION app_private.hermes_zalo_js_string_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_js_trim_v1(text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_gio_v1(jsonb,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_ngay_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_nguoi_nhan_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_text_v1(text,integer) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_iso_v1(timestamptz) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_broadcast_version_v1(boolean,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_group_ok_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_broadcast_view_v1(uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_oneshot_v1(jsonb,boolean) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_ids_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_fold_v1(text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_query_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_zalo_broadcast_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_js_string_v1(jsonb),app_private.hermes_zalo_js_trim_v1(text),
  app_private.hermes_zalo_gio_v1(jsonb,text),app_private.hermes_zalo_ngay_v1(jsonb),app_private.hermes_zalo_nguoi_nhan_v1(jsonb),
  app_private.hermes_zalo_text_v1(text,integer),app_private.hermes_zalo_iso_v1(timestamptz),
  app_private.hermes_zalo_broadcast_version_v1(boolean,jsonb),app_private.hermes_zalo_group_ok_v1(uuid,uuid),
  app_private.hermes_zalo_broadcast_view_v1(uuid),app_private.hermes_zalo_oneshot_v1(jsonb,boolean),
  app_private.hermes_zalo_ids_v1(jsonb),app_private.hermes_zalo_fold_v1(text),app_private.hermes_zalo_query_v1(jsonb),
  public.hermes_zalo_broadcast_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_broadcast_v1(jsonb) TO authenticated;

DO $assert$
DECLARE f text;
BEGIN
  IF NOT has_function_privilege('authenticated','public.hermes_zalo_broadcast_v1(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_zalo_broadcast_v1(jsonb)','EXECUTE')
    OR has_function_privilege('service_role','public.hermes_zalo_broadcast_v1(jsonb)','EXECUTE')
    OR NOT (SELECT prosecdef AND provolatile='v' FROM pg_proc WHERE oid='public.hermes_zalo_broadcast_v1(jsonb)'::regprocedure)
    THEN RAISE EXCEPTION 'hermes_zalo_broadcast_v1 ACL/volatility'; END IF;
  FOREACH f IN ARRAY ARRAY['app_private.hermes_zalo_broadcast_view_v1(uuid)','app_private.hermes_zalo_group_ok_v1(uuid,uuid)',
      'app_private.hermes_zalo_oneshot_v1(jsonb,boolean)','app_private.hermes_zalo_query_v1(jsonb)','app_private.hermes_zalo_ids_v1(jsonb)'] LOOP
    IF has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE')
      OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'hermes_zalo_broadcast helper ACL %',f; END IF;
  END LOOP;
  IF has_table_privilege('authenticated','app_private.hermes_zalo_broadcast_receipts','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('service_role','app_private.hermes_zalo_broadcast_receipts','SELECT,INSERT,UPDATE,DELETE')
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='app_private.hermes_zalo_broadcast_receipts'::regclass)
    THEN RAISE EXCEPTION 'hermes_zalo_broadcast_receipts ACL/RLS'; END IF;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
