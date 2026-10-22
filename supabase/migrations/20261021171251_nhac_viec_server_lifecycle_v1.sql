-- Nhắc hoá đơn / hợp đồng / cọc chuyển từ TRÌNH DUYỆT lên server — mở rộng lane lifecycle (plan
-- 2026-10-21-realtime-thong-bao-toi-uu.md, gói B mục B5; chủ đã chốt 21/10).
--
-- VÌ SAO (NOTIF-SERVER-4, CRITIC-1): bộ nhắc chạy ở Dashboard của trình duyệt (useScheduledNotifications) sinh 67%
-- thông báo 30 ngày: chỉ khi có người mở Dashboard, chỉ cho người "sở hữu" bản ghi, không push, bỏ qua cài đặt/giờ
-- yên, mỗi hoá đơn một dòng và không bao giờ tự hết hiệu lực (91,5% nhắc hoá đơn chưa đọc trỏ hoá đơn đã thu/huỷ/xoá).
--
-- THIẾT KẾ: dùng lại nguyên lane lifecycle đã chạy prod 15' một lần (20260928024843 + cron 20260928042301):
--   * Bốn họ nguồn mới trong app_private.lifecycle_reminder_sources_v1:
--       INVOICE_DUE       hoá đơn APPROVED/PARTIAL_PAID chưa xoá, còn nợ (remaining_amount > 0), hạn trong ≤ 3 ngày tới
--       INVOICE_OVERDUE   hoá đơn APPROVED/PARTIAL_PAID/OVERDUE chưa xoá, còn nợ, quá hạn (cùng tập "nợ" Hermes dùng)
--       CONTRACT_EXPIRING HĐ ACTIVE chưa xoá, chưa có actual_end_date, end_date ≤ hôm nay + 30 (kể cả đã quá hạn)
--       DEPOSIT_SHORTFALL HĐ ACTIVE chưa xoá, chưa có actual_end_date, deposit_remaining ≥ 10.000, deposit_debt_mode
--                         NULL/DEBT (FIRST_INVOICE thu qua hoá đơn — đã có nhắc hoá đơn)
--     Đo 22/10: org thật 59 hoá đơn quá hạn, 1 HĐ quá hạn, 1 HĐ thiếu cọc; DEMO 1 / 3 / 16.
--   * Người nhận: thành viên ACTIVE có buildings.view + invoices.view (hai họ hoá đơn) / contracts.view (hai họ HĐ)
--     trong phạm vi TOÀ (authorize_tenant_action_v3). Kiểm quyền theo TOÀ (≤ số toà có nguồn) chứ không theo từng
--     bản ghi, và tập toà được phép tính MỘT lần cho mỗi (người, công ty, quyền) trong một lượt rồi dùng chung cho mọi
--     họ (app_private.lifecycle_allowed_cached_v1) — bản trước gọi lại atav3 cho từng họ (SQL-LIFE-1).
--   * Một dòng chuông / người / ngày / họ, số cập nhật mỗi lượt (chỉ UPDATE khi nội dung đổi — không đẻ sự kiện realtime
--     thừa). Về 0 ⇒ dòng PENDING của họ đó thành CANCELLED (cancelled_reason SOURCE_RESOLVED; áp cả NOTICE/TURNOVER/
--     EXIT; KHÔNG BAO GIỜ đụng READ); nguồn quay lại trong ngày ⇒ dòng hôm nay mở lại PENDING. Dòng ngày mới thay dòng
--     cũ: dòng PENDING của ngày trước cùng họ thành CANCELLED (SUPERSEDED) — không còn mỗi ngày một dòng chồng lên.
--     Người nhận TẮT trong app (cá nhân/công ty/cadence OFF) ⇒ dòng PENDING của họ đó thành CANCELLED
--     (PREFERENCE_DISABLED, không đụng READ); bật lại trong ngày ⇒ dòng hôm nay mở lại / được tạo (SQL-LIFE-6).
--   * type giữ enum cũ để bản web cũ hiện đúng biểu tượng: INVOICE_DUE→PAYMENT_REMINDER, INVOICE_OVERDUE→
--     OVERDUE_INVOICE, CONTRACT_EXPIRING→CONTRACT_EXPIRING, DEPOSIT_SHORTFALL→DEPOSIT_SHORTFALL (NOTICE/TURNOVER/EXIT
--     giữ ACTION_REQUIRED). metadata.event: LIFECYCLE | BILLING | CONTRACT_EXPIRY | DEPOSIT — luôn có ⇒ trigger
--     a00_notifications_guard (chỉ chặn nhắc legacy thiếu event) và notification_reconcile_stale_v1 không đụng.
--   * Cổng: app_private.lifecycle_gate_v2(user, org, họ) đọc đúng khoá sở thích + events công ty theo họ; sweep/claim/
--     validate chuyển sang v2. Claim dùng giờ yên chung app_private.notify_in_quiet_hours_v1 (công ty HOẶC cá nhân).
--   * Nội dung chỉ là số đếm, không tên khách, không số tiền (như lane lifecycle hiện tại).
--   * Chi phí (RPC chạy dưới PostgREST — statement_timeout 8 s, lock_timeout 8 s của authenticator):
--       - Edge gọi sweep TỪNG công ty: public.lifecycle_reminder_org_ids_v1() rồi lifecycle_reminder_sweep_v1(<công ty>)
--         — mỗi RPC một giao dịch, khoá lock_org_for_decision_v1 chỉ sống trong phần việc của một công ty, một công ty
--         chậm/hỏng không kéo theo công ty khác (SQL-LIFE-1/2, EDGE-6). sweep_v1() không tham số giữ cho edge cũ.
--       - "Hôm nay" tính một lần trong sources; nguồn quét MỘT lần/công ty/lượt; bỏ qua (người, họ) có vân tay không đổi
--         trong ngày (app_private.lifecycle_reminder_sweep_state — lưu cả had_payload để đếm người nhận đúng, SQL-LIFE-7).
--       - Claim: đóng theo tập (biên nhận SENT, không thiết bị, hết lượt, hết ngày) rồi chỉ chọn dòng gửi được NGAY (có
--         thiết bị, còn lượt, ngoài giờ yên) TRƯỚC LIMIT — dòng giờ yên không chiếm suất (SQL-LIFE-4/EDGE-5); so ngày và
--         cổng trước payload; dựng payload MỘT lần (không gọi lồng validate — edge validate ngay trước khi gửi,
--         SQL-LIFE-3); không khoá công ty trước khi biết dòng gửi được.
--       Đo TEST 22/10 12:20 giờ công ty (thu-sql ROLLBACK, sau khi áp 171249–171253, lượt ĐẦU ngày — sweep_state rỗng,
--       2 công ty ACTIVE): sweep(công ty aaaa…) 905 ms, sweep(dddd…) 418 ms (bản trước review: 5,9–7,3 s cho cả hai
--       trong MỘT lệnh); lượt hai 18–20 ms/công ty; claim(10) khi MỌI thành viên có thiết bị 234 ms (bản trước 4,5 s),
--       validate chậm nhất 51 ms.
-- url: /contracts, /rooms, /invoices có trong NOTIFICATION_URL_ALLOWLIST (bản không-id của /invoices thêm ở 380f60d4f).
--
-- $requires$ (ghim thân, bài học 22/10): sáu hàm lane đã có trên production phải đúng thân production đo 22/10/2026
-- (= 20260928024843) hoặc thân mới của chính file (lượt hai) — PR song song thay cùng hàm thì dừng.
-- Cần 20261021171249_notify_pipeline_v2 (khoá sở thích BILLING/CONTRACT_EXPIRY/DEPOSIT, notify_in_quiet_hours_v1).
-- Không ghi dữ liệu nghiệp vụ; tên RPC lane giữ nguyên (sweep/claim/validate/settle/record_failure), hình dạng trả về
-- của claim/validate giữ nguyên. Chạy lại an toàn.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $tien_quyet$
BEGIN
  IF to_regclass('app_private.lifecycle_reminder_deliveries') IS NULL
     OR to_regprocedure('public.lifecycle_reminder_sweep_v1(uuid)') IS NULL
     OR to_regprocedure('public.lifecycle_reminder_claim_v1(integer)') IS NULL
     OR to_regprocedure('public.lifecycle_reminder_validate_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'nhac_viec_server_lifecycle_v1: cần lane lifecycle 20260928024843' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.notify_in_quiet_hours_v1(uuid,uuid,timestamp with time zone)') IS NULL
     OR position('''BILLING''' IN pg_get_functiondef('app_private.notification_prefs_read_v1(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'nhac_viec_server_lifecycle_v1: áp 20261021171249_notify_pipeline_v2 trước' USING ERRCODE = '55000';
  END IF;
END $tien_quyet$;

DO $requires$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.sig, x.cu, x.moi, (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)) AS hien
      FROM (VALUES
        ('app_private.lifecycle_reminder_sources_v1(uuid)', '51d786ea8f677f9f37a1c5fea85316bc', '7c4ca7bb7f17faec0d5b3da6ba804df0'),
        ('app_private.lifecycle_recipient_allowed_v1(uuid,uuid,uuid,text)', '51a0bf6f5a6544f73b3dd5ba5bb19e2f', 'bf53ab2b0b0d81a1da2e3fdc848f90a0'),
        ('app_private.lifecycle_reminder_payload_v1(uuid,uuid,text)', '941e764dc8afcc46a9488111c00e3499', 'f67dee9159c102e863af83486af3d0b2'),
        ('public.lifecycle_reminder_sweep_v1(uuid)', 'fef27094e008df831b72619ec1262067', 'fcf7e82347572041174351a4488b0632'),
        ('public.lifecycle_reminder_validate_v1(uuid,uuid)', '22271713beee5d0db858da6e835db6e7', '64d0de262b84fd7e2aa49a022ec16646'),
        ('public.lifecycle_reminder_claim_v1(integer)', 'ff93b8e30fc26eccacd67115a0eb04d3', '55f995dbbcb3adcc9d0bbea92289bf49')
      ) AS x(sig, cu, moi)
  LOOP
    IF r.hien IS NULL THEN
      RAISE EXCEPTION 'nhac_viec_server_lifecycle_v1: thiếu hàm % (production 22/10 có) — dừng', r.sig USING ERRCODE = '55000';
    END IF;
    IF r.hien NOT IN (r.cu, r.moi) THEN
      RAISE EXCEPTION 'nhac_viec_server_lifecycle_v1: thân % đã đổi so với bản đã duyệt (md5 %, chờ % hoặc %) — có PR khác thay hàm này, gộp rồi dựng lại migration',
        r.sig, r.hien, r.cu, r.moi USING ERRCODE = '55000';
    END IF;
  END LOOP;
END $requires$;

-- Vân tay lần tính gần nhất theo (công ty, người, họ): sweep chạy 15' một lần, nhưng kết quả chỉ đổi khi nguồn đổi
-- (id/revision), quyền/membership đổi (organizations.authorization_version tăng) hoặc cổng đổi — còn lại bỏ qua phần kiểm
-- quyền theo toà. Hết hạn quyền theo thời gian (valid_to) không tăng version: được tính lại từ ngày hôm sau (và lúc
-- claim/validate push luôn tính lại payload). had_payload = lần tính đó có payload (người này là NGƯỜI NHẬN của họ) —
-- nhánh bỏ qua đếm người nhận theo cột này, không theo "có delivery hôm nay" (người mất quyền giữa ngày vẫn còn
-- delivery buổi sáng). Bảng nội bộ, không ai ngoài sweep đọc.
CREATE TABLE IF NOT EXISTS app_private.lifecycle_reminder_sweep_state (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_family text NOT NULL,
  reminder_day date NOT NULL,
  fingerprint text NOT NULL,
  had_payload boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, user_id, source_family)
);
ALTER TABLE app_private.lifecycle_reminder_sweep_state ADD COLUMN IF NOT EXISTS had_payload boolean NOT NULL DEFAULT false;
ALTER TABLE app_private.lifecycle_reminder_sweep_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.lifecycle_reminder_sweep_state FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE app_private.lifecycle_reminder_deliveries DROP CONSTRAINT IF EXISTS lifecycle_reminder_deliveries_source_family_check;
ALTER TABLE app_private.lifecycle_reminder_deliveries ADD CONSTRAINT lifecycle_reminder_deliveries_source_family_check
  CHECK (source_family IN ('NOTICE','TURNOVER','EXIT','INVOICE_DUE','INVOICE_OVERDUE','CONTRACT_EXPIRING','DEPOSIT_SHORTFALL'));

-- Họ nguồn → khoá sở thích / metadata.event. Họ lạ là lỗi (CHECK ở bảng delivery cũng chặn), không đoán.
CREATE OR REPLACE FUNCTION app_private.lifecycle_family_event_v1(p_family text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF p_family IN ('NOTICE', 'TURNOVER', 'EXIT') THEN RETURN 'LIFECYCLE'; END IF;
  IF p_family IN ('INVOICE_DUE', 'INVOICE_OVERDUE') THEN RETURN 'BILLING'; END IF;
  IF p_family = 'CONTRACT_EXPIRING' THEN RETURN 'CONTRACT_EXPIRY'; END IF;
  IF p_family = 'DEPOSIT_SHORTFALL' THEN RETURN 'DEPOSIT'; END IF;
  RAISE EXCEPTION 'Họ nhắc việc không hợp lệ: %', p_family USING ERRCODE = '22023';
END $fn$;

-- Họ nguồn → quyền theo toà của người nhận (ngoài buildings.view). Một công thức cho sweep, claim, validate.
CREATE OR REPLACE FUNCTION app_private.lifecycle_family_perm_v1(p_family text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF p_family = 'TURNOVER' THEN RETURN 'rooms.view'; END IF;
  IF p_family IN ('INVOICE_DUE', 'INVOICE_OVERDUE') THEN RETURN 'invoices.view'; END IF;
  IF p_family IN ('NOTICE', 'EXIT', 'CONTRACT_EXPIRING', 'DEPOSIT_SHORTFALL') THEN RETURN 'contracts.view'; END IF;
  RAISE EXCEPTION 'Họ nhắc việc không hợp lệ: %', p_family USING ERRCODE = '22023';
END $fn$;

-- Họ nguồn → notifications.type (enum cũ — bản web cũ chọn biểu tượng theo type).
CREATE OR REPLACE FUNCTION app_private.lifecycle_family_type_v1(p_family text)
 RETURNS public.notification_type
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  SELECT (CASE p_family
            WHEN 'INVOICE_DUE'       THEN 'PAYMENT_REMINDER'
            WHEN 'INVOICE_OVERDUE'   THEN 'OVERDUE_INVOICE'
            WHEN 'CONTRACT_EXPIRING' THEN 'CONTRACT_EXPIRING'
            WHEN 'DEPOSIT_SHORTFALL' THEN 'DEPOSIT_SHORTFALL'
            ELSE 'ACTION_REQUIRED'
          END)::public.notification_type;
$fn$;

-- "Hôm nay" của công ty tính MỘT lần (CTE d) thay vì gọi org_today_v1 trên từng dòng: đo TEST 22/10 bản gọi theo
-- dòng mất ~60 ms/lượt, mà sweep + claim gọi hàm này vài chục lần mỗi 15' trong ngân sách statement_timeout 8 s
-- của authenticator (PostgREST).
CREATE OR REPLACE FUNCTION app_private.lifecycle_reminder_sources_v1(p_org uuid)
RETURNS TABLE(source_family text,source_id uuid,building_id uuid,revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  WITH d AS MATERIALIZED (SELECT public.org_today_v1(p_org) AS today)
  SELECT 'NOTICE',c.id,b.id,c.updated_at::text FROM d, public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id
    WHERE c.organization_id=p_org AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND c.expected_move_out_date<=d.today
  UNION ALL
  SELECT 'TURNOVER',t.id,b.id,t.epoch::text||':'||t.version::text FROM d, public.room_turnovers t
    JOIN public.rooms r ON r.id=t.room_id AND r.organization_id=t.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=t.organization_id
    WHERE t.organization_id=p_org AND t.status='PENDING' AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND (t.expected_ready_on IS NULL OR t.expected_ready_on<=d.today)
  UNION ALL
  SELECT 'EXIT',e.id,e.building_id,e.version::text FROM public.contract_exit_cases e
    WHERE e.organization_id=p_org AND e.state='PENDING'
  UNION ALL
  -- Hoá đơn còn nợ: quá hạn (kể cả trạng thái OVERDUE) hoặc đến hạn trong 3 ngày tới. remaining_amount là cột
  -- GENERATED (total_amount - paid_amount) — cùng điều kiện "nợ" của Hermes (20261020233934).
  SELECT CASE WHEN i.due_date<d.today THEN 'INVOICE_OVERDUE' ELSE 'INVOICE_DUE' END,
         i.id,b.id,i.updated_at::text FROM d, public.invoices i
    JOIN public.buildings b ON b.id=i.building_id AND b.organization_id=i.organization_id
    WHERE i.organization_id=p_org AND i.deleted_at IS NULL AND b.deleted_at IS NULL AND i.remaining_amount>0
      AND ((i.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE') AND i.due_date<d.today)
        OR (i.status::text IN ('APPROVED','PARTIAL_PAID') AND i.due_date BETWEEN d.today AND d.today+3))
  UNION ALL
  SELECT 'CONTRACT_EXPIRING',c.id,b.id,c.updated_at::text FROM d, public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id
    WHERE c.organization_id=p_org AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND c.end_date<=d.today+30
  UNION ALL
  SELECT 'DEPOSIT_SHORTFALL',c.id,b.id,c.updated_at::text FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id
    WHERE c.organization_id=p_org AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND c.deposit_remaining>=10000
      AND (c.deposit_debt_mode IS NULL OR c.deposit_debt_mode='DEBT');
$fn$;

-- Mọi nguồn của công ty dạng jsonb [{f, id, b, r}] — quét MỘT lần rồi lọc trong bộ nhớ cho từng (người, họ).
CREATE OR REPLACE FUNCTION app_private.lifecycle_reminder_sources_json_v1(p_org uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('f',s.source_family,'id',s.source_id,'b',s.building_id,'r',s.revision)),'[]'::jsonb)
    FROM app_private.lifecycle_reminder_sources_v1(p_org) s;
$fn$;

-- Các toà (trong p_buildings) mà p_user nhận nhắc được theo quyền p_perm: membership ACTIVE trong công ty ACTIVE còn
-- hiệu lực, super admin không nhận nhắc của công ty sandbox / toà demo, và authorize_tenant_action_v3(p_perm) theo
-- toà. Bên gọi ghép buildings.view với quyền của họ: allowed(perm) = f(perm, f('buildings.view', toà nguồn)).
-- Bên gọi đã lấy lock_org_for_decision_v1. Resolver quyền thật theo người nhận, không set JWT claims.
CREATE OR REPLACE FUNCTION app_private.lifecycle_allowed_buildings_v1(p_user uuid, p_org uuid, p_perm text, p_buildings uuid[])
RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_super boolean;
BEGIN
  IF p_user IS NULL OR p_org IS NULL OR p_perm IS NULL OR COALESCE(cardinality(p_buildings), 0) = 0 THEN
    RETURN '{}'::uuid[];
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
      WHERE m.user_id=p_user AND m.organization_id=p_org AND m.status='ACTIVE' AND o.status='ACTIVE'
        AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=clock_timestamp()
        AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp())) THEN
    RETURN '{}'::uuid[];
  END IF;
  v_super := EXISTS(SELECT 1 FROM public.super_admins sa WHERE sa.user_id=p_user);
  RETURN COALESCE((
    SELECT array_agg(b.id ORDER BY b.id) FROM public.buildings b
     WHERE b.id = ANY(p_buildings) AND b.organization_id=p_org
       AND NOT (v_super AND (COALESCE(p_org=ANY(public.sandbox_org_ids()),false)
                             OR COALESCE(b.user_id=ANY(public.demo_user_ids()),false)))
       AND COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(p_user,p_org,p_perm,b.id,NULL) a),false)),
    '{}'::uuid[]);
END $fn$;

-- Toà được phép của (người, công ty) cho họ p_family, nhớ trong p_cache theo khoá '<người>:<công ty>' → {quyền: [toà]}.
-- buildings.view tính MỘT lần trên mọi toà có nguồn (p_buildings), quyền của họ chỉ tính trên các toà đã qua
-- buildings.view; lần sau cùng (người, công ty, quyền) lấy lại từ cache — sweep/claim truyền cache qua mọi họ.
CREATE OR REPLACE FUNCTION app_private.lifecycle_allowed_cached_v1(p_user uuid, p_org uuid, p_family text, p_buildings uuid[],
  p_cache jsonb, OUT allowed uuid[], OUT cache jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_key   text := p_user::text || ':' || p_org::text;
  v_perm  text := app_private.lifecycle_family_perm_v1(p_family);
  v_entry jsonb;
BEGIN
  cache := COALESCE(p_cache, '{}'::jsonb);
  v_entry := COALESCE(cache -> v_key, '{}'::jsonb);
  IF NOT v_entry ? 'buildings.view' THEN
    v_entry := v_entry || jsonb_build_object('buildings.view',
      to_jsonb(app_private.lifecycle_allowed_buildings_v1(p_user, p_org, 'buildings.view', p_buildings)));
  END IF;
  IF NOT v_entry ? v_perm THEN
    v_entry := v_entry || jsonb_build_object(v_perm,
      to_jsonb(app_private.lifecycle_allowed_buildings_v1(p_user, p_org, v_perm,
        ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_entry -> 'buildings.view') x))));
  END IF;
  cache := jsonb_set(cache, ARRAY[v_key], v_entry, true);
  allowed := ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_entry -> v_perm) x);
END $fn$;

-- Payload của họ p_family từ tập nguồn p_src ({f,id,b,r}) và các toà được phép p_ok. Một công thức cho sweep, claim,
-- validate ⇒ metadata.sources so sánh được giữa các lượt (cùng thứ tự, cùng hình dạng).
CREATE OR REPLACE FUNCTION app_private.lifecycle_reminder_payload_from_v1(p_family text, p_src jsonb, p_ok uuid[])
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
DECLARE n integer; ids jsonb; title text; body text; route text;
BEGIN
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('id',(x->>'id')::uuid,'revision',x->>'r') ORDER BY (x->>'id')::uuid),'[]'::jsonb)
    INTO n, ids
    FROM jsonb_array_elements(COALESCE(p_src,'[]'::jsonb)) x
   WHERE x->>'f' = p_family AND (x->>'b')::uuid = ANY(COALESCE(p_ok,'{}'::uuid[]));
  IF n=0 THEN RETURN NULL; END IF;
  CASE p_family
    WHEN 'NOTICE' THEN title:='Báo trả phòng đã đến hẹn'; body:=n::text||' việc cần kiểm tra trong danh sách.'; route:='/contracts';
    WHEN 'TURNOVER' THEN title:='Phòng cần dọn/sửa'; body:=n::text||' việc cần kiểm tra trong danh sách.'; route:='/rooms';
    WHEN 'EXIT' THEN title:='Hồ sơ trả phòng chờ hoàn tất'; body:=n::text||' việc cần kiểm tra trong danh sách.'; route:='/contracts';
    WHEN 'INVOICE_DUE' THEN title:='Hoá đơn sắp đến hạn'; body:=n::text||' hoá đơn đến hạn trong 3 ngày tới.'; route:='/invoices';
    WHEN 'INVOICE_OVERDUE' THEN title:='Hoá đơn quá hạn chưa thu đủ'; body:=n::text||' hoá đơn đã quá hạn thanh toán.'; route:='/invoices';
    WHEN 'CONTRACT_EXPIRING' THEN title:='Hợp đồng sắp hết hạn';
      body:=n::text||' hợp đồng hết hạn trong 30 ngày tới hoặc đã quá hạn mà chưa kết thúc.'; route:='/contracts';
    WHEN 'DEPOSIT_SHORTFALL' THEN title:='Hợp đồng còn thiếu cọc'; body:=n::text||' hợp đồng chưa thu đủ tiền cọc.'; route:='/contracts';
    ELSE RAISE EXCEPTION 'Họ nhắc việc không hợp lệ: %', p_family USING ERRCODE='22023';
  END CASE;
  RETURN jsonb_build_object('title',title,'body',body,'count',n,'sources',ids,'url',route);
END $fn$;

-- Giữ chữ ký (test và tra cứu một toà dùng); cùng luật với lifecycle_allowed_buildings_v1.
CREATE OR REPLACE FUNCTION app_private.lifecycle_recipient_allowed_v1(p_user uuid,p_org uuid,p_building uuid,p_family text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT p_building IS NOT NULL AND p_building = ANY(app_private.lifecycle_allowed_buildings_v1(p_user, p_org,
    app_private.lifecycle_family_perm_v1(p_family),
    app_private.lifecycle_allowed_buildings_v1(p_user, p_org, 'buildings.view', ARRAY[p_building])));
$fn$;

-- Payload một (người, công ty, họ) — validate dùng (một delivery, không cần cache).
CREATE OR REPLACE FUNCTION app_private.lifecycle_reminder_payload_v1(p_user uuid,p_org uuid,p_family text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_src jsonb; v_b uuid[]; v_ok uuid[]; v_cache jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('f',s.source_family,'id',s.source_id,'b',s.building_id,'r',s.revision)),'[]'::jsonb)
    INTO v_src FROM app_private.lifecycle_reminder_sources_v1(p_org) s WHERE s.source_family=p_family;
  v_b := ARRAY(SELECT DISTINCT (x->>'b')::uuid FROM jsonb_array_elements(v_src) x WHERE x->>'b' IS NOT NULL);
  IF cardinality(v_b)=0 THEN RETURN NULL; END IF;
  SELECT c.allowed, c.cache INTO v_ok, v_cache FROM app_private.lifecycle_allowed_cached_v1(p_user, p_org, p_family, v_b, NULL) c;
  RETURN app_private.lifecycle_reminder_payload_from_v1(p_family, v_src, v_ok);
END $fn$;

-- Cùng ngữ nghĩa cổng của lifecycle_gate_v1 (DIGEST/OFF; push tách khỏi in_app) nhưng theo KHOÁ CỦA HỌ:
-- events công ty + sở thích cá nhân của LIFECYCLE | BILLING | CONTRACT_EXPIRY | DEPOSIT. Đọc thẳng (không fail-open):
-- lỗi cấu hình làm hỏng lượt sweep chứ không bị nuốt.
CREATE OR REPLACE FUNCTION app_private.lifecycle_gate_v2(p_user uuid, p_org uuid, p_family text)
RETURNS TABLE(in_app boolean, push boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT COALESCE((c.events->k.event_key->>'enabled')::boolean,true) AND COALESCE(p.in_app,true) AND COALESCE(p.cadence,'IMMEDIATE')<>'OFF',
    COALESCE((c.events->k.event_key->>'enabled')::boolean,true) AND COALESCE(p.push,true) AND COALESCE(p.cadence,'IMMEDIATE')='IMMEDIATE'
  FROM (SELECT app_private.lifecycle_family_event_v1(p_family) AS event_key) k
    LEFT JOIN app_private.notification_org_config c ON c.organization_id=p_org
    LEFT JOIN public.notification_preferences p ON p.organization_id=p_org AND p.user_id=p_user AND p.event_key=k.event_key;
$fn$;

-- Edge (service_role) lấy danh sách công ty rồi gọi lifecycle_reminder_sweep_v1(<công ty>) TỪNG công ty: mỗi RPC
-- một giao dịch có ngân sách 8 s riêng, khoá quyết định chỉ sống trong một công ty (SQL-LIFE-1/2, EDGE-6).
CREATE OR REPLACE FUNCTION public.lifecycle_reminder_org_ids_v1()
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT COALESCE(array_agg(o.id ORDER BY o.id), '{}'::uuid[]) FROM public.organizations o WHERE o.status='ACTIVE';
$fn$;

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_sweep_v1(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_families constant text[] := ARRAY['NOTICE','TURNOVER','EXIT','INVOICE_DUE','INVOICE_OVERDUE','CONTRACT_EXPIRING','DEPOSIT_SHORTFALL'];
  v_org record; u record; family text; payload jsonb; gate record; delivery uuid; notif uuid; today date;
  inserted integer:=0; org_inserted integer; missing jsonb; local_now timestamp; existing_delivery record;
  has_sources boolean; v_event text; v_type public.notification_type; v_day text; cancelled integer:=0; v_n integer;
  v_now timestamptz; v_src jsonb; v_present text[]; v_fp jsonb; v_authz bigint; v_fpr text; v_same boolean;
  v_had boolean; skipped integer:=0; v_all_b uuid[]; v_ok uuid[]; v_cache jsonb; v_recipients jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('lifecycle_reminder_sweep_v1')::bigint) THEN RETURN jsonb_build_object('inserted',0,'busy',true); END IF;
  FOR v_org IN SELECT id FROM public.organizations WHERE status='ACTIVE' AND (p_organization_id IS NULL OR id=p_organization_id) ORDER BY id LOOP
    local_now:=clock_timestamp() AT TIME ZONE app_private.org_timezone_v1(v_org.id);
    IF extract(hour FROM local_now)<8 THEN CONTINUE; END IF;
    PERFORM app_private.lock_org_for_decision_v1(v_org.id);
    today:=public.org_today_v1(v_org.id); v_day:=to_char(today,'YYYY-MM-DD'); org_inserted:=0; missing:='[]';
    v_recipients:='{}'; v_cache:='{}';
    -- Một lượt quét nguồn cho cả 7 họ + vân tay nguồn theo họ + mọi toà có nguồn.
    v_src:=app_private.lifecycle_reminder_sources_json_v1(v_org.id);
    SELECT COALESCE(array_agg(q.f),'{}'),COALESCE(jsonb_object_agg(q.f,q.fp),'{}') INTO v_present,v_fp FROM (
      SELECT x->>'f' AS f,md5(string_agg((x->>'id')||'@'||COALESCE(x->>'r',''),',' ORDER BY (x->>'id')::uuid)) AS fp
        FROM jsonb_array_elements(v_src) x GROUP BY x->>'f') q;
    v_all_b:=ARRAY(SELECT DISTINCT (x->>'b')::uuid FROM jsonb_array_elements(v_src) x WHERE x->>'b' IS NOT NULL);
    SELECT o.authorization_version INTO v_authz FROM public.organizations o WHERE o.id=v_org.id;
    -- Người ngoài, họ trong: tập toà được phép của một người tính một lần cho mọi họ (v_cache).
    FOR u IN SELECT DISTINCT m.user_id FROM public.organization_memberships m WHERE m.organization_id=v_org.id AND m.status='ACTIVE' ORDER BY m.user_id LOOP
      FOREACH family IN ARRAY v_families LOOP
        v_event:=app_private.lifecycle_family_event_v1(family);
        v_type:=app_private.lifecycle_family_type_v1(family);
        has_sources:=family=ANY(v_present);
        SELECT * INTO gate FROM app_private.lifecycle_gate_v2(u.user_id,v_org.id,family);
        -- Đã tính hôm nay với CÙNG nguồn (id+revision), cùng authorization_version của công ty (đổi quyền/membership
        -- ⇒ tăng) và cùng cổng ⇒ kết quả không thể khác: bỏ qua phần đắt (kiểm quyền theo toà).
        v_fpr:=COALESCE(v_fp->>family,'-')||':'||COALESCE(v_authz::text,'-')||':'||gate.in_app::text||':'||gate.push::text;
        v_same:=NULL; v_had:=NULL;
        SELECT (st.reminder_day=today AND st.fingerprint=v_fpr),st.had_payload INTO v_same,v_had
          FROM app_private.lifecycle_reminder_sweep_state st
          WHERE st.organization_id=v_org.id AND st.user_id=u.user_id AND st.source_family=family;
        IF COALESCE(v_same,false) THEN
          IF v_had THEN v_recipients:=v_recipients||jsonb_build_object(family,COALESCE((v_recipients->>family)::integer,0)+1); END IF;
          skipped:=skipped+1;
          CONTINUE;
        END IF;
        payload:=NULL;
        IF has_sources THEN
          SELECT c.allowed,c.cache INTO v_ok,v_cache FROM app_private.lifecycle_allowed_cached_v1(u.user_id,v_org.id,family,v_all_b,v_cache) c;
          payload:=app_private.lifecycle_reminder_payload_from_v1(family,v_src,v_ok);
        END IF;
        INSERT INTO app_private.lifecycle_reminder_sweep_state(organization_id,user_id,source_family,reminder_day,fingerprint,had_payload,updated_at)
          VALUES(v_org.id,u.user_id,family,today,v_fpr,payload IS NOT NULL,clock_timestamp())
          ON CONFLICT(organization_id,user_id,source_family) DO UPDATE
            SET reminder_day=excluded.reminder_day,fingerprint=excluded.fingerprint,had_payload=excluded.had_payload,
                updated_at=excluded.updated_at;
        v_now:=clock_timestamp();
        IF payload IS NULL THEN
          -- Dòng hôm nay theo nguồn hiện tại kể cả khi việc đã hết hoặc người nhận mất phạm vi toà (chỉ ghi khi đổi).
          UPDATE public.notifications n SET content='Không còn việc cần kiểm tra trong danh sách.',
            metadata=COALESCE(n.metadata,'{}')||jsonb_build_object('count',0,'sources','[]'::jsonb)
            FROM app_private.lifecycle_reminder_deliveries d
            WHERE d.organization_id=v_org.id AND d.user_id=u.user_id AND d.reminder_day=today
              AND d.source_family=family AND n.id=d.notification_id
              AND (n.metadata->>'count' IS DISTINCT FROM '0' OR n.content IS DISTINCT FROM 'Không còn việc cần kiểm tra trong danh sách.');
          -- Về 0 ⇒ mọi dòng CHƯA ĐỌC của họ này (mọi ngày) thành CANCELLED. READ giữ nguyên — không xoá cờ đã đọc.
          UPDATE public.notifications n SET status='CANCELLED',
            metadata=COALESCE(n.metadata,'{}')||jsonb_build_object('cancelled_reason','SOURCE_RESOLVED','cancelled_at',v_now,
              'cancelled_by','lifecycle_reminder_sweep_v1')
            WHERE n.user_id=u.user_id AND n.organization_id=v_org.id AND n.status='PENDING'
              AND n.metadata ? 'delivery_id' AND n.metadata->>'source_family'=family;
          GET DIAGNOSTICS v_n = ROW_COUNT; cancelled:=cancelled+v_n;
          CONTINUE;
        END IF;
        v_recipients:=v_recipients||jsonb_build_object(family,COALESCE((v_recipients->>family)::integer,0)+1);
        IF NOT gate.in_app THEN
          -- Tắt trong app (cá nhân, công ty hoặc cadence OFF) ⇒ dòng CHƯA ĐỌC của họ này (mọi ngày) thành CANCELLED;
          -- READ giữ nguyên. Không có dòng chuông mới; push (nếu còn bật) vẫn theo delivery.
          UPDATE public.notifications n SET status='CANCELLED',
            metadata=COALESCE(n.metadata,'{}')||jsonb_build_object('cancelled_reason','PREFERENCE_DISABLED','cancelled_at',v_now,
              'cancelled_by','lifecycle_reminder_sweep_v1')
            WHERE n.user_id=u.user_id AND n.organization_id=v_org.id AND n.status='PENDING'
              AND n.metadata ? 'delivery_id' AND n.metadata->>'source_family'=family;
          GET DIAGNOSTICS v_n = ROW_COUNT; cancelled:=cancelled+v_n;
        END IF;
        INSERT INTO app_private.lifecycle_reminder_deliveries(organization_id,user_id,reminder_day,source_family,push_status,last_error)
          VALUES(v_org.id,u.user_id,today,family,CASE WHEN gate.push THEN 'PENDING' ELSE 'DISABLED' END,
            CASE WHEN gate.push THEN NULL ELSE 'Organization/personal push preference disabled or cadence DIGEST/OFF' END)
          ON CONFLICT(organization_id,user_id,reminder_day,source_family) DO NOTHING RETURNING id INTO delivery;
        IF delivery IS NULL THEN
          SELECT id,notification_id INTO existing_delivery FROM app_private.lifecycle_reminder_deliveries
            WHERE organization_id=v_org.id AND user_id=u.user_id AND reminder_day=today AND source_family=family FOR UPDATE;
          delivery:=existing_delivery.id; notif:=existing_delivery.notification_id;
        ELSE
          notif:=NULL;
          org_inserted:=org_inserted+1;
        END IF;
        CONTINUE WHEN NOT gate.in_app;
        IF notif IS NOT NULL THEN
          -- Cập nhật số đếm/tham chiếu, KHÔNG reset cờ đã đọc, KHÔNG đẻ thêm push. Dòng do chính sweep huỷ vì về 0
          -- (SOURCE_RESOLVED) hay vì người nhận tắt trong app (PREFERENCE_DISABLED) mà nay còn việc và đã bật lại
          -- trong ngày ⇒ mở lại PENDING. Chỉ ghi khi có gì đổi.
          UPDATE public.notifications n SET type=v_type,
            subject=payload->>'title',content=payload->>'body',
            status=CASE WHEN n.status='CANCELLED' AND n.metadata->>'cancelled_reason' IN ('SOURCE_RESOLVED','PREFERENCE_DISABLED')
                        THEN 'PENDING'::public.notification_status ELSE n.status END,
            metadata=(CASE WHEN n.status='CANCELLED' AND n.metadata->>'cancelled_reason' IN ('SOURCE_RESOLVED','PREFERENCE_DISABLED')
                           THEN COALESCE(n.metadata,'{}')-'cancelled_reason'-'cancelled_at'-'cancelled_by'
                           ELSE COALESCE(n.metadata,'{}') END)
              ||jsonb_build_object('event',v_event,'source_family',family,'day',today,
              'url',payload->>'url','count',payload->'count','sources',payload->'sources','delivery_id',delivery)
            WHERE n.id=notif
              AND (n.type IS DISTINCT FROM v_type OR n.subject IS DISTINCT FROM payload->>'title'
                OR n.content IS DISTINCT FROM payload->>'body' OR n.metadata->'sources' IS DISTINCT FROM payload->'sources'
                OR n.metadata->>'event' IS DISTINCT FROM v_event
                OR (n.status='CANCELLED' AND n.metadata->>'cancelled_reason' IN ('SOURCE_RESOLVED','PREFERENCE_DISABLED')));
          CONTINUE;
        END IF;
        -- Chưa có dòng chuông hôm nay (delivery mới, hoặc delivery có từ lúc tắt trong app nay bật lại): dòng ngày mới
        -- thay dòng chưa đọc của ngày trước cùng họ.
        UPDATE public.notifications n SET status='CANCELLED',
          metadata=COALESCE(n.metadata,'{}')||jsonb_build_object('cancelled_reason','SUPERSEDED','cancelled_at',v_now,
            'cancelled_by','lifecycle_reminder_sweep_v1')
          WHERE n.user_id=u.user_id AND n.organization_id=v_org.id AND n.status='PENDING'
            AND n.metadata ? 'delivery_id' AND n.metadata->>'source_family'=family
            AND n.metadata->>'day' IS DISTINCT FROM v_day;
        GET DIAGNOSTICS v_n = ROW_COUNT; cancelled:=cancelled+v_n;
        INSERT INTO public.notifications(user_id,organization_id,type,channel,subject,content,metadata,status,push_state)
          VALUES(u.user_id,v_org.id,v_type,'IN_APP',payload->>'title',payload->>'body',
            jsonb_build_object('event',v_event,'source_family',family,'day',today,'url',payload->>'url','count',payload->'count','sources',payload->'sources','delivery_id',delivery),'PENDING',NULL)
          RETURNING id INTO notif;
        UPDATE app_private.lifecycle_reminder_deliveries SET notification_id=notif,inbox_recorded_at=clock_timestamp() WHERE id=delivery;
      END LOOP;
    END LOOP;
    FOREACH family IN ARRAY v_families LOOP
      IF family=ANY(v_present) AND COALESCE((v_recipients->>family)::integer,0)=0 THEN missing:=missing||jsonb_build_array(family); END IF;
    END LOOP;
    INSERT INTO app_private.lifecycle_reminder_runs(organization_id,inserted,no_recipient_families,status)
      VALUES(v_org.id,org_inserted,missing,CASE WHEN missing='[]'::jsonb THEN 'OK' ELSE 'NO_RECIPIENT' END);
    inserted:=inserted+org_inserted;
  END LOOP;
  RETURN jsonb_build_object('inserted',inserted,'cancelled',cancelled,'unchanged',skipped);
END $fn$;

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_validate_v1(p_id uuid,p_lease uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE d app_private.lifecycle_reminder_deliveries%rowtype; payload jsonb; gate record;
BEGIN
  SELECT * INTO d FROM app_private.lifecycle_reminder_deliveries WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown lifecycle delivery' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(d.organization_id);
  SELECT * INTO d FROM app_private.lifecycle_reminder_deliveries WHERE id=p_id FOR UPDATE;
  IF d.push_status<>'SENDING' OR d.lease IS DISTINCT FROM p_lease THEN RAISE EXCEPTION 'Stale lifecycle delivery lease' USING ERRCODE='PT409'; END IF;
  SELECT * INTO gate FROM app_private.lifecycle_gate_v2(d.user_id,d.organization_id,d.source_family);
  -- Hai phép rẻ (ngày, cổng) trước payload (đắt: quét nguồn + kiểm quyền theo toà).
  IF NOT gate.push OR d.reminder_day<>public.org_today_v1(d.organization_id) THEN
    payload:=NULL;
  ELSE
    payload:=app_private.lifecycle_reminder_payload_v1(d.user_id,d.organization_id,d.source_family);
  END IF;
  IF payload IS NULL THEN
    UPDATE app_private.lifecycle_reminder_deliveries SET push_status=CASE WHEN NOT gate.push THEN 'DISABLED' ELSE 'SKIPPED' END,
      last_error='Source resolved, read scope changed, day expired, or push disabled',lease=NULL,leased_at=NULL WHERE id=p_id;
    RETURN NULL;
  END IF;
  RETURN payload||jsonb_build_object('id',d.id,'lease',d.lease,'user_id',d.user_id,'organization_id',d.organization_id,
    'notification_ids',CASE WHEN d.notification_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(d.notification_id) END,'idempotency_key',d.idempotency_key);
END $fn$;

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_claim_v1(p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE d record; payload jsonb; gate record; v_lease uuid; out jsonb:='[]'; v_now timestamptz:=clock_timestamp();
  v_src_cache jsonb:='{}'; v_cache jsonb:='{}'; v_src jsonb; v_all_b uuid[]; v_ok uuid[];
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'Invalid lifecycle batch size' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('lifecycle_reminder_claim_v1')::bigint) THEN RETURN out; END IF;

  -- (1)–(4) Đóng theo TẬP những dòng không bao giờ gửi được lúc này, TRƯỚC khi chọn lô: chúng không chiếm suất của
  -- LIMIT (SQL-LIFE-4/EDGE-5). Không phải quyết định theo quyền ⇒ không khoá công ty (SQL-LIFE-2).
  -- (1) Biên nhận của khoá lượt trước SENT/PARTIAL (edge chết sau khi send-push đã gửi) ⇒ SENT, không gửi lại.
  UPDATE app_private.lifecycle_reminder_deliveries q SET push_status='SENT',delivered_at=v_now,lease=NULL,leased_at=NULL
    FROM public.push_send_log l
   WHERE l.idempotency_key=q.idempotency_key AND l.sent>0 AND l.outcome IN ('SENT','PARTIAL')
     AND ((q.push_status='PENDING' AND q.next_attempt_at<=v_now) OR (q.push_status='SENDING' AND q.leased_at<v_now-interval '10 minutes'));
  -- (2) Không có thiết bị nào đang hoạt động.
  UPDATE app_private.lifecycle_reminder_deliveries q SET push_status='NO_DEVICE',last_error='No active push device',lease=NULL,leased_at=NULL
   WHERE ((q.push_status='PENDING' AND q.next_attempt_at<=v_now) OR (q.push_status='SENDING' AND q.leased_at<v_now-interval '10 minutes'))
     AND NOT EXISTS(SELECT 1 FROM public.push_subscriptions ps WHERE ps.user_id=q.user_id AND ps.is_active);
  -- (3) Hết lượt.
  UPDATE app_private.lifecycle_reminder_deliveries q SET push_status='FAILED',last_error=COALESCE(q.last_error,'Push lease expired after 3 attempts'),
      lease=NULL,leased_at=NULL
   WHERE ((q.push_status='PENDING' AND q.next_attempt_at<=v_now) OR (q.push_status='SENDING' AND q.leased_at<v_now-interval '10 minutes'))
     AND q.attempts>=3;
  -- (4) Hết ngày (ngày công ty) — kể cả dòng đang giờ yên: hôm qua không bao giờ còn gửi.
  UPDATE app_private.lifecycle_reminder_deliveries q SET push_status='SKIPPED',last_error='Reminder day expired before push',lease=NULL,leased_at=NULL
    FROM (SELECT o.org, public.org_today_v1(o.org) AS today
            FROM (SELECT DISTINCT x.organization_id AS org FROM app_private.lifecycle_reminder_deliveries x
                   WHERE (x.push_status='PENDING' AND x.next_attempt_at<=v_now)
                      OR (x.push_status='SENDING' AND x.leased_at<v_now-interval '10 minutes')) o) t
   WHERE q.organization_id=t.org AND q.reminder_day<>t.today
     AND ((q.push_status='PENDING' AND q.next_attempt_at<=v_now) OR (q.push_status='SENDING' AND q.leased_at<v_now-interval '10 minutes'));

  -- (5) Chọn lô: chỉ dòng gửi được NGAY — có thiết bị, còn lượt, NGOÀI giờ yên công ty + cá nhân — lọc TRƯỚC LIMIT
  -- (cùng khuôn notify_claim_push_batch_v2). Dòng giờ yên giữ PENDING, lượt sau xét lại; không chặn hàng sau nó.
  FOR d IN SELECT x.* FROM app_private.lifecycle_reminder_deliveries x
    WHERE ((x.push_status='PENDING' AND x.next_attempt_at<=v_now) OR (x.push_status='SENDING' AND x.leased_at<v_now-interval '10 minutes'))
      AND x.attempts<3
      AND EXISTS(SELECT 1 FROM public.push_subscriptions ps WHERE ps.user_id=x.user_id AND ps.is_active)
      AND NOT app_private.notify_in_quiet_hours_v1(x.user_id,x.organization_id,v_now)
    ORDER BY x.organization_id,x.created_at,x.id LIMIT p_limit LOOP
    PERFORM app_private.lock_org_for_decision_v1(d.organization_id);
    SELECT * INTO d FROM app_private.lifecycle_reminder_deliveries WHERE id=d.id FOR UPDATE;
    CONTINUE WHEN NOT ((d.push_status='PENDING' AND d.next_attempt_at<=v_now) OR (d.push_status='SENDING' AND d.leased_at<v_now-interval '10 minutes'));
    -- Ngày và cổng (rẻ) TRƯỚC payload (đắt) — SQL-LIFE-3.
    IF d.reminder_day<>public.org_today_v1(d.organization_id) THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status='SKIPPED',last_error='Reminder day expired before push',lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    SELECT * INTO gate FROM app_private.lifecycle_gate_v2(d.user_id,d.organization_id,d.source_family);
    IF NOT gate.push THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status='DISABLED',
        last_error='Source resolved, read scope changed, day expired, or push disabled',lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    -- Payload dựng MỘT lần (nguồn mỗi công ty quét một lần, toà được phép nhớ theo người×công ty trong lượt); không gọi
    -- lồng validate — edge gọi lifecycle_reminder_validate_v1 ngay trước khi gửi.
    IF NOT v_src_cache ? d.organization_id::text THEN
      v_src_cache:=v_src_cache||jsonb_build_object(d.organization_id::text,app_private.lifecycle_reminder_sources_json_v1(d.organization_id));
    END IF;
    v_src:=v_src_cache->d.organization_id::text;
    v_all_b:=ARRAY(SELECT DISTINCT (x->>'b')::uuid FROM jsonb_array_elements(v_src) x WHERE x->>'b' IS NOT NULL);
    SELECT c.allowed,c.cache INTO v_ok,v_cache FROM app_private.lifecycle_allowed_cached_v1(d.user_id,d.organization_id,d.source_family,v_all_b,v_cache) c;
    payload:=app_private.lifecycle_reminder_payload_from_v1(d.source_family,v_src,v_ok);
    IF payload IS NULL THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status='SKIPPED',
        last_error='Source resolved, read scope changed, day expired, or push disabled',lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    v_lease:=gen_random_uuid();
    UPDATE app_private.lifecycle_reminder_deliveries SET push_status='SENDING',attempts=attempts+1,lease=v_lease,leased_at=clock_timestamp(),
      idempotency_key='lifecycle:'||id::text||':'||(attempts+1)::text WHERE id=d.id
      RETURNING * INTO d;
    -- Cùng hình dạng lifecycle_reminder_validate_v1 (runner parse chung).
    out:=out||jsonb_build_array(payload||jsonb_build_object('id',d.id,'lease',d.lease,'user_id',d.user_id,'organization_id',d.organization_id,
      'notification_ids',CASE WHEN d.notification_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(d.notification_id) END,
      'idempotency_key',d.idempotency_key));
  END LOOP;
  RETURN out;
END $fn$;

REVOKE ALL ON FUNCTION app_private.lifecycle_family_event_v1(text),app_private.lifecycle_family_type_v1(text),
  app_private.lifecycle_family_perm_v1(text),app_private.lifecycle_reminder_sources_v1(uuid),
  app_private.lifecycle_reminder_sources_json_v1(uuid),app_private.lifecycle_allowed_buildings_v1(uuid,uuid,text,uuid[]),
  app_private.lifecycle_allowed_cached_v1(uuid,uuid,text,uuid[],jsonb),app_private.lifecycle_reminder_payload_from_v1(text,jsonb,uuid[]),
  app_private.lifecycle_recipient_allowed_v1(uuid,uuid,uuid,text),
  app_private.lifecycle_reminder_payload_v1(uuid,uuid,text),app_private.lifecycle_gate_v2(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.lifecycle_reminder_sweep_v1(uuid),public.lifecycle_reminder_claim_v1(integer),
  public.lifecycle_reminder_validate_v1(uuid,uuid),public.lifecycle_reminder_org_ids_v1() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.lifecycle_reminder_sweep_v1(uuid),public.lifecycle_reminder_claim_v1(integer),
  public.lifecycle_reminder_validate_v1(uuid,uuid),public.lifecycle_reminder_org_ids_v1() TO service_role;

DO $nghiem_thu$
DECLARE v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.lifecycle_reminder_sweep_v1(uuid)','public.lifecycle_reminder_claim_v1(integer)',
    'public.lifecycle_reminder_validate_v1(uuid,uuid)','public.lifecycle_reminder_org_ids_v1()'] LOOP
    IF has_function_privilege('anon',v_sig,'EXECUTE') OR has_function_privilege('authenticated',v_sig,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_sig,'EXECUTE') THEN
      RAISE EXCEPTION 'nghiệm thu: ACL sai ở %', v_sig USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF app_private.lifecycle_family_event_v1('INVOICE_OVERDUE') IS DISTINCT FROM 'BILLING'
     OR app_private.lifecycle_family_type_v1('DEPOSIT_SHORTFALL')::text IS DISTINCT FROM 'DEPOSIT_SHORTFALL'
     OR app_private.lifecycle_family_type_v1('EXIT')::text IS DISTINCT FROM 'ACTION_REQUIRED'
     OR app_private.lifecycle_family_perm_v1('INVOICE_DUE') IS DISTINCT FROM 'invoices.view'
     OR app_private.lifecycle_family_perm_v1('TURNOVER') IS DISTINCT FROM 'rooms.view'
     OR app_private.lifecycle_family_perm_v1('DEPOSIT_SHORTFALL') IS DISTINCT FROM 'contracts.view' THEN
    RAISE EXCEPTION 'nghiệm thu: bảng họ → khoá/loại/quyền lệch' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app_private'
                  AND table_name='lifecycle_reminder_sweep_state' AND column_name='had_payload') THEN
    RAISE EXCEPTION 'nghiệm thu: sweep_state thiếu had_payload' USING ERRCODE='55000';
  END IF;
END $nghiem_thu$;

NOTIFY pgrst,'reload schema';
COMMIT;
