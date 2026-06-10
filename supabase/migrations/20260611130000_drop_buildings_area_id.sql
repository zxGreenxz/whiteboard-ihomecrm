-- =============================================================
-- Drop buildings.area_id — hoàn tất chuyển sang mô hình N-N
--
-- Tiền đề (đã apply trước file này):
--   • 20260611100000: area_buildings + backfill từ cột này
--   • 20260611110000: helper/policy không còn đọc b.area_id
--   • 20260611120000: RPC stats + public rooms đã viết lại
-- Apply CÙNG đợt deploy FE đã bỏ đọc/ghi buildings.area_id.
-- =============================================================

BEGIN;

DROP INDEX IF EXISTS public.idx_buildings_area_id;
ALTER TABLE public.buildings DROP COLUMN IF EXISTS area_id;

COMMIT;

NOTIFY pgrst, 'reload schema';
