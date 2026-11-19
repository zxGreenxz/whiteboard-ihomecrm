import { describe, expect, it } from 'vitest';
import { MAX_CAPTURE_BYTES, singleCaptureQr, validateCaptureMedia } from './media';

describe('meter media admission', () => {
  it('accepts a 60 second 100 MB clip and camera codec suffix', () => {
    expect(() => validateCaptureMedia({ size: MAX_CAPTURE_BYTES, type: 'video/webm;codecs=vp9' }, 60)).not.toThrow();
  });
  it.each([0, NaN, Infinity, 60.1, -1])('rejects invalid duration %s', seconds => {
    expect(() => validateCaptureMedia({ size: 1000, type: 'video/mp4' }, seconds)).toThrow();
  });
  it.each([{ size: 0, type: 'image/jpeg' }, { size: MAX_CAPTURE_BYTES + 1, type: 'video/mp4' }, { size: 1000, type: 'text/html' }])('rejects an unsupported or unsafe original %j', file => {
    expect(() => validateCaptureMedia(file)).toThrow();
  });
  it('will not pick one identity from multiple QR codes', () => {
    expect(singleCaptureQr([])).toBeNull();
    expect(singleCaptureQr(['same', 'same'])).toBe('same');
    expect(() => singleCaptureQr(['meter-a', 'meter-b'])).toThrow('nhiều mã QR');
  });
});
