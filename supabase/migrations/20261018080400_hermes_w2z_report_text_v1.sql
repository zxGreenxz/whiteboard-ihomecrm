-- Hermes đọc đầy đủ — ĐỢT 2, Gói Z (tích hợp, 18/10/2026): chốt MỘT bản public.report_text_v1 cho Gói B và Gói D.
-- Hai gói song song cùng tạo hàm làm sạch chữ này (B: 20261018020050 → 20261018020250; D: 20261018040000 → 20261018040200),
-- thân khác nhau ở điều kiện vai: theo thứ tự áp, bản D (chặn thêm auth.uid() rỗng) đè bản B. File này là định nghĩa CUỐI
-- (hàng rào gói infra/hermes-broker/wave2-sql-paths.mjs chỉ cho hai gói cùng định nghĩa khi bản cuối ở dải Z): giữ điều kiện
-- chặt hơn của D (current_user = authenticated VÀ có auth.uid()), thông báo lỗi trung tính; phép làm sạch giữ nguyên từng chữ
-- (giữ xuống dòng, bỏ ký tự điều khiển, cắt theo ký tự). Áp SAU 20261018040200, TRƯỚC 20261018090000. CREATE OR REPLACE
-- giữ ACL (B và D đều REVOKE PUBLIC/anon/service_role, GRANT authenticated). Không DROP, không đổi chữ ký, không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE OR REPLACE FUNCTION public.report_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'report_text_denied' USING ERRCODE='42501'; END IF;
  IF p_text IS NULL THEN RETURN NULL; END IF;
  RETURN left(btrim(regexp_replace(
    translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
    '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0));
END $fn$;

ALTER FUNCTION public.report_text_v1(text,integer) OWNER TO postgres;
COMMIT;
NOTIFY pgrst,'reload schema';
