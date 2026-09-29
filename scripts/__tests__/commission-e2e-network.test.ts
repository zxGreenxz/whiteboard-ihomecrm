import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNavigationReadGuard, safeHttpFailure, requestCommissionProbe } from '../lib/commission-e2e-network.mjs';
const appOrigin = 'http://127.0.0.1:4186', testOrigin = 'https://test.supabase.co';
const request = (path: string, method = 'GET', origin = testOrigin) => ({ url: () => origin + path, method: () => method });
const setup = () => createNavigationReadGuard({ appOrigin, testOrigin });
afterEach(() => vi.restoreAllMocks());

it('retains only a standard code and recognized infrastructure message', () => {
  expect(safeHttpFailure({ code: '57014', message: 'canceling statement due to statement timeout', details: 'private details', hint: 'secret' }))
    .toEqual({ code: '57014', message: 'canceling statement due to statement timeout' });
});
it('does not leak unknown server messages or arbitrary codes', () => {
  expect(safeHttpFailure({ code: 'private credentials!', message: 'account secret', data: { secret: 'x' } }))
    .toEqual({ message: 'HTTP error; response message omitted' });
});
it('omits uppercase private strings that previously matched the broad code regex', () => {
  expect(safeHttpFailure({ code: 'PRIVATE_CREDENTIALS', message: 'private' }))
    .toEqual({ message: 'HTTP error; response message omitted' });
});
it.each(['57014', '42501', '0A000', 'PGRST003'])('accepts the actual structured code format %s', code => {
  expect(safeHttpFailure({ code }).code).toBe(code);
});
it.each([500, 503])('retains status and elapsed time when the JWT probe receives HTML HTTP%s', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>private gateway body</html>', { status }));
  const result = await requestCommissionProbe({ url: testOrigin, cred: { testPublishableKey: 'test-public-key' } },
    'test-jwt', 'rpc/list_contract_commission_followups_v2', {});
  expect(result.status).toBe(status); expect(result.json).toBeNull(); expect(result.ms).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(result)).not.toContain('private');
});
it('sends the real actor JWT boundary and preserves a valid JSON result', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ rows: [], total: 0 }));
  const body = { p_contract_ids: ['fixture'] };
  const result = await requestCommissionProbe({ url: testOrigin, cred: { testPublishableKey: 'test-public-key' } },
    'test-jwt', 'rpc/list_contract_commission_followups_v2', body);
  expect(result).toMatchObject({ status: 200, json: { rows: [], total: 0 } });
  expect(fetch).toHaveBeenCalledWith(`${testOrigin}/rest/v1/rpc/list_contract_commission_followups_v2`, {
    method: 'POST', headers: { apikey: 'test-public-key', Authorization: 'Bearer test-jwt',
      'Content-Type': 'application/json', 'Accept-Profile': 'public', 'Content-Profile': 'public' },
    body: JSON.stringify(body),
  });
});
describe('harness navigation cancellation boundary', () => {
  it.each(['/rest/v1/invoices', '/rest/v1/income_expenses'])('records the exact in-flight read %s', path => {
    const guard = setup(), read = request(path); guard.started(read); guard.snapshot('reload');
    expect(guard.cancelled(read, 'net::ERR_ABORTED')).toMatchObject({ boundary: '1:reload', path });
  });
  it('does not allow a new request with the same URL after the snapshot', () => {
    const guard = setup(), old = request('/rest/v1/invoices'), fresh = request('/rest/v1/invoices');
    guard.started(old); guard.snapshot('reload'); guard.started(fresh);
    expect(guard.cancelled(fresh, 'net::ERR_ABORTED')).toBeNull();
  });
  it('does not classify completed requests or failures without deliberate navigation', () => {
    const guard = setup(), read = request('/rest/v1/rooms'); guard.started(read);
    expect(guard.cancelled(read, 'net::ERR_ABORTED')).toBeNull();
    guard.finished(read); guard.snapshot('reload'); expect(guard.cancelled(read, 'net::ERR_ABORTED')).toBeNull();
  });
  it.each(['POST', 'PATCH', 'DELETE'])('never exempts table mutation %s', method => {
    const guard = setup(), mutation = request('/rest/v1/income_expenses', method);
    guard.started(mutation); guard.snapshot('close'); expect(guard.cancelled(mutation, 'net::ERR_ABORTED')).toBeNull();
  });
  it.each(['execute_commission_request_v1', 'prepare_commission_requests_v1', 'unknown_rpc'])('never exempts mutation/unknown RPC %s', name => {
    const guard = setup(), mutation = request(`/rest/v1/rpc/${name}`, 'POST');
    guard.started(mutation); guard.snapshot('reload'); expect(guard.cancelled(mutation, 'net::ERR_ABORTED')).toBeNull();
  });
  it('records verified reader RPCs and local module reads only', () => {
    const guard = setup();
    const reads = [request('/rest/v1/rpc/list_contract_commission_followups_v2', 'POST'),
      request('/rest/v1/rpc/business_performance_organizations_v1', 'POST'), request('/src/module.ts', 'GET', appOrigin)];
    reads.forEach(guard.started); guard.snapshot('reload');
    for (const read of reads) expect(guard.cancelled(read, 'net::ERR_ABORTED')).not.toBeNull();
  });
  it('never covers HTTP500 or an unrelated network failure', () => {
    const guard = setup(), read = request('/rest/v1/rooms'); guard.started(read); guard.snapshot('reload');
    expect(guard.cancelled(read, 'net::ERR_ABORTED', 500)).toBeNull();
    expect(guard.cancelled(read, 'net::ERR_FAILED')).toBeNull();
  });
  it('never covers another Supabase target', () => {
    const guard = setup(), read = request('/rest/v1/rooms', 'GET', 'https://production.supabase.co');
    guard.started(read); guard.snapshot('reload'); expect(guard.cancelled(read, 'net::ERR_ABORTED')).toBeNull();
  });
});
