// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ConfirmedClosure } from '@/hooks/useCashbookClosing';

const h = vi.hoisted(() => ({
  vouchers: [] as {id:string;code:string;type:string;total_amount:number}[],
  limit: vi.fn(),
  closure: { closure_id: 7, cashbook_id: 'account-1', cashbook_name: 'Quỹ demo', closed_through: '2026-10-20',
    confirmed_at: '2026-10-20T09:00:00Z', difference: 500, system_balance: 1000, counted_balance: 1500,
    basis: 'POSTING_TRUTH_BY_POSTED_ON', proposed_by_name: 'Thủ quỹ demo', confirmed_by_name: 'Người nhận demo' },
}));
vi.mock('react-router-dom', () => ({ useParams: () => ({closureId:'7'}), useNavigate: () => vi.fn(), useSearchParams: () => [new URLSearchParams()] }));
vi.mock('@/lib/myOrganizations', () => ({ fetchMyOrganizations: async () => [{id:'org-1',name:'Công ty demo'}] }));
vi.mock('@/hooks/useCashbookClosing', () => ({ useCashbookClosings: () => ({data:{closures:[h.closure]},status:'success',fetchStatus:'idle',isLoading:false,isError:false,error:null,refetch:vi.fn()}) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({data: table === 'accounts' ? {id:'account-1',code:'TK-DEMO',organization_id:'org-1'} : null,error:null}),
      limit: async (count: number) => { h.limit(count); return {data:h.vouchers.slice(0,count),error:null}; },
    };
    return builder;
  } },
}));

import CashbookClosureRecord, { useClosureExtras } from '../CashbookClosureRecord';

let client: QueryClient;
const wrapper = ({children}: {children:ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => {
  client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  h.limit.mockClear();
  h.vouchers = [{id:'voucher-a',code:'PT-DEMO-A',type:'INCOME',total_amount:500}];
});
afterEach(() => { cleanup(); client.clear(); });

describe('closure voucher lookup after reopening', () => {
  it('keeps the single matching voucher for the closing record', async () => {
    const {result} = renderHook(() => useClosureExtras(h.closure as ConfirmedClosure), {wrapper});
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({cashbook_code:'TK-DEMO',organization_name:'Công ty demo',diff_voucher_ambiguous:false,diff_voucher:h.vouchers[0]});
  });

  it('does not select either voucher when two closings share the same book and day', async () => {
    h.vouchers.push({id:'voucher-b',code:'PT-DEMO-B',type:'INCOME',total_amount:300});
    const {result} = renderHook(() => useClosureExtras(h.closure as ConfirmedClosure), {wrapper});
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.diff_voucher).toBeNull();
    expect(result.current.data?.diff_voucher_ambiguous).toBe(true);
    expect(h.limit).toHaveBeenCalledWith(2);
  });

  it('prints the confirmed balance snapshot with an explicit ambiguity note instead of a wrong voucher', async () => {
    h.vouchers.push({id:'voucher-b',code:'PT-DEMO-B',type:'INCOME',total_amount:300});
    render(<CashbookClosureRecord />, {wrapper});
    expect(await screen.findByText('Có nhiều phiếu chênh lệch cùng ngày; chưa xác định được phiếu của biên bản này.')).toBeTruthy();
    expect(screen.getByText('1.000 đ')).toBeTruthy();
    expect(screen.getByText('1.500 đ')).toBeTruthy();
    expect(screen.getByRole('button',{name:'In biên bản'}).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/PT-DEMO-A|PT-DEMO-B/)).toBeNull();
  });
});
