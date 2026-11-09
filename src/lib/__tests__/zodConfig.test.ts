import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../zodConfig';

// Các câu dưới là đúng chữ zod 3.25.76 sinh ra (đo bằng so sánh hai bản khi nâng zod 4).
const firstMessage = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  return result.success ? null : result.error.issues[0].message;
};

describe('cấu hình zod 4 dùng chung (src/lib/zodConfig.ts)', () => {
  it('main.tsx nạp cấu hình trước mọi import khác', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');
    expect(main.startsWith('import "./lib/zodConfig";')).toBe(true);
  });

  it('tắt JIT để không thử new Function dưới CSP không có unsafe-eval', () => {
    expect(z.config().jitless).toBe(true);
    expect(z.object({ a: z.string() }).safeParse({ a: 'x' }).success).toBe(true);
  });

  it('giữ nguyên câu báo mặc định của zod 3', () => {
    expect(firstMessage(z.string(), undefined)).toBe('Required');
    expect(firstMessage(z.string(), null)).toBe('Expected string, received null');
    expect(firstMessage(z.number(), NaN)).toBe('Expected number, received nan');
    expect(firstMessage(z.number().int(), 1.5)).toBe('Expected integer, received float');
    expect(firstMessage(z.string().min(3), 'x')).toBe('String must contain at least 3 character(s)');
    expect(firstMessage(z.string().max(3), 'xxxxx')).toBe('String must contain at most 3 character(s)');
    expect(firstMessage(z.string().length(1), 'xx')).toBe('String must contain exactly 1 character(s)');
    expect(firstMessage(z.number().min(5), 1)).toBe('Number must be greater than or equal to 5');
    expect(firstMessage(z.number().positive(), -1)).toBe('Number must be greater than 0');
    expect(firstMessage(z.number().max(5), 9)).toBe('Number must be less than or equal to 5');
    expect(firstMessage(z.array(z.number()).min(2), [1])).toBe('Array must contain at least 2 element(s)');
    expect(firstMessage(z.array(z.number()).max(1), [1, 2])).toBe('Array must contain at most 1 element(s)');
    expect(firstMessage(z.array(z.string()), 'x')).toBe('Expected array, received string');
    expect(firstMessage(z.object({}), 'x')).toBe('Expected object, received string');
    expect(firstMessage(z.object({}).strict(), { a: 1 })).toBe("Unrecognized key(s) in object: 'a'");
    expect(firstMessage(z.string().email(), 'x')).toBe('Invalid email');
    expect(firstMessage(z.string().guid(), 'x')).toBe('Invalid uuid');
    expect(firstMessage(z.string().url(), 'x')).toBe('Invalid url');
    expect(firstMessage(z.string().regex(/a/), 'x')).toBe('Invalid');
    expect(firstMessage(z.string().datetime(), 'x')).toBe('Invalid datetime');
    expect(firstMessage(z.string().date(), 'x')).toBe('Invalid date');
    expect(firstMessage(z.enum(['A', 'B']), 'C')).toBe("Invalid enum value. Expected 'A' | 'B', received 'C'");
    expect(firstMessage(z.enum(['A', 'B']), undefined)).toBe('Required');
    expect(firstMessage(z.literal('A'), 'C')).toBe('Invalid literal value, expected "A"');
    expect(firstMessage(z.union([z.string(), z.number()]), true)).toBe('Invalid input');
    expect(firstMessage(z.string().refine(() => false), 'x')).toBe('Invalid input');
  });

  it('thông báo riêng của schema luôn được ưu tiên', () => {
    expect(firstMessage(z.string().min(3, 'Quá ngắn'), 'x')).toBe('Quá ngắn');
    expect(firstMessage(z.string({ error: 'Nhập chuỗi' }), 1)).toBe('Nhập chuỗi');
    expect(firstMessage(z.string({ error: (issue) => (issue.input === undefined ? 'Bắt buộc' : undefined) }), undefined)).toBe('Bắt buộc');
    // error trả undefined ⇒ rơi xuống câu báo mặc định kiểu zod 3
    expect(firstMessage(z.string({ error: (issue) => (issue.input === undefined ? 'Bắt buộc' : undefined) }), 1)).toBe('Expected string, received number');
  });
});
