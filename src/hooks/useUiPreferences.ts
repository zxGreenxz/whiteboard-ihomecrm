// =============================================================================
// useUiPreferences — tuỳ chọn hiển thị UI theo từng user, LƯU TRÊN SERVER.
// Lưu ở cột profiles.ui_preferences (jsonb) → GIỮ qua F5 và đồng bộ đa thiết bị.
// Mỗi key là một tuỳ chọn nhỏ (vd 'pd_hideStatCards'). Ghi merge từng key để
// không đè các key khác. Cập nhật lạc quan (optimistic) cho phản hồi tức thì.
// =============================================================================
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUserId } from '@/lib/authSession';

export type UiPreferences = Record<string, unknown>;

const QK = ['ui-preferences'] as const;

// `ui_preferences` chưa có trong types generated → đọc/ghi qua client nới lỏng kiểu.
const db = supabase as any;

/** Đọc toàn bộ tuỳ chọn UI của user hiện tại (rỗng nếu chưa đăng nhập). */
export const useUiPreferences = () =>
  useQuery({
    queryKey: QK,
    queryFn: async (): Promise<UiPreferences> => {
      const userId = await getSessionUserId();
      if (!userId) return {};
      const { data, error } = await db
        .from('profiles')
        .select('ui_preferences')
        .eq('id', userId)
        .single();
      if (error) throw error;
      return (data?.ui_preferences as UiPreferences) ?? {};
    },
    staleTime: 5 * 60 * 1000,
  });

/** Lấy 1 tuỳ chọn boolean kèm mặc định. */
export const useUiPrefBool = (key: string, fallback = false): boolean => {
  const { data } = useUiPreferences();
  const v = data?.[key];
  return typeof v === 'boolean' ? v : fallback;
};

/** Ghi 1 key tuỳ chọn (merge), lưu server + optimistic. */
export const useSetUiPreference = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
      const userId = await getSessionUserId();
      if (!userId) throw new Error('Not authenticated');
      // Đọc bản hiện tại rồi merge để không đè key khác (jsonb ghi cả object).
      const { data: cur } = await db
        .from('profiles')
        .select('ui_preferences')
        .eq('id', userId)
        .single();
      const next: UiPreferences = { ...((cur?.ui_preferences as UiPreferences) ?? {}), [key]: value };
      const { error } = await db
        .from('profiles')
        .update({ ui_preferences: next })
        .eq('id', userId);
      if (error) throw error;
      return next;
    },
    onMutate: async ({ key, value }) => {
      await qc.cancelQueries({ queryKey: QK });
      const prev = qc.getQueryData<UiPreferences>(QK);
      qc.setQueryData<UiPreferences>(QK, (o) => ({ ...(o ?? {}), [key]: value }));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(QK, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: QK });
    },
  });
};
