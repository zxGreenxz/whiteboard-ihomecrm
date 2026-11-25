// Tạo một bản ghi KHÔNG PHẢI TIỀN (khách, khách hẹn) với mã do trình duyệt sinh.
//
// VÌ SAO
//   Trước đợt 4 (plan sửa khoá vĩnh viễn, 25/11/2026), tạo khách và tạo khách hẹn giữ một dấu «chờ đối chiếu» với
//   một KHOÁ CHUNG cho mọi bản ghi mới cùng loại: một lần rớt mạng chặn mọi lần tạo sau đó. Luật 5 của plan: dữ liệu
//   không phải tiền thì không khoá, báo lỗi rõ và cho thử lại. Chống trùng là việc của máy chủ: bảng `customers`,
//   `leads` nhận cột `id` do trình duyệt gửi (đo production và thử trên TEST 25/11/2026), nên gửi lại ĐÚNG mã cũ thì
//   khoá chính chặn bản ghi thứ hai (23505), và đọc đúng mã cho biết chắc lần trước đã ghi hay chưa.
//
// CÁCH DÙNG
//   Mỗi lần tạo chọn mã qua `pickClientId`: lần gửi trước của CÙNG bản ghi còn chưa rõ kết quả thì dùng lại mã đó.
//   «Cùng bản ghi» = cùng nội dung, hoặc trùng một khoá nhận dạng (SĐT, tên chuẩn hoá, số giấy tờ) trong cùng người
//   dùng và công ty. Bộ nhớ này sống theo tab, không ghi vào trình duyệt, không chặn gì: tải lại trang là quên.
import { supabase } from '@/integrations/supabase/client';
import { FinancialAlreadyRecordedError, FinancialWorkflowError } from './financialWorkflowError';
import { hasUnconfirmedResponse } from './operationOutcome';

export type ClientCreateTable = 'customers' | 'leads';
type Row = { id: string };

interface UnconfirmedCreate { id: string; fingerprint: string; matchKeys: string[]; at: number }
const unconfirmed = new Map<string, UnconfirmedCreate[]>();
/** Giữ tối đa chừng này lần gửi chưa rõ cho mỗi (bảng, người, công ty); cũ hơn một ngày thì bỏ. */
const MEMORY_LIMIT = 20;
const MEMORY_TTL_MS = 24 * 60 * 60_000;

/** Chuẩn hoá tên tiếng Việt để so: bỏ dấu, chữ thường, đ→d, gộp khoảng trắng. */
export function normalizeVietnameseName(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd').trim().replace(/\s+/g, ' ')
    : '';
}
const digits = (value: unknown) => (typeof value === 'string' ? value.replace(/\D/g, '') : '');

/** Khoá nhận dạng một người trong payload tạo: SĐT (≥ 6 chữ số), tên chuẩn hoá, số giấy tờ. */
export function personMatchKeys(fields: { name?: unknown; phone?: unknown; idNumber?: unknown }): string[] {
  const keys: string[] = [];
  const phone = digits(fields.phone);
  if (phone.length >= 6) keys.push(`p:${phone}`);
  const name = normalizeVietnameseName(fields.name);
  if (name) keys.push(`n:${name}`);
  const idNumber = typeof fields.idNumber === 'string' ? fields.idNumber.trim() : '';
  if (idNumber) keys.push(`c:${idNumber}`);
  return keys;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}
/** Dấu vân tay nội dung để biết lần bấm sau có đúng thông tin lần trước không. */
export const contentFingerprint = (payload: unknown): string => JSON.stringify(stable(payload));

const memoryKey = (table: ClientCreateTable, userId: string, organizationId: string) => `${table}|${userId}|${organizationId}`;
function liveEntries(key: string, now: number): UnconfirmedCreate[] {
  const entries = (unconfirmed.get(key) ?? []).filter(entry => now - entry.at < MEMORY_TTL_MS);
  if (entries.length) unconfirmed.set(key, entries); else unconfirmed.delete(key);
  return entries;
}

export interface ClientIdChoice {
  id: string;
  /** Lần gửi chưa rõ kết quả mà mã này được dùng lại, nếu có. */
  reused: UnconfirmedCreate | null;
}

/** Chọn mã cho lần tạo này: dùng lại mã của lần gửi chưa rõ kết quả gần nhất của cùng bản ghi, không có thì mã mới. */
export function pickClientId(table: ClientCreateTable, userId: string, organizationId: string, fingerprint: string, matchKeys: readonly string[]): ClientIdChoice {
  const entries = liveEntries(memoryKey(table, userId, organizationId), Date.now());
  const same = [...entries].reverse().find(entry => entry.fingerprint === fingerprint || entry.matchKeys.some(key => matchKeys.includes(key)));
  return same ? { id: same.id, reused: same } : { id: crypto.randomUUID(), reused: null };
}

/** Lần gửi này chưa rõ kết quả: nhớ mã để lần bấm sau của cùng bản ghi gửi lại đúng mã. */
export function rememberUnconfirmed(table: ClientCreateTable, userId: string, organizationId: string, entry: Omit<UnconfirmedCreate, 'at'>): void {
  const key = memoryKey(table, userId, organizationId);
  const kept = liveEntries(key, Date.now()).filter(item => item.id !== entry.id);
  unconfirmed.set(key, [...kept, { ...entry, at: Date.now() }].slice(-MEMORY_LIMIT));
}

/** Đã biết chắc kết quả của mã này (đã ghi, hoặc đã báo người dùng): quên nó. */
export function forgetUnconfirmed(table: ClientCreateTable, userId: string, organizationId: string, id: string): void {
  const key = memoryKey(table, userId, organizationId);
  const kept = (unconfirmed.get(key) ?? []).filter(item => item.id !== id);
  if (kept.length) unconfirmed.set(key, kept); else unconfirmed.delete(key);
}

/** Xoá cả bộ nhớ (test, đổi tài khoản). */
export function forgetUnconfirmedCreates(): void {
  unconfirmed.clear();
}

export const isUniqueViolation = (error: unknown): boolean =>
  !!error && typeof error === 'object' && String((error as { code?: unknown }).code ?? '') === '23505';

const validRow = (value: unknown, id: string): value is Row =>
  !!value && typeof value === 'object' && (value as { id?: unknown }).id === id;

/** Đọc đúng bản ghi theo mã. `null` khi không thấy hoặc đọc hỏng: chưa đủ để kết luận gì. */
export async function readRecordById<T extends Row>(table: ClientCreateTable, id: string): Promise<T | null> {
  try {
    const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
    return !error && validRow(data, id) ? (data as unknown as T) : null;
  } catch {
    return null;
  }
}

export interface ClientCreateOutcome<T> { row: T; replayed: boolean }

/**
 * Chèn một dòng mang mã `id`. Kết quả:
 * - `{row, replayed:false}`: máy chủ trả đúng dòng vừa chèn.
 * - `{row, replayed:true}`: dòng mang mã này đã có (lần gửi trước đã ghi): đọc đúng mã thấy nó.
 * - ném lỗi gốc: máy chủ từ chối rõ (kể cả trùng một ràng buộc khác, đọc đúng mã không thấy).
 * - ném `FinancialWorkflowError('unknown')`: chưa rõ kết quả và đọc đúng mã chưa thấy. Gửi lại ĐÚNG mã này là an toàn.
 */
export async function insertWithClientId<T extends Row>(table: ClientCreateTable, id: string, payload: Record<string, unknown>, operation: string): Promise<ClientCreateOutcome<T>> {
  let response: { data: unknown; error: unknown };
  try {
    response = await supabase.from(table).insert({ ...payload, id } as never).select().single();
  } catch (error) {
    response = { data: null, error };
  }
  const { data, error } = response;
  // Biên nhận dương: máy chủ trả dòng vừa chèn. Mã khác mã đã gửi (máy chủ không giữ mã do trình duyệt sinh) vẫn là
  // dòng đã tạo thật, nên nhận nó, không coi là chưa rõ để rồi tạo thêm.
  const receiptId = data && typeof data === 'object' ? (data as { id?: unknown }).id : undefined;
  if (!error && typeof receiptId === 'string' && receiptId) return { row: data as unknown as T, replayed: false };
  const uniqueViolation = isUniqueViolation(error);
  // Không lỗi mà không có dòng đúng mã, lỗi mạng, hay trùng khoá: đọc đúng mã mới biết lần gửi đã ghi chưa.
  if (!error || uniqueViolation || hasUnconfirmedResponse(error)) {
    const existing = await readRecordById<T>(table, id);
    if (existing) return { row: existing, replayed: true };
    if (uniqueViolation) throw error;
    throw new FinancialWorkflowError(
      `Chưa xác nhận được kết quả ${operation}. Giữ nguyên thông tin rồi bấm lưu lại: máy gửi lại đúng mã này nên không tạo trùng.`,
      'unknown', [{ id, label: 'Mã bản ghi đang chờ xác nhận' }], error,
    );
  }
  throw error;
}

export interface CreateWithMemoryInput {
  table: ClientCreateTable;
  userId: string;
  organizationId: string;
  payload: Record<string, unknown>;
  matchKeys: readonly string[];
  operation: string;
  /** Tên hiển thị trong câu báo khi lần trước đã ghi với thông tin khác. */
  describe: (row: Record<string, unknown>) => string;
  /** Nơi gọi tự giữ mã cho từng bản ghi (nhập Excel theo dòng): dùng đúng mã này, không tra bộ nhớ. */
  clientId?: string;
}

/**
 * Tạo một bản ghi, nhớ mã khi chưa rõ kết quả để lần bấm sau của cùng bản ghi gửi lại đúng mã.
 * Lần trước đã ghi nhưng nội dung lần này khác (người dùng sửa giữa hai lần): không ghi gì thêm, ném
 * `FinancialAlreadyRecordedError` nêu mã bản ghi đã có; lần bấm sau là lượt mới.
 */
export async function createWithClientMemory<T extends Row>(input: CreateWithMemoryInput): Promise<ClientCreateOutcome<T>> {
  const fingerprint = contentFingerprint(input.payload);
  const choice = input.clientId
    ? { id: input.clientId, reused: null }
    : pickClientId(input.table, input.userId, input.organizationId, fingerprint, input.matchKeys);
  let outcome: ClientCreateOutcome<T>;
  try {
    outcome = await insertWithClientId<T>(input.table, choice.id, input.payload, input.operation);
  } catch (error) {
    if (!input.clientId && error instanceof FinancialWorkflowError && error.outcome === 'unknown') {
      rememberUnconfirmed(input.table, input.userId, input.organizationId, { id: choice.id, fingerprint, matchKeys: [...input.matchKeys] });
    }
    throw error;
  }
  if (!input.clientId) forgetUnconfirmed(input.table, input.userId, input.organizationId, choice.id);
  if (outcome.replayed && choice.reused && choice.reused.fingerprint !== fingerprint) {
    throw new FinancialAlreadyRecordedError(
      `${input.describe(outcome.row as unknown as Record<string, unknown>)} đã được tạo ở lần gửi trước với thông tin lúc đó (mã ${outcome.row.id}). Mở bản ghi đó để kiểm tra và sửa nếu cần; bấm lưu lại nếu vẫn muốn tạo thêm.`,
      [outcome.row.id],
    );
  }
  return outcome;
}
