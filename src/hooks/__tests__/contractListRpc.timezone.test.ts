import { expect, it, vi } from 'vitest';
import { contractDayRefetchMs, msToNextVnMidnight } from '../useContracts';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

it('đọc lại đúng lúc qua 00:00 giờ VN (+5 s) để nhãn/ô không giữ ngày cũ', () => {
  expect(msToNextVnMidnight(Date.parse('2026-10-17T16:59:00Z'))).toBe(60_000 + 5_000); // 23:59 giờ VN
  expect(msToNextVnMidnight(Date.parse('2026-10-17T17:00:00Z'))).toBe(86_400_000 + 5_000); // đúng 00:00 giờ VN
  expect(msToNextVnMidnight(Date.parse('2026-10-17T05:00:00Z'))).toBe(12 * 3_600_000 + 5_000); // 12:00 giờ VN
});

it('đọc lại theo ngày SQL: ngày cũ hơn hôm nay giờ VN ⇒ 60 s (+jitter); còn lại ⇒ qua 00:00 giờ VN (+jitter)', () => {
  const noon = Date.parse('2026-10-17T05:00:00Z'); // 12:00 giờ VN ngày 17/10
  expect(contractDayRefetchMs('2026-10-16', noon, () => 0)).toBe(60_000);
  expect(contractDayRefetchMs('2026-10-16', noon, () => 0.999)).toBe(60_000 + 29_970);
  expect(contractDayRefetchMs('2026-10-17', noon, () => 0)).toBe(msToNextVnMidnight(noon));
  expect(contractDayRefetchMs(undefined, noon, () => 0.5)).toBe(msToNextVnMidnight(noon) + 15_000);
  // 00:30 giờ VN ngày 18/10 mà SQL còn trả 17/10 (đồng hồ lệch) ⇒ đọc lại sớm.
  expect(contractDayRefetchMs('2026-10-17', Date.parse('2026-10-17T17:30:00Z'), () => 0)).toBe(60_000);
});
