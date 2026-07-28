import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('customer credit client enablement', () => {
  it('does not keep temporary client-side credit locks after the canonical route is enabled', () => {
    for (const path of [
      'src/hooks/useInvoicePayments.ts',
      'src/hooks/useBulkRecordPayment.ts',
      'src/hooks/useInvoices.ts',
    ]) {
      const source = read(path);
      expect(source, path).not.toContain('TẠM KHÓA:');
      expect(source, path).not.toContain('đang tạm khóa để đối soát kế toán');
    }
  });

  it('ships a guarded migration that enables non-cash credit and preserves TM-only refunds', () => {
    const migration = readdirSync('supabase/migrations')
      .find((name) => name.endsWith('_enable_non_cash_overpay_credit.sql'));
    expect(migration).toBeDefined();
    if (!migration) return;

    const sql = read(`supabase/migrations/${migration}`);
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.record_invoice_collection_v5');
    expect(sql).toContain("v_change_total > 0");
    expect(sql).toContain('v_later_gross_total');
    expect(sql).toContain("feature_key = 'customer.credit.apply.v1'");
    expect(sql).toContain("mode = 'ON'");
    expect(sql).toMatch(/evaluate_feature_route\(\s*'customer\.credit\.apply\.v1'/);
    expect(sql).toContain('Applied credit exceeds invoice amount after non-credit discounts');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.record_invoice_collection_v5/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_invoice_collection_v5/);
  });
});
