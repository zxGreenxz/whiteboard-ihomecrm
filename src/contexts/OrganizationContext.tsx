import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';

/**
 * Khái niệm "tổ chức hiện tại" cho frontend — GĐ9 của kế hoạch tách dữ liệu.
 *
 * VÌ SAO CẦN, khi RLS đã chặn ở tầng database rồi:
 *   Cô lập dữ liệu KHÔNG phải việc của context này — 302 bảng đã có biên giới
 *   RESTRICTIVE, frontend có hỏi bậy cũng không lấy được dữ liệu tổ chức khác.
 *   Thứ context này giải quyết là hai việc khác:
 *     1. NGƯỜI DÙNG BIẾT MÌNH ĐANG Ở ĐÂU. Hôm nay chỉ một tổ chức nên đó là
 *        thẩm mỹ; ngày có công ty thứ hai thì không biết mình đang xem sổ của ai
 *        là lỗi nghiệp vụ nghiêm trọng.
 *     2. ĐƯỜNG GHI CÓ CHỖ LẤY organization_id. Đo 09/08/2026: 105 bảng nhận
 *        được NULL (nullable, không DEFAULT, không trigger), và nhánh
 *        `organization_id IS NULL` của công thức biên giới nghĩa là AI CŨNG
 *        THẤY. Một lệnh insert quên cột đó không hỏng ngay — nó tạo ra dòng lộ
 *        cho mọi tổ chức, im lặng.
 *
 * VÌ SAO ĐI QUA RPC CHỨ KHÔNG ĐỌC THẲNG BẢNG:
 *   Đo bằng vai người dùng thường trong BEGIN…ROLLBACK trên production:
 *     SELECT count(*) FROM organization_memberships → 0
 *     SELECT count(*) FROM organizations            → 0
 *     my_org_ids()                                  → aaaa…  ✓
 *   RLS của hai bảng đó không cho người dùng thường đọc, kể cả dòng của chính
 *   mình. Gọi thẳng sẽ nhận mảng rỗng và hiển thị "không thuộc tổ chức nào" cho
 *   MỌI người — sai mà không có lỗi nào nổ ra. `get_my_organizations()` là hàm
 *   SECURITY DEFINER dựng ở 20260809030000, lọc theo auth.uid() ngay trong thân
 *   và không nhận tham số.
 */
export interface Organization {
  id: string;
  name: string;
  slug: string | null;
  memberType: string | null;
}

export interface OrganizationState {
  /** Tổ chức đang xem. `null` khi chưa nạp xong HOẶC người dùng không thuộc tổ chức nào. */
  organization: Organization | null;
  /**
   * ID tổ chức ĐANG CHỌN, hoặc `null` khi chưa chốt được.
   *
   * Đây là thứ mọi đường đọc/ghi có phạm vi tổ chức phải dùng. `null` KHÔNG có
   * nghĩa "dùng mặc định" — nó có nghĩa là chưa chốt, và bên gọi phải từ chối
   * chạy. Xem `resolveSelectedOrganizationId`.
   */
  selectedOrganizationId: string | null;
  /** Chọn tổ chức. ID không nằm trong danh bạ hiện tại sẽ bị bỏ qua. */
  selectOrganization: (id: string) => void;
  /** Mọi tổ chức người dùng có membership ACTIVE. */
  organizations: Organization[];
  /** Có nhiều hơn một tổ chức — nơi duy nhất đáng hiện bộ chuyển đổi. */
  isMultiOrg: boolean;
  isLoading: boolean;
  /**
   * Đã nạp xong VÀ không thuộc tổ chức nào. Tách khỏi `organization === null`
   * vì hai trạng thái đó cần hiển thị khác nhau: đang nạp thì chờ, không thuộc
   * tổ chức nào thì phải báo cho người dùng biết chứ không để màn trắng.
   */
  isOrphan: boolean;
  /**
   * Đã nạp xong, có NHIỀU tổ chức, nhưng chưa ai chọn. Giao diện phải hỏi.
   *
   * Tách khỏi `isOrphan` vì cách xử lý ngược nhau: mồ côi thì không có gì để
   * chọn, còn đây là có nhiều thứ để chọn mà chưa chọn.
   */
  canChonToChuc: boolean;
}

const KHOA_LUU = 'ihomecrm.selectedOrganizationId';

/**
 * Tổ chức nào đang được chọn, từ danh bạ và lựa chọn đã lưu.
 *
 * Luật, theo đúng thứ tự:
 *   1. Đúng MỘT tổ chức ⇒ chọn luôn. Bắt người dùng bấm để xác nhận thứ duy nhất
 *      họ có là nghi thức rỗng.
 *   2. Lựa chọn đã lưu còn nằm trong danh bạ ⇒ giữ.
 *   3. Mọi trường hợp khác ⇒ `null`.
 *
 * Điều (3) là chỗ khác hẳn hành vi cũ (`organizations[0]`). Người bị gỡ khỏi
 * công ty B mà lựa chọn còn trỏ vào B sẽ nhận `null` chứ KHÔNG âm thầm rơi về
 * công ty A — vì rơi âm thầm nghĩa là họ tiếp tục làm việc trên sổ của một công
 * ty khác mà không có gì báo.
 */
export function resolveSelectedOrganizationId(
  organizations: Organization[],
  persistedId: string | null,
): string | null {
  if (organizations.length === 0) return null;
  if (organizations.length === 1) return organizations[0].id;
  if (persistedId && organizations.some((o) => o.id === persistedId)) return persistedId;
  return null;
}

const OrganizationContext = createContext<OrganizationState | null>(null);

/** Tách riêng và export để test được mà không phải dựng cả cây React. */
export function parseOrganizations(payload: unknown): Organization[] {
  const raw = (payload as { organizations?: unknown } | null)?.organizations;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const o = item as Record<string, unknown>;
    // Bỏ qua dòng thiếu id/name thay vì render `undefined` lên giao diện.
    if (typeof o?.id !== 'string' || typeof o?.name !== 'string') return [];
    return [{
      id: o.id,
      name: o.name,
      slug: typeof o.slug === 'string' ? o.slug : null,
      memberType: typeof o.member_type === 'string' ? o.member_type : null,
    }];
  });
}

export function useOrganization(): OrganizationState {
  const ctx = useContext(OrganizationContext);
  if (!ctx) {
    throw new Error('useOrganization phải nằm trong <OrganizationProvider>.');
  }
  return ctx;
}

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ['my-organizations'],
    queryFn: async (): Promise<Organization[]> => {
      const user = await getSessionUser();
      if (!user) return [];
      const { data: rpc, error } = await supabase.rpc('get_my_organizations');
      if (error) throw error;
      return parseOrganizations(rpc);
    },
    // Membership đổi rất hiếm; hỏi lại mỗi 5 phút là đủ. Cùng mốc với
    // useMyContext để hai nguồn không lệch nhau giữa chừng.
    staleTime: 5 * 60 * 1000,
  });

  // Chỉ lưu ID, không lưu cả bản ghi tổ chức: một bản chép trong localStorage sẽ
  // cũ đi (đổi tên, bị gỡ quyền) mà không có gì làm nó mới lại, và giao diện sẽ
  // hiện tên cũ của một công ty người dùng không còn vào được.
  const [luuId, datLuuId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KHOA_LUU);
    } catch {
      return null; // Safari chế độ riêng tư ném ở đây; mất lựa chọn còn hơn vỡ app.
    }
  });

  const organizations = useMemo(() => data ?? [], [data]);
  const selectedOrganizationId = resolveSelectedOrganizationId(organizations, luuId);

  // Lựa chọn đã lưu không còn hợp lệ thì DỌN, đừng để rác trỏ vào công ty cũ.
  useEffect(() => {
    if (isLoading) return;
    if (luuId && !organizations.some((o) => o.id === luuId)) {
      try {
        localStorage.removeItem(KHOA_LUU);
      } catch { /* xem chú thích khởi tạo */ }
      datLuuId(null);
    }
  }, [isLoading, luuId, organizations]);

  const selectOrganization = useCallback(
    (id: string) => {
      // Bỏ qua ID ngoài danh bạ: nhận bừa sẽ tạo ra một lựa chọn không tương ứng
      // với thứ gì, và `resolveSelectedOrganizationId` chỉ việc trả null sau đó.
      if (!organizations.some((o) => o.id === id)) return;
      try {
        localStorage.setItem(KHOA_LUU, id);
      } catch { /* xem chú thích khởi tạo */ }
      datLuuId(id);
    },
    [organizations],
  );

  const value = useMemo<OrganizationState>(() => {
    return {
      organizations,
      organization: organizations.find((o) => o.id === selectedOrganizationId) ?? null,
      selectedOrganizationId,
      selectOrganization,
      isMultiOrg: organizations.length > 1,
      isLoading,
      isOrphan: !isLoading && organizations.length === 0,
      canChonToChuc: !isLoading && organizations.length > 1 && selectedOrganizationId === null,
    };
  }, [organizations, selectedOrganizationId, selectOrganization, isLoading]);

  return (
    <OrganizationContext.Provider value={value}>
      {children}
    </OrganizationContext.Provider>
  );
}
