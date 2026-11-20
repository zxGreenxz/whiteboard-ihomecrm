// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { readContractTransferLinks, type ContractTransferLink } from '@/lib/contract-lifecycle/transfers';
import { ContractTransferLinkPanel } from '../ContractTransferLinkPanel';

const state = vi.hoisted(() => ({ links: [] as ContractTransferLink[] }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'test-org' }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({}) }));
vi.mock('@/hooks/contracts/useContractTransferLinks', () => ({
  useContractTransferLinks: () => ({ data: state.links }),
  useCancelContractTransferLink: () => ({}),
}));
afterEach(cleanup);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base: ContractTransferLink = {
  id: id(1), organization_id: id(2), building_id: id(3), room_id: id(4), old_contract_id: id(5), old_exit_case_id: id(6),
  new_draft_id: id(7), new_draft_revision: 1, new_contract_id: id(8), old_contract_number: 'HD-CU', new_contract_number: 'HD-MOI',
  old_customer_name: 'Khách cũ', new_customer_name: 'Khách mới', mode: 'BROKER', deposit_mode: 'NEW_PAYMENT',
  term_mode: 'NEW_TERM', starts_on: '2026-11-01', ends_on: '2027-11-01', broker_name: 'Môi giới',
  deposit_base: 0, broker_fee: 0, fee_state: 'APPLIED', commission_voucher_id: null, commission_code: null,
  commission_approval_status: null, state: 'LINKED', version: 2, money_state: 'COMMISSION_PENDING',
  created_at: '2026-11-01', reason: 'Khách nhượng phòng', history: [],
};
async function show(overrides: Partial<ContractTransferLink> = {}) {
  const result = { ...base, ...overrides };
  state.links = await readContractTransferLinks(async () => ({ data: [result], error: null }), { contractId: base.old_contract_id }, base.organization_id);
  render(<MemoryRouter><ContractTransferLinkPanel contractId={base.old_contract_id} canEdit /></MemoryRouter>);
}

it.each([
  { no_commission_due: true, deposit_base: null, broker_fee: null },
  { deposit_base: 0, broker_fee: 0 },
])('nhận diện phí 0 với số tiền bị ẩn hoặc phản hồi v1 cũ', async fields => {
  await show(fields);
  expect(screen.getByText(/Không phát sinh hoa hồng môi giới/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Lập / nối phiếu môi giới' })).toBeNull();
});
it('giữ nút lập phiếu khi đủ điều kiện và có hoa hồng', async () => {
  await show({ deposit_base: 4_000_000, broker_fee: 2_000_000, money_state: 'COMMISSION_PENDING' });
  expect(screen.getByRole('button', { name: 'Lập / nối phiếu môi giới' })).toBeTruthy();
});
it('cho biết nháp cũ đã ký cần đối soát và chỉ cho xem lịch sử', async () => {
  await show({ new_contract_id: null, new_contract_number: null, fee_state: 'PENDING', signed_needs_review: true, money_state: 'NEEDS_REVIEW' });
  expect(screen.getByText(/Nháp v1 đã ký · Cần đối soát/)).toBeTruthy();
  expect(screen.queryByText(/Chưa ký/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Hủy liên kết' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Lập / nối phiếu môi giới' })).toBeNull();
});
