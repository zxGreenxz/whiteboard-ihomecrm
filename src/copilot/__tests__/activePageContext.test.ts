import { describe, expect, it } from 'vitest';
import { dongNguCanhTrang } from '../banDoHeThong';

const perms = { invoices: { view: true }, customers: { view: true } };
const id = '11111111-1111-4111-8111-111111111111';

describe('current page prompt', () => {
  it('identifies the UUID param on a contracted detail route without guessing entity data', () => {
    const prompt = dongNguCanhTrang(`/invoices/${id}`, perms);
    expect(prompt).toContain(`id=${id}`);
    expect(prompt).toContain('invoices.detail');
  });

  it('does not include a detail identity on deferred forms, malformed IDs or prefix siblings', () => {
    expect(dongNguCanhTrang(`/customers/${id}/edit`, perms)).not.toContain(`id=${id}`);
    expect(dongNguCanhTrang('/invoices-unrelated', perms)).toBeNull();
    expect(dongNguCanhTrang('/invoices/token-secret', perms)).not.toContain('token-secret');
    expect(dongNguCanhTrang(`/invoices/${id}`, {})).toBeNull();
  });

  it('preserves authorized generic context on pages without a Copilot route contract', () => {
    expect(dongNguCanhTrang('/', { __superadmin: true } as never)).toContain('NGỮ CẢNH');
    expect(dongNguCanhTrang('/finance/salary', { __superadmin: true } as never)).toContain('NGỮ CẢNH');
  });

  it('uses mounted effective filters including cleared URL seeds', () => {
    const prompt = dongNguCanhTrang('/invoices', perms, {
      search: '?status=PAID&month=2026-08',
      activeContext: { filters: ['payment_status=unpaid', 'billing_month=2026-09'], incompleteFilters: false },
    });
    expect(prompt).toContain('payment_status=unpaid');
    expect(prompt).toContain('billing_month=2026-09');
    expect(prompt).not.toContain('status=PAID');
    expect(prompt).not.toContain('2026-08');
    expect(dongNguCanhTrang('/invoices', perms, {
      search: '?status=PAID', activeContext: { filters: [], incompleteFilters: false },
    })).not.toContain('status=PAID');
  });

  it('labels an open modal identity separately and warns when private filters were omitted', () => {
    const prompt = dongNguCanhTrang('/invoices', perms, {
      activeContext: { filters: [], incompleteFilters: true, entityId: id },
    });
    expect(prompt).toContain(`id=${id}`);
    expect(prompt).toContain('chưa đầy đủ');
  });
});
