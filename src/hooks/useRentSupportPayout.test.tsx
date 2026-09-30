// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { useRentSupportPayout } from './useRentSupportPayout';
import type { SupportPayoutInput } from '@/lib/rentSupportApi';
const api = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn(), read: vi.fn(), readRequest: vi.fn() }));
vi.mock('@/lib/rentSupportApi', () => ({ prepareContractPayoutsWithSupport: api.prepare, executeContractPayoutOperation: api.execute,
  readContractPayoutOperation: api.read, readContractPayoutRequest: api.readRequest }));
const ready = { operation_id: 'operation1', status: 'READY', sources: [] };
const completed = { operation_id: 'operation1', status: 'COMPLETED', sources: [{ source_id: 'source1', operation_id: 'operation1', kind: 'broker', gross: '1800000', withheld: '1800000', net: '0', status: 'SETTLED_BY_SUPPORT', voucher_id: null, id: null, code: null }] };
const input: Omit<SupportPayoutInput, 'requestId'> = { contractId: 'contract1', planRevision: 2, quoteHash: 'hash1', payload: { version: 2, intents: [{ intent_id: 'intent1', source_id: null, kind: 'COMMISSION', party_id: 'party1', gross_amount: '1800000', route: 'CASHBOOK', manager_id: null, account_id: 'account1', voucher_date: '2026-11-01', payer_name: null, recipient_name: 'Payee', recipient_bank: null, recipient_account: null, item_description: null, attachments: [] }] } };
function setup() { return renderHook(() => useRentSupportPayout('org1', 'contract1'), { wrapper: ({ children }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider> }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.clearAllMocks(); api.prepare.mockReset(); api.execute.mockReset(); api.read.mockReset(); api.readRequest.mockReset();
  api.prepare.mockResolvedValue({ operation_id: 'operation1', status: 'READY' }); api.execute.mockResolvedValue(completed); api.read.mockResolvedValue(completed); api.readRequest.mockResolvedValue(ready); });
it('prepares the whole bundle before execute and treats net zero as completed without a voucher', async () => {
  const { result } = setup();
  await act(async () => { expect((await result.current.submit(input)).operation).toEqual(completed); });
  expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.execute).toHaveBeenCalledWith('org1', 'operation1');
  expect(api.prepare.mock.invocationCallOrder[0]).toBeLessThan(api.execute.mock.invocationCallOrder[0]);
  expect(result.current.receipt).toEqual(completed); expect(result.current.error).toBeNull();
});
it('reads back a lost execution response and never prepares or executes a second operation', async () => {
  api.execute.mockRejectedValueOnce(new Error('network'));
  const { result } = setup();
  await act(async () => { expect((await result.current.submit(input)).operation.status).toBe('COMPLETED'); });
  expect(api.read).toHaveBeenCalledWith('org1', 'operation1'); expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.execute).toHaveBeenCalledTimes(1);
});
it('retains READY after deferred commit failure and retries only the saved operation', async () => {
  api.execute.mockRejectedValueOnce(new Error('constraint public.private 123')); api.read.mockResolvedValue(ready);
  const { result } = setup();
  await act(async () => { await expect(result.current.submit(input)).rejects.toThrow(/chưa hoàn tất/); });
  expect(result.current.pending?.operationId).toBe('operation1'); expect(result.current.receipt).toBeNull(); expect(result.current.error).not.toContain('constraint');
  await act(async () => { await result.current.retry(); });
  expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.execute).toHaveBeenCalledTimes(2); expect(api.execute.mock.lastCall).toEqual(['org1', 'operation1']);
});
it('recovers a lost preparation before accepting a changed intent, without creating the new form', async () => {
  api.prepare.mockRejectedValueOnce(new Error('lost prepare')); api.readRequest.mockRejectedValueOnce(new Error('read unavailable'));
  const { result } = setup();
  await act(async () => { await expect(result.current.submit(input)).rejects.toThrow(); });
  const savedRequest = api.prepare.mock.calls[0][1].requestId;
  api.readRequest.mockResolvedValue(completed);
  await act(async () => { const recovered = await result.current.submit({ ...input, quoteHash: 'changed', payload: { ...input.payload, intents: input.payload.intents.map(intent => ({ ...intent, gross_amount: '3000000' })) } });
    expect(recovered.recovered).toBe(true); expect(recovered.operation).toEqual(completed); });
  expect(api.readRequest.mock.lastCall).toEqual(['org1', savedRequest]); expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.execute).not.toHaveBeenCalled();
});
it('reuses the same request when preparation is not found, then retries the saved intent', async () => {
  api.prepare.mockRejectedValueOnce(new Error('lost prepare')); api.readRequest.mockResolvedValue({ status: 'NOT_FOUND', operation_id: null });
  const { result } = setup();
  await act(async () => { await expect(result.current.submit(input)).rejects.toThrow(); });
  const savedRequest = api.prepare.mock.calls[0][1].requestId;
  await act(async () => { await result.current.retry(); });
  expect(api.prepare.mock.calls[1][1].requestId).toBe(savedRequest); expect(api.prepare.mock.calls[1][1].payload).toEqual(input.payload);
});
it('does not start dependent execute after unmount while prepare is pending', async () => {
  const prepared = deferred<{ operation_id: string; status: string }>(); api.prepare.mockReturnValue(prepared.promise);
  const { result, unmount } = setup();
  const attempt = result.current.submit(input).catch(() => null);
  await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(1)); unmount();
  await act(async () => { prepared.resolve({ operation_id: 'operation1', status: 'READY' }); await attempt; });
  expect(api.execute).not.toHaveBeenCalled(); expect(api.read).not.toHaveBeenCalled();
});
it.each(['completed preparation read', 'recovery read', 'execute response'])('discards the old %s after scope changes and resets the new scope busy state', async stage => {
  const delayed = deferred<typeof completed>();
  if (stage === 'completed preparation read') api.prepare.mockResolvedValue({ operation_id: 'operation1', status: 'COMPLETED' });
  if (stage === 'recovery read') api.execute.mockRejectedValue(new Error('network'));
  if (stage === 'execute response') api.execute.mockReturnValue(delayed.promise); else api.read.mockReturnValue(delayed.promise);
  const { result, rerender } = renderHook(({ org, contract }) => useRentSupportPayout(org, contract), { initialProps: { org: 'org1', contract: 'contract1' }, wrapper: ({ children }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider> });
  const attempt = result.current.submit(input).catch(() => null);
  await waitFor(() => expect(stage === 'execute response' ? api.execute : api.read).toHaveBeenCalled());
  rerender({ org: 'org2', contract: 'contract2' });
  expect(result.current.isPending).toBe(false); expect(result.current.pending).toBeNull();
  await act(async () => { delayed.resolve(completed); await attempt; });
  expect(result.current.receipt).toBeNull(); expect(result.current.pending).toBeNull(); expect(result.current.error).toBeNull(); expect(result.current.isPending).toBe(false);
});
