import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { buildingLegalOwnerSchema, emptyBuildingLegalOwner } from '../buildingLegalOwner';

describe('legal title owner validation', () => {
  it('permits an incomplete owner without manufacturing identity', () => {
    expect(buildingLegalOwnerSchema.parse(emptyBuildingLegalOwner)).toEqual({ full_name: '', birth_year: null, id_number: '', id_issue_date: null, id_issue_place: '', permanent_address: '' });
  });
  it('preserves initial zeros and trims names', () => {
    expect(buildingLegalOwnerSchema.parse({ ...emptyBuildingLegalOwner, full_name: ' Nguyễn An ', id_number: '001234567890' })).toMatchObject({ full_name: 'Nguyễn An', id_number: '001234567890' });
  });
  it('rejects impossible dates, fractional years and oversized identity values', () => {
    for (const input of [{ id_issue_date: '2025-02-30' }, { birth_year: 1980.5 }, { birth_year: 99 }, { id_number: '1'.repeat(51) }]) {
      expect(buildingLegalOwnerSchema.safeParse({ ...emptyBuildingLegalOwner, ...input }).success).toBe(false);
    }
  });
});
