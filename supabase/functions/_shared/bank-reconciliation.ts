import { summarizeBankPayload } from './bank-events-parse.ts';
import { type JsonObject } from './bank-events.ts';

/** Chỉ tóm tắt ngân hàng được lưu để đối chiếu; nguyên văn vẫn ở kho mã hóa. */
export function reconciliationFacts(payload: JsonObject): JsonObject | null {
  if (!['sms.received', 'notification.received', 'email.received'].includes(String(payload.event))) return null;
  const summary = summarizeBankPayload(payload);
  if (!summary || !summary.direction || !summary.amount || !Number.isSafeInteger(summary.amount)) return null;
  const from = String(payload.from ?? '').trim();
  const email = /^(?:[^<>]*<)?([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+)>?$/i.exec(from)?.[1]?.toLowerCase();
  const origin = payload.event === 'notification.received' ? String(payload.packageName ?? '').trim()
    : payload.event === 'email.received' ? email ?? '' : String(payload.sender ?? '').trim();
  // Mã tham chiếu phải có nhãn rõ ràng; không lấy các chuỗi số ngẫu nhiên trong nội dung.
  const reference = /(?:mã giao dịch|ma giao dich|ma gd|mã gd|reference|ref)\s*[:#]\s*([A-Z0-9-]{6,64})(?![A-Z0-9-])/i
    .exec(String(payload.body ?? ''))?.[1]?.toUpperCase() ?? null;
  return { ...summary, origin: origin.toLowerCase(), reference };
}
