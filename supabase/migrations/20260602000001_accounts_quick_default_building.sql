-- Thêm cột "tòa nhà mặc định khi tạo phiếu nhanh" cho sổ quỹ.
-- Phục vụ dialog Tạo phiếu nhanh: khi chọn tòa nhà, tự chọn sổ quỹ tương ứng.
-- ON DELETE SET NULL để xoá tòa nhà không làm vỡ accounts.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS quick_default_building_id uuid
    REFERENCES public.buildings(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.accounts.quick_default_building_id IS
  'Tòa nhà mặc định để tự chọn sổ quỹ này trong dialog Tạo phiếu nhanh';

-- Index nhẹ để reverse-lookup (building -> account) nhanh.
CREATE INDEX IF NOT EXISTS idx_accounts_quick_default_building
  ON public.accounts (quick_default_building_id)
  WHERE quick_default_building_id IS NOT NULL;
