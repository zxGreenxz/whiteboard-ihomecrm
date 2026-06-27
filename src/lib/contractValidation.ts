import { z } from 'zod';
import { validateFirstBillingPeriod } from '@/lib/firstInvoiceBuilder';

export const contractFormSchema = z.object({
  room_id: z.string().uuid('Vui lòng chọn phòng'),
  signed_date: z.string().min(1, 'Ngày ký không được để trống'),
  start_date: z.string().min(1, 'Ngày bắt đầu không được để trống'),
  end_date: z.string().min(1, 'Ngày kết thúc không được để trống'),
  rent_price: z.number().min(0, 'Tiền thuê không được âm'),
  total_deposit: z.number().min(0, 'Tiền cọc không được âm'),
  deposit_paid: z.number().min(0).optional(),
  deposit_account_id: z.string().uuid().nullable().optional(),
  // Xử lý thiếu cọc khi ký (chặn ở form + hook nếu chưa chọn cách xử lý).
  // mode: 'DEBT' = nợ cọc (có lý do/hẹn) | 'FIRST_INVOICE' = thu đủ ở hoá đơn đầu.
  deposit_debt_acknowledged: z.boolean().optional(),
  deposit_debt_mode: z.enum(['DEBT', 'FIRST_INVOICE']).optional(),
  deposit_debt_reason: z.string().optional(),
  deposit_topup_due_date: z.string().optional(),
  payment_cycle: z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL']),
  start_billing_date: z.string().optional(),
  end_billing_date: z.string().optional(),
  contract_template_id: z.string().uuid().nullable().optional(),
  invoice_template_id: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
  discount_months: z.number().int().min(0).optional(),
  discount_amount_per_month: z.number().min(0).optional(),
}).refine(
  (data) => new Date(data.end_date) > new Date(data.start_date),
  { message: 'Ngày kết thúc phải sau ngày bắt đầu', path: ['end_date'] }
).superRefine((data, ctx) => {
  // Kỳ tính tiền tháng đầu phải đủ tới hết tháng từ ngày bắt đầu tính tiền
  // (chỉ chặn khi quản lý đã chọn "Đến ngày").
  if (!data.end_billing_date) return;
  const res = validateFirstBillingPeriod(
    data.start_billing_date || data.start_date,
    data.end_billing_date,
  );
  if (!res.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: res.message ?? 'Kỳ tính tiền tháng đầu không hợp lệ',
      path: ['end_billing_date'],
    });
  }
});

export const renewFormSchema = z.object({
  new_end_date: z.string().min(1, 'Ngày kết thúc mới không được để trống'),
  new_rent_price: z.number().min(0, 'Tiền thuê không được âm').optional(),
  new_deposit: z.number().min(0, 'Tiền cọc không được âm').optional(),
  notes: z.string().optional(),
});

export const transferRoomFormSchema = z.object({
  new_room_id: z.string().uuid('Vui lòng chọn phòng mới'),
  new_rent_price: z.number().min(0).optional(),
  transfer_date: z.string().min(1, 'Ngày chuyển không được để trống'),
  notes: z.string().optional(),
});

export const moveOutFormSchema = z.object({
  expected_move_out_date: z.string().min(1, 'Ngày chuyển đi không được để trống'),
  notes: z.string().optional(),
});

export const transferContractFormSchema = z.object({
  new_customer_id: z.string().uuid('Vui lòng chọn khách hàng mới'),
  new_rent_price: z.number().min(0).optional(),
  new_deposit: z.number().min(0).optional(),
  transfer_date: z.string().min(1, 'Ngày nhượng không được để trống'),
  notes: z.string().optional(),
});

// Một dòng "Thu thêm" khi thanh lý (tiền phòng ngày ở thêm / điện / vệ sinh /
// khoản tuỳ ý). Gửi xuống RPC dưới dạng mảng jsonb p_extra_charges.
//  - PRORATED: tiền phòng+nước+PDV theo `days` ngày ở thêm.
//  - ELECTRIC: tiền điện chốt cuối kỳ (kèm chỉ số + meter để ghi meter_readings).
//  - CLEANING: tiền vệ sinh (mặc định 200k).
//  - CUSTOM:   khoản tuỳ ý {tên, số tiền}.
export const extraChargeItemSchema = z.object({
  kind: z.enum(['PRORATED', 'ELECTRIC', 'CLEANING', 'CUSTOM']),
  description: z.string().min(1, 'Tên khoản thu không được để trống'),
  amount: z.number().min(0, 'Số tiền không được âm'),
  days: z.number().min(0).optional(),
  previous_reading: z.number().min(0).optional(),
  current_reading: z.number().min(0).optional(),
  unit_price: z.number().min(0).optional(),
  meter_id: z.string().uuid().nullable().optional(),
});
export type ExtraChargeItem = z.infer<typeof extraChargeItemSchema>;

export const terminateForfeitFormSchema = z.object({
  forfeit_date: z.string().min(1, 'Ngày bỏ cọc không được để trống'),
});

export const terminateMoveOutFormSchema = z.object({
  move_out_date: z.string().min(1, 'Ngày chuyển đi không được để trống'),
  deposit_refund: z.number().min(0, 'Tiền hoàn cọc không được âm'),
  excess_rent: z.number().min(0).optional(),
  notes: z.string().optional(),
});

export type ContractFormData = z.infer<typeof contractFormSchema>;
export type RenewFormData = z.infer<typeof renewFormSchema>;
export type TransferRoomFormData = z.infer<typeof transferRoomFormSchema>;
export type MoveOutFormData = z.infer<typeof moveOutFormSchema>;
export type TransferContractFormData = z.infer<typeof transferContractFormSchema>;
export type TerminateForfeitFormData = z.infer<typeof terminateForfeitFormSchema>;
export type TerminateMoveOutFormData = z.infer<typeof terminateMoveOutFormSchema>;
