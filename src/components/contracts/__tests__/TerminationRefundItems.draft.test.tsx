// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import type { RefundItem } from '@/lib/contractValidation';
import type { RefundItemsDraft } from '@/lib/contractExitSettlementDrafts';
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [] }) }));
import { TerminationRefundItems } from '../TerminationRefundItems';

const contract = { id: 'c1', rent_price: 3_100_000, contract_services: [], contract_customers: [], room: { building_id: 'b1' } } as unknown as ContractWithRelations;
afterEach(cleanup);
const show = (initialDraft?: RefundItemsDraft | null) => {
  const items: RefundItem[][] = []; const drafts: RefundItemsDraft[] = [];
  render(<TerminationRefundItems contract={contract} moveOutDate="2026-10-03" onChange={value => items.push(value)}
    initialDraft={initialDraft} onDraftChange={draft => drafts.push(draft)} />);
  return { items, drafts };
};
const dates = () => screen.getAllByPlaceholderText('dd/mm/yyyy').map(input => (input as HTMLInputElement).value);

describe('Hoàn lại khách: mở từ nháp', () => {
  it('form mới vẫn gợi ý "không ở" từ ngày sau trả phòng đến hết tháng', async () => {
    const { items } = show();
    await waitFor(() => expect(dates()).toEqual(['04/10/2026', '31/10/2026']));
    expect(items[items.length - 1]).toEqual([expect.objectContaining({ kind: 'PRORATED_REFUND', days: 28 })]);
  });
  it('nháp đã xoá ngày "không ở" thì giữ trống — không tự gợi ý lại và không tự hoàn tiền ngày không ở', async () => {
    const { items, drafts } = show({ fromDate: '', toDate: '2026-10-31', proratedAmount: 0, proratedTouched: false, customRows: [] });
    await waitFor(() => expect(drafts.length).toBeGreaterThan(0));
    expect(dates()).toEqual(['', '31/10/2026']);
    expect(items[items.length - 1]).toEqual([]);
    expect(drafts[drafts.length - 1]).toEqual({ fromDate: '', toDate: '2026-10-31', proratedAmount: 0, proratedTouched: false, customRows: [] });
  });
  it('nháp có số tự gõ và dòng tuỳ ý thì điền lại đúng', async () => {
    const { items } = show({ fromDate: '2026-10-10', toDate: '2026-10-31', proratedAmount: 1_500_000, proratedTouched: true,
      customRows: [{ name: 'Hoàn tiền dịch vụ', amount: 120_000 }] });
    await waitFor(() => expect(items[items.length - 1]).toEqual([
      expect.objectContaining({ kind: 'PRORATED_REFUND', amount: 1_500_000 }),
      { kind: 'CUSTOM', description: 'Hoàn tiền dịch vụ', amount: 120_000 }]));
    expect(dates()).toEqual(['10/10/2026', '31/10/2026']);
  });
});
