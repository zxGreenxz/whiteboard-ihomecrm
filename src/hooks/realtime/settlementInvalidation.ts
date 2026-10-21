import type { QueryClient } from '@tanstack/react-query';
import type { SyncTable } from '@/lib/realtime/syncTables';
import { CONTRACT_SETTLEMENT_INVALIDATION_RULES, SETTLEMENT_FACTS_INVALIDATION_RULES } from './index';

/** Descriptor keys in this group are flushed once per burst, not per table. */
export const isSettlementQueryKey = (key: readonly unknown[]): boolean =>
  key[0] === 'contract-settlement' || key[0] === 'termination-refund-facts' || key[0] === 'commission-voucher-facts';

/**
 * Làm mới nhóm quyết toán cho MỘT cụm sự kiện xuyên bảng.
 *
 * Trước 21/10/2026 nhóm này có bộ gom riêng (timer riêng) chạy song song với
 * timer từng bảng và timer báo cáo. Nay bộ gom toàn cục của hub
 * (src/lib/realtime/hubCollector.ts) giữ MỘT nhịp cho cả cụm và gọi hàm này khi
 * nhả — luật subtype vẫn nằm ở đây, cạnh descriptor.
 */
export function flushSettlementInvalidation(client: QueryClient, tables: Iterable<SyncTable>): void {
  const subtypes = new Set<string>();
  const facts = new Set<string>();
  for (const table of tables) {
    CONTRACT_SETTLEMENT_INVALIDATION_RULES[table]?.forEach((key) => subtypes.add(key));
    SETTLEMENT_FACTS_INVALIDATION_RULES[table]?.forEach((key) => facts.add(key));
  }
  if (subtypes.size > 0) {
    client.invalidateQueries({
      queryKey: ['contract-settlement'],
      predicate: (query) => subtypes.has(String(query.queryKey[1])),
    });
  }
  for (const root of facts) client.invalidateQueries({ queryKey: [root] });
}
