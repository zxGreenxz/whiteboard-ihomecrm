-- Hermes đọc đầy đủ — nền đợt 2, sửa sau phát hành (22/10/2026; trang Hợp đồng Đợt 2 Mốc 3, HOP-DONG-THAO-TAC-GHI.md mục 6):
-- thêm khoá đợt 1 'contracts.view' vào tập khoá DÙNG LẠI của sổ báo cáo W2, để báo cáo hợp đồng (hết hạn theo khoảng ngày, báo
-- dọn đi, hồ sơ chờ quyết toán) đọc được bằng quyền XEM HỢP ĐỒNG — Quản lý toà có quyền này theo toà, không có quyền báo cáo BĐS.
-- Khoá đã có trong registry Read và đang bật (mọi kết nối hiện có đều có Read contracts.view). Loại khoá: 'company' (theo toà),
-- như các khoá dùng lại khác; phạm vi = quyền CRM theo toà ∩ overlay kết nối ∩ tập toà web (cổng nền, không đổi).
-- Dựng từ thân ĐANG CHẠY (production = TEST = repo 20261018000500, md5(prosrc) ghim ở $requires$); chỉ thêm một phần tử. Phải áp
-- TRƯỚC bảng báo cáo gói D có báo cáo dùng khoá này (thứ tự tên đảm bảo). Không đổi chữ ký, ACL, không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2_reused_keys_v1()');
  IF v_src IS NULL OR NOT (md5(v_src)='465cf331b9cb90ae589b122d5e60e8b1' OR position('''contracts.view''' IN v_src)>0) THEN
    RAISE EXCEPTION 'hermes_w2_contracts_view_reused_base_changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='contracts.view' AND mode='read') THEN
    RAISE EXCEPTION 'hermes_w2_contracts_view_reused_dependency_invalid'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_w2_reused_keys_v1()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT ARRAY['invoices.view','deposits.view','reports_finance.analysis','assets.view','services.view','rooms.view',
   'income_expenses.view','contracts.view']::text[]
$fn$;
ALTER FUNCTION app_private.hermes_w2_reused_keys_v1() OWNER TO postgres;

DO $check$
BEGIN
  IF NOT ('contracts.view'=ANY(app_private.hermes_w2_reused_keys_v1())) OR cardinality(app_private.hermes_w2_reused_keys_v1())<>8
    OR app_private.hermes_w2_permission_kind_v1('contracts.view') IS DISTINCT FROM 'company'
    OR has_function_privilege('authenticated','app_private.hermes_w2_reused_keys_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_w2_contracts_view_reused_check_failed'; END IF;
END $check$;
COMMIT;
