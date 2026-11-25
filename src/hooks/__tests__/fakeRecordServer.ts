// Máy chủ giả cho test đợt 4 (tạo khách, khách hẹn, loại thu chi, phiên bàn giao): giữ dòng theo bảng, chặn trùng
// mã như khoá chính, và giả được hai kiểu rớt mạng.
//   drop-before: lệnh không tới máy chủ (không ghi gì, trả lỗi mạng).
//   drop-after:  lệnh tới và đã ghi, nhưng phản hồi mất (trả lỗi mạng).
// Chỉ phủ đúng các chuỗi lời gọi PostgREST mà các hook trên dùng.

type Row = Record<string, unknown>;
type Failure = 'drop-before' | 'drop-after';
type Filter = (row: Row) => boolean;
type Result = { data: unknown; error: unknown };

export const NETWORK_ERROR = { message: 'TypeError: Failed to fetch', code: '' };

export interface FakeRecordServer {
  rows: Record<string, Row[]>;
  inserts: { table: string; payload: Row | Row[] }[];
  rpcCalls: { name: string; args: Row }[];
  /** Lần gọi kế tiếp của đúng loại thao tác trên bảng (hoặc RPC) sẽ hỏng theo kiểu đã chọn. */
  failNext: (target: string, op: 'insert' | 'read' | 'rpc', failure: Failure) => void;
  /** Bảng nào có thêm ràng buộc duy nhất (ngoài mã) thì khai khoá ở đây. */
  uniqueBy: Record<string, (row: Row) => string>;
  /** Giả RLS khi đọc: dòng nào trả false thì người đọc không thấy (vẫn chặn trùng khi chèn). */
  visible: Record<string, (row: Row) => boolean>;
  rpcHandlers: Record<string, (args: Row) => Result>;
  from: (table: string) => unknown;
  rpc: (name: string, args: Row) => Promise<Result>;
}

export function fakeRecordServer(): FakeRecordServer {
  const failures = new Map<string, Failure[]>();
  const takeFailure = (key: string): Failure | undefined => failures.get(key)?.shift();
  let seq = 0;
  const server: FakeRecordServer = {
    rows: {},
    inserts: [],
    rpcCalls: [],
    uniqueBy: {},
    visible: {},
    rpcHandlers: {},
    failNext: (target, op, failure) => {
      const key = `${target}:${op}`;
      failures.set(key, [...(failures.get(key) ?? []), failure]);
    },
    from: (table: string) => builder(table),
    rpc: async (name, args) => {
      server.rpcCalls.push({ name, args });
      const failure = takeFailure(`${name}:rpc`);
      if (failure === 'drop-before') return { data: null, error: NETWORK_ERROR };
      const handler = server.rpcHandlers[name];
      const result = handler ? handler(args) : { data: null, error: { code: 'PGRST202', message: 'no handler' } };
      return failure === 'drop-after' ? { data: null, error: NETWORK_ERROR } : result;
    },
  };
  const tableRows = (table: string) => (server.rows[table] ??= []);

  function insertRows(table: string, payload: Row | Row[]): Result {
    const list = Array.isArray(payload) ? payload : [payload];
    const existing = tableRows(table);
    const stored: Row[] = [];
    for (const raw of list) {
      const row: Row = { created_at: new Date().toISOString(), ...raw, id: raw.id ?? `${table}-gen-${++seq}` };
      if (existing.some(item => item.id === row.id)) {
        return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` } };
      }
      const unique = server.uniqueBy[table];
      if (unique && existing.some(item => unique(item) === unique(row))) {
        return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_org_side_normalized_name_uq"` } };
      }
      stored.push(row);
    }
    existing.push(...stored);
    return { data: stored, error: null };
  }

  function builder(table: string) {
    const filters: Filter[] = [];
    let mode: 'read' | 'insert' | 'update' = 'read';
    let payload: Row | Row[] | undefined;
    let limit: number | undefined;
    let order: { column: string; ascending: boolean } | undefined;
    const run = (shape: 'many' | 'single' | 'maybe'): Result => {
      if (mode === 'insert') {
        server.inserts.push({ table, payload: payload! });
        const failure = takeFailure(`${table}:insert`);
        if (failure === 'drop-before') return { data: null, error: NETWORK_ERROR };
        const result = insertRows(table, payload!);
        if (failure === 'drop-after') return { data: null, error: NETWORK_ERROR };
        if (result.error) return result;
        const stored = result.data as Row[];
        return { data: shape === 'many' ? stored : stored[0] ?? null, error: null };
      }
      if (mode === 'update') {
        const changed = tableRows(table).filter(row => filters.every(filter => filter(row)));
        for (const row of changed) Object.assign(row, payload);
        if (shape === 'many') return { data: changed, error: null };
        return changed.length === 1 ? { data: changed[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not single' } };
      }
      const failure = takeFailure(`${table}:read`);
      if (failure) return { data: null, error: NETWORK_ERROR };
      const visible = server.visible[table] ?? (() => true);
      let found = tableRows(table).filter(row => visible(row) && filters.every(filter => filter(row)));
      if (order) {
        const { column, ascending } = order;
        found = [...found].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
      }
      if (limit !== undefined) found = found.slice(0, limit);
      if (shape === 'many') return { data: found, error: null };
      if (shape === 'maybe') return { data: found[0] ?? null, error: null };
      return found.length === 1 ? { data: found[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not single' } };
    };
    const query = {
      insert: (value: Row | Row[]) => { mode = 'insert'; payload = value; return query; },
      update: (value: Row) => { mode = 'update'; payload = value; return query; },
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push(row => row[column] === value); return query; },
      neq: (column: string, value: unknown) => { filters.push(row => row[column] !== value); return query; },
      in: (column: string, values: unknown[]) => { filters.push(row => values.includes(row[column])); return query; },
      is: (column: string, value: unknown) => { filters.push(row => (row[column] ?? null) === value); return query; },
      gte: (column: string, value: string) => { filters.push(row => String(row[column]) >= value); return query; },
      lte: (column: string, value: string) => { filters.push(row => String(row[column]) <= value); return query; },
      order: (column: string, options?: { ascending?: boolean }) => { order = { column, ascending: options?.ascending ?? true }; return query; },
      limit: (count: number) => { limit = count; return query; },
      single: async () => run('single'),
      maybeSingle: async () => run('maybe'),
      then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(run('many')).then(resolve, reject),
    };
    return query;
  }
  return server;
}

/** Dấu «chờ đối chiếu» kiểu bản trước: một khoá chung cho mọi bản ghi mới, không có tên thao tác. */
export function seedLegacyPending(scope: { namespace: string; userId: string; organizationId: string; businessKey: string }, startedAt: Date, completedIds: string[] = []) {
  const key = 'ihome:financial-pending:v1:' + [scope.namespace, scope.userId, scope.organizationId, scope.businessKey].map(encodeURIComponent).join(':');
  const attempt = 'legacy-attempt';
  globalThis.localStorage.setItem(key, JSON.stringify({ ...scope, attemptId: attempt, requestKey: attempt, completedIds, startedAt: startedAt.toISOString() }));
  return key;
}

/** Mọi dấu «chờ đối chiếu» đang nằm trong trình duyệt. */
export function pendingKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < globalThis.localStorage.length; index += 1) {
    const key = globalThis.localStorage.key(index);
    if (key?.startsWith('ihome:financial-pending:v1:')) keys.push(key);
  }
  return keys;
}
