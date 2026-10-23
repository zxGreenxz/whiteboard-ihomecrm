import { describe, expect, it } from 'vitest';
import { HERMES_ACTION_CAPABILITIES, HERMES_ACTION_FOUNDATION_KEYS, HERMES_INVOICE_ACTION_KEYS, HERMES_READ_CAPABILITIES } from '../../infra/hermes-broker/capability-contract.mjs';
import { W2_HERMES_ONLY_KEYS, W2_READ_KEY_LIST } from '../../infra/hermes-broker/wave2-registry.mjs';
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
    expect(hermesCapabilityHint('income_expenses.approve')).toContain('không công cụ nào dùng khoá này');
    expect(hermesCapabilityHint('income_expenses.create')).toContain('luôn xem trước');
    expect(hermesCapabilityHint('toString')).toBeUndefined();
    expect(hermesCapabilityLabel('constructor')).toBe('constructor');
  });
  it('đợt 1 nền chung: every pre-registered write key is an action key, a CRM catalog key with a Hermes hint, or a labelled Hermes-only key', () => {
    const hermesOnly = ['income_expenses.approve_vouchers', 'assistant.action_probe'];
    expect(HERMES_ACTION_FOUNDATION_KEYS).toHaveLength(14);
    expect(HERMES_ACTION_FOUNDATION_KEYS).not.toContain('thu_tien.collect');
    for (const key of HERMES_ACTION_FOUNDATION_KEYS) {
      expect(HERMES_ACTION_CAPABILITIES.includes(key), key).toBe(true);
      expect(HERMES_READ_CAPABILITIES.includes(key), key).toBe(false);
      if (hermesOnly.includes(key)) {
        expect(catalog.has(key), key).toBe(false);
        expect(hermesCapabilityLabel(key), key).not.toBe(key);
      } else {
        expect(catalog.has(key), key).toBe(true);
        expect(hermesCapabilityHint(key), key).toMatch(/^Hermes: /);
      }
    }
  });
  it('đợt 3 hoá đơn: khoá thu tiền là khoá riêng Hermes có nhãn (không trong catalog CRM, không phải thu_tien.collect); nhãn hai khoá hoá đơn đúng nghĩa', () => {
    expect(HERMES_INVOICE_ACTION_KEYS).toEqual(['thu_tien.collect_transfer']);
    for (const key of HERMES_INVOICE_ACTION_KEYS) {
      expect(HERMES_ACTION_CAPABILITIES.includes(key), key).toBe(true);
      expect(catalog.has(key), key).toBe(false);
      expect(hermesCapabilityLabel(key)).toMatch(/không tiền mặt, có xem trước/);
    }
    expect(HERMES_ACTION_CAPABILITIES).not.toContain('thu_tien.collect');
    expect(hermesCapabilityHint('invoices.edit')).not.toContain('xác nhận kiểm tra');
    expect(hermesCapabilityHint('invoices.approve')).toContain('không phải duyệt hoá đơn');
  });
  it('wave 2: every new read key is a CRM catalog key with a Hermes hint, or a labelled Hermes-only key', () => {
    for (const key of W2_READ_KEY_LIST) {
      expect(HERMES_READ_CAPABILITIES.includes(key), key).toBe(true);
      if (W2_HERMES_ONLY_KEYS.includes(key)) {
        expect(catalog.has(key), key).toBe(false);
        expect(hermesCapabilityLabel(key), key).not.toBe(key);
      } else {
        expect(catalog.has(key), key).toBe(true);
        expect(hermesCapabilityHint(key), key).toMatch(/^Hermes: /);
      }
    }
  });
});
