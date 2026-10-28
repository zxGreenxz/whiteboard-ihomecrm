import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createActionCatalog } from './action-catalog.mjs';
import { HERMES_ACTION_CAPABILITIES } from './capability-contract.mjs';
import { CONTRACT_ACTIONS } from './contract-action-contract.mjs';
import { EXPENSE_ACTIONS } from './expense-actions-contract.mjs';
import { INVOICE_ACTIONS } from './invoice-actions-contract.mjs';
import { SALE_ACTIONS } from './sale-action-contract.mjs';
import { TASK_ACTIONS } from './task-actions-contract.mjs';

// Bốn migration bật thao tác ghi theo trang (HĐ / TC / HĐn / CV, docs/plans/hermes-crm/BAT-KHOA-GHI-4-TRANG.md) và bốn file lùi
// (docs/plans/hermes-crm/revert/*_actions_activation_revert_v1.sql) trên PGlite. Fixture: bảng registry / chính sách / biên nhận
// THẬT (câu CREATE của 20261012061447 và 20261021133823), hai hàm + hai trigger chiếu lại inherit_crm THẬT (20261019034754, md5 thân
// = production 28/10), dữ liệu registry + 27 dòng chính sách như production đọc 28/10 (chỉ đọc), các hàm của trang là vỏ rỗng cùng
// chữ ký (khối kiểm phụ thuộc chỉ hỏi to_regprocedure). Chứng minh: mỗi file bật / tắt ĐÚNG khoá của trang (= khoá danh mục connector
// của trang, trừ khoá mượn của lớp Sale), độc lập với ba trang kia, chạy lại không đổi gì, kết nối inherit_crm nhận / mất khoá mà
// không đổi epoch, legacy / REVOKED không đổi, thiếu phụ thuộc thì dừng trước khi ghi, rào legacy của file lùi. KHÔNG chứng minh RPC
// trang hay hàm web (đã có test riêng) và không thay lane / tầng 2 trên TEST.
// Kiểm đột biến: HERMES_ACTIVATION_SQL_MUTATION=<tên trong MUTATIONS> đổi SQL CHỈ trong bộ nhớ của lần chạy này ⇒ test phải đỏ.
const lf = text => text.replaceAll('\r\n', '\n');
const migration = slug => {
  const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  assert.equal(found.length, 1, slug);
  return lf(readFileSync(`supabase/migrations/${found[0]}`, 'utf8'));
};
const revertFile = slug => lf(readFileSync(`docs/plans/hermes-crm/revert/${slug.replace(/_v1$/, '')}_revert_v1.sql`, 'utf8'));
const plain = sql => sql.replace(/^BEGIN;|^COMMIT;|^NOTIFY pgrst[^\n]*/gm, '');
const statement = (sql, start, end) => {
  const from = sql.indexOf(start); assert.ok(from >= 0, start);
  const to = sql.indexOf(end, from + start.length); assert.ok(to > from, `${start} … ${end}`);
  return sql.slice(from, to + end.length);
};
const fnStatement = (sql, name) => {
  const from = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`); assert.ok(from >= 0, name);
  return sql.slice(from, sql.indexOf('$fn$;', sql.indexOf('AS $fn$', from) + 7) + 5);
};

const PAGES = Object.freeze({
  contract: { slug: 'hermes_contract_actions_activation_v1', prefix: 'contract.', actions: CONTRACT_ACTIONS },
  expense: { slug: 'hermes_expense_actions_activation_v1', prefix: 'expense.', actions: EXPENSE_ACTIONS },
  invoice: { slug: 'hermes_invoice_actions_activation_v1', prefix: 'invoice.', actions: INVOICE_ACTIONS },
  task: { slug: 'hermes_task_actions_activation_v1', prefix: 'task.', actions: TASK_ACTIONS },
});
// Bước ghi chính của mỗi trang + khung chung mà khối kiểm phụ thuộc BẮT BUỘC phải hỏi (bỏ khỏi danh sách ⇒ đỏ).
const SHARED_REQUIRED = ['public.hermes_action_capabilities_v1(uuid)', 'app_private.hermes_action_guard_v1(jsonb,text)',
  'app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)', 'app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)',
  'app_private.hermes_refresh_registry_projection_v2()', 'app_private.hermes_project_connection_limits_v2()'];
const PAGE_REQUIRED = {
  contract: ['public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    'app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)',
    'app_private.hermes_contract_batch_step_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'],
  expense: ['public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    'app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'],
  invoice: ['public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    'app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
    'app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
    'app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'],
  task: ['public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    'app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)',
    'app_private.hermes_task_action_write_v1(jsonb)', 'app_private.hermes_task_action_finish_v1(jsonb,text,jsonb)',
    'app_private.hermes_task_recurring_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)',
    'app_private.hermes_task_recurring_finish_v1(jsonb,text,jsonb)'],
};
// CONG-VIEC-THAO-TAC-GHI.md mục 22 (bản chủ duyệt): bốn dòng chính sách việc định kỳ.
const RECURRING_POLICIES = [
  ['task.recurring_create', 'tasks.create', 'tasks.create', 'reversible', 'always', true],
  ['task.recurring_delete', 'tasks.delete', 'tasks.delete', 'reversible', 'always', true],
  ['task.recurring_pause', 'tasks.edit', 'tasks.edit', 'reversible', 'always', true],
  ['task.recurring_update', 'tasks.edit', 'tasks.edit', 'reversible', 'always', true],
];
// Production đọc 28/10/2026 (db:query, chỉ đọc): khoá Action liên quan + hai khoá Read, và 27 dòng chính sách.
const PROD_REGISTRY = {
  'assistant.action_probe': false, 'contracts.create': false, 'contracts.edit': false, 'contracts.renew': false, 'contracts.terminate': false,
  'contracts.transfer': false, 'deposits.edit': true, 'income_expenses.approve': true, 'income_expenses.approve_vouchers': false,
  'income_expenses.cancel': false, 'income_expenses.create': false, 'income_expenses.edit': false, 'invoices.approve': false,
  'invoices.cancel': false, 'invoices.edit': false, 'meter_readings.create': false, 'rooms.edit': true, 'sale_phong.lock_room': true,
  'tasks.create': true, 'tasks.delete': false, 'tasks.edit': true, 'thu_tien.collect_transfer': false,
};
const PROD_READ = ['contracts.view', 'tasks.view'];
const PROD_POLICIES = [
  ['contract.draft', 'contracts.create', 'contracts.create', 'reversible', 'never'],
  ['contract.notice_cancel', 'contracts.terminate', 'contracts.terminate', 'reversible', 'never'],
  ['contract.notice_set', 'contracts.terminate', 'contracts.terminate', 'reversible', 'never'],
  ['contract.occupant_add', 'contracts.edit', 'contracts.edit', 'reversible', 'never'],
  ['contract.occupant_remove', 'contracts.edit', 'contracts.edit', 'reversible', 'never'],
  ['contract.renew', 'contracts.renew', 'contracts.renew', 'irreversible', 'always'],
  ['contract.renew_batch', 'contracts.renew', 'contracts.renew', 'irreversible', 'always'],
  ['contract.return', 'contracts.terminate', 'contracts.terminate', 'irreversible', 'always'],
  ['contract.room_lock', 'sale_phong.lock_room', 'sale_phong.lock_room', 'reversible', 'never'],
  ['contract.room_unlock', 'sale_phong.lock_room', 'sale_phong.lock_room', 'reversible', 'never'],
  ['expense.approve', 'income_expenses.approve_vouchers', 'income_expenses.approve', 'money', 'always'],
  ['expense.cancel', 'income_expenses.cancel', 'income_expenses.create', 'irreversible', 'always'],
  ['expense.create', 'income_expenses.create', 'income_expenses.create', 'money', 'always'],
  ['expense.edit', 'income_expenses.edit', 'income_expenses.create', 'money', 'always'],
  ['expense.note', 'income_expenses.create', 'income_expenses.create', 'reversible', 'never'],
  ['invoice.adjust', 'invoices.edit', 'invoices.edit', 'money', 'always'],
  ['invoice.adjustment_check', 'invoices.approve', 'invoices.approve', 'irreversible', 'always'],
  ['invoice.cancel', 'invoices.cancel', 'invoices.cancel', 'money', 'always'],
  ['invoice.collect', 'thu_tien.collect_transfer', 'thu_tien.collect', 'money', 'always'],
  ['invoice.meter_record', 'meter_readings.create', 'meter_readings.create', 'money', 'always'],
  ['invoice.restore', 'invoices.cancel', 'invoices.cancel', 'money', 'always'],
  ['probe.confirm', 'assistant.action_probe', 'buildings.view', 'money', 'always'],
  ['probe.note', 'assistant.action_probe', 'buildings.view', 'reversible', 'never'],
  ['task.cancel', 'tasks.delete', 'tasks.delete', 'irreversible', 'always'],
  ['task.create', 'tasks.create', 'tasks.create', 'reversible', 'never'],
  ['task.create_batch', 'tasks.create', 'tasks.create', 'reversible', 'always'],
  ['task.update', 'tasks.edit', 'tasks.edit', 'reversible', 'never'],
];

// Đột biến tay (chỉ trong bộ nhớ). Mỗi mục: file đích + các cặp [chuỗi gốc phải có, chuỗi thay].
const MUTATIONS = {
  'forward-drop-key': ['forward:contract', ["'contracts.create','contracts.edit','contracts.renew'", "'contracts.create','contracts.renew'"], ['<>4 THEN', '<>3 THEN']],
  'forward-skip-function-check': ['forward:expense', ['IF to_regprocedure(signature) IS NULL THEN', 'IF false THEN']],
  'forward-skip-projection-check': ['forward:invoice', ["AND tgenabled='O'", '']],
  'forward-skip-policy-check': ['forward:invoice', ["IF missing IS NOT NULL THEN\n    RAISE EXCEPTION 'hermes_invoice_activation_policy_missing", "IF false THEN\n    RAISE EXCEPTION 'hermes_invoice_activation_policy_missing"]],
  'forward-recurring-never': ['forward:task', ["('task.recurring_pause','tasks.edit','tasks.edit','reversible','always',true)", "('task.recurring_pause','tasks.edit','tasks.edit','reversible','never',true)"]],
  'forward-skip-recurring-check': ['forward:task', [")))<>4 THEN\n    RAISE EXCEPTION 'hermes_task_activation_recurring_policy_invalid'", ")))<0 THEN\n    RAISE EXCEPTION 'hermes_task_activation_recurring_policy_invalid'"]],
  'revert-skip-legacy-fence': ['revert:expense', ['IF legacy>0 THEN', 'IF false THEN']],
  'revert-touches-lock': ['revert:contract', ["ARRAY['contracts.create','contracts.edit'", "ARRAY['sale_phong.lock_room','contracts.create','contracts.edit'"], ['<>4 THEN', '<>5 THEN']],
  'revert-drops-create': ['revert:task', ["WHERE capability='tasks.delete' AND mode='action' AND enabled;", "WHERE capability IN ('tasks.delete','tasks.create') AND mode='action' AND enabled;"]],
};
const mutationName = process.env.HERMES_ACTIVATION_SQL_MUTATION;
assert(!mutationName || Object.hasOwn(MUTATIONS, mutationName), `unknown mutation ${mutationName}`);
const mutate = (target, sql) => {
  if (!mutationName || MUTATIONS[mutationName][0] !== target) return sql;
  for (const [from, to] of MUTATIONS[mutationName].slice(1)) { assert.ok(sql.includes(from), `${mutationName}: ${from}`); sql = sql.replaceAll(from, to); }
  return sql;
};
const FORWARD = Object.fromEntries(Object.entries(PAGES).map(([page, spec]) => [page, mutate(`forward:${page}`, migration(spec.slug))]));
const REVERT = Object.fromEntries(Object.entries(PAGES).map(([page, spec]) => [page, mutate(`revert:${page}`, revertFile(spec.slug))]));
const keysOf = sql => [...statement(sql, ':=ARRAY[', ']').matchAll(/'([a-z_.]+)'/g)].map(m => m[1]).sort();
const signaturesOf = sql => [...statement(sql, 'FOREACH signature IN ARRAY ARRAY[', '] LOOP').matchAll(/'([a-z_]+\.[a-z0-9_]+\([^']*\))'/g)].map(m => m[1]);
const REAL_FUNCTIONS = new Set(['app_private.hermes_refresh_registry_projection_v2()', 'app_private.hermes_project_connection_limits_v2()']);

const IDENTITY = lf(readFileSync('supabase/migrations/20261012061447_hermes_assistant_identity_policy_v1.sql', 'utf8'));
const FOUNDATION = migration('hermes_action_foundation_v1');
const INHERIT = lf(readFileSync('supabase/migrations/20261019034754_hermes_inherit_crm_limits_v1.sql', 'utf8'));
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = u(1), USER = u(2), INHERIT_ALL = u(11), INHERIT_EXCLUDING = u(12), LEGACY = u(13), REVOKED = u(14);
const EXCLUDED = ['contracts.renew', 'income_expenses.approve_vouchers', 'invoices.cancel', 'tasks.delete'];
const LEGACY_KEYS = ['sale_phong.lock_room', 'tasks.create'];

async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  const stubs = new Set(Object.values(FORWARD).flatMap(signaturesOf).filter(signature => !REAL_FUNCTIONS.has(signature)));
  await db.exec(`CREATE SCHEMA app_private;
    ${statement(IDENTITY, 'CREATE TABLE IF NOT EXISTS app_private.hermes_capabilities (', '\n);')}
    CREATE TABLE app_private.hermes_connections(id uuid PRIMARY KEY,organization_id uuid NOT NULL,user_id uuid NOT NULL,
      state text NOT NULL CHECK (state IN ('PENDING','ACTIVE','REVOKED')),epoch bigint NOT NULL DEFAULT 1,
      read_capabilities text[] NOT NULL DEFAULT '{}',action_capabilities text[] NOT NULL DEFAULT '{}',scope_ids uuid[] NOT NULL DEFAULT '{}',
      revoked_at timestamptz,permission_mode text NOT NULL DEFAULT 'legacy_allowlist',excluded_read text[] NOT NULL DEFAULT '{}',
      excluded_action text[] NOT NULL DEFAULT '{}',scope_mode text NOT NULL DEFAULT 'restricted');
    CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,building_id uuid,area_id uuid,cashbook_id uuid);
    CREATE TABLE public.job_recurrence_rules(id uuid PRIMARY KEY);
    CREATE TABLE public.job_recurrence_occurrences(rule_id uuid);
    ${statement(FOUNDATION, 'CREATE TABLE IF NOT EXISTS app_private.hermes_action_policies(', ';\n')}
    ${statement(FOUNDATION, 'CREATE TABLE IF NOT EXISTS app_private.hermes_action_receipts(', ';\n')}
    ${fnStatement(INHERIT, 'app_private.hermes_project_connection_limits_v2')}
    ${statement(INHERIT, 'CREATE TRIGGER hermes_connection_limits_projection_v2', ';')}
    ${fnStatement(INHERIT, 'app_private.hermes_refresh_registry_projection_v2')}
    ${statement(INHERIT, 'CREATE TRIGGER hermes_registry_projection_v2', ';')}
    ${[...stubs].map(signature => `CREATE FUNCTION ${signature} RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';`).join('\n    ')}
    INSERT INTO public.authorization_scopes(id,organization_id,scope_type) VALUES('${u(3)}','${ORG}','ORGANIZATION');`);
  for (const [capability, enabled] of Object.entries(PROD_REGISTRY))
    await db.query('INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES($1,$2,$3)', [capability, 'action', enabled]);
  for (const capability of PROD_READ)
    await db.query('INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES($1,$2,true)', [capability, 'read']);
  for (const row of PROD_POLICIES)
    await db.query('INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES($1,$2,$3,$4,$5,true)', row);
  // inherit_crm đủ khoá / có loại trừ (chiếu ngay lúc chèn); legacy_allowlist giữ tập cố định; REVOKED không còn được chiếu lại.
  const insert = (id, state, mode, scope, extra = {}) => db.query(`INSERT INTO app_private.hermes_connections(id,organization_id,user_id,state,
    permission_mode,scope_mode,excluded_action,action_capabilities,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ORG, USER, state, mode, scope, extra.excluded ?? [], extra.action ?? [], state === 'REVOKED' ? new Date() : null]);
  await insert(INHERIT_ALL, 'ACTIVE', 'inherit_crm', 'unrestricted');
  await insert(INHERIT_EXCLUDING, 'ACTIVE', 'inherit_crm', 'unrestricted', { excluded: EXCLUDED });
  await insert(LEGACY, 'ACTIVE', 'legacy_allowlist', 'restricted', { action: LEGACY_KEYS });
  await insert(REVOKED, 'REVOKED', 'inherit_crm', 'unrestricted');
  return db;
}

test('bật / lùi thao tác ghi theo trang: đúng khoá, độc lập, idempotent, chiếu inherit_crm, rào phụ thuộc và legacy', { timeout: 120000 }, async t => {
  const db = await fixture(t);
  const registry = async () => Object.fromEntries((await db.query('SELECT capability,enabled FROM app_private.hermes_capabilities ORDER BY capability')).rows
    .map(row => [row.capability, row.enabled]));
  const policies = async () => (await db.query(`SELECT action,capability,crm_permission,action_class,confirm,private_only
    FROM app_private.hermes_action_policies ORDER BY action`)).rows.map(row => Object.values(row));
  const connections = async () => Object.fromEntries((await db.query(`SELECT id::text,epoch::int,action_capabilities
    FROM app_private.hermes_connections ORDER BY id`)).rows.map(row => [row.id, { epoch: row.epoch, action: [...row.action_capabilities].sort() }]));
  const enabledActionKeys = async () => Object.entries(await registry()).filter(([key, on]) => on && Object.hasOwn(PROD_REGISTRY, key)).map(([key]) => key).sort();
  // Mỗi ca chạy trong một giao dịch rồi lùi; lỗi mong đợi lùi về savepoint để ca đi tiếp.
  const inCase = async body => { await db.exec('BEGIN'); try { await body(); } finally { await db.exec('ROLLBACK'); } };
  const refused = async (sql, message) => {
    await db.exec('SAVEPOINT expect_refusal');
    await assert.rejects(db.exec(sql), error => String(error.message).includes(message), message);
    await db.exec('ROLLBACK TO SAVEPOINT expect_refusal');
  };
  const BASE = { registry: await registry(), policies: await policies(), connections: await connections() };
  const pageKeys = page => keysOf(FORWARD[page]);
  const catalogKeys = page => createActionCatalog([...PAGES[page].actions]).keys.filter(key => !SALE_ACTIONS.includes(key)).sort();

  await t.test('khoá của mỗi file = khoá danh mục connector của trang (trừ khoá mượn của lớp Sale); khoá có trong hợp đồng web + connector', () => {
    for (const page of Object.keys(PAGES)) {
      assert.deepEqual(pageKeys(page), catalogKeys(page), page);
      // File lùi của CV chỉ tắt tasks.delete (ca hành vi bên dưới); ba file kia tắt đúng tập khoá của file bật.
      if (page !== 'task') assert.deepEqual(keysOf(REVERT[page]), catalogKeys(page), `${page} (lùi)`);
      for (const key of pageKeys(page)) assert.ok(HERMES_ACTION_CAPABILITIES.includes(key), key);
    }
    assert.deepEqual(createActionCatalog([...CONTRACT_ACTIONS]).keys.filter(key => SALE_ACTIONS.includes(key)), ['sale_phong.lock_room']);
  });

  await t.test('khối kiểm phụ thuộc hỏi bước ghi chính của trang + khung chung; mọi tên hàm có định nghĩa trong repo', () => {
    const defined = new Set();
    for (const path of ['supabase/baseline/schema.sql', ...readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).map(name => `supabase/migrations/${name}`)])
      for (const match of readFileSync(path, 'utf8').matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?(public|app_private)"?\."?([a-z0-9_]+)"?\s*\(/gi))
        defined.add(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`);
    for (const page of Object.keys(PAGES)) {
      const signatures = signaturesOf(FORWARD[page]);
      for (const required of [...SHARED_REQUIRED, ...PAGE_REQUIRED[page]]) assert.ok(signatures.includes(required), `${page}: ${required}`);
      for (const signature of signatures) assert.ok(defined.has(signature.slice(0, signature.indexOf('('))), `${page}: ${signature}`);
      assert.equal(new Set(signatures).size, signatures.length, `${page}: trùng chữ ký`);
    }
  });

  await t.test('production 28/10: mỗi file bật đúng khoá của trang, chạy lại không đổi gì, ba trang kia giữ nguyên', async () => {
    for (const page of Object.keys(PAGES)) await inCase(async () => {
      await db.exec(plain(FORWARD[page]));
      const once = { registry: await registry(), policies: await policies(), connections: await connections() };
      for (const [key, on] of Object.entries(once.registry))
        assert.equal(on, pageKeys(page).includes(key) ? true : BASE.registry[key], `${page}: ${key}`);
      await db.exec(plain(FORWARD[page]));
      assert.deepEqual({ registry: await registry(), policies: await policies(), connections: await connections() }, once, `${page}: chạy lại`);
    });
  });

  await t.test('từ trạng thái mọi khoá của trang đều tắt: file vẫn bật đủ khoá (CV: cả tasks.create / tasks.edit)', async () => {
    for (const page of Object.keys(PAGES)) await inCase(async () => {
      await db.query('UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability=ANY($1)', [pageKeys(page)]);
      await db.exec(plain(FORWARD[page]));
      const after = await registry();
      for (const key of pageKeys(page)) assert.equal(after[key], true, `${page}: ${key}`);
    });
  });

  await t.test('thao tác sống sau khi bật: dòng chính sách của trang = danh mục connector, khoá + lớp khớp; CV chèn đúng bốn dòng mục 22', async () => {
    await inCase(async () => {
      for (const page of Object.keys(PAGES)) await db.exec(plain(FORWARD[page]));
      const rows = await policies(), on = await registry();
      for (const [page, spec] of Object.entries(PAGES)) {
        const sql = rows.filter(row => row[0].startsWith(spec.prefix));
        assert.deepEqual(sql.map(row => row[0]).sort(), spec.actions.map(action => action.id).sort(), page);
        for (const action of spec.actions) {
          const row = sql.find(item => item[0] === action.id);
          assert.deepEqual([row[1], row[3]], [action.key, action.class], action.id);
          assert.equal(on[row[1]], true, `${action.id}: khoá ${row[1]} bật`);
        }
      }
      assert.deepEqual(rows.filter(row => row[0].startsWith('task.recurring_')), RECURRING_POLICIES);
      assert.deepEqual(rows.filter(row => !row[0].startsWith('task.recurring_')), BASE.policies, 'dòng cũ không đổi');
    });
  });

  await t.test('kết nối: inherit_crm ACTIVE nhận khoá (trừ khoá loại trừ), epoch giữ nguyên; legacy_allowlist và REVOKED không đổi', async () => {
    await inCase(async () => {
      for (const page of Object.keys(PAGES)) await db.exec(plain(FORWARD[page]));
      const after = await connections(), enabled = await enabledActionKeys();
      assert.deepEqual(after[INHERIT_ALL], { epoch: BASE.connections[INHERIT_ALL].epoch, action: enabled });
      assert.deepEqual(after[INHERIT_EXCLUDING], { epoch: BASE.connections[INHERIT_EXCLUDING].epoch, action: enabled.filter(key => !EXCLUDED.includes(key)) });
      assert.deepEqual(after[LEGACY], BASE.connections[LEGACY]);
      assert.deepEqual(after[REVOKED], BASE.connections[REVOKED]);
      for (const page of Object.keys(PAGES)) for (const key of pageKeys(page)) assert.ok(after[INHERIT_ALL].action.includes(key), key);
    });
  });

  await t.test('Hợp đồng không đụng khoá mượn sale_phong.lock_room (bật hay tắt đều giữ nguyên, kể cả file lùi)', async () => {
    for (const lock of [true, false]) await inCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=$1 WHERE capability='sale_phong.lock_room'", [lock]);
      await db.exec(plain(FORWARD.contract));
      assert.equal((await registry())['sale_phong.lock_room'], lock);
      await db.exec(plain(REVERT.contract));
      assert.equal((await registry())['sale_phong.lock_room'], lock);
    });
  });

  await t.test('thiếu phụ thuộc ⇒ dừng TRƯỚC khi ghi: từng hàm, bảng, trigger chiếu lại, dòng chính sách, dòng registry', async () => {
    for (const [page, spec] of Object.entries(PAGES)) {
      const name = page;
      await inCase(async () => {
        for (const signature of signaturesOf(FORWARD[page])) {
          await db.exec('SAVEPOINT drop_one');
          await db.exec(`DROP FUNCTION ${signature} CASCADE`);
          await refused(plain(FORWARD[page]), `hermes_${name}_activation_function_missing: ${signature}`);
          await db.exec('ROLLBACK TO SAVEPOINT drop_one');
        }
        for (const [setup, message] of [
          ['DROP TABLE app_private.hermes_action_receipts', `hermes_${name}_activation_dependencies_missing`],
          ['DROP TRIGGER hermes_registry_projection_v2 ON app_private.hermes_capabilities', `hermes_${name}_activation_projection_missing`],
          ['ALTER TABLE app_private.hermes_connections DISABLE TRIGGER hermes_connection_limits_projection_v2', `hermes_${name}_activation_projection_missing`],
          [`UPDATE app_private.hermes_action_policies SET capability='rooms.edit' WHERE action='${spec.actions[0].id}'`,
            `hermes_${name}_activation_policy_missing: ${spec.actions[0].id}`],
          [`DELETE FROM app_private.hermes_capabilities WHERE capability='${pageKeys(page)[0]}'`, `hermes_${name}_activation_registry_invalid`],
          [`UPDATE app_private.hermes_capabilities SET mode='read' WHERE capability='${pageKeys(page).at(-1)}'`, `hermes_${name}_activation_registry_invalid`],
        ]) {
          await db.exec('SAVEPOINT broken');
          await db.exec(setup);
          await refused(plain(FORWARD[page]), message);
          await db.exec('ROLLBACK TO SAVEPOINT broken');
        }
        assert.deepEqual(await registry(), BASE.registry, `${page}: không khoá nào đổi`);
        assert.deepEqual(await policies(), BASE.policies, `${page}: không dòng chính sách nào đổi`);
      });
    }
  });

  await t.test('CV: dòng định kỳ có sẵn khác bản đã duyệt ⇒ dừng, không nhận im lặng (ON CONFLICT giữ dòng cũ)', async () => {
    for (const [action, column, value] of [['task.recurring_pause', 'confirm', 'never'], ['task.recurring_delete', 'capability', 'tasks.edit'],
      ['task.recurring_create', 'private_only', false]]) await inCase(async () => {
      const row = RECURRING_POLICIES.find(item => item[0] === action);
      const fields = { capability: row[1], crm_permission: row[2], action_class: row[3], confirm: row[4], private_only: row[5], [column]: value };
      await db.query(`INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only)
        VALUES($1,$2,$3,$4,$5,$6)`, [action, fields.capability, fields.crm_permission, fields.action_class, fields.confirm, fields.private_only]);
      await refused(plain(FORWARD.task), 'hermes_task_activation_recurring_policy_invalid');
    });
  });

  await t.test('file lùi: tắt đúng khoá của trang (CV: tasks.delete + bốn dòng định kỳ), kết nối mất khoá, chạy lại được, bật lại được', async () => {
    for (const page of Object.keys(PAGES)) await inCase(async () => {
      for (const each of Object.keys(PAGES)) await db.exec(plain(FORWARD[each]));
      const all = { registry: await registry(), policies: await policies() };
      await db.exec(plain(REVERT[page]));
      const after = await registry(), rows = await policies();
      const off = page === 'task' ? ['tasks.delete'] : pageKeys(page);
      for (const [key, on] of Object.entries(after)) assert.equal(on, off.includes(key) ? false : all.registry[key], `${page}: ${key}`);
      assert.deepEqual(rows, page === 'task' ? all.policies.filter(row => !row[0].startsWith('task.recurring_')) : all.policies, `${page}: chính sách`);
      const projected = (await connections())[INHERIT_ALL].action;
      for (const key of off) assert.equal(projected.includes(key), false, `${page}: ${key} rời kết nối inherit_crm`);
      assert.deepEqual((await connections())[LEGACY], BASE.connections[LEGACY]);
      await db.exec(plain(REVERT[page]));
      assert.deepEqual({ registry: await registry(), policies: await policies() }, { registry: after, policies: rows }, `${page}: lùi lần hai`);
      await db.exec(plain(FORWARD[page]));
      assert.deepEqual({ registry: await registry(), policies: await policies() }, all, `${page}: bật lại`);
    });
  });

  await t.test('file lùi từ chối khi còn kết nối legacy_allowlist ACTIVE giữ khoá của trang; không đổi gì', async () => {
    for (const page of Object.keys(PAGES)) await inCase(async () => {
      for (const each of Object.keys(PAGES)) await db.exec(plain(FORWARD[each]));
      const before = { registry: await registry(), policies: await policies() };
      const held = page === 'task' ? 'tasks.delete' : pageKeys(page)[0];
      await db.query('UPDATE app_private.hermes_connections SET action_capabilities=array_append(action_capabilities,$1) WHERE id=$2', [held, LEGACY]);
      await refused(plain(REVERT[page]), `hermes_${page}_revert_blocked`);
      assert.deepEqual({ registry: await registry(), policies: await policies() }, before, page);
      // Cùng khoá ở kết nối legacy đã REVOKED thì không chặn.
      await db.query("UPDATE app_private.hermes_connections SET state='REVOKED',revoked_at=clock_timestamp() WHERE id=$1", [LEGACY]);
      await db.exec(plain(REVERT[page]));
    });
  });

  await t.test('file lùi trên production chưa bật: không đổi gì', async () => {
    await inCase(async () => {
      for (const page of Object.keys(PAGES)) await db.exec(plain(REVERT[page]));
      assert.deepEqual({ registry: await registry(), policies: await policies(), connections: await connections() }, BASE);
    });
  });

  await t.test('file nguyên văn (BEGIN / COMMIT / NOTIFY): bật cả bốn rồi lùi cả bốn ⇒ về đúng production 28/10', async () => {
    for (const page of Object.keys(PAGES)) await db.exec(FORWARD[page]);
    assert.deepEqual((await enabledActionKeys()).filter(key => !BASE.registry[key]).sort(),
      Object.keys(PAGES).flatMap(pageKeys).filter(key => !BASE.registry[key]).sort());
    for (const page of Object.keys(PAGES).reverse()) await db.exec(REVERT[page]);
    assert.deepEqual({ registry: await registry(), policies: await policies(), connections: await connections() }, BASE);
  });
});
