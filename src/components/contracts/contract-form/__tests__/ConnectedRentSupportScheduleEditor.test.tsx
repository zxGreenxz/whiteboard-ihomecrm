// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { Form } from '@/components/ui/form';
import type { ContractFormData } from '@/lib/contractValidation';
const mocks = vi.hoisted(() => ({ register: vi.fn(), view: true, create: true, read: undefined as unknown }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: (_: unknown, _module: string, action: string) => action === 'view' ? mocks.view : mocks.create }));
vi.mock('@/hooks/useContractRentSupport', () => ({ useContractRentSupport: () => ({ data: mocks.read }) }));
vi.mock('@/hooks/useRentSupportParties', () => ({ useRentSupportParties: () => ({ data: [{ party_id: null, profile_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'INTERNAL', display_name: 'Sale nhân sự' }], register: { mutateAsync: mocks.register, isPending: false }, isFetching: false, isError: false }) }));
import { ConnectedRentSupportScheduleEditor } from '../ConnectedRentSupportScheduleEditor';
function Harness() {
  const form = useForm<ContractFormData>({ defaultValues: { start_date: '2026-09-20', end_date: '2027-09-20', start_billing_date: '2026-09-20', end_billing_date: '2026-10-05', rent_price: 4000000,
    rent_support: { version: 2, start_billing_month: '2026-09', payer: 'SALE', sale_party_id: null, deduction_policy: 'COMMISSION_ONLY', collection_mode: 'UPFRONT_COMMITTED', segments: [{ month_count: 3, monthly_amount: '300000' }] } } });
  return <Form {...form}><ConnectedRentSupportScheduleEditor form={form} buildingId="cccccccc-cccc-4ccc-8ccc-cccccccccccc"/><output aria-label="Party được lưu">{form.watch('rent_support')?.sale_party_id ?? 'chưa chọn'}</output></Form>;
}
beforeEach(() => { mocks.register.mockReset(); mocks.view = true; mocks.create = true; mocks.read = undefined; });
afterEach(cleanup);
it('configures Sale support without selecting or registering a recipient', () => {
  render(<Harness/>);
  expect(screen.queryByLabelText('Sale chịu hỗ trợ')).toBeNull();
  expect(screen.queryByLabelText('Tên người nhận ngoài nhân sự')).toBeNull();
  expect(screen.queryByText('Chọn và xác minh danh tính Sale trước khi lưu.')).toBeNull();
  expect(screen.getByLabelText('Nguồn khấu trừ')).toBeTruthy();
  expect(mocks.register).not.toHaveBeenCalled();
});
it('hides funding controls for a contract-only reader', () => {
  mocks.view = false; render(<Harness/>);
  expect(screen.queryByLabelText('Người chịu hỗ trợ')).toBeNull(); expect(screen.queryByLabelText('Nguồn khấu trừ')).toBeNull();
  expect(screen.getByText(/Cần quyền tài chính/)).toBeTruthy();
});
