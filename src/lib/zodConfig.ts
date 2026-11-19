/**
 * Cấu hình toàn cục của zod 4 — PHẢI nạp trước mọi schema (dòng import đầu của main.tsx).
 *
 * File này cố ý KHÔNG import 'zod': zod nằm ở chunk lazy (vendor-forms), import tĩnh từ
 * entry sẽ kéo cả gói vào lần tải đầu. zod 4 đọc cấu hình từ một object toàn cục
 * (`globalThis.__zod_globalConfig`, xem zod/v4/core/core.js), nên ghi thẳng vào đó là đủ.
 * Test `src/lib/__tests__/zodConfig.test.ts` nhắc lại đúng hai điều dưới bằng zod thật
 * để bản nâng zod sau làm hỏng phép ghi này thì đỏ ngay.
 *
 * 1. `jitless`: CSP của app là `script-src 'self'` (không 'unsafe-eval'). Không đặt cờ này,
 *    zod 4 thử `new Function('')` ở lần dựng `z.object()` đầu tiên ⇒ trình duyệt ghi một vi
 *    phạm CSP dù zod nuốt lỗi.
 * 2. `customError`: giữ NGUYÊN câu báo mặc định của zod 3 cho những ô KHÔNG khai thông báo
 *    riêng (zod 4 đổi chữ, ví dụ "Required" ⇒ "Invalid input: expected string, received
 *    undefined"). Thông báo riêng của schema luôn được ưu tiên hơn customError.
 */

type RawIssue = {
  code?: string;
  input?: unknown;
  expected?: string;
  format?: string;
  origin?: string;
  minimum?: number | bigint | Date;
  maximum?: number | bigint | Date;
  inclusive?: boolean;
  exact?: boolean;
  values?: readonly unknown[];
  keys?: readonly string[];
  divisor?: number | bigint;
  prefix?: string;
  suffix?: string;
  includes?: string;
  inst?: { _zod?: { def?: { type?: string } } };
};

function loaiDuLieu(data: unknown): string {
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  if (typeof data === 'number') return Number.isNaN(data) ? 'nan' : 'number';
  if (typeof data === 'object') {
    if (data instanceof Date) return 'date';
    if (data instanceof Map) return 'map';
    if (data instanceof Set) return 'set';
    if (typeof (data as Promise<unknown>).then === 'function') return 'promise';
    return 'object';
  }
  return typeof data;
}

const noiGiaTri = (values: readonly unknown[], separator: string) =>
  values.map((value) => (typeof value === 'string' ? `'${value}'` : String(value))).join(separator);

function chuZod3(issue: RawIssue): string | undefined {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined) return 'Required';
      if (issue.input === Infinity || issue.input === -Infinity) return 'Number must be finite';
      if (issue.expected === 'int') return 'Expected integer, received float';
      return `Expected ${issue.expected === 'record' ? 'object' : issue.expected}, received ${loaiDuLieu(issue.input)}`;
    }
    case 'invalid_value': {
      const values = issue.values ?? [];
      if (issue.inst?._zod?.def?.type === 'literal') {
        return `Invalid literal value, expected ${JSON.stringify(values.length === 1 ? values[0] : values)}`;
      }
      if (issue.input === undefined) return 'Required';
      const danhSach = noiGiaTri(values, ' | ');
      return typeof issue.input === 'string'
        ? `Invalid enum value. Expected ${danhSach}, received '${issue.input}'`
        : `Expected ${danhSach}, received ${loaiDuLieu(issue.input)}`;
    }
    case 'invalid_format':
      switch (issue.format) {
        case 'regex': return 'Invalid';
        case 'starts_with': return `Invalid input: must start with "${issue.prefix}"`;
        case 'ends_with': return `Invalid input: must end with "${issue.suffix}"`;
        case 'includes': return `Invalid input: must include "${issue.includes}"`;
        case 'guid': return 'Invalid uuid';
        default: return `Invalid ${issue.format}`;
      }
    case 'too_small': {
      const { origin, exact, inclusive, minimum } = issue;
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${minimum} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${minimum} character(s)`;
      if (origin === 'number' || origin === 'int') return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${minimum}`;
      if (origin === 'bigint') return `BigInt must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${minimum}`;
      if (origin === 'date') return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(minimum))}`;
      return undefined;
    }
    case 'too_big': {
      const { origin, exact, inclusive, maximum } = issue;
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${maximum} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${maximum} character(s)`;
      if (origin === 'number' || origin === 'int') return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
      if (origin === 'bigint') return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
      if (origin === 'date') return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(maximum))}`;
      return undefined;
    }
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${noiGiaTri(issue.keys ?? [], ', ')}`;
    default:
      return undefined; // invalid_union, custom, invalid_key, invalid_element: chữ zod 4 trùng zod 3
  }
}

const cauHinhToanCuc = globalThis as typeof globalThis & { __zod_globalConfig?: Record<string, unknown> };
cauHinhToanCuc.__zod_globalConfig = Object.assign(cauHinhToanCuc.__zod_globalConfig ?? {}, {
  jitless: true,
  customError: chuZod3,
});

export {};
