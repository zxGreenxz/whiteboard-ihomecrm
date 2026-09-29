import { afterEach, expect, it, vi } from 'vitest';
import { createScopedActor } from '../lib/commission-e2e-scoped-actor.mjs';

afterEach(() => vi.restoreAllMocks());
it.each([
  ['another-project', 'aaaa0000-0000-4000-8000-000000000001'],
  ['hzulujxgonszuleqticb', 'another-organization'],
])('refuses to create an actor outside the pinned TEST REAL clone: %s %s', async (testRef, organizationId) => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const query = vi.fn(), record = vi.fn();
  await expect(createScopedActor({ ctx: { cred: { testRef } }, db: { query }, organizationId,
    buildingId: 'building', ownerId: 'owner', marker: 'marker', record })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
});
