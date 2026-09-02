-- Seed cờ rollout `disabled` cho MỌI trang canonical của Copilot, cộng một cờ
-- riêng cho điều hướng.
--
-- LỖ ĐANG VÁ
--   Bảng `copilot_feature_flags` mới có đúng 3 dòng scope `page`
--   (`20260828170000`: rooms.list, customers.list, invoices.list). Nhưng phạm
--   vi Copilot đã sinh từ `COPILOT_PAGE_CONTRACTS` và hôm nay là 19 đích
--   canonical. `set_copilot_feature_flag_v2` chỉ UPDATE dòng CÓ SẴN — không có
--   dòng thì nó ném `unknown_rollout_contract`. Nghĩa là 16 trang kia KHÔNG
--   BAO GIỜ bật được bằng đường vận hành, và cái thiếu đó không có triệu chứng
--   nào: trang admin vẫn hiện, tool vẫn "tắt", không log gì. Công tắc phải tồn
--   tại trước thì mới có chuyện bật hay không bật.
--
--   `copilot.navigation` là cờ MỚI, tách khỏi rollout từng trang: `mo_trang`
--   chỉ điều hướng (UI-control) hoặc trả link markdown (chat), nó không đọc dữ
--   liệu và không bấm gì. Trước lát này nó gác bằng ĐÚNG BỘ khoá của ba trang
--   pilot UI-control, nên tắt rollout của riêng trang Hoá đơn là mất luôn khả
--   năng dẫn đường tới 18 trang không liên quan.
--
-- KHÔNG BẬT GÌ Ở ĐÂY. Mọi dòng seed `disabled`; canary DEMO do người vận hành
-- bật qua `set_copilot_feature_flag_v2` (CAS revision + reason/evidence/
-- rollback + hạn dùng), để bằng chứng nằm trong sổ audit chứ không nằm trong
-- một migration.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- Trigger `copilot_feature_flags_bump_revision` (bản v2, `20260829030000`) TỪ
-- CHỐI mọi INSERT/UPDATE không mang dấu transaction này — đó là thứ ép mọi
-- thay đổi lúc chạy phải đi qua RPC có CAS. Seed trong migration là con đường
-- hợp lệ duy nhất còn lại, nên nó phải tự khai dấu.
SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

-- ON CONFLICT DO NOTHING: 3 dòng cũ giữ NGUYÊN trạng thái đang có trên
-- production. Seed đè lại thành 'disabled' sẽ là một lần tắt rollout không ai
-- yêu cầu, và nó sẽ đi vào sổ audit dưới tên "migration".
INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
SELECT
  v.scope,
  v.contract_id,
  v.state,
  'seed rollout deny-by-default cho moi trang canonical + dieu huong',
  'migration:20260902185838_copilot_rollout_seed_pages_v1',
  'migration:20260902185838_copilot_rollout_seed_pages_v1'
FROM (VALUES
  ('page', 'rooms.list'          , 'disabled'),  -- Căn hộ / Phòng
  ('page', 'invoices.list'       , 'disabled'),  -- Hoá đơn
  ('page', 'customers.list'      , 'disabled'),  -- Cư dân
  ('page', 'buildings.list'      , 'disabled'),  -- Toà nhà & Khu vực
  ('page', 'services.list'       , 'disabled'),  -- Dịch vụ
  ('page', 'assets.list'         , 'disabled'),  -- Tài sản
  ('page', 'materials.list'      , 'disabled'),  -- Vật tư
  ('page', 'vehicles.list'       , 'disabled'),  -- Phương tiện
  ('page', 'leads.list'          , 'disabled'),  -- Khách hẹn
  ('page', 'deposits.list'       , 'disabled'),  -- Đặt cọc
  ('page', 'contracts.list'      , 'disabled'),  -- Hợp đồng
  ('page', 'income-expenses.list', 'disabled'),  -- Thu chi
  ('page', 'cashbooks.list'      , 'disabled'),  -- Sổ quỹ
  ('page', 'reports.finance'     , 'disabled'),  -- Báo cáo tài chính
  ('page', 'reports.real-estate' , 'disabled'),  -- Báo cáo BĐS
  ('page', 'meter-readings.list' , 'disabled'),  -- Ghi chỉ số
  ('page', 'thu-tien.list'       , 'disabled'),  -- Thu tiền (mobile)
  ('page', 'chat-zalo.list'      , 'disabled'),  -- Chat Zalo
  ('page', 'tasks.list'          , 'disabled'),  -- Công việc
  ('page', 'copilot.navigation'  , 'disabled')  -- Điều hướng của Copilot (mở trang)
) AS v(scope, contract_id, state)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- Nghiệm thu CHỈ SOI CATALOG cờ: đếm dòng của chính bảng vừa seed, không đụng
-- tới dữ liệu nghiệp vụ nào và không tham chiếu khoá ngoại nào. Chạy được trên
-- DB rỗng vì bảng do `20260828170000` tạo ra trong cùng lane forward.
DO $ktra$
DECLARE
  v_thieu text[];
  v_so_dong integer;
BEGIN
  SELECT array_agg(k ORDER BY k)
  INTO v_thieu
  FROM unnest(ARRAY[
    'rooms.list',
    'invoices.list',
    'customers.list',
    'buildings.list',
    'services.list',
    'assets.list',
    'materials.list',
    'vehicles.list',
    'leads.list',
    'deposits.list',
    'contracts.list',
    'income-expenses.list',
    'cashbooks.list',
    'reports.finance',
    'reports.real-estate',
    'meter-readings.list',
    'thu-tien.list',
    'chat-zalo.list',
    'tasks.list',
    'copilot.navigation'
  ]) AS k
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.copilot_feature_flags f
    WHERE f.scope = 'page' AND f.contract_id = k
  );
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_contract: %', array_to_string(v_thieu, ', ');
  END IF;

  SELECT count(*) INTO v_so_dong
  FROM public.copilot_feature_flags
  WHERE scope = 'page';
  IF v_so_dong < 20 THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_dong: % < 20', v_so_dong;
  END IF;
END
$ktra$;

COMMIT;
