import { FinancialAlreadyRecordedError, FinancialWorkflowError, RepeatableWriteUnknownError, isConfirmedFinancialRejection, workflowErrorMessage } from './financialWorkflow';

export function confirmedMaterialVoucherId(value: unknown, expectedId?: string): string {
  const id = value && typeof value === 'object' ? (value as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || !id || (expectedId && id !== expectedId)) {
    throw new FinancialWorkflowError('Chưa xác nhận được ID phiếu vật tư. Giữ dữ liệu đang nhập và đối chiếu danh sách phiếu, tồn kho trước khi thực hiện tiếp.', 'unknown', []);
  }
  return id;
}

export function confirmMaterialVoucherLines(value: unknown, expectedIds: readonly string[]): void {
  const ids = Array.isArray(value) ? value.map(row => row && typeof row === 'object' ? (row as Record<string, unknown>).id : undefined) : [];
  if (!Array.isArray(value) || ids.length !== expectedIds.length || new Set(ids).size !== ids.length || expectedIds.some(id => !ids.includes(id))) {
    throw new Error('Chưa xác nhận đủ các dòng vật tư đã lưu.');
  }
}

export function materialVoucherFailureMessage(error: unknown, operation: string): string {
  return workflowErrorMessage(error, operation);
}
/** Kết quả chưa rõ thì khoá form, TRỪ thao tác lặp lại được (đợt 8): lỗi đó báo rõ và cho bấm lại. */
export function materialVoucherRetryBlocked(error: unknown): boolean {
  return error instanceof FinancialWorkflowError && !(error instanceof RepeatableWriteUnknownError) && error.outcome !== 'failure';
}

/**
 * Đợt 8: lưu vật tư của công việc và sửa phiếu nhập «xoá rồi chèn lại» toàn bộ dòng (chưa nguyên tử; hàm máy chủ ở đợt
 * 10). Hỏng giữa chừng thì phiếu có thể đang không còn dòng nào và tồn kho (trigger tính lại từ mọi dòng đang có) tạm tính
 * như vậy: câu báo nói rõ điều đó. Cả hai kết quả không khoá form: lần lưu lại xoá rồi ghi lại đúng bộ dòng đang nhập nên
 * không nhân đôi dòng, tồn kho tính lại theo đúng bộ dòng đó.
 *
 * `done`: việc ĐÃ CHẮC làm trên máy chủ trước bước hỏng («Đã xoá các dòng cũ của phiếu nhập») khi bước hỏng là ghi dòng
 * mới; `null` khi chính lệnh xoá dòng cũ hỏng — từ chối rõ ở bước đó nghĩa là chưa xoá gì nên trả nguyên lỗi.
 * Máy chủ từ chối rõ ⇒ `failure`; chưa rõ ⇒ `RepeatableWriteUnknownError`.
 */
export function materialLinesRewriteError(done: string | null, button: string, error: unknown): unknown {
  if (isConfirmedFinancialRejection(error)) {
    if (done === null) return error;
    return new FinancialWorkflowError(`${done} nhưng máy chủ từ chối ghi các dòng vật tư mới; phiếu đang chưa có dòng vật tư nào và tồn kho đang tính như vậy. ${workflowErrorMessage(error, 'ghi các dòng vật tư mới')} Sửa lại rồi bấm «${button}».`, 'failure', [], error);
  }
  const unknown = new RepeatableWriteUnknownError(done === null ? 'xoá các dòng vật tư cũ' : 'ghi các dòng vật tư mới', error);
  const state = done === null ? 'Chưa xác nhận được kết quả xoá các dòng vật tư cũ' : `${done} nhưng chưa xác nhận được đã ghi các dòng vật tư mới`;
  unknown.message = `${state}; phiếu có thể đang chưa có dòng vật tư nào và tồn kho tạm tính như vậy. Bấm «${button}» lại: lần lưu lại xoá rồi ghi lại đúng bộ dòng đang nhập nên không nhân đôi dòng, tồn kho tính lại theo đúng bộ dòng đó.`;
  return unknown;
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

export function readMaterialVoucherLines(value: unknown): Array<{ id: string; material_id: string }> {
  const failure = () => new Error('Chưa xác nhận được các dòng vật tư hiện tại. Tải lại phiếu trước khi sửa.');
  if (!Array.isArray(value)) throw failure();
  const ids = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== 'object') throw failure();
    const record = row as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id || ids.has(record.id) || typeof record.material_id !== 'string' || !record.material_id) throw failure();
    ids.add(record.id);
    return { id: record.id, material_id: record.material_id };
  });
}
