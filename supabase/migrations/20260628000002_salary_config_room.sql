-- =============================================
-- Bảng lương: gán phòng nhân viên ở → lấy hoá đơn phòng đó làm "Tiền phòng"
-- (công ty cho nhân viên ở 1 phòng giá ưu đãi; tiền phòng = total_amount của
--  hoá đơn phòng đó theo billing_month, trừ vào lương).
-- =============================================
BEGIN;

ALTER TABLE public.manager_salary_config
  ADD COLUMN IF NOT EXISTS room_id UUID REFERENCES public.rooms(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.manager_salary_config.room_id IS
  'Phòng nhân viên ở (giá ưu đãi). Nếu set: tiền phòng = hoá đơn phòng đó theo tháng; nếu tháng chưa có hoá đơn → dùng default_room_rent.';

COMMIT;
NOTIFY pgrst, 'reload schema';
