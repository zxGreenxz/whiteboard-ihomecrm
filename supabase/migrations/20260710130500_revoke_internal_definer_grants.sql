-- =============================================================
-- Phase 1 (bổ sung): thu hồi quyền gọi TRỰC TIẾP với các hàm SECURITY DEFINER
-- nội bộ đang lỡ mở cho anon/authenticated. Các hàm này chỉ được gọi bên trong
-- một hàm cha SECURITY DEFINER (chạy dưới owner) hoặc bởi cron (service_role),
-- nên REVOKE không phá luồng hợp lệ, mà chặn được việc client tự gọi với
-- p_user_id tuỳ ý (ghi dữ liệu vào tenant khác).
--
--   generate_recurring_vouchers(uuid)  : FE dùng _v2; v1 do cron gọi.
--                                        Anon/auth gọi trực tiếp = sinh phiếu
--                                        recurring cho user_id bất kỳ.
--   seed_commission_expense_types(uuid): chỉ gọi trong RPC tạo phiếu hoa hồng
--                                        (SECURITY DEFINER). Anon/auth gọi =
--                                        chèn loại chi vào tenant bất kỳ.
--   is_user_super_admin(uuid)          : helper đọc; không cần anon.
--   v5_building_reqs / v5_checklist_for_building: đọc config+phòng, v5 FLAGS
--                                        OFF; không cần anon.
--
-- Idempotent.
-- =============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.generate_recurring_vouchers(uuid)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.seed_commission_expense_types(uuid)
  FROM PUBLIC, anon, authenticated;

-- get_income_expense_history giờ là SECURITY INVOKER (RLS đã chặn anon vì policy
-- audit_log chỉ TO authenticated) nhưng vẫn revoke PUBLIC cho sạch (anon kế thừa
-- PUBLIC nên REVOKE FROM anon ở migration trước chưa đủ).
REVOKE ALL ON FUNCTION public.get_income_expense_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_income_expense_history(uuid) TO authenticated;

-- Các hàm dưới đây được GRANT cho PUBLIC (anon kế thừa qua PUBLIC), nên phải
-- REVOKE khỏi PUBLIC rồi GRANT lại authenticated thì mới chặn được anon.
REVOKE ALL ON FUNCTION public.is_user_super_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_user_super_admin(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.v5_building_reqs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_building_reqs(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.v5_checklist_for_building(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v5_checklist_for_building(uuid, date, text) TO authenticated;

COMMIT;

-- =============================================================
-- ROLLBACK:
-- GRANT EXECUTE ON FUNCTION public.generate_recurring_vouchers(uuid) TO authenticated, anon;
-- GRANT EXECUTE ON FUNCTION public.seed_commission_expense_types(uuid) TO authenticated, anon;
-- GRANT EXECUTE ON FUNCTION public.is_user_super_admin(uuid) TO anon;
-- GRANT EXECUTE ON FUNCTION public.v5_building_reqs(uuid) TO anon;
-- GRANT EXECUTE ON FUNCTION public.v5_checklist_for_building(uuid, date, text) TO anon;
-- =============================================================
