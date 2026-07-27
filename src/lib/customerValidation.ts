import { z } from 'zod';

// ============================================================
// Customer Validation Schemas
// Matches design: discriminatedUnion on customer_type
// ============================================================

const phoneRegex = /^[0-9]{10,11}$/;

// ============================================================
// Individual Customer Schema
// ============================================================

export const customerIndividualSchema = z.object({
  customer_type: z.literal('INDIVIDUAL'),
  full_name: z.string().min(1, 'Họ tên không được để trống'),
  phone: z.string().regex(phoneRegex, 'Số điện thoại phải có 10-11 chữ số'),
  email: z.string().email('Email không hợp lệ').optional().or(z.literal('')),
  id_number: z.string().optional(),
  id_issue_date: z.string().optional(),
  id_issue_place: z.string().optional(),
  date_of_birth: z.string().optional(),
  gender: z.string().optional(),
  is_foreign: z.boolean().default(false),
  province: z.string().optional(),
  district: z.string().optional(),
  ward: z.string().optional(),
  detailed_address: z.string().optional(),
  current_residence: z.string().optional(),
  permanent_address: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_name: z.string().optional(),
  occupation: z.string().optional(),
  workplace: z.string().optional(),
  contact_person: z.string().optional(),
  contact_person_phone: z.string().optional(),
  advisor: z.string().optional(),
  advisor_phone: z.string().optional(),
  fingerprint_code: z.string().optional(),
  customer_group: z.string().optional(),
  notes: z.string().optional(),
  avatar_url: z.string().optional(),
  id_images: z.record(z.string()).optional(),
  vehicles: z
    .array(
      z.object({
        vehicle_type: z.string(),
        vehicle_name: z.string(),
        color: z.string().optional(),
        license_plate: z.string(),
      }),
    )
    .optional(),
});

// ============================================================
// Organization Customer Schema
// ============================================================

export const customerOrganizationSchema = z.object({
  customer_type: z.literal('ORGANIZATION'),
  company_name: z.string().min(1, 'Tên công ty không được để trống'),
  full_name: z.string().optional().default(''),
  phone: z.string().regex(phoneRegex, 'Số điện thoại phải có 10-11 chữ số'),
  email: z.string().email('Email không hợp lệ').optional().or(z.literal('')),
  representative: z.string().optional(),
  business_registration_url: z.string().optional(),
  headquarters_address: z.string().optional(),
  is_foreign: z.boolean().default(false),
  province: z.string().optional(),
  district: z.string().optional(),
  ward: z.string().optional(),
  detailed_address: z.string().optional(),
  current_residence: z.string().optional(),
  permanent_address: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_name: z.string().optional(),
  contact_person: z.string().optional(),
  contact_person_phone: z.string().optional(),
  advisor: z.string().optional(),
  advisor_phone: z.string().optional(),
  customer_group: z.string().optional(),
  notes: z.string().optional(),
  avatar_url: z.string().optional(),
  id_images: z.record(z.string()).optional(),
  vehicles: z
    .array(
      z.object({
        vehicle_type: z.string(),
        vehicle_name: z.string(),
        color: z.string().optional(),
        license_plate: z.string(),
      }),
    )
    .optional(),
});

// ============================================================
// Discriminated Union Schema
// ============================================================

export const customerSchema = z.discriminatedUnion('customer_type', [
  customerIndividualSchema,
  customerOrganizationSchema,
]);

export type CustomerFormValues = z.infer<typeof customerSchema>;
