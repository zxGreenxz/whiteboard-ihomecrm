import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bankEmailQueryKey,
  bankEmailWorkerUrl,
  parseBankEmailList,
  parseBankEmailReview,
} from '../bankEmail';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOrganizationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const transactionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const invoiceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const v5Receipt = {
  collection_id: '11111111-1111-4111-8111-111111111111',
  invoice_id: invoiceId,
  gross_amount: 500000,
  applied_amount: 500000,
  change_amount: 0,
  credit_amount: 0,
  rounding_amount: 0,
  credit_lot_id: null,
  tenders: [{
    tender_id: '22222222-2222-4222-8222-222222222222',
    payment_id: '33333333-3333-4333-8333-333333333333',
    voucher_id: '44444444-4444-4444-8444-444444444444',
    applied_amount: 500000,
  }],
  invoice: { id: invoiceId },
};

const connection = {
  id: connectionId,
  organizationId,
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

const transaction = {
  id: transactionId,
  connectionId,
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

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('bank email boundary', () => {
  it('rejects a connection from another organization in an inbox response', () => {
    expect(() => parseBankEmailList({ connections: [{ ...connection, organizationId: otherOrganizationId }], transactions: [], hasMore: false }, organizationId)).toThrow();
  });

  it('rejects an inbox transaction whose connection is absent', () => {
    expect(() => parseBankEmailList({ connections: [], transactions: [transaction], hasMore: false }, organizationId)).toThrow();
  });

  it('rejects a posted review without a V5 receipt', () => {
    expect(() => parseBankEmailReview({ id: transactionId, status: 'POSTED', reason: null, invoiceId, receipt: null }, { transactionId, action: 'post', expectedInvoiceId: invoiceId, expectedAmount: 500000 })).toThrow();
  });

  it('accepts a replayed, positively confirmed posted review', () => {
    const result = parseBankEmailReview({ id: transactionId, status: 'POSTED', reason: null, invoiceId, receipt: v5Receipt }, { transactionId, action: 'post', expectedInvoiceId: invoiceId, expectedAmount: 500000 });
    expect(result.status).toBe('POSTED');
    expect(result.invoiceId).toBe(invoiceId);
  });

  it('does not treat pending or ignored review as successful posting', () => {
    expect(() => parseBankEmailReview({ id: transactionId, status: 'PENDING', reason: 'AMOUNT_MISMATCH', invoiceId: null, receipt: null }, { transactionId, action: 'post', expectedInvoiceId: invoiceId, expectedAmount: 500000 })).toThrow();
    expect(() => parseBankEmailReview({ id: transactionId, status: 'IGNORED', reason: null, invoiceId: null, receipt: null }, { transactionId, action: 'post', expectedInvoiceId: invoiceId, expectedAmount: 500000 })).toThrow();
  });

  it('rejects a posted receipt for another invoice or with unaccounted money', () => {
    expect(() => parseBankEmailReview({ id: transactionId, status: 'POSTED', reason: null, invoiceId, receipt: { ...v5Receipt, invoice_id: connectionId } }, { transactionId, action: 'post', expectedInvoiceId: invoiceId, expectedAmount: 500000 })).toThrow();
    expect(() => parseBankEmailReview({ id: transactionId, status: 'POSTED', reason: null, invoiceId, receipt: { ...v5Receipt, change_amount: 100 } }, { transactionId, action: 'post', expectedInvoiceId: invoiceId, expectedAmount: 500000 })).toThrow();
  });

  it('rejects a valid V5 receipt posted to a different invoice or amount than selected', () => {
    const payload = { id: transactionId, status: 'POSTED', reason: null, invoiceId, receipt: v5Receipt };
    expect(() => parseBankEmailReview(payload, { transactionId, action: 'post', expectedInvoiceId: connectionId, expectedAmount: 500000 })).toThrow(/khác|đối chiếu/i);
    expect(() => parseBankEmailReview(payload, { transactionId, action: 'post', expectedInvoiceId: invoiceId, expectedAmount: 400000 })).toThrow(/khác|đối chiếu/i);
  });

  it('separates cached inboxes by actor and organization', () => {
    expect(bankEmailQueryKey('actor-1', organizationId)).not.toEqual(bankEmailQueryKey('actor-1', otherOrganizationId));
    expect(bankEmailQueryKey('actor-1', organizationId)).not.toEqual(bankEmailQueryKey('actor-2', organizationId));
  });

  it('accepts only a same-origin worker proxy for relative deployment config', () => {
    vi.stubGlobal('location', { origin: 'https://app.example.test' });
    vi.stubEnv('VITE_BANK_EMAIL_WORKER_URL', '/api/bank-email');
    expect(bankEmailWorkerUrl()).toBe('https://app.example.test/api/bank-email/');
    vi.stubEnv('VITE_BANK_EMAIL_WORKER_URL', '//other.example.test/api/bank-email');
    expect(bankEmailWorkerUrl()).toBeNull();
  });

  it('reports an invalid optional endpoint or absent browser origin as unavailable', () => {
    vi.stubEnv('VITE_BANK_EMAIL_WORKER_URL', 'not a URL');
    expect(bankEmailWorkerUrl()).toBeNull();
    vi.stubEnv('VITE_BANK_EMAIL_WORKER_URL', '/api/bank-email');
    vi.stubGlobal('location', undefined);
    expect(bankEmailWorkerUrl()).toBeNull();
  });
});
