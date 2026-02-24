// =============================================
// Invoice Template Engine
// Renders invoice HTML from template strings with placeholder substitution,
// FEES loop blocks, logo image replacement, and Vietnamese currency formatting.
// =============================================

// =============================================
// Types
// =============================================

export interface InvoiceFeeItem {
  index: number;
  name: string;
  price: string;
  quantity: string;
  coefficient: string;
  total: string;
}

export interface InvoiceTemplateData {
  APARTMENT_NAME: string;
  ROOM_NAME: string;
  CONTRACT_NAME: string;
  INVOICE_CODE: string;
  ISSUE_DATE: string;
  DUE_DATE: string;
  SUBTOTAL: string;
  DISCOUNT_WITH_PROMOTION: string;
  DEBT: string;
  TOTAL_WITH_DEBT: string;
  PAID: string;
  REMAIN: string;
  AMOUNT_IN_WORDS_WITH_DEBT: string;
  NOTE: string;
  LOGO_URL?: string;
  FEES: InvoiceFeeItem[];
  [key: string]: unknown;
}

// =============================================
// Currency Formatting
// =============================================

/**
 * Format a number with dot separators for thousands (Vietnamese style).
 * Examples: 1000000 → "1.000.000", 0 → "0", -1500 → "-1.500"
 * Decimals are rounded before formatting.
 */
export function formatCurrencyVND(amount: number): string {
  const rounded = Math.round(amount);
  const isNegative = rounded < 0;
  const abs = Math.abs(rounded);
  const str = abs.toString();

  // Insert dots every 3 digits from the right
  let result = '';
  for (let i = 0; i < str.length; i++) {
    if (i > 0 && (str.length - i) % 3 === 0) {
      result += '.';
    }
    result += str[i];
  }

  return isNegative ? `-${result}` : result;
}

// =============================================
// Number to Vietnamese Words
// =============================================

const DIGITS = [
  'không', 'một', 'hai', 'ba', 'bốn',
  'năm', 'sáu', 'bảy', 'tám', 'chín',
];

/**
 * Read a group of up to 3 digits as Vietnamese words.
 * @param hundreds - hundreds digit (0-9)
 * @param tens - tens digit (0-9)
 * @param units - units digit (0-9)
 * @param hasHigherGroup - whether there is a non-zero group above this one
 */
function readThreeDigits(
  hundreds: number,
  tens: number,
  units: number,
  hasHigherGroup: boolean,
): string {
  const parts: string[] = [];

  if (hundreds > 0) {
    parts.push(`${DIGITS[hundreds]} trăm`);
  } else if (hasHigherGroup && (tens > 0 || units > 0)) {
    // Need "không trăm" when there's a higher group and this group has tens/units
    parts.push('không trăm');
  }

  if (tens > 1) {
    parts.push(`${DIGITS[tens]} mươi`);
    if (units === 1) {
      parts.push('mốt');
    } else if (units === 4) {
      parts.push('tư');
    } else if (units === 5) {
      parts.push('lăm');
    } else if (units > 0) {
      parts.push(DIGITS[units]);
    }
  } else if (tens === 1) {
    parts.push('mười');
    if (units === 1) {
      parts.push('một');
    } else if (units === 5) {
      parts.push('lăm');
    } else if (units > 0) {
      parts.push(DIGITS[units]);
    }
  } else if (units > 0) {
    if (hundreds > 0 || hasHigherGroup) {
      parts.push('lẻ');
    }
    parts.push(DIGITS[units]);
  }

  return parts.join(' ');
}

/**
 * Convert a non-negative integer to Vietnamese words with "đồng" suffix.
 * Supports range 0 to 999,999,999,999.
 *
 * Examples:
 *   0 → "không đồng"
 *   1000 → "một nghìn đồng"
 *   1500000 → "một triệu năm trăm nghìn đồng"
 */
export function numberToVietnameseWords(amount: number): string {
  const n = Math.round(Math.abs(amount));

  if (n === 0) return 'không đồng';

  // Split into groups of 3 from right to left
  const billions = Math.floor(n / 1_000_000_000);
  const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const remainder = n % 1_000;

  const groups: { value: number; suffix: string }[] = [
    { value: billions, suffix: 'tỷ' },
    { value: millions, suffix: 'triệu' },
    { value: thousands, suffix: 'nghìn' },
    { value: remainder, suffix: '' },
  ];

  const parts: string[] = [];
  let hasHigherGroup = false;

  for (const group of groups) {
    if (group.value > 0 || (hasHigherGroup && group.suffix === '')) {
      const h = Math.floor(group.value / 100);
      const t = Math.floor((group.value % 100) / 10);
      const u = group.value % 10;

      const words = readThreeDigits(h, t, u, hasHigherGroup);
      if (words) {
        parts.push(group.suffix ? `${words} ${group.suffix}` : words);
      }
      hasHigherGroup = true;
    } else if (group.value === 0 && hasHigherGroup && group.suffix !== '') {
      // Skip zero groups in the middle but mark that higher groups exist
      // (the readThreeDigits handles "không trăm" when needed)
    }
  }

  return `${parts.join(' ')} đồng`;
}

// =============================================
// Template Rendering
// =============================================

/**
 * Render an invoice template by replacing placeholders, processing FEES loops,
 * and handling logo image substitution.
 *
 * Rules:
 * 1. Replace `{#FEES}...{/FEES}` block by iterating data.FEES
 * 2. Replace `+++IMAGE LOGO()+++` with `<img>` tag using LOGO_URL
 * 3. Replace all `{PLACEHOLDER_NAME}` with corresponding data values
 * 4. Unknown placeholders → empty string
 */
export function renderInvoiceTemplate(
  template: string,
  data: InvoiceTemplateData,
): string {
  let result = template;

  // 1. Process FEES loop block
  result = result.replace(
    /\{#FEES\}([\s\S]*?)\{\/FEES\}/g,
    (_match, loopBody: string) => {
      if (!data.FEES || data.FEES.length === 0) return '';

      return data.FEES.map((fee) => {
        let row = loopBody;
        row = row.replace(/\{index\}/g, String(fee.index));
        row = row.replace(/\{name\}/g, fee.name);
        row = row.replace(/\{price\}/g, fee.price);
        row = row.replace(/\{quantity\}/g, fee.quantity);
        row = row.replace(/\{coefficient\}/g, fee.coefficient);
        row = row.replace(/\{total\}/g, fee.total);
        return row;
      }).join('');
    },
  );

  // 2. Replace logo placeholder
  if (data.LOGO_URL) {
    result = result.replace(
      /\+\+\+IMAGE LOGO\(\)\+\+\+/g,
      `<img src="${data.LOGO_URL}" alt="Logo" />`,
    );
  } else {
    result = result.replace(/\+\+\+IMAGE LOGO\(\)\+\+\+/g, '');
  }

  // 3. Replace all {PLACEHOLDER} with data values
  result = result.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_match, key: string) => {
    const value = data[key];
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
  });

  return result;
}
