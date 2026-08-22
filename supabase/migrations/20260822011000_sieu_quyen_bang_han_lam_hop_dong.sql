-- =============================================================================
-- Thu hồi quyền bảng thừa trên public.reservation_hold_deadlines
--
-- LỖI CỦA MIGRATION 20260822010000, đo được ngay sau khi apply:
--
--     authenticated : DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--     (bảng anh em room_reservation_holds: authenticated chỉ SELECT)
--
-- NGUYÊN NHÂN: Supabase có `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
-- authenticated` trong schema public, nên quyền được cấp NGAY tại CREATE TABLE.
-- Migration kia viết `REVOKE ALL ... FROM PUBLIC, anon` — đúng cho `anon` (đã
-- kiểm: anon không còn dòng nào trong role_table_grants), nhưng `authenticated`
-- KHÔNG nằm trong PUBLIC nên nó không bị chạm. `GRANT SELECT TO authenticated`
-- ngay sau đó chỉ là phép cộng vào một tập vốn đã đầy đủ.
--
-- MỨC ĐỘ: KHÔNG hở dữ liệu. Bảng bật RLS và không có policy PERMISSIVE nào cho
-- INSERT/UPDATE/DELETE, nên RLS từ chối mặc định — `authenticated` có quyền
-- BẢNG nhưng không ghi được dòng nào. Thứ bị mất là LỚP THỨ HAI: thiết kế nói
-- "đường ghi duy nhất là RPC, kể cả khi ai đó lỡ thêm policy". Với quyền bảng
-- còn nguyên, chỉ cần một policy ghi thêm vào sau này là mất luôn phần kiểm
-- quyền TOÀ NHÀ mà RPC đang giữ — và RLS thì không biết phiếu thuộc toà nào.
--
-- Vì thế đây là forward-fix ngay, không đợi gom lô.
-- =============================================================================

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.reservation_hold_deadlines') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng reservation_hold_deadlines. DỪNG.';
  END IF;
END
$guard$;

REVOKE ALL ON TABLE public.reservation_hold_deadlines FROM authenticated;
GRANT SELECT ON TABLE public.reservation_hold_deadlines TO authenticated;

-- Nhắc lại cho anon và PUBLIC — idempotent, và để file này tự đủ nghĩa nếu ai
-- đọc nó tách khỏi 20260822010000.
REVOKE ALL ON TABLE public.reservation_hold_deadlines FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- TỰ KIỂM — đo TẬP QUYỀN THẬT, không đo câu lệnh vừa gõ
-- ---------------------------------------------------------------------------
DO $tk$
DECLARE v_thua text;
BEGIN
  SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) INTO v_thua
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name = 'reservation_hold_deadlines'
     AND grantee = 'authenticated'
     AND privilege_type <> 'SELECT';
  IF v_thua IS NOT NULL THEN
    RAISE EXCEPTION 'authenticated còn quyền thừa: %. DỪNG.', v_thua;
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.reservation_hold_deadlines', 'SELECT') THEN
    RAISE EXCEPTION 'Thu hồi quá tay — authenticated mất luôn SELECT, FE không đọc được hạn. DỪNG.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public'
       AND table_name = 'reservation_hold_deadlines'
       AND grantee IN ('anon', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'anon/PUBLIC còn quyền trên bảng. DỪNG.';
  END IF;

  -- service_role PHẢI còn đủ quyền: job nền và edge function đi vai này.
  IF NOT has_table_privilege('service_role', 'public.reservation_hold_deadlines', 'INSERT') THEN
    RAISE EXCEPTION 'service_role mất quyền ghi. DỪNG.';
  END IF;
END
$tk$;

COMMIT;

NOTIFY pgrst, 'reload schema';
