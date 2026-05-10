import { z } from 'zod';

// ============================================================
// Enums for Zod validation (matching @/types/invoice)
// ============================================================

const invoiceItemTypeEnum = z.enum(['RENT', 'SERVICE', 'PENALTY', 'DISCOUNT', 'OTHER']);

const paymentMethodEnum = z.enum(['TM', 'TK', 'TT']);

// ============================================================
// Invoice Item Schema
// ============================================================

const invoiceItemSchema = z.object({
  service_id: z.string().nullable().optional(),
  type: invoiceItemTypeEnum,
  description: z.string().min(1, 'Vui lòng nhập mô tả dịch vụ'),
  unit_price: z.number().min(0, 'Đơn giá phải >= 0'),
  quantity: z.number().gt(0, 'Số lượng phải > 0'),
  coefficient: z.number().gt(0, 'Hệ số phải > 0').default(1),
  previous_reading: z.number().nullable().optional(),
  current_reading: z.number().nullable().optional(),
  from_date: z.string().nullable().optional(),
  to_date: z.string().nullable().optional(),
  sort_order: z.number().int().optional(),
});

// ============================================================
// Invoice Form Schema (create/edit)
// ============================================================

export const invoiceFormSchema = z
  .object({
    building_id: z.string().min(1, 'Vui lòng chọn tòa nhà'),
    room_id: z.string().min(1, 'Vui lòng chọn phòng'),
    bed_id: z.string().nullable().optional(),
    contract_id: z.string().min(1, 'Vui lòng chọn hợp đồng'),
    billing_month: z.string().min(1, 'Vui lòng chọn kỳ thanh toán'),
    issue_date: z.string().min(1, 'Vui lòng chọn ngày lập'),
    due_date: z.string().min(1, 'Vui lòng chọn hạn thanh toán'),
    template_id: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    discount_amount: z.number().min(0).default(0),
    tax_percent: z.number().min(0).default(0),
    prepaid_amount: z.number().min(0).default(0),
    previous_debt: z.number().min(0).default(0),
    items: z.array(invoiceItemSchema).min(1, 'Vui lòng thêm ít nhất 1 dịch vụ'),
  })
  .refine((data) => data.issue_date <= data.due_date, {
    message: 'Ngày lập phải trước hoặc bằng hạn thanh toán',
    path: ['due_date'],
  });

export type InvoiceFormValues = z.infer<typeof invoiceFormSchema>;

// ============================================================
// Payment Form Schema
// ============================================================

export const paymentFormSchema = z.object({
  amount: z.number().gt(0, 'Số tiền phải > 0'),
  payment_method: paymentMethodEnum,
  payment_date: z.string().min(1, 'Vui lòng chọn ngày thu'),
  notes: z.string().nullable().optional(),
  receipt_image_url: z.string().nullable().optional(),
});

export type PaymentFormValues = z.infer<typeof paymentFormSchema>;

// ============================================================
// Auto-Generate Invoices Schema
// ============================================================

export const autoGenerateSchema = z.object({
  building_id: z.string().min(1, 'Vui lòng chọn tòa nhà'),
  billing_month: z.string().regex(/^\d{4}-\d{2}$/, 'Định dạng: YYYY-MM'),
  invoice_type: z.enum(['rent_only', 'service_only', 'both'], {
    required_error: 'Vui lòng chọn hình thức tạo hoá đơn',
  }),
});

export type AutoGenerateFormValues = z.infer<typeof autoGenerateSchema>;

// ============================================================
// Prepaid Validation Function
// ============================================================

interface PrepaidValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate số tiền trả trước (prepaid) dựa trên tiền thừa hiện có và tổng hoá đơn.
 */
export const prepaidValidation = (
  prepaid: number,
  excessBalance: number,
  totalAmount: number,
): PrepaidValidationResult => {
  if (prepaid < 0) {
    return { valid: false, error: 'Số tiền trả trước không được âm' };
  }
  if (prepaid > excessBalance) {
    return {
      valid: false,
      error: 'Số tiền trả trước không được vượt quá tiền thừa hiện có',
    };
  }
  if (prepaid > totalAmount) {
    return {
      valid: false,
      error: 'Số tiền trả trước không được vượt quá tổng hoá đơn',
    };
  }
  return { valid: true };
};
