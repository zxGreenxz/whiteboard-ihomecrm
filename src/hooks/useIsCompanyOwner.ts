// =============================================================================
// useIsCompanyOwner — cờ hiển thị "chủ công ty", KHÁC useIsOrgOwner.
//
// VÌ SAO KHÔNG DÙNG LẠI useIsOrgOwner. Hook kia gọi `is_org_owner_self_v1`, mà
// hàm đó neo `app_private.is_org_owner_v1` → chỉ khớp vai có
// `system_key = 'TENANT_OWNER'` (hoặc tên "Chủ sở hữu tổ chức"). Vai **"Chủ công
// ty"** dựng ở migration 20260811030000 cố ý là vai TỰ TẠO, `system_key = NULL`,
// nên nó KHÔNG khớp — đo trên prod 27/08/2026 với tài khoản `nguyentam`:
// `is_org_owner_v1` trả **false** cho chính chủ doanh nghiệp.
//
// Hệ quả nếu dùng nhầm hook: chủ công ty mở phiếu bỏ cọc đã duyệt thì form khoá
// read-only, không thấy công tắc KQKD, và không hiểu vì sao.
//
// Hook này gọi `is_company_owner_self_v1` — wrapper mirror ĐÚNG vị ngữ mà
// `set_forfeit_voucher_kqkd_v1` dùng ở server, để nút bấm và writer không lệch.
// Vẫn là cờ HIỂN THỊ: nó không nhận org nên trả true khi người dùng là chủ ở ít
// nhất một tổ chức. Hàng rào thật nằm ở RPC và kiểm theo đúng org của phiếu.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const AUTHORIZATION_REFRESH_INTERVAL = 60_000;

/** true ⇔ đang đăng nhập và là chủ công ty ở ≥1 tổ chức. */
export const useIsCompanyOwner = () =>
  useQuery({
    queryKey: ['auth', 'is_company_owner_self'],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc('is_company_owner_self_v1');
      if (error) {
        // Fail-closed: không đọc được thì coi như KHÔNG phải chủ. Server vẫn là
        // hàng rào thật, nên đoán "có" chỉ để mời bấm một nút sẽ bị từ chối.
        console.error('useIsCompanyOwner error:', error);
        return false;
      }
      return !!data;
    },
    staleTime: AUTHORIZATION_REFRESH_INTERVAL,
    refetchInterval: AUTHORIZATION_REFRESH_INTERVAL,
    refetchOnWindowFocus: 'always',
    retry: 1,
  });
