import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useRoomCashLifecycle } from '@/hooks/useRoomCashLifecycle';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/contexts/OrganizationContext';
import { readSettlementFinancialContext, settlementFinancialQueryKey, type SettlementFinancialTarget } from '@/hooks/useContractSettlementFinancialFacts';
import { selectSettlementChronology } from '@/lib/contractSettlementTimeline';
import type { SettlementBusinessEvent } from '@/lib/contractSettlementEventReader';
import type { SettlementFinancialScope } from '@/lib/contractSettlementFinancialContext';
import { ContractSettlementTimelineView } from './ContractSettlementTimelineView';
import { settlementTimelineLane } from './settlementTimelinePresentation';

interface Props {
  target: SettlementFinancialTarget & { contractId: string; roomId: string };
  events: readonly SettlementBusinessEvent[];
  eventsComplete: boolean;
}
/** Reads money only for the visible lanes of the selected room. All commands remain outside this timeline. */
export function ContractSettlementTimeline({ target, events, eventsComplete }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const { data: actor } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const room = useRoomCashLifecycle(target.roomId);
  const chronology = room.data?.today ? selectSettlementChronology(room.data, target.contractId, room.data.today) : null;
  const lanes = chronology?.lanes ?? [];
  const requests = lanes.map((lane, index) => {
    const isTarget = lane.contract.id === target.contractId;
    const terminations = eventsComplete ? events.filter(event => event.sourceKind === 'termination'
      && event.organizationId === selectedOrganizationId && event.contractId === lane.contract.id) : [];
    const scope: SettlementFinancialScope = {
      organizationId: selectedOrganizationId ?? '', roomId: target.roomId, contractId: lane.contract.id,
      terminationId: isTarget && target.terminationId ? target.terminationId : terminations.length === 1 ? terminations[0].sourceId : null,
      voucherId: isTarget ? target.voucherId ?? null : null,
      sourceReceiptId: isTarget ? target.sourceReceiptId ?? null : null,
    };
    return { scope, visible: expanded || lane.role !== 'following' || index === lanes.length - 1 };
  });
  const facts = useQueries({ queries: requests.map(({ scope, visible }) => ({
    queryKey: settlementFinancialQueryKey(actor?.id, scope),
    enabled: visible && !!actor?.id && !!selectedOrganizationId,
    queryFn: ({ signal }: { signal: AbortSignal }) => readSettlementFinancialContext(scope, signal),
    staleTime: 0, retry: false, refetchInterval: 30_000, refetchOnWindowFocus: 'always' as const,
  })) });
  const failed = facts.some((query, index) => requests[index].visible && query.isError);
  const pending = facts.some((query, index) => requests[index].visible && query.isPending);
  const retry = async () => {
    setRetryError(null);
    const results = await Promise.allSettled([room.refetch({ throwOnError: true }), ...facts.filter((_query, index) => requests[index].visible).map(query => query.refetch({ throwOnError: true }))]);
    if (results.some(result => result.status === 'rejected')) setRetryError('Chưa tải lại đầy đủ dòng thời gian. Vui lòng thử lại.');
  };
  return <ContractSettlementTimelineView
    lanes={lanes.map((lane, index) => settlementTimelineLane(lane, facts[index]?.isError ? undefined : facts[index]?.data))}
    hint="Liền trước → hợp đồng đang xử lý → hiện tại"
    loading={room.isPending || pending} expanded={expanded} onExpandedChange={setExpanded}
    error={room.error?.message || retryError || (failed ? 'Chưa đọc được một phần số liệu. Các khoản chưa xác minh được giữ riêng.' : null)}
    warning={chronology?.warning === 'CHRONOLOGY_UNVERIFIED' ? 'Chưa xác minh đủ thứ tự cư trú; chỉ hiển thị hợp đồng đang xử lý.'
      : chronology?.warning === 'TARGET_UNAVAILABLE' ? 'Không đọc được hợp đồng đang xử lý trong lịch sử phòng.' : null}
    onRetry={() => { void retry(); }} />;
}
