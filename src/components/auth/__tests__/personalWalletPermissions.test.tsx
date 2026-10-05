// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrganizationProvider, useOrganization } from '@/contexts/OrganizationContext';
import { salaryProfitRoutes } from '@/app/routes/salaryProfitRoutes';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { RequirePermission } from '../RequirePermission';
import type { ActionKey } from '@/lib/permissions';

const h = vi.hoisted(() => ({ rpc: vi.fn(), getSession: vi.fn(), permissions: {} as unknown, error: null as unknown }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc, auth: { getSession: h.getSession } } }));
// Only lazy page contents are fixtures; the shipped route and both guards run.
vi.mock('@/app/lazyPages', async original => ({ ...await original<object>(), PersonalWalletPage: () => <h1>Ví cá nhân đã mở</h1> }));

function OrganizationStatus() {
  const org = useOrganization();
  const company = useMyPermissions();
  return <output aria-label="organization state">{JSON.stringify({ selected: org.selectedOrganizationId, count: org.organizations.length, company: company.data ?? null })}</output>;
}

function mount(props?: { action: ActionKey; fallbackPath?: string; buildingId?: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['auth', 'user'], { id: 'actor-a' });
  render(<QueryClientProvider client={client}><OrganizationProvider><MemoryRouter initialEntries={[props ? '/permission-test' : '/finance/personal-wallet']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><OrganizationStatus /><Routes>{salaryProfitRoutes}<Route path="/permission-test" element={<RequirePermission module="personal_finance" {...props}><h1>Personal action</h1></RequirePermission>} /><Route path="/denied" element={<h1>Custom denial</h1>} /><Route path="/" element={<h1>Trang chủ</h1>} /></Routes></MemoryRouter></OrganizationProvider></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  localStorage.clear();
  h.error = null;
  h.permissions = { personal_finance: { view: true, create: true } };
  h.getSession.mockResolvedValue({ data: { session: { user: { id: 'actor-a' }, access_token: 'fixture-a' } }, error: null });
  h.rpc.mockImplementation((name: string) => {
    const result = Promise.resolve(name === 'list_my_copilot_organizations_v1'
      ? { data: { organizations: [{ id: 'org-a', name: 'A' }, { id: 'org-b', name: 'B' }] }, error: null }
      : { data: h.permissions, error: h.error });
    return Object.assign(result, { setHeader: () => result });
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('opens the shipped personal route with multiple organizations and none selected', async () => {
  mount();
  await screen.findByRole('heading', { name: 'Ví cá nhân đã mở' });
  await waitFor(() => expect(JSON.parse(screen.getByLabelText('organization state').textContent!)).toEqual({ selected: null, count: 2, company: null }));
  expect(localStorage.getItem('ihomecrm.selectedOrganizationId')).toBeNull();
  expect(h.rpc.mock.calls.some(([name]) => name === 'get_my_permissions_v2')).toBe(false);
});

it('denies the personal route when the account has no personal view permission', async () => {
  h.permissions = { income_expenses: { view: true, create: true } };
  mount();
  await screen.findByRole('heading', { name: 'Trang chủ' });
  expect(screen.queryByRole('heading', { name: 'Ví cá nhân đã mở' })).toBeNull();
});

it('keeps permission errors retryable and opens only after a successful read', async () => {
  h.error = new Error('Temporary permission failure');
  mount();
  await screen.findByRole('heading', { name: 'Không tải được quyền' });
  expect(screen.queryByRole('heading', { name: 'Ví cá nhân đã mở' })).toBeNull();
  h.error = null;
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  await screen.findByRole('heading', { name: 'Ví cá nhân đã mở' });
});

it('personal permission dispatch respects the requested action and fallback path', async () => {
  h.permissions = { personal_finance: { view: true, create: false } };
  mount({ action: 'create', fallbackPath: '/denied' });
  await screen.findByRole('heading', { name: 'Custom denial' });
  expect(screen.queryByRole('heading', { name: 'Personal action' })).toBeNull();
});

it('personal grants cannot satisfy an organization-building scoped guard without selecting that organization', async () => {
  h.permissions = { __superadmin: true };
  mount({ action: 'view', buildingId: 'building-a' });
  await waitFor(() => expect(JSON.parse(screen.getByLabelText('organization state').textContent!).count).toBe(2));
  expect(screen.queryByRole('heading', { name: 'Personal action' })).toBeNull();
  expect(h.rpc.mock.calls.some(([name]) => name === 'get_my_permissions')).toBe(false);
});
