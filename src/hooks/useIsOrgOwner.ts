// =============================================================================
// useIsOrgOwner — mirror của vị ngữ CHỦ TỔ CHỨC mà server dùng cho các đặc quyền
// của chủ (Slice −1 · §−1.6/B3).
//
// VÌ SAO PHẢI CÓ HOOK RIÊNG. Các cổng chủ ở SQL đều viết
// `public.is_super_admin() OR app_private.is_org_owner_v1(org, auth.uid())`
// (vd `pay_period_fee` với `p_force` = "Đóng thêm", `reverse_invoice_collection_v5`).
// Giao diện thì lấy cờ từ `useIsAdmin() || useIsSuperAdmin()`, nhưng
// `public.is_admin()` trên prod hôm nay CHỈ CÒN `SELECT public.is_super_admin()`
// (đo bằng pg_get_functiondef 30/07/2026 — bản cũ "Admin ở BẤT KỲ tenant" đã bị
// thu hồi vì bypass xuyên tenant). Hệ quả: cờ UI ≡ super admin, nên CHỦ TỔ CHỨC
// THẬT không phải super admin (org DEMO có 2 người như vậy) bị ẩn mất chính đặc
// quyền của mình và nhận thông báo "phải nhờ chủ tổ chức" — tức nhờ chính mình.
//
// Đây là cờ HIỂN THỊ, không phải hàng rào: server vẫn siết theo ĐÚNG org của toà
// và trả `[FIXED_FEE_FORCE_DENIED]` bằng tiếng Việt nếu sai. RPC không nhận org
// (xem COMMENT của hàm SQL) — nó trả true khi người dùng là chủ ở ít nhất một
// org, đủ để quyết định "có mời bấm hay không".
//
// PHẠM VI SAU RÀ VÒNG 2: hook này chỉ còn là phỏng đoán TRƯỚC khi gọi RPC. Với
// riêng "Đóng thêm", chính `pay_period_fee` đã trả khoá `can_force` trong payload
// cảnh báo trùng — đúng vị ngữ của cổng chặn, đúng org của toà — và
// usePeriodFeeState ưu tiên khoá đó. Nhờ vậy ca lệch duy nhất còn lại của hook
// (chủ org A bấm trên toà org B) không còn dẫn tới lời mời sai: server nói "không"
// ngay trong bước cảnh báo trùng, trước khi hộp thoại kịp mở.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const AUTHORIZATION_REFRESH_INTERVAL = 60_000;

/** true ⇔ đang đăng nhập và có vai trò system_key='TENANT_OWNER' ở ≥1 tổ chức. */
export const useIsOrgOwner = () =>
  useQuery({
    queryKey: ['auth', 'is_org_owner_self'],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await (supabase as any).rpc('is_org_owner_self_v1');
      if (error) {
        // Fail-closed: không đọc được thì coi như KHÔNG phải chủ. Server vẫn là
        // hàng rào thật, nên đoán "có" chỉ để mời bấm một nút sẽ bị từ chối.
        console.error('useIsOrgOwner error:', error);
        return false;
      }
      return !!data;
    },
    staleTime: AUTHORIZATION_REFRESH_INTERVAL,
    refetchInterval: AUTHORIZATION_REFRESH_INTERVAL,
    refetchOnWindowFocus: 'always',
    retry: 1,
  });
