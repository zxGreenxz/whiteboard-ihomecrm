import type { BillProvider, EmailBill, GmailMessage, GmailMessagePart } from './types';

// The same domains drive Gmail search and From validation. Search is only a filter;
// each returned message is validated again at the parser boundary.
export const BILL_SENDER_DOMAINS: Readonly<Record<BillProvider, readonly string[]>> = {
  grab: ['grab.com'], shopee: ['shopee.vn'],
};
const MAX_BODY_SIZE = 1_000_000;
const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

function header(part: GmailMessagePart | undefined, name: string): string | null {
  const matches = part?.headers?.filter((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return matches?.length === 1 ? matches[0].value.trim() : null;
}

function senderProvider(from: string | null): BillProvider | null {
  if (!from) return null;
  const bracketed = from.match(/^[^<>\r\n]*<([^<>\r\n]+)>$/);
  const candidate = bracketed ? bracketed[1] : from;
  const address = candidate.match(/^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9.-]+))$/i);
  if (!address) return null;
  const domain = address[2].toLowerCase();
  if (!domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  for (const provider of ['grab', 'shopee'] as const) {
    if (BILL_SENDER_DOMAINS[provider].some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))) return provider;
  }
  return null;
}

function decodeBody(data: string): string {
  if (data.length > MAX_BODY_SIZE || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) throw new Error('invalid_body');
  const bytes = Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// Pure string conversion: no DOM, image, stylesheet, frame or network resource is created.
function htmlToText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|iframe|object|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|tr|td|th|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, code: string) => {
      const number = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    })
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()] ?? '');
}

function bodyText(part: GmailMessagePart | undefined, depth = 0): string {
  if (!part) return '';
  if (depth > 15) throw new Error('invalid_body');
  if (part.filename || /\battachment\b/i.test(header(part, 'Content-Disposition') ?? '')) return '';
  const mime = part.mimeType?.toLowerCase();
  if (mime === 'multipart/alternative') {
    const plain = part.parts?.find((child) => child.mimeType?.toLowerCase() === 'text/plain' && !child.filename);
    if (plain) return bodyText(plain, depth + 1);
    const html = part.parts?.find((child) => child.mimeType?.toLowerCase() === 'text/html' && !child.filename);
    return bodyText(html, depth + 1);
  }
  if (mime?.startsWith('multipart/')) return (part.parts ?? []).map((child) => bodyText(child, depth + 1)).join('\n');
  if (mime !== 'text/plain' && mime !== 'text/html') return '';
  if (!part.body?.data) {
    if (part.body?.attachmentId) throw new Error('unsupported_body');
    return '';
  }
  const decoded = decodeBody(part.body.data);
  return mime === 'text/html' ? htmlToText(decoded) : decoded;
}

function labeledValues(text: string, label: RegExp): string[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const values: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!label.test(fold(lines[index]))) continue;
    const separator = lines[index].search(/[:：]/);
    const suffix = separator >= 0 ? lines[index].slice(separator + 1).trim() : '';
    values.push(suffix || lines[index + 1] || '');
  }
  return values;
}

function amountValue(value: string): number | null {
  const match = value.match(/^(?:(?:VND|₫|đ)\s*)?([0-9]+|[1-9][0-9]{0,2}(?:[.,][0-9]{3})+)\s*(VND|₫|đ)?$/i);
  if (!match || !/(?:VND|₫|đ)/i.test(value)) return null;
  if (match[1].includes('.') && match[1].includes(',')) return null;
  const amount = Number(match[1].replace(/[.,]/g, ''));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export function isValidBillDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateValue(value: string): string | null {
  const dayFirst = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const date = dayFirst ? `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}` : value;
  return isValidBillDate(date) ? date : null;
}

export function parseEmailBill(message: GmailMessage, mailbox: string): EmailBill | null {
  const provider = senderProvider(header(message.payload, 'From'));
  if (!provider || !message.id || !mailbox) return null;
  const subject = header(message.payload, 'Subject') ?? '';
  const warnings: string[] = [];
  let text = '';
  try {
    text = bodyText(message.payload).replace(/\r\n?/g, '\n').replace(/[\t\u00a0]/g, ' ').trim();
    if (text.length > MAX_BODY_SIZE) throw new Error('invalid_body');
  } catch {
    warnings.push('Không đọc được phần nội dung thư được hỗ trợ.');
    text = '';
  }
  const receipts = labeledValues(text, /^(?:receipt\s*(?:id|number|no\.?)|trip\s*(?:id|code)|booking\s*(?:id|code)|order\s*(?:id|number)|ma\s*(?:bien nhan|hoa don|chuyen xe|dat xe|don hang))\s*(?:[:：]\s*|$)/);
  const normalizedReceipts = receipts.map((value) => value.replace(/^#/, '').trim().toUpperCase());
  const uniqueReceipts = new Set(normalizedReceipts);
  const receiptId = uniqueReceipts.size === 1 && /^[A-Z0-9][A-Z0-9_-]{3,79}$/.test(normalizedReceipts[0]) ? normalizedReceipts[0] : '';
  if (!receiptId) warnings.push('Thiếu mã biên nhận ổn định hoặc có nhiều mã khác nhau.');
  const totals = labeledValues(text, /^(?:total|grand total|total paid|amount paid|tong cong|tong tien|tong thanh toan|so tien da thanh toan)\s*(?:[:：]\s*|$)/).map(amountValue);
  const uniqueAmounts = new Set(totals);
  const amount = uniqueAmounts.size === 1 && totals[0] !== null ? totals[0] ?? null : null;
  if (amount === null) warnings.push('Không xác định được một tổng tiền VND nguyên, rõ ràng.');
  const dates = labeledValues(text, /^(?:date|payment date|trip date|ngay|ngay thanh toan|ngay giao dich)\s*(?:[:：]\s*|$)/).map(dateValue);
  const date = new Set(dates).size === 1 ? dates[0] ?? null : null;
  if (!date) warnings.push('Thiếu ngày giao dịch rõ ràng; cần kiểm tra thư.');
  const statusText = fold(`${subject}\n${text}`);
  const rejectedStatus = /\b(?:cancelled|canceled|cancellation|refund(?:ed)?|order confirmation|payment (?:pending|failed|unsuccessful|declined)|amount due|awaiting payment|unpaid|not (?:fully )?paid|huy|hoan tien|xac nhan (?:dat|don) hang|cho thanh toan|chua thanh toan|thanh toan that bai)\b/.test(statusText);
  const incompletePayment = /\b(?:to be paid|will be paid|(?:cash|pay|payment|paid) on delivery|cod|partially paid|partial payment|paid in part|(?:se|du kien) thanh toan|(?:thanh toan|tra tien) khi nhan hang|thanh toan (?:truoc )?mot phan|con phai thanh toan)\b/.test(statusText);
  const affirmativeStatus = /^(?:paid(?: in full)?|fully paid|completed|successful|payment (?:completed|successful)|da thanh toan(?: day du)?|thanh toan thanh cong)[.!]?$/;
  const paymentStatuses = labeledValues(text, /^(?:payment status|trang thai thanh toan)\s*(?:[:：]\s*|$)/).map(fold);
  const badStatus = rejectedStatus || incompletePayment || paymentStatuses.some(value => !affirmativeStatus.test(value));
  // Only complete affirmative lines/labels count. Incidental "paid", future
  // payment and the "Receipt ID" identity label do not prove payment.
  const paymentHeading = /^(?:payment (?:completed|successful)|paid(?: in full)?|fully paid|da thanh toan(?: day du)?|thanh toan thanh cong)[.!]?$/m;
  const receiptHeading = /^(?:payment receipt|your receipt|receipt|bien nhan)(?:$|\s*[-:])/m;
  const paid = (paymentStatuses.length > 0 && paymentStatuses.every(value => affirmativeStatus.test(value)))
    || paymentHeading.test(statusText)
    || receiptHeading.test(fold(subject)) || receiptHeading.test(fold(text));
  if (badStatus) warnings.push('Thư xác nhận đặt hàng, hủy, hoàn tiền, COD hoặc chưa thanh toán đủ không được nhập.');
  if (!paid) warnings.push('Chưa xác định đây là biên nhận đã thanh toán.');
  return {
    source: { provider, mailbox, message_id: message.id, receipt_id: receiptId },
    subject, description: `${provider === 'grab' ? 'Grab' : 'Shopee'}${receiptId ? ` - ${receiptId}` : ''}`,
    date, amount, text, warnings,
    blocked: badStatus || !paid || !receiptId || amount === null || text.length === 0,
  };
}
