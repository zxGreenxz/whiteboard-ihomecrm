import { z } from 'zod';

export const contractFormSchema = z.object({
  room_id: z.string().uuid('Vui lòng chọn phòng'),
  bed_id: z.string().uuid().nullable().optional(),
  signed_date: z.string().min(1, 'Ngày ký không được để trống'),
  start_date: z.string().min(1, 'Ngày bắt đầu không được để trống'),
  end_date: z.string().min(1, 'Ngày kết thúc không được để trống'),
  rent_price: z.number().min(0, 'Tiền thuê không được âm'),
  total_deposit: z.number().min(0, 'Tiền cọc không được âm'),
  deposit_paid: z.number().min(0).optional(),
  deposit_account_id: z.string().uuid().nullable().optional(),
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
);

export const renewFormSchema = z.object({
  new_end_date: z.string().min(1, 'Ngày kết thúc mới không được để trống'),
  new_rent_price: z.number().min(0, 'Tiền thuê không được âm').optional(),
  new_deposit: z.number().min(0, 'Tiền cọc không được âm').optional(),
  notes: z.string().optional(),
});

export const transferRoomFormSchema = z.object({
  new_room_id: z.string().uuid('Vui lòng chọn phòng mới'),
  new_bed_id: z.string().uuid().nullable().optional(),
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

export const terminateForfeitFormSchema = z.object({
  forfeit_date: z.string().min(1, 'Ngày bỏ cọc không được để trống'),
});

export const terminateMoveOutFormSchema = z.object({
  move_out_date: z.string().min(1, 'Ngày chuyển đi không được để trống'),
  deposit_refund: z.number().min(0, 'Tiền hoàn cọc không được âm'),
  penalty_fee: z.number().min(0).optional(),
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
