import type { ContractExitEarlyTerms } from '@/lib/contractExitEarlyTerms';

export const EXIT_FIXTURE_IDS = {
  org: '10000000-0000-4000-8000-000000000001',
  room: '10000000-0000-4000-8000-000000000002',
  oldContract: '10000000-0000-4000-8000-000000000003',
  newContract: '10000000-0000-4000-8000-000000000004',
  exitCase: '10000000-0000-4000-8000-000000000005',
  building: '10000000-0000-4000-8000-000000000006',
  actor: '10000000-0000-4000-8000-000000000007',
};

/** Một dòng đọc `read_contract_exit_early_terms_v1` đủ trường theo schema; mặc định ca nhờ sale còn chờ nối. */
export function exitTermsRow(overrides: Partial<ContractExitEarlyTerms> = {}): ContractExitEarlyTerms {
  const id = EXIT_FIXTURE_IDS;
  return {
    exit_case_id: id.exitCase, contract_id: id.oldContract, organization_id: id.org, building_id: id.building, room_id: id.room,
    early_reason: 'SALE_ASSISTED', sale_name: 'Minh', deposit_base: 4_000_000, broker_fee: 2_000_000, fee_applied_at: null,
    hold_until: '2026-12-04', reopened_at: null, reopened_by: null, reopened_by_name: null, expiry_notified_at: null,
    new_contract_id: null, new_contract_number: null, linked_at: null, new_contract_deposit_paid: null,
    new_contract_total_deposit: null, new_contract_start_date: null, new_contract_billing_start: null,
    support_amount: 0, commission_voucher_id: null, commission_code: null, commission_approval_status: null,
    version: 1, created_by: id.actor, created_by_name: 'Quản lý', created_at: '2026-11-24T02:00:00Z', updated_at: '2026-11-24T02:00:00Z',
    old_contract_number: 'HD-0101', old_customer_name: 'Nguyễn Văn A', building_name: 'Toà A', room_name: 'P101',
    actual_move_out_on: '2026-12-01', exit_state: 'PENDING', exit_version: 1, current_kind: 'EARLY_RETURN',
    old_contract_deposit_paid: 4_000_000, pending_link: true, hold_open: true, history: [],
    ...overrides,
  };
}

/** Dòng đã nối: hợp đồng `newContract` là khách nhận. */
export function linkedExitTermsRow(overrides: Partial<ContractExitEarlyTerms> = {}) {
  return exitTermsRow({ new_contract_id: EXIT_FIXTURE_IDS.newContract, new_contract_number: 'HD-0202', linked_at: '2026-11-25T02:00:00Z',
    pending_link: false, ...overrides });
}
