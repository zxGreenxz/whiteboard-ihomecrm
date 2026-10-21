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
--     bản ghi: 59 hoá đơn × 5 người × 2 lần atav3 (~17 ms) mỗi 15' là quá đắt.
--   * Một dòng chuông / người / ngày / họ, số cập nhật mỗi lượt (chỉ UPDATE khi nội dung đổi — không đẻ sự kiện realtime
--     thừa). Về 0 ⇒ dòng PENDING của họ đó thành CANCELLED (cancelled_reason SOURCE_RESOLVED; áp cả NOTICE/TURNOVER/
--     EXIT; KHÔNG BAO GIỜ đụng READ); nguồn quay lại trong ngày ⇒ dòng hôm nay mở lại PENDING. Dòng ngày mới thay dòng
--     cũ: dòng PENDING của ngày trước cùng họ thành CANCELLED (SUPERSEDED) — không còn mỗi ngày một dòng chồng lên.
--   * type giữ enum cũ để bản web cũ hiện đúng biểu tượng: INVOICE_DUE→PAYMENT_REMINDER, INVOICE_OVERDUE→
--     OVERDUE_INVOICE, CONTRACT_EXPIRING→CONTRACT_EXPIRING, DEPOSIT_SHORTFALL→DEPOSIT_SHORTFALL (NOTICE/TURNOVER/EXIT
--     giữ ACTION_REQUIRED). metadata.event: LIFECYCLE | BILLING | CONTRACT_EXPIRY | DEPOSIT — luôn có ⇒ trigger
--     a00_notifications_guard (chỉ chặn nhắc legacy thiếu event) và notification_reconcile_stale_v1 không đụng.
--   * Cổng: app_private.lifecycle_gate_v2(user, org, họ) đọc đúng khoá sở thích + events công ty theo họ; sweep/claim/
--     validate chuyển sang v2. Claim dùng giờ yên chung app_private.notify_in_quiet_hours_v1 (công ty HOẶC cá nhân).
--   * Nội dung chỉ là số đếm, không tên khách, không số tiền (như lane lifecycle hiện tại).
-- url: /contracts, /rooms có trong NOTIFICATION_URL_ALLOWLIST; /invoices (trang danh sách, RequirePermission
-- module invoices) CHƯA có bản không-id trong allowlist — gói C/tích hợp thêm (ghi trong báo cáo gói B).
--
-- Cần 20261021171249_notify_pipeline_v2 (khoá sở thích BILLING/CONTRACT_EXPIRY/DEPOSIT, notify_in_quiet_hours_v1).
-- Không ghi dữ liệu nghiệp vụ; tên RPC lane giữ nguyên (sweep/claim/validate/settle/record_failure) — edge không đổi
-- hợp đồng gọi. Chạy lại an toàn.
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

CREATE OR REPLACE FUNCTION app_private.lifecycle_reminder_sources_v1(p_org uuid)
RETURNS TABLE(source_family text,source_id uuid,building_id uuid,revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT 'NOTICE',c.id,b.id,c.updated_at::text FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id
    WHERE c.organization_id=p_org AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND c.expected_move_out_date<=public.org_today_v1(p_org)
  UNION ALL
  SELECT 'TURNOVER',t.id,b.id,t.epoch::text||':'||t.version::text FROM public.room_turnovers t
    JOIN public.rooms r ON r.id=t.room_id AND r.organization_id=t.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=t.organization_id
    WHERE t.organization_id=p_org AND t.status='PENDING' AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND (t.expected_ready_on IS NULL OR t.expected_ready_on<=public.org_today_v1(p_org))
  UNION ALL
  SELECT 'EXIT',e.id,e.building_id,e.version::text FROM public.contract_exit_cases e
    WHERE e.organization_id=p_org AND e.state='PENDING'
  UNION ALL
  -- Hoá đơn còn nợ: quá hạn (kể cả trạng thái OVERDUE) hoặc đến hạn trong 3 ngày tới. remaining_amount là cột
  -- GENERATED (total_amount - paid_amount) — cùng điều kiện "nợ" của Hermes (20261020233934).
  SELECT CASE WHEN i.due_date<public.org_today_v1(p_org) THEN 'INVOICE_OVERDUE' ELSE 'INVOICE_DUE' END,
         i.id,b.id,i.updated_at::text FROM public.invoices i
    JOIN public.buildings b ON b.id=i.building_id AND b.organization_id=i.organization_id
    WHERE i.organization_id=p_org AND i.deleted_at IS NULL AND b.deleted_at IS NULL AND i.remaining_amount>0
      AND ((i.status::text IN ('APPROVED','PARTIAL_PAID','OVERDUE') AND i.due_date<public.org_today_v1(p_org))
        OR (i.status::text IN ('APPROVED','PARTIAL_PAID')
            AND i.due_date BETWEEN public.org_today_v1(p_org) AND public.org_today_v1(p_org)+3))
  UNION ALL
  SELECT 'CONTRACT_EXPIRING',c.id,b.id,c.updated_at::text FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id
    WHERE c.organization_id=p_org AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND c.end_date<=public.org_today_v1(p_org)+30
  UNION ALL
  SELECT 'DEPOSIT_SHORTFALL',c.id,b.id,c.updated_at::text FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id
    WHERE c.organization_id=p_org AND c.status='ACTIVE' AND c.actual_end_date IS NULL AND c.deleted_at IS NULL
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND c.deposit_remaining>=10000
      AND (c.deposit_debt_mode IS NULL OR c.deposit_debt_mode='DEBT');
$fn$;

-- Bên gọi đã lấy lock_org_for_decision_v1 ở câu trước. Resolver quyền thật theo người nhận, không set JWT claims.
CREATE OR REPLACE FUNCTION app_private.lifecycle_recipient_allowed_v1(p_user uuid,p_org uuid,p_building uuid,p_family text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT EXISTS(SELECT 1 FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=p_user AND m.organization_id=p_org AND m.status='ACTIVE' AND o.status='ACTIVE'
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=clock_timestamp() AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
    AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=p_building AND b.organization_id=p_org
      AND NOT (EXISTS(SELECT 1 FROM public.super_admins sa WHERE sa.user_id=p_user)
        AND (COALESCE(p_org=ANY(public.sandbox_org_ids()),false) OR COALESCE(b.user_id=ANY(public.demo_user_ids()),false))))
    AND COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(p_user,p_org,'buildings.view',p_building,NULL)),false)
    AND COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(p_user,p_org,
      CASE WHEN p_family='TURNOVER' THEN 'rooms.view'
           WHEN p_family IN ('INVOICE_DUE','INVOICE_OVERDUE') THEN 'invoices.view'
           ELSE 'contracts.view' END,p_building,NULL)),false);
$fn$;

CREATE OR REPLACE FUNCTION app_private.lifecycle_reminder_payload_v1(p_user uuid,p_org uuid,p_family text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE n integer; ids jsonb; title text; body text; route text;
BEGIN
  -- Quyền xét theo TOÀ (một lần mỗi toà có nguồn), rồi đếm mọi nguồn thuộc các toà được phép.
  WITH s AS (SELECT x.source_id,x.building_id,x.revision FROM app_private.lifecycle_reminder_sources_v1(p_org) x
              WHERE x.source_family=p_family),
       ok AS (SELECT b.building_id FROM (SELECT DISTINCT s.building_id FROM s WHERE s.building_id IS NOT NULL) b
               WHERE app_private.lifecycle_recipient_allowed_v1(p_user,p_org,b.building_id,p_family))
  SELECT count(*),COALESCE(jsonb_agg(jsonb_build_object('id',s.source_id,'revision',s.revision) ORDER BY s.source_id),'[]')
    INTO n,ids
    FROM s WHERE s.building_id IN (SELECT ok.building_id FROM ok);
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

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_sweep_v1(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org record; u record; family text; payload jsonb; gate record; delivery uuid; notif uuid; today date;
  inserted integer:=0; org_inserted integer; missing jsonb; recipient_count integer; local_now timestamp;
  existing_delivery record; has_sources boolean; v_event text; v_type public.notification_type; v_day text;
  cancelled integer:=0; v_n integer; v_now timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('lifecycle_reminder_sweep_v1')::bigint) THEN RETURN jsonb_build_object('inserted',0,'busy',true); END IF;
  FOR v_org IN SELECT id FROM public.organizations WHERE status='ACTIVE' AND (p_organization_id IS NULL OR id=p_organization_id) ORDER BY id LOOP
    local_now:=clock_timestamp() AT TIME ZONE app_private.org_timezone_v1(v_org.id);
    IF extract(hour FROM local_now)<8 THEN CONTINUE; END IF;
    PERFORM app_private.lock_org_for_decision_v1(v_org.id);
    today:=public.org_today_v1(v_org.id); v_day:=to_char(today,'YYYY-MM-DD'); org_inserted:=0; missing:='[]';
    FOREACH family IN ARRAY ARRAY['NOTICE','TURNOVER','EXIT','INVOICE_DUE','INVOICE_OVERDUE','CONTRACT_EXPIRING','DEPOSIT_SHORTFALL'] LOOP
      v_event:=app_private.lifecycle_family_event_v1(family);
      v_type:=app_private.lifecycle_family_type_v1(family);
      has_sources:=EXISTS(SELECT 1 FROM app_private.lifecycle_reminder_sources_v1(v_org.id) s WHERE s.source_family=family);
      recipient_count:=0;
      FOR u IN SELECT DISTINCT user_id FROM public.organization_memberships WHERE organization_id=v_org.id AND status='ACTIVE' ORDER BY user_id LOOP
        payload:=CASE WHEN has_sources THEN app_private.lifecycle_reminder_payload_v1(u.user_id,v_org.id,family) END;
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
        recipient_count:=recipient_count+1;
        SELECT * INTO gate FROM app_private.lifecycle_gate_v2(u.user_id,v_org.id,family);
        INSERT INTO app_private.lifecycle_reminder_deliveries(organization_id,user_id,reminder_day,source_family,push_status,last_error)
          VALUES(v_org.id,u.user_id,today,family,CASE WHEN gate.push THEN 'PENDING' ELSE 'DISABLED' END,
            CASE WHEN gate.push THEN NULL ELSE 'Organization/personal push preference disabled or cadence DIGEST/OFF' END)
          ON CONFLICT(organization_id,user_id,reminder_day,source_family) DO NOTHING RETURNING id INTO delivery;
        IF delivery IS NULL THEN
          SELECT id,notification_id INTO existing_delivery FROM app_private.lifecycle_reminder_deliveries
            WHERE organization_id=v_org.id AND user_id=u.user_id AND reminder_day=today AND source_family=family FOR UPDATE;
          IF gate.in_app AND existing_delivery.notification_id IS NOT NULL THEN
            -- Cập nhật số đếm/tham chiếu, KHÔNG reset cờ đã đọc, KHÔNG đẻ thêm push. Dòng do chính sweep huỷ vì về 0
            -- (SOURCE_RESOLVED) mà nguồn quay lại trong ngày ⇒ mở lại PENDING. Chỉ ghi khi có gì đổi.
            UPDATE public.notifications n SET type=v_type,
              subject=payload->>'title',content=payload->>'body',
              status=CASE WHEN n.status='CANCELLED' AND n.metadata->>'cancelled_reason'='SOURCE_RESOLVED' THEN 'PENDING'::public.notification_status
                          ELSE n.status END,
              metadata=(CASE WHEN n.status='CANCELLED' AND n.metadata->>'cancelled_reason'='SOURCE_RESOLVED'
                             THEN COALESCE(n.metadata,'{}')-'cancelled_reason'-'cancelled_at'-'cancelled_by'
                             ELSE COALESCE(n.metadata,'{}') END)
                ||jsonb_build_object('event',v_event,'source_family',family,'day',today,
                'url',payload->>'url','count',payload->'count','sources',payload->'sources','delivery_id',existing_delivery.id)
              WHERE n.id=existing_delivery.notification_id
                AND (n.type IS DISTINCT FROM v_type OR n.subject IS DISTINCT FROM payload->>'title'
                  OR n.content IS DISTINCT FROM payload->>'body' OR n.metadata->'sources' IS DISTINCT FROM payload->'sources'
                  OR n.metadata->>'event' IS DISTINCT FROM v_event
                  OR (n.status='CANCELLED' AND n.metadata->>'cancelled_reason'='SOURCE_RESOLVED'));
          END IF;
          CONTINUE;
        END IF;
        IF gate.in_app THEN
          -- Dòng ngày mới thay dòng chưa đọc của ngày trước cùng họ.
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
        END IF;
        org_inserted:=org_inserted+1;
      END LOOP;
      IF has_sources AND recipient_count=0 THEN missing:=missing||jsonb_build_array(family); END IF;
    END LOOP;
    INSERT INTO app_private.lifecycle_reminder_runs(organization_id,inserted,no_recipient_families,status)
      VALUES(v_org.id,org_inserted,missing,CASE WHEN missing='[]'::jsonb THEN 'OK' ELSE 'NO_RECIPIENT' END);
    inserted:=inserted+org_inserted;
  END LOOP;
  RETURN jsonb_build_object('inserted',inserted,'cancelled',cancelled);
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
  payload:=app_private.lifecycle_reminder_payload_v1(d.user_id,d.organization_id,d.source_family);
  SELECT * INTO gate FROM app_private.lifecycle_gate_v2(d.user_id,d.organization_id,d.source_family);
  IF payload IS NULL OR NOT gate.push OR d.reminder_day<>public.org_today_v1(d.organization_id) THEN
    UPDATE app_private.lifecycle_reminder_deliveries SET push_status=CASE WHEN NOT gate.push THEN 'DISABLED' ELSE 'SKIPPED' END,
      last_error='Source resolved, read scope changed, day expired, or push disabled',lease=NULL,leased_at=NULL WHERE id=p_id;
    RETURN NULL;
  END IF;
  RETURN payload||jsonb_build_object('id',d.id,'lease',d.lease,'user_id',d.user_id,'organization_id',d.organization_id,
    'notification_ids',CASE WHEN d.notification_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(d.notification_id) END,'idempotency_key',d.idempotency_key);
END $fn$;

CREATE OR REPLACE FUNCTION public.lifecycle_reminder_claim_v1(p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE d record; payload jsonb; gate record; v_lease uuid; out jsonb:='[]'; receipt record;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'Invalid lifecycle batch size' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('lifecycle_reminder_claim_v1')::bigint) THEN RETURN out; END IF;
  FOR d IN SELECT * FROM app_private.lifecycle_reminder_deliveries
    WHERE (push_status='PENDING' AND next_attempt_at<=clock_timestamp()) OR (push_status='SENDING' AND leased_at<clock_timestamp()-interval '10 minutes')
    ORDER BY organization_id,created_at,id LIMIT p_limit LOOP
    PERFORM app_private.lock_org_for_decision_v1(d.organization_id);
    SELECT * INTO d FROM app_private.lifecycle_reminder_deliveries WHERE id=d.id FOR UPDATE;
    SELECT outcome,sent INTO receipt FROM public.push_send_log WHERE idempotency_key=d.idempotency_key;
    IF receipt.sent>0 AND receipt.outcome IN ('SENT','PARTIAL') THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status='SENT',delivered_at=clock_timestamp(),lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    payload:=app_private.lifecycle_reminder_payload_v1(d.user_id,d.organization_id,d.source_family);
    SELECT * INTO gate FROM app_private.lifecycle_gate_v2(d.user_id,d.organization_id,d.source_family);
    IF payload IS NULL OR d.reminder_day<>public.org_today_v1(d.organization_id) OR NOT gate.push THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status=CASE WHEN NOT gate.push THEN 'DISABLED' ELSE 'SKIPPED' END,
        last_error='Source resolved, read scope changed, day expired, or push disabled',lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE user_id=d.user_id AND is_active) THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status='NO_DEVICE',last_error='No active push device',lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    IF d.attempts>=3 THEN
      UPDATE app_private.lifecycle_reminder_deliveries SET push_status='FAILED',last_error=COALESCE(last_error,'Push lease expired after 3 attempts'),lease=NULL,leased_at=NULL WHERE id=d.id;
      CONTINUE;
    END IF;
    -- Giờ yên công ty (mặc định 21→7 khi chưa cấu hình) HOẶC giờ yên cá nhân, theo múi giờ công ty ⇒ hoãn lượt sau.
    IF app_private.notify_in_quiet_hours_v1(d.user_id,d.organization_id,clock_timestamp()) THEN CONTINUE; END IF;
    v_lease:=gen_random_uuid();
    UPDATE app_private.lifecycle_reminder_deliveries SET push_status='SENDING',attempts=attempts+1,lease=v_lease,leased_at=clock_timestamp(),
      idempotency_key='lifecycle:'||id::text||':'||(attempts+1)::text WHERE id=d.id;
    payload:=public.lifecycle_reminder_validate_v1(d.id,v_lease);
    IF payload IS NOT NULL THEN out:=out||jsonb_build_array(payload); END IF;
  END LOOP;
  RETURN out;
END $fn$;

REVOKE ALL ON FUNCTION app_private.lifecycle_family_event_v1(text),app_private.lifecycle_family_type_v1(text),
  app_private.lifecycle_reminder_sources_v1(uuid),app_private.lifecycle_recipient_allowed_v1(uuid,uuid,uuid,text),
  app_private.lifecycle_reminder_payload_v1(uuid,uuid,text),app_private.lifecycle_gate_v2(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.lifecycle_reminder_sweep_v1(uuid),public.lifecycle_reminder_claim_v1(integer),
  public.lifecycle_reminder_validate_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.lifecycle_reminder_sweep_v1(uuid),public.lifecycle_reminder_claim_v1(integer),
  public.lifecycle_reminder_validate_v1(uuid,uuid) TO service_role;

DO $nghiem_thu$
DECLARE v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.lifecycle_reminder_sweep_v1(uuid)','public.lifecycle_reminder_claim_v1(integer)',
    'public.lifecycle_reminder_validate_v1(uuid,uuid)'] LOOP
    IF has_function_privilege('anon',v_sig,'EXECUTE') OR has_function_privilege('authenticated',v_sig,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_sig,'EXECUTE') THEN
      RAISE EXCEPTION 'nghiệm thu: ACL sai ở %', v_sig USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF app_private.lifecycle_family_event_v1('INVOICE_OVERDUE') IS DISTINCT FROM 'BILLING'
     OR app_private.lifecycle_family_type_v1('DEPOSIT_SHORTFALL')::text IS DISTINCT FROM 'DEPOSIT_SHORTFALL'
     OR app_private.lifecycle_family_type_v1('EXIT')::text IS DISTINCT FROM 'ACTION_REQUIRED' THEN
    RAISE EXCEPTION 'nghiệm thu: bảng họ → khoá/loại lệch' USING ERRCODE='55000';
  END IF;
END $nghiem_thu$;

NOTIFY pgrst,'reload schema';
COMMIT;
