// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { SettlementDetailContext } from '../ContractSettlementSection';
import type { SettlementVoucherRow } from '@/lib/contractSettlement';
const m = vi.hoisted(() => ({ open: vi.fn(), input: null as unknown, busy: false, dialogOpen: false }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor' } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org' }) }));
vi.mock('@/hooks/income-expenses/useIncomeExpenseActions', () => ({ useIncomeExpenseActions: (input: unknown) => {
  m.input = input; return { selected: m.dialogOpen ? { key: 'draft' } : null, dismissalBlocked: m.busy, availability: () => new Proxy({}, { get: (_target, key) => key === 'resubmitReview' ? { visible: true, enabled: true, reason: null } : { visible: false, enabled: false, reason: null } }), open: m.open };
} }));
vi.mock('@/hooks/useContractSettlementFinancialFacts', () => ({ useContractSettlementFinancialFacts: () => ({ data: undefined, isPending: false, isError: false }) }));
vi.mock('@/hooks/income-expenses/supplements', () => ({ useIncomeExpenseSupplements: () => ({ data: [], isPending: false, isError: false }) }));
vi.mock('../ContractSettlementTimeline', () => ({ ContractSettlementTimeline: ({ target }: { target: { contractId: string } }) => <div>timeline:{target.contractId}</div> }));
vi.mock('@/components/income-expenses/IncomeExpenseActionDialogs', () => ({ IncomeExpenseActionDialogs: () => null }));
vi.mock('@/components/income-expenses/VoucherHistoryDialog', () => ({ default: () => null }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: () => null }));
vi.mock('@/components/ui/attachment-lightbox', () => ({ AttachmentLightbox: () => null }));
import { ContractSettlementModal } from '../ContractSettlementModal';
const base = (): SettlementDetailContext => ({ selection: { kind: 'voucher', voucherId: 'v' }, row: undefined, event: undefined, events: [], rows: [], paymentsComplete: true, eventsComplete: true, error: null, refreshing: false, fallbackFocusRef: createRef(), onSelect: vi.fn(), onClose: vi.fn(), refreshRequired: vi.fn().mockResolvedValue(undefined) });
const reviewVoucher = (): SettlementVoucherRow => ({
  rowType: 'voucher', rowKey: 'voucher:v', voucherId: 'v', voucherCode: 'PC-review', settlementKind: 'commission',
  sourceLink: { state: 'verified', sourceRef: { kind: 'broker', organizationId: 'org', contractId: 'original-contract' } },
  basis: { kind: 'COMMISSION', status: 'AVAILABLE', amount: 100, measuredAt: null, source: null, fingerprint: null, version: null, warning: null },
  snapshot: { state: 'ready', value: {
    id: 'v', code: 'PC-review', organizationId: 'org', buildingId: 'building', roomId: 'room', roomName: '301',
    contractId: 'original-contract', contractNumber: 'HD-original', tenantId: null, customerName: 'Khách cũ',
    totalAmount: 100, type: 'EXPENSE', payerName: 'Môi giới', receiveBankName: null, receiveBankAccount: null,
    accountId: null, approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED', postingMode: 'CASHBOOK',
    reviewState: 'CHANGES_REQUESTED', reviewReason: 'Rà soát chứng từ', approvalVersion: 1, postingVersion: 1, reviewVersion: 2,
    systemSource: 'contract.broker_commission', activePostingId: null, effectiveNetPaid: 0, postedOn: null,
    voucherDate: '2026-09-01', sourceEventDate: '2026-09-01', makerUserId: 'actor',
    flowOwnership: { state: 'ready', value: { owner: 'contract-settlement', verified: true } },
    postingEvidence: { state: 'ready', value: { activePostingId: null, effectiveNetPaid: 0, postedOn: null } },
    notes: 'Ghi chú phiếu cũ', attachments: [], actionReadiness: { state: 'loading' },
  } },
});
afterEach(() => { cleanup(); vi.clearAllMocks(); m.busy = false; m.dialogOpen = false; });
it('resubmits the selected review voucher through the shared machine, never through source creation', () => {
  const context = { ...base(), row: reviewVoucher() }, create = vi.fn();
  render(<ContractSettlementModal context={context} renderCreate={create} />);
  expect(screen.getByText('timeline:original-contract')).toBeTruthy();
  expect(screen.getByText('Ghi chú phiếu cũ')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển chờ duyệt' }));
  expect(m.open).toHaveBeenCalledExactlyOnceWith('resubmitReview', 'v');
  expect(m.input).toMatchObject({ voucherIds: ['v'], refreshRequired: context.refreshRequired });
  expect(create).not.toHaveBeenCalled();
});
it('keeps the same voucher session locked while its refresh temporarily removes the row', () => {
  const context = { ...base(), row: reviewVoucher() as SettlementDetailContext['row'] }, create = vi.fn();
  m.busy = true;
  const view = render(<ContractSettlementModal context={context} renderCreate={create} />);
  context.row = undefined;
  view.rerender(<ContractSettlementModal context={context} renderCreate={create} />);
  expect(screen.getByText('Ghi chú phiếu cũ')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Đóng hồ sơ' }));
  fireEvent.click(screen.getByRole('button', { name: 'Chuyển chờ duyệt' }));
  expect(context.onClose).not.toHaveBeenCalled();
  expect(m.open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  m.busy = false;
  view.rerender(<ContractSettlementModal context={context} renderCreate={create} />);
  expect(screen.getByText(/Không đọc được hồ sơ đang chọn/)).toBeTruthy();
});
it('retains an open evidence or supplement draft even before the money command starts', () => {
  const context = { ...base(), row: reviewVoucher() as SettlementDetailContext['row'] };
  m.dialogOpen = true;
  const view = render(<ContractSettlementModal context={context} renderCreate={() => null} />);
  expect((screen.getByRole('button', { name: 'Đóng hồ sơ' }) as HTMLButtonElement).disabled).toBe(true);
  context.row = undefined;
  view.rerender(<ContractSettlementModal context={context} renderCreate={() => null} />);
  expect(screen.getByText('Ghi chú phiếu cũ')).toBeTruthy();
  m.dialogOpen = false;
  view.rerender(<ContractSettlementModal context={context} renderCreate={() => null} />);
  expect(screen.getByText(/Không đọc được hồ sơ đang chọn/)).toBeTruthy();
});
it('keeps an unavailable selection explicit and never offers creation for that existing ID', () => {
  const context = base(), create = vi.fn();
  render(<ContractSettlementModal context={context} renderCreate={create} />);
  expect(screen.getByText(/Không đọc được hồ sơ đang chọn/)).toBeTruthy();
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Đóng hồ sơ' }));
  expect(context.onClose).toHaveBeenCalledTimes(1);
});
it('passes the exact source to creation and selects only the returned voucher identity', () => {
  const context = base();
  const sourceRef = { kind: 'broker' as const, organizationId: 'org', contractId: 'old-contract' };
  context.selection = { kind: 'source', sourceRef };
  context.row = { rowType: 'source', rowKey: 'source', settlementKind: 'commission', sourceRef, organizationId: 'org', buildingId: 'building', roomId: 'room', roomName: '301', contractId: 'old-contract', contractNumber: 'HD-old', customerName: 'Khách cũ', eventDate: '2026-09-01', recipient: { name: 'Người nhận', bankName: null, bankAccount: null }, basis: { kind: 'COMMISSION', status: 'AVAILABLE', amount: 100, measuredAt: null, source: null, fingerprint: null, version: null, warning: null }, createEligibility: { state: 'unavailable', reasonCodes: ['ADAPTER_REQUIRED'] } };
  render(<ContractSettlementModal context={context} renderCreate={props => <button onClick={() => props.onCreated({ outcome: 'created', voucherId: 'created-voucher' })}>{props.sourceRef.kind}:lập</button>} />);
  expect(screen.getByText('timeline:old-contract')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'broker:lập' }));
  expect(context.onSelect).toHaveBeenCalledWith({ kind: 'voucher', voucherId: 'created-voucher' });
});
it.each(['missing', 'linked-voucher'] as const)('retains an in-flight source session across %s refresh until creation is verified', replacement => {
  const context = base();
  const sourceRef = { kind: 'broker' as const, organizationId: 'org', contractId: 'contract' };
  context.selection = { kind: 'source', sourceRef };
  context.row = { rowType: 'source', rowKey: 'source', settlementKind: 'commission', sourceRef, organizationId: 'org', buildingId: 'building', roomId: 'room', roomName: '301', contractId: 'contract', contractNumber: 'HD', customerName: null, eventDate: null, recipient: { name: null, bankName: null, bankAccount: null }, basis: { kind: 'COMMISSION', status: 'AVAILABLE', amount: 100, measuredAt: null, source: null, fingerprint: null, version: null, warning: null }, createEligibility: { state: 'unavailable', reasonCodes: [] } };
  let finish: (() => void) | undefined;
  const create: Parameters<typeof ContractSettlementModal>[0]['renderCreate'] = props => {
    finish = () => props.onBusyChange?.(false);
    return <button onClick={() => props.onBusyChange?.(true)}>Bắt đầu lập</button>;
  };
  const onBusyChange = vi.fn();
  const view = render(<ContractSettlementModal context={context} renderCreate={create} onBusyChange={onBusyChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu lập' }));
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  context.row = replacement === 'missing' ? undefined : reviewVoucher();
  view.rerender(<ContractSettlementModal context={context} renderCreate={create} onBusyChange={onBusyChange} />);
  expect(screen.queryByText(/Không đọc được hồ sơ đang chọn/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Bắt đầu lập' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Đóng hồ sơ' }) as HTMLButtonElement).disabled).toBe(true);
  act(() => finish?.());
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
  if (replacement === 'missing') expect(screen.getByText(/Không đọc được hồ sơ đang chọn/)).toBeTruthy();
  else expect(screen.getByText('Ghi chú phiếu cũ')).toBeTruthy();
});
