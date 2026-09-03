import { describe, expect, it } from 'vitest';
import { buildRegistry, buildRegistryDefinitions, toLlmTools, toPageAgentTools } from '../tools/registry';
import { makeUiControlStepGuard, uiControlGuard } from '../uiControlAvailability';
import type { PermissionsMap } from '@/lib/permissions';
import type { CopilotAvailabilitySnapshot } from '../featureFlags';

const SUPER: PermissionsMap = { __superadmin: true } as unknown as PermissionsMap;
const ORG = 'aaaa0000-0000-4000-8000-000000000001';

/**
 * Ba trường `ToolCtx` không liên quan tới điều đang đo — khai một lần.
 *
 * `isSuperAdmin: false` là mặc định CÓ CHỦ Ý: tool `superAdminOnly` phải vắng mặt
 * trừ khi một ca nói rõ người dùng là super admin.
 */
const CTX_NEN = { threadId: null, generation: 0, isSuperAdmin: false };

describe('Copilot availability adapters', () => {
  it('requires every tool to declare rollout keys or an explicit exemption', () => {
    const registry = buildRegistryDefinitions();
    expect(registry.length).toBeGreaterThan(0);
    for (const tool of registry) {
      const hasKeys = Boolean(tool.rolloutKey);
      expect(
        hasKeys || tool.rolloutExempt === true,
        `tool "${tool.name}" is missing rollout metadata`,
      ).toBe(true);
    }
  });

  it('fails closed for rollout-controlled page tools when snapshot is missing or stale', () => {
    const stale = { revision: 1, fetchedAt: 0, organizationId: ORG, states: { 'page:rooms.list': 'enabled' as const } };
    const ctx = { ...CTX_NEN, perms: SUPER, organizationId: ORG, availability: stale };
    const llm = toLlmTools(buildRegistryDefinitions(), ctx);
    const page = toPageAgentTools(buildRegistryDefinitions(), ctx);
    expect(llm.phong_trong).toBeUndefined();
    expect(page.phong_trong).toBeUndefined();
  });

  it('fails closed for every tool when availability is explicitly null', () => {
    const ctx = { ...CTX_NEN, perms: SUPER, organizationId: ORG, availability: null };
    expect(Object.keys(toLlmTools(buildRegistryDefinitions(), ctx))).toEqual([]);
    expect(Object.keys(toPageAgentTools(buildRegistryDefinitions(), ctx))).toEqual([]);
    expect(buildRegistry(null)).toEqual([]);
  });

  it('fails closed when a caller omits the availability snapshot', () => {
    const ctx = { ...CTX_NEN, perms: SUPER, organizationId: ORG };
    expect(Object.keys(toLlmTools(buildRegistryDefinitions(), ctx))).toEqual([]);
    expect(Object.keys(toPageAgentTools(buildRegistryDefinitions(), ctx))).toEqual([]);
    expect(buildRegistry()).toEqual([]);
  });

  it('fails closed when the availability snapshot belongs to another organization', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 3,
      fetchedAt: Date.now(),
      organizationId: 'dddd0000-0000-4000-8000-000000000001',
      states: {
        'page:rooms.list': 'enabled' as const,
        'page:customers.list': 'enabled' as const,
        'page:invoices.list': 'enabled' as const,
      },
    };
    const ctx = { ...CTX_NEN, perms: SUPER, organizationId: ORG, availability: snapshot };
    expect(Object.keys(toLlmTools(buildRegistryDefinitions(), ctx))).toEqual([]);
    expect(Object.keys(toPageAgentTools(buildRegistryDefinitions(), ctx))).toEqual([]);
  });

  it('rechecks the organization binding before a wrapped tool executes', async () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 3,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled' as const },
    };
    const ctx = { ...CTX_NEN, perms: SUPER, organizationId: ORG, availability: snapshot };
    const tool = toPageAgentTools(buildRegistryDefinitions(), ctx).phong_trong;
    expect(tool).toBeDefined();
    ctx.organizationId = 'dddd0000-0000-4000-8000-000000000001';
    await expect(tool!.execute({}, { signal: new AbortController().signal })).rejects.toThrow(
      /organization_mismatch/,
    );
  });

  it('allows explicit exemptions only after a fresh server snapshot is present', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 2,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled' as const },
    };
    const ctx = { ...CTX_NEN, perms: SUPER, organizationId: ORG, availability: snapshot };
    expect(toLlmTools(buildRegistryDefinitions(), ctx).huong_dan).toBeDefined();
    expect(toLlmTools(buildRegistryDefinitions(), ctx).phong_trong).toBeDefined();
  });

  it('exposes only enabled page tools and keeps shadow non-executable', () => {
    const snapshot = {
      revision: 2,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled' as const, 'page:customers.list': 'shadow' as const },
    };
    const ctx = { ...CTX_NEN, perms: SUPER, organizationId: ORG, availability: snapshot };
    const llm = toLlmTools(buildRegistryDefinitions(), ctx);
    expect(llm.phong_trong).toBeDefined();
    expect(llm.tim_khach_hang).toBeUndefined();
    expect(toPageAgentTools(buildRegistryDefinitions(), ctx).phong_trong).toBeDefined();
  });

  it('rechecks rollout state immediately before a wrapped tool executes', async () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 4,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: {
        'page:copilot.navigation': 'enabled' as const,
      },
    };
    let navigated = '';
    const tool = toPageAgentTools(buildRegistryDefinitions(), {
      ...CTX_NEN,
      perms: SUPER,
      organizationId: ORG,
      navigate: (to) => { navigated = to; },
      availability: snapshot,
    }).mo_trang;
    expect(tool).toBeDefined();
    snapshot.states['page:copilot.navigation'] = 'disabled';
    await expect(tool!.execute({ trang: 'rooms.list' }, { signal: new AbortController().signal })).rejects.toThrow(
      /rollout_unavailable/,
    );
    expect(navigated).toBe('');
  });

  it('requires a declared page, enabled rollout, matching organization, and page permission for UI-control', () => {
    const base = {
      perms: SUPER,
      organizationId: ORG,
      availability: {
        revision: 5,
        fetchedAt: Date.now(),
        organizationId: ORG,
        states: { 'page:rooms.list': 'enabled' as const },
      },
    };
    expect(uiControlGuard({ pathname: '/apartments', ctx: base }).allowed).toBe(true);
    expect(
      uiControlGuard({
        pathname: '/apartments',
        ctx: { ...base, availability: { ...base.availability, states: { 'page:rooms.list': 'shadow' as const } } },
      }).allowed,
    ).toBe(false);
    expect(uiControlGuard({ pathname: '/buildings', ctx: base }).allowed).toBe(false);
    expect(uiControlGuard({ pathname: '/apartments', ctx: { ...base, organizationId: null } }).allowed).toBe(false);
    expect(
      uiControlGuard({ pathname: '/apartments', ctx: { ...base, perms: { rooms: { view: false } } } }).allowed,
    ).toBe(false);
  });

  it('rechecks route and page availability before each UI-control step', () => {
    const ctx: {
      perms: PermissionsMap;
      organizationId: string;
      availability: CopilotAvailabilitySnapshot;
    } = {
      perms: SUPER,
      organizationId: ORG,
      availability: {
        revision: 6,
        fetchedAt: Date.now(),
        organizationId: ORG,
        states: { 'page:rooms.list': 'enabled' },
      },
    };
    let pathname = '/apartments';
    const guard = makeUiControlStepGuard(ctx, ['/apartments', '/invoices', '/customers'], () => pathname);
    expect(() => guard()).not.toThrow();
    pathname = '/buildings';
    expect(() => guard()).toThrow(/outside_allowlist/);
    pathname = '/apartments';
    ctx.availability.states['page:rooms.list'] = 'shadow';
    expect(() => guard()).toThrow(/page_rollout_disabled/);
  });
});
