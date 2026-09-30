import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));

vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options }));
vi.mock('@/hooks/use-toast', () => ({ useToast: vi.fn() }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: vi.fn() }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return {
    supabase: createClient('https://deposits.test', 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: mocks.fetch },
    }),
  };
});

import {
  useOrphanDepositVouchers as orphanQueryOptions,
  useReservationDeposits as reservationQueryOptions,
  type OrphanDepositVoucher,
  type ReservationDepositRow,
} from './useDeposits';

const voucher = (id: string) => ({
  id, code: `PT-${id}`, name: 'Cọc giữ chỗ', payer_name: 'Khách thử',
  total_amount: 1500, voucher_date: '2026-09-28',
  approval_status: 'APPROVED', approval_version: 1,
  building_id: 'building-1', room_id: 'room-1',
  building: { id: 'building-1', name: 'Tòa thử' },
  room: { id: 'room-1', name: '101' },
  income_expense_items: [{ id: `${id}-item`, amount: 1000, income_expense_types: { is_deposit: true } }],
  settled: null, management_exclusion: null,
});

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

const runReservationQuery = (buildingIds?: string[]) => (
  reservationQueryOptions(buildingIds) as unknown as { queryFn: () => Promise<ReservationDepositRow[]> }
).queryFn();

const requestUrls = () => mocks.fetch.mock.calls.map(([input]) => new URL(String(input)));

beforeEach(() => { mocks.fetch.mockReset(); });

describe('reservation deposit management visibility', () => {
  it('excludes management-hidden vouchers on every page without changing deposit amounts or building scope', async () => {
    mocks.fetch
      .mockResolvedValueOnce(respond([voucher('visible-1')]))
      .mockResolvedValueOnce(respond([voucher('visible-2')]))
      .mockResolvedValueOnce(respond([]));

    const rows = await runReservationQuery(['building-1']);

    expect(rows.map(({ id, total_amount }) => ({ id, total_amount }))).toEqual([
      { id: 'visible-1', total_amount: 1000 },
      { id: 'visible-2', total_amount: 1000 },
    ]);
    const requests = requestUrls();
    expect(requests).toHaveLength(3);
    expect(requests.map(url => url.searchParams.get('offset'))).toEqual(['0', '1', '2']);
    for (const url of requests) {
      expect(url.pathname).toBe('/rest/v1/income_expenses');
      expect(url.searchParams.get('select')).toContain(
        'management_exclusion:deposit_management_exclusions!deposit_management_exclusions_voucher_id_fkey(voucher_id)',
      );
      expect(url.searchParams.get('management_exclusion')).toBe('is.null');
      expect(url.searchParams.get('building_id')).toBe('in.(building-1)');
      expect(url.searchParams.get('contract_id')).toBe('is.null');
      expect(url.searchParams.get('deleted_at')).toBe('is.null');
      expect(url.searchParams.get('income_expense_items.income_expense_types.is_deposit')).toBe('eq.true');
      expect(url.searchParams.get('order')).toBe('voucher_date.desc,id.asc');
      expect(url.searchParams.has('settled')).toBe(false);
    }
  });

  it('keeps hidden management vouchers eligible for contract linking through the orphan-deposit query', async () => {
    mocks.fetch.mockResolvedValueOnce(respond([{
      ...voucher('hidden-hold'), management_exclusion: { voucher_id: 'hidden-hold' },
    }]));

    const query = orphanQueryOptions('room-1', '2026-09-21') as unknown as {
      queryFn: () => Promise<OrphanDepositVoucher[]>;
    };
    const rows = await query.queryFn();

    expect(rows).toMatchObject([{ id: 'hidden-hold', total_amount: 1000 }]);
    const [url] = requestUrls();
    expect(url.searchParams.has('management_exclusion')).toBe(false);
    expect(url.searchParams.get('select')).not.toContain('deposit_management_exclusions');
    expect(url.searchParams.get('room_id')).toBe('eq.room-1');
    expect(url.searchParams.get('voucher_date')).toBe('lte.2026-09-28');
    expect(url.searchParams.get('settled')).toBe('is.null');
  });

  it('reports a failed exclusion read instead of presenting an empty deposit list', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockResolvedValueOnce(respond({
      code: 'PGRST200', message: 'Relationship is unavailable', details: null, hint: null,
    }, 400));
    try {
      await expect(runReservationQuery()).rejects.toMatchObject({code:'PGRST200',message:'Relationship is unavailable'});
    } finally {
      errorLog.mockRestore();
    }
  });
});
