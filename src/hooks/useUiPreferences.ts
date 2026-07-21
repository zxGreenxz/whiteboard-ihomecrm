// =============================================================================
// useUiPreferences — tuỳ chọn hiển thị UI theo từng user, LƯU TRÊN SERVER.
// Lưu ở cột profiles.ui_preferences (jsonb) → GIỮ qua F5 và đồng bộ đa thiết bị.
// Mỗi key là một tuỳ chọn nhỏ (vd 'pd_hideStatCards'). Ghi merge từng key để
// không đè các key khác. Cập nhật lạc quan (optimistic) cho phản hồi tức thì.
// =============================================================================
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { getSessionUserId } from '@/lib/authSession';

export type UiPreferences = Record<string, unknown>;

const QK = ['ui-preferences'] as const;
const MUTATION_KEY = ['set-ui-preference'] as const;
const optimisticOwners = new WeakMap<QueryClient, Map<string, symbol>>();

function getOptimisticOwners(queryClient: QueryClient): Map<string, symbol> {
  const current = optimisticOwners.get(queryClient);
  if (current) return current;
  const created = new Map<string, symbol>();
  optimisticOwners.set(queryClient, created);
  return created;
}

/** Đọc toàn bộ tuỳ chọn UI của user hiện tại (rỗng nếu chưa đăng nhập). */
export const useUiPreferences = () =>
  useQuery({
    queryKey: QK,
    queryFn: async (): Promise<UiPreferences> => {
      const userId = await getSessionUserId();
      if (!userId) return {};
      const { data, error } = await supabase
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

/** Ghi atomic 1 key qua RPC để hai thiết bị không ghi đè các preference khác. */
export const useSetUiPreference = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
      const { data, error } = await supabase.rpc('set_my_ui_preference', {
        p_key: key,
        p_value: value as Json,
      });
      if (error) throw error;
      return (data as UiPreferences) ?? {};
    },
    onMutate: async ({ key, value }) => {
      await qc.cancelQueries({ queryKey: QK });
      const previous = qc.getQueryData<UiPreferences>(QK);
      const hadPrevious = Object.prototype.hasOwnProperty.call(previous ?? {}, key);
      const optimisticOwner = Symbol(key);
      getOptimisticOwners(qc).set(key, optimisticOwner);
      let optimisticPreferences: UiPreferences | undefined;
      qc.setQueryData<UiPreferences>(QK, (current) => {
        optimisticPreferences = { ...(current ?? {}), [key]: value };
        return optimisticPreferences;
      });
      return {
        key,
        previousValue: previous?.[key],
        hadPrevious,
        optimisticValue: value,
        optimisticOwner,
        optimisticPreferences,
      };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      const owners = getOptimisticOwners(qc);
      if (owners.get(context.key) !== context.optimisticOwner) return;
      qc.setQueryData<UiPreferences>(QK, (current) => {
        if (!current) return current;
        const stillOwnsKey = current === context.optimisticPreferences
          || Object.is(current[context.key], context.optimisticValue);
        if (!stillOwnsKey) return current;

        const next = { ...current };
        if (context.hadPrevious) next[context.key] = context.previousValue;
        else delete next[context.key];
        return next;
      });
      owners.delete(context.key);
    },
    onSuccess: (preferences, { key }, context) => {
      qc.setQueryData<UiPreferences>(QK, (current) => ({
        ...preferences,
        ...(current ?? {}),
      }));
      const owners = getOptimisticOwners(qc);
      if (context && owners.get(key) === context.optimisticOwner) owners.delete(key);
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: MUTATION_KEY }) === 1) {
        return qc.invalidateQueries({ queryKey: QK });
      }
    },
  });
};
