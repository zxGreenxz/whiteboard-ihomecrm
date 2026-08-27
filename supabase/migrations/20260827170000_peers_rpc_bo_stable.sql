-- =====================================================================
-- `profit_total_group_peers_v2` phải VOLATILE, không được STABLE.
--
-- TRIỆU CHỨNG (đo trên trình duyệt thật 27/08/2026, tài khoản chủ công ty):
--   POST /rest/v1/rpc/profit_total_group_peers_v2 → HTTP 405, và khi gọi qua
--   supabase-js thì lộ nguyên nhân: SQLSTATE 25006
--   "cannot execute SELECT FOR SHARE in a read-only transaction".
--
-- NGUYÊN NHÂN: PostgREST mở transaction READ ONLY cho hàm khai IMMUTABLE/STABLE
-- — kể cả khi client gửi POST. Mọi RPC của Profit Close đều đi qua
-- `_profit_assert_authorized_v2`, mà hàm đó khoá `organizations` và
-- `organization_memberships` bằng `SELECT ... FOR SHARE` (chặn tổ chức bị vô
-- hiệu hoá hay tư cách thành viên bị gỡ ngay giữa lời gọi). FOR SHARE là ghi
-- khoá, nên transaction chỉ-đọc từ chối.
--
-- Đây không phải chuyện mới: `profit_close_state_v2` viết `STABLE` trong file
-- gốc nhưng bản ĐANG CHẠY là VOLATILE — đã có người vấp đúng chỗ này rồi sửa,
-- chỉ là bài học không được viết lại thành luật nên nó tái diễn.
--
-- LUẬT rút ra: RPC nào gọi `_profit_assert_authorized_v2` thì KHÔNG được khai
-- IMMUTABLE/STABLE. `profit_close_scopes_v2` giữ được STABLE vì nó liệt kê tổ
-- chức chứ không đi qua hàm assert đó.
--
-- Không dùng `ALTER FUNCTION ... VOLATILE` mà CREATE OR REPLACE nguyên thân:
-- lịch sử ở repo này đọc bằng "lần CREATE cuối cùng", nên một ALTER lẻ sẽ làm
-- định nghĩa sống nói dối về chính nó.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.profit_total_group_peers_v2(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, 'shareholder_profit.view'
  );

  WITH rule_buildings AS (
    SELECT
      s.id AS rule_id,
      COALESCE(NULLIF(btrim(s.label), ''), m.name) AS rule_label,
      rb.building_id,
      b.name AS building_name
    FROM public.profit_manager_salaries s
    JOIN public.profit_managers m
      ON m.id = s.manager_id
     AND m.organization_id = p_organization_id
     AND m.is_active
     AND m.deleted_at IS NULL
    JOIN public.profit_manager_salary_buildings rb
      ON rb.salary_id = s.id
     AND rb.organization_id = p_organization_id
    JOIN public.buildings b
      ON b.id = rb.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.is_virtual = false
    WHERE s.organization_id = p_organization_id
      AND s.is_active
      AND s.basis = 'TOTAL_GROUP'
  ),
  pairs AS (
    SELECT DISTINCT
      me.building_id,
      peer.building_id AS peer_id,
      peer.building_name AS peer_name,
      me.rule_label
    FROM rule_buildings me
    JOIN rule_buildings peer ON peer.rule_id = me.rule_id
  ),
  grouped AS (
    SELECT
      building_id,
      jsonb_agg(DISTINCT peer_id) AS peer_ids,
      string_agg(DISTINCT peer_name, ', ') AS peer_names,
      string_agg(DISTINCT rule_label, ', ') AS rule_labels
    FROM pairs
    GROUP BY building_id
  )
  SELECT COALESCE(
    jsonb_object_agg(
      building_id::text,
      jsonb_build_object(
        'peer_ids', peer_ids,
        'peer_names', peer_names,
        'rule_labels', rule_labels
      )
    ),
    '{}'::jsonb
  )
  INTO v_result
  FROM grouped;

  RETURN COALESCE(v_result, '{}'::jsonb);
END
$fn$;

REVOKE ALL ON FUNCTION public.profit_total_group_peers_v2(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profit_total_group_peers_v2(uuid)
  TO authenticated;
COMMENT ON FUNCTION public.profit_total_group_peers_v2(uuid) IS
  'Ban do nha -> cac nha phai chot cung vi dung chung quy tac luong dieu hanh TOTAL_GROUP. Chi de giao dien mo rong vung chon; KHONG nam trong tai lieu nguon nen khong dung toi building_source_hash. PHAI VOLATILE: _profit_assert_authorized_v2 dung SELECT FOR SHARE, ma PostgREST chay ham STABLE trong transaction chi-doc.';

COMMIT;

NOTIFY pgrst, 'reload schema';
