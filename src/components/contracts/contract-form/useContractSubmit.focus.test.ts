// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { ContractFormData } from '@/lib/contractValidation';
import type { ContractFormState } from './useContractFormState';
import { useContractSubmit } from './useContractSubmit';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { document.body.innerHTML = ''; });

it('marks missing customers and focuses the chooser within the contract dialog', async () => {
  document.body.innerHTML = '<div data-slot="dialog-content"><div data-field-name="customers"><button type="button">Thêm khách hàng</button></div></div>';
  const setError = vi.fn();
  const state = { form: { setError }, selectedCustomers: [] } as unknown as ContractFormState;
  const submit = useContractSubmit({ state, onOpenChange: vi.fn() });
  submit({} as ContractFormData);
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Thêm khách hàng'));
  expect(setError).toHaveBeenCalledWith('customers', expect.objectContaining({ type: 'server' }));
});

it('places a verified room conflict on the room selector and focuses it', async () => {
  document.body.innerHTML = '<div data-slot="dialog-content"><div data-field-name="room_id"><button type="button">Chọn phòng</button></div></div>';
  const setError = vi.fn();
  const createContract = { mutate: vi.fn((_request, callbacks) => callbacks.onError({ code: '23505', message: 'Phòng đã có hợp đồng đang hiệu lực' })) };
  const state = {
    isEditMode: false, form: { setError },
    selectedCustomers: [{ id: '22222222-2222-4222-8222-222222222222', is_representative: true }],
    selectedServices: [], useCustomServices: false, createContract,
    typedDepositTotal: 0, approvedOrphanTotal: 0, orphanDepositVouchers: [],
    refetchOrphanDepositVouchers: vi.fn().mockResolvedValue({ error: null }),
    invoiceItems: [], firstInvoiceDiscount: { amount: 0, notes: null }, depositRows: [],
  } as unknown as ContractFormState;
  const submit = useContractSubmit({ state, onOpenChange: vi.fn() });
  submit({ room_id: '11111111-1111-4111-8111-111111111111', signed_date: '2026-09-01',
    start_date: '2026-09-01', end_date: '2027-08-31', start_billing_date: '2026-09-01',
    end_billing_date: '2026-09-30', rent_price: 4_000_000, total_deposit: 0,
    payment_cycle: 'MONTHLY' } as ContractFormData);
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Chọn phòng'));
  expect(setError).toHaveBeenCalledWith('room_id', expect.objectContaining({ type: 'server', message: 'Phòng đã có hợp đồng hiệu lực.' }));
});
