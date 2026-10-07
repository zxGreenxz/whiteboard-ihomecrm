-- Huỷ (xoá) đăng ký tạm trú trên Cổng DVC Bộ Công an, đi chung đường với đăng ký.
--
-- VÌ SAO: khách trả phòng thì chủ phải nộp thủ tục "Xóa đăng ký tạm trú" (mã TAMTRU_06,
-- trường hợp "Cả hộ do không còn chỗ ở hợp pháp") kèm hai giấy: tờ khai CT01 ghi
-- "Hủy tạm trú tại …" và biên bản thanh lý hợp đồng thuê. Hai ảnh đó cần chỗ lưu cạnh
-- ảnh hồ sơ đăng ký, và mã hồ sơ xoá cần vào cùng sổ nhưng phân biệt được với mã đăng ký.
--
-- 1. residence_dossier_files nhận thêm hai loại ảnh theo khách: CT01_XOA, THANH_LY.
--    Quyền ghi giữ nguyên hàm residence_dossier_can_write_v1 (mọi loại không phải
--    OWNERSHIP đều theo customers.print trên toà) nên không đổi policy nào.
-- 2. residence_registrations thêm procedure_code = mã thủ tục trên cổng: TAMTRU_01 đăng
--    ký (mặc định — mọi dòng cũ đều là đăng ký), TAMTRU_06 xoá đăng ký.
--
-- Chỉ nới ràng buộc và thêm cột có mặc định; không xoá hay đổi dữ liệu nào. Idempotent.
ALTER TABLE public.residence_dossier_files DROP CONSTRAINT IF EXISTS residence_dossier_files_kind_check;
ALTER TABLE public.residence_dossier_files ADD CONSTRAINT residence_dossier_files_kind_check
  CHECK (kind IN ('CT01', 'LEASE', 'OWNERSHIP', 'CT01_XOA', 'THANH_LY'));

ALTER TABLE public.residence_dossier_files DROP CONSTRAINT IF EXISTS residence_dossier_files_kind_target;
ALTER TABLE public.residence_dossier_files ADD CONSTRAINT residence_dossier_files_kind_target CHECK (
  (kind = 'OWNERSHIP' AND customer_id IS NULL)
  OR (kind IN ('CT01', 'LEASE', 'CT01_XOA', 'THANH_LY') AND customer_id IS NOT NULL));

ALTER TABLE public.residence_registrations
  ADD COLUMN IF NOT EXISTS procedure_code text NOT NULL DEFAULT 'TAMTRU_01';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'residence_registrations_procedure_code_chk') THEN
    ALTER TABLE public.residence_registrations
      ADD CONSTRAINT residence_registrations_procedure_code_chk
      CHECK (procedure_code IN ('TAMTRU_01', 'TAMTRU_06'));
  END IF;
END $$;

COMMENT ON COLUMN public.residence_registrations.procedure_code IS
  'Mã thủ tục trên Cổng DVC: TAMTRU_01 = Đăng ký tạm trú, TAMTRU_06 = Xóa đăng ký tạm trú.';
COMMENT ON COLUMN public.residence_dossier_files.kind IS
  'CT01/LEASE = ảnh tờ khai và hợp đồng ở nhờ đã ký khi đăng ký; OWNERSHIP = giấy chỗ ở hợp pháp của toà; CT01_XOA/THANH_LY = tờ khai CT01 huỷ và biên bản thanh lý đã ký khi xoá đăng ký.';
