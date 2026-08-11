-- =============================================================================
-- GĐ0 — Bịt bề mặt gọi được KHÔNG CẦN ĐĂNG NHẬP
-- (giai đoạn đầu của kế hoạch docs/plans/PLAN-TACH-DU-LIEU-DA-CONG-TY.md)
--
-- ÁN LỆ 07/08/2026. `public.get_public_latest_invoice_by_contract(uuid)` là
-- SECURITY DEFINER, thân hàm KHÔNG có một dòng kiểm quyền nào — chỉ kiểm hợp
-- đồng tồn tại / chưa xoá / chưa thanh lý — mà lại được GRANT cho role `anon`.
-- Đã gọi thật bằng anon key lấy từ bundle trình duyệt, KHÔNG đăng nhập:
--   HTTP 200, trả về họ tên khách thuê, số điện thoại, tên toà, số phòng và
--   toàn bộ dòng hoá đơn kèm số tiền — của công ty THẬT.
-- Ba hàm `building_of_invoice/contract/payment` cũng mở cho `anon`; chúng là
-- máy dò: xác nhận một UUID hoá đơn/hợp đồng/thanh toán có tồn tại hay không
-- và ánh xạ nó sang toà nhà.
--
-- ĐƯỜNG CÔNG KHAI HỢP LỆ KHÔNG BỊ ĐỤNG TỚI.
-- Tính năng tra hoá đơn công khai đi qua `get_public_latest_invoice_by_code(text)`,
-- lấy `contracts.public_code` (6–8 ký tự ngẫu nhiên) làm bí mật chia sẻ. Hàm đó
-- gọi `..._by_contract` BÊN TRONG thân mình; vì nó là SECURITY DEFINER nên lời
-- gọi bên trong chạy bằng quyền chủ hàm, KHÔNG phụ thuộc quyền của `anon`.
-- Đã đo: sau khi thu hồi, `anon` gọi `by_code` vẫn trả đúng dữ liệu.
--
-- ⚠ HAI VAI PHẢI ĐỐI XỬ KHÁC NHAU — CHỖ NÀY BẢN KẾ HOẠCH ĐẦU TIÊN VIẾT SAI.
-- Kế hoạch v1 định thu hồi `building_of_*` khỏi cả `authenticated` rồi dời sang
-- schema app_private. Đo thật trong transaction rollback cho thấy làm vậy là
-- GÃY NGAY production: 4/5 bảng thử nghiệm ném 42501 "permission denied for
-- function building_of_contract" với người dùng thường —
--   contract_tenants, deposits, contract_services, contract_terminations.
-- Lý do: biểu thức của RLS policy được đánh giá bằng quyền của CHÍNH người
-- truy vấn, mà hơn 40 policy *_rbac đang gọi ba hàm này. Thu hồi khỏi
-- `authenticated` = tự khoá cửa nhà mình.
--
-- Vì vậy file này chỉ thu hồi khỏi `anon` và `PUBLIC` cho ba hàm building_of_*.
-- Việc bịt nốt máy dò đối với người ĐÃ đăng nhập của tổ chức khác là việc khác
-- hẳn: phải viết lại 40+ policy để không cần hàm trần, thuộc giai đoạn sau.
--
-- VÌ SAO CÓ `PUBLIC` TRONG DANH SÁCH THU HỒI:
-- quyền cấp cho PUBLIC không hiện ra khi chỉ thu hồi theo tên role. Thiếu vế này
-- thì REVOKE chạy xong mà quyền vẫn còn nguyên.
--
-- ĐO TRƯỚC/SAU (transaction rollback, vai thật qua SET ROLE + JWT):
--   nathan (nhân viên thường org aaaa) đọc contract_tenants/invoice_items/
--     deposits/contract_services/contract_terminations = 0/2690/0/213/31
--     — TRƯỚC và SAU thu hồi giống hệt nhau.
--   nathan gọi building_of_contract  → vẫn chạy (policy cần).
--   anon  gọi get_public_latest_invoice_by_code → vẫn chạy.
--   anon  gọi get_public_latest_invoice_by_contract → bị chặn 42501. ✔
--   anon  gọi building_of_contract → bị chặn 42501. ✔
--
-- Idempotent: REVOKE trên quyền đã mất là no-op.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- PREFLIGHT — không được bịt cửa sau khi cửa trước đã hỏng.
-- Nếu `by_code` không còn hoặc không còn là SECURITY DEFINER thì việc thu hồi
-- `by_contract` sẽ giết luôn tính năng tra hoá đơn công khai của khách thuê.
-- ─────────────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_secdef boolean;
  v_anon_goi_duoc boolean;
BEGIN
  SELECT p.prosecdef
    INTO v_secdef
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'get_public_latest_invoice_by_code';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không thấy get_public_latest_invoice_by_code — đường công khai hợp lệ đã biến mất, thu hồi by_contract lúc này sẽ giết tính năng tra hoá đơn. DỪNG.';
  END IF;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'get_public_latest_invoice_by_code không còn là SECURITY DEFINER — lời gọi by_contract bên trong nó sẽ chạy bằng quyền người gọi và hỏng sau khi thu hồi. DỪNG.';
  END IF;

  SELECT has_function_privilege('anon', p.oid, 'EXECUTE')
    INTO v_anon_goi_duoc
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'get_public_latest_invoice_by_code';

  IF NOT v_anon_goi_duoc THEN
    RAISE EXCEPTION 'anon vốn đã không gọi được by_code — trang tra hoá đơn công khai đang hỏng sẵn. Sửa việc đó trước. DỪNG.';
  END IF;

  -- Ba hàm building_of_* phải còn nguyên quyền của authenticated TRƯỚC khi chạy,
  -- nếu không thì 40+ policy đang hỏng sẵn và file này sẽ che mất triệu chứng.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('building_of_invoice','building_of_contract','building_of_payment')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Có building_of_* mà authenticated đã mất quyền — RLS đang hỏng sẵn. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- (1) Hàm rò dữ liệu khách: đóng với MỌI vai gọi trực tiếp.
--     Không ai trong repo gọi hàm này (chỉ có khai báo kiểu tự sinh ở
--     src/integrations/supabase/types.ts). Đường dùng hợp lệ duy nhất là qua
--     thân của by_code.
-- ─────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.get_public_latest_invoice_by_contract(uuid)
  FROM anon, authenticated, PUBLIC;

-- ─────────────────────────────────────────────────────────────────────
-- (2) Máy dò: đóng với người CHƯA đăng nhập.
--     GIỮ NGUYÊN cho `authenticated` — 40+ policy *_rbac gọi chúng và biểu thức
--     policy chạy bằng quyền người truy vấn. Xem khối chú thích đầu file.
-- ─────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.building_of_invoice(uuid)
  FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.building_of_contract(uuid)
  FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.building_of_payment(uuid)
  FROM anon, PUBLIC;

COMMENT ON FUNCTION public.get_public_latest_invoice_by_contract(uuid) IS
  'CHỈ dùng nội bộ trong thân get_public_latest_invoice_by_code. Không GRANT lại cho anon/authenticated: '
  'hàm không kiểm quyền, ai cầm contract_id là đọc được họ tên + SĐT khách thuê và toàn bộ hoá đơn. Án lệ 07/08/2026.';

-- ─────────────────────────────────────────────────────────────────────
-- VERIFY — ba mệnh đề, thiếu một là hỏng việc.
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_ten text;
BEGIN
  -- (a) anon phải hết quyền trên cả bốn hàm.
  SELECT string_agg(p.proname, ', ')
    INTO v_ten
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('get_public_latest_invoice_by_contract',
                       'building_of_invoice','building_of_contract','building_of_payment')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_ten IS NOT NULL THEN
    RAISE EXCEPTION 'anon VẪN gọi được: % — thu hồi chưa ăn (nhiều khả năng còn quyền cấp cho PUBLIC). DỪNG.', v_ten;
  END IF;

  -- (b) authenticated PHẢI còn quyền trên building_of_* — hơn 40 policy *_rbac
  --     gọi chúng, mất quyền là người dùng thường đọc gì cũng 42501.
  SELECT string_agg(p.proname, ', ')
    INTO v_ten
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('building_of_invoice','building_of_contract','building_of_payment')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_ten IS NOT NULL THEN
    RAISE EXCEPTION 'authenticated MẤT quyền trên % — sẽ vỡ 40+ policy RLS gọi hàm này. DỪNG.', v_ten;
  END IF;

  -- (c) anon PHẢI còn gọi được by_code — đó là tính năng của khách thuê.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'get_public_latest_invoice_by_code'
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'anon mất quyền gọi by_code — vừa giết trang tra hoá đơn công khai. DỪNG.';
  END IF;
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK: (chỉ dùng khi thật sự phải mở lại — đang mở lại một lỗ rò PII)
--   GRANT EXECUTE ON FUNCTION public.get_public_latest_invoice_by_contract(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.building_of_invoice(uuid)  TO anon;
--   GRANT EXECUTE ON FUNCTION public.building_of_contract(uuid) TO anon;
--   GRANT EXECUTE ON FUNCTION public.building_of_payment(uuid)  TO anon;
-- =============================================================================
