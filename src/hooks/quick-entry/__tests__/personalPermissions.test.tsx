// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrganizationProvider } from '@/contexts/OrganizationContext';
import { useQuickEntryController } from '../useQuickEntryController';

const h = vi.hoisted(() => ({ rpc: vi.fn(), personal: { personal_finance: { view: true, create: true } } as unknown }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc,
  from: () => ({ select: () => ({ eq: () => ({ single: () => ({ setHeader: async () => ({ data: { ui_preferences: {} }, error: null }) }) }) }) }),
  auth: {
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    getSession: async () => ({ data: { session: { user: { id: 'actor-a' }, access_token: `header.${btoa(JSON.stringify({sub:'actor-a'}))}.signature` } }, error: null })
  } } }));
// Data/side-effect boundaries are fixtures; auth, organization, permission hooks,
// quick refs and controller are the shipped implementation.
vi.mock('@/hooks/personal-finance/usePersonalFinance', () => ({ usePersonalFinance: () => ({ data: { wallets: [], categories: [] }, isLoading: false, error: null }) }));
vi.mock('../useQuickEntryFeed', () => ({ useQuickEntryFeed: () => ({}) }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({ useIncomeExpenseFormBuildings: () => ({}), useIncomeExpenseFormRooms: () => ({}) }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({ useIncomeExpenseTypes: () => ({}) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({}) }));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({ useCustodianCashbooksV2: () => ({}) }));
vi.mock('@/hooks/usePeriodFees', () => ({ useFeeAccounts: () => ({}) }));
vi.mock('@/hooks/useUtilityBills', () => ({ useUtilityAccounts: () => ({}) }));
vi.mock('@/hooks/useBuildingCommonNames', () => ({ useBuildingCommonNames: () => ({}) }));

beforeEach(() => {
  localStorage.clear();
  h.personal = { personal_finance: { view: true, create: true } };
  h.rpc.mockImplementation((name: string) => {
    const result = Promise.resolve(name === 'list_my_copilot_organizations_v1'
      ? { data: { organizations: [{ id: 'org-a', name: 'A' }, { id: 'org-b', name: 'B' }] }, error: null }
      : { data: h.personal, error: null });
    return Object.assign(result, { setHeader: () => result });
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['auth', 'user'], { id: 'actor-a' });
  return renderHook(() => useQuickEntryController('personal'), { wrapper: ({ children }) => <QueryClientProvider client={client}><OrganizationProvider>{children}</OrganizationProvider></QueryClientProvider> });
}

it('personal quick entry becomes ready without a company and cannot open company entry', async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.mode).toBe('personal');
  expect(result.current.modes).toEqual(['personal']);
  expect(result.current.refs.orgId).toBeNull();
  expect(result.current.refs.canCompany).toBe(false);
  expect(result.current.loading).toBe(false);
});

it('account-wide superadmin projection cannot enable company entry without a selected company', async () => {
  h.personal = { __superadmin: true, income_expenses: { create: true } };
  const { result } = mount();
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.modes).toEqual(['personal']);
  expect(result.current.refs.canCompany).toBe(false);
  expect(h.rpc.mock.calls.some(([name]) => name === 'get_my_permissions_v2')).toBe(false);
});
