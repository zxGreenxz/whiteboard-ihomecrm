import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

import { listOwnedBankEmailConnections, reviewBankEmail } from '../bankEmail';

const transactionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const invoiceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const receipt = {
  collection_id: '11111111-1111-4111-8111-111111111111', invoice_id: invoiceId,
  gross_amount: 500000, applied_amount: 500000, change_amount: 0, credit_amount: 0,
  rounding_amount: 0, credit_lot_id: null,
  tenders: [{ tender_id: '22222222-2222-4222-8222-222222222222', payment_id: '33333333-3333-4333-8333-333333333333', voucher_id: '44444444-4444-4444-8444-444444444444', applied_amount: 500000 }],
  invoice: { id: invoiceId },
};

afterEach(() => vi.clearAllMocks());

describe('bank email RPC transport', () => {
  it('sends the selected invoice identity and transaction amount to the server before posting', async () => {
    mocks.rpc.mockResolvedValue({ data: { id: transactionId, status: 'POSTED', reason: null, invoiceId, receipt }, error: null });
    await reviewBankEmail({ transactionId, action: 'post', invoiceNumber: 'ACB-E2E-01', expectedInvoiceId: invoiceId, expectedAmount: 500000 });
    expect(mocks.rpc).toHaveBeenCalledWith('bank_email_review_v1', {
      p_transaction_id: transactionId,
      p_invoice_number: 'ACB-E2E-01',
      p_ignore: false,
      p_expected_invoice_id: invoiceId,
      p_expected_amount: 500000,
    });
  });

  it('reads owner connection metadata without a business organization argument', async () => {
    const owner = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'owner@example.test', status: 'CONNECTED' };
    mocks.rpc.mockResolvedValue({ data: { connections: [{ ...owner, bankAccount: 'secret-account' }] }, error: null });
    await expect(listOwnedBankEmailConnections()).resolves.toEqual([owner]);
    expect(mocks.rpc).toHaveBeenCalledWith('bank_email_my_connections_v1', {});
  });
});
