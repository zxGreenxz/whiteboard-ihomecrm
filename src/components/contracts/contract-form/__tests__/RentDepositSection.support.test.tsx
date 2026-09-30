// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { Form } from '@/components/ui/form';
import type { ContractFormData } from '@/lib/contractValidation';
import type { ContractFormState } from '../useContractFormState';
import { describeDepositAdjustment } from '@/lib/contractPriceAdjustment';
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => false }));
import { RentDepositSection } from '../RentDepositSection';
afterEach(cleanup);
function Harness() {
  const form = useForm<ContractFormData>({ defaultValues: { rent_price: 4000000, total_deposit: 4000000, payment_cycle: 'MONTHLY', discount_months: 3, discount_amount_per_month: 300000 } });
  const state = { form, isEditMode: false, selectedBuildingId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', roomDefaultRent: 4000000,
    depositAdjustment: describeDepositAdjustment(4000000, 4000000), depositRows: [], orphanDepositVouchers: [], accounts: [] } as unknown as ContractFormState;
  return <Form {...form}><RentDepositSection {...state}/></Form>;
}
it('does not let a contract-only editor fabricate a funding payer while converting legacy discounts', () => {
  render(<Harness/>);
  expect(screen.queryByRole('button', { name: 'Đối chiếu và chuyển sang lịch hỗ trợ' })).toBeNull();
  expect(screen.getByText(/Giảm tiền thuê cũ/)).toBeTruthy();
});
