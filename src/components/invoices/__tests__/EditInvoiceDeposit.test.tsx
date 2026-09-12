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
  useAdjustInvoice: () => ({ isPending: false, mutate: (payload: unknown) => { boundary.payload = payload as typeof boundary.payload; } }),
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
    contract_id: 'dddd0000-0000-4000-8000-000000000103', status: 'DRAFT', paid_amount: 0,
    billing_month: '2026-09', issue_date: '2026-09-01', due_date: '2026-09-05',
    notes: 'Ghi chú cũ', previous_debt: 0, previous_debt_sources: [], discount_amount: 0, total_amount: 7490000,
    invoice_items: [
      { id: 'rent', type: 'RENT', accounting_class: 'REVENUE', description: 'Tiền thuê', unit_price: 5290000, quantity: 1, amount: 5290000 },
      { id: 'deposit', type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Tiền cọc', unit_price: 2200000, quantity: 1, amount: 2200000 },
    ],
  } as unknown as InvoiceWithRelations;
}

const depositToggle = () => screen.getByRole('checkbox', { name: 'Tiền cọc (nếu có)' }) as HTMLInputElement;
const valueOf = (el: HTMLElement) => (el as HTMLInputElement).value;

it('preserves a deposit item when the user changes only invoice notes', async () => {
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={fixture()} />);
  expect(depositToggle().checked).toBe(true);
  expect(valueOf(screen.getByLabelText('Mô tả cọc'))).toBe('Tiền cọc');
  fireEvent.change(screen.getByLabelText('Ghi chú'), { target: { value: 'Chỉ sửa ghi chú' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu hoá đơn' }));
  await waitFor(() => expect(boundary.payload).not.toBeNull());
  expect(boundary.payload!.formData.notes).toBe('Chỉ sửa ghi chú');
  const deposit = boundary.payload!.formData.items.find(item => item.description === 'Tiền cọc');
  expect(deposit).toMatchObject({ type: 'OTHER', description: 'Tiền cọc', unit_price: 2200000 });
  expect(deposit?.accounting_class).toBe('DEPOSIT');
});

async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Lưu hoá đơn' }));
  await waitFor(() => expect(boundary.payload).not.toBeNull());
  return boundary.payload!.formData.items;
}
function selectKind(label: string) {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: label }), { key: 'Enter' });
}
it('retains the deposit class when the amount and description change', async () => {
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={fixture()} />);
  fireEvent.change(screen.getByLabelText('Mô tả cọc'), { target: { value: 'Bổ sung bảo đảm' } });
  fireEvent.change(screen.getByLabelText('Số tiền cọc'), { target: { value: '2300000' } });
  expect((await save()).find(item => item.description === 'Bổ sung bảo đảm'))
    .toMatchObject({ accounting_class: 'DEPOSIT', unit_price: 2300000 });
});
it('allows removing and re-adding the deposit through the explicit Tiền cọc toggle', async () => {
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={fixture()} />);
  fireEvent.click(depositToggle());
  expect(screen.queryByLabelText('Mô tả cọc')).toBeNull();
  fireEvent.click(depositToggle());
  fireEvent.change(screen.getByLabelText('Số tiền cọc'), { target: { value: '2200000' } });
  expect((await save()).find(item => item.description === 'Tiền cọc'))
    .toMatchObject({ type: 'OTHER', accounting_class: 'DEPOSIT', unit_price: 2200000 });
});
it('does not infer a deposit from a revenue description containing cọc', async () => {
  const invoice = fixture();
  invoice.invoice_items![1] = { ...invoice.invoice_items![1]!, accounting_class: 'REVENUE', description: 'Phí xử lý cọc' };
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={invoice} />);
  expect(depositToggle().checked).toBe(false);
  expect(valueOf(screen.getByLabelText('Mô tả khoản thu'))).toBe('Phí xử lý cọc');
  const items = await save();
  expect(items.find(item => item.description === 'Phí xử lý cọc')).toMatchObject({ accounting_class: 'REVENUE' });
  expect(items.find(item => item.type === 'RENT')).toMatchObject({ accounting_class: 'REVENUE' });
});
it('changing the kind of an extra keeps its accounting class untouched', async () => {
  const invoice = fixture();
  invoice.invoice_items![1] = { ...invoice.invoice_items![1]!, type: 'SERVICE', description: 'Tiền nước bảo đảm' };
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={invoice} />);
  expect(depositToggle().checked).toBe(false);
  selectKind('Khác');
  expect((await save()).find(item => item.description === 'Tiền nước bảo đảm'))
    .toMatchObject({ type: 'OTHER', accounting_class: 'DEPOSIT' });
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

it('keeps every saved amount when a draft is saved untouched', async () => {
  render(<EditInvoiceDialog open onOpenChange={() => {}} invoice={fixture()} />);
  expect(screen.getByTestId('invoice-entry-total').textContent).toBe('7.490.000 đ');
  const items = await save();
  expect(items.map(item => [item.description, item.unit_price])).toEqual([
    ['Tiền thuê', 5290000],
    ['Tiền cọc', 2200000],
  ]);
});

it('creates a new deposit using the actual create form toggle', async () => {
  render(<GenerateInvoiceDialog open onOpenChange={() => {}} />);
  fireEvent.keyDown(screen.getAllByRole('combobox')[2]!, { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: 'DEMO-CONTRACT - DEMO' }), { key: 'Enter' });
  fireEvent.click(depositToggle());
  fireEvent.change(screen.getByLabelText('Số tiền cọc'), { target: { value: '2200000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo hoá đơn' }));
  await waitFor(() => expect(boundary.payload).not.toBeNull());
  expect(boundary.payload!.formData.items.find(item => item.description === 'Tiền cọc')).toMatchObject({
    type: 'OTHER', accounting_class: 'DEPOSIT', unit_price: 2200000,
  });
});
