import { z } from 'zod';

export const commissionTierSchema = z.object({
  min_months: z.number().min(0),
  max_months: z.number().min(0),
  rate_percent: z.number().min(0).max(100),
}).refine((d) => d.min_months <= d.max_months, {
  message: 'Tháng bắt đầu phải <= tháng kết thúc',
});

export const DEFAULT_COMMISSION_TIERS_DATA = [
  { min_months: 5, max_months: 6, rate_percent: 50 },
  { min_months: 10, max_months: 12, rate_percent: 60 },
];

export const buildingSchema = z.object({
  name: z.string().min(1, 'Tên toà nhà không được để trống'),
  code: z.string().optional().or(z.literal('')),
  province: z.string().min(1, 'Tỉnh/Thành phố không được để trống'),
  district: z.string().min(1, 'Quận/Huyện không được để trống'),
  ward: z.string().min(1, 'Xã/Phường không được để trống'),
  street_address: z.string().min(1, 'Địa chỉ chi tiết không được để trống'),
  area_id: z.string().uuid().optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  contract_template_id: z.string().uuid().nullable().optional(),
  invoice_template_id: z.string().uuid().nullable().optional(),
  default_account_id_tt: z.string().uuid().nullable().optional(),
  default_account_id_tk: z.string().uuid().nullable().optional(),
  commission_tiers: z.array(commissionTierSchema).default(DEFAULT_COMMISSION_TIERS_DATA),
});

export const buildingServiceSchema = z.object({
  service_id: z.string().uuid(),
  is_active: z.boolean(),
  unit_price_override: z.number().min(0, 'Đơn giá không được âm').nullable(),
});

export type BuildingFormData = z.infer<typeof buildingSchema>;
export type BuildingServiceValidation = z.infer<typeof buildingServiceSchema>;
