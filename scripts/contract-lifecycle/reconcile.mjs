// Explicit, read-only TEST reconciliation. Import has no I/O.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateTestTarget, catalogHash } from './preflight.mjs';
import { loadTestCredentials, loadTestCredentialsFromVault, withTestTransaction, createTestHttp, selectAll } from './transport.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PAGE = 1000;
const MAX = 100000;
const ALLOWED = new Set(['expectedRef', 'url', 'organizationId', 'month']);

function status(code, reason, details = {}) { return { status: code, reason, ...details }; }
function exactObject(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
export function validateReconcileScope(value, credentialRef) {
  if (!exactObject(value) || Object.keys(value).some(k => !ALLOWED.has(k))) throw new Error('Invalid TEST scope fields.');
  validateTestTarget(value);
  if (value.expectedRef !== credentialRef) throw new Error('TEST scope and credential project refs differ.');
  if (!UUID.test(value.organizationId ?? '')) throw new Error('Explicit TEST organization UUID required.');
  if (value.month !== undefined && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) || Number(value.month.slice(0, 4)) < 1900)) throw new Error('Invalid TEST month.');
  return value;
}

export function parseTestArgs(args) {
  if (args[0] !== '--test-scope') throw new Error('TEST scope must be the first option.');
  const found = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--test-scope', '--ca-file', '--use-vault'].includes(key) || Object.hasOwn(found, key)) throw new Error('Unknown or duplicate TEST option.');
    if (key === '--use-vault') found[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing TEST option value.');
      found[key] = args[++i];
    }
  }
  if (!found['--test-scope'] || !found['--ca-file']) throw new Error('TEST scope and CA file are required.');
  return found;
}

// Decimal arithmetic never converts money to IEEE-754 numbers or rounds a difference away.
function decimal(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isSafeInteger(value))) throw new Error('Unsafe TEST money number.');
  const s = String(value);
  if (!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(s)) throw new Error('Unsafe TEST money value.');
  const [whole, fraction = ''] = s.split('.');
  return BigInt(whole.startsWith('-') ? '-1' : '1') * (BigInt(whole.replace('-', '')) * 1000000n + BigInt(fraction.padEnd(6, '0') || '0'));
}
function money(rows, field) { return rows.reduce((sum, row) => sum + decimal(row?.[field]), 0n); }
function decimalText(scaled) {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const fraction = String(absolute % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / 1000000n}${fraction ? `.${fraction}` : ''}`;
}
function digest(rows) { return catalogHash([...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))); }
function ids(rows) { return [...rows].map(r => r?.id).sort(); }
function validIds(rows) {
  if (!Array.isArray(rows) || rows.length > MAX || rows.some(r => typeof r?.id !== 'string' || !r.id)) return false;
  const all = ids(rows);
  if (all.some((id, i) => i && id === all[i - 1])) return false;
  return true;
}
function validRows(rows, field) {
  if (!validIds(rows)) return false;
  try { money(rows, field); } catch { return false; }
  return true;
}
function sameIds(a, b) { return JSON.stringify(ids(a)) === JSON.stringify(ids(b)); }
function rpcMoney(rpc) {
  if (!Array.isArray(rpc) || rpc.length !== 1) return null;
  try { return ['cash_income', 'internal_income', 'pending_income'].reduce((sum, key) => sum + decimal(rpc[0]?.[key]), 0n); } catch { return null; }
}

export function compareV1({ before, after, rest, rpc, pages, truth } = {}) {
  if (![before, after, rest].every(rows => validRows(rows, 'total_amount')) || !Number.isSafeInteger(pages) || pages < 0) return status(2, 'invalid_source');
  if (!before.length) return status(3, 'missing_source');
  const a = money(before, 'total_amount');
  const c = money(rest, 'total_amount');
  const afterSum = money(after, 'total_amount');
  let truthMismatch = false;
  try { truthMismatch = !truth || truth.count !== before.length || decimal(truth.sum) !== a; }
  catch { return status(2, 'unsafe_truth'); }
  if (truthMismatch || a !== c || a !== afterSum || !sameIds(before, rest) || digest(before) !== digest(after)) return status(1, 'source_mismatch');
  const b = rpcMoney(rpc);
  if (b === null) return status(3, 'rpc_missing');
  if (a !== b) return status(1, 'rpc_mismatch');
  if (before.length <= PAGE || rest.length <= PAGE || pages <= 1) return status(3, 'http_cap_unproven');
  return status(0, 'pass', { count: before.length, pages, sourceDigest: digest(before) });
}

export function compareV2({ accounts, legacy, v2, truth, postings } = {}) {
  if (![accounts, legacy, v2, postings].every(Array.isArray) || !truth || !Number.isSafeInteger(truth.count) || truth.count < 0) return status(2, 'invalid_source');
  if (!validIds(accounts) || !validRows(legacy, 'current_amount') || !validRows(v2, 'current_amount')) return status(2, 'invalid_account');
  if (!accounts.length || !legacy.length || !v2.length) return status(3, 'missing_source');
  if (!sameIds(accounts, legacy) || !sameIds(accounts, v2)) return status(3, 'missing_view_counterpart');
  const l = new Map(legacy.map(r => [r.id, r]));
  const v = new Map(v2.map(r => [r.id, r]));
  try {
    if (accounts.some(a => decimal(l.get(a.id).current_amount) !== decimal(v.get(a.id).current_amount))) return status(1, 'balance_mismatch');
    if (!validRows(postings, 'signed_amount')) return status(2, 'invalid_posting');
    if (!postings.length) return truth.count !== 0 || decimal(truth.sum) !== 0n ? status(1, 'posting_mismatch') : status(3, 'postings_missing');
    const idDigest = createHash('md5').update(ids(postings).join(',')).digest('hex');
    if (truth.count !== postings.length || decimal(truth.sum) !== money(postings, 'signed_amount') ||
        !/^[a-f0-9]{32}$/.test(truth.idDigest ?? '') || truth.idDigest !== idDigest) return status(1, 'posting_mismatch');
  } catch { return status(2, 'unsafe_money'); }
  if (postings.length <= PAGE) return status(3, 'sql_page_threshold_unproven');
  return status(0, 'pass', { accounts: accounts.length, postings: postings.length, postingDigest: digest(postings) });
}

export async function readSqlPages(fetchPage, { pageSize = PAGE, maxRows = MAX, allowEmpty = false } = {}) {
  if (typeof fetchPage !== 'function' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE) throw new Error('Invalid SQL page reader.');
  const rows = [];
  let count;
  do {
    const page = await fetchPage(rows.length, pageSize);
    if (!Array.isArray(page?.rows) || !Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || page.totalCount > maxRows || (count !== undefined && count !== page.totalCount)) throw new Error('Invalid SQL page/count.');
    count = page.totalCount;
    if (page.rows.length !== Math.min(pageSize, count - rows.length)) throw new Error('Truncated SQL page.');
    rows.push(...page.rows);
  } while (rows.length < count);
  if (!rows.length && !allowEmpty) throw new Error('Missing SQL baseline rows.');
  const keys = rows.map(r => r?.id);
  if (keys.some((id, i) => typeof id !== 'string' || (i && id <= keys[i - 1]))) throw new Error('SQL pages have duplicate/unordered IDs.');
  return rows;
}

async function queryOne(ctx, sql, values = []) {
  const result = await ctx.query(sql, values);
  if (result.rows?.length !== 1) throw new Error('Required TEST SQL result missing.');
  return result.rows[0];
}
async function paged(ctx, tableSql, values, columns, orderSql = 'id') {
  const { c } = await queryOne(ctx, `SELECT count(*)::int AS c ${tableSql}`, values);
  const count = Number(c);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX) throw new Error('Invalid TEST SQL count.');
  return readSqlPages(async (offset, limit) => ({
    rows: (await ctx.query(`SELECT ${columns} ${tableSql} ORDER BY ${orderSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset])).rows,
    totalCount: count,
  }), { allowEmpty: true });
}
function windowFor(month) {
  if (!month) return { start: '1900-01-01', end: '9999-12-31' };
  const [year, m] = month.split('-').map(Number);
  return { start: `${month}-01`, end: `${month}-${String(new Date(Date.UTC(year, m, 0)).getUTCDate()).padStart(2, '0')}` };
}
const V1_FROM = `FROM public.income_expenses WHERE organization_id = $1 AND type = 'INCOME' AND approval_status = 'APPROVED' AND deleted_at IS NULL AND voucher_date BETWEEN $2 AND $3`;
const V1_COLUMNS = 'id::text AS id, organization_id::text AS organization_id, building_id::text AS building_id, account_id::text AS account_id, room_id::text AS room_id, voucher_date::text AS voucher_date, approval_status, deleted_at::text AS deleted_at, total_amount::text AS total_amount';
export async function v1Sql(ctx, scope, win) {
  const values = [scope.organizationId, win.start, win.end];
  const truth = await queryOne(ctx, `SELECT count(*)::int AS count, COALESCE(sum(total_amount),0)::text AS sum ${V1_FROM}`, values);
  const before = await paged(ctx, V1_FROM, values, V1_COLUMNS);
  return { before, truth: { count: Number(truth.count), sum: truth.sum } };
}

export async function runV1(config, scope, actor, apiKey, {
  transaction = withTestTransaction, sqlReader = v1Sql, createHttp = createTestHttp, selectRows = selectAll,
} = {}) {
  const win = windowFor(scope.month);
  const first = await transaction(config, { readOnly: true, run: async ctx => {
    let phase = 'organization';
    try {
    const org = await ctx.query('SELECT id FROM public.organizations WHERE id = $1', [scope.organizationId]);
    if (org.rows?.length !== 1) return status(3, 'organization_missing');
    phase = 'sql';
    const { before, truth } = await sqlReader(ctx, scope, win);
    if (!before.length) return status(3, 'vouchers_missing');
    const http = createHttp(config, { verified: ctx, apiKey });
    phase = 'auth';
    const jwt = await http.signIn(actor);
    const rpc = [];
    // The existing invoker accepts UUID[]; each chunk is scoped by independently queried SQL IDs.
    for (let i = 0; i < before.length; i += 500) {
      phase = 'rpc';
      const part = await http.rpc('get_income_expense_layer_stats', {
        p_type: 'INCOME', p_approval: 'APPROVED', p_start_date: win.start, p_end_date: win.end,
        p_voucher_ids: before.slice(i, i + 500).map(r => r.id),
      }, { token: jwt });
      if (!Array.isArray(part) || part.length !== 1) return status(3, 'rpc_missing');
      rpc.push(part[0]);
    }
    const filtered = `&organization_id=eq.${scope.organizationId}&type=eq.INCOME&approval_status=eq.APPROVED&deleted_at=is.null&voucher_date=gte.${win.start}&voucher_date=lte.${win.end}`;
    phase = 'rest';
    const rest = await selectRows(http, { table: 'income_expenses', columns: 'id,organization_id,building_id,account_id,room_id,voucher_date,approval_status,deleted_at,total_amount', filters: filtered, token: jwt, allowEmpty: true });
    const pages = Math.ceil(rest.length / PAGE);
    const combined = { cash_income: '0', internal_income: '0', pending_income: '0' };
    // BigInt result is rendered as decimal string before comparator parses it.
    for (const key of Object.keys(combined)) combined[key] = decimalText(rpc.reduce((sum, r) => sum + decimal(r[key]), 0n));
    return { before, truth, rest, rpc: [combined], pages };
    } catch (error) {
      const http = /^TEST HTTP (\d{3}) ([A-Z0-9_]+)$/.exec(error?.message ?? '');
      const catalog = /^Catalog income_expenses: ([a-z, ]+)\.$/.exec(error?.message ?? '');
      const known = ['Invalid TEST SELECT specification.', 'Invalid TEST SELECT page.', 'TEST HTTP invalid JSON response.', 'TEST HTTP transport failed.'];
      return status(2, `v1_${phase}_error`, { ...(http ? { httpStatus: Number(http[1]), httpCode: http[2] } : {}), ...(catalog ? { catalogCode: catalog[1].replaceAll(' ', '_') } : {}), ...(known.includes(error?.message) ? { detail: error.message } : {}) });
    }
  }});
  if (first.status) return first;
  const fresh = await transaction(config, { readOnly: true, run: async ctx => (await sqlReader(ctx, scope, win)).before });
  return compareV1({ ...first, after: fresh });
}

const POST_FROM = `FROM public.income_expense_posting_lines pl JOIN public.income_expense_postings p ON p.id = pl.posting_id AND p.organization_id = pl.organization_id JOIN public.accounts a ON a.id = pl.account_id AND a.organization_id = pl.organization_id LEFT JOIN public.income_expenses v ON v.id = p.voucher_id AND v.organization_id = p.organization_id WHERE pl.organization_id = $1 AND p.event_kind IN ('POSTING','REVERSAL') AND (p.voucher_id IS NULL OR v.id IS NOT NULL) AND p.posted_on BETWEEN $2 AND $3`;
async function runV2(config, scope) {
  return withTestTransaction(config, { readOnly: true, run: async ctx => {
    const gate = await queryOne(ctx, `SELECT to_regclass('public.accounts_with_balance') IS NOT NULL AS legacy, to_regclass('public.accounts_with_balance_v2') IS NOT NULL AS v2, to_regclass('public.income_expense_posting_lines') IS NOT NULL AS lines, to_regclass('public.income_expense_postings') IS NOT NULL AS postings`);
    if (!Object.values(gate).every(Boolean)) return status(3, 'schema_missing');
    const org = await ctx.query('SELECT id FROM public.organizations WHERE id = $1', [scope.organizationId]);
    if (org.rows?.length !== 1) return status(3, 'organization_missing');
    const accounts = await paged(ctx, 'FROM public.accounts WHERE organization_id = $1 AND deleted_at IS NULL AND is_virtual = false', [scope.organizationId], 'id::text AS id, initial_amount::text AS initial_amount');
    if (!accounts.length) return status(3, 'accounts_missing');
    const accountIds = accounts.map(a => a.id);
    const legacy = await paged(ctx, 'FROM public.accounts_with_balance WHERE id = ANY($1::uuid[])', [accountIds], 'id::text AS id, current_amount::text AS current_amount');
    const v2 = await paged(ctx, 'FROM public.accounts_with_balance_v2 WHERE id = ANY($1::uuid[]) AND organization_id = $2', [accountIds, scope.organizationId], 'id::text AS id, current_amount::text AS current_amount');
    const win = windowFor(scope.month);
    const values = [scope.organizationId, win.start, win.end];
    const truthRow = await queryOne(ctx, `SELECT count(*)::int AS count, COALESCE(sum(pl.signed_amount),0)::text AS sum, md5(string_agg(pl.id::text, ',' ORDER BY pl.id)) AS id_digest ${POST_FROM}`, values);
    const postings = await paged(ctx, POST_FROM, values, 'pl.id::text AS id, pl.signed_amount::text AS signed_amount', 'pl.id');
    // Detect inconsistent relations that an inner join would otherwise hide.
    const raw = await queryOne(ctx, `SELECT count(*)::int AS count FROM public.income_expense_posting_lines pl JOIN public.income_expense_postings p ON p.id = pl.posting_id WHERE pl.organization_id = $1 AND p.posted_on BETWEEN $2 AND $3 AND p.event_kind IN ('POSTING','REVERSAL')`, values);
    if (Number(raw.count) !== Number(truthRow.count)) return status(1, 'posting_relation_mismatch');
    return compareV2({ accounts, legacy, v2, truth: { count: Number(truthRow.count), sum: truthRow.sum, idDigest: truthRow.id_digest }, postings });
  }});
}

export async function runTestReconcile(kind, args, env = process.env) {
  try {
    const options = parseTestArgs(args);
    const scope = JSON.parse(await readFile(options['--test-scope'], 'utf8'));
    // Scope syntax/target is checked before vault, network, or authentication.
    validateReconcileScope(scope, scope?.expectedRef);
    const credentials = options['--use-vault'] ? await loadTestCredentialsFromVault({ env }) : loadTestCredentials({ env });
    validateReconcileScope(scope, credentials.expectedRef);
    const ca = await readFile(options['--ca-file'], 'utf8');
    const config = { ...credentials, db: { ...credentials.db, ca } };
    let result;
    if (kind === 'v1') {
      const email = env.LIFECYCLE_TEST_EMAIL;
      const password = env.LIFECYCLE_TEST_PASSWORD;
      let apiKey = env.TEST_SUPABASE_PUBLISHABLE_KEY;
      if (!apiKey && options['--use-vault']) {
        const { docVault } = await import('../test-env/lib.mjs');
        apiKey = docVault().match(/(?:^|\s)TEST_SUPABASE_PUBLISHABLE_KEY=([^\s`]+)/m)?.[1];
      }
      if (!email || !password || !apiKey) throw new Error('Explicit TEST actor and publishable key required.');
      result = await runV1(config, scope, { email, password }, apiKey);
    } else if (kind === 'v2') result = await runV2(config, scope);
    else throw new Error('Unknown TEST reconcile kind.');
    return { ...result, targetRef: scope.expectedRef, mode: kind, at: new Date().toISOString() };
  } catch { return { status: 2, reason: 'test_reconcile_error' }; }
}
