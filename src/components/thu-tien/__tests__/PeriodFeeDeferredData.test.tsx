// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeriodFeePanel } from '../PeriodFeePanel';
import { PeriodFeeSheet } from '../PeriodFeeSheet';
import { useFeeAccounts } from '@/hooks/usePeriodFees';
import { usePeriodFeeState } from '@/hooks/usePeriodFeeState';
import { useUtilityPayState } from '@/hooks/useUtilityPayState';
import { FEE_CATEGORIES } from '@/lib/feeCategories';

// Chỉ giả lập I/O và phần nội dung khác. Parent, menu, state hooks và React
// Query thật phải chứng minh không gửi request khi chưa cần dữ liệu phí.
const H = vi.hoisted(() => ({
  reads: [] as string[],
  readRpc: vi.fn(),
  pending: new Map<string, Promise<{ data: unknown; error: { message: string } | null }>>(),
  buildings: [{ id: 'building', name: 'A', is_virtual: false, has_elevator: true }],
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      H.reads.push(table);
      const data = table === 'profiles' ? { ui_preferences: {} }
        : table === 'income_expense_types' ? [{ id: 'electric', name: 'Đóng tiền điện' }] : [];
      const builder: unknown = new Proxy({}, {
        get: (_obj, key) => key === 'then'
          ? (resolve: (value: unknown) => unknown) => Promise.resolve(H.pending.get(table) ?? { data, error: null }).then(resolve)
          : () => builder,
      });
      return builder;
    },
    rpc: (...args: unknown[]) => H.readRpc(...args),
  },
}));
vi.mock('@/lib/authSession', () => ({
  getSessionUser: async () => ({ id: 'user', email: 'user@example.test' }),
  getSessionUserId: async () => 'user',
}));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({ useIncomeExpenseFormBuildings: () => ({ data: H.buildings, isLoading: false }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: H.buildings }) }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsAdmin: () => ({ data: true }), useIsSuperAdmin: () => ({ data: false }) }));
vi.mock('@/hooks/useIsOrgOwner', () => ({ useIsOrgOwner: () => ({ data: true }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: [] }) }));
vi.mock('@/hooks/useMaintenanceBatch', () => ({ useCreateMaintenanceBatch: () => ({ isPending: false }) }));
vi.mock('../contract-settlement/ContractSettlementSection', () => ({ ContractSettlementSection: () => <div>Hồ sơ hợp đồng</div> }));
vi.mock('../SettlementPanels', () => ({ DepositLedgerSection: () => null }));
vi.mock('../PeriodFeeSharedModals', () => ({ PeriodFeeSharedModals: () => null }));
vi.mock('../UtilityCancelModal', () => ({ UtilityCancelModal: () => null }));
vi.mock('@/components/ui/attachment-lightbox', () => ({ AttachmentLightbox: () => null }));

const wrapper = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
};
const props = { billingMonth: '2026-09', onBillingMonthChange: vi.fn(), onClose: vi.fn(), canRecordPayment: true };
const costlyTables = ['building_fee_accounts', 'accounts', 'profiles', 'building_utility_accounts', 'income_expense_types', 'income_expenses'];

beforeEach(() => {
  H.reads.length = 0;
  H.pending.clear();
  H.readRpc.mockReset().mockImplementation(async (name: string) => ({
    data: name === 'get_period_fee_status' ? [{
      building_id: 'building', category_key: 'internet', paid_amount: 0, draft_amount: 0, expected_amount: 123,
    }] : [],
    error: null,
  }));
  sessionStorage.setItem('flt:thu-tien:fee-cat', JSON.stringify('hop_dong'));
});
afterEach(() => { cleanup(); sessionStorage.clear(); });

describe('Phí kỳ — hoãn dữ liệu ngoài Hợp đồng & quyết toán', () => {
  it.each([
    ['panel', 'building_fee_accounts'], ['panel', 'accounts'], ['panel', 'profiles'],
    ['sheet', 'building_fee_accounts'], ['sheet', 'accounts'], ['sheet', 'profiles'],
  ] as const)('%s không mở form phí khi %s còn pending', async (surface, table) => {
    let finish!: (value: { data: unknown; error: null }) => void;
    H.pending.set(table, new Promise(resolve => { finish = resolve; }));
    const view = render(surface === 'panel' ? <PeriodFeePanel {...props} /> : <PeriodFeeSheet {...props} show />, { wrapper: wrapper() });
    await waitFor(() => expect(H.readRpc).toHaveBeenCalled());
    const trigger = view.container.querySelector(surface === 'panel' ? '.ptt-trigger' : '.ptt-m-trigger')!;
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('button', { name: /^Internet/ }));
    await waitFor(() => expect(H.reads).toContain(table));
    expect(view.container.querySelector('input[placeholder="Mã NCC"]')).toBeNull();
    expect(screen.getByText('Đang tải dữ liệu phí…')).toBeTruthy();
    await act(async () => { finish({ data: table === 'profiles' ? { ui_preferences: {} } : [], error: null }); });
    await waitFor(() => expect(view.container.querySelector('input[placeholder="Mã NCC"]')).not.toBeNull());
  });

  it('sheet không tạo synthetic meter hoặc mở mutation khi utility source mới bật còn pending/lỗi', async () => {
    let finish!: (value: { data: unknown; error: { message: string } | null }) => void;
    H.pending.set('building_utility_accounts', new Promise(resolve => { finish = resolve; }));
    const view = render(<PeriodFeeSheet {...props} show />, { wrapper: wrapper() });
    fireEvent.click(view.container.querySelector('.ptt-m-trigger')!);
    fireEvent.click(screen.getByRole('button', { name: /^Điện & Nước/ }));
    await waitFor(() => expect(H.reads).toContain('building_utility_accounts'));
    expect(screen.queryAllByRole('button', { name: /Tạo công tơ/ })).toHaveLength(0);
    expect(screen.getByText('Đang tải dữ liệu điện nước…')).toBeTruthy();
    await act(async () => { finish({ data: null, error: { message: 'offline' } }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Thử lại dữ liệu điện nước' })).toBeTruthy());
    expect(screen.queryAllByRole('button', { name: /Tạo công tơ/ })).toHaveLength(0);
    H.pending.delete('building_utility_accounts');
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại dữ liệu điện nước' }));
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /Tạo công tơ/ })).toHaveLength(2));
  });
  it.each(['panel', 'sheet'] as const)('%s giữ menu/badge; chỉ tải phí khi người dùng chuyển mục', async (surface) => {
    const view = render(surface === 'panel' ? <PeriodFeePanel {...props} /> : <PeriodFeeSheet {...props} show />, { wrapper: wrapper() });
    await waitFor(() => expect(H.readRpc).toHaveBeenCalledWith('get_period_fee_status', expect.any(Object)));
    await act(async () => {});
    expect(H.reads.filter((table) => costlyTables.includes(table))).toEqual([]);
    expect(H.readRpc.mock.calls.map(([name]) => name)).toEqual(['get_period_fee_status']);
    const trigger = view.container.querySelector(surface === 'panel' ? '.ptt-trigger' : '.ptt-m-trigger')!;
    fireEvent.click(trigger);
    const internet = screen.getByRole('button', { name: /^Internet/ });
    // Một tòa chưa đóng: badge vẫn là 1 dù toàn bộ detail fee đang hoãn.
    expect(within(internet).getByText('1')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Tiền nhà/ })).toBeTruthy();
    fireEvent.click(internet);
    await waitFor(() => expect(H.reads).toEqual(expect.arrayContaining(['building_fee_accounts', 'accounts', 'profiles'])));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /^Điện & Nước/ }));
    await waitFor(() => expect(H.reads).toEqual(expect.arrayContaining(['building_utility_accounts', 'income_expenses'])));
  });

  it('các state hooks tắt I/O khi enabled false và mặc định vẫn tải như caller cũ', async () => {
    const cat = FEE_CATEGORIES.find((c) => c.family === 'GRID')!;
    const hook = renderHook(({ enabled }: { enabled?: boolean }) => {
      const options = enabled === undefined ? undefined : { enabled };
      const fee = useFeeAccounts(options);
      usePeriodFeeState('2026-09', cat, H.buildings, () => undefined, fee.accountOf, options);
      useUtilityPayState('2026-09', H.buildings, options);
    }, { wrapper: wrapper(), initialProps: { enabled: false } });
    await act(async () => {});
    expect(H.reads).toEqual([]);
    hook.rerender({ enabled: undefined });
    await waitFor(() => expect(H.reads).toEqual(expect.arrayContaining(costlyTables)));
  });

  it('sheet đang đóng không gọi dữ liệu fee/utility phụ trợ', async () => {
    sessionStorage.setItem('flt:thu-tien:fee-cat', JSON.stringify('overview'));
    render(<PeriodFeeSheet {...props} show={false} />, { wrapper: wrapper() });
    await act(async () => {});
    expect(H.reads).toEqual([]);
    expect(H.readRpc).not.toHaveBeenCalled();
  });
});
