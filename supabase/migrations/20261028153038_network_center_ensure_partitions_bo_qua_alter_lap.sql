-- Network Center: hàm chuẩn bị bảng con theo ngày KHÔNG chạy lại ALTER/REVOKE trên bảng con đã đủ điều kiện
--
-- Vấn đề (đo trên production 28/10/2026, chỉ đọc):
--   · app_private.network_center_ensure_raw_partitions_v1, thân sống ở
--     20260729020000_network_center_current_telemetry.sql:477-526 (md5 prosrc cad87e76…), với mỗi ngày
--     trong khoảng và mỗi bảng cha (network_device_samples, network_interface_samples) chạy
--     CREATE TABLE IF NOT EXISTS, rồi ALTER TABLE … ENABLE ROW LEVEL SECURITY và REVOKE ALL VÔ ĐIỀU KIỆN.
--   · Người gọi: network_center_worker_ingest_v1/v2 → ingest_legacy_impl_v1 (hôm qua…ngày kia, khoảng
--     6 lần/giờ), cron hằng giờ network_center_watchdog_maintenance_v1 (khoảng một tháng tới), retention.
--     Tức vài chục lệnh ALTER TABLE mỗi giờ, trong khi cả 46/46 bảng con mỗi loại đã bật RLS và ACL chỉ
--     còn postgres. xmin của pg_class các bảng con đổi sau mỗi lượt, tức dòng catalog bị ghi lại thật.
--   · ALTER TABLE … ENABLE ROW LEVEL SECURITY luôn lấy AccessExclusiveLock và ghi lại dòng pg_class (kèm
--     huỷ relcache ở mọi phiên), kể cả khi RLS đã bật. Khi có việc đọc dài trên bảng con (pg_dump của
--     test-env:sync, backup), lệnh phải chờ khoá và mọi truy vấn khác vào bảng đó xếp hàng sau nó: lúc
--     13:44 ngày 28/10 nghẽn đúng như vậy trong đợt app báo "Mạng đang chậm".
--
-- Sửa (không đổi chữ ký, kiểu trả về, SECURITY DEFINER, search_path, TimeZone, ACL hay thông báo lỗi):
--   · Trước khi chạy ba lệnh, đọc catalog (không lấy khoá bảng). Bảng con đã có, đã bật RLS, và không còn
--     quyền bảng hay quyền cột nào cho PUBLIC/anon/authenticated/service_role thì bỏ qua. Ở trạng thái đó
--     ba lệnh cũ vốn không đổi gì (REVOKE ALL ON TABLE cũng thu quyền cột, nên phép kiểm xét cả attacl).
--   · Còn lại vẫn chạy y như cũ: tạo bảng con mới (default privileges của Supabase cấp quyền cho
--     anon/authenticated/service_role, nên bảng mới luôn đi qua REVOKE), và tự vá khi ai đó tắt RLS hoặc
--     cấp lại quyền.
--
-- Chạy lại được: CREATE OR REPLACE + REVOKE (khẳng định lại ACL, không đổi gì trên production); chốt đầu
-- nhận đúng thân 20260729020000 hoặc thân mới này (md5 prosrc). Nghiệm thu chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $chot$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('app_private.network_center_ensure_raw_partitions_v1(date,date)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'chot: thieu app_private.network_center_ensure_raw_partitions_v1(date,date)';
  END IF;
  IF md5(replace(v_src, chr(13), '')) NOT IN ('cad87e767538761a3b8623abae0d35be', 'c0b5062b884fcd4c29aca760c78938b8') THEN
    RAISE EXCEPTION 'chot: network_center_ensure_raw_partitions_v1 khong con la ban 20260729020000 hoac ban va nay - doc lai ban dang chay truoc khi de';
  END IF;
END
$chot$;

CREATE OR REPLACE FUNCTION app_private.network_center_ensure_raw_partitions_v1(
  p_from date,
  p_through date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
SET timezone TO 'UTC'
AS $fn$
DECLARE
  v_day date;
  v_next date;
  v_parent text;
  v_name text;
BEGIN
  IF p_from IS NULL OR p_through IS NULL OR p_through < p_from THEN
    RAISE EXCEPTION 'Invalid Network Center partition range' USING ERRCODE = '22023';
  END IF;
  IF p_through > p_from + 62 THEN
    RAISE EXCEPTION 'Network Center partition range exceeds 63 days' USING ERRCODE = '22023';
  END IF;

  v_day := p_from;
  WHILE v_day <= p_through LOOP
    v_next := v_day + 1;

    FOREACH v_parent IN ARRAY ARRAY['network_device_samples', 'network_interface_samples'] LOOP
      v_name := v_parent || '_' || to_char(v_day, 'YYYYMMDD');

      -- ALTER TABLE lấy AccessExclusiveLock và ghi lại pg_class kể cả khi RLS đã bật; chỉ chạy ba lệnh
      -- khi bảng con chưa có, RLS chưa bật, hoặc còn quyền bảng/cột cho PUBLIC/anon/authenticated/service_role.
      IF NOT EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = v_name
           AND c.relrowsecurity
           AND NOT EXISTS (
             SELECT 1
               FROM aclexplode(c.relacl) acl
              WHERE acl.grantee = 0
                 OR acl.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role'))
           )
           AND NOT EXISTS (
             SELECT 1
               FROM pg_attribute att
               CROSS JOIN LATERAL aclexplode(att.attacl) acl
              WHERE att.attrelid = c.oid
                AND att.attacl IS NOT NULL
                AND (acl.grantee = 0
                     OR acl.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')))
           )
      ) THEN
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
          v_name,
          v_parent,
          v_day,
          v_next
        );
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', v_name);
      END IF;
    END LOOP;

    v_day := v_next;
  END LOOP;
END;
$fn$;

-- CREATE OR REPLACE giữ ACL sẵn có ({postgres=X/postgres} trên production). Khẳng định lại y như
-- 20260729020000:960 để file tự đứng vững cả trên database dựng từ baseline (baseline không mang GRANT/REVOKE).
REVOKE ALL ON FUNCTION app_private.network_center_ensure_raw_partitions_v1(date, date) FROM PUBLIC, anon, authenticated, service_role;

DO $nghiem_thu$
DECLARE v_src text; v_secdef boolean; v_vol "char"; v_cfg text[]; v_oid oid;
BEGIN
  v_oid := to_regprocedure('app_private.network_center_ensure_raw_partitions_v1(date,date)');
  SELECT p.prosrc, p.prosecdef, p.provolatile, p.proconfig
    INTO v_src, v_secdef, v_vol, v_cfg
    FROM pg_proc p
   WHERE p.oid = v_oid;
  IF md5(replace(v_src, chr(13), '')) <> 'c0b5062b884fcd4c29aca760c78938b8' THEN
    RAISE EXCEPTION 'nghiem_thu: than network_center_ensure_raw_partitions_v1 khong phai ban va nay';
  END IF;
  IF v_secdef IS NOT TRUE OR v_vol <> 'v'
     OR NOT (coalesce(v_cfg, '{}') @> ARRAY['search_path=pg_catalog, app_private, public', 'TimeZone=UTC']) THEN
    RAISE EXCEPTION 'nghiem_thu: network_center_ensure_raw_partitions_v1 sai definer/volatility/config (%, %, %)',
      v_secdef, v_vol, v_cfg;
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: network_center_ensure_raw_partitions_v1 khong duoc mo EXECUTE cho anon/authenticated/service_role';
  END IF;
END
$nghiem_thu$;

COMMIT;
