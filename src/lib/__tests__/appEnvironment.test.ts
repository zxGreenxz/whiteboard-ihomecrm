import { describe, expect, it } from 'vitest';
import { docMoiTruong } from '@/lib/appEnvironment';

describe('docMoiTruong', () => {
  it('chỉ đúng giá trị "test" mới là môi trường TEST', () => {
    expect(docMoiTruong('test')).toBe('test');
    expect(docMoiTruong(' TEST ')).toBe('test');
  });

  it('mọi giá trị khác, kể cả thiếu biến, đều là production', () => {
    for (const v of [undefined, null, '', 'production', 'staging', 1, true]) {
      expect(docMoiTruong(v)).toBe('production');
    }
  });
});
