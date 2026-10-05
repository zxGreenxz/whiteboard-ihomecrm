/** Historical money uses Number at the API boundary, but arithmetic uses its exact decimal spelling. */
export class MoneyRangeError extends Error {
  constructor() {
    super('Số tiền tổng hợp vượt khả năng biểu diễn chính xác. Chưa thể hiển thị tổng tiền; vui lòng liên hệ hỗ trợ hoặc tải lại sau khi dữ liệu được kiểm tra.');
    this.name = 'MoneyRangeError';
  }
}

type Decimal = { units: bigint; scale: number };
function decimal(value: number): Decimal {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new MoneyRangeError();
  const [mantissa = '0', exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const units = BigInt(whole + fraction);
  return scale < 0 ? { units: units * 10n ** BigInt(-scale), scale: 0 } : { units, scale };
}

/** Accumulate before converting once, so cancellation and long histories do not lose small amounts. */
export function sumMoney(values: readonly number[]): number {
  const parts = values.map(decimal);
  const scale = parts.reduce((max, part) => Math.max(max, part.scale), 0);
  const units = parts.reduce((sum, part) => sum + part.units * 10n ** BigInt(scale - part.scale), 0n);
  const limit = BigInt(Number.MAX_SAFE_INTEGER) * 10n ** BigInt(scale);
  if (units > limit || units < -limit) throw new MoneyRangeError();
  const result = Number(`${units}e-${scale}`);
  const roundTrip = decimal(result);
  // Safe integer range alone does not protect fractional digits beside a large integer.
  if (roundTrip.units * 10n ** BigInt(scale) !== units * 10n ** BigInt(roundTrip.scale)) throw new MoneyRangeError();
  return result;
}

export const subtractMoney = (left: number, right: number): number => sumMoney([left, -right]);
