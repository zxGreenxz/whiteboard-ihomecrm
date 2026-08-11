-- =============================================================================
-- SPIKE GĐ-R — PostgREST trên project này có phơi `request.headers` không?
--
-- TẠM THỜI. Có migration đi kèm gỡ bỏ ngay sau khi đo xong
-- (20260808120000_go_spike_request_headers.sql). Không được để lại trên prod.
--
-- VÌ SAO PHẢI ĐO: GĐ-R có hai thiết kế, và kế hoạch ghi rõ Thiết kế A có một
-- điều kiện tiên quyết PHẢI CHỨNG MINH TRƯỚC KHI CHỌN:
--
--   Thiết kế A (thuần DB, không sửa client): bảng đếm theo IP, đọc
--     current_setting('request.headers', true)::json->>'x-forwarded-for'.
--     Hàm get_public_latest_invoice_by_code là VOLATILE nên ghi được.
--     ĐIỀU KIỆN: (1) GUC đó thực sự mang header trên CHÍNH project này —
--     repo có 0 tiền lệ, grep 'request.headers|x-forwarded-for' trong
--     supabase/migrations = 0 hit; (2) xác định hop nào của chuỗi XFF do proxy
--     của Supabase tự nối vào, vì phần đầu chuỗi do CLIENT tự đặt và kẻ tấn công
--     đổi được mỗi request. Không chứng minh được cả hai thì Thiết kế A là
--     limiter GIẢ và phải bị loại.
--
--   Thiết kế B (edge function): dựng supabase/functions/public-invoice/ với
--     verify_jwt=false, rate-limit trên x-forwarded-for của Deno, rồi sửa URL ở
--     client. Kèm ràng buộc BẮT BUỘC: REVOKE EXECUTE
--     get_public_latest_invoice_by_code(text) khỏi anon, nếu không thì cứ POST
--     thẳng PostgREST là đi vòng qua limiter trong một dòng curl.
--
-- Hàm dưới đây KHÔNG đọc dữ liệu của ai: nó chỉ trả lại header của CHÍNH request
-- đang gọi nó. Cấp cho authenticated, KHÔNG cấp cho anon — người đã đăng nhập
-- xem header của chính mình thì không lộ gì thêm.
--
-- SECURITY INVOKER (mặc định) là cố ý: cần đọc GUC của phiên gọi, không cần
-- quyền của ai cả.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.zz_spike_request_headers()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $f$
  SELECT jsonb_build_object(
    'co_guc_headers',  current_setting('request.headers', true) IS NOT NULL,
    'headers_tho',     current_setting('request.headers', true),
    'xff',             (current_setting('request.headers', true))::jsonb ->> 'x-forwarded-for',
    'cf_connecting_ip',(current_setting('request.headers', true))::jsonb ->> 'cf-connecting-ip',
    'x_real_ip',       (current_setting('request.headers', true))::jsonb ->> 'x-real-ip',
    'inet_client_addr', inet_client_addr()::text,
    'ten_khoa',        (SELECT jsonb_agg(k ORDER BY k)
                          FROM jsonb_object_keys(
                                 coalesce((current_setting('request.headers', true))::jsonb, '{}'::jsonb)) k)
  );
$f$;

REVOKE EXECUTE ON FUNCTION public.zz_spike_request_headers() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.zz_spike_request_headers() TO authenticated;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.zz_spike_request_headers()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Hàm spike vẫn gọi được bằng anon — không được phơi thêm bề mặt ẩn danh. DỪNG.';
  END IF;
  RAISE NOTICE 'Hàm spike đã dựng, chỉ authenticated gọi được. NHỚ GỠ bằng 20260808120000.';
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK: DROP FUNCTION public.zz_spike_request_headers();
-- Đã có sẵn thành migration 20260808120000_go_spike_request_headers.sql.
-- =============================================================================
