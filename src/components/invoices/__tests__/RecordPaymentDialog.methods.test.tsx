// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RecordPaymentDialog from '../RecordPaymentDialog';
import type { InvoiceWithRelations } from '@/types/invoice';

const boundary = vi.hoisted(() => ({
  accounts: undefined as undefined | Array<Record<string, unknown>>,
  mutateAsync: vi.fn(),
}));

// Exercise the real Radix select interaction; jsdom has no geometry for Floating UI popper positioning.
vi.mock('@/components/ui/select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/select')>();
  return {
    ...actual,
    SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => (
      <actual.SelectContent {...props} position="item-aligned" />
    ),
  };
});
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: boundary.accounts }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'collector' } }) }));
vi.mock('@/hooks/useInvoicePayments', () => ({
  useRecordPaymentRPC: () => ({ isPending: false, mutateAsync: boundary.mutateAsync }),
}));
vi.mock('@/hooks/useClipboardImagePaste', () => ({ useClipboardImagePaste: () => ({}) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: new Proxy({}, { get() { throw new Error('No backend calls permitted in this fixture'); } }),
}));

const organizationId = 'dddd0000-0000-4000-8000-000000000001';
const otherOrganizationId = 'cccc0000-0000-4000-8000-000000000001';

const account = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  organization_id: organizationId,
  is_virtual: false,
  user_id: null,
  bank_name: null,
  ...overrides,
});

const validAccounts = () => [
  account('account-tm', { name: 'Chung' }),
  account('account-tt', { name: 'Thu tòa nhà' }),
];

function invoice(defaultAccountIdTt: string | null = 'account-tt') {
  return {
    id: 'invoice',
    invoice_number: 'DEMO-TT',
    organization_id: organizationId,
    building_id: 'building',
    building: {
      id: 'building',
      name: 'Tòa kiểm thử',
      default_account_id_tt: defaultAccountIdTt,
      default_account_id_tk: null,
    },
    tenant: { full_name: 'Khách kiểm thử' },
    payments: [],
    total_amount: 100_000,
    paid_amount: 0,
    status: 'APPROVED',
    contract_id: null,
  } as unknown as InvoiceWithRelations;
}

function renderDialog(defaultAccountIdTt: string | null = 'account-tt') {
  return render(<RecordPaymentDialog open onOpenChange={() => {}} invoice={invoice(defaultAccountIdTt)} />);
}

async function openMethod(index = 0) {
  fireEvent.keyDown(screen.getAllByRole('combobox')[index]!, { key: 'ArrowDown' });
  return screen.findByRole('option', { name: 'TT' });
}

async function chooseTt(index = 0) {
  const option = await openMethod(index);
  fireEvent.keyDown(option, { key: 'Enter' });
}

afterEach(cleanup);
beforeEach(() => {
  boundary.accounts = validAccounts();
  boundary.mutateAsync.mockReset();
  boundary.mutateAsync.mockResolvedValue(undefined);
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

it('shows TT when the building TT default is a real account in the invoice organization', async () => {
  renderDialog();
  expect(await openMethod()).toBeTruthy();
});

it.each([
  ['the building has no TT default', null, validAccounts()],
  ['the configured account is missing from readable accounts', 'missing-account', validAccounts()],
  ['the configured account is virtual', 'account-tt', [
    account('account-tm', { name: 'Chung' }),
    account('account-tt', { is_virtual: true }),
  ]],
  ['the configured account belongs to another organization', 'account-tt', [
    account('account-tm', { name: 'Chung' }),
    account('account-tt', { organization_id: otherOrganizationId }),
  ]],
])('hides TT when %s', async (_case, defaultAccountIdTt, accounts) => {
  boundary.accounts = accounts;
  renderDialog(defaultAccountIdTt);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  expect(await screen.findByRole('option', { name: 'TM' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'TT' })).toBeNull();
});

it('shows TT after accounts transition from loading to a valid building default', async () => {
  boundary.accounts = undefined;
  const view = renderDialog();
  fireEvent.keyDown(screen.getAllByRole('combobox')[0]!, { key: 'ArrowDown' });
  expect(await screen.findByRole('option', { name: 'TM' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'TT' })).toBeNull();

  fireEvent.keyDown(document.body, { key: 'Escape' });
  boundary.accounts = validAccounts();
  view.rerender(<RecordPaymentDialog open onOpenChange={() => {}} invoice={invoice()} />);
  expect(await openMethod()).toBeTruthy();
});

it('defaults a second payment row to TT only when the building TT default is valid', async () => {
  renderDialog();
  fireEvent.click(screen.getByTitle('Thêm dòng thanh toán'));
  await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2));
  expect(screen.getAllByRole('combobox')[1]!.textContent).toContain('TT');
});

it('defaults a second payment row to TM when TT and TK are unavailable', async () => {
  boundary.accounts = [account('account-tm', { name: 'Chung' })];
  renderDialog(null);
  fireEvent.click(screen.getByTitle('Thêm dòng thanh toán'));
  await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2));
  expect(screen.getAllByRole('combobox')[1]!.textContent).toContain('TM');
});

it('sends the building TT default account in the RPC tender when TT is selected', async () => {
  renderDialog();
  await chooseTt();
  fireEvent.click(screen.getByRole('button', { name: 'Ghi nhận thanh toán' }));
  await waitFor(() => expect(boundary.mutateAsync).toHaveBeenCalledTimes(1));
  expect(boundary.mutateAsync.mock.calls[0]![0]).toMatchObject({
    tenders: [{ payment_method: 'TT', account_id: 'account-tt' }],
  });
});
