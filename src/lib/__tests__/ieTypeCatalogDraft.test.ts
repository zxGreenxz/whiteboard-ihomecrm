import { describe, expect, it } from 'vitest';
import {
  catalogFormDefaults,
  catalogUpdatesFromForm,
  mergeTargetCandidates,
  mergedSourceCount,
  parseKeywordsText,
  parseSortOrderText,
} from '../ieTypeCatalogDraft';
import { incomeExpenseTypeFormSchema } from '../incomeExpenseValidation';
import type { IeTypeCatalogFields } from '../ieTypeCatalog';

const NOW = '2026-10-03T08:00:00.000Z';

describe('ô danh mục trong form hạng mục', () => {
  it('tách cụm từ theo dấu phẩy, bỏ rỗng và trùng', () => {
    expect(parseKeywordsText(' bơm gas, ,xả  giàn,Bơm Gas,\nthợ điện lạnh ')).toEqual(['bơm gas', 'xả giàn', 'thợ điện lạnh']);
    expect(parseKeywordsText('')).toEqual([]);
    expect(parseSortOrderText('')).toBeNull();
    expect(parseSortOrderText(' 12 ')).toBe(12);
    expect(parseSortOrderText('1.5')).toBeNaN();
  });

  it('tạo mới: chỉ gửi ô đã điền', () => {
    expect(catalogUpdatesFromForm(catalogFormDefaults(null), null, NOW)).toEqual({});
    expect(
      catalogUpdatesFromForm({ keywords_text: 'a, b', sort_order_text: '3', quick_entry_hidden: true, archived: true }, null, NOW),
    ).toEqual({ keywords: ['a', 'b'], sort_order: 3, quick_entry_hidden: true });
  });

  it('sửa: không đổi gì ⇒ không gửi cột danh mục (môi trường chưa áp migration vẫn lưu được)', () => {
    // Hàng của môi trường chưa áp migration: không có cột danh mục nào.
    const legacy: IeTypeCatalogFields = { id: 't1', name: 'Tiền rác' };
    expect(catalogUpdatesFromForm(catalogFormDefaults(legacy), legacy, NOW)).toEqual({});
    const curated = { keywords: ['bơm gas'], sort_order: 5, quick_entry_hidden: true, archived_at: null, merged_into_id: 'dl' };
    expect(catalogUpdatesFromForm(catalogFormDefaults(curated), curated, NOW)).toEqual({});
  });

  it('sửa: chỉ gửi ô đã đổi; lưu trữ đặt mốc, khôi phục trả null', () => {
    const original = { keywords: ['a'], sort_order: 1, quick_entry_hidden: false, archived_at: null, merged_into_id: null };
    const values = { ...catalogFormDefaults(original), archived: true, merged_into_id: 'target' };
    expect(catalogUpdatesFromForm(values, original, NOW)).toEqual({ archived_at: NOW, merged_into_id: 'target' });
    const archived = { ...original, archived_at: '2026-01-01T00:00:00Z', merged_into_id: 'target' };
    expect(catalogUpdatesFromForm({ ...catalogFormDefaults(archived), archived: false }, archived, NOW)).toEqual({ archived_at: null });
    expect(catalogUpdatesFromForm({ ...catalogFormDefaults(original), keywords_text: '', sort_order_text: '' }, original, NOW))
      .toEqual({ keywords: [], sort_order: null });
  });

  it('đích gộp: cùng chiều, đang dùng, chưa tự gộp, khác mục đang sửa', () => {
    const rows = [
      { id: 'self', type: 'expense' },
      { id: 'ok', type: 'expense' },
      { id: 'income', type: 'income' },
      { id: 'archived', type: 'expense', archived_at: '2026-10-03' },
      { id: 'merged', type: 'expense', merged_into_id: 'ok' },
    ];
    expect(mergeTargetCandidates(rows, { id: 'self', type: 'expense' }).map((t) => t.id)).toEqual(['ok']);
    expect(mergedSourceCount(rows, 'ok')).toBe(1);
    expect(mergedSourceCount(rows, 'self')).toBe(0);
  });

  it('schema form chặn thứ tự không phải số nguyên', () => {
    const base = { name: 'X', type: 'expense', category: 'Nhóm' };
    expect(incomeExpenseTypeFormSchema.safeParse({ ...base, sort_order_text: 'abc' }).success).toBe(false);
    expect(incomeExpenseTypeFormSchema.safeParse({ ...base, sort_order_text: '10' }).success).toBe(true);
    expect(incomeExpenseTypeFormSchema.safeParse(base).success).toBe(true);
  });
});
