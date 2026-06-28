import { describe, it, expect } from 'vitest';
import { distanceMeters, parseLatLngFromMapsUrl, isValidLatLng } from '../geo';

describe('distanceMeters', () => {
  it('cùng một điểm → 0m', () => {
    expect(distanceMeters(10.806, 106.665, 10.806, 106.665)).toBe(0);
  });

  it('đối xứng (A→B == B→A)', () => {
    const ab = distanceMeters(10.8, 106.6, 10.81, 106.61);
    const ba = distanceMeters(10.81, 106.61, 10.8, 106.6);
    expect(Math.abs(ab - ba)).toBeLessThan(1e-6);
  });

  it('~111.2m cho 0.001° vĩ độ tại xích đạo (±2m)', () => {
    const d = distanceMeters(0, 0, 0.001, 0);
    expect(d).toBeGreaterThan(109);
    expect(d).toBeLessThan(113);
  });

  it('phân biệt trong/ngoài bán kính 70m', () => {
    // ~0.0003° vĩ độ ≈ 33m → trong phạm vi
    expect(distanceMeters(10.8, 106.6, 10.8003, 106.6)).toBeLessThan(70);
    // ~0.001° vĩ độ ≈ 111m → ngoài phạm vi
    expect(distanceMeters(10.8, 106.6, 10.801, 106.6)).toBeGreaterThan(70);
  });
});

describe('parseLatLngFromMapsUrl', () => {
  it('dạng @lat,lng (view center)', () => {
    expect(parseLatLngFromMapsUrl('https://www.google.com/maps/@10.806,106.665,17z')).toEqual({
      lat: 10.806,
      lng: 106.665,
    });
  });

  it('dạng ?q=lat,lng', () => {
    expect(parseLatLngFromMapsUrl('https://maps.google.com/?q=10.806,106.665')).toEqual({
      lat: 10.806,
      lng: 106.665,
    });
  });

  it('ưu tiên !3d!4d (toạ độ chính xác) hơn @ (view center)', () => {
    const url =
      'https://www.google.com/maps/place/X/@10.5,106.5,17z/data=!3d10.806!4d106.665';
    expect(parseLatLngFromMapsUrl(url)).toEqual({ lat: 10.806, lng: 106.665 });
  });

  it('nhập tay "lat, lng"', () => {
    expect(parseLatLngFromMapsUrl('10.806, 106.665')).toEqual({ lat: 10.806, lng: 106.665 });
  });

  it('toạ độ không hợp lệ → null', () => {
    expect(parseLatLngFromMapsUrl('https://maps.google.com/?q=200,500')).toBeNull();
    expect(parseLatLngFromMapsUrl('không có toạ độ ở đây')).toBeNull();
    expect(parseLatLngFromMapsUrl('')).toBeNull();
  });
});

describe('isValidLatLng', () => {
  it('loại 0,0 và ngoài miền', () => {
    expect(isValidLatLng(0, 0)).toBe(false);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(10.8, 106.6)).toBe(true);
    expect(isValidLatLng(null, 106.6)).toBe(false);
  });
});
