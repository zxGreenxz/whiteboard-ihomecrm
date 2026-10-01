// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyContractDraftPayload, type ContractDraft } from '@/lib/contractDrafts';
import type { ContractFormState } from '../contract-form/useContractFormState';
import { ContractFormDialog } from '../ContractFormDialog';

const fixtures = vi.hoisted(() => ({ rows: [], save: vi.fn(), submit: vi.fn() }));
vi.mock('@/hooks/useContracts', () => ({ useCreateContract: () => ({ isPending: false }),
  useUpdateContract: () => ({ isPending: false }), useSyncContractCustomers: () => ({ isPending: false }),
  useSyncContractServices: () => ({ isPending: false }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: fixtures.rows }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => ({ data: fixtures.rows }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: fixtures.rows }) }));
vi.mock('@/hooks/useDeposits', () => ({ useOrphanDepositVouchers: () => ({ data: fixtures.rows }) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: fixtures.rows }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor' } }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: { __superadmin: true } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: '11111111-1111-4111-8111-111111111111' }) }));
vi.mock('@/hooks/useDocumentTemplates', () => ({ useDocumentTemplatesByType: () => ({ data: fixtures.rows }) }));
vi.mock('@/hooks/useContractDrafts', () => ({ useSaveContractDraft: () => ({ mutateAsync: fixtures.save, isPending: false }) }));
vi.mock('../contract-form/useContractSubmit', () => ({ useContractSubmit: () => fixtures.submit }));
// Keep the real form-state and draft-editor hooks; only presentation and I/O are substituted.
vi.mock('../contract-form/GeneralSection', () => ({ GeneralSection: (state: ContractFormState) => <>
  <input aria-label="Nội dung đang soạn" {...state.form.register('notes')} />
  <output data-testid="support">{JSON.stringify(state.form.watch('rent_support') ?? null)}</output>
  <button type="button" onClick={() => state.setCommissionContractId('signed-contract')}>Mở phiếu sau ký</button>
</> }));
vi.mock('../contract-form/CustomersSection', () => ({ CustomersSection: () => null }));
vi.mock('../contract-form/RentDepositSection', () => ({ RentDepositSection: () => null }));
vi.mock('../contract-form/ServicesSection', () => ({ ServicesSection: () => null }));
vi.mock('../contract-form/FirstInvoicePreview', () => ({ FirstInvoicePreview: () => null }));
vi.mock('../contract-form/ContractFormFooter', () => ({ ContractFormFooter: ({ onSaveDraft }: { onSaveDraft?: () => void }) => <button type="button" onClick={onSaveDraft}>Lưu nháp</button> }));
vi.mock('../CustomerSelectionDialog', () => ({ CustomerSelectionDialog: () => null }));
vi.mock('../ServiceSelectionDialog', () => ({ ServiceSelectionDialog: () => null }));
vi.mock('../CommissionVoucherModal', () => ({ CommissionVoucherModal: ({ open, contractId }: { open: boolean; contractId: string | null }) => open ? <p>Phiếu sau ký {contractId}</p> : null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: new Proxy({}, { get() { throw new Error('No backend calls in reopen integration'); } }) }));

const schedule = { version: 2 as const, payer: 'SALE' as const,
  start_billing_month: '2026-09', sale_party_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  collection_mode: 'UPFRONT_COMMITTED' as const, deduction_policy: 'COMMISSION_ONLY' as const,
  segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] };
function draft(revision: number, notes: string, withSupport = false): ContractDraft {
  const empty = emptyContractDraftPayload();
  return { id: '33333333-3333-4333-8333-333333333333', organization_id: '11111111-1111-4111-8111-111111111111',
    building_id: '22222222-2222-4222-8222-222222222222', room_id: null, template_id: null, revision,
    payload: { ...empty, form: { ...empty.form, notes, rent_price: 5000000, start_date: '2026-09-01', start_billing_date: '2026-09-01', end_billing_date: '2026-09-30' },
      ...(withSupport ? { rent_support: schedule } : {}) },
    created_by: '55555555-5555-4555-8555-555555555555', created_at: '2026-09-29', updated_at: '2026-09-29', documents: [] };
}
const onOpenChange = vi.fn();
const notesInput = () => screen.getByRole('textbox', { name: 'Nội dung đang soạn' }) as HTMLInputElement;
const shownSupport = () => JSON.parse(screen.getByTestId('support').textContent ?? 'null');
afterEach(cleanup);
beforeEach(() => { fixtures.save.mockReset(); fixtures.submit.mockReset(); });

it('reopens the same draft with the latest SALE schedule before the hydration guard locks its identity', async () => {
  const old = draft(1, 'Nháp cũ');
  const latest = draft(2, 'Nháp đã lưu hỗ trợ', true);
  const { rerender } = render(<ContractFormDialog open draft={old} onOpenChange={onOpenChange} />);
  await waitFor(() => expect(notesInput().value).toBe('Nháp cũ'));
  rerender(<ContractFormDialog open={false} draft={old} onOpenChange={onOpenChange} />);
  rerender(<ContractFormDialog open draft={latest} onOpenChange={onOpenChange} />);
  await waitFor(() => expect(notesInput().value).toBe('Nháp đã lưu hỗ trợ'));
  expect(shownSupport()).toEqual(schedule);
  expect(schedule.segments.reduce((sum, segment) => sum + segment.month_count * Number(segment.monthly_amount), 0)).toBe(1800000);
});

it('keeps dirty input during a same-id background refresh, then accepts it on the next open', async () => {
  const initial = draft(2, 'Đã lưu', true);
  const refreshed = draft(3, 'Bản máy chủ mới', true);
  const { rerender } = render(<ContractFormDialog open draft={initial} onOpenChange={onOpenChange} />);
  await waitFor(() => expect(notesInput().value).toBe('Đã lưu'));
  fireEvent.change(notesInput(), { target: { value: 'Đang sửa chưa lưu' } });
  rerender(<ContractFormDialog open draft={refreshed} onOpenChange={onOpenChange} />);
  expect(notesInput().value).toBe('Đang sửa chưa lưu');
  expect(shownSupport()).toEqual(schedule);
  rerender(<ContractFormDialog open={false} draft={initial} onOpenChange={onOpenChange} />);
  rerender(<ContractFormDialog open draft={refreshed} onOpenChange={onOpenChange} />);
  await waitFor(() => expect(notesInput().value).toBe('Bản máy chủ mới'));
});

it('hydrates a newly selected draft identity while the dialog stays open', async () => {
  const initial = draft(1, 'Nháp A');
  const next = { ...draft(2, 'Nháp B', true), id: '66666666-6666-4666-8666-666666666666' };
  const { rerender } = render(<ContractFormDialog open draft={initial} onOpenChange={onOpenChange} />);
  await waitFor(() => expect(notesInput().value).toBe('Nháp A'));
  rerender(<ContractFormDialog open draft={next} onOpenChange={onOpenChange} />);
  await waitFor(() => expect(notesInput().value).toBe('Nháp B'));
  expect(shownSupport()).toEqual(schedule);
});

it('retains the locally persisted draft and post-signing modal when the parent draft is stale or closed', async () => {
  const initial = draft(2, 'Đã lưu', true);
  const saved = draft(3, 'Vừa lưu', true);
  fixtures.save.mockResolvedValue(saved);
  const { rerender } = render(<ContractFormDialog open draft={initial} onOpenChange={onOpenChange} />);
  await waitFor(() => expect(notesInput().value).toBe('Đã lưu'));
  fireEvent.change(notesInput(), { target: { value: 'Vừa lưu' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
  await waitFor(() => expect(screen.getByText('Nháp · phiên bản 3')).toBeTruthy());
  rerender(<ContractFormDialog open draft={{ ...initial }} onOpenChange={onOpenChange} />);
  expect(notesInput().value).toBe('Vừa lưu');
  expect(shownSupport()).toEqual(schedule);
  expect(screen.getByText('Nháp · phiên bản 3')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Mở phiếu sau ký' }));
  rerender(<ContractFormDialog open={false} draft={initial} onOpenChange={onOpenChange} />);
  expect(screen.getByText('Phiếu sau ký signed-contract')).toBeTruthy();
});
