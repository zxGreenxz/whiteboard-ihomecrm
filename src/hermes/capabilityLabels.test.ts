import { describe, expect, it } from 'vitest';
import { HERMES_ACTION_CAPABILITIES, HERMES_READ_CAPABILITIES } from '../../infra/hermes-broker/capability-contract.mjs';
import { VISIBLE_PAGE_GROUPS, featureKey } from '@/lib/permissionPages';
import { hermesCapabilityHint, hermesCapabilityLabel } from './capabilityLabels';

const catalog = new Set(VISIBLE_PAGE_GROUPS.flatMap(group => group.pages.flatMap(page => page.features.map(featureKey))));

describe('Hermes capability labels', () => {
  it('gives every supported key a Vietnamese label: CRM catalog label or a Hermes-only label', () => {
    for (const key of [...HERMES_READ_CAPABILITIES, ...HERMES_ACTION_CAPABILITIES]) {
      expect(catalog.has(key) || hermesCapabilityLabel(key) !== key, key).toBe(true);
    }
  });
  it('states the narrower Hermes meaning for finance, customer and task-follow keys', () => {
    for (const key of ['income_expenses.create', 'income_expenses.approve', 'income_expenses.view', 'meter_readings.view', 'deposits.view',
      'reports_finance.analysis', 'customers.create', 'leads.create', 'tasks.edit', 'tasks.delete']) {
      expect(HERMES_READ_CAPABILITIES.includes(key) || HERMES_ACTION_CAPABILITIES.includes(key), key).toBe(true);
      expect(hermesCapabilityHint(key), key).toMatch(/^Hermes: /);
    }
    expect(hermesCapabilityHint('income_expenses.approve')).toContain('không có công cụ duyệt');
    expect(hermesCapabilityHint('toString')).toBeUndefined();
    expect(hermesCapabilityLabel('constructor')).toBe('constructor');
  });
});
