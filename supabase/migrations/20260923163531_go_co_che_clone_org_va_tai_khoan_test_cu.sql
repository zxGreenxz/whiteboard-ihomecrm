-- =============================================================================
-- GỠ CƠ CHẾ ĐỒNG BỘ ORG TEST CŨ (schema clone_org) + 4 TÀI KHOẢN test.*
-- =============================================================================
--
-- Org TEST cccc0000-… xoá 08/08/2026; dữ liệu còn sót của nó đã dọn ở
-- 20260923162145. Còn lại bộ máy đồng bộ đã chết (đo production 23/09):
--   - schema clone_org: 7 bảng (user_map, idmap, sync_request…), 2 sequence,
--     7 hàm (do_sync chạy dưới session_replication_role=replica — tắt mọi guard);
--   - 2 RPC public.clone_org_request_sync_v1 / clone_org_sync_status_v1 — thẻ
--     "Công ty TEST" trên trang Cài đặt → Tổ chức đã gỡ khỏi giao diện cùng đợt;
--   - 4 tài khoản test.*@username.ihomecrm.local: không membership, còn đăng nhập được;
--     ngoài 20 dòng public.push_send_log (nhật ký chống gửi trùng, không khoá ngoại, tự
--     dọn sau 7 ngày — cố ý để nguyên) không còn dòng dữ liệu nào tham chiếu (đã kiểm).
-- Bản thay thế: môi trường TEST là project Supabase riêng (scripts/test-env/).
--
-- Đã kiểm trước khi viết: không view/policy/khoá ngoại nào ngoài schema phụ thuộc
-- clone_org; hàm duy nhất ngoài schema nhắc tới "clone_org" là
-- public._chung_building — CHỈ trong chú thích, thân hàm không truy vấn schema này.
--
-- CHỐT: chỉ chạy khi file bản sao trong thư mục 4 tài khoản test.* đã xoá khỏi
-- storage (bước riêng, có tải bản lưu trước) — storage.objects của chúng trỏ owner
-- về các tài khoản này.
-- IDEMPOTENT: DROP IF EXISTS, DELETE lọc đúng 4 id; lượt hai của lane không đổi gì.
-- sandbox_org_ids() và họ policy *_hide_sandbox_admin GIỮ NGUYÊN (Contract §2).
-- =============================================================================

DO $b0$
DECLARE v bigint;
BEGIN
  SELECT count(*) INTO v FROM storage.objects
   WHERE split_part(name, '/', 1) IN ('6879ff40-0f23-4f18-a6f5-f46c155abf30', 'e23e7161-ea2a-41a9-be8f-f53ca90a1aa7',
                                      '219da27c-9b26-4504-811d-11592e8e540a', '9892102c-2541-4591-8170-a8afecd4e818');
  IF v > 0 THEN
    RAISE EXCEPTION 'Còn % file trong thư mục tài khoản test.* — xoá file (có bản lưu) trước. DỪNG.', v;
  END IF;
  SELECT count(*) INTO v FROM public.organization_memberships
   WHERE user_id IN ('6879ff40-0f23-4f18-a6f5-f46c155abf30', 'e23e7161-ea2a-41a9-be8f-f53ca90a1aa7',
                     '219da27c-9b26-4504-811d-11592e8e540a', '9892102c-2541-4591-8170-a8afecd4e818');
  IF v > 0 THEN
    RAISE EXCEPTION 'Tài khoản test.* vẫn còn % membership — không phải tình huống file này dọn. DỪNG.', v;
  END IF;
END $b0$;

-- Cron đã gỡ ở 20260923162145; lặp lại cho chắc (idempotent).
DO $b1$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone_org_sync_worker') THEN
    PERFORM cron.unschedule('clone_org_sync_worker');
  END IF;
END $b1$;

DROP FUNCTION IF EXISTS public.clone_org_request_sync_v1();
DROP FUNCTION IF EXISTS public.clone_org_sync_status_v1();
DROP SCHEMA IF EXISTS clone_org CASCADE;

-- 4 tài khoản test.*: lọc ĐỒNG THỜI theo id và email — không bao giờ khớp nhầm ai khác.
DELETE FROM auth.users
 WHERE id IN ('6879ff40-0f23-4f18-a6f5-f46c155abf30', 'e23e7161-ea2a-41a9-be8f-f53ca90a1aa7',
              '219da27c-9b26-4504-811d-11592e8e540a', '9892102c-2541-4591-8170-a8afecd4e818')
   AND email LIKE 'test.%@username.ihomecrm.local';

DO $kiem$
BEGIN
  IF to_regnamespace('clone_org') IS NOT NULL THEN RAISE EXCEPTION 'Schema clone_org vẫn còn. KHÔNG commit.'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'clone\_org\_%' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'RPC clone_org_* vẫn còn. KHÔNG commit.';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE email LIKE 'test.%@username.ihomecrm.local') THEN
    RAISE EXCEPTION 'Tài khoản test.* vẫn còn. KHÔNG commit.';
  END IF;
  IF to_regclass('cron.job') IS NOT NULL
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone_org_sync_worker') THEN
    RAISE EXCEPTION 'Cron clone_org_sync_worker vẫn còn. KHÔNG commit.';
  END IF;
  RAISE NOTICE 'Đã gỡ schema clone_org, 2 RPC clone_org_*, cron đồng bộ và 4 tài khoản test.*.';
END $kiem$;
