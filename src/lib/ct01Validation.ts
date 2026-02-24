import { z } from 'zod';

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
