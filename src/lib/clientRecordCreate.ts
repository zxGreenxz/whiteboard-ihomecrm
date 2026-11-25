// Tạo một bản ghi KHÔNG PHẢI TIỀN (khách, khách hẹn) với mã do trình duyệt sinh.
//
// VÌ SAO
//   Trước đợt 4 (plan sửa khoá vĩnh viễn, 25/11/2026), tạo khách và tạo khách hẹn giữ một dấu «chờ đối chiếu» với
//   một KHOÁ CHUNG cho mọi bản ghi mới cùng loại: một lần rớt mạng chặn mọi lần tạo sau đó. Luật 5 của plan: dữ liệu
//   không phải tiền thì không khoá, báo lỗi rõ và cho thử lại. Chống trùng là việc của máy chủ: bảng `customers`,
//   `leads` nhận cột `id` do trình duyệt gửi (đo production và thử trên TEST 25/11/2026), nên gửi lại ĐÚNG mã cũ thì
//   khoá chính chặn bản ghi thứ hai (23505), và đọc đúng mã cho biết chắc lần trước đã ghi hay chưa. Mọi chỉ mục
//   duy nhất của hai bảng này đều nằm trên `id` (production 25/11/2026), nên 23505 tự nó chứng minh mã đã có.
//
// CÁCH DÙNG
//   Mỗi lần tạo chọn mã qua `pickClientId`: lần gửi trước của cùng người (trùng SĐT, số giấy tờ hoặc tên chuẩn hoá,
//   để sửa SĐT hay sửa tên giữa hai lần vẫn nhận ra) trong cùng người dùng và công ty mà chưa biết chắc kết quả, kể cả
//   lần còn đang gửi, thì dùng lại mã đó. Chọn nhầm người khác trùng tên chỉ dẫn tới MỘT lần báo «đã có» (dòng đọc
//   lại khác người đang tạo, xem `samePerson`), không bao giờ ghi đè hay trùng. Bộ nhớ này sống theo tab, không ghi vào trình duyệt, không chặn gì: tải lại trang là quên.
import { supabase } from '@/integrations/supabase/client';
import { FinancialAlreadyRecordedError, FinancialWorkflowError } from './financialWorkflowError';
import { hasUnconfirmedResponse } from './operationOutcome';

export type ClientCreateTable = 'customers' | 'leads';
type Row = { id: string };

interface UnconfirmedCreate { id: string; matchKeys: string[]; at: number }
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

/**
 * Khoá nhận dạng một người: SĐT (≥ 6 chữ số), số giấy tờ. Tên chuẩn hoá chỉ dùng khi không có SĐT, vì hai người
 * khác nhau trùng tên là chuyện thường.
 */
export function personMatchKeys(fields: { name?: unknown; phone?: unknown; idNumber?: unknown }): string[] {
  const keys: string[] = [];
  const phone = digits(fields.phone);
  if (phone.length >= 6) keys.push(`p:${phone}`);
  const idNumber = typeof fields.idNumber === 'string' ? fields.idNumber.trim() : '';
  if (idNumber) keys.push(`c:${idNumber}`);
  const name = normalizeVietnameseName(fields.name);
  if (name && phone.length < 6) keys.push(`n:${name}`);
  return keys;
}

/** Cùng một người theo các trường nhận dạng: tên chuẩn hoá, SĐT (chữ số), số giấy tờ (trường nào có ở cả hai bên). */
/** Khoá để chọn lại mã trong bộ nhớ: như `personMatchKeys` nhưng luôn có tên (sửa SĐT giữa hai lần vẫn khớp). */
export function memoryMatchKeys(fields: { name?: unknown; phone?: unknown; idNumber?: unknown }): string[] {
  const keys = personMatchKeys(fields);
  const name = normalizeVietnameseName(fields.name);
  return name && !keys.includes(`n:${name}`) ? [...keys, `n:${name}`] : keys;
}

export function samePerson(a: { name?: unknown; phone?: unknown; idNumber?: unknown }, b: { name?: unknown; phone?: unknown; idNumber?: unknown }): boolean {
  const same = (x: string, y: string) => !x || !y || x === y;
  const idA = typeof a.idNumber === 'string' ? a.idNumber.trim() : '';
  const idB = typeof b.idNumber === 'string' ? b.idNumber.trim() : '';
  return normalizeVietnameseName(a.name) === normalizeVietnameseName(b.name) && same(digits(a.phone), digits(b.phone)) && same(idA, idB);
}

const memoryKey = (table: ClientCreateTable, userId: string, organizationId: string) => `${table}|${userId}|${organizationId}`;
function liveEntries(key: string, now: number): UnconfirmedCreate[] {
  const entries = (unconfirmed.get(key) ?? []).filter(entry => now - entry.at < MEMORY_TTL_MS);
  if (entries.length) unconfirmed.set(key, entries); else unconfirmed.delete(key);
  return entries;
}

export interface ClientIdChoice {
  id: string;
  /** Mã này là của một lần gửi trước còn chưa biết chắc kết quả (đang gửi, hoặc chưa rõ). */
  reused: boolean;
}

/** Chọn mã cho lần tạo này: dùng lại mã của lần gửi chưa biết chắc kết quả gần nhất của cùng người, không có thì mã mới. */
export function pickClientId(table: ClientCreateTable, userId: string, organizationId: string, matchKeys: readonly string[]): ClientIdChoice {
  const entries = liveEntries(memoryKey(table, userId, organizationId), Date.now());
  const same = [...entries].reverse().find(entry => entry.matchKeys.some(key => matchKeys.includes(key)));
  return same ? { id: same.id, reused: true } : { id: crypto.randomUUID(), reused: false };
}

/** Nhớ mã của một lần gửi chưa biết chắc kết quả (ghi TRƯỚC khi gửi, để lần bấm khi lệnh cũ còn treo cũng dùng lại). */
export function rememberUnconfirmed(table: ClientCreateTable, userId: string, organizationId: string, entry: Omit<UnconfirmedCreate, 'at'>): void {
  const key = memoryKey(table, userId, organizationId);
  const kept = liveEntries(key, Date.now()).filter(item => item.id !== entry.id);
  unconfirmed.set(key, [...kept, { ...entry, at: Date.now() }].slice(-MEMORY_LIMIT));
}

/** Đã biết chắc kết quả của mã này (đã ghi, máy chủ từ chối rõ, hoặc đã báo người dùng): quên nó. */
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

export type RecordRead<T> = { state: 'found'; row: T } | { state: 'missing' } | { state: 'unreadable' };

/** Đọc đúng bản ghi theo mã. `missing` = đọc được nhưng không thấy (chưa có, hoặc RLS ẩn); `unreadable` = đọc hỏng. */
export async function readRecordById<T extends Row>(table: ClientCreateTable, id: string): Promise<RecordRead<T>> {
  try {
    const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
    if (error) return { state: 'unreadable' };
    if (!data) return { state: 'missing' };
    return (data as { id?: unknown }).id === id ? { state: 'found', row: data as unknown as T } : { state: 'unreadable' };
  } catch {
    /* Lỗi mạng khi đọc lại: không kết luận được, nơi gọi coi là chưa rõ. */
    return { state: 'unreadable' };
  }
}

const isDeleted = (row: unknown) => {
  const value = row && typeof row === 'object' ? (row as { deleted_at?: unknown }).deleted_at : null;
  return typeof value === 'string' && value !== '';
};

export type ClientCreateOutcome<T> =
  | { row: T; replayed: boolean; deleted?: false }
  /** Mã này đã có nhưng bản ghi đã bị xoá (mềm): lần trước đã tạo rồi bị xoá. Nơi gọi tạo lại bằng mã mới nếu cần. */
  | { row: T; replayed: true; deleted: true };

const unknownOutcome = (operation: string, id: string, cause: unknown) => new FinancialWorkflowError(
  `Chưa xác nhận được kết quả ${operation}. Giữ nguyên thông tin rồi bấm lưu lại: máy gửi lại đúng mã này nên không tạo trùng.`,
  'unknown', [{ id, label: 'Mã bản ghi đang chờ xác nhận' }], cause,
);

/**
 * Chèn một dòng mang mã `id`. Kết quả:
 * - `{row, replayed:false}`: máy chủ trả dòng vừa chèn.
 * - `{row, replayed:true}`: dòng mang mã này đã có (lần gửi trước đã ghi), đọc đúng mã thấy nó; `deleted` nếu đã bị xoá.
 * - ném `FinancialAlreadyRecordedError`: mã đã có (23505) nhưng người này không đọc thấy dòng đó.
 * - ném `FinancialWorkflowError('unknown')`: chưa rõ kết quả và chưa đọc được. Gửi lại ĐÚNG mã này là an toàn.
 * - ném lỗi gốc: máy chủ từ chối rõ.
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
  if (error && !uniqueViolation && !hasUnconfirmedResponse(error)) throw error;
  // Không lỗi mà không có dòng, lỗi mạng, hay trùng mã: đọc đúng mã mới biết lần gửi đã ghi chưa.
  const read = await readRecordById<T>(table, id);
  if (read.state === 'found') return isDeleted(read.row) ? { row: read.row, replayed: true, deleted: true } : { row: read.row, replayed: true };
  if (uniqueViolation && read.state === 'missing') {
    throw new FinancialAlreadyRecordedError(`Mã ${id} đã có trên máy chủ (lần gửi trước đã ghi) nhưng bạn không xem được bản ghi đó. Nhờ quản lý kiểm tra; bấm lưu lại nếu vẫn muốn tạo thêm.`, [id]);
  }
  throw unknownOutcome(operation, id, error);
}

export interface CreateWithMemoryInput {
  table: ClientCreateTable;
  userId: string;
  organizationId: string;
  payload: Record<string, unknown>;
  /** Trường nhận dạng của bản ghi đang tạo, để so với dòng đọc lại và để chọn lại mã. */
  person: { name?: unknown; phone?: unknown; idNumber?: unknown };
  /** Đọc trường nhận dạng từ một dòng của bảng. */
  personOf: (row: Record<string, unknown>) => { name?: unknown; phone?: unknown; idNumber?: unknown };
  operation: string;
  /** Tên hiển thị trong câu báo khi lần trước đã ghi với thông tin khác. */
  describe: (row: Record<string, unknown>) => string;
  /** Câu thêm vào khi lần trước đã ghi với thông tin khác (ví dụ «xe chưa được lưu»). */
  alreadyNote?: string;
  /** Nơi gọi tự giữ mã cho từng bản ghi (nhập Excel theo dòng): dùng đúng mã này, không tra bộ nhớ. */
  clientId?: string;
}

export type CreateWithMemoryOutcome<T> = { row: T; replayed: boolean; clientId: string };

/**
 * Tạo một bản ghi; mã của lần gửi chưa biết chắc kết quả được nhớ (từ TRƯỚC khi gửi) để lần bấm sau của cùng người
 * gửi lại đúng mã. Dòng đọc lại mang thông tin khác người đang tạo (người dùng sửa giữa hai lần): không ghi gì thêm,
 * ném `FinancialAlreadyRecordedError` nêu mã bản ghi đã có; lần bấm sau là lượt mới. Dòng đã bị xoá: tạo lại bằng mã mới.
 */
export async function createWithClientMemory<T extends Row>(input: CreateWithMemoryInput): Promise<CreateWithMemoryOutcome<T>> {
  const matchKeys = memoryMatchKeys(input.person);
  const { table, userId, organizationId } = input;
  const choice = input.clientId ? { id: input.clientId, reused: false } : pickClientId(table, userId, organizationId, matchKeys);
  rememberUnconfirmed(table, userId, organizationId, { id: choice.id, matchKeys });
  let id = choice.id;
  let outcome: ClientCreateOutcome<T>;
  try {
    outcome = await insertWithClientId<T>(table, id, input.payload, input.operation);
    if (outcome.deleted) {
      // Lần trước đã tạo rồi bị xoá: bản ghi đó không còn dùng được. Lần bấm này là một lần tạo mới, mã mới.
      forgetUnconfirmed(table, userId, organizationId, id);
      id = crypto.randomUUID();
      rememberUnconfirmed(table, userId, organizationId, { id, matchKeys });
      outcome = await insertWithClientId<T>(table, id, input.payload, input.operation);
    }
  } catch (error) {
    // Máy chủ từ chối rõ một mã mới (chưa từng gửi trước đó) hoặc đã báo mã đã có: quên mã. Mã của lần gửi trước còn
    // chưa rõ thì giữ, vì lời từ chối của lần này không nói gì về lần trước.
    const settled = error instanceof FinancialAlreadyRecordedError || (!(error instanceof FinancialWorkflowError) && !hasUnconfirmedResponse(error) && !choice.reused);
    if (settled) forgetUnconfirmed(table, userId, organizationId, id);
    throw error;
  }
  forgetUnconfirmed(table, userId, organizationId, id);
  if (outcome.replayed && !input.clientId && !samePerson(input.personOf(outcome.row as unknown as Record<string, unknown>), input.person)) {
    throw new FinancialAlreadyRecordedError(
      `${input.describe(outcome.row as unknown as Record<string, unknown>)} đã được tạo ở lần gửi trước với thông tin lúc đó (mã ${outcome.row.id}). Mở bản ghi đó để kiểm tra và sửa nếu cần; bấm lưu lại nếu vẫn muốn tạo thêm.${input.alreadyNote ? ` ${input.alreadyNote}` : ''}`,
      [outcome.row.id],
    );
  }
  return { row: outcome.row, replayed: outcome.replayed, clientId: id };
}
