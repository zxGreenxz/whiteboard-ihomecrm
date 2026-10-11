-- Thu quyền gọi ba hàm SECURITY DEFINER không kiểm người gọi và không còn đường gọi nào trong app.
--
-- 1. public.monthly_building_profit(date, date, uuid) — thu của PUBLIC, anon, authenticated.
--    Khi người gọi không thuộc toà nào, chuỗi tìm "chủ" rơi về super admin đầu tiên. Đo 11/10/2026 trên
--    TEST (ACL giống production): POST /rest/v1/rpc/monthly_building_profit chỉ với publishable key (có sẵn
--    trong bundle web) trả HTTP 200, 17 toà kèm total_income/total_expense/net_profit. Người đăng nhập
--    không có toà (kể cả tài khoản demo.*) cũng mượn được quyền đó. App đã chuyển sang
--    fa_monthly_pnl_accrual (useShareholderProfit); production không có hàm/view nào khác gọi tới.
-- 2. public.approve_meter_reading(uuid), public.bulk_approve_meter_readings(uuid[]) — thu của authenticated
--    (anon đã thu ở 20260902082002). Thân hàm UPDATE meter_readings sang APPROVED theo id, không kiểm
--    quyền/toà/công ty. App dùng approve_meter_reading_v1/bulk_approve_meter_readings_v1
--    (useMeterReadings.noLegacyFallback.test.ts khoá không quay lại bản cũ).
--
-- service_role giữ EXECUTE. Không đổi thân hàm, không ghi dữ liệu.

REVOKE EXECUTE ON FUNCTION public.monthly_building_profit(date, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_meter_reading(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bulk_approve_meter_readings(uuid[]) FROM PUBLIC, anon, authenticated;

DO $assert$
DECLARE
  v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.monthly_building_profit(date, date, uuid)'::regprocedure,
    'public.approve_meter_reading(uuid)'::regprocedure,
    'public.bulk_approve_meter_readings(uuid[])'::regprocedure
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% vẫn EXECUTE được bởi anon/authenticated', v_fn;
    END IF;
  END LOOP;
END
$assert$;

NOTIFY pgrst, 'reload schema';
