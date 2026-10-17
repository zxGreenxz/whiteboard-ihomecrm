import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import { customerSearchFilter } from '../customerSearch';

const db = new PGlite();
afterAll(() => db.close());

function namePattern(search: string): string {
  const filter = customerSearchFilter(search);
  const quoted = filter.match(/^full_name\.imatch\.("(?:[^"\\]|\\.)*"),/)?.[1];
  if (!quoted) throw new Error(`Missing quoted name pattern: ${filter}`);
  return JSON.parse(quoted) as string;
}

async function matches(name: string, search: string): Promise<boolean> {
  const result = await db.query<{ matches: boolean }>('SELECT $1 ~* $2 AS matches', [name, namePattern(search)]);
  return result.rows[0].matches;
}

describe('customer name search in PostgreSQL', () => {
  it.each(['NGUYEN TRAN NHAT AN', 'nhat an', 'NhẬt An', '  nguyen tran nhat an  '])('finds an accented name with %s', async search => {
    expect(await matches('Nguyễn Trần Nhật An', search)).toBe(true);
  });

  it.each(['DANG THUY DUONG', 'đặng thùy dương'])('handles đ and every Vietnamese vowel with %s', async search => {
    expect(await matches('Đặng Thùy Dương', search)).toBe(true);
  });

  it('handles decomposed Unicode in stored names and search input', async () => {
    expect(await matches('Nguyễn Nhật An'.normalize('NFD'), 'nguyen nhat an')).toBe(true);
    expect(await matches('Nguyễn Nhật An', 'NGUYỄN NHẬT AN'.normalize('NFD'))).toBe(true);
  });

  it('does not match a different consonant or missing word', async () => {
    expect(await matches('Nguyễn Nhật An', 'nguyen nhac an')).toBe(false);
    expect(await matches('Nguyễn An', 'nguyen nhat an')).toBe(false);
  });

  it('preserves literal matching of names in other languages', async () => {
    expect(await matches('François Noël', 'François Noël')).toBe(true);
  });

  it('treats regex and PostgREST punctuation as literal text', async () => {
    const literal = 'An (A+B), "VIP" \\ [1].*';
    expect(await matches(literal, literal)).toBe(true);
    expect(await matches('Any unrelated customer', '.*')).toBe(false);
  });

  it('quotes contact searches and keeps email punctuation literal', () => {
    const filter = customerSearchFilter('an+demo@example.test');
    expect(filter).toContain('email.imatch.' + JSON.stringify('an\\+demo@example\\.test'));
    expect(customerSearchFilter('0912345678')).toContain('phone.imatch."0912345678"');
    expect(customerSearchFilter('AB123456')).toContain('id_number.imatch."AB123456"');
  });
});
