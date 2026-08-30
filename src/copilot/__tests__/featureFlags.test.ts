import { describe, expect, it } from 'vitest';
import {
  copilotAvailability,
  fetchCopilotAvailability,
  parseCopilotAvailability,
  filterAvailableContractKeys,
  COPILOT_ROLLOUT_CONTRACTS,
  rolloutRowsFromAvailability,
  copilotRolloutTransitions,
  formatCopilotRolloutError,
  type CopilotAvailabilitySnapshot,
} from '../featureFlags';

const ORG = 'aaaa0000-0000-4000-8000-000000000001';

describe('Copilot feature flags', () => {
  it('fails closed for missing or stale snapshots', () => {
    expect(copilotAvailability(undefined, 'rooms.list')).toBe('disabled');
    const stale: CopilotAvailabilitySnapshot = { revision: 1, fetchedAt: 0, organizationId: ORG, states: { 'page:rooms.list': 'enabled' } };
    expect(copilotAvailability(stale, 'rooms.list', 60_000, 60_001)).toBe('disabled');
  });

  it('exposes enabled keys only; shadow is not executable', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 2,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled', 'page:invoices.list': 'shadow', 'page:customers.list': 'disabled' },
    };
    expect(filterAvailableContractKeys(['rooms.list', 'invoices.list', 'customers.list'], snapshot)).toEqual(['rooms.list']);
  });

  it('keeps page and action rollout keys independent', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 3,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:shared.read': 'enabled', 'action:shared.read': 'disabled' },
    };
    expect(copilotAvailability(snapshot, 'shared.read')).toBe('enabled');
    expect(copilotAvailability(snapshot, 'action:shared.read')).toBe('disabled');
  });

  it('accepts only server snapshots with a finite revision, timestamp, and valid states', () => {
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, organization_id: ORG, states: { 'page:rooms.list': 'enabled' } })).toEqual({
      revision: 4,
      // Numeric epoch values below the millisecond range are interpreted as
      // seconds; the client contract stores timestamps in milliseconds.
      fetchedAt: 1_234_000,
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled' },
    });
    expect(parseCopilotAvailability({ revision: 0, fetchedAt: 1234, organizationId: ORG, states: { 'page:rooms.list': 'enabled' } })).toBeNull();
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, organizationId: ORG, states: { 'page:rooms.list': 'ON' } })).toBeNull();
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, organizationId: ORG, states: { 'rooms.list': 'enabled' } })).toBeNull();
    expect(parseCopilotAvailability(['rooms.list'])).toBeNull();
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, states: { 'page:rooms.list': 'enabled' } })).toBeNull();
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, organizationId: ORG, organization_id: 'other', states: { 'page:rooms.list': 'enabled' } })).toBeNull();
  });

  it('fails closed when the server availability RPC errors or returns malformed data', async () => {
    const rpc = async () => ({ data: { revision: 1, fetchedAt: 1_700_000_000_000, organization_id: 'org-1', states: { 'page:rooms.list': 'enabled' } }, error: null });
    await expect(fetchCopilotAvailability('org-1', rpc, 1_700_000_000_001)).resolves.toMatchObject({ revision: 1, organizationId: 'org-1' });
    const malformed = async () => ({ data: { revision: 1, fetchedAt: 1_700_000_000_000, organization_id: 'org-1', states: { 'page:rooms.list': 'ON' } }, error: null });
    await expect(fetchCopilotAvailability('org-1', malformed, 1_700_000_000_001)).resolves.toBeNull();
    const failed = async () => ({ data: null, error: new Error('network') });
    await expect(fetchCopilotAvailability('org-1', failed, 200)).resolves.toBeNull();
  });

  it('does not query availability without a selected organization', async () => {
    let called = false;
    const rpc = async () => {
      called = true;
      return { data: null, error: null };
    };
    await expect(fetchCopilotAvailability(null, rpc, 200)).resolves.toBeNull();
    expect(called).toBe(false);
  });

  it('projects the server snapshot into the admin rollout rows without inventing enabled state', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 7,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled', 'page:customers.list': 'shadow' },
    };
    const rows = rolloutRowsFromAvailability(snapshot);
    expect(rows).toHaveLength(COPILOT_ROLLOUT_CONTRACTS.length);
    expect(rows.find((row) => row.contractId === 'rooms.list')?.state).toBe('enabled');
    expect(rows.find((row) => row.contractId === 'customers.list')?.state).toBe('shadow');
    expect(rows.find((row) => row.contractId === 'invoices.list')?.state).toBe('disabled');
    expect(rows.every((row) => row.revision === 7)).toBe(true);
  });

  it('only offers legal rollout transitions and maps CAS conflicts to an operator action', () => {
    expect(copilotRolloutTransitions('disabled')).toEqual(['shadow']);
    expect(copilotRolloutTransitions('shadow')).toEqual(['enabled', 'disabled']);
    expect(copilotRolloutTransitions('enabled')).toEqual(['shadow', 'disabled']);
    expect(formatCopilotRolloutError(new Error('copilot_rollout_stale_revision'))).toContain('tải lại');
    expect(formatCopilotRolloutError(new Error('rollout_evidence_required'))).toContain('bằng chứng');
  });
});
