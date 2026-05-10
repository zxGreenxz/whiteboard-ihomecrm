import { describe, it, expect } from 'vitest';
import { sanitizeStorageFileName } from '../storageKey';

describe('sanitizeStorageFileName', () => {
  it('keeps already-safe names unchanged', () => {
    expect(sanitizeStorageFileName('photo.png')).toBe('photo.png');
    expect(sanitizeStorageFileName('a-b_c.123.jpg')).toBe('a-b_c.123.jpg');
  });

  it('replaces spaces and special chars with underscore', () => {
    expect(sanitizeStorageFileName('hello world.png')).toBe('hello_world.png');
    expect(sanitizeStorageFileName('a, b (c).jpg')).toBe('a_b_c.jpg');
  });

  it('strips Vietnamese accents', () => {
    expect(sanitizeStorageFileName('ảnh đồng hồ điện.jpg')).toBe('anh_dong_ho_dien.jpg');
    expect(sanitizeStorageFileName('Phòng 101.png')).toBe('Phong_101.png');
  });

  it('handles the real-world DALL-E case from the bug report', () => {
    const input = 'DALL-E 2024-06-18 08.31.31 - A modern and successful Vietnamese businessman, Minh, planting clean vegetables in a well-organized small garden behind his house under the bright mor.webp';
    const out = sanitizeStorageFileName(input);
    expect(out).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(out.endsWith('.webp')).toBe(true);
    // base portion (before extension) capped at 100 chars
    expect(out.length - '.webp'.length).toBeLessThanOrEqual(100);
  });

  it('collapses runs of underscores produced by replacement', () => {
    expect(sanitizeStorageFileName('a   b   c.png')).toBe('a_b_c.png');
  });

  it('trims leading/trailing separators on the base name', () => {
    expect(sanitizeStorageFileName('___leading.png')).toBe('leading.png');
    expect(sanitizeStorageFileName('  spaced  .png')).toBe('spaced.png');
  });

  it('falls back to "file" when base becomes empty', () => {
    expect(sanitizeStorageFileName('???.png')).toBe('file.png');
    expect(sanitizeStorageFileName('')).toBe('file');
  });

  it('keeps extension only after the LAST dot', () => {
    expect(sanitizeStorageFileName('a.b.c.png')).toBe('a.b.c.png');
    expect(sanitizeStorageFileName('weird name.tar.gz')).toBe('weird_name.tar.gz');
  });

  it('output always matches the Supabase Storage allowed key character set', () => {
    const tricky = [
      'a/b\\c:d*e?f"g<h>i|j.png',
      'foo bar.jpg',
      '😀 emoji file.heic',
      '   .png',
    ];
    for (const name of tricky) {
      expect(sanitizeStorageFileName(name)).toMatch(/^[a-zA-Z0-9._-]+$/);
    }
  });
});
