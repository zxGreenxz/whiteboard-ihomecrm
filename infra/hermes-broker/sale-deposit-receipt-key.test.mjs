import { createBroker } from './broker.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createActionCatalog } from './action-catalog.mjs';
import { PROBE_CONFIRM, PROBE_NOTE } from './action-probe-contract.mjs';
import { HERMES_ACTION_CAPABILITIES, HERMES_CAPABILITIES } from './capability-contract.mjs';
import { CONTRACT_ACTIONS } from './contract-action-contract.mjs';
import { CUSTOMER_ACTIONS } from './customer-action-contract.mjs';
import { EXPENSE_ACTIONS } from './expense-actions-contract.mjs';
import { INVOICE_ACTIONS } from './invoice-actions-contract.mjs';
import { SALE_POLICY_CAPABILITIES } from './sale-policy-contract.mjs';
import { SALE_TOOL } from './sale-tool-contract.mjs';
import { TASK_ACTIONS } from './task-actions-contract.mjs';
import { saleSetup, ROOM, ORG } from './sale-action-sql-fixture.mjs';
import { extract } from './room-pass-sql-fixture.mjs';

// Review chéo PR #349 (phương án b): migration bật trang Thu chi bật income_expenses.create, mà khoá đó từng là điều kiện CUỐI CÙNG
// còn đóng hai tool báo cọc Sale ghi tiền một bước (crm_sale_reservation_create / _topup: không xem trước, không confirmToken, có
// thể tự duyệt lúc sinh). Từ migration hermes_sale_deposit_receipt_key_v1 + connector cùng đợt, hai thao tác đó đòi THÊM khoá riêng
// deposits.create_receipt (seed TẮT; registry ∩ chính sách công ty ∩ kết nối ở SQL; effective.action ở connector).
// Chứng minh, cả connector lẫn SQL: income_expenses.create bật (như sau 20261027234414) mà thiếu khoá riêng ⇒ chặn trước khi ghi; có
// khoá riêng ⇒ mở; khoá riêng không thay deposits.create hay income_expenses.create (chỉ siết); thao tác Sale khác không đổi; không lớp
// quyền nào của connector cấp khoá riêng. SQL chạy trên PGlite: fixture Sale (20261020183546) + thân production 20261021064112 + cổng
// nhận kết nối 20261019034850 + cột / hàm / trigger chiếu lại inherit_crm THẬT của 20261019034754 + file mới nguyên văn (BEGIN / COMMIT
// / NOTIFY). KHÔNG chứng minh bộ ghi cọc thật (stub của fixture), lane / DB thật hay connector đã triển khai.
// Kiểm đột biến: HERMES_SALE_DEPOSIT_KEY_MUTATION=<tên trong MUTATIONS> đổi SQL / mã connector CHỈ trong bộ nhớ ⇒ test phải đỏ. Đột
// biến đổi thân hàm thì md5 ghim của file được ghim lại theo thân đã đổi, để chỉ phép kiểm hành vi bắt được.
const KEY = 'deposits.create_receipt';
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const migrationName = slug => {
  const found = readdirSync(DIR).filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  assert.equal(found.length, 1, slug);
  return found[0];
};
const read = name => readFileSync(new URL(name, DIR), 'utf8').replaceAll('\r\n', '\n');
const BODY_NAME = migrationName('hermes_sale_bulk_policy_v1'), FILE_NAME = migrationName('hermes_sale_deposit_receipt_key_v1');
const BODY_SQL = read(BODY_NAME);
const HEAD = 'CREATE OR REPLACE FUNCTION public.hermes_sale_actions_v1(';
const statementOf = sql => {
  const start = sql.indexOf(HEAD); assert.ok(start >= 0, 'có định nghĩa vỏ Sale');
  assert.equal(sql.indexOf(HEAD, start + 1), -1, 'đúng một định nghĩa');
  return sql.slice(start, sql.indexOf('END $fn$;', start) + 'END $fn$;'.length);
};
const slice = (sql, start, end) => {
  const from = sql.indexOf(start); assert.ok(from >= 0, start);
  const to = sql.indexOf(end, from + start.length); assert.ok(to > from, `${start} … ${end}`);
  return sql.slice(from, to + end.length);
};
const prosrc = statement => statement.slice(statement.indexOf('AS $fn$') + 'AS $fn$'.length, statement.lastIndexOf('$fn$'));
const md5 = text => createHash('md5').update(text).digest('hex');

// Mỗi mục: [đích, ...cặp [chuỗi gốc phải có, chuỗi thay]].
const MUTATIONS = {
  'sql-no-key-gate': ['sql', ["   THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;\n  -- The CRM maker",
    '   THEN NULL; END IF;\n  -- The CRM maker']],
  'sql-skip-registry': ['sql', [`  PERFORM 1 FROM app_private.hermes_capabilities WHERE capability='${KEY}' AND mode='action' AND enabled FOR SHARE;`, '  PERFORM 1;']],
  'sql-skip-connection': ['sql', [`OR NOT('${KEY}'=ANY(c.action_capabilities)) `, '']],
  'sql-skip-policy': ['sql', [`policy WHERE policy.enabled AND '${KEY}'=ANY(policy.action_capabilities))`, 'policy WHERE policy.enabled)']],
  'sql-key-replaces-income': ['sql', ["  IF NOT(v_building=ANY(app_private.hermes_sale_buildings_v1(c,'income_expenses.create'))) THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;\n  -- A one-step", '  -- A one-step']],
  'sql-topup-skips-key': ['sql', ['  IF NOT FOUND OR NOT(', "  IF v_op='reservation_create' AND (NOT FOUND OR NOT("],
    [`'${KEY}'=ANY(policy.action_capabilities))`, `'${KEY}'=ANY(policy.action_capabilities)))`]],
  'sql-seed-enabled': ['sql', [`VALUES('${KEY}','action',false)`, `VALUES('${KEY}','action',true)`]],
  'sql-reseed-disables': ['sql', [`VALUES('${KEY}','action',false);\n  END IF;`,
    `VALUES('${KEY}','action',false);\n  END IF;\n  UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='${KEY}';`]],
  'sql-skip-body-pin': ['sql', ['  IF body_md5 IS NULL OR body_md5 NOT IN (', '  IF false AND body_md5 NOT IN (']],
  'sql-skip-mode-check': ['sql', [`capability='${KEY}' AND mode<>'action') THEN`, `capability='${KEY}' AND false) THEN`]],
  'connector-no-key': ['connector', ["const DEPOSIT_RECEIPT_KEYS = Object.freeze(['income_expenses.create', SALE_DEPOSIT_RECEIPT_KEY]);",
    "const DEPOSIT_RECEIPT_KEYS = Object.freeze(['income_expenses.create']);"]],
  'connector-key-replaces-income': ['connector', ["const DEPOSIT_RECEIPT_KEYS = Object.freeze(['income_expenses.create', SALE_DEPOSIT_RECEIPT_KEY]);",
    'const DEPOSIT_RECEIPT_KEYS = Object.freeze([SALE_DEPOSIT_RECEIPT_KEY]);']],
  'connector-topup-skips-key': ['connector', ["const DEPOSIT_RECEIPT_OPS = Object.freeze(['reservation_create', 'reservation_topup']);",
    "const DEPOSIT_RECEIPT_OPS = Object.freeze(['reservation_create']);"]],
};
const mutation = process.env.HERMES_SALE_DEPOSIT_KEY_MUTATION;
assert(!mutation || Object.hasOwn(MUTATIONS, mutation), `unknown mutation ${mutation}`);
const mutate = (target, text) => {
  if (!mutation || MUTATIONS[mutation][0] !== target) return text;
  let changed = text;
  for (const [from, to] of MUTATIONS[mutation].slice(1)) {
    assert.ok(changed.includes(from), `${mutation}: ${from}`);
    changed = changed.replaceAll(from, to);
  }
  if (target === 'sql') changed = changed.replaceAll(md5(prosrc(statementOf(text))), md5(prosrc(statementOf(changed))));
  return changed;
};
const FILE_SQL = mutate('sql', read(FILE_NAME));
const CONTRACT_URL = new URL('./sale-action-contract.mjs', import.meta.url);
const contract = mutation && MUTATIONS[mutation][0] === 'connector'
  ? await import(`data:text/javascript,${encodeURIComponent(mutate('connector', readFileSync(CONTRACT_URL, 'utf8'))
    .replace(/from '\.\/([^']+)'/g, (_, file) => `from '${new URL(file, CONTRACT_URL).href}'`))}`)
  : await import('./sale-action-contract.mjs');

const DEPOSIT_OPS = ['reservation_create', 'reservation_topup'];
const OTHER_OPS = ['options', 'observe', 'patch', 'lock', 'release', 'reservation_update', 'reservation_assign', 'status'];
// Sau 20261027234414: lớp thao tác cấp bốn khoá Thu chi của danh mục production, lớp Sale cấp năm khoá Sale (bật từ 20261022121254).
const TC_ON = Object.freeze([...contract.SALE_ACTIONS, 'sale_phong.edit', ...createActionCatalog([...EXPENSE_ACTIONS]).keys]);
const receipt = { amount: 2000000, accountId: null, voucherDate: '2026-10-21', name: null, description: null };
const RESERVATION = '00000000-0000-4000-8000-000000000501';
const createInput = requestId => ({ requestId, roomId: ROOM, customerId: null, customerHint: 'Anh A', intendedMoveInOn: null, topupDueOn: null,
  depositTarget: 3000000, notes: null, receipt });
const topupInput = requestId => ({ requestId, reservationId: RESERVATION, expectedRevision: 1, receipt });
const INPUT = { reservation_create: createInput, reservation_topup: topupInput };
let sequence = 0;
const nextId = () => `00000000-0000-4000-8000-${String(600 + ++sequence).padStart(12, '0')}`;

test('connector: income_expenses.create (trang Thu chi đã bật) không mở báo cọc / thu thêm; thêm khoá riêng mới mở; chỉ siết', () => {
  assert.equal(contract.SALE_DEPOSIT_RECEIPT_KEY, KEY);
  assert.ok(TC_ON.includes('income_expenses.create') && TC_ON.includes('deposits.create') && !TC_ON.includes(KEY));
  for (const operation of DEPOSIT_OPS) {
    const input = contract.saleActionInput(operation, INPUT[operation](randomUUID()));
    for (const args of [[], [input]]) {
      assert.equal(contract.mayUseSaleAction({ action: TC_ON }, operation, ...args), false, `${operation}: khoá Thu chi một mình`);
      assert.equal(contract.mayUseSaleAction({ action: [...TC_ON, KEY] }, operation, ...args), true, `${operation}: thêm khoá riêng`);
    }
    // Khoá riêng không thay hai điều kiện cũ.
    for (const missing of ['income_expenses.create', 'deposits.create'])
      assert.equal(contract.mayUseSaleAction({ action: [...TC_ON.filter(key => key !== missing), KEY] }, operation), false, `${operation}: thiếu ${missing}`);
    assert.equal(contract.mayUseSaleAction({ action: [KEY] }, operation), false);
    assert.equal(contract.mayUseSaleAction(undefined, operation), false);
  }
  // Mọi thao tác Sale khác: khoá riêng không đổi gì.
  for (const operation of OTHER_OPS) {
    assert.equal(contract.mayUseSaleAction({ action: TC_ON }, operation), true, operation);
    assert.equal(contract.mayUseSaleAction({ action: [KEY] }, operation), false, `${operation}: khoá riêng không cấp gì khác`);
  }
});

test('connector: khoá riêng có trong hợp đồng web + connector (bật nhầm không làm hỏng kết nối) nhưng không lớp quyền nào cấp', () => {
  assert.deepEqual(HERMES_CAPABILITIES[KEY], { mode: 'action', resource: 'building' });
  assert.ok(HERMES_ACTION_CAPABILITIES.includes(KEY));
  // Lớp Sale cấp đúng năm khoá của hermes_sale_capabilities_v1; lớp thao tác chỉ cấp khoá của danh mục crm_action_*.
  assert.equal(contract.SALE_ACTIONS.includes(KEY), false);
  const actionKeys = createActionCatalog([...EXPENSE_ACTIONS, ...TASK_ACTIONS, ...INVOICE_ACTIONS, ...CONTRACT_ACTIONS, PROBE_NOTE, PROBE_CONFIRM]).keys;
  assert.equal(actionKeys.includes(KEY), false);
  for (const keys of [SALE_POLICY_CAPABILITIES, CUSTOMER_ACTIONS]) assert.equal(keys.includes(KEY), false);
  // Danh mục / lớp quyền tương lai: mã connector (không kể test, fixture) chỉ được nhắc khoá riêng ở hợp đồng Sale và hợp đồng khoá.
  // Thêm nơi dùng (vd. một thao tác crm_action_* khai khoá này ⇒ lớp thao tác cấp nó ⇒ mở báo cọc) phải sửa test này có chủ ý.
  const users = [];
  for (const dir of ['hermes-broker', 'hermes-runtime', 'hermes-zalo-router', 'hermes-zalo-native']) {
    const base = new URL(`../${dir}/`, import.meta.url);
    let names = [];
    try { names = readdirSync(base); } catch { continue; }
    for (const name of names.filter(item => item.endsWith('.mjs') && !/\.test\.mjs$|fixture/.test(item)))
      if (/deposits\.create_receipt|SALE_DEPOSIT_RECEIPT_KEY/.test(readFileSync(new URL(name, base), 'utf8'))) users.push(`${dir}/${name}`);
  }
  assert.deepEqual(users.sort(), ['hermes-broker/capability-contract.mjs', 'hermes-broker/sale-action-contract.mjs']);
});

test('connector broker: crm_sale_action ẩn báo cọc / thu thêm khi chỉ có khoá Thu chi, gọi ⇒ tool_not_available, không tới dịch vụ', async t => {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const building = randomUUID(), connection = randomUUID(), seen = [], prepared = new WeakMap(), state = { grants: TC_ON };
  const who = () => ({ row: { id: connection, assistantId: randomUUID(), organizationId: randomUUID(), userId: randomUUID(), state: 'active', epoch: 1,
    expiresAt: Date.now() + 3600000, restrictions: { read: [], action: state.grants } }, effective: { read: [], action: state.grants },
    policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [randomUUID()], isSuperadmin: false,
    scopesByPermission: Object.fromEntries(state.grants.map(key => [key, { buildingIds: [building], cashbookIds: [] }])) });
  const broker = createBroker({ dependencyScope: scope, limits: { maxResultBytes: 65536 }, audit: async () => {},
    authority: { identifyConnection: async () => ({ connectionId: connection }), resolve: async () => who(), checkUnchanged: async () => {} },
    saleActions: {
      async prepareSaleAction(_token, operation, input) { seen.push(operation); const value = Object.freeze({}); prepared.set(value, input); return value; },
      async finalizeSaleAction(_token, value, options) { options.onDispatch(); return { outcome: 'applied', requestId: prepared.get(value).requestId }; },
    } });
  const token = 'hc_' + 'A'.repeat(43);
  const call = async (operation, input) => JSON.parse((await broker.callTool(token, SALE_TOOL.name, { operation, ...(input ? { input } : {}) })).content[0].text);
  const listed = async () => (await call('list')).operations.map(item => item.operation);
  const off = await listed();
  for (const operation of DEPOSIT_OPS) assert.equal(off.includes(operation), false, operation);
  for (const operation of ['room_patch', 'room_lock', 'room_release', 'reservation_update', 'reservation_assign']) assert.ok(off.includes(operation), operation);
  for (const operation of DEPOSIT_OPS)
    await assert.rejects(() => call(operation, INPUT[operation](randomUUID())), error => error.code === 'tool_not_available', operation);
  assert.deepEqual(seen, []);
  state.grants = [...TC_ON, KEY];
  const on = await listed();
  for (const operation of DEPOSIT_OPS) {
    assert.ok(on.includes(operation), operation);
    assert.equal((await call(operation, INPUT[operation](randomUUID()))).outcome, 'applied', operation);
  }
  assert.deepEqual(seen, DEPOSIT_OPS);
});

test('migration: đúng thân production 20261021064112 + một khối chèn trong nhánh báo cọc; md5 ghim khớp hai thân', () => {
  assert.ok(FILE_NAME > BODY_NAME, 'chạy sau thân mà nó ghim');
  const before = statementOf(BODY_SQL).split('\n'), after = statementOf(FILE_SQL).split('\n');
  let head = 0;
  while (head < before.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
  assert.equal(head + tail, before.length, 'chỉ chèn, không sửa / xoá dòng nào của thân 20261021064112');
  assert.match(before[head - 1], /hermes_sale_buildings_v1\(c,'income_expenses\.create'\)/, 'khối chèn ngay sau cổng income_expenses.create');
  assert.match(before[head - 2], /^ IF v_op IN \('reservation_create','reservation_topup'\) THEN$/, 'trong nhánh báo cọc / thu thêm');
  const pins = [...new Set([...FILE_SQL.matchAll(/'([0-9a-f]{32})'/g)].map(match => match[1]))].sort();
  assert.deepEqual(pins, [md5(prosrc(statementOf(BODY_SQL))), md5(prosrc(statementOf(FILE_SQL)))].sort(), 'ghim thân cũ + thân mới, không gì khác');
  assert.doesNotMatch(FILE_SQL.replace(/--[^\n]*/g, ''), /\b(?:DROP|GRANT|REVOKE|ALTER)\b/i, 'không DROP, không đổi ACL hay owner');
});

const bodyMd5 = async db => (await db.query("SELECT md5(replace(prosrc,chr(13),'')) m FROM pg_proc WHERE oid='public.hermes_sale_actions_v1(jsonb,text,jsonb)'::regprocedure")).rows[0].m;
const keyRow = async db => (await db.query('SELECT mode,enabled FROM app_private.hermes_capabilities WHERE capability=$1', [KEY])).rows[0] ?? null;
const connectionRows = async db => (await db.query(`SELECT id,epoch,permission_mode,read_capabilities,action_capabilities,scope_ids,excluded_action
  FROM app_private.hermes_connections ORDER BY id`)).rows;

test('SQL (thân production + file mới): income_expenses.create bật mà thiếu khoá riêng ⇒ chặn trước khi ghi; đủ khoá riêng ⇒ mở', { timeout: 180000 }, async t => {
  const { db, rpc } = await saleSetup(t);
  await db.exec(BODY_SQL);
  // Như production (6/6 kết nối ACTIVE là inherit_crm): cột + hàm + trigger chiếu lại của 20261019034754 (khoá registry bật ⇒ vào
  // action_capabilities của kết nối inherit_crm, trừ khoá loại trừ) và cổng nhận kết nối hiện hành 20261019034850 (inherit_crm KHÔNG
  // bị đòi khoá kết nối ⊆ chính sách công ty ⇒ chính sách công ty thiếu khoá riêng chỉ còn cổng của file này chặn).
  const inherit = read(migrationName('hermes_inherit_crm_limits_v1'));
  const fnStatement = name => slice(inherit, `CREATE OR REPLACE FUNCTION ${name}(`, 'END $fn$;');
  await db.exec([slice(inherit, 'ALTER TABLE app_private.hermes_connections', ';'), slice(inherit, 'DO $fn$ BEGIN', 'END $fn$;'),
    fnStatement('app_private.hermes_project_connection_limits_v2'), slice(inherit, 'CREATE TRIGGER hermes_connection_limits_projection_v2', ';'),
    fnStatement('app_private.hermes_refresh_registry_projection_v2'), slice(inherit, 'CREATE TRIGGER hermes_registry_projection_v2', ';'),
    extract(read(migrationName('hermes_zalo_stable_binding_v1')), 'app_private.hermes_private_command_connection_v1')].join('\n'));
  await db.exec("UPDATE app_private.hermes_connections SET permission_mode='inherit_crm'");
  const productionBody = await bodyMd5(db);
  assert.equal(productionBody, md5(prosrc(statementOf(BODY_SQL))), 'md5 tính trong JS = md5 PostgreSQL của thân 20261021064112');
  const policyBefore = (await db.query('SELECT action_capabilities FROM app_private.hermes_org_policies')).rows;
  const connectionsBefore = await connectionRows(db);
  assert.ok(connectionsBefore[0].action_capabilities.includes('income_expenses.create'), 'kết nối inherit_crm nhận khoá Thu chi đã bật');
  await db.exec(FILE_SQL);

  const toggle = (on, key) => db.query(`UPDATE app_private.hermes_org_policies SET action_capabilities=CASE WHEN $1::boolean
    THEN array_append(array_remove(action_capabilities,$2::text),$2::text) ELSE array_remove(action_capabilities,$2::text) END`, [on, key]);
  // registry: mọi khoá khác bật, khoá riêng theo tham số (trigger chiếu lại kết nối inherit_crm). Kết nối: inherit_crm (loại trừ theo
  // tham số) hoặc legacy_allowlist giữ tập cố định (kể cả khoá đã tắt ở registry).
  const set = async ({ registry = true, policy = true, exclude = [], legacy = null } = {}) => {
    await db.exec(`DELETE FROM app_private.hermes_sale_action_receipts;DELETE FROM public.fixture_sale_writes;DELETE FROM public.room_reservations;
      UPDATE public.fixture_sale_acl SET allowed=true`);
    await db.query('INSERT INTO public.room_reservations VALUES($1,$2,$3)', [RESERVATION, ORG, ROOM]);
    await toggle(policy, KEY);
    await db.query('UPDATE app_private.hermes_capabilities SET enabled=(capability<>$1::text OR $2::boolean)', [KEY, registry]);
    if (legacy) await db.query(`UPDATE app_private.hermes_connections SET permission_mode='legacy_allowlist',excluded_action='{}',
      read_capabilities='{}',action_capabilities=$1::text[]`, [legacy]);
    else await db.query("UPDATE app_private.hermes_connections SET permission_mode='inherit_crm',excluded_action=$1::text[]", [exclude]);
  };
  const projected = async () => (await connectionRows(db))[0].action_capabilities;
  const writes = async () => Number((await db.query('SELECT count(*) n FROM public.fixture_sale_writes')).rows[0].n);
  const receipts = async () => (await db.query('SELECT operation FROM app_private.hermes_sale_action_receipts ORDER BY created_at,operation')).rows.map(row => row.operation);
  const deniedBoth = async label => {
    for (const operation of DEPOSIT_OPS)
      await assert.rejects(() => rpc(operation, INPUT[operation](nextId())), error => error.code === '42501' && error.message === 'hermes_sale_denied', `${label}: ${operation}`);
    assert.equal(await writes(), 0, `${label}: không gọi bộ ghi`);
    assert.deepEqual(await receipts(), [], `${label}: không biên nhận`);
  };

  await t.test('file seed khoá riêng TẮT: kết nối inherit_crm không nhận khoá, epoch / chính sách giữ nguyên; chạy lại không đổi gì', async () => {
    assert.deepEqual(await keyRow(db), { mode: 'action', enabled: false });
    assert.deepEqual((await db.query('SELECT action_capabilities FROM app_private.hermes_org_policies')).rows, policyBefore);
    assert.deepEqual(await connectionRows(db), connectionsBefore);
    const once = await bodyMd5(db);
    assert.notEqual(once, productionBody);
    await db.exec(FILE_SQL);
    assert.deepEqual([await bodyMd5(db), await keyRow(db), await connectionRows(db)], [once, { mode: 'action', enabled: false }, connectionsBefore]);
  });

  await t.test('như production sau 20261027234414 (khoá Thu chi bật, khoá riêng TẮT): báo cọc + thu thêm bị chặn; Sale khác vẫn chạy', async () => {
    await set({ registry: false, policy: false });
    assert.ok((await projected()).includes('income_expenses.create') && !(await projected()).includes(KEY));
    await deniedBoth('khoá riêng TẮT');
    assert.equal((await rpc('lock', { requestId: nextId(), roomId: ROOM, hours: 6, note: null })).outcome, 'applied');
    assert.equal((await rpc('reservation_update', { requestId: nextId(), reservationId: RESERVATION, expectedRevision: 1, changes: { notes: 'Ghi chú' } })).outcome, 'applied');
    assert.deepEqual(await receipts(), ['lock', 'reservation_update']);
  });

  await t.test('thiếu MỘT lớp của khoá riêng ⇒ vẫn chặn: registry tắt (legacy còn giữ), kết nối loại trừ, chính sách công ty thiếu', async () => {
    // registry tắt nhưng kết nối legacy_allowlist vẫn giữ khoá + chính sách công ty có khoá: chỉ registry chặn.
    await set({ registry: false, legacy: [...TC_ON.filter(key => !['sale_phong.edit', 'income_expenses.edit', 'income_expenses.cancel',
      'income_expenses.approve_vouchers'].includes(key)), 'income_expenses.approve', KEY] });
    await deniedBoth('registry tắt');
    // registry bật, chính sách có, kết nối inherit_crm loại trừ khoá riêng.
    await set({ exclude: [KEY] });
    assert.equal((await projected()).includes(KEY), false);
    await deniedBoth('kết nối loại trừ');
    // registry bật, kết nối inherit_crm nhận khoá, chính sách công ty (dòng có thật) thiếu khoá riêng.
    await set({ policy: false });
    assert.ok((await projected()).includes(KEY));
    await deniedBoth('chính sách công ty thiếu');
  });

  await t.test('đủ khoá riêng ⇒ báo cọc + thu thêm chạy, đối soát status được; kết nối loại trừ khoá ⇒ status cũng bị chặn', async () => {
    await set();
    assert.ok((await projected()).includes(KEY), 'bật registry ⇒ kết nối inherit_crm tự nhận khoá (SQL mở; connector vẫn không cấp)');
    const createId = nextId(), created = await rpc('reservation_create', createInput(createId));
    assert.equal(created.outcome, 'applied');
    assert.equal(created.receipt.receivedAmount, 0);
    assert.equal(JSON.stringify(created).includes('must never'), false);
    assert.equal((await rpc('reservation_topup', topupInput(nextId()))).outcome, 'applied');
    assert.deepEqual(await receipts(), ['reservation_create', 'reservation_topup']);
    assert.deepEqual(await rpc('status', { requestId: createId }), created);
    await db.query("UPDATE app_private.hermes_connections SET excluded_action=ARRAY[$1::text]", [KEY]);
    await assert.rejects(() => rpc('status', { requestId: createId }), error => error.code === '42501');
  });

  await t.test('chỉ siết: khoá riêng đủ mà kết nối loại trừ income_expenses.create ⇒ vẫn chặn', async () => {
    await set({ exclude: ['income_expenses.create'] });
    assert.ok((await projected()).includes(KEY) && !(await projected()).includes('income_expenses.create'));
    await deniedBoth('thiếu income_expenses.create');
  });

  await t.test('chạy lại file khi khoá riêng đã bật: không tắt khoá, thân giữ nguyên, kết nối giữ khoá, báo cọc vẫn chạy', async () => {
    await set();
    const body = await bodyMd5(db);
    await db.exec(FILE_SQL);
    assert.deepEqual([await bodyMd5(db), await keyRow(db)], [body, { mode: 'action', enabled: true }]);
    assert.ok((await projected()).includes(KEY));
    assert.equal((await rpc('reservation_create', createInput(nextId()))).outcome, 'applied');
  });
});

test('SQL: thân hàm khác bản đã ghim hoặc khoá trùng tên khác mode ⇒ file dừng, không ghi gì', { timeout: 120000 }, async t => {
  const { db } = await saleSetup(t);
  const refused = async message => {
    await assert.rejects(() => db.exec(FILE_SQL), error => String(error.message).includes(message), message);
    await db.exec('ROLLBACK');
  };
  // Fixture dựng thân 20261020183546 (trước 20261021064112): không phải thân production ⇒ không ghi đè.
  const older = await bodyMd5(db);
  await refused('hermes_sale_deposit_key_body_unexpected');
  assert.deepEqual([await bodyMd5(db), await keyRow(db)], [older, null]);
  await db.exec(BODY_SQL);
  const production = await bodyMd5(db);
  await db.query("INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES($1,'read',false)", [KEY]);
  await refused('hermes_sale_deposit_key_mode_conflict');
  assert.deepEqual([await bodyMd5(db), await keyRow(db)], [production, { mode: 'read', enabled: false }]);
});
