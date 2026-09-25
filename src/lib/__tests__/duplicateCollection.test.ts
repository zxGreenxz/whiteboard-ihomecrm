import { describe, expect, it } from 'vitest';

import {
  collectionClock,
  DUPLICATE_COLLECTION_WINDOW_MS,
  duplicateCollectionQuestion,
  findRecentDuplicateCollection,
  type CollectionForDuplicateCheck,
} from '../duplicateCollection';

// Giờ ĐỊA PHƯƠNG dựng bằng Date(y, m, d, h, mi) ⇒ "HH:mm" không phụ thuộc múi giờ máy chạy test.
const NOW = new Date(2026, 8, 25, 14, 30, 0);
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const thu = (over: Partial<CollectionForDuplicateCheck> & { id: string }): CollectionForDuplicateCheck => ({
  status: 'ACTIVE',
  gross_amount: 3_500_000,
  created_at: at(5),
  collector_name: 'Hiệp',
  ...over,
});

describe('findRecentDuplicateCollection', () => {
  it('bắt lần thu còn hiệu lực, cùng số tiền, trong 30 phút', () => {
    const dup = findRecentDuplicateCollection([thu({ id: 'a' })], 3_500_000, NOW);
    expect(dup?.id).toBe('a');
  });

  it('khác số tiền thì không coi là trùng (so theo đồng, làm tròn)', () => {
    expect(findRecentDuplicateCollection([thu({ id: 'a' })], 3_400_000, NOW)).toBeNull();
    expect(findRecentDuplicateCollection([thu({ id: 'a', gross_amount: 3_500_000.4 })], 3_500_000, NOW)?.id).toBe('a');
  });

  it('bỏ qua lần thu đã hoàn tác', () => {
    expect(findRecentDuplicateCollection([thu({ id: 'a', status: 'REVERSED' })], 3_500_000, NOW)).toBeNull();
  });

  it('ngoài cửa sổ 30 phút thì không hỏi; đúng mốc 30 phút vẫn tính', () => {
    expect(findRecentDuplicateCollection([thu({ id: 'a', created_at: at(31) })], 3_500_000, NOW)).toBeNull();
    expect(findRecentDuplicateCollection([thu({ id: 'a', created_at: at(30) })], 3_500_000, NOW)?.id).toBe('a');
    expect(DUPLICATE_COLLECTION_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('đồng hồ máy người dùng chậm hơn máy chủ: lần thu "ở tương lai" vài phút vẫn là vừa thu', () => {
    expect(findRecentDuplicateCollection([thu({ id: 'a', created_at: at(-3) })], 3_500_000, NOW)?.id).toBe('a');
  });

  it('nhiều lần trùng ⇒ trả lần GẦN NHẤT', () => {
    const dup = findRecentDuplicateCollection(
      [thu({ id: 'cu', created_at: at(20) }), thu({ id: 'moi', created_at: at(2) }), thu({ id: 'giua', created_at: at(9) })],
      3_500_000,
      NOW.getTime(),
    );
    expect(dup?.id).toBe('moi');
  });

  it('số tiền 0 / ngày hỏng không làm vỡ, cũng không báo trùng', () => {
    expect(findRecentDuplicateCollection([thu({ id: 'a', gross_amount: 0 })], 0, NOW)).toBeNull();
    expect(findRecentDuplicateCollection([thu({ id: 'a', created_at: 'không phải ngày' })], 3_500_000, NOW)).toBeNull();
    expect(findRecentDuplicateCollection([], 3_500_000, NOW)).toBeNull();
  });
});

describe('duplicateCollectionQuestion', () => {
  it('nêu số tiền, giờ thu và người thu', () => {
    const created = new Date(2026, 8, 25, 14, 5, 0).toISOString();
    expect(duplicateCollectionQuestion(thu({ id: 'a', created_at: created }))).toBe(
      'Hoá đơn này vừa được thu 3.500.000 đ lúc 14:05 bởi Hiệp. Vẫn thu tiếp?',
    );
  });

  it('không đọc được tên người thu thì vẫn hỏi, không để trống', () => {
    const q = duplicateCollectionQuestion(thu({ id: 'a', collector_name: '  ' }));
    expect(q).toContain('bởi một người khác');
  });

  it('collectionClock: giờ:phút có số 0 đứng đầu; ngày hỏng ⇒ "—"', () => {
    expect(collectionClock(new Date(2026, 8, 25, 7, 3, 0).toISOString())).toBe('07:03');
    expect(collectionClock('???')).toBe('—');
  });
});
