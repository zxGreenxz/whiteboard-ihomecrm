import { PublicRequestError } from './publicFeedback';
type Item = {
  id: string;
  type: string | null;
  description: string | null;
  unit_price: number | null;
  quantity: number | null;
  coefficient: number | null;
  amount: number | null;
  previous_reading: number | null;
  current_reading: number | null;
  from_date: string | null;
  to_date: string | null;
};

type PublicInvoice = {
  id: string;
  invoice_number: string | null;
  billing_month: string | null;
  issue_date: string | null;
  due_date: string | null;
  status: string;
  subtotal: number | null;
  discount_amount: number | null;
  total_amount: number | null;
  paid_amount: number | null;
  remaining_amount: number | null;
  previous_debt: number | null;
  items: Item[];
};

export type PublicPayload = {
  invoice: PublicInvoice | null;
  room: { id: string; name: string; code: string | null } | null;
  building: { id: string; name: string } | null;
  // Số điện thoại đã bị bỏ khỏi payload ở 20260808100000: bề mặt này anon gọi
  // được chỉ bằng một mã hợp đồng 6 ký tự, nên mọi trường ở đây là dữ liệu công
  // khai với bất kỳ ai đoán trúng mã.
  customer?: { full_name: string } | null;
};


const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const numberOrNull = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value));
const dateOrNull = (value: unknown) => value === null || (typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)));
export function parsePublicInvoice(value: unknown): PublicPayload | null {
  if (value === null) return null;
  const invalid = () => { throw new PublicRequestError(0, 'invalid-response'); };
  if (!object(value) || !('invoice' in value) || !('room' in value) || !('building' in value)) return invalid();
  for (const key of ['room', 'building']) {
    const entity = value[key];
    if (entity !== null && (!object(entity) || typeof entity.id !== 'string' || typeof entity.name !== 'string')) return invalid();
  }
  const invoice = value.invoice;
  if (invoice !== null) {
    if (!object(invoice) || typeof invoice.id !== 'string' || typeof invoice.status !== 'string' || !nullableText(invoice.invoice_number) || !Array.isArray(invoice.items)) return invalid();
    if (['subtotal','discount_amount','total_amount','paid_amount','remaining_amount','previous_debt'].some(key => !numberOrNull(invoice[key]))) return invalid();
    if (['billing_month','issue_date','due_date'].some(key => !dateOrNull(invoice[key]))) return invalid();
    for (const item of invoice.items) {
      if (!object(item) || typeof item.id !== 'string' || !nullableText(item.description) || !nullableText(item.type)) return invalid();
      if (['unit_price','quantity','coefficient','amount','previous_reading','current_reading'].some(key => !numberOrNull(item[key]))) return invalid();
      if (['from_date','to_date'].some(key => !dateOrNull(item[key]))) return invalid();
    }
  }
  if (value.customer != null && (!object(value.customer) || typeof value.customer.full_name !== 'string')) return invalid();
  return value as PublicPayload;
}
