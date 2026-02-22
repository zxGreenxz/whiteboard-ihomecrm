/**
 * Code Generation Utility
 *
 * Generates formatted codes for 4 document types:
 * - Đặt cọc (DEPOSIT): DC-YYYYMMDD-001
 * - Hợp đồng (CONTRACT): HD-YYYYMM-0001
 * - Hóa đơn (INVOICE): INV-YYYY-00001
 * - Biên bản bàn giao (HANDOVER): BBBG-001
 *
 * Supports configurable prefix, separator, date format, padding, and reset period.
 */

// --- Type Definitions ---

export type CodeType = 'DEPOSIT' | 'CONTRACT' | 'INVOICE' | 'HANDOVER';

export type ResetPeriod = 'daily' | 'monthly' | 'yearly' | 'never';

export type DateFormat = 'YYYYMMDD' | 'YYYYMM' | 'YYYY' | 'none';

export interface CodeConfig {
  /** Prefix for the code (e.g. "DC", "HD", "INV", "BBBG") */
  prefix: string;
  /** Separator between parts (default: "-") */
  separator: string;
  /** Date format included in the code */
  dateFormat: DateFormat;
  /** Number of digits for the counter (e.g. 3 → "001") */
  padding: number;
  /** When to reset the counter */
  resetPeriod: ResetPeriod;
}

// --- Default Configurations ---

const DEFAULT_CONFIGS: Record<CodeType, CodeConfig> = {
  DEPOSIT: {
    prefix: 'DC',
    separator: '-',
    dateFormat: 'YYYYMMDD',
    padding: 3,
    resetPeriod: 'daily',
  },
  CONTRACT: {
    prefix: 'HD',
    separator: '-',
    dateFormat: 'YYYYMM',
    padding: 4,
    resetPeriod: 'monthly',
  },
  INVOICE: {
    prefix: 'INV',
    separator: '-',
    dateFormat: 'YYYY',
    padding: 5,
    resetPeriod: 'yearly',
  },
  HANDOVER: {
    prefix: 'BBBG',
    separator: '-',
    dateFormat: 'none',
    padding: 3,
    resetPeriod: 'never',
  },
};

/**
 * Get the default configuration for a code type.
 */
export function getDefaultConfig(type: CodeType): CodeConfig {
  return { ...DEFAULT_CONFIGS[type] };
}

/**
 * Format a date according to the specified date format.
 */
export function formatDatePart(date: Date, format: DateFormat): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  switch (format) {
    case 'YYYYMMDD':
      return `${year}${month}${day}`;
    case 'YYYYMM':
      return `${year}${month}`;
    case 'YYYY':
      return year;
    case 'none':
      return '';
  }
}

/**
 * Compute the reset key suffix for a given reset period and date.
 * This determines when the counter resets to 1.
 */
export function getResetKey(date: Date, resetPeriod: ResetPeriod): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  switch (resetPeriod) {
    case 'daily':
      return `${year}${month}${day}`;
    case 'monthly':
      return `${year}${month}`;
    case 'yearly':
      return year;
    case 'never':
      return '';
  }
}

/**
 * Generate a formatted code string.
 *
 * @param type - The document type (DEPOSIT, CONTRACT, INVOICE, HANDOVER)
 * @param config - Optional partial config to override defaults
 * @param counter - The sequence number (defaults to 1)
 * @param date - The date to use (defaults to now)
 * @returns Formatted code string
 *
 * @example
 * generateCode('DEPOSIT')                          // "DC-20260222-001"
 * generateCode('CONTRACT')                         // "HD-202602-0001"
 * generateCode('INVOICE', undefined, 5)            // "INV-2026-00005"
 * generateCode('HANDOVER', undefined, 42)          // "BBBG-042"
 * generateCode('DEPOSIT', { prefix: 'DEP' }, 7)   // "DEP-20260222-007"
 */
export function generateCode(
  type: CodeType,
  config?: Partial<CodeConfig>,
  counter: number = 1,
  date: Date = new Date()
): string {
  const resolved: CodeConfig = {
    ...DEFAULT_CONFIGS[type],
    ...config,
  };

  const parts: string[] = [resolved.prefix];

  const datePart = formatDatePart(date, resolved.dateFormat);
  if (datePart) {
    parts.push(datePart);
  }

  const counterStr = String(counter).padStart(resolved.padding, '0');
  parts.push(counterStr);

  return parts.join(resolved.separator);
}


/**
 * Generate an invoice number using a prefix, format string, and user context.
 *
 * This is a convenience wrapper around `generateCode` for invoice-specific usage.
 *
 * @param prefix - The prefix for the invoice number (e.g. "INV")
 * @param _format - Format string (reserved for future use)
 * @param _userId - User ID (reserved for future per-user counters)
 * @param resetPeriod - When to reset the counter ("DAILY", "MONTHLY", "YEARLY", "NEVER")
 * @returns Generated invoice number string
 */
export async function generateInvoiceNumber(
  prefix: string,
  _format: string,
  _userId: string,
  resetPeriod: string
): Promise<string> {
  const periodMap: Record<string, ResetPeriod> = {
    DAILY: 'daily',
    MONTHLY: 'monthly',
    YEARLY: 'yearly',
    NEVER: 'never',
  };

  const resolvedPeriod = periodMap[resetPeriod] || 'yearly';

  // Determine date format based on reset period
  const dateFormatMap: Record<ResetPeriod, DateFormat> = {
    daily: 'YYYYMMDD',
    monthly: 'YYYYMM',
    yearly: 'YYYY',
    never: 'none',
  };

  return generateCode(
    'INVOICE',
    {
      prefix,
      resetPeriod: resolvedPeriod,
      dateFormat: dateFormatMap[resolvedPeriod],
    },
    1,
    new Date()
  );
}


/**
 * Generate a contract number using a prefix, format string, and user context.
 *
 * This is a convenience wrapper around `generateCode` for contract-specific usage.
 *
 * @param prefix - The prefix for the contract number (e.g. "HD")
 * @param _format - Format string (reserved for future use)
 * @param _userId - User ID (reserved for future per-user counters)
 * @param resetPeriod - When to reset the counter ("DAILY", "MONTHLY", "YEARLY", "NEVER")
 * @returns Generated contract number string
 */
export async function generateContractNumber(
  prefix: string,
  _format: string,
  _userId: string,
  resetPeriod: string
): Promise<string> {
  const periodMap: Record<string, ResetPeriod> = {
    DAILY: 'daily',
    MONTHLY: 'monthly',
    YEARLY: 'yearly',
    NEVER: 'never',
  };

  const resolvedPeriod = periodMap[resetPeriod] || 'monthly';

  const dateFormatMap: Record<ResetPeriod, DateFormat> = {
    daily: 'YYYYMMDD',
    monthly: 'YYYYMM',
    yearly: 'YYYY',
    never: 'none',
  };

  return generateCode(
    'CONTRACT',
    {
      prefix,
      resetPeriod: resolvedPeriod,
      dateFormat: dateFormatMap[resolvedPeriod],
    },
    1,
    new Date()
  );
}
