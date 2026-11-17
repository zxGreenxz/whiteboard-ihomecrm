// Bộ lọc nhà của bảng "LN được chia Nhà × Tháng" — lưu THEO TÀI KHOẢN trên máy chủ (bảng public.settings,
// khoá `buildingFilterSettingKey`: công ty + cổ đông). Chủ yêu cầu 17/11/2026: bộ lọc tạo ra phải còn khi mở
// lại, theo từng người dùng — kể cả trình duyệt khác, máy khác, cửa sổ ẩn danh.
// Bản trên trình duyệt (localStorage) chỉ là BỘ ĐỆM: mở màn có ngay bộ lọc lần trước, và vẫn dùng được trong
// phiên khi máy chủ chưa đọc / ghi được (báo rõ, có "Thử lại"). Tài khoản chưa có bản trên máy chủ mà trình
// duyệt còn bộ lọc tạo trước thay đổi này ⇒ đẩy lên máy chủ một lần.

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useAuth } from '@/hooks/useAuth';
import { requireAccountWriteReceipt } from '@/lib/accountSettingsWriteReceipt';
import { withOrg } from '@/lib/orgPayload';
import {
  buildingFilterSettingKey, buildingFilterStorageKey, emptyBuildingFilterState, parseBuildingFilterState,
  parseBuildingFilterValue, sameBuildingFilterState, type BuildingFilterState,
} from '@/lib/profitLedger/buildingFilters';

export type BuildingFilterSync = 'loading' | 'saving' | 'saved' | 'error';

export interface BuildingFilterStore {
  state: BuildingFilterState;
  update: (next: BuildingFilterState) => void;
  sync: BuildingFilterSync;
  /** Câu báo khi chưa đọc / chưa lưu được lên tài khoản; null = ổn. */
  syncError: string | null;
  retry: () => void;
}

export const BUILDING_FILTER_READ_ERROR = 'Chưa đọc được bộ lọc đã lưu trên tài khoản — đang dùng bộ lọc trên trình duyệt này.';
export const BUILDING_FILTER_SAVE_ERROR = 'Chưa lưu được bộ lọc lên tài khoản — bộ lọc vẫn dùng được trên trình duyệt này.';

function readCache(cacheKey: string): BuildingFilterState {
  try {
    return parseBuildingFilterState(window.localStorage.getItem(cacheKey));
  } catch {
    return emptyBuildingFilterState();
  }
}

function writeCache(cacheKey: string, state: BuildingFilterState): void {
  try {
    window.localStorage.setItem(cacheKey, JSON.stringify(state));
  } catch {
    // Trình duyệt chặn lưu (riêng tư / hết chỗ): bản trên tài khoản vẫn là bản chính.
  }
}

interface Versions {
  key: string;
  /** Tăng mỗi lần người dùng đổi bộ lọc trên máy này. */
  local: number;
  /** Phiên bản mới nhất đã khớp với máy chủ (đã lưu xong hoặc vừa nạp từ máy chủ). */
  saved: number;
  migrated: boolean;
}

export function useBuildingFilterState(organizationId: string, shareholderId: string): BuildingFilterStore {
  const cacheKey = buildingFilterStorageKey(organizationId, shareholderId);
  const settingKey = buildingFilterSettingKey(organizationId, shareholderId);
  const { data: user } = useAuth();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();

  const [entry, setEntry] = useState(() => ({ cacheKey, state: readCache(cacheKey) }));
  const versions = useRef<Versions>({ key: settingKey, local: 0, saved: 0, migrated: false });
  if (versions.current.key !== settingKey) versions.current = { key: settingKey, local: 0, saved: 0, migrated: false };

  useEffect(() => {
    setEntry((previous) => (previous.cacheKey === cacheKey ? previous : { cacheKey, state: readCache(cacheKey) }));
    // Tab khác của cùng trình duyệt vừa đổi bộ lọc của cùng khoá ⇒ nạp lại bộ đệm.
    const onStorage = (event: StorageEvent) => {
      if (event.key === cacheKey) setEntry({ cacheKey, state: readCache(cacheKey) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [cacheKey]);

  const server = useQuery({
    queryKey: ['settings', settingKey, userId],
    enabled: userId !== null,
    staleTime: 5 * 60_000,
    // null = tài khoản chưa có bộ lọc nào trên máy chủ.
    queryFn: async (): Promise<BuildingFilterState | null> => {
      const { data, error } = await supabase
        .from('settings')
        .select('value')
        .eq('user_id', userId ?? '')
        .eq('key', settingKey)
        .maybeSingle();
      if (error) throw error;
      return data ? parseBuildingFilterValue(data.value) : null;
    },
  });

  const save = useMutation({
    // Ghi tuần tự theo khoá: bấm liên tiếp không để bản cũ ghi đè bản mới trên máy chủ.
    scope: { id: `settings:${settingKey}` },
    mutationFn: async ({ next }: { next: BuildingFilterState; version: number; key: string; owner: string }) => {
      if (!userId) throw new Error('Chưa đăng nhập');
      const { data, error } = await supabase
        .from('settings')
        .upsert(withOrg({ user_id: userId, key: settingKey, value: next as unknown as Json }, organizationId), { onConflict: 'user_id,key' })
        .select()
        .single();
      if (error) throw error;
      requireAccountWriteReceipt(data, { user_id: userId, key: settingKey, value: next });
      return next;
    },
    onSuccess: (next, { version, key, owner }) => {
      if (versions.current.key !== key || version < versions.current.local) return; // đã có thay đổi mới hơn đang chờ lưu
      versions.current.saved = version;
      queryClient.setQueryData(['settings', key, owner], next);
    },
  });

  const persist = (next: BuildingFilterState) => {
    if (!userId) return;
    versions.current.local += 1;
    save.mutate({ next, version: versions.current.local, key: settingKey, owner: userId });
  };

  // Nạp bản trên máy chủ khi KHÔNG còn thay đổi nào của máy này chưa lên máy chủ (không đè thứ người dùng vừa đổi).
  useEffect(() => {
    if (!server.isSuccess) return;
    const v = versions.current;
    if (v.key !== settingKey || v.local !== v.saved) return;
    const fromServer = server.data;
    if (fromServer === null) {
      const local = readCache(cacheKey);
      if (!v.migrated && local.presets.length > 0) {
        v.migrated = true;
        persist(local);
      }
      return;
    }
    setEntry((previous) => (previous.cacheKey === cacheKey && sameBuildingFilterState(previous.state, fromServer)
      ? previous
      : { cacheKey, state: fromServer }));
    writeCache(cacheKey, fromServer);
    // persist đổi mỗi lần render nhưng chỉ đọc khoá / người dùng hiện hành — không cần là phụ thuộc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.isSuccess, server.data, server.dataUpdatedAt, cacheKey, settingKey]);

  const update = (next: BuildingFilterState) => {
    setEntry({ cacheKey, state: next });
    writeCache(cacheKey, next);
    persist(next);
  };

  const pendingLocal = versions.current.local !== versions.current.saved;
  const saveFailed = save.isError && pendingLocal;
  const sync: BuildingFilterSync = save.isPending ? 'saving'
    : saveFailed || server.isError ? 'error'
      : userId !== null && server.isPending ? 'loading'
        : 'saved';
  const syncError = saveFailed ? BUILDING_FILTER_SAVE_ERROR : server.isError ? BUILDING_FILTER_READ_ERROR : null;
  const state = entry.cacheKey === cacheKey ? entry.state : emptyBuildingFilterState();
  const retry = () => {
    if (saveFailed) persist(state);
    else if (server.isError) void server.refetch();
  };

  // Đổi công ty / cổ đông mà effect chưa kịp chạy: không bày bộ lọc của khoá cũ.
  return { state, update, sync, syncError, retry };
}
