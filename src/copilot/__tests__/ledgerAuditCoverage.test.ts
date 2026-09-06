import { describe, expect, it } from 'vitest';
import { ACTION_CATALOG, type ActionCatalogEntry } from '../plan/actionCatalog';
import { doiChieuSo } from '../../../scripts/copilot-ledger-audit.mjs';

const org = 'dddd0000-0000-4000-8000-000000000001';
const registry = (Object.values(ACTION_CATALOG) as ActionCatalogEntry[])
  .filter(r => r.executorKind === 'direct_l5_v1')
  .map(r => ({ action_id: r.actionId, executor_kind: r.executorKind, risk: r.risk, grantable: false, pin_always: true }));
const bounds = { org, since: '2026-09-01T00:00:00Z', until: '2026-09-06T00:00:00Z' };

describe('ledger identity correction retains dynamic direct L5 checks', () => {
  it('checks every catalog direct L5 action and a newly registered action', async () => {
    expect(registry).toHaveLength(24);
    const dynamicRegistry = [...registry, { ...registry[0], action_id: 'future.new_action' }];
    for (const action of dynamicRegistry) {
      const client = { async rpc(_jwt: string, _name: string, args: { p_stream: string }) {
        const rows = args.p_stream === 'audit' ? [] : [{
          id: '00000000-0000-4000-8000-000000000001', created_at: '2026-09-03T00:00:00Z', organization_id: org,
          action_id: action.action_id, event: 'step_done', plan_id: 'plan', plan_present: true,
          plan_actor_matches: true, plan_org_matches: true, plan_consent_matches: true,
          entity_evidence: 'match', audit_present: true, audit_matches: true,
          action_executions: 1, step_links: 1, duplicate_executions: false, has_after_digest: true,
          consent_kind: 'click', consent_evidence: 'valid',
        }];
        return { status: 200, body: { version: 1, rows, total: rows.length, missing_step_ledger: 0, registry: dynamicRegistry } };
      } };
      const report = await doiChieuSo(client, 'offline', bounds);
      expect(report.counts.unintendedWrite, action.action_id).toBe(1);
      expect(report.directL5Actions, action.action_id).toEqual(dynamicRegistry.map(r => r.action_id));
      expect(report.canaryDurationVerified).toBe(false);
    }
  });
});
