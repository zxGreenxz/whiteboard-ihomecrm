// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSharedFundWrite, type FundWrite } from '../useSharedFund';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'original-owner' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
const org = 'fixture-org';
const source: FundWrite = {
  action: 'source',
  kind: 'OPENING',
  effectiveDate: '2024-06-01',
  amount: 750,
  reference: 'BB-A',
  evidence: 'Đã đối chiếu',
  expected: 0,
};
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  rpc.mockReset();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', org);
});
afterEach(cleanup);

it('sau khi mất biên nhận, tìm giao dịch cũ theo đúng công ty, người ghi và khóa trước khi gửi lại', async () => {
  let sentKey = '';
  rpc.mockImplementation(async (name: string, args: { p_idempotency_key: string }) => {
    if (name === 'shared_fund_record_source_v1') {
      sentKey = args.p_idempotency_key;
      throw new TypeError('Failed to fetch');
    }
    const base = {
      kind: 'OPENING',
      effective_date: '2024-06-01',
      amount: 750,
      reference: 'BB-A',
      evidence: 'Đã đối chiếu',
    };
    return {
      error: null,
      data: {
        organization_id: org,
        route: 'CANONICAL',
        has_opening: true,
        available_amount: 750,
        last_effective_date: '2024-06-01',
        sources: [
          { ...base, id: 'other-owner-id', created_by: 'someone-else', request_key: sentKey },
          { ...base, id: 'original-id', created_by: 'original-owner', request_key: sentKey },
        ],
        shareholders: [],
        distributions: [],
        openings: [],
      },
    };
  });
  const old = renderHook(() => useSharedFundWrite(org), { wrapper });
  await act(async () => {
    await expect(old.result.current.mutateAsync(source)).rejects.toBeTruthy();
  });
  old.unmount();
  const next = renderHook(() => useSharedFundWrite(org), { wrapper });
  await act(async () => {
    await expect(next.result.current.mutateAsync({ ...source, reference: 'BB-B' })).resolves.toEqual({
      id: 'original-id',
      reconciled: true,
    });
  });
  expect(rpc.mock.calls.map((c) => c[0])).toEqual(['shared_fund_record_source_v1', 'shared_fund_state_v1']);
});

it('truyền cả số lợi nhuận và ứng đã duyệt vào mốc đầu kỳ', async () => {
  rpc.mockResolvedValue({
    error: null,
    data: {
      opening_id: 'moc',
      shareholder_id: 'alpha',
      through_month: '2024-04-01',
      as_of_date: '2024-05-03',
      advance_amount: 75,
      evidence: 'Đã đối chiếu',
    },
  });
  const hook = renderHook(() => useSharedFundWrite(org), { wrapper });
  await act(async () => {
    await hook.result.current.mutateAsync({
      action: 'opening',
      shareholderId: 'alpha',
      throughMonth: '2024-04-01',
      asOfDate: '2024-05-03',
      advance: 75,
      expectedUnpaid: 60,
      expectedApproved: 90,
      evidence: 'Đã đối chiếu',
    });
  });
  expect(rpc).toHaveBeenCalledWith(
    'shareholder_profit_opening_advance_v1',
    expect.objectContaining({
      p_organization_id: org,
      p_expected_unpaid: 60,
      p_expected_approved: 90,
      p_advance_amount: 75,
    }),
  );
});
