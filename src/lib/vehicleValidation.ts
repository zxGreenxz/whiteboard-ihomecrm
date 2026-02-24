import { z } from 'zod';

// ============================================================
// Vehicle Validation Schema
// ============================================================

export const vehicleSchema = z.object({
  vehicle_type: z.enum(['MOTORBIKE', 'CAR', 'BICYCLE', 'ELECTRIC_BIKE', 'OTHER']),
  vehicle_name: z.string().min(1, 'Tên dòng xe không được để trống'),
  color: z.string().min(1, 'Màu xe không được để trống'),
  license_plate: z.string().min(1, 'Biển số xe không được để trống'),
  owner_name: z.string().min(1, 'Tên chủ xe không được để trống'),
  ticket_number: z.string().optional(),
  building_id: z.string().uuid().optional(),
  room_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  image_url: z.string().url().optional().or(z.literal('')),
});

export type VehicleFormValues = z.infer<typeof vehicleSchema>;

// ============================================================
// Image Upload Validation
// ============================================================

export const imageValidation = {
  acceptedFormats: ['image/png', 'image/jpeg', 'image/jpg'],
  maxSizeMB: 10,
  maxSizeBytes: 10 * 1024 * 1024,

  validate(file: File): { valid: boolean; error?: string } {
    if (!this.acceptedFormats.includes(file.type)) {
      return { valid: false, error: 'Chỉ chấp nhận file PNG, JPG, JPEG' };
    }
    if (file.size > this.maxSizeBytes) {
      return { valid: false, error: 'Kích thước file tối đa 10MB' };
    }
    return { valid: true };
  },
};
