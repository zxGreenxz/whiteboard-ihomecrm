/** Credit RPC must return a real number; null cannot mean an authoritative zero. */
export function readContractCreditBalance(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    throw new Error('Không xác nhận được số dư tiền thừa của khách');
  }
  const amount = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(amount)) throw new Error('Không xác nhận được số dư tiền thừa của khách');
  return amount;
}
