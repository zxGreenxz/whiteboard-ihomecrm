import { describe, expect, it } from 'vitest';
import { docMoiTruong, troProduction } from '@/lib/appEnvironment';

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

describe('troProduction', () => {
  it('URL database production ⇒ production', () => {
    expect(troProduction('https://tryymsxyyckgbrmmvozx.supabase.co')).toBe(true);
  });

  it('URL project TEST ⇒ không phải production', () => {
    expect(troProduction('https://hzulujxgonszuleqticb.supabase.co')).toBe(false);
  });

  it('thiếu URL thì coi là production — không bao giờ gắn nhãn TEST khi không chắc', () => {
    for (const v of [undefined, null, '', '  ', 42]) expect(troProduction(v)).toBe(true);
  });
});
