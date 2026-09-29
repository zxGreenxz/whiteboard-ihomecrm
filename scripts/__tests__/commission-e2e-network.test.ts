import { describe, expect, it } from 'vitest';
import { createNavigationReadGuard } from '../lib/commission-e2e-network.mjs';
const appOrigin = 'http://127.0.0.1:4186', testOrigin = 'https://test.supabase.co';
const request = (path: string, method = 'GET', origin = testOrigin) => ({ url: () => origin + path, method: () => method });
const setup = () => createNavigationReadGuard({ appOrigin, testOrigin });
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
