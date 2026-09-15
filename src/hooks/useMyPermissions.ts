import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';

/**
 * Permissions của caller hiện tại TRONG CÔNG TY ĐANG CHỌN, dạng
 * `{ moduleKey: { actionKey: { org_wide, building_ids, cashbook_ids } } }`.
 *
 * - Owner & super admin: backend trả sentinel `__superadmin: true` → mọi quyền true.
 * - Staff: backend trả PHẠM VI HIỆU LỰC của từng khoá trong đúng công ty đó.
 *
 * Dùng RPC `get_my_permissions_v2(p_org)` (SECURITY DEFINER) vì RLS của
 * staff_assignments chỉ cho owner đọc — staff sẽ nhận `[]` nếu query trực
 * tiếp bảng và mất hết quyền UI.
 *
 * FE dùng helper `canUse(perms, moduleKey, actionKey, buildingId?)` trong
 * `@/lib/permissionPages` để gate các nút. Hàng rào THẬT nằm ở máy chủ
 * (`authorize_tenant_action_v3` + RLS); hook này chỉ quyết định hiện hay ẩn.
 *
 * VÌ SAO CACHE KEY PHẢI KÈM CÔNG TY
 *   Bản cũ dùng khoá `['my-permissions']` trống trơn và RPC không có tham số
 *   công ty, nên (a) chủ nhiều công ty nhận HỢP của mọi tập quyền — quyền chỉ
 *   có ở DEMO lại mở nút trên sổ THẬT, và (b) đổi công ty trên thanh chọn
 *   không làm quyền nạp lại vì khoá không đổi.
 */
export type PermissionScopeValue = {
  org_wide: boolean;
  building_ids: string[];
  cashbook_ids?: string[];
};

export type PermissionsMap = Record<string, Record<string, boolean | PermissionScopeValue>> & {
  __superadmin?: boolean;
};

/**
 * Hàm chưa tồn tại trên máy chủ. PostgREST trả PGRST202 khi không phân giải
 * được lời gọi; 42883 là mã Postgres tương ứng nếu lọt xuống tới engine.
 */
const thieuHam = (error: { code?: string | null } | null | undefined): boolean =>
  error?.code === 'PGRST202' || error?.code === '42883';

const docMap = (data: unknown): PermissionsMap => {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as PermissionsMap;
  return {};
};

/**
 * `types.ts` sinh từ catalog LIVE, mà migration 20260915143713 chưa được apply
 * (Contract §3: session con không apply, chủ apply sau khi rà). Khai chữ ký ở
 * đây theo đúng nếp nhà — `invoiceRoundingReportRepository.ts`,
 * `financeV2Route.ts`, `useDeposits.ts` — chứ KHÔNG `as any`: tên hàm và tên
 * tham số vẫn bị tsc kiểm, chỉ phần kết quả để `unknown` rồi tự đọc.
 *
 * GỠ khối này ngay khi `npm run gen:types` chạy lại sau lúc apply.
 */
type QuyenV2Rpc = (
  name: 'get_my_permissions_v2',
  args: { p_org: string },
) => PromiseLike<{ data: unknown; error: { code?: string | null } | null }>;

export const useMyPermissions = () => {
  const { selectedOrganizationId, isLoading: dangTaiCongTy } = useOrganization();

  const q = useQuery<PermissionsMap>({
    queryKey: ['my-permissions', selectedOrganizationId],
    staleTime: 5 * 60 * 1000,
    // Chưa chốt công ty thì KHÔNG hỏi. Trả `{}` lúc này là nói dối "đã biết
    // rồi, bạn không có quyền gì", và route guard sẽ đá người dùng về `/`.
    enabled: !!selectedOrganizationId,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as unknown as QuyenV2Rpc)(
        'get_my_permissions_v2',
        { p_org: selectedOrganizationId as string },
      );

      // Client và migration KHÔNG lên cùng một lúc (Contract §3: migration
      // apply riêng, có backup). Nếu bản client này lên trước thì mọi người
      // dùng mất sạch quyền giao diện — sự cố toàn hệ thống, đắt hơn nhiều so
      // với việc sống thêm một đợt bằng quyền không có phạm vi.
      if (thieuHam(error)) {
        const cu = await supabase.rpc('get_my_permissions');
        if (cu.error || !cu.data) return {};
        return docMap(cu.data);
      }

      if (error || !data) return {};
      return docMap(data);
    },
  });

  // Danh bạ công ty còn đang nạp = CHƯA BIẾT, không phải "không có quyền".
  // `enabled: false` làm react-query báo `isLoading === false`, nên phải nói
  // rõ ở đây; nếu không route guard đá người dùng ra ngay khung hình đầu.
  return { ...q, isLoading: q.isLoading || dangTaiCongTy };
};

/** Helper gate UI: trả true khi user được phép `actionKey` trên `moduleKey`. */
export const can = (
  perms: PermissionsMap | undefined,
  moduleKey: string,
  actionKey: string,
): boolean => {
  if (!perms) return false;
  if (perms.__superadmin === true) return true;
  const raw = perms[moduleKey]?.[actionKey];
  if (typeof raw === 'boolean') return raw;
  if (raw && typeof raw === 'object') {
    return (
      raw.org_wide === true ||
      (Array.isArray(raw.building_ids) && raw.building_ids.length > 0) ||
      (Array.isArray(raw.cashbook_ids) && raw.cashbook_ids.length > 0)
    );
  }
  return false;
};
