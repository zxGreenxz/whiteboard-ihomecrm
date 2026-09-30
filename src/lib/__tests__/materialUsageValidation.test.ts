import { describe, expect, it } from 'vitest';
import { validateMaterialUsageRows } from '../materialUsageValidation';

describe('material usage rows', () => {
  it('does not discard an unfinished row beside a complete row', () => {
    expect(validateMaterialUsageRows([
      { material_id: 'material-a', quantity: '2' },
      { material_id: 'material-b', quantity: '' },
    ], { optional: true })).toEqual({ 'materials.1.quantity': 'Nhập số lượng vật tư lớn hơn 0.' });
  });
  it('allows an untouched optional section but requires a standalone usage row', () => {
    const blank = [{ material_id: null, quantity: '' }];
    expect(validateMaterialUsageRows(blank, { optional: true })).toEqual({});
    expect(validateMaterialUsageRows(blank)).toHaveProperty('materials.0.material_id');
  });
  it('rejects missing material and non-finite quantity on the exact row', () => {
    expect(validateMaterialUsageRows([{ material_id: null, quantity: 'Infinity' }])).toEqual({
      'materials.0.material_id': 'Chọn vật tư.',
      'materials.0.quantity': 'Nhập số lượng vật tư lớn hơn 0.',
    });
  });
  it('accepts complete positive rows', () => {
    expect(validateMaterialUsageRows([{ material_id: 'material-a', quantity: '1.5' }])).toEqual({});
  });
});
