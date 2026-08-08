-- =============================================================================
-- Gỡ hàm dò tạm của spike GĐ-R (20260808110000). Đã đo xong, không để lại prod.
--
-- ======================= KẾT QUẢ ĐO, GHI LẠI TẠI ĐÂY ========================
--
-- Câu hỏi 1 — PostgREST có phơi `request.headers` trên project này không?
--   CÓ. current_setting('request.headers', true) trả về JSON đầy đủ, gồm cả
--   header tự chế mà client tự đặt. 25 khoá quan sát được, trong đó có:
--     x-forwarded-for · cf-connecting-ip · cf-ray · cf-worker · cf-ipcountry
--     cf-visitor · cf-ew-via · cdn-loop · x-envoy-original-path · sb-request-id
--
-- Câu hỏi 2 — hop nào của x-forwarded-for là ĐÁNG TIN?
--   HOP CUỐI CÙNG. Đo bằng cách gửi XFF giả rồi xem DB nhận gì:
--     gửi (không có)                  → DB thấy "113.177.142.96"
--     gửi "9.9.9.9"                   → DB thấy "9.9.9.9,113.177.142.96"
--     gửi "203.0.113.99, 198.51.100.7"→ DB thấy "203.0.113.99, 198.51.100.7,113.177.142.96"
--   Hạ tầng luôn NỐI IP thật vào cuối. Phần đầu chuỗi do client tự đặt, đổi
--   được mỗi request — dùng phần đầu để đếm là limiter GIẢ.
--
-- Câu hỏi 3 — cf-connecting-ip có giả được không?
--   KHÔNG, và mạnh hơn thế: cố giả thì bị chặn ngay ở biên.
--     gửi CF-Connecting-IP: 1.2.3.4   → HTTP 403, trang lỗi HTML của Cloudflare
--     gửi cả CF-Connecting-IP lẫn XFF → HTTP 403
--     không gửi gì                    → cf-connecting-ip = 113.177.142.96 (IP thật)
--   Tức cf-connecting-ip là giá trị do Cloudflare tự đặt, client không chạm được.
--
-- ================== ĐIỀU NÀY LẬT MỘT KẾT LUẬN CỦA KẾ HOẠCH ==================
--
-- GĐ-R mục 1(b) ghi: "Cloudflare chỉ đứng trước chillhome.io.vn (img/storage),
-- không trước supabase.co lẫn ptcrm.vercel.app." SAI. Cloudflare CÓ đứng trước
-- supabase.co — chứng cứ là cf-ray/cf-worker/cf-ipcountry/cdn-loop có mặt trong
-- mọi request, và chính Cloudflare trả 403 khi client cố giả header của nó.
-- (Mục 1(a) — Vercel không nhìn thấy request — vẫn ĐÚNG: trình duyệt gọi thẳng
-- supabase.co bằng fetch thuần, Vercel nằm ngoài đường đi.)
--
-- ========================= HỆ QUẢ CHO VIỆC CHỌN =============================
--
-- THIẾT KẾ A (thuần DB) — CHỌN. Điều kiện tiên quyết mà kế hoạch đòi đã được
-- chứng minh đủ cả hai vế: GUC có thật, và có một nguồn IP không giả được
-- (cf-connecting-ip, hoặc hop cuối của XFF nếu Cloudflare vắng mặt). Hàm
-- get_public_latest_invoice_by_code là VOLATILE nên ghi bảng đếm được.
--
-- THIẾT KẾ B (edge function) — LOẠI, và không chỉ vì tốn công hơn. Điểm yếu cốt
-- lõi của B là kẻ tấn công cứ POST thẳng /rest/v1/rpc là đi vòng qua limiter —
-- nên B BẮT BUỘC kèm REVOKE EXECUTE khỏi anon, tức phải sửa client, sửa
-- allow-list definer-acl, sửa edge-function-surface. A không có đường vòng nào
-- vì bộ đếm nằm BÊN TRONG chính hàm mà anon gọi.
--
-- Một điểm phải nhớ khi thi hành A: đếm theo cf-connecting-ip thì mọi khách sau
-- cùng một NAT/4G-gateway dùng chung một quota. Ngưỡng phải rộng tay, và phải
-- đếm theo (ip, mã-sai) chứ không phải mọi lượt gọi — người xem hoá đơn của
-- chính mình gọi đúng mã, kẻ dò thì gọi sai liên tục.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.zz_spike_request_headers();

DO $verify$
BEGIN
  IF to_regprocedure('public.zz_spike_request_headers()') IS NOT NULL THEN
    RAISE EXCEPTION 'Hàm spike vẫn còn trên production. DỪNG.';
  END IF;
  RAISE NOTICE 'Đã gỡ hàm dò tạm. Kết quả đo ghi trong chú thích đầu file này.';
END
$verify$;

COMMIT;
