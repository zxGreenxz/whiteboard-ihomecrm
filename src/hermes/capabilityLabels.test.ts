import { describe, expect, it } from 'vitest';
import { HERMES_ACTION_CAPABILITIES, HERMES_ACTION_FOUNDATION_KEYS, HERMES_CAPABILITIES, HERMES_INVOICE_ACTION_KEYS, HERMES_LEARNING_ACTION_KEYS,
  HERMES_READ_CAPABILITIES } from '../../infra/hermes-broker/capability-contract.mjs';
import { W2_HERMES_ONLY_KEYS, W2_READ_KEY_LIST } from '../../infra/hermes-broker/wave2-registry.mjs';
import { VISIBLE_PAGE_GROUPS, featureKey } from '@/lib/permissionPages';
import { hermesCapabilityHint, hermesCapabilityLabel } from './capabilityLabels';
import { SALE_ACTION_TOOLS, SALE_DEPOSIT_RECEIPT_KEY, mayUseSaleAction, saleActionOperation } from '../../infra/hermes-broker/sale-action-contract.mjs';
import { SALE_BULK_TOOLS, mayUseSaleBulk, saleBulkOperation } from '../../infra/hermes-broker/sale-bulk-contract.mjs';
import { SALE_POLICY_TOOLS, mayUseSalePolicy } from '../../infra/hermes-broker/sale-policy-contract.mjs';
import { saleToolOperation, saleToolPublic } from '../../infra/hermes-broker/sale-tool-contract.mjs';

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
  it('đợt 3 học có kiểm duyệt: khoá Bài học là khoá riêng Hermes có nhãn, mode action phạm vi công ty, không nối vào khối nền chung', () => {
    expect(HERMES_LEARNING_ACTION_KEYS).toEqual(['assistant.learning_review']);
    for (const key of HERMES_LEARNING_ACTION_KEYS) {
      expect(HERMES_ACTION_CAPABILITIES.includes(key), key).toBe(true);
      expect(HERMES_READ_CAPABILITIES.includes(key), key).toBe(false);
      expect(HERMES_ACTION_FOUNDATION_KEYS.includes(key), key).toBe(false);
      expect(HERMES_CAPABILITIES[key]).toEqual({ mode: 'action', resource: 'organization' });
      expect(catalog.has(key), key).toBe(false);
      expect(hermesCapabilityLabel(key)).toMatch(/Bài học Hermes chờ duyệt.*luôn xem trước/);
    }
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
  it('05/11 cọc làm trên web: các khoá cọc của Hermes chỉ mở tra phòng và tra yêu cầu cũ; nhãn nói đúng như vậy', () => {
    // Công cụ crm_sale_action mà broker quảng bá cho một bộ khoá: lọc như broker.mjs (công khai, rồi quyền của từng nhóm công cụ).
    const listed = (action: string[]) => [
      ...SALE_ACTION_TOOLS.filter(tool => saleToolPublic(tool) && mayUseSaleAction({ action }, saleActionOperation(tool.name))),
      ...SALE_POLICY_TOOLS.filter(tool => saleToolPublic(tool) && mayUseSalePolicy({ action })),
      ...SALE_BULK_TOOLS.filter(tool => saleToolPublic(tool) && mayUseSaleBulk({ action }, saleBulkOperation(tool.name))),
    ].map(tool => saleToolOperation(tool)).sort();
    const lookups = ['action_status', 'room_options'];
    expect(listed(['deposits.create'])).toEqual(lookups);
    expect(listed(['deposits.edit'])).toEqual(lookups);
    expect(listed([SALE_DEPOSIT_RECEIPT_KEY])).toEqual([]);
    // Đủ mọi khoá phụ mà sáu thao tác đã gỡ từng đòi (thu chi, khoá riêng báo cọc, giữ phòng): vẫn chỉ hai thao tác tra cứu.
    expect(listed(['deposits.create', 'deposits.edit', SALE_DEPOSIT_RECEIPT_KEY, 'income_expenses.create', 'income_expenses.approve', 'sale_phong.lock_room'])).toEqual(lookups);
    // Nhãn nói đúng điều đó và chỉ đường tới trang Quản lý cọc như câu lỗi sale_deposit_web_only của broker.
    expect(hermesCapabilityLabel(SALE_DEPOSIT_RECEIPT_KEY)).toMatch(/^Đã gỡ: /);
    expect(hermesCapabilityHint('deposits.create')).toMatch(/^Hermes: chỉ tra danh sách phòng và yêu cầu cũ; báo cọc, thu thêm cọc làm trên web/);
    expect(hermesCapabilityHint('deposits.edit')).toMatch(/^Hermes: chỉ tra danh sách phòng và yêu cầu cũ; sửa cọc, gắn khách vào cọc làm trên web/);
    for (const text of [hermesCapabilityLabel(SALE_DEPOSIT_RECEIPT_KEY), hermesCapabilityHint('deposits.create'), hermesCapabilityHint('deposits.edit')]) {
      expect(text).toContain('trang Quản lý cọc (/deposits)');
    }
  });
});
