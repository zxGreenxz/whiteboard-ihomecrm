import { describe, expect, it, vi } from 'vitest';
import { createCompanyWalletService, companyVoucherPayload, type CompanyWalletRpcClient } from './service';
import { parseCompanyWalletSnapshot } from './contract';
import type { CreateIncomeExpenseInput } from '@/hooks/income-expenses/types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [owner, org, walletId, accountId, buildingId, requestKey] = [1, 2, 3, 4, 5, 6].map(id);
const wallet = { id: walletId, user_id: owner, organization_id: org, name: 'Bank', icon: '🏦', kind: 'bank', account_id: accountId, is_preferred: true, hidden: false, version: 1, account_name: 'Company bank', balance: 50, balance_visible: true, can_use: true };
const snapshot = { owner_id: owner, organization_id: org, schema_version: 1, wallets: [wallet], transactions: [] };
const input: CreateIncomeExpenseInput = { type: 'EXPENSE', name: 'Paper', building_id: buildingId, account_id: accountId, voucher_date: '2026-10-08', items: [{ income_expense_type_id: id(7), description: 'Paper', quantity: 1, unit_price: 100, start_date: '2026-10-08', end_date: '2026-10-08' }] };
describe('company wallet typed service', () => {
 it('rejects cross-owner/org rows and inconsistent masked balances', () => {
  expect(parseCompanyWalletSnapshot(snapshot, owner, org)).toEqual(snapshot);
  for (const changed of [{ ...snapshot, owner_id: id(8) }, { ...snapshot, wallets: [{ ...wallet, organization_id: id(8) }] }, { ...snapshot, wallets: [{ ...wallet, balance_visible: false }] }]) expect(() => parseCompanyWalletSnapshot(changed, owner, org)).toThrow();
  expect(parseCompanyWalletSnapshot({ ...snapshot, wallets: [{ ...wallet, balance_visible: false, balance: null }] }, owner, org).wallets[0].balance).toBeNull();
 });
 it('sends one wrapper RPC and preserves the same payload/key for uncertainty retry', async () => {
  const rpc = vi.fn(async () => ({ data: {}, error: null })); const service = createCompanyWalletService({ rpc }, owner, org);
  const request = { walletId, idempotencyKey: 'qe-card-id', input };
  await expect(service.createVoucher(request)).rejects.toMatchObject({ outcomeUnknown: true, kind: 'internal' });
  await expect(service.createVoucher(request)).rejects.toMatchObject({ outcomeUnknown: true });
  expect(rpc).toHaveBeenCalledTimes(2); expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  expect(rpc.mock.calls[0]).toEqual(['create_company_wallet_voucher', { p_organization_id: org, p_wallet_id: walletId, p_idempotency_key: 'qe-card-id', p_input: companyVoucherPayload(input) }]);
 });
 it.each([['42501', 'permission'], ['23505', 'conflict'], ['PT409', 'conflict'], ['22023', 'validation']])('preserves canonical %s rejection without fallback', async (code, kind) => {
  const rpc = vi.fn(async () => ({ data: null, error: { code, message: 'Denied' } }));
  await expect(createCompanyWalletService({ rpc }, owner, org).createVoucher({ walletId, idempotencyKey: 'key', input })).rejects.toMatchObject({ kind, code, outcomeUnknown: false });
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it('requires explicit matching owner/org/wallet/account on voucher receipts', async () => {
  const base = { id: id(8), user_id: owner, organization_id: org, wallet_id: walletId, account_id: accountId, code: 'PC1', approval_status: 'APPROVED', posting_status: 'POSTED', origin: 'personal_wallet' };
  for (const patch of [{ wallet_id: id(9) }, { organization_id: id(9) }, { account_id: id(9) }, { maker_user_id: id(9) }]) {
   const client: CompanyWalletRpcClient = { rpc: async () => ({ data: { ...base, ...patch }, error: null }) };
   await expect(createCompanyWalletService(client, owner, org).createVoucher({ walletId, idempotencyKey: 'key', input })).rejects.toMatchObject({ outcomeUnknown: true });
  }
 });
 it('rejects unsupported recurring input before transport and validates mutation receipt identity', async () => {
  const rpc = vi.fn(async () => ({ data: {}, error: null })); const service = createCompanyWalletService({ rpc }, owner, org);
  await expect(service.createVoucher({ walletId, idempotencyKey: 'key', input: { ...input, repeat_cycle: 'MONTH' } })).rejects.toMatchObject({ outcomeUnknown: false, kind: 'validation' }); expect(rpc).not.toHaveBeenCalled();
  await expect(service.mutate({ requestKey, action: 'create', data: { name: 'Bank', kind: 'bank', account_id: accountId } })).rejects.toMatchObject({ outcomeUnknown: true });
 });
});
