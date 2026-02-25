import { z } from 'zod';

export const roomSchema = z.object({
  building_id: z.string().uuid('Vui lòng chọn toà nhà'),
  floor: z.number().int().positive('Vui lòng chọn tầng'),
  name: z.string().min(1, 'Tên phòng không được để trống'),
  rent_price: z.number().min(0, 'Tiền thuê không được âm'),
  deposit_amount: z.number().min(0, 'Tiền cọc không được âm'),
  area: z.number().positive('Diện tích phải là số dương').nullable().optional(),
  max_occupants: z.number().int().positive('Số khách tối đa phải là số nguyên dương').nullable().optional(),
  status: z.enum(['AVAILABLE', 'OCCUPIED', 'RESERVED', 'MAINTENANCE', 'UNAVAILABLE']).default('AVAILABLE'),
  invoice_template_id: z.string().uuid().nullable().optional(),
  lease_template_id: z.string().uuid().nullable().optional(),
});

export type RoomFormData = z.infer<typeof roomSchema>;
