-- =====================================================================
-- VÁ BẢO MẬT (04/07): mọi VIEW public phải chạy quyền NGƯỜI GỌI
-- (security_invoker = true) — view mặc định chạy quyền OWNER (postgres)
-- nên BYPASS RLS bảng gốc: tài khoản demo công khai của trang docs đọc
-- được dữ liệu tenant thật qua view (sổ quỹ + số dư, 741 chỉ số điện
-- nước, 299 đồng hồ, tính toán thanh lý…).
--
-- 2 nguồn:
--  - accounts_with_balance: recreate ở 20260704100000 (M1 is_virtual) làm
--    RỚT cờ security_invoker=true mà 20260514000051 đã set (pg_get_viewdef
--    không chứa reloptions) — đã ALTER nóng ngay khi phát hiện; ghi lại đây.
--  - 5 view còn lại chưa từng set cờ từ khi tạo (lỗ hổng có sẵn).
--
-- BÀI HỌC CHO MIGRATION SAU: recreate view = viewdef + GRANT + **reloptions**;
-- luôn `ALTER VIEW ... SET (security_invoker = true)` sau CREATE.
-- =====================================================================

ALTER VIEW public.accounts_with_balance       SET (security_invoker = true);
ALTER VIEW public.building_coverage           SET (security_invoker = true);
ALTER VIEW public.contract_extension_history  SET (security_invoker = true);
ALTER VIEW public.meters_with_latest_reading  SET (security_invoker = true);
ALTER VIEW public.v_termination_calculation   SET (security_invoker = true);

-- meter_readings_detailed join auth.users (email người ghi/duyệt) — bật
-- invoker là "permission denied for table users" với mọi user thường.
-- Đổi 2 join sang public.profiles (giữ NGUYÊN tên cột approver_email/
-- recorder_email) rồi mới bật invoker.
CREATE OR REPLACE VIEW public.meter_readings_detailed AS
SELECT mr.id,
    mr.user_id,
    mr.reading_code,
    mr.meter_id,
    m.code AS meter_code,
    m.name AS meter_name,
    mr.contract_id,
    mr.service_id,
    s.name AS service_name,
    mr.building_id,
    b.name AS building_name,
    mr.room_id,
    r.name AS room_name,
    mr.meter_type,
    mr.settlement_month,
    mr.reading_date,
    mr.previous_reading,
    mr.current_reading,
    mr.consumption,
    mr.status,
    mr.approved_by,
    (approver.email)::character varying(255) AS approver_email,
    mr.approved_at,
    mr.recorded_by,
    (recorder.email)::character varying(255) AS recorder_email,
    mr.notes,
    mr.meter_image_url,
    mr.created_at,
    mr.updated_at
   FROM meter_readings mr
     LEFT JOIN meters m ON m.id = mr.meter_id
     LEFT JOIN buildings b ON b.id = mr.building_id
     LEFT JOIN rooms r ON r.id = mr.room_id
     LEFT JOIN services s ON s.id = mr.service_id
     LEFT JOIN public.profiles approver ON approver.id = mr.approved_by
     LEFT JOIN public.profiles recorder ON recorder.id = mr.recorded_by
  WHERE mr.deleted_at IS NULL
  ORDER BY mr.reading_date DESC, mr.created_at DESC;

ALTER VIEW public.meter_readings_detailed SET (security_invoker = true);
GRANT SELECT ON public.meter_readings_detailed TO authenticated, service_role;
