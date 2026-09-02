import { z } from 'zod';
import type { CT01FormData } from '@/types/customer';

// ============================================================
// CT01 Family Member Schema
// ============================================================

const ct01FamilyMemberSchema = z.object({
  full_name: z.string().min(1),
  date_of_birth: z.string().min(1),
  gender: z.string().min(1),
  id_number: z.string(),
  occupation_workplace: z.string(),
  relationship_to_declarant: z.string(),
  relationship_to_household_head: z.string(),
});

// ============================================================
// CT01 Declaration Schema
// ============================================================

export const ct01Schema = z.object({
  registration_authority: z.string().min(1, 'Cơ quan đăng ký cư trú không được để trống'),
  full_name: z.string().min(1, 'Họ tên không được để trống'),
  date_of_birth: z.string().min(1, 'Ngày sinh không được để trống'),
  gender: z.string().min(1, 'Giới tính không được để trống'),
  id_number: z.string().min(1, 'Số CMND/CCCD không được để trống'),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  permanent_address: z.string().optional(),
  temporary_address: z.string().optional(),
  current_address: z.string().optional(),
  occupation_workplace: z.string().optional(),
  household_head_name: z.string().optional(),
  household_head_relationship: z.string().optional(),
  household_head_id_number: z.string().optional(),
  request_content: z.string().optional(),
  family_members: z.array(ct01FamilyMemberSchema).default([]),
});

export type CT01FormValues = z.infer<typeof ct01Schema>;

/**
 * tsconfig.app.json tắt strictNullChecks nên z.infer coi MỌI field là optional,
 * không gán thẳng được vào CT01FormData (field bắt buộc). Zod đã bảo đảm các
 * field bắt buộc non-empty ở runtime (.min(1)); hàm này chỉ chuẩn hoá hình dạng,
 * không ép kiểu.
 */
export function toCT01FormData(values: CT01FormValues): CT01FormData {
  return {
    registration_authority: values.registration_authority ?? '',
    full_name: values.full_name ?? '',
    date_of_birth: values.date_of_birth ?? '',
    gender: values.gender ?? '',
    id_number: values.id_number ?? '',
    phone: values.phone,
    email: values.email,
    permanent_address: values.permanent_address,
    temporary_address: values.temporary_address,
    current_address: values.current_address,
    occupation_workplace: values.occupation_workplace,
    household_head_name: values.household_head_name,
    household_head_relationship: values.household_head_relationship,
    household_head_id_number: values.household_head_id_number,
    request_content: values.request_content,
    family_members: (values.family_members ?? []).map((m) => ({
      full_name: m.full_name ?? '',
      date_of_birth: m.date_of_birth ?? '',
      gender: m.gender ?? '',
      id_number: m.id_number ?? '',
      occupation_workplace: m.occupation_workplace ?? '',
      relationship_to_declarant: m.relationship_to_declarant ?? '',
      relationship_to_household_head: m.relationship_to_household_head ?? '',
    })),
  };
}
