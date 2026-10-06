import { afterEach, expect, it, vi } from 'vitest';
import { request, signInTest } from '../test-voucher-detail-read-authz.mjs';

afterEach(() => vi.unstubAllGlobals());
const context = signal => ({ url: 'https://test.invalid', cred: { testPublishableKey: 'test-key' }, signal, writeState: { uncertain: false } });

it('stops later JWT reads, logins and writes after lease cancellation', async () => {
  let started = 0;
  vi.stubGlobal('fetch', async () => { started++; return new Response('{}'); });
  const abort = new AbortController(); abort.abort(new Error('lease lost'));
  const ctx = context(abort.signal);
  await expect(request(ctx, 'jwt', 'income_expenses')).rejects.toThrow('lease lost');
  await expect(request(ctx, 'jwt', 'rpc/append_income_expense_supplement_v1', {})).rejects.toThrow('lease lost');
  await expect(signInTest(ctx, 'fixture@example.invalid', 'test-password')).rejects.toThrow('lease lost');
  expect(started).toBe(0);
});

it('waits for an in-flight write result after cancellation instead of racing cleanup against an aborted fetch', async () => {
  let complete, suppliedSignal;
  vi.stubGlobal('fetch', async (_url, options) => {
    suppliedSignal = options.signal;
    return new Promise(resolve => { complete = () => resolve(new Response('{}')); });
  });
  const abort = new AbortController(), ctx = context(abort.signal);
  const writing = request(ctx, 'jwt', 'rpc/append_income_expense_supplement_v1', {});
  abort.abort(new Error('SIGINT'));
  expect(suppliedSignal?.aborted ?? false).toBe(false);
  complete(); await writing;
  await expect(request(ctx, 'jwt', 'income_expenses')).rejects.toThrow('SIGINT');
});

it('retains uncertainty on a write whose connection failed before its result was known', async () => {
  vi.stubGlobal('fetch', async () => { throw new Error('socket lost'); });
  const ctx = context(new AbortController().signal);
  await expect(request(ctx, 'jwt', 'rpc/append_income_expense_supplement_v1', {})).rejects.toThrow('socket lost');
  expect(ctx.writeState.uncertain).toBe(true);
});

it('retains uncertainty when a gateway returns 504 while a write may still commit', async () => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 504 }));
  const ctx = context(new AbortController().signal);
  await request(ctx, 'jwt', 'rpc/append_income_expense_supplement_v1', {});
  expect(ctx.writeState.uncertain).toBe(true);
});

it('retains uncertainty when a write response body cannot be decoded', async () => {
  vi.stubGlobal('fetch', async () => new Response('truncated-json'));
  const ctx = context(new AbortController().signal);
  await expect(request(ctx, 'jwt', 'rpc/append_income_expense_supplement_v1', {})).rejects.toThrow();
  expect(ctx.writeState.uncertain).toBe(true);
});
