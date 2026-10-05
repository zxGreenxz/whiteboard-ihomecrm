import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { companySessionToken, readLocalCompany, syncActiveCompany } from '@/lib/companyPreference';
import type { CompanyPreferenceSession, PreferenceResult } from '@/lib/companyPreferenceRemote';
import { OrganizationContext, parseOrganizations, resetOrgScopedQueries, resolveSelectedOrganizationId, type Organization, type OrganizationState } from './OrganizationContext';

export default function OrganizationProviderImplementation({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: user, isLoading: authLoading, isError: authError } = useAuth();
  const { data, isLoading: directoryLoading, isSuccess, isError: directoryError, refetch } = useQuery({
    queryKey: ['my-organizations', user?.id ?? null],
    enabled: !!user,
    queryFn: async (): Promise<Organization[]> => {
      const token = await companySessionToken(user!.id);
      const { data: rpc, error } = await supabase.rpc('list_my_copilot_organizations_v1').setHeader('Authorization', `Bearer ${token}`);
      if (error) throw error;
      return parseOrganizations(rpc);
    },
    // Membership đổi rất hiếm; hỏi lại mỗi 5 phút là đủ. Cùng mốc với
    // useMyContext để hai nguồn không lệch nhau giữa chừng.
    staleTime: 5 * 60 * 1000,
  });
  const userId = user?.id ?? null;
  const identity = useRef(userId);
  identity.current = userId;
  const controller = useRef<CompanyPreferenceSession | null>(null);
  const [retryModule, setRetryModule] = useState(0);
  const [preference, setPreference] = useState<PreferenceResult>({ owner: null, id: null, loaded: false, error: null, pending: false });
  const organizations = useMemo(() => data ?? [], [data]);
  const current = preference.owner === userId ? preference : null;
  const isLoading = authLoading || (!!userId && (directoryLoading || !current?.loaded));
  const isError = authError || directoryError;
  const selectedOrganizationId = userId && isSuccess && current?.loaded
    ? resolveSelectedOrganizationId(organizations, current.id) : null;
  const choNapLai = useRef<Set<string> | null>(null);
  const scopeBeforeLoad = useRef<string | null>(null);
  const selectedScope = useRef(selectedOrganizationId);
  selectedScope.current = selectedOrganizationId;
  const directory = useRef(organizations);
  directory.current = organizations;

  // Synchronous auth fence: never await Supabase inside this callback.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const next = session?.user.id ?? null;
      if (identity.current !== next) {
        identity.current = next;
        controller.current?.dispose();
        syncActiveCompany(null, null);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    controller.current = null;
    if (!userId) { syncActiveCompany(null, null); return; }
    readLocalCompany(userId); // Migrate legacy ownership before the active-scope effect clears it.
    void import('@/lib/companyPreferenceRemote').then((remote) => {
      if (cancelled || identity.current !== userId) return;
      const session = new remote.CompanyPreferenceSession(userId, {
        isCurrent: () => !cancelled && identity.current === userId,
        apply: (next) => {
          if (!next.loaded) scopeBeforeLoad.current = selectedScope.current;
          if (next.loaded) {
            const previousScope = selectedScope.current ?? scopeBeforeLoad.current;
            const nextScope = resolveSelectedOrganizationId(directory.current, next.id);
            if (previousScope && previousScope !== nextScope) choNapLai.current = resetOrgScopedQueries(queryClient);
          }
          setPreference(next);
        },
      });
      controller.current = session;
      return session.load();
    }).catch(() => {
      if (!cancelled && identity.current === userId) setPreference({ owner: userId, id: null, loaded: true, pending: false, error: 'Chưa tải được lựa chọn công ty đã lưu. Thử lại để đồng bộ.' });
    });
    return () => { cancelled = true; controller.current?.dispose(); };
  }, [userId, queryClient, retryModule]);

  useEffect(() => {
    syncActiveCompany(userId, selectedOrganizationId);
    if (selectedOrganizationId) controller.current?.ensure(selectedOrganizationId);
  }, [userId, selectedOrganizationId, current?.loaded, current?.error, current?.id, current?.pending]);

  const refetchOrganizations = useCallback(async () => {
    if (controller.current) controller.current.retry(selectedOrganizationId);
    else setRetryModule(value => value + 1);
    await refetch();
  }, [selectedOrganizationId, refetch]);

  const selectOrganization = useCallback((id: string) => {
    if (!userId || identity.current !== userId || !isSuccess || !organizations.some((o) => o.id === id)) return;
    if (id === selectedOrganizationId) {
      if (current?.error) controller.current?.select(id);
      return;
    }
    choNapLai.current = resetOrgScopedQueries(queryClient);
    syncActiveCompany(userId, id);
    controller.current?.select(id);
  }, [userId, organizations, isSuccess, selectedOrganizationId, current?.error, queryClient]);

  // Nạp lại SAU commit chứ không ngay trong selectOrganization: effect của màn con
  // chạy trước effect này và đã gắn queryFn mới vào observer, nên lượt nạp đọc
  // công ty mới. Nạp ngay lúc dọn thì queryFn còn giữ công ty cũ và ghi dữ liệu
  // công ty A vào đúng khoá vừa dọn.
  useEffect(() => {
    const hashes = choNapLai.current;
    if (!hashes) return;
    choNapLai.current = null;
    if (hashes.size === 0) return;
    void queryClient.refetchQueries({
      type: 'active',
      predicate: (query) => hashes.has(query.queryHash),
    });
  }, [queryClient, selectedOrganizationId]);

  const value = useMemo<OrganizationState>(() => {
    return {
      organizations,
      organization: organizations.find((o) => o.id === selectedOrganizationId) ?? null,
      selectedOrganizationId,
      selectOrganization,
      isMultiOrg: organizations.length > 1,
      isLoading,
      isError,
      refetchOrganizations,
      preferenceError: current?.error ?? null,
      isOrphan: !isLoading && isSuccess && organizations.length === 0,
      canChonToChuc: !isLoading && organizations.length > 1 && selectedOrganizationId === null,
    };
  }, [organizations, selectedOrganizationId, selectOrganization, isLoading, isError, refetchOrganizations, isSuccess, current?.error]);

  return (
    <OrganizationContext.Provider value={value}>
      {children}
    </OrganizationContext.Provider>
  );
}
