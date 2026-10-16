-- Chat Zalo — GỬI ẢNH PHÒNG TRỐNG MỘT LẦN (gửi ngay / hẹn giờ một lần), chủ dự án chốt 16/10/2026.
--
-- Dùng CHÍNH bộ máy gửi định kỳ (worker/lib/automation.js guiLo: ảnh bảng, tin chi tiết phòng,
-- giãn nhịp, khung giờ, trần ngày), chỉ khác nguồn quyền: lượt một lần tự là căn cứ gửi,
-- không cần công tắc lịch bật và người nhận không cần nằm trong config.recipients.
--  (1) Bảng public.zalo_automation_oneshots: một dòng = một lượt (queued → running → done/failed,
--      hoặc cancelled). request_id duy nhất theo (organization_id, request_id) chống tạo trùng.
--      Chỉ đọc/ghi qua RPC (authenticated không có quyền bảng; worker service_role chỉ SELECT).
--  (2) public.zalo_hen_gui_phong_trong_v1 (tạo: gửi ngay khi p_run_at NULL, hoặc hẹn ≤ 30 ngày),
--      public.zalo_huy_hen_gui_phong_trong_v1 (huỷ lượt chưa chạy), public.zalo_ds_hen_gui_phong_trong_v1
--      (liệt kê). Cần chat_zalo.manage_automation VÀ chat_zalo.send. Người nhận phải là NHÓM
--      (thread_type='group') ĐÃ đánh dấu sale (is_sale_partner) thuộc tài khoản cá nhân của công ty —
--      chặt hơn RecipientPicker (nhóm HOẶC sale): chủ chốt không gửi khách lẻ.
--      Từ chối có mã (ok=false, code) để Hermes đề nghị cách khác: ngoai_khung_gio (kèm khung giờ và
--      goi_y_run_at), het_tran_ngay, dang_dung_khan_cap, nguoi_nhan_khong_hop_le, ...
--      KHÔNG áp skipIfUnchanged cho lượt chủ động; vẫn giữ khung giờ, giãn nhịp, trần ngày.
--  (3) Worker (service_role): zalo_worker_claim_oneshot_v1 (khoá lease + khoá công ty, chiếm một lần;
--      lượt "running" của instance đã chết được chiếm lại với cùng khoá yêu cầu ⇒ không gửi trùng;
--      quá 180 phút sau giờ hẹn hoặc sang ngày khác ⇒ failed, không gửi bù),
--      zalo_enqueue_broadcast_oneshot_v1 (bản lượt-một-lần của zalo_enqueue_broadcast_v1: cùng khoá
--      công ty, khung giờ, trần ngày, khoá trùng tin; thay điều kiện enabled/config.recipients bằng
--      lượt đang running do đúng instance giữ), zalo_worker_finish_oneshot_v1.
--  (4) zalo_worker_begin_provider_v1: job mang payload.oneshot_id được nhận khi lượt chưa bị huỷ và
--      hội thoại vẫn là nhóm sale trong danh sách lượt; job định kỳ giữ nguyên điều kiện cũ.
--  (5) zalo_dung_khan_cap: huỷ thêm mọi lượt một lần queued/running. Dừng khẩn cấp còn hiệu lực
--      (chặn tạo lượt mới) tới khi người quản lý lưu lại cấu hình gửi phòng trống
--      (zalo_automations.updated_at của dòng broadcast_vacant mới hơn nhật ký mode='stopped').
-- Không đổi chữ ký/kiểu trả về hàm đã phát hành (CREATE OR REPLACE giữ owner/GRANT). Hai hàm vá
-- được kiểm sha thân trước khi thay (bản đã phát hành hoặc chính bản này). Không ghi dữ liệu cũ.
-- Mọi tham chiếu tới bảng zalo_* nằm trong thân plpgsql ⇒ chạy được trên baseline của diễn tập.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- ---------------------------------------------------------------------------
-- 1. Bảng lượt gửi một lần
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.zalo_automation_oneshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kind                text NOT NULL DEFAULT 'broadcast_vacant' CHECK (kind='broadcast_vacant'),
  recipients          uuid[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 50 AND array_position(recipients,NULL::uuid) IS NULL),
  mode                text NOT NULL DEFAULT 'full' CHECK (mode IN ('full','compact')),
  run_at              timestamptz NOT NULL,
  send_now            boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','cancelled','failed')),
  origin              text NOT NULL DEFAULT 'ui' CHECK (origin IN ('ui','hermes')),
  created_by          uuid NOT NULL,
  request_id          text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  request_fingerprint text NOT NULL,
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  claimed_by_instance uuid,
  started_at          timestamptz,
  finished_at         timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid,
  result              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result)='object'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT zalo_automation_oneshots_request_uniq UNIQUE (organization_id,request_id)
);
COMMENT ON TABLE public.zalo_automation_oneshots IS
  'Lượt gửi ảnh phòng trống MỘT LẦN (gửi ngay/hẹn giờ) chạy bằng bộ máy gửi định kỳ. Chỉ qua RPC zalo_hen_gui_phong_trong_v1/zalo_huy_hen_gui_phong_trong_v1/zalo_ds_hen_gui_phong_trong_v1 và RPC worker.';
COMMENT ON COLUMN public.zalo_automation_oneshots.request_fingerprint IS
  'md5(mode|người nhận đã sắp|run_at hoặc now): cùng request_id + cùng dấu ⇒ trả lại lượt cũ; khác dấu ⇒ 23505.';
CREATE INDEX IF NOT EXISTS zalo_automation_oneshots_due_idx
  ON public.zalo_automation_oneshots(run_at) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS zalo_automation_oneshots_org_created_idx
  ON public.zalo_automation_oneshots(organization_id,created_at DESC);

DROP TRIGGER IF EXISTS trg_autofill_org_strict ON public.zalo_automation_oneshots;
CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.zalo_automation_oneshots
  FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();

ALTER TABLE public.zalo_automation_oneshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zalo_automation_oneshots FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.zalo_automation_oneshots TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Helper riêng (không ai ngoài hàm DEFINER gọi được)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.zalo_oneshot_json_v1(r public.zalo_automation_oneshots)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'pg_catalog','public' AS $fn$
  SELECT jsonb_build_object('id',r.id,'organization_id',r.organization_id,'status',r.status,'mode',r.mode,
    'run_at',r.run_at,'send_now',r.send_now,'recipients',to_jsonb(r.recipients),'origin',r.origin,
    'request_id',r.request_id,'created_by',r.created_by,'created_at',r.created_at,'started_at',r.started_at,
    'attempts',r.attempts,'finished_at',r.finished_at,'cancelled_at',r.cancelled_at,'result',r.result)
$fn$;

-- Khung giờ đọc ĐÚNG luật của app_private.zalo_in_allowed_hours_v1 (regex + mặc định 08:00–20:00)
-- và mốc bắt đầu khung kế tiếp sau p_after (giờ Việt Nam) để gợi ý hẹn giờ.
CREATE OR REPLACE FUNCTION app_private.zalo_oneshot_khung_gio_v1(p_config jsonb,p_after timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO 'pg_catalog' AS $fn$
DECLARE f text:=p_config#>>'{antiSpam,allowedHours,from}'; t text:=p_config#>>'{antiSpam,allowedHours,to}'; v_next timestamptz;
BEGIN
  IF f IS NULL OR f !~ '^([01]?[0-9]|2[0-3]):([0-5]?[0-9])$' THEN f:='08:00'; END IF;
  IF t IS NULL OR t !~ '^([01]?[0-9]|2[0-3]):([0-5]?[0-9])$' THEN t:='20:00'; END IF;
  v_next:=(date_trunc('day',p_after AT TIME ZONE 'Asia/Ho_Chi_Minh')
    +make_interval(hours=>split_part(f,':',1)::int,mins=>split_part(f,':',2)::int)) AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF v_next<=p_after THEN v_next:=v_next+interval '1 day'; END IF;
  RETURN jsonb_build_object('from',lpad(split_part(f,':',1),2,'0')||':'||lpad(split_part(f,':',2),2,'0'),
    'to',lpad(split_part(t,':',1),2,'0')||':'||lpad(split_part(t,':',2),2,'0'),'next_start',v_next);
END $fn$;

-- Dừng khẩn cấp còn hiệu lực: nhật ký 'stopped' mới nhất KHÔNG cũ hơn lần lưu cấu hình gửi phòng
-- trống gần nhất. zalo_dung_khan_cap đặt updated_at và ghi nhật ký trong cùng giao dịch (bằng nhau);
-- worker chỉ ghi sổ dòng đang bật nên không thể tự gỡ trạng thái này.
CREATE OR REPLACE FUNCTION app_private.zalo_dang_dung_khan_cap_v1(p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE v_stop timestamptz; v_save timestamptz;
BEGIN
  SELECT max(r.created_at) INTO v_stop FROM public.zalo_automation_runs r
   WHERE r.organization_id=p_org AND r.kind='broadcast_vacant' AND r.mode='stopped';
  IF v_stop IS NULL THEN RETURN false; END IF;
  SELECT a.updated_at INTO v_save FROM public.zalo_automations a WHERE a.organization_id=p_org AND a.kind='broadcast_vacant';
  RETURN v_save IS NULL OR v_save<=v_stop;
END $fn$;

-- Đếm tin tự động (không phải auto-reply) đã xếp trong ngày giờ VN — đúng công thức trần của
-- zalo_enqueue_broadcast_v1.
CREATE OR REPLACE FUNCTION app_private.zalo_oneshot_tin_hom_nay_v1(p_org uuid,p_now timestamptz)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE v_day timestamptz:=date_trunc('day',p_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'; v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.zalo_send_queue WHERE organization_id=p_org AND payload ? 'tu_dong'
    AND NOT COALESCE(payload->>'auto_reply'='true',false) AND created_at>=v_day AND created_at<v_day+interval '1 day';
  RETURN v_count;
END $fn$;

REVOKE ALL ON FUNCTION app_private.zalo_oneshot_json_v1(public.zalo_automation_oneshots),
  app_private.zalo_oneshot_khung_gio_v1(jsonb,timestamptz),app_private.zalo_dang_dung_khan_cap_v1(uuid),
  app_private.zalo_oneshot_tin_hom_nay_v1(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 3. RPC người dùng / Hermes (JWT authenticated)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_hen_gui_phong_trong_v1(
  p_recipients uuid[],
  p_mode text DEFAULT 'full',
  p_run_at timestamptz DEFAULT NULL,
  p_request_id text DEFAULT NULL,
  p_origin text DEFAULT 'ui',
  p_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE v_uid uuid:=auth.uid(); v_org uuid:=p_organization_id; v_orgs uuid[];
  v_mode text:=lower(btrim(COALESCE(p_mode,'full'))); v_origin text:=lower(btrim(COALESCE(p_origin,'ui')));
  v_req text:=btrim(COALESCE(p_request_id,'')); v_now timestamptz:=clock_timestamp(); v_run timestamptz;
  v_ids uuid[]; v_bad uuid[]; v_fp text; v_row public.zalo_automation_oneshots; a public.zalo_automations;
  v_day timestamptz; v_cap integer; v_count integer; v_khung jsonb; v_open integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('manage_automation') o;
    IF array_length(v_orgs,1) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Cần chọn tổ chức' USING ERRCODE='22023'; END IF;
    v_org:=v_orgs[1];
  END IF;
  IF NOT public.zalo_can('manage_automation',v_org) OR NOT public.zalo_can('send',v_org) THEN
    RAISE EXCEPTION 'Bạn không có quyền gửi tự động trong tổ chức này' USING ERRCODE='42501'; END IF;
  IF v_mode NOT IN ('full','compact') THEN RAISE EXCEPTION 'Chế độ gửi phải là full hoặc compact' USING ERRCODE='22023'; END IF;
  IF v_origin NOT IN ('ui','hermes') THEN RAISE EXCEPTION 'Nguồn tạo phải là ui hoặc hermes' USING ERRCODE='22023'; END IF;
  IF v_req='' OR length(v_req)>200 THEN RAISE EXCEPTION 'Thiếu mã yêu cầu (request_id ≤ 200 ký tự) để chống tạo trùng' USING ERRCODE='22023'; END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(COALESCE(p_recipients,'{}'::uuid[])) x WHERE x IS NOT NULL;
  IF v_ids IS NULL OR cardinality(v_ids)>50 THEN RAISE EXCEPTION 'Chọn từ 1 đến 50 nhóm nhận' USING ERRCODE='22023'; END IF;
  IF p_run_at IS NOT NULL AND (p_run_at<v_now-interval '5 minutes' OR p_run_at>v_now+interval '30 days') THEN
    RAISE EXCEPTION 'Giờ hẹn phải nằm trong 30 ngày tới' USING ERRCODE='22023'; END IF;
  v_fp:=md5(concat_ws('|',v_mode,array_to_string(v_ids,','),
    COALESCE(to_char(p_run_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),'now')));

  -- Cùng khoá với dừng khẩn cấp và xếp hàng: lượt tạo song song với nút dừng không lọt qua.
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  SELECT * INTO v_row FROM public.zalo_automation_oneshots WHERE organization_id=v_org AND request_id=v_req;
  IF FOUND THEN
    IF v_row.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho một lượt gửi khác' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('ok',true,'reused',true,'oneshot',app_private.zalo_oneshot_json_v1(v_row));
  END IF;

  IF app_private.zalo_dang_dung_khan_cap_v1(v_org) THEN
    RETURN jsonb_build_object('ok',false,'code','dang_dung_khan_cap',
      'reason','Tự động hoá Zalo đang DỪNG KHẨN CẤP. Người quản lý cần mở cài đặt gửi phòng trống và lưu lại trước khi gửi tiếp.');
  END IF;

  SELECT array_agg(x ORDER BY x) INTO v_bad FROM unnest(v_ids) x
   WHERE NOT EXISTS(SELECT 1 FROM public.zalo_conversations c
     JOIN public.zalo_accounts z ON z.id=c.account_id AND z.organization_id=c.organization_id AND z.kind='personal'
     WHERE c.id=x AND c.organization_id=v_org AND c.thread_type='group' AND c.is_sale_partner);
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','nguoi_nhan_khong_hop_le','nguoi_nhan_loi',to_jsonb(v_bad),
      'reason','Chỉ gửi tới nhóm Zalo của công ty đã đánh dấu sale; có '||cardinality(v_bad)||' hội thoại không hợp lệ.');
  END IF;

  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=v_org AND kind='broadcast_vacant';
  v_run:=COALESCE(p_run_at,v_now);
  IF NOT app_private.zalo_in_allowed_hours_v1(v_run,a.config) THEN
    v_khung:=app_private.zalo_oneshot_khung_gio_v1(a.config,greatest(v_run,v_now));
    RETURN jsonb_build_object('ok',false,'code','ngoai_khung_gio',
      'khung_gio',jsonb_build_object('from',v_khung->>'from','to',v_khung->>'to'),'goi_y_run_at',v_khung->'next_start',
      'reason',format('Ngoài khung giờ được phép gửi %s–%s (giờ Việt Nam). Hãy hẹn giờ trong khung.',v_khung->>'from',v_khung->>'to'));
  END IF;

  v_day:=date_trunc('day',v_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF v_run<v_day+interval '1 day' THEN
    v_cap:=app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000);
    v_count:=app_private.zalo_oneshot_tin_hom_nay_v1(v_org,v_now);
    IF v_count>=v_cap THEN
      v_khung:=app_private.zalo_oneshot_khung_gio_v1(a.config,v_day+interval '1 day'-interval '1 microsecond');
      RETURN jsonb_build_object('ok',false,'code','het_tran_ngay','tran_ngay',v_cap,'da_xep',v_count,'goi_y_run_at',v_khung->'next_start',
        'reason',format('Đã chạm trần %s tin tự động hôm nay. Hãy hẹn sang ngày khác.',v_cap));
    END IF;
  END IF;

  IF p_run_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.zalo_conversations c JOIN public.zalo_accounts z ON z.id=c.account_id
      WHERE c.id=ANY(v_ids) AND z.organization_id=v_org AND z.kind='personal' AND z.status='connected') THEN
    RETURN jsonb_build_object('ok',false,'code','tai_khoan_chua_ket_noi',
      'reason','Tài khoản Zalo của các nhóm này chưa kết nối nên chưa gửi ngay được.');
  END IF;

  SELECT count(*) INTO v_open FROM public.zalo_automation_oneshots WHERE organization_id=v_org AND status IN ('queued','running');
  IF v_open>=20 THEN
    RETURN jsonb_build_object('ok',false,'code','qua_nhieu_luot_cho',
      'reason','Đang có 20 lượt gửi một lần chờ chạy. Huỷ bớt hoặc chờ các lượt đó chạy xong.');
  END IF;

  INSERT INTO public.zalo_automation_oneshots(organization_id,recipients,mode,run_at,send_now,origin,created_by,request_id,request_fingerprint)
  VALUES(v_org,v_ids,v_mode,v_run,p_run_at IS NULL,v_origin,v_uid,v_req,v_fp) RETURNING * INTO v_row;
  RETURN jsonb_build_object('ok',true,'reused',false,'oneshot',app_private.zalo_oneshot_json_v1(v_row));
END $fn$;

CREATE OR REPLACE FUNCTION public.zalo_huy_hen_gui_phong_trong_v1(p_oneshot_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE v_uid uuid:=auth.uid(); v_org uuid; v_row public.zalo_automation_oneshots;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO v_org FROM public.zalo_automation_oneshots WHERE id=p_oneshot_id;
  -- Không lộ lượt của công ty khác: không thấy và không có quyền trả cùng một lỗi.
  IF v_org IS NULL OR NOT public.zalo_can('manage_automation',v_org) THEN
    RAISE EXCEPTION 'Không tìm thấy lượt hẹn hoặc bạn không có quyền' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  SELECT * INTO v_row FROM public.zalo_automation_oneshots WHERE id=p_oneshot_id FOR UPDATE;
  IF v_row.status='cancelled' THEN
    RETURN jsonb_build_object('ok',true,'reused',true,'oneshot',app_private.zalo_oneshot_json_v1(v_row)); END IF;
  IF v_row.status<>'queued' THEN
    RETURN jsonb_build_object('ok',false,'code','da_chay','oneshot',app_private.zalo_oneshot_json_v1(v_row),
      'reason','Lượt này đã chạy (trạng thái '||v_row.status||'). Muốn chặn tin còn chờ thì dùng Dừng khẩn cấp.');
  END IF;
  UPDATE public.zalo_automation_oneshots SET status='cancelled',cancelled_at=clock_timestamp(),cancelled_by=v_uid,
    updated_at=clock_timestamp(),result=result||jsonb_build_object('code','huy_boi_nguoi_dung','reason','Người dùng huỷ lượt hẹn')
   WHERE id=p_oneshot_id RETURNING * INTO v_row;
  RETURN jsonb_build_object('ok',true,'reused',false,'oneshot',app_private.zalo_oneshot_json_v1(v_row));
END $fn$;

CREATE OR REPLACE FUNCTION public.zalo_ds_hen_gui_phong_trong_v1(p_organization_id uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE v_org uuid:=p_organization_id; v_orgs uuid[]; v_limit integer:=least(greatest(COALESCE(p_limit,20),1),100);
  a public.zalo_automations; v_khung jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('view') o;
    IF array_length(v_orgs,1) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Cần chọn tổ chức' USING ERRCODE='22023'; END IF;
    v_org:=v_orgs[1];
  END IF;
  IF NOT public.zalo_can('view',v_org) THEN RAISE EXCEPTION 'Bạn không có quyền xem tự động hoá trong tổ chức này' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=v_org AND kind='broadcast_vacant';
  v_khung:=app_private.zalo_oneshot_khung_gio_v1(a.config,clock_timestamp());
  RETURN jsonb_build_object(
    'organization_id',v_org,
    'dang_dung_khan_cap',app_private.zalo_dang_dung_khan_cap_v1(v_org),
    'lich_dinh_ky_bat',COALESCE(a.enabled,false),
    'khung_gio',jsonb_build_object('from',v_khung->>'from','to',v_khung->>'to'),
    'tran_ngay',app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000),
    'da_xep_hom_nay',app_private.zalo_oneshot_tin_hom_nay_v1(v_org,clock_timestamp()),
    -- Lượt chờ chạy trước (theo giờ hẹn), rồi lượt gần nhất.
    'items',COALESCE((SELECT jsonb_agg(app_private.zalo_oneshot_json_v1(s) ORDER BY l.ord)
      FROM (SELECT o.id,row_number() OVER (ORDER BY o.status IN ('queued','running') DESC,
                CASE WHEN o.status IN ('queued','running') THEN o.run_at END ASC,o.created_at DESC,o.id) AS ord
              FROM public.zalo_automation_oneshots o WHERE o.organization_id=v_org ORDER BY ord LIMIT v_limit) l
      JOIN public.zalo_automation_oneshots s ON s.id=l.id),'[]'::jsonb));
END $fn$;

REVOKE ALL ON FUNCTION public.zalo_hen_gui_phong_trong_v1(uuid[],text,timestamptz,text,text,uuid),
  public.zalo_huy_hen_gui_phong_trong_v1(uuid),public.zalo_ds_hen_gui_phong_trong_v1(uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.zalo_hen_gui_phong_trong_v1(uuid[],text,timestamptz,text,text,uuid),
  public.zalo_huy_hen_gui_phong_trong_v1(uuid),public.zalo_ds_hen_gui_phong_trong_v1(uuid,integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. RPC worker (service_role). Thứ tự khoá như hàng đợi: lease → khoá công ty → dòng.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_worker_claim_oneshot_v1(p_instance_id uuid,p_organization_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE v_now timestamptz:=clock_timestamp(); v_id uuid; v_org uuid; r public.zalo_automation_oneshots;
  a public.zalo_automations; v_cap integer; v_try integer:=0; v_code text; v_reason text;
BEGIN
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>v_now-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','lease_lost'); END IF;
  LOOP
    v_try:=v_try+1;
    IF v_try>5 THEN RETURN jsonb_build_object('status','none'); END IF;
    v_id:=NULL;
    -- "running" của instance khác = instance đã mất lease (lease là singleton): chiếm lại và
    -- chạy lại với CÙNG khoá yêu cầu ⇒ tin đã xếp được dùng lại, không gửi trùng.
    SELECT o.id,o.organization_id INTO v_id,v_org FROM public.zalo_automation_oneshots o
     WHERE o.run_at<=v_now AND (o.status='queued' OR (o.status='running' AND o.claimed_by_instance IS DISTINCT FROM p_instance_id))
       AND (p_organization_ids IS NULL OR cardinality(p_organization_ids)=0 OR o.organization_id=ANY(p_organization_ids))
     ORDER BY o.run_at,o.id LIMIT 1;
    IF v_id IS NULL THEN RETURN jsonb_build_object('status','none'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
    SELECT * INTO r FROM public.zalo_automation_oneshots WHERE id=v_id FOR UPDATE;
    EXIT WHEN r.status='queued' OR (r.status='running' AND r.claimed_by_instance IS DISTINCT FROM p_instance_id);
  END LOOP;

  IF (r.run_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date<>(v_now AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
     OR v_now-r.run_at>interval '180 minutes' THEN
    v_code:='qua_han'; v_reason:='Worker không chạy kịp trong ngày và trong 180 phút sau giờ hẹn; không gửi bù.';
  ELSIF r.attempts>=3 THEN
    v_code:='qua_so_lan_thu'; v_reason:='Đã thử chạy lượt này 3 lần mà chưa chốt được; dừng để không gửi lặp.';
  END IF;
  IF v_code IS NOT NULL THEN
    UPDATE public.zalo_automation_oneshots SET status='failed',finished_at=v_now,updated_at=v_now,
      result=result||jsonb_build_object('code',v_code,'reason',v_reason) WHERE id=r.id RETURNING * INTO r;
    RETURN jsonb_build_object('status','expired','code',v_code,'reason',v_reason,'oneshot',app_private.zalo_oneshot_json_v1(r));
  END IF;

  UPDATE public.zalo_automation_oneshots SET status='running',attempts=attempts+1,claimed_by_instance=p_instance_id,
    started_at=COALESCE(started_at,v_now),updated_at=v_now WHERE id=r.id RETURNING * INTO r;
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=r.organization_id AND kind='broadcast_vacant';
  v_cap:=app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000);
  RETURN jsonb_build_object('status','claimed','oneshot',app_private.zalo_oneshot_json_v1(r),
    'config',COALESCE(a.config,'{}'::jsonb),'con_lai',greatest(0,v_cap-app_private.zalo_oneshot_tin_hom_nay_v1(r.organization_id,v_now)));
END $fn$;

CREATE OR REPLACE FUNCTION public.zalo_worker_finish_oneshot_v1(p_oneshot_id uuid,p_instance_id uuid,p_ok boolean,p_result jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE v_now timestamptz:=clock_timestamp(); v_org uuid; r public.zalo_automation_oneshots; v_result jsonb:=COALESCE(p_result,'{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_result)<>'object' OR length(v_result::text)>20000 OR p_ok IS NULL THEN
    RAISE EXCEPTION 'Kết quả lượt gửi không hợp lệ' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>v_now-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','lease_lost'); END IF;
  SELECT organization_id INTO v_org FROM public.zalo_automation_oneshots WHERE id=p_oneshot_id;
  IF v_org IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','missing'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  SELECT * INTO r FROM public.zalo_automation_oneshots WHERE id=p_oneshot_id FOR UPDATE;
  IF r.claimed_by_instance IS DISTINCT FROM p_instance_id THEN RETURN jsonb_build_object('ok',false,'reason','claim_changed','status',r.status); END IF;
  IF r.status='running' THEN
    UPDATE public.zalo_automation_oneshots SET status=CASE WHEN p_ok THEN 'done' ELSE 'failed' END,finished_at=v_now,updated_at=v_now,
      result=v_result WHERE id=r.id RETURNING * INTO r;
    RETURN jsonb_build_object('ok',true,'status',r.status);
  END IF;
  IF r.status='cancelled' THEN
    -- Dừng khẩn cấp giữa lượt: giữ trạng thái huỷ, chỉ lưu phần worker đã kịp làm để đối soát.
    UPDATE public.zalo_automation_oneshots SET finished_at=COALESCE(finished_at,v_now),updated_at=v_now,
      result=result||jsonb_build_object('truoc_khi_huy',v_result) WHERE id=r.id;
    RETURN jsonb_build_object('ok',false,'reason','cancelled','status','cancelled');
  END IF;
  RETURN jsonb_build_object('ok',false,'reason','claim_changed','status',r.status);
END $fn$;

-- Bản lượt-một-lần của zalo_enqueue_broadcast_v1 (20261012012329): cùng kiểm nội dung/album,
-- khoá công ty, khoá trùng tin, ngày, khung giờ, trần ngày, kiểm từng ảnh; khác ở điều kiện
-- nhận: lượt đang running do đúng instance giữ + hội thoại là nhóm sale trong danh sách lượt.
CREATE OR REPLACE FUNCTION public.zalo_enqueue_broadcast_oneshot_v1(p_oneshot_id uuid,p_instance_id uuid,p_conversation_id uuid,
  p_body text,p_not_before timestamptz,p_request_key text,p_attachment jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $fn$
DECLARE c public.zalo_conversations; a public.zalo_automations; o public.zalo_automation_oneshots; v_msg uuid; v_job uuid; v_payload jsonb;
  v_now timestamptz:=clock_timestamp(); v_day timestamptz; v_count integer; v_cap integer; v_reason text; v_key text; v_attachments jsonb;
  v_attachment jsonb; v_ids jsonb:='[]'; v_item uuid; v_index integer:=0;
BEGIN
  IF (btrim(COALESCE(p_body,''))='' AND p_attachment IS NULL) OR length(p_body)>20000 OR p_not_before IS NULL OR p_oneshot_id IS NULL
    OR btrim(COALESCE(p_request_key,''))='' OR length(p_request_key)>300
    OR left(p_request_key,length('oneshot:'||p_oneshot_id::text||':'))<>'oneshot:'||p_oneshot_id::text||':' THEN
    RAISE EXCEPTION 'Nội dung gửi một lần không hợp lệ' USING ERRCODE='22023'; END IF;
  v_attachments:=CASE WHEN p_attachment IS NULL THEN '[]'::jsonb
    WHEN jsonb_typeof(p_attachment)='object' THEN jsonb_build_array(p_attachment)
    WHEN jsonb_typeof(p_attachment)='array' THEN p_attachment ELSE NULL END;
  IF v_attachments IS NULL OR (p_attachment IS NOT NULL AND jsonb_array_length(v_attachments) NOT BETWEEN 1 AND 12)
    OR (jsonb_typeof(p_attachment)='array' AND btrim(COALESCE(p_body,''))<>'') THEN
    RAISE EXCEPTION 'Album cần 1–12 ảnh và tin thông tin riêng' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||c.organization_id::text,0));
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id FOR SHARE;
  v_key:='automation:broadcast:'||p_request_key;
  SELECT id INTO v_msg FROM public.zalo_messages WHERE conversation_id=c.id AND client_dedup_key=v_key;
  IF FOUND THEN
    SELECT id INTO v_job FROM public.zalo_send_queue WHERE message_id=v_msg
      AND payload->>'automation_request_key'=p_request_key ORDER BY created_at,id LIMIT 1;
    RETURN jsonb_build_object('status','queued','reused',true,'message_id',v_msg,'job_id',v_job,'reason','Tin này đã được xếp hàng');
  END IF;
  SELECT * INTO o FROM public.zalo_automation_oneshots WHERE id=p_oneshot_id;
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=c.organization_id AND kind='broadcast_vacant' FOR SHARE;
  IF o.id IS NULL OR o.organization_id IS DISTINCT FROM c.organization_id THEN v_reason:='Lượt gửi không thuộc công ty của hội thoại';
  ELSIF o.status<>'running' OR o.claimed_by_instance IS DISTINCT FROM p_instance_id THEN v_reason:='Lượt gửi đã bị huỷ hoặc không còn do worker này giữ';
  ELSIF NOT (c.id=ANY(o.recipients)) THEN v_reason:='Hội thoại không nằm trong danh sách của lượt gửi';
  ELSIF c.thread_type IS DISTINCT FROM 'group' OR NOT c.is_sale_partner THEN v_reason:='Hội thoại không còn là nhóm sale';
  ELSIF NOT EXISTS(SELECT 1 FROM public.zalo_accounts x WHERE x.id=c.account_id AND x.organization_id=c.organization_id AND x.kind='personal' AND x.status='connected') THEN v_reason:='Tài khoản chưa kết nối'; END IF;
  v_day:=date_trunc('day',v_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF v_reason IS NULL AND (p_not_before<v_day OR p_not_before>=v_day+interval '1 day') THEN v_reason:='Lịch gửi đã hết hạn trong ngày'; END IF;
  IF v_reason IS NULL AND (NOT app_private.zalo_in_allowed_hours_v1(p_not_before,a.config) OR NOT app_private.zalo_in_allowed_hours_v1(v_now,a.config)) THEN v_reason:='Ngoài khung giờ được phép'; END IF;
  v_cap:=app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000);
  SELECT count(*) INTO v_count FROM public.zalo_send_queue WHERE organization_id=c.organization_id AND payload ? 'tu_dong'
    AND NOT COALESCE(payload->>'auto_reply'='true',false) AND created_at>=v_day AND created_at<v_day+interval '1 day';
  IF v_reason IS NULL AND v_count>=v_cap THEN v_reason:='Đã chạm trần gửi phòng trống trong ngày'; END IF;
  IF v_reason IS NOT NULL THEN RETURN jsonb_build_object('status','skipped','reason',v_reason); END IF;
  FOR v_attachment IN SELECT jsonb_array_elements(v_attachments) LOOP
    PERFORM app_private.zalo_assert_attachment_v1(c.account_id,v_attachment);
  END LOOP;
  IF jsonb_array_length(v_attachments)=0 THEN
    INSERT INTO public.zalo_messages(user_id,organization_id,conversation_id,account_id,direction,msg_type,body,status,sent_at,client_dedup_key)
      VALUES(c.user_id,c.organization_id,c.id,c.account_id,'out','text',p_body,'pending',v_now,v_key) RETURNING id INTO v_msg;
  ELSE
    FOR v_attachment IN SELECT jsonb_array_elements(v_attachments) LOOP
      INSERT INTO public.zalo_messages(user_id,organization_id,conversation_id,account_id,direction,msg_type,body,media_url,media_meta,status,sent_at,created_at,client_dedup_key)
        VALUES(c.user_id,c.organization_id,c.id,c.account_id,'out','image',COALESCE(p_body,''),v_attachment->>'url',
          (v_attachment-'url')||jsonb_build_object('tu_dong',true,'automation_album_key',v_key,'album_index',v_index,'album_count',jsonb_array_length(v_attachments)),
          'pending',v_now,clock_timestamp(),CASE WHEN v_index=0 THEN v_key ELSE v_key||':image:'||v_index END) RETURNING id INTO v_item;
      IF v_index=0 THEN v_msg:=v_item; END IF;
      v_ids:=v_ids||jsonb_build_array(v_item); v_index:=v_index+1;
    END LOOP;
  END IF;
  v_payload:=jsonb_build_object('body',p_body,'tu_dong',true,'automation_request_key',p_request_key,'oneshot_id',o.id);
  IF jsonb_array_length(v_attachments)>0 THEN
    v_payload:=v_payload||jsonb_build_object('type','image','attachments',v_attachments,'message_ids',v_ids);
  END IF;
  INSERT INTO public.zalo_send_queue(user_id,organization_id,conversation_id,account_id,message_id,channel,payload,status,not_before)
    VALUES(c.user_id,c.organization_id,c.id,c.account_id,v_msg,'personal',v_payload,'queued',greatest(v_now,p_not_before)) RETURNING id INTO v_job;
  UPDATE public.zalo_conversations SET last_message_text=COALESCE(NULLIF(p_body,''),'[Hình ảnh]'),last_message_at=v_now,last_message_dir='out' WHERE id=c.id;
  RETURN jsonb_build_object('status','queued','reused',false,'reason','Đã xếp hàng gửi phòng trống một lần','message_id',v_msg,'job_id',v_job);
END $fn$;

REVOKE ALL ON FUNCTION public.zalo_worker_claim_oneshot_v1(uuid,uuid[]),public.zalo_worker_finish_oneshot_v1(uuid,uuid,boolean,jsonb),
  public.zalo_enqueue_broadcast_oneshot_v1(uuid,uuid,uuid,text,timestamptz,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_claim_oneshot_v1(uuid,uuid[]),public.zalo_worker_finish_oneshot_v1(uuid,uuid,boolean,jsonb),
  public.zalo_enqueue_broadcast_oneshot_v1(uuid,uuid,uuid,text,timestamptz,text,jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Hai hàm đã phát hành: chỉ thay khi thân hiện tại đúng bản đã rà (hoặc chính bản này).
-- ---------------------------------------------------------------------------
DO $attest$
DECLARE v_sha text;
BEGIN
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO v_sha
    FROM pg_proc WHERE oid=to_regprocedure('public.zalo_worker_begin_provider_v1(uuid,uuid)');
  IF v_sha IS NULL THEN RAISE EXCEPTION 'missing public.zalo_worker_begin_provider_v1'; END IF;
  IF v_sha NOT IN ('73deb1cf865ce3b77369e8203051cb34b58dc046f5efc95f3a8bea9a8b99ad65','c832f76d03cbb7860dc479117975ede658d831615d7e038d73cc11f6c99a01fa') THEN
    RAISE EXCEPTION 'unexpected public.zalo_worker_begin_provider_v1 source %',v_sha; END IF;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO v_sha
    FROM pg_proc WHERE oid=to_regprocedure('public.zalo_dung_khan_cap(uuid)');
  -- Vắng hàm chỉ xảy ra trên baseline diễn tập (20260831015222 dừng dây chuyền ở đó): tạo mới.
  IF v_sha IS NOT NULL AND v_sha NOT IN ('fb30f97b633485f20229fb6235f8feeb3312ef0f7a15221457b5735af810ebab','d6620d953bbeb6d48e2c9c85063771de33471d464288cf3e164a21e01d828fb7') THEN
    RAISE EXCEPTION 'unexpected public.zalo_dung_khan_cap source %',v_sha; END IF;
END $attest$;

-- Thân 20261011052259 + dòng Hermes của 20261013170125; thêm nhánh payload.oneshot_id.
CREATE OR REPLACE FUNCTION public.zalo_worker_begin_provider_v1(p_job_id uuid,p_instance_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE q public.zalo_send_queue; c public.zalo_conversations; a public.zalo_automations; o public.zalo_automation_oneshots;
  v_kind text; v_now timestamptz:=clock_timestamp(); v_day timestamptz; v_cap int; v_count int; v_org uuid; v_oneshot uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM app_private.hermes_group_jobs WHERE job_id=p_job_id) THEN RETURN false; END IF;
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id AND heartbeat_at>v_now-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT organization_id INTO v_org FROM public.zalo_send_queue WHERE id=p_job_id;
  IF v_org IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  SELECT * INTO q FROM public.zalo_send_queue WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR q.status<>'processing' OR q.processing_instance_id IS DISTINCT FROM p_instance_id THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.zalo_accounts x WHERE x.id=q.account_id AND x.organization_id=q.organization_id AND x.status='connected') THEN RETURN false; END IF;
  IF q.payload ? 'tu_dong' THEN
    v_kind:=CASE WHEN q.payload->>'auto_reply'='true' THEN 'auto_reply' ELSE 'broadcast_vacant' END;
    SELECT * INTO a FROM public.zalo_automations WHERE organization_id=q.organization_id AND kind=v_kind FOR SHARE;
    SELECT * INTO c FROM public.zalo_conversations WHERE id=q.conversation_id;
    IF c.id IS NULL OR c.account_id IS DISTINCT FROM q.account_id OR c.organization_id IS DISTINCT FROM q.organization_id THEN RETURN false; END IF;
    IF v_kind='broadcast_vacant' AND q.payload ? 'oneshot_id' THEN
      -- Lượt một lần tự là căn cứ gửi: không cần công tắc lịch hay config.recipients.
      BEGIN v_oneshot:=(q.payload->>'oneshot_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
      SELECT * INTO o FROM public.zalo_automation_oneshots WHERE id=v_oneshot;
      IF o.id IS NULL OR o.organization_id IS DISTINCT FROM q.organization_id OR o.status NOT IN ('running','done','failed')
        OR NOT (c.id=ANY(o.recipients)) OR c.thread_type IS DISTINCT FROM 'group' OR NOT c.is_sale_partner THEN RETURN false; END IF;
    ELSIF a.id IS NULL OR NOT a.enabled OR (v_kind='auto_reply' AND NOT c.is_sale_partner) THEN RETURN false;
    ELSIF v_kind='broadcast_vacant' AND NOT COALESCE(a.config->'recipients' ? c.id::text,false) THEN RETURN false;
    END IF;
    v_day:=date_trunc('day',v_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
    IF v_kind='broadcast_vacant' AND (q.created_at<v_day OR q.created_at>=v_day+interval '1 day') THEN RETURN false; END IF;
    IF v_kind='broadcast_vacant' AND NOT app_private.zalo_in_allowed_hours_v1(v_now,a.config) THEN RETURN false; END IF;
    v_cap:=CASE WHEN v_kind='auto_reply' THEN app_private.zalo_config_int_v1(a.config->'dailyCap',50,1000)
      ELSE app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000) END;
    IF q.provider_started_at IS NULL THEN
      SELECT count(*) INTO v_count FROM public.zalo_send_queue x WHERE x.organization_id=q.organization_id AND x.payload ? 'tu_dong'
        AND CASE WHEN v_kind='auto_reply' THEN COALESCE(x.payload->>'auto_reply'='true',false) ELSE NOT COALESCE(x.payload->>'auto_reply'='true',false) END
        AND x.provider_started_at>=v_day AND x.provider_started_at<v_day+interval '1 day';
      IF v_count>=v_cap THEN RETURN false; END IF;
    END IF;
  END IF;
  UPDATE public.zalo_send_queue SET provider_started_at=COALESCE(provider_started_at,v_now) WHERE id=q.id;
  RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_begin_provider_v1(uuid,uuid) TO service_role;

-- Thân 20261011052259; thêm huỷ lượt một lần queued/running và khoá 'hen_gio_huy' trong kết quả.
CREATE OR REPLACE FUNCTION public.zalo_dung_khan_cap(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_org uuid:=p_organization_id; v_orgs uuid[]; v_jobs uuid[]; v_msgs uuid[]; v_jobs_count int:=0; v_msgs_count int:=0; v_processing int:=0; v_acc uuid;
  v_shots int:=0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('manage_automation') o;
    IF array_length(v_orgs,1) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Cần chọn tổ chức' USING ERRCODE='22023'; END IF;
    v_org:=v_orgs[1];
  END IF;
  IF NOT public.zalo_can('manage_automation',v_org) THEN RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  UPDATE public.zalo_automations SET enabled=false,updated_at=now() WHERE organization_id=v_org AND enabled;
  WITH shots AS (
    UPDATE public.zalo_automation_oneshots SET status='cancelled',cancelled_at=clock_timestamp(),cancelled_by=auth.uid(),updated_at=clock_timestamp(),
      result=result||jsonb_build_object('code','dung_khan_cap','reason','Người dùng bấm Dừng khẩn cấp')
    WHERE organization_id=v_org AND status IN ('queued','running') RETURNING id
  ) SELECT count(*) INTO v_shots FROM shots;
  WITH stopped AS (
    UPDATE public.zalo_send_queue SET status='failed',processed_at=clock_timestamp(),last_error='CANCELLED_AUTOMATION: người dùng dừng khẩn cấp',
      result=jsonb_build_object('outcome','cancelled','reason','emergency_stop')
    WHERE organization_id=v_org AND status='queued' AND payload ? 'tu_dong' RETURNING id,message_id
  ) SELECT array_agg(id),array_agg(message_id) FILTER(WHERE message_id IS NOT NULL) INTO v_jobs,v_msgs FROM stopped;
  v_jobs_count:=COALESCE(cardinality(v_jobs),0);
  UPDATE public.zalo_messages m SET status='failed' WHERE m.organization_id=v_org AND m.status='pending'
    AND (m.id=ANY(COALESCE(v_msgs,'{}')) OR EXISTS(SELECT 1 FROM public.zalo_send_queue q WHERE q.id=ANY(COALESCE(v_jobs,'{}'))
      AND q.conversation_id=m.conversation_id AND q.account_id=m.account_id AND jsonb_typeof(q.payload->'message_ids')='array' AND q.payload->'message_ids' ? m.id::text));
  GET DIAGNOSTICS v_msgs_count=ROW_COUNT;
  SELECT count(*) INTO v_processing FROM public.zalo_send_queue WHERE organization_id=v_org AND status='processing' AND payload ? 'tu_dong';
  SELECT id INTO v_acc FROM public.zalo_accounts WHERE organization_id=v_org ORDER BY id LIMIT 1;
  INSERT INTO public.zalo_automation_runs(organization_id,account_id,kind,mode,reason,messages_count,detail)
    VALUES(v_org,v_acc,'broadcast_vacant','stopped',format('Đã dừng %s tin đang chờ, huỷ %s lượt gửi một lần và tắt tự động hóa',v_jobs_count,v_shots),v_jobs_count,
      jsonb_build_object('so_job_huy',v_jobs_count,'so_tin_danh_dau_that_bai',v_msgs_count,'con_dang_gui',v_processing,'so_hen_gio_huy',v_shots,'boi',auth.uid()));
  RETURN jsonb_build_object('da_huy',v_jobs_count,'tin_danh_dau_that_bai',v_msgs_count,'con_dang_gui',v_processing,'hen_gio_huy',v_shots);
END $fn$;
REVOKE ALL ON FUNCTION public.zalo_dung_khan_cap(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.zalo_dung_khan_cap(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Tự kiểm catalog trước khi commit (chạy được trên database rỗng).
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE f text;
BEGIN
  IF position('oneshot_id' IN pg_get_functiondef('public.zalo_worker_begin_provider_v1(uuid,uuid)'::regprocedure))=0
    OR position('hermes_group_jobs' IN pg_get_functiondef('public.zalo_worker_begin_provider_v1(uuid,uuid)'::regprocedure))=0
    OR position('zalo_automation_oneshots' IN pg_get_functiondef('public.zalo_dung_khan_cap(uuid)'::regprocedure))=0
    THEN RAISE EXCEPTION 'zalo oneshot patch source'; END IF;
  FOREACH f IN ARRAY ARRAY['public.zalo_hen_gui_phong_trong_v1(uuid[],text,timestamptz,text,text,uuid)',
      'public.zalo_huy_hen_gui_phong_trong_v1(uuid)','public.zalo_ds_hen_gui_phong_trong_v1(uuid,integer)','public.zalo_dung_khan_cap(uuid)'] LOOP
    IF NOT has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE')
      OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'zalo oneshot ACL %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.zalo_worker_claim_oneshot_v1(uuid,uuid[])','public.zalo_worker_finish_oneshot_v1(uuid,uuid,boolean,jsonb)',
      'public.zalo_enqueue_broadcast_oneshot_v1(uuid,uuid,uuid,text,timestamptz,text,jsonb)','public.zalo_worker_begin_provider_v1(uuid,uuid)'] LOOP
    IF NOT has_function_privilege('service_role',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE')
      OR has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'zalo oneshot worker ACL %',f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['app_private.zalo_oneshot_json_v1(public.zalo_automation_oneshots)','app_private.zalo_oneshot_khung_gio_v1(jsonb,timestamptz)',
      'app_private.zalo_dang_dung_khan_cap_v1(uuid)','app_private.zalo_oneshot_tin_hom_nay_v1(uuid,timestamptz)'] LOOP
    IF has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE')
      OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'zalo oneshot helper ACL %',f; END IF;
  END LOOP;
  IF has_table_privilege('authenticated','public.zalo_automation_oneshots','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('anon','public.zalo_automation_oneshots','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT has_table_privilege('service_role','public.zalo_automation_oneshots','SELECT')
    OR has_table_privilege('service_role','public.zalo_automation_oneshots','INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.zalo_automation_oneshots'::regclass)
    THEN RAISE EXCEPTION 'zalo oneshot table ACL/RLS'; END IF;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
