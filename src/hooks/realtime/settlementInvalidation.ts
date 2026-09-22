import type { QueryClient } from '@tanstack/react-query';
import { delayConTrongTran } from '@/lib/realtime/hubDebounce';
import type { SyncTable } from '@/lib/realtime/syncTables';
import { CONTRACT_SETTLEMENT_INVALIDATION_RULES, SETTLEMENT_FACTS_INVALIDATION_RULES } from './index';

/** Descriptor keys in this group are flushed once per burst, not per table. */
export const isSettlementQueryKey = (key: readonly unknown[]): boolean =>
  key[0] === 'contract-settlement' || key[0] === 'termination-refund-facts' || key[0] === 'commission-voucher-facts';

export function createSettlementInvalidationCollector(client: QueryClient) {
  const pending = new Set<string>();
  const pendingFacts = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstEvent = 0;

  return {
    enqueue(table: SyncTable, now: number) {
      const keys = CONTRACT_SETTLEMENT_INVALIDATION_RULES[table];
      if (!keys) return;
      keys.forEach((key) => pending.add(key));
      SETTLEMENT_FACTS_INVALIDATION_RULES[table]?.forEach((key) => pendingFacts.add(key));
      if (timer !== undefined) clearTimeout(timer);
      else firstEvent = now;
      timer = setTimeout(() => {
        timer = undefined;
        const subtypes = new Set(pending);
        pending.clear();
        client.invalidateQueries({
          queryKey: ['contract-settlement'],
          predicate: (query) => subtypes.has(String(query.queryKey[1])),
        });
        for (const root of pendingFacts) client.invalidateQueries({ queryKey: [root] });
        pendingFacts.clear();
      }, delayConTrongTran(firstEvent, now));
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      pendingFacts.clear();
    },
  };
}
