import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  POINTER_ANGLE,
  easeOutQuint,
  formatCountdown,
  indexAtPointer,
  normalizeAngle,
  targetRotation,
} from '../luckyWheel';

describe('luckyWheel — kim phải chỉ đúng đội server đã chốt', () => {
  it('property: mọi (count, winIdx, jitter, turns) đều dừng đúng ô', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 40 }),
        fc.double({ min: 0, max: 0.9999, noNaN: true }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 39 }),
        (count, jitter01, turns, winSeed) => {
          const winIdx = winSeed % count;
          const rot = targetRotation(winIdx, count, jitter01, turns);
          expect(indexAtPointer(rot, count)).toBe(winIdx);
          // normalize không được đổi kết quả (client lưu rot đã chuẩn hoá)
          expect(indexAtPointer(normalizeAngle(rot), count)).toBe(winIdx);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('12 đội — quét toàn bộ ô ở cả hai biên jitter', () => {
    const n = 12;
    for (let winIdx = 0; winIdx < n; winIdx++) {
      for (const j of [0, 0.0001, 0.25, 0.5, 0.75, 0.9999]) {
        for (const turns of [1, 6, 7, 8, 12]) {
          expect(indexAtPointer(targetRotation(winIdx, n, j, turns), n)).toBe(winIdx);
        }
      }
    }
  });

  it('jitter bị kẹp trong ±0.35 ô nên không bao giờ tràn sang ô kề', () => {
    const n = 8;
    const seg = (Math.PI * 2) / n;
    for (const j of [-5, 0, 1, 99]) {
      const rot = targetRotation(3, n, j, 6);
      const local = normalizeAngle(POINTER_ANGLE - rot);
      const offsetFromCenter = local - (3 * seg + seg / 2);
      expect(Math.abs(offsetFromCenter)).toBeLessThanOrEqual(0.35 * seg + 1e-9);
    }
  });

  it('indexAtPointer trả -1 khi chưa có đội nào', () => {
    expect(indexAtPointer(0, 0)).toBe(-1);
  });

  it('rot ban đầu (kim ở 12 giờ) trỏ ô 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (count) => {
        expect(indexAtPointer(POINTER_ANGLE, count)).toBe(0);
      }),
    );
  });
});

describe('normalizeAngle', () => {
  it('luôn trả về [0, 2PI)', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (a) => {
        const v = normalizeAngle(a);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(Math.PI * 2);
      }),
    );
  });
});

describe('easeOutQuint', () => {
  it('đi từ 0 tới 1, đơn điệu tăng, kẹp ngoài biên', () => {
    expect(easeOutQuint(0)).toBe(0);
    expect(easeOutQuint(1)).toBe(1);
    expect(easeOutQuint(-3)).toBe(0);
    expect(easeOutQuint(9)).toBe(1);
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const v = easeOutQuint(p);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('formatCountdown', () => {
  it('định dạng hh:mm:ss và có ngày khi > 24h', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(-5000)).toBe('00:00:00');
    expect(formatCountdown(59_000)).toBe('00:00:59');
    expect(formatCountdown(60_000)).toBe('00:01:00');
    expect(formatCountdown(3_661_000)).toBe('01:01:01');
    expect(formatCountdown(90_061_000)).toBe('1 ngày 01:01:01');
  });

  it('không bao giờ ra chuỗi có NaN', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), (ms) => {
        expect(formatCountdown(ms)).not.toMatch(/NaN/);
      }),
    );
  });
});
