// Mask PII trước khi nội dung rời hệ thống (đi qua LLM provider) — F12 PLAN.md.
// Dùng cho: transformPageContent (UI-control) + output tool nhạy cảm (chat).
//
// Phạm vi v1: SĐT VN, CCCD/CMND, STK ngân hàng (chỉ khi có từ khoá ngữ cảnh
// để không nuốt nhầm mã số/ID/tiền).

const PHONE_RE = /(\+?84|0)(?:[\s.\-]?\d){8,10}\b/g;
const CCCD_RE = /\b\d{12}\b/g;
// STK: 8–16 chữ số NGAY SAU từ khoá ngữ cảnh (stk, số tk, số tài khoản, tk:)
const STK_RE = /((?:stk|s[ốo] t[àa]i kho[ảa]n|s[ốo] tk|tk)\s*[:#]?\s*)\d{8,16}\b/gi;

export function maskPii(content: string): string {
  return content
    .replace(STK_RE, '$1[STK đã ẩn]')
    .replace(CCCD_RE, '[CCCD đã ẩn]')
    .replace(PHONE_RE, '[SĐT đã ẩn]');
}

/** Che một phần SĐT để vẫn nhận diện được người (090***4567). */
export function maskPhonePartial(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return phone;
  return `${digits.slice(0, 3)}***${digits.slice(-4)}`;
}
