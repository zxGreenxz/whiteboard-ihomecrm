import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupAccountingFixtureAccess,
  prepareAccountingFixtureAccess,
  type AccountingAccessScope,
} from '../../.e2e-fleet/specs/accounting-admin';

const scope: AccountingAccessScope = {
  marker: '[E2E-ACCOUNTING:unit-123]',
  actorId: '10000000-0000-4000-8000-000000000001',
  buildingId: '20000000-0000-4000-8000-000000000001',
  receivingAccountId: '30000000-0000-4000-8000-000000000001',
};
const bindingId = '40000000-0000-4000-8000-000000000001';
const fetchMock = vi.fn<typeof fetch>();
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.stubEnv('SUPABASE_PAT', 'unit-test-pat');
  vi.stubEnv('SUPABASE_PROJECT_REF', 'fixturetest');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('accounting fixture access boundary', () => {
  it('accepts a verified existing grant without claiming ownership of it', async () => {
    fetchMock.mockResolvedValue(reply([{ has_access: true, owned_binding_ids: [] }]));
    expect(await prepareAccountingFixtureAccess(scope)).toEqual([]);
  });
  it('returns only the run-owned grant identities after setup', async () => {
    fetchMock.mockResolvedValue(reply([{ has_access: true, owned_binding_ids: [bindingId] }]));
    expect(await prepareAccountingFixtureAccess(scope)).toEqual([bindingId]);
  });
  it.each([[], [{ has_access: false, owned_binding_ids: [] }], [{ has_access: true }]].map(rows => ({ rows })))(
    'does not turn incomplete or denied setup into ready: $rows', async ({ rows }) => {
      fetchMock.mockResolvedValue(reply(rows));
      await expect(prepareAccountingFixtureAccess(scope)).rejects.toThrow(/quyền sổ TT/);
    },
  );
  it.each(['ordinary-note', '[E2E-ACCOUNTING:bad%]', '[E2E-ACCOUNTING:bad_]'])('rejects an unsafe ownership marker %s before SQL', async marker => {
    await expect(prepareAccountingFixtureAccess({ ...scope, marker })).rejects.toThrow(/marker/);
    await expect(cleanupAccountingFixtureAccess({ ...scope, marker })).rejects.toThrow(/marker/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects malformed scope identities before SQL', async () => {
    await expect(prepareAccountingFixtureAccess({ ...scope, receivingAccountId: "not-a-uuid'" })).rejects.toThrow(/UUID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('preserves a database rejection of a non-DEMO or changed fixture', async () => {
    fetchMock.mockResolvedValue(reply({ message: 'Accounting access scope is not the expected DEMO fixture' }, 400));
    await expect(prepareAccountingFixtureAccess(scope)).rejects.toThrow(/expected DEMO fixture/);
  });
  it('requires cleanup readback rather than accepting an empty response', async () => {
    fetchMock.mockResolvedValue(reply([]));
    await expect(cleanupAccountingFixtureAccess(scope)).rejects.toThrow(/dọn quyền/);
  });
  it('fails cleanup if any owned binding remains', async () => {
    fetchMock.mockResolvedValue(reply([{ remaining: 1 }]));
    await expect(cleanupAccountingFixtureAccess(scope)).rejects.toThrow(/dọn quyền/);
  });
  it('accepts cleanup only after zero owned bindings remain', async () => {
    fetchMock.mockResolvedValue(reply([{ remaining: 0 }]));
    await expect(cleanupAccountingFixtureAccess(scope)).resolves.toBeUndefined();
  });
});
