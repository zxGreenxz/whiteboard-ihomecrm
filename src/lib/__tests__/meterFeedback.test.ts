import { describe, expect, it } from 'vitest';
import { isDuplicateMeterCode } from '../meterFeedback';

describe('isDuplicateMeterCode', () => {
  it('requires the known meter code constraint', () => {
    expect(isDuplicateMeterCode({ code: '23505', message: 'duplicate key value violates unique constraint "meters_user_id_code_key"' })).toBe(true);
    expect(isDuplicateMeterCode({ code: '23505', message: 'duplicate key value violates unique constraint "other_key"' })).toBe(false);
    expect(isDuplicateMeterCode({ code: '23505' })).toBe(false);
  });
});
