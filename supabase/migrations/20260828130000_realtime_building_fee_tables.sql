-- =====================================================================
-- Realtime cho HAI BẢNG CẤU HÌNH PHÍ THEO TOÀ — building_fee_accounts +
-- building_utility_accounts (audit 27/08, C-INFRA-7 / DoD dòng 1746 của Plan 2).
--
-- VÌ SAO: trang /thanh-toan đọc hai bảng này (ô phí cố định, sổ điện nước) và
-- các query key period-fee-status / fee-accounts / utility-accounts. Chúng vắng
-- khỏi publication lẫn SYNC_TABLES ⇒ một máy sửa cấu hình phí thì máy kia phải
-- F5 mới thấy — đúng lớp lỗi đã có án lệ với contract_terminations.
--
-- Chép nguyên khuôn 20260731060000 (preflight tồn tại + RLS bắt buộc + ghi nhận
-- REPLICA IDENTITY + idempotent). Đo trước khi viết: cả hai bảng relrowsecurity
-- = true, relreplident = d.
--
-- KHÔNG ĐỤNG TIỀN: chỉ ALTER PUBLICATION. Không DDL bảng, không DML.
-- =====================================================================
BEGIN;

DO $pub$
DECLARE
  r record;
  v_added int := 0;
  v_ident "char";
BEGIN
  FOR r IN
    SELECT t.tablename
      FROM (VALUES ('building_fee_accounts'), ('building_utility_accounts')) AS t(tablename)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname = r.tablename
    ) THEN
      RAISE EXCEPTION 'Không thấy bảng public.% — DỪNG.', r.tablename;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_publication_tables p
       WHERE p.pubname='supabase_realtime' AND p.schemaname='public'
         AND p.tablename = r.tablename
    ) THEN
      RAISE NOTICE '% đã có trong supabase_realtime — bỏ qua', r.tablename;
      CONTINUE;
    END IF;

    IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname = r.tablename) THEN
      RAISE EXCEPTION
        'Bảng public.% chưa bật RLS — KHÔNG đưa vào publication realtime (realtime lọc theo RLS người nghe)',
        r.tablename;
    END IF;

    -- Ghi nhận REPLICA IDENTITY để nếu ai đó đã đặt FULL thì biết mà xem lại.
    SELECT c.relreplident INTO v_ident
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname = r.tablename;
    IF v_ident = 'f' THEN
      RAISE WARNING 'public.% đang REPLICA IDENTITY FULL — event sẽ mang cả nội dung dòng, xem lại có cần không', r.tablename;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', r.tablename);
    v_added := v_added + 1;
    RAISE NOTICE 'đã thêm public.% vào supabase_realtime', r.tablename;
  END LOOP;

  RAISE NOTICE 'Tổng đã thêm: % bảng', v_added;
END
$pub$;

DO $selfcheck$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t.tablename, ', ') INTO v_missing
    FROM (VALUES ('building_fee_accounts'), ('building_utility_accounts')) AS t(tablename)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_publication_tables p
      WHERE p.pubname='supabase_realtime' AND p.schemaname='public'
        AND p.tablename = t.tablename);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Còn thiếu trong publication: %. DỪNG.', v_missing;
  END IF;
END
$selfcheck$;

COMMIT;
