// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  review: vi.fn(),
  setup: vi.fn(),
  enable: vi.fn(),
  disconnect: vi.fn(),
  oauth: vi.fn(),
  workerUrl: null as string | null,
  inboxTransaction: null as Record<string, unknown> | null,
}));

const connection = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bankAccount: '1234567890',
  accountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  enabled: false,
  autoEnabledAt: null,
  status: 'CONNECTED',
  email: 'owner@example.test',
  lastSyncedAt: null,
  lastError: null,
  createdAt: '2026-10-05T01:00:00Z',
};

const pending = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  connectionId: connection.id,
  messageId: 'gmail-1',
  internalDate: '2026-10-05T01:00:00Z',
  verified: true,
  account: '1234567890',
  amount: 500000,
  balance: 1200000,
  currency: 'VND',
  direction: 'CREDIT',
  occurredAt: '2026-10-05T00:59:00Z',
  bankReference: 'FT123',
  description: 'THU HD-01',
  status: 'PENDING',
  reason: 'NO_MATCH',
  invoiceId: null,
  receipt: null,
  createdAt: '2026-10-05T01:00:01Z',
};

vi.mock('@/lib/bankEmail', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/bankEmail')>();
  return { ...actual, bankEmailWorkerUrl: () => mocks.workerUrl };
});
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: connection.organizationId }) }));
vi.mock('@/hooks/useBankEmail', () => ({
  useBankEmailInbox: () => ({ data: { pages: [{ connections: [connection], transactions: [mocks.inboxTransaction ?? pending], hasMore: false }] }, isPending: false, isError: false, hasNextPage: false, isFetchingNextPage: false, refetch: vi.fn(), fetchNextPage: vi.fn() }),
  useBankEmailCashbooks: () => ({ data: [{ id: connection.accountId, name: 'Sổ ngân hàng' }], isLoading: false, isError: false }),
  useBankInvoiceCandidates: () => ({ data: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', invoice_number: 'HD-01', status: 'APPROVED' }], isLoading: false, isError: false }),
  useSetupBankEmail: () => ({ mutateAsync: mocks.setup, isPending: false }),
  useSetBankEmailEnabled: () => ({ mutateAsync: mocks.enable, isPending: false }),
  useDisconnectBankEmail: () => ({ mutateAsync: mocks.disconnect, isPending: false }),
  useStartBankEmailOAuth: () => ({ mutateAsync: mocks.oauth, isPending: false }),
  useReviewBankEmail: () => ({ mutateAsync: mocks.review, isPending: false }),
}));

import { BankEmailPanel } from './BankEmailPanel';
import { BankEmailActualOutcomeError } from '@/lib/bankEmail';

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.workerUrl = null; mocks.inboxTransaction = null; });

describe('BankEmailPanel', () => {
  it('shows unavailable Gmail worker without presenting connection as usable', () => {
    render(<BankEmailPanel />);
    expect(screen.getByText(/Máy chủ kết nối Gmail chưa được cấu hình/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Kết nối Gmail/ })).toHaveProperty('disabled', true);
  });

  it('requires selecting an exact invoice before posting a pending credit', async () => {
    mocks.workerUrl = 'https://worker.example.test/';
    mocks.review.mockResolvedValue({ id: pending.id, status: 'POSTED', reason: null, invoiceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', receipt: { voucherId: 'v1' } });
    render(<BankEmailPanel />);
    const button = screen.getByRole('button', { name: /Xác nhận thu/ });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/Mã hóa đơn cho giao dịch/), { target: { value: 'HD' } });
    fireEvent.click(screen.getByRole('button', { name: /HD-01/ }));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith({ transactionId: pending.id, organizationId: connection.organizationId, invoiceNumber: 'HD-01', expectedInvoiceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', expectedAmount: 500000, action: 'post' }));
  });

  it('offers an explicit ignore action for a pending row', async () => {
    mocks.review.mockResolvedValue({ id: pending.id, status: 'IGNORED', reason: null, invoiceId: null, receipt: null });
    render(<BankEmailPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Bỏ qua giao dịch/ }));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith({ transactionId: pending.id, organizationId: connection.organizationId, action: 'ignore' }));
  });

  it('keeps the actual posted outcome visible when inbox refresh turns the row terminal before review rejects', async () => {
    const otherInvoiceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const actual = { id: pending.id, status: 'POSTED' as const, reason: null, invoiceId: otherInvoiceId, receipt: {
      collection_id: '11111111-1111-4111-8111-111111111111', invoice_id: otherInvoiceId,
      gross_amount: 500000, applied_amount: 500000, change_amount: 0, credit_amount: 0,
      rounding_amount: 0, credit_lot_id: null,
      tenders: [{ tender_id: '22222222-2222-4222-8222-222222222222', payment_id: '33333333-3333-4333-8333-333333333333', voucher_id: '44444444-4444-4444-8444-444444444444', applied_amount: 500000 }],
      invoice: { id: otherInvoiceId },
    } };
    let rejectReview!: (reason: unknown) => void;
    mocks.review.mockImplementation(() => new Promise((_, reject) => { rejectReview = reject; }));
    const view = render(<BankEmailPanel />);
    fireEvent.change(screen.getByLabelText(/Mã hóa đơn cho giao dịch/), { target: { value: 'HD' } });
    fireEvent.click(screen.getByRole('button', { name: /HD-01/ }));
    fireEvent.click(screen.getByRole('button', { name: /Xác nhận thu/ }));
    mocks.inboxTransaction = { ...pending, status: 'POSTED', reason: null, invoiceId: otherInvoiceId, receipt: actual.receipt };
    view.rerender(<BankEmailPanel />);
    await act(async () => { rejectReview(new BankEmailActualOutcomeError(actual)); });
    const row = screen.getByRole('article', { name: 'Giao dịch FT123' });
    expect(row.textContent).toContain('Đã ghi thu');
    expect(row.querySelector('[role="alert"]')?.textContent).toMatch(/khác lựa chọn/i);
    expect(row.querySelector('a')?.getAttribute('href')).toBe(`/invoices/${otherInvoiceId}`);
    expect(row.querySelector('a')?.textContent).toBe('Xem hóa đơn đã ghi thu');
  });
});
