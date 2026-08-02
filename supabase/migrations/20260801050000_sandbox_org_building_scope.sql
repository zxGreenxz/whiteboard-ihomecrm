-- ============================================================================
-- Bịt đường rò org sandbox qua can_access_building() (RPC SECURITY DEFINER)
-- ============================================================================
-- ĐO ĐƯỢC: sau khi có org TEST, RPC fa_occupancy_monthly trả về 432 dòng thay vì
-- 228 — thừa đúng 12 toà của org TEST — khi gọi bằng JWT của chủ tài khoản thật.
--
-- NGUYÊN NHÂN: policy RLS *_hide_sandbox_admin không cứu được các hàm
-- SECURITY DEFINER (chúng bỏ qua RLS). Các báo cáo đó lọc toà bằng
-- public.can_access_building(), mà hàm này có nhánh tắt `is_super_admin() OR …`
-- ⇒ super admin đi qua MỌI toà của MỌI org, kể cả org sandbox.
--
-- app_private.buildings_for_v3() và app_private.can_v3() đã lọc org đúng
-- (`organization_id = any(my_org_ids())`), nên chỉ nhánh super admin bị hở.
--
-- CÁCH SỬA: toà thuộc org sandbox chỉ hiện với người THỰC SỰ có membership ở org
-- đó. Sửa đúng 1 hàm này là bịt cả họ báo cáo dựng trên nó (tỷ lệ lấp đầy,
-- doanh thu theo toà, hiệu quả kinh doanh…).
--
-- STABLE là đúng: hàm chỉ đọc, không lấy khoá dòng — hợp lệ với PostgREST GET.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.can_access_building(_building_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $$
  SELECT NOT EXISTS (
           SELECT 1
           FROM public.buildings b
           WHERE b.id = _building_id
             AND COALESCE(b.organization_id = ANY (public.sandbox_org_ids()), false)
             AND NOT COALESCE(b.organization_id = ANY (public.my_org_ids()), false)
         )
     AND (public.is_super_admin() OR app_private.can_v3('buildings.view', _building_id));
$$;

COMMENT ON FUNCTION public.can_access_building(uuid) IS
  'Quyền xem một toà. Chặn sẵn org sandbox (xem public.sandbox_org_ids()) đối với '
  'người không có membership ở org đó — nếu không, super admin sẽ kéo dữ liệu công ty '
  'TEST vào mọi báo cáo SECURITY DEFINER (RLS không với tới các hàm đó).';
