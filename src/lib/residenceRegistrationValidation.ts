export class RegistrationError extends Error {}

/** Mã hồ sơ cổng cấp: G01.899.909-260916-890012. Chặn rác trước khi ghi vào sổ. */
export function maHoSoHopLe(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Z0-9][A-Z0-9.\-/]{4,60}$/i.test(raw.trim());
}
