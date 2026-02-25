import { z } from 'zod';

export const buildingSchema = z.object({
  name: z.string().min(1, 'Tên toà nhà không được để trống'),
  code: z.string().optional().or(z.literal('')),
  province: z.string().min(1, 'Tỉnh/Thành phố không được để trống'),
  district: z.string().min(1, 'Quận/Huyện không được để trống'),
  ward: z.string().min(1, 'Xã/Phường không được để trống'),
  street_address: z.string().min(1, 'Địa chỉ chi tiết không được để trống'),
  area_id: z.string().uuid().optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const buildingServiceSchema = z.object({
  service_id: z.string().uuid(),
  is_active: z.boolean(),
  unit_price_override: z.number().min(0, 'Đơn giá không được âm').nullable(),
});

export type BuildingFormData = z.infer<typeof buildingSchema>;
export type BuildingServiceValidation = z.infer<typeof buildingServiceSchema>;
