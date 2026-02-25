import type { Customer, CT01FormData } from '@/types/customer';

/**
 * Auto-fill CT01FormData from a Customer record.
 * Maps overlapping fields; required fields with no customer data default to empty string.
 * Requirements: 6.3
 */
export function autoFillCT01FromCustomer(customer: Customer): CT01FormData {
  return {
    registration_authority: '',
    full_name: customer.full_name ?? '',
    date_of_birth: customer.date_of_birth ?? '',
    gender: customer.gender ?? '',
    id_number: customer.id_number ?? '',
    phone: customer.phone ?? undefined,
    email: customer.email ?? undefined,
    permanent_address: customer.permanent_address ?? undefined,
    temporary_address: undefined,
    current_address: customer.current_residence ?? undefined,
    occupation_workplace:
      [customer.occupation, customer.workplace].filter(Boolean).join(' - ') || undefined,
    household_head_name: undefined,
    household_head_relationship: undefined,
    household_head_id_number: undefined,
    request_content: undefined,
    family_members: [],
  };
}

/**
 * Generate a unique CT01 declaration code in the format "CT01-YYYYMMDD-XXXX".
 */
export function generateCT01Code(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `CT01-${yyyy}${mm}${dd}-${rand}`;
}
