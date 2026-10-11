import { describe, expect, it } from 'vitest';
import { commissionInterventionsSchema, hasCommissionBasisChange, hasCommissionTierChange, isCommissionReasonValid } from '../commissionAudit';

describe('commission audit input boundaries', () => {
  it('requires a written reason within the persisted size limit', () => {
    for (const reason of ['', '       ', 'ngắn', 'a'.repeat(2001)]) expect(isCommissionReasonValid(reason)).toBe(false);
    expect(isCommissionReasonValid('  Điều chỉnh theo thỏa thuận mới  ')).toBe(true);
  });
  it('detects every commission basis while normalizing date representation', () => {
    const basis = {room_id:'room-a',rent_price:5000000,start_date:'2026-01-01',end_date:'2027-01-01'};
    expect(hasCommissionBasisChange(basis,{...basis,start_date:'2026-01-01T00:00:00Z'})).toBe(false);
    for (const patch of [{room_id:'room-b'},{rent_price:5500000},{start_date:'2026-01-02'},{end_date:'2027-01-02'}]) {
      expect(hasCommissionBasisChange(basis,{...basis,...patch})).toBe(true);
    }
  });
  it('does not require a reason for object-key ordering but preserves tier priority', () => {
    const a={min_months:6,max_months:12,rate_percent:50}, b={min_months:10,max_months:12,rate_percent:60};
    expect(hasCommissionTierChange([a],[{rate_percent:50,max_months:12,min_months:6}])).toBe(false);
    expect(hasCommissionTierChange([a,b],[b,a])).toBe(true);
    expect(hasCommissionTierChange([a],[{...a,rate_percent:60}])).toBe(true);
  });
  it('does not turn malformed or missing history into a confirmed empty history', () => {
    expect(()=>commissionInterventionsSchema.parse(null)).toThrow();
    expect(()=>commissionInterventionsSchema.parse([{stage:'CREATE'}])).toThrow();
    expect(commissionInterventionsSchema.parse([])).toEqual([]);
  });
});
