import { describe, expect, it } from 'vitest';
import { publicFailure, PublicRequestError, parseLuckyState, checkinCodeError } from '@/lib/publicFeedback';
describe('public page feedback', () => {
  it('does not claim a server or malformed response is a network failure', () => {
    expect(publicFailure(new PublicRequestError(500), 'tải hóa đơn')).toMatch(/máy chủ/i);
    expect(publicFailure(new PublicRequestError(429), 'tải hóa đơn')).toContain('quá nhiều');
    expect(publicFailure(new Error('SQL secret'), 'tải hóa đơn')).not.toContain('SQL');
  });
  it('requires a confirmed valid public response before success', () => {
    expect(() => parseLuckyState({})).toThrow();
    expect(() => parseLuckyState({ ok: true })).toThrow();
    expect(parseLuckyState({ ok: false, reason: 'bad_code' })).toMatchObject({ ok: false });
  });
  it('documents and accepts exactly six through eight digits', () => {
    expect(checkinCodeError('12345')).toContain('6–8');
    expect(checkinCodeError('123456')).toBeNull();
    expect(checkinCodeError('12345678')).toBeNull();
    expect(checkinCodeError('123456789')).toContain('6–8');
  });
});
