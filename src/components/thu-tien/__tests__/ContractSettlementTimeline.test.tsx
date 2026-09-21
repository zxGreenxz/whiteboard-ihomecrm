// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SettlementRoomLifecycle } from '@/lib/contractSettlementTimeline';
import type { SettlementFinancialScope } from '@/lib/contractSettlementFinancialContext';
const m = vi.hoisted(() => ({ room: null as SettlementRoomLifecycle | null, read: vi.fn(), refreshRoom: vi.fn() }));
vi.mock('@/hooks/useRoomCashLifecycle', () => ({ useRoomCashLifecycle: () => ({ data: m.room, isPending: false, error: null, refetch: m.refreshRoom }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor' } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org' }) }));
vi.mock('@/hooks/useContractSettlementFinancialFacts', () => ({
  readSettlementFinancialContext: m.read,
  settlementFinancialQueryKey: (actor: string, scope: SettlementFinancialScope) => ['financial', actor, scope],
}));
import { ContractSettlementTimeline } from '../ContractSettlementTimeline';
beforeEach(() => {
  m.read.mockReset().mockImplementation(async (scope: SettlementFinancialScope) => ({
    targetContractId: scope.contractId, today: '2026-09-21', termination: null,
    depositReceived: { state: 'verified', amount: scope.contractId === 'c1' ? 3900000 : 1000000, basis: 'ledger' },
  }));
  m.room = { organizationId: 'org', today: '2026-09-21', generatedAt: '2026-09-21T00:00:00Z', room: { id: 'room', name: '301', buildingId: 'building', buildingName: '80DS3' }, range: { from: null, to: null }, events: [], vacancies: [],
    contracts: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, number: `HD-${i}`, status: i === 4 ? 'ACTIVE' : 'TERMINATED', signedDate: `2026-0${i + 1}-01`, startDate: `2026-0${i + 1}-10`, endDate: '2027-01-01', actualEndDate: null, rentPrice: 4000000, totalDeposit: 4000000, tenantName: `Khách ${i}` })),
    segments: Array.from({ length: 5 }, (_, i) => ({ contractId: `c${i}`, contractNumber: `HD-${i}`, segIndex: 0, fromDate: `2026-0${i + 1}-10`, toDate: i === 4 ? null : `2026-0${i + 2}-10`, sourcePath: 'contracts', trusted: true, diagnostic: null })),
  };
});
afterEach(cleanup);
it('reads only compact visible contracts, then fetches intermediate facts when expanded', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ContractSettlementTimeline target={{ roomId: 'room', contractId: 'c1', voucherId: 'voucher-target' }} events={[]} eventsComplete /></QueryClientProvider>);
  await waitFor(() => expect(m.read).toHaveBeenCalledTimes(3));
  expect(m.read.mock.calls.map(([scope]) => scope.contractId).sort()).toEqual(['c0', 'c1', 'c4']);
  expect(m.read.mock.calls.find(([scope]) => scope.contractId === 'c1')?.[0]).toMatchObject({ voucherId: 'voucher-target', contractId: 'c1' });
  expect(m.read.mock.calls.filter(([scope]) => scope.contractId !== 'c1').every(([scope]) => scope.voucherId === null)).toBe(true);
  await waitFor(() => expect(screen.getByText('3.900.000đ')).toBeTruthy());
  expect(screen.getByRole('article', { name: 'Đang xử lý · HD-1' })).toBeTruthy();
  expect(screen.getByRole('article', { name: 'Hiện tại · HD-4' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Xem thêm 2 hợp đồng' }));
  await waitFor(() => expect(m.read).toHaveBeenCalledTimes(5));
  client.clear();
});
