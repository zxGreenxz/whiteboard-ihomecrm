import { expect, it } from 'vitest';
import { congThang, docHanHopDong, hanConHieuLuc, ngayHopLe } from '@/lib/residenceLeaseTerm';

it('cộng tháng giữ đúng cuối tháng ngắn', () => {
  expect(docHanHopDong(['Hôm nay, Ngày 31 Tháng 12 Năm 2026', 'Thời hạn mượn: 2 tháng']))
    .toMatchObject({ to: '28/02/2027' });
  expect(congThang(new Date(Date.UTC(2027, 11, 31)), 2)).toEqual(new Date(Date.UTC(2028, 1, 29)));
});

it('ngayHopLe từ chối ngày không có thật', () => {
  expect(ngayHopLe(29, 2, 2027)).toBeNull();
  expect(ngayHopLe(29, 2, 2028)).not.toBeNull();
  expect(ngayHopLe(0, 1, 2026)).toBeNull();
});

it('hanConHieuLuc so với hôm nay theo giờ Việt Nam', () => {
  const han = { from: '14/09/2026', to: '14/09/2028', nguon: 'cap-ngay' } as const;
  expect(hanConHieuLuc(han, new Date('2026-09-16T00:00:00Z'))).toBe(true);
  expect(hanConHieuLuc(han, new Date('2028-09-20T00:00:00Z'))).toBe(false);
  // Chỉ dùng hạn còn ở tương lai: từ 00:00 ngày 14/09 giờ VN, hạn bằng hôm nay.
  expect(hanConHieuLuc(han, new Date('2028-09-13T16:59:59Z'))).toBe(true);
  expect(hanConHieuLuc(han, new Date('2028-09-13T17:00:00Z'))).toBe(false);
});
