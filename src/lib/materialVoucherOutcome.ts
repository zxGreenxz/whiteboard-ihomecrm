import { FinancialAlreadyRecordedError, FinancialWorkflowError, RepeatableWriteUnknownError, isConfirmedFinancialRejection, workflowErrorMessage } from './financialWorkflow';

export function materialVoucherFailureMessage(error: unknown, operation: string): string {
  return workflowErrorMessage(error, operation);
}

/*
 * Đợt 9 (plan sửa khoá vĩnh viễn sau rớt mạng): TẠO phiếu nhập / phiếu kiểm kê / phiếu xuất tay không giữ dấu «chờ đối
 * chiếu» nữa (trước đây một khoá chung `create` mỗi loại: một lần rớt mạng chặn mọi lần tạo phiếu sau đó).
 *
 * Production (đọc 26/11/2026): ba bảng đầu phiếu và ba bảng dòng đều có `id uuid default gen_random_uuid()`; trigger
 * BEFORE INSERT (`set_user_id_from_auth`, `autofill_org_strict`, `set_material_*_code` md5 241cd2de / b3b7fcfe / 0f633053
 * chỉ sinh `code`) không đụng `new.id`; dòng → đầu phiếu `ON DELETE CASCADE`. Tồn kho, giá vốn bình quân, tổng phiếu do
 * trigger AFTER của bảng dòng TÍNH LẠI tuyệt đối từ mọi dòng (`material_items_after_change` 758f8023 →
 * `recompute_material_stock` 96f2f70c; `material_purchase_recompute_total` c1052928), nên tồn chỉ đổi khi có DÒNG.
 *
 * Nên: đầu phiếu mang mã do trình duyệt sinh (`createRecordOnce`), các dòng cũng mang mã do trình duyệt sinh và được nhớ
 * theo đầu phiếu (theo tab). Lần bấm lại dùng lại ĐÚNG phiếu và ĐÚNG các mã dòng: lệnh chèn một lần nhiều dòng là nguyên
 * tử, khoá chính chặn bộ dòng thứ hai kể cả khi lệnh cũ tới máy chủ trễ. Đầu phiếu đã có thì đọc dòng của nó: đủ ⇒ xong
 * (không gửi gì thêm); chưa có dòng ⇒ chèn dòng; khác bản đang nhập ⇒ báo mã phiếu, không chèn chồng.
 */
type VoucherRow = Record<string, unknown>;
interface LooseQuery extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns?: string): LooseQuery;
  insert(values: unknown): LooseQuery;
  delete(): LooseQuery;
  eq(column: string, value: unknown): LooseQuery;
  single(): PromiseLike<{ data: unknown; error: unknown }>;
}

/** Mã dòng do trình duyệt sinh của từng đầu phiếu còn chờ xác nhận dòng (theo tab, không ghi vào trình duyệt). */
const pendingLineIds = new Map<string, string[]>();
function lineIdsFor(lineTable: string, headerId: string, count: number): string[] {
  const key = `${lineTable}|${headerId}`;
  const ids = pendingLineIds.get(key) ?? [];
  while (ids.length < count) ids.push(crypto.randomUUID());
  pendingLineIds.set(key, ids);
  return ids.slice(0, count);
}

const comparable = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '';
  const asNumber = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(asNumber) ? String(asNumber) : String(value);
};
const lineSignature = (rows: ReadonlyArray<VoucherRow>, compare: readonly string[]) =>
  JSON.stringify(rows.map(row => compare.map(column => comparable(row[column]))).map(cells => JSON.stringify(cells)).sort());

/** Đầu phiếu đọc lại có cùng các trường người dùng nhập với đầu phiếu đang tạo không (rỗng / null như nhau, số theo giá trị). */
export function sameVoucherHeader(row: VoucherRow, payload: VoucherRow, fields: readonly string[]): boolean {
  return fields.every(field => comparable(row[field]) === comparable(payload[field]));
}

/**
 * Khoá nhận ra «cùng phiếu đang tạo» giữa hai lần bấm trong tab: mã bản nháp của form (sửa nội dung giữa hai lần bấm vẫn
 * là cùng phiếu) và chữ ký nội dung (mở lại form với đúng nội dung vẫn nhận ra lần gửi trước).
 */
export function materialVoucherMatchKeys(draft: string | undefined, header: readonly unknown[], items: ReadonlyArray<VoucherRow>, compare: readonly string[]): string[] {
  const signature = `s:${JSON.stringify([header.map(comparable), lineSignature(items, compare)])}`;
  return draft ? [`d:${draft}`, signature] : [signature];
}

/*
 * Đợt 10b (plan sửa khoá vĩnh viễn sau rớt mạng): SỬA phiếu nhập và lưu vật tư của công việc gọi MỘT hàm máy chủ thay nguyên
 * tử đầu phiếu + cả bộ dòng (`replace_material_purchase_v1`, `save_job_material_usage_v1`; SECURITY INVOKER nên RLS và trigger
 * như ghi thẳng; một giao dịch: hoặc chưa ghi gì, hoặc đã ghi đủ; tồn kho, giá vốn, tổng phiếu do trigger tính lại từ mọi dòng).
 * Không còn lúc phiếu không có dòng nào giữa hai lệnh. Ba hàm dưới đây dùng chung cho hai nơi gọi đó.
 */

/** Biên nhận lệch / sai dạng của hàm nguyên tử: chưa rõ (`repeatableWrite` biến thành bấm lại được), không bao giờ là đã lưu. */
const replaceMismatch = (part: string) => new FinancialWorkflowError(`Biên nhận ${part} chưa khớp đúng nội dung đã gửi.`, 'unknown', [], new TypeError('Mismatched atomic material receipt'));
const sameDate = (a: unknown, b: unknown) => String(a ?? '').slice(0, 10) === String(b ?? '').slice(0, 10);

/**
 * Đầu phiếu trong biên nhận phải đúng mã và đúng các trường đã gửi (rỗng / null như nhau, số theo giá trị, ngày so theo
 * ngày). Trả lại đầu phiếu đó.
 */
export function confirmReplacedHeader(value: unknown, id: string, sent: VoucherRow, fields: readonly string[]): VoucherRow {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as VoucherRow : null;
  if (!row || row.id !== id || !fields.every(field => field.endsWith('_date') ? sameDate(row[field], sent[field]) : comparable(row[field]) === comparable(sent[field]))) throw replaceMismatch('đầu phiếu vật tư');
  return row;
}

/**
 * Các dòng trong biên nhận phải khớp ĐÚNG bộ đã gửi: đúng số dòng, mã dòng là chuỗi không trùng, đúng mã phiếu, đa tập giá
 * trị theo các cột đã gửi (số so theo giá trị). Trả mã các dòng đã ghi.
 */
export function confirmReplacedMaterialLines(value: unknown, parentColumn: 'purchase_id' | 'usage_id', parentId: string, items: ReadonlyArray<VoucherRow>, compare: readonly string[]): string[] {
  const rows: unknown[] = Array.isArray(value) ? value : [];
  const ids = rows.map(row => row && typeof row === 'object' ? (row as VoucherRow).id : undefined);
  const exact = Array.isArray(value) && rows.length === items.length
    && ids.every(id => typeof id === 'string' && id !== '') && new Set(ids).size === ids.length
    && rows.every(row => (row as VoucherRow)[parentColumn] === parentId && typeof (row as VoucherRow).material_id === 'string')
    && lineSignature(rows as VoucherRow[], compare) === lineSignature(items, compare);
  if (!exact) throw replaceMismatch('các dòng vật tư');
  return ids as string[];
}

/**
 * Lời từ chối do chính hàm máy chủ viết (tiếng Việt, không lộ SQL: P0002 không thấy / không có quyền sửa, 42501 «Chưa …») ⇒
 * giữ câu đó cho màn hình (`failure`). Lỗi khác đi nguyên (câu báo do `workflowErrorMessage` / `friendlyError` dựng).
 */
export function materialServerRefusal(error: unknown): unknown {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return typeof message === 'string' && message !== '' && (code === 'P0002' || (code === '42501' && message.startsWith('Chưa ')))
    ? new FinancialWorkflowError(message, 'failure', [], error) : error;
}

/** Kết quả chưa rõ của một lần thay nguyên tử: thay câu dặn mặc định bằng câu nói rõ máy chủ thay cả bộ trong MỘT lần. */
export function materialReplaceUnknown(error: unknown, operation: string, advice: string): unknown {
  return error instanceof RepeatableWriteUnknownError ? new RepeatableWriteUnknownError(operation, error.cause, error.completed, advice) : error;
}

export interface MaterialVoucherCreate {
  headerTable: 'material_purchases' | 'material_adjustments' | 'material_usages';
  lineTable: 'material_purchase_items' | 'material_adjustment_items' | 'material_usage_items';
  parentColumn: 'purchase_id' | 'adjustment_id' | 'usage_id';
  /** «Phiếu nhập», «Phiếu kiểm kê», «Phiếu xuất». */
  noun: string;
  operation: string;
  userId: string;
  organizationId: string;
  matchKeys: readonly string[];
  /** Đầu phiếu gửi đi, đã bọc `withOrg(...)` ở nơi gọi; không chứa `id`. */
  headerPayload: VoucherRow;
  sameHeader: (row: VoucherRow) => boolean;
  /** Các dòng đang nhập, để so với dòng đã có trên máy chủ theo các cột `compare`. */
  items: ReadonlyArray<VoucherRow>;
  compare: readonly string[];
  /** Dựng các dòng gửi đi từ đầu phiếu đã có trên máy chủ, đã bọc `withOrgAll(...)` theo công ty của đầu phiếu; chưa có `id`. */
  buildLines: (header: VoucherRow) => VoucherRow[];
}

export interface MaterialVoucherCreated<T> {
  header: T;
  /** Lần bấm TRƯỚC (còn chưa rõ) đã ghi trọn phiếu này; lần này không ghi gì thêm. */
  replayed: boolean;
  /**
   * Các dòng không được xác nhận bằng biên nhận của chính lệnh chèn lần này mà bằng lần đọc lại (đã có từ lần bấm trước,
   * lệnh cũ tới trễ, hoặc phản hồi của lần này mất). Nơi gọi tính trên tồn đọc TRƯỚC đó (đặt tồn) phải đọc lại tồn.
   */
  linesFromRead: boolean;
}

const voucherLabel = (noun: string, row: VoucherRow, lower = false) => {
  const code = typeof row.code === 'string' && row.code ? ` ${row.code}` : '';
  return `${lower ? noun.toLowerCase() : noun}${code}`;
};

/**
 * Tạo một phiếu vật tư (đầu phiếu + dòng) bằng mã do trình duyệt sinh, không giữ dấu. Kết quả:
 * - trả phiếu: đã ghi trọn (lần này, hoặc lần bấm trước — `replayed`).
 * - ném `FinancialAlreadyRecordedError`: lần bấm trước đã tạo phiếu này với nội dung khác bản đang nhập; câu báo nêu mã,
 *   lần bấm sau là lượt mới.
 * - ném `RepeatableWriteUnknownError`: đầu phiếu đã có nhưng chưa xác nhận được các dòng; bấm lại dùng lại đúng phiếu và
 *   đúng các mã dòng.
 * - ném `FinancialWorkflowError('failure')`: máy chủ từ chối rõ các dòng; phiếu tạm được gỡ nếu gỡ được.
 * - lỗi của bước tạo đầu phiếu đi nguyên (`createRecordOnce`); nơi gọi bọc `repeatableWrite`.
 */
export async function createMaterialVoucherOnce<T extends { id: string }>(input: MaterialVoucherCreate): Promise<MaterialVoucherCreated<T>> {
  const memory = await import('@/lib/clientRecordCreate');
  const { supabase } = await import('@/integrations/supabase/client');
  const db = supabase as unknown as { from: (table: string) => LooseQuery };
  const { headerTable, lineTable, userId, organizationId } = input;
  // Có lần bấm trước còn chưa rõ của cùng phiếu không: chỉ khi đó «đã có trên máy chủ» mới là do lần bấm trước ghi.
  const prior = memory.pickClientId(headerTable, userId, organizationId, input.matchKeys).reused;
  // Đầu phiếu của lần bấm trước mang thông tin khác bản đang nhập: giữ lại dòng đó để câu báo nói được phiếu đó có dòng chưa.
  const earlier: { row?: VoucherRow } = {};
  let created: { row: T; replayed: boolean };
  try {
    created = await memory.createRecordOnce<T>({
      table: headerTable, userId, organizationId, matchKeys: input.matchKeys, payload: input.headerPayload, operation: input.operation,
      sameAs: row => { const same = input.sameHeader(row); earlier.row = same ? undefined : row; return same; },
      describe: row => voucherLabel(input.noun, row),
    });
  } catch (error) {
    if (error instanceof FinancialAlreadyRecordedError && earlier.row) throw await explainEarlierHeader(error, earlier.row);
    throw error;
  }
  const { row: header, replayed: headerReplayed } = created;
  if (!input.items.length) return { header, replayed: prior && headerReplayed, linesFromRead: false };
  const headerRow = header as unknown as VoucherRow;
  const id = header.id;
  const name = voucherLabel(input.noun, headerRow);
  // Đầu phiếu đã có trên máy chủ: nhớ lại mã tới khi các dòng được xác nhận, để lần bấm sau dùng lại ĐÚNG phiếu này.
  memory.rememberUnconfirmed(headerTable, userId, organizationId, { id, matchKeys: [...input.matchKeys] });
  const settle = () => { memory.forgetUnconfirmed(headerTable, userId, organizationId, id); pendingLineIds.delete(`${lineTable}|${id}`); };
  const unknown = (cause: unknown) => new RepeatableWriteUnknownError(
    `lưu các dòng vật tư của ${voucherLabel(input.noun, headerRow, true)}`, cause,
    [{ id, label: `${name} đã tạo, các dòng vật tư chưa xác nhận` }],
    `Bấm lại: máy dùng lại đúng phiếu này (mã ${id}) và đúng các mã dòng đã gửi, nên không tạo phiếu thứ hai và không cộng tồn hai lần.`,
  );
  const readLines = async (): Promise<VoucherRow[]> => {
    let reply: { data: unknown; error: unknown };
    try { reply = await db.from(lineTable).select(['id', ...input.compare].join(', ')).eq(input.parentColumn, id); }
    catch (error) { throw unknown(error); }
    // Đọc hỏng ⇒ chưa kết luận được (không coi là «chưa có dòng»).
    if (reply.error || !Array.isArray(reply.data)) throw unknown(reply.error);
    return reply.data as VoucherRow[];
  };
  const differs = () => {
    settle();
    return new FinancialAlreadyRecordedError(`${name} đã được tạo ở lần bấm trước với các dòng vật tư khác bản đang nhập (mã ${id}). Mở phiếu đó để kiểm tra và sửa; bấm lưu lại nếu vẫn muốn tạo phiếu mới.`, [id]);
  };
  const same = (rows: VoucherRow[]) => lineSignature(rows, input.compare) === lineSignature(input.items, input.compare);

  if (headerReplayed) {
    // Đầu phiếu đã có từ trước lần gửi này: đọc dòng của nó TRƯỚC khi chèn gì.
    const existing = await readLines();
    if (existing.length) {
      if (!same(existing)) throw differs();
      settle();
      return { header, replayed: prior, linesFromRead: true };
    }
  }
  const lineIds = lineIdsFor(lineTable, id, input.items.length);
  const rows = input.buildLines(headerRow).map((row, index) => ({ ...row, id: lineIds[index] }));
  let reply: { data: unknown; error: unknown };
  try { reply = await db.from(lineTable).insert(rows).select('id'); }
  catch (error) { reply = { data: null, error }; }
  // Dòng mang mã do trình duyệt sinh: biên nhận phải trả ĐÚNG các mã đã gửi (không lạ, không thiếu, không thừa) mới là xong;
  // lệch thì đọc lại dòng của phiếu để kết luận (bên dưới).
  const receipt = Array.isArray(reply.data) ? reply.data.map(row => (row as VoucherRow | null)?.id) : [];
  const exactReceipt = receipt.length === lineIds.length && new Set(receipt).size === lineIds.length && lineIds.every(lineId => receipt.includes(lineId));
  if (!reply.error && exactReceipt) { settle(); return { header, replayed: false, linesFromRead: false }; }
  const failure = reply.error;
  const duplicateLine = !!failure && typeof failure === 'object' && String((failure as { code?: unknown }).code ?? '') === '23505';
  if (failure && !duplicateLine && isConfirmedFinancialRejection(failure)) {
    // Máy chủ từ chối rõ các dòng (không dòng nào được ghi): gỡ đầu phiếu rỗng vừa tạo.
    let removed = false;
    try {
      const { data, error } = await db.from(headerTable).delete().eq('id', id).select('id').single();
      removed = !error && (data as VoucherRow | null)?.id === id;
    } catch { /* Gỡ hỏng: phiếu rỗng còn lại; lần bấm sau dùng lại đúng phiếu này. */ }
    if (removed) {
      settle();
      throw new FinancialWorkflowError('Dòng vật tư bị từ chối; phiếu tạm đã gỡ. Giữ bản nháp, kiểm tra lỗi trước khi thử lại.', 'failure', [], failure);
    }
    throw new FinancialWorkflowError(`Dòng vật tư bị từ chối; chưa gỡ được ${voucherLabel(input.noun, headerRow, true)} tạm (mã ${id}) nên phiếu đó đang chưa có dòng vật tư nào (không làm đổi tồn kho). Sửa lại rồi bấm lưu: máy ghi các dòng vào đúng phiếu này.`, 'failure', [], failure);
  }
  // Mất phản hồi, biên nhận sai dạng, hay trùng mã dòng (lệnh cũ mang đúng các mã này đã ghi): đọc lại dòng của phiếu.
  const existing = await readLines();
  if (!existing.length) throw unknown(failure);
  if (!same(existing)) throw differs();
  settle();
  return { header, replayed: prior && duplicateLine, linesFromRead: true };

  /**
   * Lần bấm trước đã tạo đầu phiếu với thông tin khác (người dùng sửa ngày / nhà cung cấp / ghi chú / chiều kiểm kê giữa hai
   * lần bấm). Không điền dòng vào phiếu đó: phải đổi đầu phiếu của nó, mà dòng của lần trước có thể còn đang tới máy chủ
   * (với phiếu kiểm kê, đổi chiều IN/OUT sẽ đảo dấu phần tồn của các dòng đó). Chỉ nói rõ phiếu đó đã có dòng chưa, để
   * phiếu rỗng không sót lại im lặng. Đọc hỏng ⇒ giữ câu báo gốc (vẫn nêu mã phiếu).
   */
  async function explainEarlierHeader(error: FinancialAlreadyRecordedError, row: VoucherRow): Promise<FinancialAlreadyRecordedError> {
    const earlierId = typeof row.id === 'string' ? row.id : '';
    if (!earlierId) return error;
    let lines: unknown;
    try { const reply = await db.from(lineTable).select('id').eq(input.parentColumn, earlierId); lines = reply.error ? undefined : reply.data; }
    catch { /* Đọc hỏng: giữ câu báo gốc. */ }
    if (!Array.isArray(lines) || lines.length) return error;
    return new FinancialAlreadyRecordedError(`${voucherLabel(input.noun, row)} (mã ${earlierId}) đã được tạo ở lần bấm trước với thông tin đầu phiếu khác bản đang nhập và hiện CHƯA có dòng vật tư nào (không làm đổi tồn kho). Mở phiếu đó để sửa hoặc xoá; bấm lưu lại nếu vẫn muốn tạo phiếu mới.`, [earlierId]);
  }
}
