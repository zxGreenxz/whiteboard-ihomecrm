-- =====================================================================
-- FIX: _termination_pick_account chọn SAI sổ quỹ khi thanh lý.
--
-- Bản cũ: ORDER BY (a.name = building.name), is_default, created_at LIMIT 1.
-- Nếu owner KHÔNG có account trùng tên toà và KHÔNG có sổ is_default → rơi vào
-- account tạo đầu tiên, thường là sổ ẢO "Chung" (is_virtual, dùng cho chia LN cổ
-- đông) → cọc/hoàn cọc dồn nhầm vào "Chung" (âm nặng), trong khi sổ thật của toà
-- (buildings.default_account_id_tt = nơi thu tiền thuê) không phản ánh.
--
-- FIX: ưu tiên sổ quỹ ĐÃ CẤU HÌNH cho toà — default_account_id_tt (tiền mặt) rồi
-- default_account_id_tk (ngân hàng); chỉ khi toà chưa cấu hình mới fallback theo
-- tên/khác, và LOẠI các sổ kỹ thuật ("Cấn trừ thanh lý (nội bộ)", "Làm tròn tiền
-- thiếu") khỏi fallback. Áp dụng cho mọi RPC thanh lý (forfeit + move-out).
-- =====================================================================

CREATE OR REPLACE FUNCTION public._termination_pick_account(
  p_user_id     uuid,
  p_building_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- 1) Sổ tiền mặt cấu hình cho toà (nơi thu tiền thuê).
    (SELECT b.default_account_id_tt FROM buildings b
      WHERE b.id = p_building_id AND b.default_account_id_tt IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tt AND a.deleted_at IS NULL)),
    -- 2) Sổ ngân hàng cấu hình cho toà.
    (SELECT b.default_account_id_tk FROM buildings b
      WHERE b.id = p_building_id AND b.default_account_id_tk IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tk AND a.deleted_at IS NULL)),
    -- 3) Fallback: trùng tên toà → is_default → tạo sớm nhất; né sổ kỹ thuật.
    (SELECT a.id
       FROM accounts a, (SELECT name FROM buildings WHERE id = p_building_id) bld
      WHERE a.user_id = p_user_id
        AND a.deleted_at IS NULL
        AND a.name NOT IN ('Cấn trừ thanh lý (nội bộ)', 'Làm tròn tiền thiếu')
      ORDER BY (a.name = bld.name) DESC, a.is_default DESC NULLS LAST, a.created_at
      LIMIT 1)
  );
$$;

NOTIFY pgrst, 'reload schema';
