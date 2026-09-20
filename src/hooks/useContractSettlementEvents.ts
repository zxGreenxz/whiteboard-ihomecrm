import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { readSettlementEvents, settlementEventQueryKey, type SettlementEventScope } from '@/lib/contractSettlementEventReader';
import { readSettlementEventPage } from '@/lib/contractSettlementEventRepository';

export const settlementEventDependencies = ['contracts', 'contract_extensions', 'contract_terminations', 'contract_transfers',
  'rooms', 'buildings', 'contract_customers', 'customers', 'income_expenses', 'income_expense_items', 'income_expense_types',
  'contract_deposit_links', 'reservation_deposit_settlements', 'reservation_settlement_vouchers', 'organization_memberships'] as const;

export function useContractSettlementEvents(scope: SettlementEventScope, enabled = true) {
  const client = useQueryClient();
  const active = enabled && !!scope.actorId && !!scope.organizationId && scope.buildingIds.length > 0;
  const query = useQuery({ queryKey: settlementEventQueryKey(scope), enabled: active,
    queryFn: ({ signal }) => readSettlementEvents(scope, readSettlementEventPage, signal),
    staleTime: 0, refetchInterval: 30_000, refetchOnWindowFocus: 'always', retry: false });
  useEffect(() => {
    if (!active) return;
    const channel = supabase.channel(`settlement-events:${scope.organizationId}:${scope.actorId}`);
    for (const table of settlementEventDependencies) channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
      void client.invalidateQueries({ queryKey: ['contract-settlement-events', scope.organizationId, scope.actorId] });
    });
    channel.subscribe(); return () => { void supabase.removeChannel(channel); };
  }, [active, scope.organizationId, scope.actorId, client]);
  const code = query.isError ? 'EVENT_READ_FAILED' : query.data?.error;
  const error = code ? code === 'EVENT_READ_DENIED' ? 'Bạn không có quyền xem biến động trong phạm vi này.'
    : code === 'EVENT_CHANGED_RELOAD' ? 'Hồ sơ vừa thay đổi. Vui lòng tải lại để xem đủ biến động.'
      : 'Chưa đọc đủ biến động. Vui lòng tải lại.' : null;
  return { rows: active ? query.data?.rows ?? [] : [], complete: active && !query.isError && query.data?.complete === true,
    loading: active && query.isPending, fetching: active && query.isFetching, error, asOf: query.data?.asOf ?? null,
    refresh: async () => { const result = await query.refetch(); if (result.error || !result.data?.complete) throw Error('Chưa tải lại đủ biến động. Vui lòng thử lại.'); } };
}
