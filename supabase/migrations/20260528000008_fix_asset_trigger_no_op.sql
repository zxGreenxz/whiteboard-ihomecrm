-- =============================================
-- Fix trigger update_asset_status_on_contract_change
-- =============================================
-- Lỗi: invalid input value for enum asset_condition: "AVAILABLE"
-- Nguyên nhân: trigger viết lại ở migration 20260528000006 dùng giá trị
-- 'AVAILABLE' / 'IN_USE' cho cột assets.condition, nhưng enum asset_condition
-- chỉ có (NEW, GOOD, FAIR, POOR, BROKEN) — không liên quan đến trạng thái thuê.
--
-- assets không có cột status/state thực sự, nên trigger này không nên update
-- gì cả khi contract thay đổi. Convert thành no-op để không lỗi nữa.
-- =============================================

CREATE OR REPLACE FUNCTION public.update_asset_status_on_contract_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- assets không có status field — trigger này không cần làm gì.
  -- Giữ trigger để không phải drop trigger DDL trên contracts (tránh churn).
  RETURN NEW;
END;
$function$;
