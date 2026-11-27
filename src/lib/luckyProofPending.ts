import { z } from 'zod';
import type { LuckyProof } from './luckyDrawApi';

// Giấy cọc ĐÃ tải xong (biên nhận dương của kho) mà chưa được `lucky_save_payout_v1` gắn vào đội: giữ trong trình duyệt để
// lần sau gắn lại đúng tệp đó, không bắt khách tải lại (khoá `ihome:lucky-proof-pending:v1:<sự kiện>:<đội>`).
//
// Đợt 9 (mẫu PR #478): kho này chỉ là tiện ích, KHÔNG phải dấu chặn. Đọc hỏng hay dữ liệu hỏng dạng thì coi như không có tệp
// chờ gắn (tệp đã tải mà mất dấu chỉ còn là tệp mồ côi, vô hại) và bỏ bản hỏng; ghi hỏng thì tệp vẫn được giữ trong trang
// đang mở. Đường dẫn không thuộc thư mục của sự kiện thì không bao giờ được đem gắn.
const schema = z.array(z.object({ path: z.string().min(1), name: z.string().min(1), at: z.string().optional() })).max(10);
const key = (eventId: string, teamId: string) => 'ihome:lucky-proof-pending:v1:' + [eventId, teamId].map(encodeURIComponent).join(':');
function forget(eventId: string, teamId: string) {
  try { localStorage.removeItem(key(eventId, teamId)); }
  catch { /* Không gỡ được thì bản cũ chỉ được đọc lại lần sau; không chặn gì. */ }
}
function parseStored(raw: string | null, eventId: string): LuckyProof[] | 'invalid' {
  if (!raw) return [];
  let value: unknown = null;
  try { value = JSON.parse(raw); }
  catch { value = null; /* Bản lưu hỏng dạng: xử lý như dữ liệu sai bên dưới. */ }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return 'invalid';
  const own = parsed.data.filter(p => p.path.startsWith(eventId + '/'));
  return [...new Map(own.map(p => [p.path, { path: p.path, name: p.name, ...(p.at ? { at: p.at } : {}) }])).values()];
}
export function readPendingLuckyProofs(eventId: string, teamId: string): LuckyProof[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key(eventId, teamId)); }
  catch { raw = null; /* Trình duyệt không cho đọc: không có tệp chờ gắn nào; tải giấy cọc vẫn chạy bình thường. */ }
  const proofs = parseStored(raw, eventId);
  if (proofs !== 'invalid') return proofs;
  forget(eventId, teamId);
  return [];
}
function write(eventId: string, teamId: string, paths: LuckyProof[]) {
  if (!paths.length) { forget(eventId, teamId); return; }
  try { localStorage.setItem(key(eventId, teamId), JSON.stringify(paths)); }
  catch { /* Không lưu được thì tệp đã tải chỉ còn được giữ trong trang đang mở; tải lại trang thì khách chọn lại tệp. */ }
}
export function retainUploadedLuckyProof(eventId: string, teamId: string, proof: LuckyProof): LuckyProof[] {
  if (!proof.path.startsWith(eventId + '/')) return readPendingLuckyProofs(eventId, teamId);
  const next = [...new Map([...readPendingLuckyProofs(eventId, teamId), proof].map(p => [p.path, p])).values()];
  write(eventId, teamId, next);
  return next;
}
export function confirmPendingLuckyProofs(eventId: string, teamId: string, confirmed: readonly LuckyProof[]): LuckyProof[] {
  const next = readPendingLuckyProofs(eventId, teamId).filter(p => !confirmed.some(saved => saved.path === p.path));
  write(eventId, teamId, next);
  return next;
}
/** Bỏ hẳn các tệp chờ gắn (khách chọn bỏ qua). Tệp đã nằm trong kho chỉ còn là tệp mồ côi, không gắn vào đội nào. */
export function discardPendingLuckyProofs(eventId: string, teamId: string): void {
  forget(eventId, teamId);
}

/**
 * Dấu «đã lên kế hoạch tải» của BẢN TRƯỚC (khoá `upload:<đội>`): ghi trước khi gửi tệp, kẹt lại khi mất phản hồi và từng
 * khoá ô tải mãi. Bản này không ghi nữa. Đọc MỘT LẦN rồi bỏ, trả tên tệp để nhắc khách chọn lại (tệp đó chưa từng được gắn
 * vào đội; nếu đã nằm trong kho thì chỉ là tệp mồ côi). Không bao giờ ném lỗi, không chặn gì.
 */
export function takeLegacyPlannedLuckyUploads(eventId: string, teamId: string): string[] {
  const names = readPendingLuckyProofs(eventId, 'upload:' + teamId).map(p => p.name);
  forget(eventId, 'upload:' + teamId);
  return names;
}
