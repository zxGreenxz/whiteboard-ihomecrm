// =============================================================================
// useLandlordPortal — link tên miền cho chủ nhà (PIN) và phần quản trị gộp toà / người xem.
//
// Như useLandlordSettlement: lỗi THROW để màn báo, gói đi qua zod (src/lib/landlordPortal.ts). Server là hàng rào
// thật — chống dò PIN, phiên hết hạn / bị thu hồi ⇒ landlord_portal_v1 trả NULL.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { confirmReceiptSchema } from '@/lib/landlordSettlement';
import {
  portalLoginSchema,
  portalPayloadSchema,
  portalSaveReceiptSchema,
  portalsSchema,
  portalUnlockReceiptSchema,
  portalViewerAddReceiptSchema,
  portalViewerRevokeReceiptSchema,
} from '@/lib/landlordPortal';

type LoiRpc = { code?: string; message: string; details?: string | null; hint?: string | null };

/**
 * Ranh giới kiểu cho RPC chưa có trong `types.ts` sinh tự động (migration 20261024072823 chưa lên production lúc
 * viết). Sau gen:types đổi sang `supabase.rpc('<tên>', …)` có kiểu. Tên RPC vẫn viết thẳng tại nơi gọi.
 */
const goiRpc = (tenHam: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: LoiRpc | null }> =>
  (supabase.rpc as unknown as (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: LoiRpc | null }>)(
    tenHam, args);

const KEY = 'landlord-portal';
export const landlordPortalKeys = {
  all: [KEY] as const,
  page: (slug: string, session: string | null, building: string | null, month: string | null) =>
    [KEY, 'page', slug, session, building, month] as const,
  admin: () => [KEY, 'admin'] as const,
};

// ─────────────────────────────── link tên miền (anon) ───────────────────────────────

export const useLandlordPortalLogin = () =>
  useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { slug: string; pin: string }) => {
      const { data, error } = await goiRpc('landlord_portal_login_v1', { p_slug: input.slug, p_pin: input.pin });
      if (error) throw error;
      return portalLoginSchema.parse(data);
    },
  });

/** Trang của link: NULL = phiên không còn hiệu lực (trang xoá phiên, hỏi lại PIN). */
export const useLandlordPortal = (slug: string, session: string | null, building: string | null, month: string | null) =>
  useQuery({
    queryKey: landlordPortalKeys.page(slug, session, building, month),
    enabled: !!session,
    // giữ số đang xem khi đổi toà / tháng — nhưng KHÔNG mang số của phiên khác (thoát rồi vào PIN người khác)
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[3] === session ? prev : undefined),
    queryFn: async () => {
      const { data, error } = await goiRpc('landlord_portal_v1', {
        p_slug: slug, p_session: session, p_building: building, p_month: month,
      });
      if (error) throw error;
      return data == null ? null : portalPayloadSchema.parse(data);
    },
  });

export interface PortalConfirmInput {
  slug: string;
  session: string;
  building: string;
  /** 'YYYY-MM-01' */
  month: string;
  revision: number;
  note: string | null;
}

/** Xác nhận đã xem số liệu — server ghi người xem của phiên. */
export const useConfirmLandlordPortalMonth = () => {
  const qc = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: PortalConfirmInput) => {
      const { data, error } = await goiRpc('landlord_portal_confirm_v1', {
        p_slug: input.slug, p_session: input.session, p_building: input.building,
        p_month: input.month, p_revision: input.revision, p_note: input.note,
      });
      if (error) throw error;
      return confirmReceiptSchema.parse(data);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: landlordPortalKeys.all }),
  });
};

export const useLandlordPortalLogout = () =>
  useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { slug: string; session: string }) => {
      const { error } = await goiRpc('landlord_portal_logout_v1', { p_slug: input.slug, p_session: input.session });
      if (error) throw error;
    },
  });

// ─────────────────────────────── quản trị ───────────────────────────────

export const useLandlordPortals = (enabled = true) =>
  useQuery({
    queryKey: landlordPortalKeys.admin(),
    enabled,
    queryFn: async () => {
      const { data, error } = await goiRpc('landlord_portals_v1', {});
      if (error) throw error;
      return portalsSchema.parse(data);
    },
  });

const useInvalidateAdmin = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: landlordPortalKeys.admin() });
};

export const useSaveLandlordPortal = () => {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { slug: string; buildingIds: string[] }) => {
      const { data, error } = await goiRpc('landlord_portal_save_v1', { p_slug: input.slug, p_building_ids: input.buildingIds });
      if (error) throw error;
      return portalSaveReceiptSchema.parse(data);
    },
    onSettled: () => invalidate(),
  });
};

export const useAddLandlordPortalViewer = () => {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: { handlesFeedback: true },
    // PIN luôn do server sinh (PIN tự chọn quá dễ dò) — trả về đúng một lần
    mutationFn: async (input: { slug: string; label: string }) => {
      const { data, error } = await goiRpc('landlord_portal_viewer_add_v1', { p_slug: input.slug, p_label: input.label });
      if (error) throw error;
      return portalViewerAddReceiptSchema.parse(data);
    },
    onSettled: () => invalidate(),
  });
};

/** Mở khoá link bị khoá vì nhập PIN sai nhiều lần. */
export const useUnlockLandlordPortal = () => {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { slug: string }) => {
      const { data, error } = await goiRpc('landlord_portal_unlock_v1', { p_slug: input.slug });
      if (error) throw error;
      return portalUnlockReceiptSchema.parse(data);
    },
    onSettled: () => invalidate(),
  });
};

export const useRevokeLandlordPortalViewer = () => {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: async (input: { viewerId: string }) => {
      const { data, error } = await goiRpc('landlord_portal_viewer_revoke_v1', { p_viewer_id: input.viewerId });
      if (error) throw error;
      return portalViewerRevokeReceiptSchema.parse(data);
    },
    onSettled: () => invalidate(),
  });
};
