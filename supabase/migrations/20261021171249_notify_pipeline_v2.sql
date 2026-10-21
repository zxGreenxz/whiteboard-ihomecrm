-- Pipeline thông báo phía database, đợt 21/10/2026 (plan docs/plans/2026-10-21-realtime-thong-bao-toi-uu.md,
-- gói B, mục B1 B2 B3 B4 B6 B8 B9 B10 + helper B13). Một transaction, chạy hai lượt liền không lỗi, không nhân dữ liệu.
--
-- VÌ SAO (đo production CHỈ ĐỌC 21–22/10/2026, chi tiết trong digest NOTIF-SERVER / NOTIF-SETTINGS / CRITIC):
--   * authenticated có UPDATE/INSERT cấp bảng trên notifications và tự đặt được push_state/created_at/push_idem_key
--     trên dòng của mình ⇒ một tài khoản chiếm trọn lô drain của cả hệ thống (NOTIF-SERVER-6).
--   * drain không lọc dòng đã đọc, gộp chéo công ty, DUPLICATE bị tính là SENT dù lượt trước lỗi, dòng E1 kẹt sau
--     3 lượt vì UPSERT không reset push_attempts (NOTIF-SERVER-5/9/10, M1).
--   * 2.696 nhắc hoá đơn/HĐ/cọc do trình duyệt sinh (metadata.event NULL) còn PENDING, đa số trỏ việc đã xong; 31
--     thông báo E5/E6a trỏ bàn giao đã CONFIRMED/CANCELLED (CRITIC-1). Bộ nhắc chuyển lên server ở migration
--     20261021171251_nhac_viec_server_lifecycle_v1.sql; file này chặn bản production cũ đẻ thêm và dọn tồn đọng.
--   * DELETE của dòng gộp E1 không qua được filter user_id của realtime vì REPLICA IDENTITY DEFAULT (RT-DB-7).
--
-- NỘI DUNG
--   1. Sở thích: khoá mới BILLING, CONTRACT_EXPIRY, DEPOSIT (CHECK + normalize + read). notify_gate_v1 chỉ áp
--      min_amount cho E2*, E3, E6c (E1/E4 truyền NULL; E5/E6a/E6b là việc chờ mình làm — ngưỡng nuốt mất việc).
--   2. Giờ yên: bảng public.notification_quiet_hours (cá nhân, theo công ty) + helper
--      app_private.notify_in_quiet_hours_v1 (giờ yên công ty — mặc định 21→7 khi chưa có dòng — HOẶC cá nhân,
--      theo múi giờ công ty) + app_private.notify_push_allowed_now_v1 cho lane gửi thẳng (B13) + RPC get/set.
--   3. get/set_notification_org_config_v2 theo công ty tường minh, set có p_expected_updated_at ⇒ lệch là PT409.
--   4. Trigger a00_notifications_guard (SECURITY INVOKER, theo khuôn app_private.khoa_organization_id_v1): vai không
--      tin cậy (authenticated/anon) INSERT bị ép push_*/sent_at/created_at; INSERT 4 loại nhắc legacy thiếu
--      metadata.event bị BỎ (BEFORE trả NULL — bản web cũ insert không .select() nên không lỗi); UPDATE chỉ đổi được
--      status PENDING→READ, mọi cột khác giữ OLD. Mọi vai: rời PENDING mà push_state='QUEUED' ⇒ 'SKIPPED'.
--   5. REPLICA IDENTITY FULL cho notifications.
--   6. notify_ie_pending_refresh_v1 (E1): khi số phiếu tăng (bump) thì reset push_attempts=0, push_leased_at=NULL.
--   7. notify_claim_push_batch_v2 / notify_settle_push_batch_v2 (+ wrapper public, chỉ service_role). Bản v1 giữ
--      chữ ký, thân uỷ quyền v2 (salary-v5-jobs vẫn gọi v1 tới khi edge chuyển).
--   8. Dọn lỗi thời: app_private.notification_reconcile_stale_v1 + public.notification_maintenance_v1 (dọn
--      push_send_log > 30 ngày tối đa 1 lần/ngày) + sổ app_private.notification_drain_runs và
--      public.notify_drain_record_run_v1.
--   9. get_notification_delivery_health_v1 (settings.view), get_my_push_log_v1.
--  10. Vệ sinh ACL: anon mất mọi quyền trên push_subscriptions/notification_logs/notification_templates,
--      authenticated mất TRUNCATE trên ba bảng đó.
--  11. Dọn lần đầu (B6) trong chính migration.
--
-- DỌN LẦN ĐẦU — số đo 22/10/2026 (production, chỉ đọc): nhắc legacy PENDING thiếu metadata.event = 2.696
--   (PAYMENT_REMINDER 1.491 · OVERDUE_INVOICE 517 · CONTRACT_EXPIRING 599 · DEPOSIT_SHORTFALL 89); E5/E6a PENDING trỏ
--   bàn giao đã xong = 31 (E5→CONFIRMED 14, E5→CANCELLED 3, E6a→CONFIRMED 14). Chỉ đổi status PENDING→CANCELLED,
--   KHÔNG xoá. Khôi phục nếu cần (một câu, trong lane):
--     UPDATE public.notifications SET status='PENDING',
--            metadata = metadata - 'cancelled_reason' - 'cancelled_at' - 'cancelled_by' - 'cancelled_by_migration'
--      WHERE metadata->>'cancelled_by_migration' = '20261021171249_notify_pipeline_v2';
--
-- TƯƠNG THÍCH bản web production đang chạy (cùng database): đếm chưa đọc = status PENDING nên CANCELLED tự ẩn khỏi
-- chuông; "đánh dấu tất cả đã đọc" (.neq('status','READ')) vẫn chạy — dòng CANCELLED giữ CANCELLED; bộ nhắc
-- trình duyệt (useScheduledNotifications) insert không .select() ⇒ bị bỏ êm.
--
-- SAU KHI APPLY (người tích hợp): npm run gen:types; provenance; org-boundary inventory (bảng mới có policy
-- notification_quiet_hours_org_boundary); edge lifecycle-reminders chuyển drain sang v2 (gói B-EDGE).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- =====================================================================================================================
-- 0. Điều kiện tiên quyết — thiếu là dừng, không đoán.
-- =====================================================================================================================
DO $tien_quyet$
BEGIN
  IF to_regclass('public.notifications') IS NULL
     OR to_regclass('public.push_subscriptions') IS NULL
     OR to_regclass('public.push_send_log') IS NULL
     OR to_regclass('public.notification_preferences') IS NULL
     OR to_regclass('public.notification_logs') IS NULL
     OR to_regclass('public.notification_templates') IS NULL
     OR to_regclass('public.cash_handovers') IS NULL
     OR to_regclass('app_private.notification_org_config') IS NULL
     OR to_regclass('app_private.notification_no_recipient_log') IS NULL
     OR to_regclass('app_private.lifecycle_reminder_deliveries') IS NULL
     OR to_regclass('app_private.lifecycle_reminder_runs') IS NULL THEN
    RAISE EXCEPTION 'notify_pipeline_v2: thiếu bảng nền của hệ thông báo (20260729* / 20260928024843)' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'push_idem_key') THEN
    RAISE EXCEPTION 'notify_pipeline_v2: notifications chưa có cột hàng đợi push (20260729141000)' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.org_timezone_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.require_perm_v1(uuid,text,text)') IS NULL
     OR to_regprocedure('app_private.assert_notification_membership_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.notify_gate_v1(uuid,uuid,text,numeric)') IS NULL
     OR to_regprocedure('app_private.notify_ie_pending_refresh_v1(uuid,uuid)') IS NULL
     OR to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
     OR to_regprocedure('public.my_org_ids()') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('public.sandbox_org_ids()') IS NULL THEN
    RAISE EXCEPTION 'notify_pipeline_v2: thiếu hàm nền (quyền/múi giờ/cổng thông báo)' USING ERRCODE = '55000';
  END IF;
END $tien_quyet$;

-- =====================================================================================================================
-- 1. B8 — khoá sở thích mới BILLING, CONTRACT_EXPIRY, DEPOSIT (họ nhắc server ở 20261021171251).
--    Thân ba hàm = bản production 22/10 (đã có E6, LIFECYCLE) + ba khoá mới. Cùng chữ ký, cùng IMMUTABLE/STABLE.
-- =====================================================================================================================
ALTER TABLE public.notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_event_key_ck;
ALTER TABLE public.notification_preferences ADD CONSTRAINT notification_preferences_event_key_ck
  CHECK (event_key IN ('E1','E2','E3','E4','E5','E6','LIFECYCLE','BILLING','CONTRACT_EXPIRY','DEPOSIT'));

CREATE OR REPLACE FUNCTION app_private.notification_events_normalize_v1(p_events jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
declare
  v_keys constant text[] := array['E1','E2','E3','E4','E5','E6','LIFECYCLE','BILLING','CONTRACT_EXPIRY','DEPOSIT'];
  v_out  jsonb := '{}'::jsonb;
  v_src  jsonb;
  k       text;
  v       jsonb;
  v_on    boolean;
  v_min   numeric;
begin
  v_src := p_events;
  if v_src is null or jsonb_typeof(v_src) = 'null' then
    v_src := '{}'::jsonb;
  end if;
  if jsonb_typeof(v_src) <> 'object' then
    raise exception 'Cấu hình sự kiện phải là một object JSON.' using errcode = '22023';
  end if;

  -- Khoá lạ là lỗi, không im lặng bỏ qua: im lặng = người dùng tưởng đã tắt mà thực ra chưa.
  for k in select jsonb_object_keys(v_src) loop
    if not (k = any (v_keys)) then
      raise exception 'Sự kiện không hợp lệ: %. Chỉ nhận E1, E2, E3, E4, E5, E6, LIFECYCLE, BILLING, CONTRACT_EXPIRY, DEPOSIT.', k
        using errcode = '22023';
    end if;
  end loop;

  foreach k in array v_keys loop
    v := v_src -> k;
    if v is null or jsonb_typeof(v) = 'null' then
      v_out := v_out || jsonb_build_object(k, jsonb_build_object('enabled', true, 'min_amount', null));
      continue;
    end if;
    if jsonb_typeof(v) <> 'object' then
      raise exception 'Cấu hình sự kiện % phải là object JSON.', k using errcode = '22023';
    end if;

    if jsonb_exists(v, 'enabled') and jsonb_typeof(v -> 'enabled') <> 'boolean' then
      raise exception 'events.%.enabled phải là true hoặc false.', k using errcode = '22023';
    end if;
    v_on := coalesce((v ->> 'enabled')::boolean, true);

    if jsonb_exists(v, 'min_amount') and jsonb_typeof(v -> 'min_amount') not in ('null', 'number') then
      raise exception 'events.%.min_amount phải là số hoặc null.', k using errcode = '22023';
    end if;
    if jsonb_exists(v, 'min_amount') and jsonb_typeof(v -> 'min_amount') = 'number' then
      v_min := (v ->> 'min_amount')::numeric;
      if v_min < 0 then
        raise exception 'events.%.min_amount không được âm.', k using errcode = '22023';
      end if;
    else
      v_min := null;
    end if;

    v_out := v_out || jsonb_build_object(k, jsonb_build_object('enabled', v_on, 'min_amount', v_min));
  end loop;

  return v_out;
end
$fn$;

CREATE OR REPLACE FUNCTION app_private.notification_prefs_normalize_v1(p_prefs jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
declare
  v_keys      constant text[] := array['E1','E2','E3','E4','E5','E6','LIFECYCLE','BILLING','CONTRACT_EXPIRY','DEPOSIT'];
  v_cadences  constant text[] := array['IMMEDIATE','DIGEST','OFF'];
  v_out jsonb := '{}'::jsonb;
  k     text;
  v     jsonb;
  v_cad text;
begin
  if p_prefs is null or jsonb_typeof(p_prefs) = 'null' then
    raise exception 'Thiếu dữ liệu sở thích thông báo.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_prefs) <> 'object' then
    raise exception 'Sở thích thông báo phải là một object JSON.' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(p_prefs) loop
    if not (k = any (v_keys)) then
      raise exception 'Sự kiện không hợp lệ: %. Chỉ nhận E1, E2, E3, E4, E5, E6, LIFECYCLE, BILLING, CONTRACT_EXPIRY, DEPOSIT.', k
        using errcode = '22023';
    end if;
    v := p_prefs -> k;
    if jsonb_typeof(v) <> 'object' then
      raise exception 'Sở thích của % phải là object JSON.', k using errcode = '22023';
    end if;
    if jsonb_exists(v, 'in_app') and jsonb_typeof(v -> 'in_app') <> 'boolean' then
      raise exception '%.in_app phải là true hoặc false.', k using errcode = '22023';
    end if;
    if jsonb_exists(v, 'push') and jsonb_typeof(v -> 'push') <> 'boolean' then
      raise exception '%.push phải là true hoặc false.', k using errcode = '22023';
    end if;

    -- FIELD VẮNG ⇒ PHÁT JSON `null` (setter coalesce với giá trị cũ), KHÔNG phát mặc định — xem 20260729150000.
    if jsonb_exists(v, 'cadence') then
      v_cad := upper(v ->> 'cadence');
      if not (v_cad = any (v_cadences)) then
        raise exception 'Nhịp gửi không hợp lệ: %. Chỉ nhận IMMEDIATE, DIGEST, OFF.', v_cad
          using errcode = '22023';
      end if;
    else
      v_cad := null;
    end if;

    v_out := v_out || jsonb_build_object(k, jsonb_build_object(
      'in_app',  case when jsonb_exists(v, 'in_app')  then (v ->> 'in_app')::boolean  else null end,
      'push',    case when jsonb_exists(v, 'push')    then (v ->> 'push')::boolean    else null end,
      'cadence', v_cad));
  end loop;

  if v_out = '{}'::jsonb then
    raise exception 'Không có sự kiện nào để lưu.' using errcode = '22023';
  end if;
  return v_out;
end
$fn$;

CREATE OR REPLACE FUNCTION app_private.notification_prefs_read_v1(p_user uuid, p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  select coalesce(jsonb_object_agg(k.event_key, jsonb_build_object(
           'in_app',  coalesce(np.in_app, true),
           'push',    coalesce(np.push, true),
           'cadence', coalesce(np.cadence, 'IMMEDIATE'),
           'updated_at', np.updated_at)), '{}'::jsonb)
    from (values ('E1'),('E2'),('E3'),('E4'),('E5'),('E6'),('LIFECYCLE'),('BILLING'),('CONTRACT_EXPIRY'),('DEPOSIT'))
           as k(event_key)
    left join public.notification_preferences np
      on np.user_id = p_user
     and np.organization_id = p_org
     and np.event_key = k.event_key;
$fn$;

REVOKE ALL ON FUNCTION app_private.notification_events_normalize_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.notification_prefs_normalize_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.notification_prefs_read_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- B8 — notify_gate_v1: thân = bản production, đổi hai chỗ:
--   (1) min_amount chỉ áp cho họ THÔNG TIN mang một số tiền: E2* (kết quả duyệt), E3, E6c (biên bản chốt sổ).
--       E1/E4 truyền amount NULL (ngưỡng vô tác dụng); E5/E6a/E6b là việc chờ người nhận xử lý — lọc theo tiền là
--       nuốt việc (NOTIF-SETTINGS-9). Claim v2 gọi lại cổng với amount NULL nên ngưỡng không áp lần hai.
--   (2) không có dòng sở thích ⇒ trả true/true thay vì NULL/NULL (mọi nơi gọi đều coalesce(…, true) nên hành vi như
--       cũ; claim v2 đọc thẳng g_push).
CREATE OR REPLACE FUNCTION app_private.notify_gate_v1(p_user uuid, p_org uuid, p_event text, p_amount numeric DEFAULT NULL::numeric)
 RETURNS TABLE(g_in_app boolean, g_push boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
declare
  v_family  text := case when p_event like 'E2%' then 'E2' when p_event like 'E6%' then 'E6' else p_event end;  -- §B.7 BẮT BUỘC
  v_cfg     jsonb;
  v_min     numeric;
  v_in      boolean := true;
  v_push    boolean := true;
  v_cadence text := 'IMMEDIATE';
begin
  begin
    select c.events -> v_family into v_cfg
      from app_private.notification_org_config c
     where c.organization_id = p_org;

    if v_cfg is not null then
      if coalesce((v_cfg->>'enabled')::boolean, true) = false then
        g_in_app := false; g_push := false; return next; return;
      end if;
      v_min := nullif(v_cfg->>'min_amount','')::numeric;
    end if;

    select coalesce(np.in_app, true), coalesce(np.push, true), coalesce(np.cadence,'IMMEDIATE')
      into v_in, v_push, v_cadence
      from public.notification_preferences np
     where np.user_id = p_user and np.organization_id = p_org and np.event_key = v_family;
  exception when others then
    -- Bảng đổi hình dạng: MỞ (thà ồn còn hơn câm), nhưng để lại vết.
    raise warning 'notify_gate_v1: không đọc được cấu hình (user=% org=% event=%): % %',
      p_user, p_org, p_event, sqlstate, sqlerrm;
    v_in := true; v_push := true; v_cadence := 'IMMEDIATE'; v_min := null;
  end;

  -- select … into không thấy dòng sở thích ⇒ ba biến thành NULL; về mặc định.
  v_in := coalesce(v_in, true); v_push := coalesce(v_push, true); v_cadence := coalesce(v_cadence, 'IMMEDIATE');

  if v_cadence = 'OFF' then
    v_in := false; v_push := false;
  elsif v_cadence = 'DIGEST' then
    v_push := false;    -- chưa có bộ gom DIGEST: không đẩy
  end if;

  if v_min is not null and p_amount is not null and p_amount < v_min
     and (p_event like 'E2%' or p_event in ('E3', 'E6c')) then
    v_in := false; v_push := false;
  end if;

  g_in_app := v_in; g_push := v_push; return next;
end $fn$;

REVOKE ALL ON FUNCTION app_private.notify_gate_v1(uuid, uuid, text, numeric) FROM PUBLIC, anon, authenticated, service_role;

-- =====================================================================================================================
-- 2. B8 — giờ yên cá nhân + helper giờ yên dùng chung (claim v2, lifecycle claim, lane gửi thẳng).
-- =====================================================================================================================
CREATE TABLE IF NOT EXISTS public.notification_quiet_hours (
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  quiet_start     smallint NOT NULL DEFAULT 21
    CONSTRAINT notification_quiet_hours_start_ck CHECK (quiet_start BETWEEN 0 AND 23),
  quiet_end       smallint NOT NULL DEFAULT 7
    CONSTRAINT notification_quiet_hours_end_ck CHECK (quiet_end BETWEEN 0 AND 23),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);
ALTER TABLE public.notification_quiet_hours ENABLE ROW LEVEL SECURITY;

-- Đọc trực tiếp: chỉ dòng của mình, trong công ty mình thuộc (khuôn notification_preferences). Ghi: chỉ qua RPC.
DROP POLICY IF EXISTS notification_quiet_hours_own_select ON public.notification_quiet_hours;
CREATE POLICY notification_quiet_hours_own_select ON public.notification_quiet_hours
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS notification_quiet_hours_org_boundary ON public.notification_quiet_hours;
CREATE POLICY notification_quiet_hours_org_boundary ON public.notification_quiet_hours
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS notification_quiet_hours_hide_sandbox_admin ON public.notification_quiet_hours;
CREATE POLICY notification_quiet_hours_hide_sandbox_admin ON public.notification_quiet_hours
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id = ANY (public.sandbox_org_ids()), false)));

-- public có DEFAULT PRIVILEGES cấp arwdDxtm cho anon/authenticated/service_role trên bảng mới ⇒ thu hồi tường minh.
REVOKE ALL ON TABLE public.notification_quiet_hours FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.notification_quiet_hours TO authenticated;

COMMENT ON TABLE public.notification_quiet_hours IS
  'Giờ yên CÁ NHÂN theo công ty. Khoảng [quiet_start, quiet_end) theo múi giờ công ty (app_private.org_timezone_v1), '
  'vắt qua nửa đêm được; start = end = không có giờ yên. Push bị HOÃN (không bỏ), chuông vẫn ghi. '
  'Ghi qua public.set_my_notification_quiet_hours_v1.';

-- Giờ trong khoảng [start, end), vắt nửa đêm; start = end ⇒ không có giờ yên. Một công thức cho mọi nơi.
CREATE OR REPLACE FUNCTION app_private.notify_hour_in_window_v1(p_hour integer, p_start integer, p_end integer)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE
           WHEN p_hour IS NULL OR p_start IS NULL OR p_end IS NULL OR p_start = p_end THEN false
           WHEN p_start < p_end THEN p_hour >= p_start AND p_hour < p_end
           ELSE p_hour >= p_start OR p_hour < p_end
         END;
$fn$;

-- Giờ yên = giờ yên CÔNG TY (dòng config; chưa có dòng ⇒ 21→7, giữ ngữ nghĩa drain cũ) HOẶC giờ yên CÁ NHÂN đang bật.
-- Giờ tính theo múi giờ công ty, KHÔNG phải UTC (cron.timezone = GMT).
CREATE OR REPLACE FUNCTION app_private.notify_in_quiet_hours_v1(p_user uuid, p_org uuid, p_at timestamptz DEFAULT clock_timestamp())
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_hour  integer := extract(hour FROM (coalesce(p_at, clock_timestamp()) AT TIME ZONE app_private.org_timezone_v1(p_org)))::integer;
  v_start integer;
  v_end   integer;
  v_me    record;
BEGIN
  SELECT c.quiet_start, c.quiet_end INTO v_start, v_end
    FROM app_private.notification_org_config c
   WHERE c.organization_id = p_org;
  IF NOT FOUND THEN
    v_start := 21; v_end := 7;
  END IF;
  IF app_private.notify_hour_in_window_v1(v_hour, v_start, v_end) THEN
    RETURN true;
  END IF;

  IF p_user IS NULL OR p_org IS NULL THEN
    RETURN false;
  END IF;
  SELECT q.quiet_start, q.quiet_end INTO v_me
    FROM public.notification_quiet_hours q
   WHERE q.user_id = p_user AND q.organization_id = p_org AND q.enabled;
  RETURN FOUND AND app_private.notify_hour_in_window_v1(v_hour, v_me.quiet_start, v_me.quiet_end);
END $fn$;

-- B13: lane gửi thẳng (pg_net) hỏi helper này trước khi bắn; false ⇒ để QUEUED cho drain chung.
CREATE OR REPLACE FUNCTION app_private.notify_push_allowed_now_v1(p_user uuid, p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT NOT app_private.notify_in_quiet_hours_v1(p_user, p_org, clock_timestamp());
$fn$;

REVOKE ALL ON FUNCTION app_private.notify_hour_in_window_v1(integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.notify_in_quiet_hours_v1(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.notify_push_allowed_now_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.notification_quiet_hours_read_v1(p_user uuid, p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT jsonb_build_object(
           'organization_id', p_org,
           'enabled',         coalesce(q.enabled, false),
           'quiet_start',     coalesce(q.quiet_start, 21),
           'quiet_end',       coalesce(q.quiet_end, 7),
           'quiet_timezone',  app_private.org_timezone_v1(p_org),
           'updated_at',      q.updated_at)
    FROM (SELECT 1) seed
    LEFT JOIN public.notification_quiet_hours q ON q.user_id = p_user AND q.organization_id = p_org;
$fn$;
REVOKE ALL ON FUNCTION app_private.notification_quiet_hours_read_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Cổng: chỉ membership ACTIVE trong p_organization_id (giờ yên của CHÍNH MÌNH, không phải hành vi quản trị).
CREATE OR REPLACE FUNCTION public.get_my_notification_quiet_hours_v1(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập.' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_notification_membership_v1(p_organization_id);
  RETURN app_private.notification_quiet_hours_read_v1(v_uid, p_organization_id);
END $fn$;

-- NULL = giữ nguyên giá trị đang có (chưa có dòng ⇒ tắt, 21, 7). Trả biên nhận đọc lại từ bảng.
CREATE OR REPLACE FUNCTION public.set_my_notification_quiet_hours_v1(
  p_organization_id uuid, p_enabled boolean, p_quiet_start integer, p_quiet_end integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid     uuid := (SELECT auth.uid());
  v_cur     public.notification_quiet_hours%ROWTYPE;
  v_enabled boolean;
  v_start   integer;
  v_end     integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập.' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_notification_membership_v1(p_organization_id);

  SELECT * INTO v_cur
    FROM public.notification_quiet_hours q
   WHERE q.user_id = v_uid AND q.organization_id = p_organization_id
   FOR UPDATE;

  v_enabled := coalesce(p_enabled, v_cur.enabled, false);
  v_start   := coalesce(p_quiet_start, v_cur.quiet_start, 21);
  v_end     := coalesce(p_quiet_end, v_cur.quiet_end, 7);
  IF v_start < 0 OR v_start > 23 THEN
    RAISE EXCEPTION 'Giờ bắt đầu yên phải trong khoảng 0..23 (giờ công ty).' USING ERRCODE = '22023';
  END IF;
  IF v_end < 0 OR v_end > 23 THEN
    RAISE EXCEPTION 'Giờ kết thúc yên phải trong khoảng 0..23 (giờ công ty).' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.notification_quiet_hours (user_id, organization_id, enabled, quiet_start, quiet_end, updated_at)
  VALUES (v_uid, p_organization_id, v_enabled, v_start, v_end, now())
  ON CONFLICT (user_id, organization_id) DO UPDATE
    SET enabled     = excluded.enabled,
        quiet_start = excluded.quiet_start,
        quiet_end   = excluded.quiet_end,
        updated_at  = now();

  RETURN app_private.notification_quiet_hours_read_v1(v_uid, p_organization_id);
END $fn$;

REVOKE ALL ON FUNCTION public.get_my_notification_quiet_hours_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_my_notification_quiet_hours_v1(uuid, boolean, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_notification_quiet_hours_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_notification_quiet_hours_v1(uuid, boolean, integer, integer) TO authenticated;

-- =====================================================================================================================
-- 3. B8 — cấu hình thông báo công ty v2: công ty TƯỜNG MINH (v1 sửa ngầm công ty do current_admin_org_v1 chọn —
--    NOTIF-SETTINGS-14), set chống ghi đè bằng p_expected_updated_at (NOTIF-SETTINGS-8). Cổng giống v1:
--    app_private.require_perm_v1 → authorize_tenant_action_v3 (DENY > ALLOW, scope, valid_to, emergency-deny), nay
--    với p_organization_id thay cho current_admin_org_v1(). v1 giữ nguyên cho bản web cũ.
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION app_private.notification_org_config_read_v1(p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT jsonb_build_object(
           'organization_id',   o.id,
           'organization_name', o.name,
           'configured',        c.organization_id IS NOT NULL,
           'events',            app_private.notification_events_normalize_v1(c.events),
           'quiet_start',       coalesce(c.quiet_start, 21),
           'quiet_end',         coalesce(c.quiet_end, 7),
           'quiet_timezone',    app_private.org_timezone_v1(o.id),
           'updated_by',        c.updated_by,
           'updated_at',        c.updated_at)
    FROM public.organizations o
    LEFT JOIN app_private.notification_org_config c ON c.organization_id = o.id
   WHERE o.id = p_org;
$fn$;
REVOKE ALL ON FUNCTION app_private.notification_org_config_read_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_notification_org_config_v2(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập.' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu công ty.' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.require_perm_v1(p_organization_id, 'settings.view', 'xem cấu hình thông báo của công ty');
  RETURN app_private.notification_org_config_read_v1(p_organization_id);
END $fn$;

-- Chưa có dòng: p_expected_updated_at phải NULL (đọc thấy updated_at NULL). Có dòng: phải BẰNG updated_at đã đọc.
-- Lệch ⇒ PT409 (PostgREST trả 409). Hai người cùng tạo dòng đầu: INSERT … ON CONFLICT DO NOTHING, người sau PT409.
CREATE OR REPLACE FUNCTION public.set_notification_org_config_v2(
  p_organization_id uuid, p_events jsonb, p_quiet_start integer, p_quiet_end integer, p_expected_updated_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_cur    app_private.notification_org_config%ROWTYPE;
  v_found  boolean;
  v_merged jsonb;
  v_events jsonb;
  v_k      text;
  v_start  integer;
  v_end    integer;
  v_done   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập.' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu công ty.' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.require_perm_v1(p_organization_id, 'settings.edit', 'sửa cấu hình thông báo của công ty');

  SELECT * INTO v_cur
    FROM app_private.notification_org_config c
   WHERE c.organization_id = p_organization_id
   FOR UPDATE;
  v_found := FOUND;

  IF (v_found AND p_expected_updated_at IS DISTINCT FROM v_cur.updated_at)
     OR (NOT v_found AND p_expected_updated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cấu hình thông báo vừa được người khác thay đổi. Tải lại rồi sửa lại.' USING ERRCODE = 'PT409';
  END IF;

  -- Merge sâu tới cấp field trên JSON THÔ rồi mới chuẩn hoá một lần (bài học của v1, 20260729150000).
  IF p_events IS NULL THEN
    v_events := app_private.notification_events_normalize_v1(v_cur.events);
  ELSE
    PERFORM app_private.notification_events_normalize_v1(p_events);
    v_merged := coalesce(v_cur.events, '{}'::jsonb);
    FOR v_k IN SELECT jsonb_object_keys(p_events) LOOP
      v_merged := jsonb_set(v_merged, ARRAY[v_k], coalesce(v_merged -> v_k, '{}'::jsonb) || (p_events -> v_k), true);
    END LOOP;
    v_events := app_private.notification_events_normalize_v1(v_merged);
  END IF;

  v_start := coalesce(p_quiet_start, v_cur.quiet_start, 21);
  v_end   := coalesce(p_quiet_end, v_cur.quiet_end, 7);
  IF v_start < 0 OR v_start > 23 THEN
    RAISE EXCEPTION 'Giờ bắt đầu yên phải trong khoảng 0..23 (giờ công ty).' USING ERRCODE = '22023';
  END IF;
  IF v_end < 0 OR v_end > 23 THEN
    RAISE EXCEPTION 'Giờ kết thúc yên phải trong khoảng 0..23 (giờ công ty).' USING ERRCODE = '22023';
  END IF;

  IF v_found THEN
    UPDATE app_private.notification_org_config c
       SET events = v_events, quiet_start = v_start, quiet_end = v_end, updated_by = v_uid, updated_at = now()
     WHERE c.organization_id = p_organization_id;
  ELSE
    INSERT INTO app_private.notification_org_config (organization_id, events, quiet_start, quiet_end, updated_by, updated_at)
    VALUES (p_organization_id, v_events, v_start, v_end, v_uid, now())
    ON CONFLICT (organization_id) DO NOTHING
    RETURNING organization_id INTO v_done;
    IF v_done IS NULL THEN
      RAISE EXCEPTION 'Cấu hình thông báo vừa được người khác thay đổi. Tải lại rồi sửa lại.' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  RETURN app_private.notification_org_config_read_v1(p_organization_id);
END $fn$;

REVOKE ALL ON FUNCTION public.get_notification_org_config_v2(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_notification_org_config_v2(uuid, jsonb, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_notification_org_config_v2(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_notification_org_config_v2(uuid, jsonb, integer, integer, timestamptz) TO authenticated;

-- =====================================================================================================================
-- 4. B1 — trigger canh dòng thông báo. SECURITY INVOKER BẮT BUỘC: DEFINER thì current_user luôn là chủ hàm (postgres)
--    và trigger không phân biệt được client với mã máy chủ. Trigger không kiểm EXECUTE lúc chạy (đã có án lệ
--    khoa_organization_id_v1 ở 20261011042329) nên REVOKE ALL vẫn đúng. Tên a00_ ⇒ chạy TRƯỚC a90_autofill_org,
--    trg_autofill_org_strict: dòng nhắc legacy bị bỏ trước khi autofill_org_strict kịp ném 23502.
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION app_private.notifications_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_status public.notification_status;
BEGIN
  -- Mã máy chủ: hàm SECURITY DEFINER (current_user = postgres), edge/worker (service_role), lane migration.
  -- Client qua PostgREST là authenticated/anon và không tự đổi được current_user. KHÔNG dùng session_user.
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    -- Bất biến cho mọi vai: rời PENDING (đã đọc/đã huỷ) thì không còn push chờ gửi.
    IF TG_OP = 'UPDATE' AND NEW.push_state = 'QUEUED' AND NEW.status IS DISTINCT FROM 'PENDING' THEN
      NEW.push_state := 'SKIPPED';
      NEW.push_leased_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Bộ nhắc trình duyệt của bản web cũ: nhắc nay do server sinh (metadata.event BILLING/CONTRACT_EXPIRY/DEPOSIT).
    IF NEW.type::text IN ('PAYMENT_REMINDER', 'OVERDUE_INVOICE', 'CONTRACT_EXPIRING', 'DEPOSIT_SHORTFALL')
       AND (NEW.metadata ->> 'event') IS NULL THEN
      RETURN NULL;
    END IF;
    NEW.push_state     := NULL;
    NEW.push_leased_at := NULL;
    NEW.push_idem_key  := NULL;
    NEW.push_attempts  := 0;
    NEW.sent_at        := NULL;
    NEW.created_at     := now();
    RETURN NEW;
  END IF;

  -- UPDATE từ client: chỉ được PENDING → READ. Mọi cột khác (kể cả nội dung, công ty, created_at, push_*) giữ OLD;
  -- READ → PENDING, CANCELLED → READ… đều bị bỏ êm (dòng giữ nguyên trạng thái cũ).
  v_status := NEW.status;
  NEW := OLD;
  IF OLD.status = 'PENDING' AND v_status = 'READ' THEN
    NEW.status := 'READ';
    IF NEW.push_state = 'QUEUED' THEN
      NEW.push_state := 'SKIPPED';
      NEW.push_leased_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

REVOKE ALL ON FUNCTION app_private.notifications_guard_v1() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a00_notifications_guard ON public.notifications;
CREATE TRIGGER a00_notifications_guard
  BEFORE INSERT OR UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION app_private.notifications_guard_v1();

-- =====================================================================================================================
-- 5. B2 — DELETE/UPDATE qua được filter user_id của realtime (E1 xoá dòng gộp khi hết phiếu).
-- =====================================================================================================================
ALTER TABLE public.notifications REPLICA IDENTITY FULL;

-- =====================================================================================================================
-- 6. B4 — E1 (phiếu chờ duyệt, dòng gộp). Thân = bản production; chỉ thêm reset push_attempts/push_leased_at khi bump.
--    Không reset thì sau 3 lượt gửi trong đời dòng gộp, số phiếu tăng thêm cũng không bao giờ push (NOTIF-SERVER-M1).
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION app_private.notify_ie_pending_refresh_v1(p_org uuid, p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
declare
  v_n      bigint  := 0;
  v_sum    numeric := 0;
  v_ids    uuid[]  := '{}'::uuid[];
  v_old    bigint;
  v_up     boolean;
  v_in_app boolean := true;
  v_push   boolean := true;
begin
  if p_org is null or p_user is null then
    return;
  end if;

  select g.g_in_app, g.g_push into v_in_app, v_push
    from app_private.notify_gate_v1(p_user, p_org, 'E1', null) g;

  if coalesce(v_in_app, true) then
    with pend as (
      select ie.id, ie.total_amount, ie.building_id, ie.created_at
        from public.income_expenses ie
       where ie.organization_id = p_org
         and ie.deleted_at is null
         and ie.approval_status = 'UNAPPROVED'
         -- chép ĐÚNG predicate của approve_income_expense_v2 (§0.4A).
         and coalesce(ie.review_state,'') in ('PENDING','CHANGES_REQUESTED')
         -- §B.2 điểm 5: LOẠI TRỪ phiếu đang thuộc approval engine.
         and not exists (select 1 from public.approval_requests ar
                          where ar.subject_type = 'FINANCIAL_VOUCHER'
                            and ar.subject_id = ie.id
                            and ar.state = 'PENDING_APPROVAL')),
    bld as (select distinct p.building_id from pend p),
    -- gọi atav3 MỘT LẦN trên mỗi TOÀ có phiếu chờ, không phải mỗi phiếu
    ok as (select b.building_id from bld b
            where (select a.allowed from app_private.authorize_tenant_action_v3(
                     p_user, p_org, 'income_expenses.approve', b.building_id, null) a))
    select count(*), coalesce(sum(p.total_amount),0),
           coalesce(array_agg(p.id order by p.created_at), '{}'::uuid[])
      into v_n, v_sum, v_ids
      from pend p
     where p.building_id in (select building_id from ok);
  end if;

  -- ĐỌC SỐ ĐẾM CŨ trước khi ghi — v_up quyết định có bump created_at/push_state hay không.
  select coalesce((n.metadata->>'count')::bigint, 0) into v_old
    from public.notifications n
   where n.user_id = p_user and n.organization_id = p_org
     and (n.metadata->>'kind') = 'ie_pending' and n.status is distinct from 'READ'
   limit 1;
  v_old := coalesce(v_old, 0);

  -- v_n = 0 ⇒ XOÁ dòng đang mở (REPLICA IDENTITY FULL ⇒ máy khác nhận được DELETE).
  if coalesce(v_n,0) = 0 then
    delete from public.notifications n
     where n.user_id = p_user and n.organization_id = p_org
       and (n.metadata->>'kind') = 'ie_pending' and n.status is distinct from 'READ';
    return;
  end if;

  v_up := v_n > v_old;

  insert into public.notifications
    (user_id, organization_id, type, channel, status, subject, content, metadata, push_state)
  values (p_user, p_org, 'ACTION_REQUIRED', 'IN_APP', 'PENDING',
          'Phiếu chờ bạn duyệt',
          v_n || ' phiếu đang chờ bạn duyệt · tổng '
            || replace(to_char(v_sum,'FM999,999,999,999'), ',', '.') || ' đ',
          jsonb_build_object(
            'kind','ie_pending', 'event','E1', 'count',v_n, 'amount',v_sum,
            'voucher_ids', to_jsonb(v_ids),
            -- BẮT BUỘC có &layer=PENDING (xem 20260729161000).
            'url','/income-expense?approval_status=UNAPPROVED&layer=PENDING',
            'actor_id', auth.uid()),
          case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
  on conflict (user_id, organization_id)
    where (metadata->>'kind') = 'ie_pending' and status is distinct from 'READ'
  do update set
    content        = excluded.content,
    metadata       = excluded.metadata,
    -- CHỈ bump khi số TĂNG: bump mọi lần thì E3 liên tục reset đồng hồ và push không bao giờ tới.
    created_at     = case when v_up then now() else public.notifications.created_at end,
    push_state     = case when v_up then excluded.push_state else public.notifications.push_state end,
    -- Bump = một push MỚI: lượt thử đếm lại từ 0, lease cũ (nếu có) bỏ.
    push_attempts  = case when v_up then 0 else public.notifications.push_attempts end,
    push_leased_at = case when v_up then null else public.notifications.push_leased_at end;
end $fn$;

REVOKE ALL ON FUNCTION app_private.notify_ie_pending_refresh_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- =====================================================================================================================
-- 7. B3 — drain chung v2.
-- =====================================================================================================================
-- Họ dùng để gọi lại cổng lúc claim: E* giữ nguyên (notify_gate_v1 tự gộp E2*/E6*), Hermes task đi cổng E4 như lúc
-- sinh (hermes_task_follow_notify_v1). Dòng không thuộc họ nào (CUSTOM, canh gác…) ⇒ NULL ⇒ không gọi cổng.
CREATE OR REPLACE FUNCTION app_private.notify_push_family_v1(p_metadata jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE
           WHEN p_metadata ->> 'event' IN ('E1','E2','E2b','E2c','E3','E4','E5','E6a','E6b','E6c') THEN p_metadata ->> 'event'
           WHEN p_metadata ->> 'event' = 'HERMES_TASK' THEN 'E4'
           ELSE NULL
         END;
$fn$;
REVOKE ALL ON FUNCTION app_private.notify_push_family_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Thứ tự trong một lượt (khoá advisory chung với v1 ⇒ v1/v2 không bao giờ chạy chồng):
--   a) SENDING quá 15': tra push_send_log của KHOÁ LƯỢT ĐÓ trước — SENT/PARTIAL (sent>0) ⇒ SENT; còn lại ⇒ QUEUED
--      (lượt sau mang khoá mới) hoặc FAILED khi đã 3 lượt.
--   b) QUEUED mà status ≠ PENDING (đã đọc/huỷ ở bất kỳ đâu) ⇒ SKIPPED.
--   c) QUEUED đã 3 lượt ⇒ FAILED (trước đây nằm QUEUED vĩnh viễn).
--   d) Gọi lại cổng enabled/push (amount NULL — E1 mang TỔNG gộp, không lọc ngưỡng lần hai) ⇒ tắt thì SKIPPED.
--   e) Người không có thiết bị active ⇒ NO_DEVICE (không tính lượt).
--   f) Claim: chưa đọc, ngoài giờ yên công ty + cá nhân (HOÃN, không bỏ), debounce 10' của E1, FOR UPDATE SKIP
--      LOCKED; gộp theo (người, công ty); khoá = md5(người:công ty:mốc sớm nhất:số dòng:vân tay id:lượt) — mỗi lượt
--      một khoá ⇒ gửi lại sau lỗi không bị send-push coi là DUPLICATE.
CREATE OR REPLACE FUNCTION app_private.notify_claim_push_batch_v2(p_limit integer DEFAULT 100)
 RETURNS TABLE(notification_ids uuid[], user_id uuid, organization_id uuid, idem_key text, title text, body text,
               url text, tag text, data jsonb)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
#variable_conflict use_column
DECLARE
  v_limit integer     := greatest(1, least(coalesce(p_limit, 100), 500));
  v_now   timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('notify_push_drain_v1')::bigint) THEN
    RAISE NOTICE 'notify_claim_push_batch_v2: lượt trước còn đang chạy, bỏ lượt này';
    RETURN;
  END IF;

  -- a) SENDING treo.
  WITH stale AS (
    SELECT n.id, l.outcome, l.sent
      FROM public.notifications n
      LEFT JOIN public.push_send_log l ON l.idempotency_key = split_part(n.push_idem_key, ':', 1)
     WHERE n.push_state = 'SENDING'
       AND coalesce(n.push_leased_at, timestamptz 'epoch') < v_now - interval '15 minutes'
     FOR UPDATE OF n SKIP LOCKED
  )
  UPDATE public.notifications n
     SET push_state = CASE WHEN s.outcome IN ('SENT','PARTIAL') AND coalesce(s.sent, 0) > 0 THEN 'SENT'
                           WHEN n.push_attempts >= 3 THEN 'FAILED'
                           ELSE 'QUEUED' END,
         sent_at = CASE WHEN s.outcome IN ('SENT','PARTIAL') AND coalesce(s.sent, 0) > 0 THEN coalesce(n.sent_at, v_now)
                        ELSE n.sent_at END,
         error_message = CASE WHEN s.outcome IN ('SENT','PARTIAL') AND coalesce(s.sent, 0) > 0 THEN NULL
                              WHEN n.push_attempts >= 3 THEN 'push: không nhận được phản hồi sau 3 lần'
                              ELSE n.error_message END,
         push_leased_at = NULL
    FROM stale s
   WHERE n.id = s.id;

  -- b) Đã đọc / đã huỷ trước khi tới lượt gửi.
  UPDATE public.notifications n
     SET push_state = 'SKIPPED', push_leased_at = NULL,
         error_message = left('push: bỏ vì thông báo đã ' || coalesce(n.status::text, 'NULL') || ' trước khi gửi', 300)
   WHERE n.push_state = 'QUEUED'
     AND n.status IS DISTINCT FROM 'PENDING';

  -- c) Hết lượt.
  UPDATE public.notifications n
     SET push_state = 'FAILED', push_leased_at = NULL,
         error_message = coalesce(n.error_message, 'push: đã thử 3 lần')
   WHERE n.push_state = 'QUEUED'
     AND n.push_attempts >= 3;

  -- d) Cài đặt đổi sau khi dòng đã vào hàng (công ty tắt họ, người dùng tắt đẩy về máy / cadence DIGEST|OFF).
  UPDATE public.notifications n
     SET push_state = 'SKIPPED', push_leased_at = NULL,
         error_message = 'push: cài đặt thông báo đã tắt đẩy về máy'
   WHERE n.push_state = 'QUEUED'
     AND n.organization_id IS NOT NULL
     AND app_private.notify_push_family_v1(n.metadata) IS NOT NULL
     AND NOT coalesce((SELECT g.g_push
                         FROM app_private.notify_gate_v1(n.user_id, n.organization_id,
                                                         app_private.notify_push_family_v1(n.metadata), NULL) g), true);

  -- e) Không có thiết bị nào đang hoạt động. NO_DEVICE ≠ FAILED: không phải lỗi, không tính lượt.
  UPDATE public.notifications n
     SET push_state = 'NO_DEVICE', push_leased_at = v_now
   WHERE n.push_state = 'QUEUED'
     AND NOT EXISTS (SELECT 1 FROM public.push_subscriptions ps WHERE ps.user_id = n.user_id AND ps.is_active);

  -- f) Claim + lease.
  RETURN QUERY
  WITH cand AS (
    SELECT n.id, n.user_id AS c_user, n.organization_id AS c_org, n.subject, n.content,
           n.metadata ->> 'url' AS c_url, n.created_at, n.push_attempts
      FROM public.notifications n
     WHERE n.push_state = 'QUEUED'
       AND n.push_attempts < 3
       AND n.status = 'PENDING'
       -- debounce 10' cho E1 gộp: phiếu được duyệt trong vòng 10' KHÔNG bao giờ push.
       AND (coalesce(n.metadata ->> 'kind', '') <> 'ie_pending' OR n.created_at < v_now - interval '10 minutes')
       AND EXISTS (SELECT 1 FROM public.push_subscriptions ps WHERE ps.user_id = n.user_id AND ps.is_active)
       -- giờ yên công ty (theo org_timezone_v1) HOẶC cá nhân ⇒ hoãn tới lượt sau.
       AND NOT app_private.notify_in_quiet_hours_v1(n.user_id, n.organization_id, v_now)
     ORDER BY n.created_at, n.id
     FOR UPDATE OF n SKIP LOCKED
     LIMIT v_limit
  ),
  grp AS (
    SELECT c.c_user AS g_user,
           c.c_org  AS g_org,
           array_agg(c.id ORDER BY c.created_at, c.id)                                   AS ids,
           count(*)::integer                                                             AS cnt,
           min(c.created_at)                                                             AS first_at,
           max(c.push_attempts)::integer                                                 AS max_attempts,
           (array_agg(c.subject ORDER BY c.created_at DESC, c.id DESC))[1]               AS last_subject,
           (array_agg(c.content ORDER BY c.created_at DESC, c.id DESC))[1]               AS last_content,
           (array_agg(c.c_url   ORDER BY c.created_at DESC, c.id DESC))[1]               AS last_url,
           -- data.notificationIds: tối đa 20 id MỚI NHẤT (thứ người dùng thấy đầu tiên khi bấm).
           (array_agg(c.id      ORDER BY c.created_at DESC, c.id DESC))[1:20]            AS recent_ids
      FROM cand c
     GROUP BY c.c_user, c.c_org
  ),
  keyed AS (
    -- epoch-ms (không phụ thuộc TimeZone của session) + md5(id) (lô bị p_limit cắt đôi không trùng khoá) như v1,
    -- thêm công ty (gộp theo người×công ty) và SỐ LƯỢT (gửi lại sau lỗi = khoá mới).
    SELECT g.*,
           md5(g.g_user::text || ':' || coalesce(g.g_org::text, '-') || ':' ||
               (extract(epoch FROM g.first_at) * 1000)::bigint::text || ':' ||
               g.cnt::text || ':' ||
               md5(array_to_string(g.ids, ',')) || ':' ||
               (g.max_attempts + 1)::text) AS k_idem
      FROM grp g
  ),
  upd AS (
    UPDATE public.notifications n
       SET push_state     = 'SENDING',
           push_leased_at = v_now,
           push_attempts  = n.push_attempts + 1,
           push_idem_key  = k.k_idem || ':' || n.id::text
      FROM keyed k
     WHERE n.id = ANY (k.ids)
    RETURNING n.id
  )
  SELECT k.ids,
         k.g_user,
         k.g_org,
         k.k_idem,
         CASE WHEN k.cnt = 1 THEN coalesce(nullif(btrim(k.last_subject), ''), 'CRM')
              ELSE k.cnt::text || ' thông báo mới' END,
         left(coalesce(k.last_content, ''), 180),
         -- Chỉ đường nội bộ tuyệt đối ('/x', không '//host', không '\'); còn lại /my-day (không bọc quyền).
         CASE WHEN btrim(k.last_url) LIKE '/%' AND btrim(k.last_url) NOT LIKE '//%'
                   AND strpos(btrim(k.last_url), E'\\') = 0
              THEN btrim(k.last_url) ELSE '/my-day' END,
         -- Web Push THAY THẾ thông báo cùng tag: 1 dòng ⇒ tag theo dòng; lô ⇒ tag theo người×công ty.
         CASE WHEN k.cnt = 1 THEN 'crm-' || k.ids[1]::text
              ELSE 'crm-' || k.g_user::text || '-' || coalesce(k.g_org::text, '0') END,
         jsonb_build_object('notificationIds', to_jsonb(k.recent_ids), 'organizationId', k.g_org)
    FROM keyed k
   ORDER BY k.first_at;
END $fn$;

-- Kết quả edge: [{idem_key, outcome, retryable, error, sent}]. DUPLICATE chỉ thành SENT khi sổ push_send_log của
-- khoá đó là SENT/PARTIAL (sent>0); sổ đang SENDING (lượt khác còn bay) ⇒ không đụng; còn lại ⇒ thử lại/FAILED.
CREATE OR REPLACE FUNCTION app_private.notify_settle_push_batch_v2(p_results jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
#variable_conflict use_column
DECLARE
  v_rows integer := 0;
BEGIN
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) = 0 THEN
    RETURN 0;
  END IF;

  WITH r AS (
    SELECT nullif(btrim(x ->> 'idem_key'), '')                                           AS idem_key,
           upper(coalesce(nullif(btrim(x ->> 'outcome'), ''), 'PROVIDER_ERROR'))          AS outcome,
           -- KHÔNG ::boolean: payload rác ném 22P02 giết cả lượt settle ⇒ lô treo rồi gửi TRÙNG.
           (lower(coalesce(x ->> 'retryable', 'true')) NOT IN ('false','f','0','no'))     AS retryable,
           nullif(btrim(coalesce(x ->> 'error', '')), '')                                 AS error,
           ord
      FROM jsonb_array_elements(p_results) WITH ORDINALITY AS e(x, ord)
     WHERE jsonb_typeof(x) = 'object'
  ),
  d AS (
    -- Một khoá hai lần trong cùng payload: lấy phần tử cuối (UPDATE … FROM nhiều dòng khớp là không xác định).
    SELECT DISTINCT ON (r.idem_key) r.* FROM r WHERE r.idem_key IS NOT NULL ORDER BY r.idem_key, r.ord DESC
  ),
  v AS (
    SELECT d.*, l.outcome AS log_outcome,
           CASE
             WHEN d.outcome IN ('SENT','PARTIAL') THEN 'SENT'
             WHEN d.outcome = 'DUPLICATE' AND l.outcome IN ('SENT','PARTIAL') AND coalesce(l.sent, 0) > 0 THEN 'SENT'
             WHEN d.outcome = 'DUPLICATE' AND l.outcome = 'SENDING' THEN 'KEEP'
             WHEN d.outcome = 'NO_DEVICE' THEN 'NO_DEVICE'
             WHEN d.outcome = 'DUPLICATE' THEN 'RETRY'
             WHEN NOT d.retryable THEN 'FAILED'
             ELSE 'RETRY'
           END AS verdict
      FROM d
      LEFT JOIN public.push_send_log l ON l.idempotency_key = d.idem_key
  ),
  upd AS (
    UPDATE public.notifications n
       SET push_state = CASE v.verdict
                          WHEN 'SENT'      THEN 'SENT'
                          WHEN 'NO_DEVICE' THEN 'NO_DEVICE'
                          WHEN 'FAILED'    THEN 'FAILED'
                          ELSE CASE WHEN n.push_attempts >= 3 THEN 'FAILED' ELSE 'QUEUED' END
                        END,
           -- sent_at giữ ĐÚNG một nghĩa: "đã đẩy push thành công lúc nào".
           sent_at = CASE WHEN v.verdict = 'SENT' THEN now() ELSE n.sent_at END,
           error_message = CASE WHEN v.verdict = 'SENT' THEN NULL
                                ELSE left(concat_ws(' ', 'push', v.outcome,
                                                    CASE WHEN v.outcome = 'DUPLICATE'
                                                         THEN 'sổ=' || coalesce(v.log_outcome, 'không có') END,
                                                    v.error), 300) END,
           push_leased_at = NULL
           -- KHÔNG đụng status: đã đẩy push ≠ đã đọc.
      FROM v
     WHERE v.verdict <> 'KEEP'
       AND n.push_state = 'SENDING'
       AND n.push_idem_key IS NOT NULL
       AND split_part(n.push_idem_key, ':', 1) = v.idem_key
    RETURNING 1 AS one
  )
  SELECT count(*)::integer INTO v_rows FROM upd;

  RETURN v_rows;
END $fn$;

REVOKE ALL ON FUNCTION app_private.notify_claim_push_batch_v2(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.notify_settle_push_batch_v2(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.notify_claim_push_batch_v2(p_limit integer DEFAULT 100)
 RETURNS TABLE(notification_ids uuid[], user_id uuid, organization_id uuid, idem_key text, title text, body text,
               url text, tag text, data jsonb)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY SELECT * FROM app_private.notify_claim_push_batch_v2(p_limit);
END $fn$;

CREATE OR REPLACE FUNCTION public.notify_settle_push_batch_v2(p_results jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RETURN app_private.notify_settle_push_batch_v2(p_results);
END $fn$;

REVOKE ALL ON FUNCTION public.notify_claim_push_batch_v2(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notify_settle_push_batch_v2(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.notify_claim_push_batch_v2(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_settle_push_batch_v2(jsonb) TO service_role;

-- v1 giữ chữ ký (RPC đã phát hành, salary-v5-jobs còn gọi), thân uỷ quyền v2: không còn hai luật drain song song.
CREATE OR REPLACE FUNCTION app_private.notify_claim_push_batch_v1(p_limit integer DEFAULT 100)
 RETURNS TABLE(notification_ids uuid[], user_id uuid, idem_key text, title text, body text, url text, tag text)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT c.notification_ids, c.user_id, c.idem_key, c.title, c.body, c.url, c.tag
    FROM app_private.notify_claim_push_batch_v2(p_limit) c;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.notify_settle_push_batch_v1(p_results jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RETURN app_private.notify_settle_push_batch_v2(p_results);
END $fn$;

REVOKE ALL ON FUNCTION app_private.notify_claim_push_batch_v1(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.notify_settle_push_batch_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- =====================================================================================================================
-- 8. B6 — dọn thông báo lỗi thời + bảo trì định kỳ (edge lifecycle-reminders gọi mỗi 15', pha 1).
-- =====================================================================================================================
CREATE TABLE IF NOT EXISTS app_private.notification_drain_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finished_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  batches       integer NOT NULL DEFAULT 0 CHECK (batches >= 0),
  settled       integer NOT NULL DEFAULT 0 CHECK (settled >= 0),
  outcomes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL CHECK (status IN ('OK', 'FAILED')),
  error_message text
);
CREATE INDEX IF NOT EXISTS notification_drain_runs_recent_idx ON app_private.notification_drain_runs (finished_at DESC);
ALTER TABLE app_private.notification_drain_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.notification_drain_runs FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS app_private.notification_maintenance_state (
  task        text PRIMARY KEY,
  last_run_at timestamptz NOT NULL
);
ALTER TABLE app_private.notification_maintenance_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.notification_maintenance_state FROM PUBLIC, anon, authenticated, service_role;

-- Chỉ PENDING → CANCELLED, không xoá; ghi lý do + mốc để khôi phục được. p_marker (tên migration) chỉ dùng cho lần
-- dọn đầu, để câu khôi phục ở đầu file chọn đúng tập dòng.
--   * E5 (bàn giao chờ bạn xác nhận) / E6a (nhắc chốt sổ sau bàn giao) trỏ bàn giao CONFIRMED/CANCELLED.
--   * Nhắc legacy của bộ nhắc trình duyệt (4 loại, metadata.event NULL): đã có dòng gộp server thay thế
--     (họ BILLING/CONTRACT_EXPIRY/DEPOSIT); trigger a00 chặn bản web cũ đẻ thêm nên sau lần đầu tập này gần như rỗng.
CREATE OR REPLACE FUNCTION app_private.notification_reconcile_stale_v1(p_marker text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_now      timestamptz := clock_timestamp();
  v_extra    jsonb := CASE WHEN p_marker IS NULL THEN '{}'::jsonb
                           ELSE jsonb_build_object('cancelled_by_migration', p_marker) END;
  v_handover integer := 0;
  v_legacy   integer := 0;
BEGIN
  WITH t AS (
    SELECT n.id
      FROM public.notifications n
      JOIN public.cash_handovers h ON h.id::text = n.metadata ->> 'handover_id'
     WHERE n.status = 'PENDING'
       AND n.metadata ->> 'event' IN ('E5', 'E6a')
       AND h.status::text IN ('CONFIRMED', 'CANCELLED')
     FOR UPDATE OF n SKIP LOCKED
  )
  UPDATE public.notifications n
     SET status = 'CANCELLED',
         metadata = n.metadata || jsonb_build_object('cancelled_reason', 'HANDOVER_RESOLVED', 'cancelled_at', v_now,
                                                     'cancelled_by', 'notification_reconcile_stale_v1') || v_extra
    FROM t
   WHERE n.id = t.id;
  GET DIAGNOSTICS v_handover = ROW_COUNT;

  WITH t AS (
    SELECT n.id
      FROM public.notifications n
     WHERE n.status = 'PENDING'
       AND n.type IN ('PAYMENT_REMINDER', 'OVERDUE_INVOICE', 'CONTRACT_EXPIRING', 'DEPOSIT_SHORTFALL')
       AND (n.metadata ->> 'event') IS NULL
     FOR UPDATE OF n SKIP LOCKED
  )
  UPDATE public.notifications n
     SET status = 'CANCELLED',
         metadata = n.metadata || jsonb_build_object('cancelled_reason', 'LEGACY_CLIENT_REMINDER_REPLACED',
                                                     'cancelled_at', v_now,
                                                     'cancelled_by', 'notification_reconcile_stale_v1') || v_extra
    FROM t
   WHERE n.id = t.id;
  GET DIAGNOSTICS v_legacy = ROW_COUNT;

  RETURN jsonb_build_object('legacy_cancelled', v_legacy, 'handover_cancelled', v_handover);
END $fn$;
REVOKE ALL ON FUNCTION app_private.notification_reconcile_stale_v1(text) FROM PUBLIC, anon, authenticated, service_role;

-- Pha bảo trì của edge (service_role): dọn lỗi thời mỗi lượt; dọn push_send_log > 30 ngày (dài hơn mọi lease và
-- đủ đối soát) + sổ drain > 30 ngày tối đa một lần mỗi ngày, mốc nhớ trong notification_maintenance_state.
CREATE OR REPLACE FUNCTION public.notification_maintenance_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_res     jsonb;
  v_legacy  integer;
  v_handover integer;
  v_deleted integer := 0;
  v_last    timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('notification_maintenance_v1')::bigint) THEN
    RETURN jsonb_build_object('reconciled', 0, 'legacy_cancelled', 0, 'handover_cancelled', 0, 'push_log_deleted', 0,
                              'busy', true);
  END IF;

  v_res := app_private.notification_reconcile_stale_v1(NULL);
  v_legacy := coalesce((v_res ->> 'legacy_cancelled')::integer, 0);
  v_handover := coalesce((v_res ->> 'handover_cancelled')::integer, 0);

  SELECT s.last_run_at INTO v_last
    FROM app_private.notification_maintenance_state s
   WHERE s.task = 'push_log_cleanup'
   FOR UPDATE;
  IF v_last IS NULL OR v_last < clock_timestamp() - interval '1 day' THEN
    DELETE FROM public.push_send_log l WHERE l.created_at < clock_timestamp() - interval '30 days';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    DELETE FROM app_private.notification_drain_runs r WHERE r.finished_at < clock_timestamp() - interval '30 days';
    INSERT INTO app_private.notification_maintenance_state (task, last_run_at)
    VALUES ('push_log_cleanup', clock_timestamp())
    ON CONFLICT (task) DO UPDATE SET last_run_at = excluded.last_run_at;
  END IF;

  RETURN jsonb_build_object('reconciled', v_legacy + v_handover, 'legacy_cancelled', v_legacy,
                            'handover_cancelled', v_handover, 'push_log_deleted', v_deleted);
END $fn$;

-- Sổ mỗi lượt drain của edge — get_notification_delivery_health_v1 đọc last_drain_at từ đây.
CREATE OR REPLACE FUNCTION public.notify_drain_record_run_v1(p_batches integer, p_settled integer, p_outcomes jsonb,
                                                             p_error text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 2000);
BEGIN
  IF p_batches IS NULL OR p_batches < 0 OR p_settled IS NULL OR p_settled < 0 THEN
    RAISE EXCEPTION 'Số lô và số dòng đã chốt phải là số nguyên không âm.' USING ERRCODE = '22023';
  END IF;
  IF p_outcomes IS NOT NULL AND jsonb_typeof(p_outcomes) <> 'object' THEN
    RAISE EXCEPTION 'p_outcomes phải là object JSON {outcome: số lượng}.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app_private.notification_drain_runs (batches, settled, outcomes, status, error_message)
  VALUES (p_batches, p_settled, coalesce(p_outcomes, '{}'::jsonb), CASE WHEN v_error IS NULL THEN 'OK' ELSE 'FAILED' END,
          v_error);
END $fn$;

REVOKE ALL ON FUNCTION public.notification_maintenance_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notify_drain_record_run_v1(integer, integer, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.notification_maintenance_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_drain_record_run_v1(integer, integer, jsonb, text) TO service_role;

-- =====================================================================================================================
-- 9. B9 — sức khoẻ giao thông báo (settings.view của đúng công ty) + nhật ký push của chính mình.
-- =====================================================================================================================
-- push_log_7d chỉ đếm khoá GẮN ĐƯỢC với công ty (lô drain của dòng thuộc công ty + lượt lifecycle của công ty):
-- push_send_log không có cột công ty, đếm theo người sẽ lẫn push của công ty khác khi người đó thuộc hai công ty.
CREATE OR REPLACE FUNCTION public.get_notification_delivery_health_v1(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_now     timestamptz := clock_timestamp();
  v_since   timestamptz := clock_timestamp() - interval '7 days';
  v_members uuid[];
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập.' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu công ty.' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.require_perm_v1(p_organization_id, 'settings.view', 'xem sức khoẻ giao thông báo của công ty');

  SELECT coalesce(array_agg(DISTINCT m.user_id), '{}'::uuid[]) INTO v_members
    FROM public.organization_memberships m
   WHERE m.organization_id = p_organization_id
     AND m.status = 'ACTIVE'
     AND coalesce(m.valid_from, '-infinity'::timestamptz) <= v_now
     AND (m.valid_to IS NULL OR m.valid_to > v_now);

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'generated_at', v_now,
    'members_total', cardinality(v_members),
    'members_with_device', (SELECT count(DISTINCT ps.user_id)::integer FROM public.push_subscriptions ps
                             WHERE ps.is_active AND ps.user_id = ANY (v_members)),
    'active_devices', (SELECT count(*)::integer FROM public.push_subscriptions ps
                        WHERE ps.is_active AND ps.user_id = ANY (v_members)),
    'queue', (SELECT jsonb_build_object(
                       'queued',  count(*) FILTER (WHERE n.push_state = 'QUEUED'),
                       'sending', count(*) FILTER (WHERE n.push_state = 'SENDING'),
                       'oldest_queued_at', min(n.created_at) FILTER (WHERE n.push_state = 'QUEUED'))
                FROM public.notifications n
               WHERE n.organization_id = p_organization_id AND n.push_state IN ('QUEUED', 'SENDING')),
    'last_7d', (SELECT jsonb_build_object(
                         'sent',      count(*) FILTER (WHERE n.push_state = 'SENT'),
                         'no_device', count(*) FILTER (WHERE n.push_state = 'NO_DEVICE'),
                         'failed',    count(*) FILTER (WHERE n.push_state = 'FAILED'),
                         'skipped',   count(*) FILTER (WHERE n.push_state = 'SKIPPED'))
                  FROM public.notifications n
                 WHERE n.organization_id = p_organization_id AND n.created_at >= v_since AND n.push_state IS NOT NULL),
    'lifecycle', jsonb_build_object(
       'push_states', (SELECT coalesce(jsonb_object_agg(q.push_status, q.so), '{}'::jsonb)
                         FROM (SELECT d.push_status, count(*)::integer AS so
                                 FROM app_private.lifecycle_reminder_deliveries d
                                WHERE d.organization_id = p_organization_id AND d.created_at >= v_since
                                GROUP BY d.push_status) q),
       'last_success_at', (SELECT max(r.finished_at) FROM app_private.lifecycle_reminder_runs r
                            WHERE r.organization_id = p_organization_id AND r.status IN ('OK', 'NO_RECIPIENT'))),
    'push_log_7d', (SELECT coalesce(jsonb_object_agg(q.outcome, q.so), '{}'::jsonb)
                      FROM (SELECT coalesce(l.outcome, 'UNKNOWN') AS outcome, count(*)::integer AS so
                              FROM public.push_send_log l
                             WHERE l.created_at >= v_since
                               AND l.idempotency_key IN (
                                     SELECT split_part(n.push_idem_key, ':', 1)
                                       FROM public.notifications n
                                      WHERE n.organization_id = p_organization_id
                                        AND n.push_idem_key IS NOT NULL
                                        AND n.created_at >= v_since - interval '1 day'
                                     UNION
                                     SELECT d.idempotency_key
                                       FROM app_private.lifecycle_reminder_deliveries d
                                      WHERE d.organization_id = p_organization_id
                                        AND d.idempotency_key IS NOT NULL
                                        AND d.created_at >= v_since - interval '1 day')
                             GROUP BY 1) q),
    'no_recipient_7d', (SELECT coalesce(jsonb_agg(jsonb_build_object('event', q.event, 'reason', q.reason, 'n', q.so)
                                                  ORDER BY q.so DESC, q.event, q.reason), '[]'::jsonb)
                          FROM (SELECT r.event_key AS event, r.reason, count(*)::integer AS so
                                  FROM app_private.notification_no_recipient_log r
                                 WHERE r.organization_id = p_organization_id AND r.created_at >= v_since
                                 GROUP BY r.event_key, r.reason
                                UNION ALL
                                SELECT f.family, 'NO_RECIPIENT_IN_SCOPE', count(*)::integer
                                  FROM app_private.lifecycle_reminder_runs lr
                                 CROSS JOIN LATERAL jsonb_array_elements_text(lr.no_recipient_families) AS f(family)
                                 WHERE lr.organization_id = p_organization_id AND lr.finished_at >= v_since
                                 GROUP BY f.family) q),
    'last_drain_at', (SELECT max(r.finished_at) FROM app_private.notification_drain_runs r),
    'last_drain_ok_at', (SELECT max(r.finished_at) FROM app_private.notification_drain_runs r WHERE r.status = 'OK'),
    'last_drain_error', (SELECT r.error_message FROM app_private.notification_drain_runs r
                          ORDER BY r.finished_at DESC, r.id DESC LIMIT 1));
END $fn$;

CREATE OR REPLACE FUNCTION public.get_my_push_log_v1(p_limit integer DEFAULT 10)
 RETURNS TABLE(created_at timestamptz, outcome text, sent integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
#variable_conflict use_column
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập.' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'p_limit phải trong khoảng 1..50.' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT l.created_at, l.outcome, l.sent
    FROM public.push_send_log l
   WHERE l.user_id = v_uid
   ORDER BY l.created_at DESC, l.idempotency_key
   LIMIT p_limit;
END $fn$;

REVOKE ALL ON FUNCTION public.get_notification_delivery_health_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_my_push_log_v1(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_notification_delivery_health_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_push_log_v1(integer) TO authenticated;

-- =====================================================================================================================
-- 10. B10 — vệ sinh ACL (đo 21/10: anon có DELETE/INSERT/…/TRUNCATE trên ba bảng; authenticated có TRUNCATE).
--     RLS không áp cho TRUNCATE nên các câu dưới thực sự gỡ quyền. notification_logs/templates: 0 dòng, không mã
--     nào đọc (CRITIC-9). service_role giữ nguyên (send-push prune thiết bị chết).
-- =====================================================================================================================
REVOKE ALL ON TABLE public.push_subscriptions FROM anon;
REVOKE ALL ON TABLE public.notification_logs FROM anon;
REVOKE ALL ON TABLE public.notification_templates FROM anon;
REVOKE TRUNCATE ON TABLE public.push_subscriptions FROM authenticated;
REVOKE TRUNCATE ON TABLE public.notification_logs FROM authenticated;
REVOKE TRUNCATE ON TABLE public.notification_templates FROM authenticated;

-- =====================================================================================================================
-- 11. Dọn lần đầu (B6). Lượt hai không còn dòng PENDING nào khớp ⇒ 0, không nhân dữ liệu.
-- =====================================================================================================================
DO $don_lan_dau$
DECLARE
  v jsonb;
BEGIN
  v := app_private.notification_reconcile_stale_v1('20261021171249_notify_pipeline_v2');
  RAISE NOTICE 'notify_pipeline_v2: dọn lần đầu %', v;
END $don_lan_dau$;

-- =====================================================================================================================
-- 12. Nghiệm thu catalog (không đọc dữ liệu nghiệp vụ).
-- =====================================================================================================================
DO $nghiem_thu$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.get_my_notification_quiet_hours_v1(uuid)',
    'public.set_my_notification_quiet_hours_v1(uuid,boolean,integer,integer)',
    'public.get_notification_org_config_v2(uuid)',
    'public.set_notification_org_config_v2(uuid,jsonb,integer,integer,timestamp with time zone)',
    'public.get_notification_delivery_health_v1(uuid)',
    'public.get_my_push_log_v1(integer)'] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'nghiệm thu: thiếu %', v_sig USING ERRCODE = '55000';
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'nghiệm thu: ACL sai ở % (anon phải bị chặn, authenticated phải gọi được)', v_sig USING ERRCODE = '55000';
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.notify_claim_push_batch_v2(integer)',
    'public.notify_settle_push_batch_v2(jsonb)',
    'public.notification_maintenance_v1()',
    'public.notify_drain_record_run_v1(integer,integer,jsonb,text)'] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'nghiệm thu: thiếu %', v_sig USING ERRCODE = '55000';
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE') OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'nghiệm thu: ACL sai ở % (chỉ service_role)', v_sig USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.notifications'::regclass AND t.tgname = 'a00_notifications_guard'
                    AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'nghiệm thu: thiếu trigger a00_notifications_guard' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'app_private.notifications_guard_v1()'::regprocedure AND p.prosecdef) THEN
    RAISE EXCEPTION 'nghiệm thu: notifications_guard_v1 phải SECURITY INVOKER' USING ERRCODE = '55000';
  END IF;
  IF (SELECT c.relreplident FROM pg_class c WHERE c.oid = 'public.notifications'::regclass) <> 'f' THEN
    RAISE EXCEPTION 'nghiệm thu: notifications chưa REPLICA IDENTITY FULL' USING ERRCODE = '55000';
  END IF;
  IF has_table_privilege('anon', 'public.push_subscriptions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.push_subscriptions', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.notification_quiet_hours', 'SELECT')
     OR has_table_privilege('authenticated', 'public.notification_quiet_hours', 'INSERT') THEN
    RAISE EXCEPTION 'nghiệm thu: quyền bảng còn hở' USING ERRCODE = '55000';
  END IF;
END $nghiem_thu$;

NOTIFY pgrst, 'reload schema';

COMMIT;
