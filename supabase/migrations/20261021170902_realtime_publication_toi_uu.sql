-- =====================================================================
-- Tối ưu publication supabase_realtime (plan 2026-10-21 realtime + thông báo,
-- mục A10; RT-DB-2, RT-OTHER-1, RT-HUB-4, RT-HUB-6).
--
-- 1. KHÔNG DROP public.network_worker_building_status ở file này (RT-CLIENT-1,
--    SQL-LIFE-5 — review chéo 22/10). Client mới đã bỏ nghe bảng này
--    (src/lib/network-center/runtime.ts), nhưng bản client production CŨ mở MỘT
--    kênh network-center-<uid> gồm 5 binding có bảng này; Realtime tạo
--    subscription của cả kênh trong một transaction (đo TEST 22/10: thiếu một
--    bảng ⇒ cả kênh 'Unable to subscribe', callback vẫn SUBSCRIBED) ⇒ DROP trước
--    khi mọi tab cũ tải lại bản mới làm Network Center cũ mất HẾT realtime. Giữ
--    bảng thêm một vòng phát hành chỉ tốn ~6.300 lượt giải mã WAL/ngày. DROP để
--    migration RIÊNG, áp SAU khi promote client mới và tab cũ đã tải lại
--    (follow-up trong plan §6 và tooling/known-gaps.yaml). Thứ tự phát hành:
--    ADD trước client, DROP sau client.
--
-- 2. ADD public.meter_readings, public.meters
--    Nhân viên ghi chỉ số trên điện thoại, quản lý ở máy khác vẫn thấy "chưa
--    ghi" tới F5. Realtime chỉ giao event cho dòng người nghe SELECT được, nên
--    trước khi thêm đã đo pg_policies (prod 21/10): meters_select_rbac và
--    meter_readings_select_rbac là PERMISSIVE SELECT theo phạm vi toà
--    (has_full_building_scope / accessible_building_ids; readings thêm admin) —
--    đúng người xem màn Chỉ số. Tải nhỏ: meter_readings 395 insert / 51,8 ngày,
--    0 update, 0 delete; meters 13 dòng. Preflight dưới đây ĐÒI có policy SELECT
--    cho phép — mất policy đó thì dừng, không thêm một bảng không ai nhận event.
--    Áp file này TRƯỚC khi promote client mới (hub mới nghe hai bảng này trong
--    cùng một kênh — thiếu một bảng thì cả 19 bảng của hub im). Client cũ không
--    nghe hai bảng này nên ADD sớm là an toàn.
--    KHÔNG REVOKE SELECT của anon trên hai bảng (SQL-LIFE-9): anon vẫn EXECUTE
--    được hai hàm INVOKER đọc chúng (get_meter_reading_stats,
--    get_meters_without_readings) và chưa chứng minh được kênh realtime nào không
--    join dưới vai anon trước khi có JWT — REVOKE có thể làm hỏng cả kênh như
--    mục 1. Giới hạn DELETE chỉ mang khoá chính (tới cả anon) ghi ở
--    docs/he-thong/realtime-sync.md §6 và tooling/known-gaps.yaml.
--
-- 3. KHÔNG ADD approval_requests / approval_request_steps (RT-HUB-4)
--    Đo prod 21/10: hai bảng chỉ có policy RESTRICTIVE (org_boundary,
--    hide_sandbox_admin), KHÔNG có policy SELECT cho phép nào ⇒ authenticated
--    không SELECT được dòng nào (đọc thật đi qua RPC SECURITY DEFINER
--    list_my_pending_approvals_v1) ⇒ realtime sẽ không giao event cho ai. Không
--    nới policy chỉ để realtime nhận được (RT-DB-4). Bù bằng poll 60s + focus ở
--    usePendingApprovals (src/hooks/useApprovals.ts).
--
-- Idempotent: kiểm pg_publication_tables trước khi ADD.
-- Không BEGIN/COMMIT trong file: lane migrate:forward và test-env:thu-sql tự
-- bọc MỘT transaction quanh thân file.
-- KHÔNG ĐỤNG TIỀN, KHÔNG DDL bảng, KHÔNG DML: chỉ ALTER PUBLICATION.
-- =====================================================================

DO $add$
DECLARE
  r record;
  v_added int := 0;
  v_ident "char";
BEGIN
  FOR r IN
    SELECT t.tablename
      FROM (VALUES ('meter_readings'), ('meters')) AS t(tablename)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = r.tablename AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION 'Không thấy bảng public.% — DỪNG.', r.tablename;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_publication_tables p
       WHERE p.pubname = 'supabase_realtime' AND p.schemaname = 'public'
         AND p.tablename = r.tablename
    ) THEN
      RAISE NOTICE '% đã có trong supabase_realtime — bỏ qua', r.tablename;
      CONTINUE;
    END IF;

    IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = r.tablename) THEN
      RAISE EXCEPTION
        'Bảng public.% chưa bật RLS — KHÔNG đưa vào publication realtime (realtime lọc theo RLS người nghe)',
        r.tablename;
    END IF;

    -- Đường SELECT cho người xem: phải có ít nhất một policy PERMISSIVE cho
    -- SELECT (hoặc ALL) áp cho authenticated/public mà KHÔNG chỉ dành cho super
    -- admin. Thiếu ⇒ không ai ngoài super admin nhận event ⇒ thêm vào chỉ tốn.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies pol
       WHERE pol.schemaname = 'public' AND pol.tablename = r.tablename
         AND pol.permissive = 'PERMISSIVE'
         AND pol.cmd IN ('SELECT', 'ALL')
         AND (pol.roles && ARRAY['authenticated', 'public']::name[])
         AND pol.qual IS NOT NULL
         AND btrim(pol.qual) <> '( SELECT is_super_admin() AS is_super_admin)'
    ) THEN
      RAISE EXCEPTION
        'Bảng public.% không có policy SELECT cho phép người xem — realtime sẽ không giao event cho ai. DỪNG.',
        r.tablename;
    END IF;

    SELECT c.relreplident INTO v_ident
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = r.tablename;
    IF v_ident = 'f' THEN
      RAISE WARNING 'public.% đang REPLICA IDENTITY FULL — event sẽ mang cả nội dung dòng, xem lại có cần không', r.tablename;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', r.tablename);
    v_added := v_added + 1;
    RAISE NOTICE 'đã thêm public.% vào supabase_realtime', r.tablename;
  END LOOP;

  RAISE NOTICE 'Tổng đã thêm: % bảng', v_added;
END
$add$;

DO $selfcheck$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t.tablename, ', ') INTO v_missing
    FROM (VALUES ('meter_readings'), ('meters')) AS t(tablename)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_publication_tables p
      WHERE p.pubname = 'supabase_realtime' AND p.schemaname = 'public'
        AND p.tablename = t.tablename);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Còn thiếu trong publication: %. DỪNG.', v_missing;
  END IF;
END
$selfcheck$;
