import { supabase } from '@/integrations/supabase/client';
import type { SettlementEventPageReader } from './contractSettlementEventReader';

// New RPC has a validated unknown boundary until forward-lane types are generated.
type EventRpc = (name: 'read_contract_settlement_events_v1', args: {
  p_organization_id: string; p_building_ids: string[]; p_cursor: string | null; p_revision: string | null; p_limit: number;
}) => PromiseLike<{ data: unknown; error: { code?: string } | null }> & {
  abortSignal: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
};
export const readSettlementEventPage: SettlementEventPageReader = async (scope, cursor, revision, signal) => {
  const request = (supabase.rpc as unknown as EventRpc)('read_contract_settlement_events_v1', {
    p_organization_id: scope.organizationId, p_building_ids: [...new Set(scope.buildingIds)].sort(),
    p_cursor: cursor, p_revision: revision, p_limit: 250,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw Error(error.code === '42501' ? 'EVENT_READ_DENIED' : error.code === 'PT409' ? 'EVENT_CHANGED_RELOAD' : 'EVENT_READ_FAILED');
  return data;
};
