import { BILL_SENDER_DOMAINS, isValidBillDate, parseEmailBill } from './parser';
import type { GmailBillPage, GmailMessage, GmailMessagePart, GmailSession } from './types';

export class GmailError extends Error {
  constructor(public readonly code: 'expired' | 'unauthorized' | 'forbidden' | 'request_failed' | 'invalid_response' | 'invalid_range' | 'aborted' | 'timeout', message: string) { super(message); this.name = 'GmailError'; }
}
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function request(session: GmailSession, path: string, signal?: AbortSignal): Promise<unknown> {
  if (!session.accessToken || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) throw new GmailError('expired', 'Phiên Gmail đã hết hạn. Vui lòng kết nối lại.');
  if (signal?.aborted) throw new GmailError('aborted', 'Đã hủy đọc Gmail.');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
  try {
    const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${session.accessToken}` }, signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (response.status === 401) throw new GmailError('unauthorized', 'Google không chấp nhận phiên Gmail. Vui lòng kết nối lại.');
    if (response.status === 403) throw new GmailError('forbidden', 'Chưa có quyền đọc Gmail hoặc Gmail API chưa được bật.');
    if (!response.ok) throw new GmailError('request_failed', 'Không đọc được Gmail. Vui lòng thử lại.');
    try { return await response.json(); } catch { throw new GmailError('invalid_response', 'Gmail trả về dữ liệu không hợp lệ.'); }
  } catch (error) {
    if (controller.signal.aborted) throw new GmailError(timedOut ? 'timeout' : 'aborted', timedOut ? 'Đọc Gmail quá thời gian. Vui lòng thử lại.' : 'Đã hủy đọc Gmail.');
    if (error instanceof GmailError) throw error;
    throw new GmailError('request_failed', 'Không kết nối được Gmail. Vui lòng thử lại.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function readGmailProfile(session: GmailSession, signal?: AbortSignal): Promise<string> {
  const profile = await request(session, '/profile', signal);
  if (!isRecord(profile) || typeof profile.emailAddress !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.emailAddress)) throw new GmailError('invalid_response', 'Không xác định được tài khoản Gmail.');
  return profile.emailAddress;
}

function validPart(part: unknown, depth = 0): part is GmailMessagePart {
  if (!isRecord(part) || depth > 15) return false;
  if (part.mimeType !== undefined && typeof part.mimeType !== 'string') return false;
  if (part.filename !== undefined && typeof part.filename !== 'string') return false;
  if (part.headers !== undefined && (!Array.isArray(part.headers) || !part.headers.every((item) => isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string'))) return false;
  if (part.body !== undefined && (!isRecord(part.body) || (part.body.data !== undefined && typeof part.body.data !== 'string') || (part.body.attachmentId !== undefined && typeof part.body.attachmentId !== 'string'))) return false;
  return part.parts === undefined || (Array.isArray(part.parts) && part.parts.every((child) => validPart(child, depth + 1)));
}

export async function listGmailBills(session: GmailSession, mailbox: string, range: {from: string; to: string}, pageToken?: string, signal?: AbortSignal): Promise<GmailBillPage> {
  if (!isValidBillDate(range.from) || !isValidBillDate(range.to) || range.from > range.to) throw new GmailError('invalid_range', 'Khoảng ngày tìm kiếm không hợp lệ.');
  // Gmail's date string search uses Pacific time; Unix seconds define the selected
  // Vietnam calendar days explicitly and include the whole final day.
  const start = Date.parse(`${range.from}T00:00:00+07:00`) / 1000;
  const end = Date.parse(`${range.to}T00:00:00+07:00`) / 1000 + 86400;
  const senders = Object.values(BILL_SENDER_DOMAINS).flat().map((domain) => `from:(${domain})`).join(' ');
  const params = new URLSearchParams({ q: `{${senders}} after:${start - 1} before:${end}`, maxResults: '20' });
  if (pageToken !== undefined) params.set('pageToken', pageToken);
  const page = await request(session, `/messages?${params}`, signal);
  if (!isRecord(page) || (page.messages !== undefined && !Array.isArray(page.messages)) || (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string')) throw new GmailError('invalid_response', 'Danh sách Gmail không hợp lệ.');
  const entries = page.messages ?? [];
  if (!Array.isArray(entries) || !entries.every((entry) => isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0)) throw new GmailError('invalid_response', 'Danh sách Gmail không hợp lệ.');
  const result: GmailBillPage = { bills: [], nextPageToken: typeof page.nextPageToken === 'string' ? page.nextPageToken : null, failedCount: 0 };
  for (const entry of entries) {
    if (signal?.aborted) throw new GmailError('aborted', 'Đã hủy đọc Gmail.');
    try {
      const raw = await request(session, `/messages/${encodeURIComponent(String(entry.id))}?format=full`, signal);
      if (!isRecord(raw) || raw.id !== entry.id || !validPart(raw.payload)) throw new GmailError('invalid_response', 'Nội dung Gmail không hợp lệ.');
      const message: GmailMessage = { id: String(raw.id), payload: raw.payload };
      const bill = parseEmailBill(message, mailbox);
      if (bill) result.bills.push(bill);
    } catch (error) {
      if (error instanceof GmailError && ['unauthorized', 'forbidden', 'expired', 'aborted', 'timeout'].includes(error.code)) throw error;
      result.failedCount++;
    }
  }
  return result;
}
