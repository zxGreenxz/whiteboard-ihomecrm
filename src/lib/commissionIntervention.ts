import { isCommissionType } from '@/lib/managerSalary';

export interface CommissionVoucherLike {
  type?: string | null;
  system_source?: string | null;
  commission_kind?: string | null;
  items?: readonly { type_name?: string | null; category?: string | null }[] | null;
}

export function isCommissionVoucher(voucher: CommissionVoucherLike | null | undefined): boolean {
  return !!voucher && voucher.type === 'EXPENSE' && (
    voucher.system_source === 'contract.commission' ||
    voucher.commission_kind === 'broker' || voucher.commission_kind === 'sale' ||
    !!voucher.items?.some(item => isCommissionType({ category: item.category, name: item.type_name }))
  );
}
