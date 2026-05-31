import { z } from 'zod';

// Schema cho hạng mục (item) trong phiếu thu/chi
export const itemSchema = z.object({
  income_expense_type_id: z.string().min(1, 'Vui lòng chọn loại hạng mục'),
  description: z.string().nullable().optional(),
  quantity: z.number().int().min(1, 'Số lượng phải >= 1'),
  unit_price: z.number().min(0, 'Đơn giá phải >= 0'),
  start_date: z.string().min(1, 'Vui lòng chọn ngày bắt đầu'),
  end_date: z.string().min(1, 'Vui lòng chọn ngày kết thúc'),
}).refine(
  (data) => data.start_date <= data.end_date,
  { message: 'Ngày bắt đầu không được sau ngày kết thúc', path: ['end_date'] }
);

// Schema cho form Phiếu thu/chi
export const incomeExpenseFormSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE'], {
    required_error: 'Vui lòng chọn loại phiếu',
  }),
  name: z.string().min(1, 'Vui lòng nhập tên phiếu'),
  building_id: z.string().min(1, 'Vui lòng chọn căn hộ'),
  room_id: z.string().nullable().optional(),
  tenant_id: z.string().nullable().optional(),
  // Hợp đồng liên quan — bắt buộc cho phiếu cọc nếu HĐ đã tồn tại, optional
  // cho các loại khác. Nếu phòng có HĐ ACTIVE và user tạo cọc thì sẽ tự
  // prefill; với cọc trước HĐ thì để null, trigger DB sẽ tự link khi HĐ
  // được tạo.
  contract_id: z.string().nullable().optional(),
  payer_name: z.string().nullable().optional(),
  account_id: z.string().min(1, 'Vui lòng chọn tài khoản'),
  voucher_date: z.string().min(1, 'Vui lòng chọn ngày'),
  // null = tự động (DB suy theo hạng mục cọc → cọc không tính KQKD);
  // true/false = override tay. Mặc định null (auto).
  business_result_accounting: z.boolean().nullable().default(null),
  attachments: z.array(z.string()).default([]),
  // Cài đặt lặp lại (mirror Resident "Cài đặt lặp lại")
  repeat_cycle: z
    .enum(['NONE', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'])
    .default('NONE')
    .optional(),
  repeat_infinity: z.boolean().default(false).optional(),
  repeat_count: z.coerce.number().int().min(0).default(0).optional(),
  items: z.array(itemSchema).min(1, 'Vui lòng thêm ít nhất 1 hạng mục'),
});

export type IncomeExpenseFormValues = z.infer<typeof incomeExpenseFormSchema>;

// Schema cho Loại thu chi
export const incomeExpenseTypeFormSchema = z.object({
  name: z.string().min(1, 'Vui lòng nhập tên loại'),
  type: z.enum(['income', 'expense'], {
    required_error: 'Vui lòng chọn loại',
  }),
  category: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  is_default: z.boolean().optional().default(false),
});

export type IncomeExpenseTypeFormValues = z.infer<typeof incomeExpenseTypeFormSchema>;

// Schema cho Mẫu in thu chi
export const incomeExpenseTemplateFormSchema = z.object({
  name: z.string().min(1, 'Vui lòng nhập tên mẫu'),
  description: z.string().nullable().optional(),
  template_file_url: z.string().nullable().optional(),
  is_default: z.boolean().optional().default(false),
  is_income_template: z.boolean().optional().default(false),
  field_mappings: z.record(z.string()).nullable().optional(),
});

export type IncomeExpenseTemplateFormValues = z.infer<typeof incomeExpenseTemplateFormSchema>;

// Schema cho dòng import Excel
export const excelImportRowSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE']),
  building_name: z.string().min(1, 'Căn hộ không được trống'),
  room_name: z.string().optional(),
  name: z.string().min(1, 'Tên phiếu không được trống'),
  voucher_date: z.string().min(1, 'Ngày không được trống'),
  item_name: z.string().min(1, 'Hạng mục không được trống'),
  amount: z.number().min(0, 'Số tiền phải >= 0'),
});

export type ExcelImportRow = z.infer<typeof excelImportRowSchema>;

// Validation: tổng tiền = tổng các hạng mục
export const validateTotalAmount = (
  items: Array<{ quantity: number; unit_price: number }>
): number => {
  return items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
};

// Phiếu sau khi tạo là chốt — không cho sửa nội dung. Chỉ có thể Huỷ.
// (Giữ hàm để các component cũ vẫn import được nếu cần.)
export const canEditVoucher = (_status: string): boolean => {
  return false;
};

// =============================================
// Phiếu Thu/Chi Tổng (Batch)
// =============================================

// Mỗi hạng mục trong phiếu tổng = 1 phiếu lẻ sẽ được sinh ra,
// nên hạng mục có riêng building/room (khác với schema phiếu lẻ thường).
export const batchItemSchema = z
  .object({
    building_id: z.string().min(1, 'Vui lòng chọn tòa nhà'),
    room_id: z.string().nullable().optional(),
    income_expense_type_id: z.string().min(1, 'Vui lòng chọn loại hạng mục'),
    type_name: z.string().optional(),
    description: z.string().nullable().optional(),
    quantity: z.number().int().min(1).default(1),
    unit_price: z.number().min(0, 'Số tiền phải >= 0'),
    start_date: z.string().min(1, 'Vui lòng chọn ngày bắt đầu'),
    end_date: z.string().min(1, 'Vui lòng chọn ngày kết thúc'),
  })
  .refine((data) => data.start_date <= data.end_date, {
    message: 'Ngày bắt đầu không được sau ngày kết thúc',
    path: ['end_date'],
  });

export const incomeExpenseBatchFormSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE'], {
    required_error: 'Vui lòng chọn loại phiếu',
  }),
  shared_name: z.string().min(1, 'Vui lòng nhập tên phiếu chung'),
  account_id: z.string().min(1, 'Vui lòng chọn sổ quỹ'),
  voucher_date: z.string().min(1, 'Vui lòng chọn ngày'),
  payer_name: z.string().nullable().optional(),
  // null = tự động (theo hạng mục cọc); true/false = override tay.
  business_result_accounting: z.boolean().nullable().default(null),
  attachments: z.array(z.string()).default([]),
  notes: z.string().nullable().optional(),
  items: z.array(batchItemSchema).min(1, 'Vui lòng thêm ít nhất 1 hạng mục'),
});

export type IncomeExpenseBatchFormValues = z.infer<typeof incomeExpenseBatchFormSchema>;
