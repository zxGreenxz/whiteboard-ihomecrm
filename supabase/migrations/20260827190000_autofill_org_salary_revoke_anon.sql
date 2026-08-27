BEGIN;
-- ============================================================
-- _autofill_org_salary(): cắt EXECUTE của anon + authenticated
--
-- VÌ SAO CÓ FILE NÀY — gate check-definer-acl đỏ trên CI run 33075149963:
--     ❌ 1 SECURITY DEFINER function MỚI anon-executable ngoài allowlist:
--        + _autofill_org_salary()
--
--   20260827180000 có `REVOKE ALL ON FUNCTION ... FROM PUBLIC`, và thế là CHƯA
--   ĐỦ. Trên Supabase, schema `public` có DEFAULT PRIVILEGES cấp EXECUTE thẳng
--   cho vai `anon` và `authenticated`; REVOKE khỏi PUBLIC không đụng tới hai
--   GRANT riêng đó. Đo sau khi apply 180000:
--       _autofill_org       anon=false  authenticated=false
--       _autofill_org_salary anon=true  authenticated=true   ← lệch
--   Hàm anh em `_autofill_org()` sạch, nên đây là thiếu sót của file mới chứ
--   không phải quy ước chung của repo.
--
--   Rủi ro thật: hàm là SECURITY DEFINER, chạy bằng quyền owner. Để anon gọi
--   được một hàm definer là mở một cửa không ai định mở — kể cả khi thân hàm
--   hiện tại chỉ đọc và RAISE, vì lần sửa sau không ai nhớ lại chuyện ACL.
--
-- KHÔNG sửa thẳng 180000: nó đã apply lên production và evidence
--   (docs/generated/schema-change-evidence/…180000.json) ghim sha256 của đúng
--   bytes đã chạy. Sửa file là biến bằng chứng đó thành lời khai về một file
--   không còn tồn tại.
--
-- Trigger KHÔNG cần EXECUTE cấp cho ai: nó do bảng gọi, chạy bằng quyền owner.
-- Cắt quyền không làm hai trigger ở 180000 ngừng chạy — khối kiểm cuối file này
-- soi lại chính điều đó bằng catalog.
--
-- Chạy được trên database rỗng: REVOKE trên hàm luôn tồn tại (180000 chạy trước
-- trong cùng lane), phép kiểm chỉ soi catalog, không khẳng định gì trên dữ liệu.
-- ============================================================

REVOKE ALL ON FUNCTION public._autofill_org_salary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._autofill_org_salary() FROM anon;
REVOKE ALL ON FUNCTION public._autofill_org_salary() FROM authenticated;

DO $kiem$
DECLARE
  v_anon boolean;
  v_auth boolean;
  v_trig integer;
BEGIN
  SELECT has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
    INTO v_anon, v_auth
    FROM pg_proc p
   WHERE p.proname = '_autofill_org_salary'
     AND p.pronamespace = 'public'::regnamespace;

  IF v_anon OR v_auth THEN
    RAISE EXCEPTION '_autofill_org_salary vẫn gọi được: anon=% authenticated=%', v_anon, v_auth;
  END IF;

  -- Cắt quyền xong hai trigger phải còn nguyên.
  SELECT count(*) INTO v_trig
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE p.proname = '_autofill_org_salary'
     AND NOT t.tgisinternal;

  IF v_trig <> 2 THEN
    RAISE EXCEPTION 'Kỳ vọng 2 trigger _autofill_org_salary sau REVOKE, đếm được %', v_trig;
  END IF;
END
$kiem$;

COMMIT;
