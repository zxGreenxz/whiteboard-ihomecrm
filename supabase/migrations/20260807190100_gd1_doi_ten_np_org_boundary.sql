-- =============================================================================
-- GĐ1 — Đổi tên policy biên giới duy nhất đang lệch quy ước
--
-- Quy ước của Sprint 3b: policy biên giới tổ chức tên là relname || '_org_boundary'.
-- 31/32 policy tuân thủ. Riêng `notification_preferences` mang tên viết tắt
-- `np_org_boundary` (đặt ở 20260729150000_notification_config_tables_rpc.sql).
--
-- VÌ SAO MỘT CÁI TÊN LẠI ĐÁNG MỘT MIGRATION.
-- Gate đếm bảng "đã có biên giới" bằng cách khớp tên theo quy ước. Một cái tên
-- lệch nghĩa là bảng đó bị đếm là THIẾU biên giới VĨNH VIỄN — vá bao nhiêu lần
-- cũng không làm con số đúng lên được. Đây chính là chỗ sinh ra khoảng lệch
-- 272 vs 273 giữa con số bản kế hoạch dùng và con số đo thật, và một gate đếm
-- sai theo hướng bi quan sẽ bị người ta tắt đi sau vài tuần.
--
-- Đổi tên KHÔNG đụng tới nội dung policy: cùng USING, cùng WITH CHECK, cùng vai.
-- Đo trước khi đổi: đúng 1 policy lệch quy ước, tổng 32 policy biên giới.
-- =============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'notification_preferences'
       AND p.polname = 'np_org_boundary'
  ) THEN
    RAISE NOTICE 'np_org_boundary không còn — có thể đã đổi tên trước đó. Bỏ qua.';
  END IF;
END
$preflight$;

ALTER POLICY np_org_boundary ON public.notification_preferences
  RENAME TO notification_preferences_org_boundary;

DO $verify$
DECLARE
  v_lech text;
BEGIN
  SELECT string_agg(c.relname || '.' || p.polname, ', ')
    INTO v_lech
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE p.polname LIKE '%org_boundary%'
     AND p.polname <> c.relname || '_org_boundary';

  IF v_lech IS NOT NULL THEN
    RAISE EXCEPTION 'Vẫn còn policy biên giới lệch quy ước: % — gate sẽ đếm chúng là thiếu vĩnh viễn. DỪNG.', v_lech;
  END IF;
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK:
--   ALTER POLICY notification_preferences_org_boundary ON public.notification_preferences
--     RENAME TO np_org_boundary;
-- =============================================================================
