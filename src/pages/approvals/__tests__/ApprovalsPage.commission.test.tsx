// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IncomeExpenseWithRelations } from '@/hooks/income-expenses/types';

const api = vi.hoisted(() => ({ read: vi.fn(), decide: vi.fn(), approve: vi.fn(), post: vi.fn(), refetch: vi.fn(), mobile: false, actor: 'reviewer' }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('@/components/errors/QueryRegion', () => ({ QueryRegion: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/approvals/AiSubmittedBadge', () => ({ AiSubmittedBadge: () => null }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => api.mobile }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: api.actor } }) }));
vi.mock('@/hooks/useApprovals', () => ({
  usePendingApprovals: () => ({ data: [{ request_id: 'approval-request', voucher_id: 'voucher-target', organization_id: 'organization-target',
    voucher_type: 'EXPENSE', voucher_name: 'Hoa hồng trong tên tự nhập', voucher_code: 'PC-TEST', amount: 100,
    submitted_at: '2026-10-11T03:00:00Z', step_no: 1, approval_version: 1, posting_version: 1 }],
    isLoading: false, isFetching: false, isError: false, refetch: api.refetch }),
  useDecideApproval: () => ({ mutate: api.decide, mutateAsync: api.decide, isPending: false }),
}));
vi.mock('@/lib/financeV2Route', () => ({ useFinanceV2Routes: () => ({ getOrg: () => ({}) }), canWriteWorkflow: () => true, canWritePosting: () => true }));
vi.mock('@/hooks/income-expenses/financeV2Mutations', () => ({
  useApproveIncomeExpenseV2: () => ({ mutate: api.approve, isPending: false }),
  useApproveAndPostIncomeExpenseV2: () => ({ mutateAsync: api.post, isPending: false }),
  useCustodianCashbooksV2: () => ({ data: [{ id: 'cashbook', name: 'Sổ kiểm thử' }], isError: false, refetch: vi.fn() }),
  useAttachPostingEvidence: () => vi.fn(), useRemovePostingAttachment: () => vi.fn(),
  uploadFinanceEvidence: vi.fn(), adoptVoucherAttachmentsAsEvidence: vi.fn(),
}));
vi.mock('@/lib/incomeExpenseDetailRpc', () => ({ loadIncomeExpenseDetails: api.read }));
vi.mock('@/hooks/income-expenses/detailRead', () => ({ withDetailReadDeadline: (read: Promise<unknown>) => read }));
vi.mock('@/components/income-expenses/IncomeExpensePostingDialog', () => ({ default: ({ voucher }: {
  voucher: { subjectId: string; isCommission?: boolean; approvedTotal: number; name?: string };
}) => <div role="dialog" aria-label="Duyệt và chi">{voucher.subjectId} {voucher.isCommission ? 'Hoa hồng đã xác định' : 'Chi thông thường'} {voucher.approvedTotal} {voucher.name}</div> }));
import ApprovalsPage from '../ApprovalsPage';

const detail = (patch: Partial<IncomeExpenseWithRelations> = {}) => ({ id: 'voucher-target', organization_id: 'organization-target',
  type: 'EXPENSE', name: 'Chi phí đã đối chiếu', total_amount: 150, system_source: null, commission_kind: null,
  approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', approval_version: 3, posting_version: 2,
  items: [], detail_read: { complete: true, expected_item_count: 0 }, ...patch } as IncomeExpenseWithRelations);
beforeEach(() => { vi.clearAllMocks(); api.mobile = false; api.actor = 'reviewer'; api.read.mockResolvedValue([detail()]); });
afterEach(cleanup);

it.each([false, true])('reads the exact voucher before opening commission posting on mobile=%s', async mobile => {
  api.mobile = mobile;
  let resolve!: (rows: IncomeExpenseWithRelations[]) => void;
  api.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<ApprovalsPage />);
  const open = screen.getByRole('button', { name: 'Duyệt và Chi…' });
  fireEvent.click(open); fireEvent.click(open);
  expect(api.read).toHaveBeenCalledTimes(1);
  expect(api.read).toHaveBeenCalledWith('organization-target', ['voucher-target']);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByRole('status')).toBeTruthy();
  resolve([detail({ system_source: 'contract.commission', name: 'Nguồn hệ thống không suy theo tên' })]);
  expect((await screen.findByRole('dialog')).textContent).toContain('Hoa hồng đã xác định');
  expect(screen.getByRole('dialog').textContent).toContain('150');
  expect(api.post).not.toHaveBeenCalled(); expect(api.approve).not.toHaveBeenCalled();
});

it('does not infer commission from the pending voucher title', async () => {
  render(<ApprovalsPage />); fireEvent.click(screen.getByRole('button', { name: 'Duyệt và Chi…' }));
  expect((await screen.findByRole('dialog')).textContent).toContain('Chi thông thường');
  expect(screen.queryByText('Hoa hồng đã xác định')).toBeNull();
});

it.each([
  ['missing', null], ['wrong voucher', detail({ id: 'other-voucher' })], ['wrong organization', detail({ organization_id: 'other-organization' })],
  ['incomplete items', detail({ detail_read: { complete: false, expected_item_count: 1 } })], ['already approved', detail({ approval_status: 'APPROVED' })],
] as const)('keeps posting closed for %s detail', async (_label, value) => {
  api.read.mockResolvedValueOnce(value ? [value] : []);
  render(<ApprovalsPage />); fireEvent.click(screen.getByRole('button', { name: 'Duyệt và Chi…' }));
  await screen.findByRole('alert'); expect(screen.queryByRole('dialog')).toBeNull(); expect(api.post).not.toHaveBeenCalled();
});

it('shows read failure and allows a fresh exact read without posting', async () => {
  api.read.mockRejectedValueOnce(new Error('Không đọc được chi tiết phiếu'));
  render(<ApprovalsPage />); fireEvent.click(screen.getByRole('button', { name: 'Duyệt và Chi…' }));
  await screen.findByRole('alert'); expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Duyệt và Chi…' }));
  await screen.findByRole('dialog'); expect(api.read).toHaveBeenCalledTimes(2); expect(api.post).not.toHaveBeenCalled();
});

it('discards a late detail response after the acting user changes', async () => {
  let resolve!: (rows: IncomeExpenseWithRelations[]) => void;
  api.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<ApprovalsPage />); fireEvent.click(screen.getByRole('button', { name: 'Duyệt và Chi…' }));
  api.actor = 'other-reviewer'; view.rerender(<ApprovalsPage />);
  resolve([detail({ commission_kind: 'broker' })]);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(screen.queryByRole('dialog')).toBeNull(); expect(api.post).not.toHaveBeenCalled();
});
