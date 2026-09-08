// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitFor, cleanup, fireEvent, render, screen } from '@testing-library/react';
import GenerateInvoiceDialog from '../GenerateInvoiceDialog';
import EditInvoiceDialog from '../EditInvoiceDialog';
import type { InvoiceWithRelations } from '@/types/invoice';

const boundary = vi.hoisted(() => ({ payload: null as null | { formData: { notes: string; items: Array<{ description: string; type: string; unit_price: number; accounting_class?: string }> } } }));
// Exercise real Radix selection; jsdom has no geometry for Floating UI popper positioning.
vi.mock('@/components/ui/select', async (importOriginal) => {
 const actual = await importOriginal<typeof import('@/components/ui/select')>();
 return { ...actual, SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => <actual.SelectContent {...props} position='item-aligned' /> };
});
vi.mock('@/hooks/useInvoices', () => ({
  useCreateInvoice: () => ({ isPending: false, mutate: (formData: NonNullable<typeof boundary.payload>['formData']) => { boundary.payload = { formData }; } }),
  useUpdateInvoice: () => ({ isPending: false, mutate: (payload: typeof boundary.payload) => { boundary.payload = payload; } }),
  useExcessAmount: () => ({ data: 0 }),
}));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [] }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock('@/hooks/useContracts', () => ({ useContracts: () => ({ data: [{
  id: 'demo-contract', status: 'ACTIVE', contract_number: 'DEMO-CONTRACT', rent_price: 1000000,
  room_id: null, room: { id: 'demo-room', name: 'DEMO', building_id: 'demo-building' },
}] }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [] }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => ({ data: [] }) }));
vi.mock('@/hooks/useVehicles', () => ({ useVehicles: () => ({ data: { data: [] } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: new Proxy({}, { get() { throw new Error('No backend calls permitted in this fixture'); } }) }));
afterEach(cleanup);
beforeEach(() => {
  boundary.payload = null;
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

function fixture() {
  return {
    id: 'dddd0000-0000-4000-8000-000000000101', invoice_number: 'DEMO-NOTES-ONLY',
    building_id: 'dddd0000-0000-4000-8000-000000000102', room_id: null,
    contract_id: 'dddd0000-0000-4000-8000-000000000103', status: 'APPROVED', paid_amount: 0,
    billing_month: '2026-09', issue_date: '2026-09-01', due_date: '2026-09-05',
    notes: 'Ghi chú cũ', previous_debt: 0, previous_debt_sources: [], discount_amount: 0,
    invoice_items: [
      { id: 'rent', type: 'RENT', accounting_class: 'REVENUE', description: 'Tiền thuê', unit_price: 5290000, quantity: 1, amount: 5290000 },
      { id: 'deposit', type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Tiền cọc', unit_price: 2200000, quantity: 1, amount: 2200000 },
    ],
  } as unknown as InvoiceWithRelations;
}

it('preserves a deposit item when the user changes only invoice notes', async () => {
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={fixture()} />);
  expect(screen.getAllByDisplayValue('Tiền cọc').find(element => element.tagName === 'INPUT')!).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Ghi chú'), { target: { value: 'Chỉ sửa ghi chú' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
  await waitFor(() => expect(boundary.payload).not.toBeNull());
  expect(boundary.payload!.formData.notes).toBe('Chỉ sửa ghi chú');
  const deposit = boundary.payload!.formData.items.find(item => item.description === 'Tiền cọc');
  expect(deposit).toMatchObject({ type: 'OTHER', description: 'Tiền cọc', unit_price: 2200000 });
  expect(deposit?.accounting_class).toBe('DEPOSIT');
});

async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
  await waitFor(() => expect(boundary.payload).not.toBeNull());
  return boundary.payload!.formData.items;
}
function selectKind(label: string) {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: label }), { key: 'Enter' });
}
it('retains the deposit class when the amount and description change', async () => {
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={fixture()} />);
  const row = screen.getAllByDisplayValue('Tiền cọc').find(element => element.tagName === 'INPUT')!.closest('tr')!;
  fireEvent.change(screen.getAllByDisplayValue('Tiền cọc').find(element => element.tagName === 'INPUT')!, { target: { value: 'Bổ sung bảo đảm' } });
  const price = row.querySelectorAll('input')[2]!;
  fireEvent.change(price, { target: { value: '2300000' } });
  expect((await save()).find(item => item.description === 'Bổ sung bảo đảm'))
    .toMatchObject({ accounting_class: 'DEPOSIT', unit_price: 2300000 });
});
it('allows deleting and readding a deposit through the explicit Tiền cọc choice', async () => {
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={fixture()} />);
  fireEvent.click(screen.getAllByDisplayValue('Tiền cọc').find(element => element.tagName === 'INPUT')!.closest('tr')!.querySelector('button[aria-label="Xóa khoản thu"]')!);
  fireEvent.click(screen.getByRole('button', { name: /^Thêm$/ }));
  selectKind('Tiền cọc');
  const row = screen.getAllByDisplayValue('Tiền cọc').find(element => element.tagName === 'INPUT')!.closest('tr')!;
  fireEvent.change(row.querySelectorAll('input')[2]!, { target: { value: '2200000' } });
  expect((await save()).find(item => item.description === 'Tiền cọc'))
    .toMatchObject({ type: 'OTHER', accounting_class: 'DEPOSIT', unit_price: 2200000 });
});
it('does not infer a deposit from a revenue description containing cọc', async () => {
  const invoice = fixture();
  invoice.invoice_items![1] = { ...invoice.invoice_items![1]!, accounting_class: 'REVENUE', description: 'Phí xử lý cọc' };
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={invoice} />);
  const items = await save();
  expect(items.find(item => item.description === 'Phí xử lý cọc')).toMatchObject({ accounting_class: 'REVENUE' });
  expect(items.find(item => item.type === 'RENT')).toMatchObject({ accounting_class: 'REVENUE' });
});
it('an explicit change from Tiền cọc to Khác changes the class without using the label', async () => {
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={fixture()} />);
  selectKind('Khác');
  expect((await save()).find(item => item.description === 'Tiền cọc')).toMatchObject({ accounting_class: 'REVENUE' });
});

for (const [type, description, accounting_class] of [
  ['SERVICE', 'Tiền nước bảo đảm', 'DEPOSIT'],
  ['RENT', 'Tiền thuê bảo đảm', 'DEPOSIT'],
  ['OTHER', 'Khoản ngoài doanh thu', 'NON_PNL'],
] as const) {
  it(`preserves structured ${accounting_class} metadata for ${type}`, async () => {
    const invoice = fixture();
    invoice.invoice_items![1] = { ...invoice.invoice_items![1]!, type, description, accounting_class };
    render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={invoice} />);
    expect((await save()).find(item => item.description === description)).toMatchObject({
      type, accounting_class, unit_price: 2200000,
    });
  });
}

it('creates a new deposit using the actual create form selector', async () => {
  render(<GenerateInvoiceDialog open onOpenChange={() => {}} />);
  fireEvent.keyDown(screen.getAllByRole('combobox')[2]!, { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: 'DEMO-CONTRACT - DEMO' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: /^Thêm$/ }));
  fireEvent.keyDown(screen.getAllByRole('combobox').at(-1)!, { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: 'Tiền cọc' }), { key: 'Enter' });
  const row = screen.getAllByDisplayValue('Tiền cọc').find(element => element.tagName === 'INPUT')!.closest('tr')!;
  fireEvent.change(row.querySelectorAll('input')[2]!, { target: { value: '2200000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo hóa đơn' }));
  await waitFor(() => expect(boundary.payload).not.toBeNull());
  expect(boundary.payload!.formData.items.find(item => item.description === 'Tiền cọc')).toMatchObject({
    type: 'OTHER', accounting_class: 'DEPOSIT', unit_price: 2200000,
  });
});
