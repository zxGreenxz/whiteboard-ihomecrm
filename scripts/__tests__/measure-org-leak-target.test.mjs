import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseOrgLeakArgs, createOrgLeakQuery, loadOrgLeakInventory, MA_THOAT_CHOT_HONG } from '../measure-org-leak.mjs';
import { PRODUCTION_REF, withMigrationLease } from '../lib/migration-target.mjs';

const REF = 'abcdefghijklmnopqrst';
const TARGET = Object.freeze({ environment: 'test', projectRef: REF, pat: 'synthetic-test-pat' });
const ARGS = ['--env', 'test', '--expected-project-ref', REF];
const UID = '12340000-0000-4000-8000-000000000001';
const ORG = '23450000-0000-4000-8000-000000000001';
const SYNTHETIC_UID = '99999999-0000-4000-8000-000000000099';
const SYNTHETIC_ORG = '99990000-0000-4000-8000-000000000099';
const ok = rows => ({ ok: true, status: 200, body: JSON.stringify(rows) });

function fakeLease() {
  const state = { pending: false, released: false, ready: true, dispatchGuards: 0, markers: true };
  const deps = {
    test: 'synthetic-test-uri', cred: {},
    query: async sql => sql.includes('to_regclass')
      ? [{ marker: state.markers, lease_marker: state.markers }] : [{ ref: REF }],
    withTestLock: async (_context, work) => {
      try { return await work({}); } finally { state.released = !state.pending; }
    },
    assertTestLease: async () => assert(state.ready, 'lease_lost'),
    markTestCleanupRequired: () => { state.pending = true; state.dispatchGuards += 1; },
    withTestCleanup: async (_lease, _test, settle) => { await settle({}); state.pending = false; },
  };
  return { state, lease: (target, work) => withMigrationLease(target, work, deps) };
}

test('TEST target requires explicit expected ref; bad flags fail before credential resolution', async () => {
  let credentials = 0;
  for (const args of [['--env', 'test'], ['--env', 'stage'], ['--evn', 'test'],
    ['--env=test'], ['--write', '--write'], ['--env'], ['--expected-project-ref', '../prod'],
    ['--env', 'test', '--env', 'prod']]) {
    await assert.rejects(main(args, { resolveTarget: async () => { credentials += 1; return TARGET; } }));
  }
  assert.equal(credentials, 0);
  assert.deepEqual(parseOrgLeakArgs([...ARGS, '--write']), { environment: 'test', expectedProjectRef: REF, write: true });
  assert.equal(parseOrgLeakArgs([]).environment, 'prod'); // Existing CLI is explicit legacy production behavior.
});

test('resolved TEST/project mismatch is rejected before lock or SQL', async () => {
  let locks = 0;
  for (const target of [{ ...TARGET, environment: 'prod' }, { ...TARGET, projectRef: PRODUCTION_REF },
    { ...TARGET, projectRef: 'zzzzzzzzzzzzzzzzzzzz' }]) {
    await assert.rejects(main(ARGS, { resolveTarget: async () => target,
      lease: async () => { locks += 1; } }), /target_mismatch/);
  }
  assert.equal(locks, 0);
});

test('TEST resolver receives database requirement and has no caller-selected output path', async () => {
  const f = fakeLease();
  let resolution;
  const result = await main(ARGS, { resolveTarget: async (...args) => { resolution = args; return TARGET; },
    lease: f.lease, measure: async ({ target, output }) => {
      assert.equal(target, TARGET);
      assert.match(output.replaceAll('\\', '/'), new RegExp(`/.cache/migration-targets/test/${REF}/org-leak-baseline.json$`));
      return 0;
    } });
  assert.equal(result, 0);
  assert.deepEqual(resolution[1], { needsDatabase: true });
  assert.equal(f.state.released, true);
  await assert.rejects(main([...ARGS, '--output', 'docs/generated/org-leak-baseline.json']), /unknown_argument/);
});

test('missing TEST markers or a lost lease cannot dispatch even read SQL', async () => {
  for (const change of [{ markers: false }, { ready: false }]) {
    const f = fakeLease(); Object.assign(f.state, change);
    let calls = 0;
    await assert.rejects(main(ARGS, { resolveTarget: async () => TARGET, lease: f.lease,
      queryImpl: async () => { calls += 1; return ok([]); }, measure: ({ runSql }) => runSql('SELECT 1;') }));
    assert.equal(calls, 0);
    assert.equal(f.state.dispatchGuards, 0);
  }
});

test('every SQL dispatch is guarded and transaction settlement clears the TEST marker', async () => {
  const f = fakeLease(); const calls = [];
  await main(ARGS, { resolveTarget: async () => TARGET, lease: f.lease,
    queryImpl: async input => { calls.push(input); assert.equal(f.state.pending, true); return ok([]); },
    measure: async ({ runSql }) => {
      await runSql('SELECT 1;');
      await runSql('BEGIN; CREATE TEMP TABLE fixture (id int); ROLLBACK;');
      return 0;
    } });
  assert.equal(calls.length, 2);
  assert.equal(f.state.dispatchGuards, 2);
  assert.equal(f.state.released, true);
  for (const call of calls) {
    assert.equal(call.ref, REF); assert.equal(call.pat, TARGET.pat);
    assert.match(call.query, /^BEGIN;/); assert.match(call.query, /ROLLBACK;$/);
  }
  assert.equal((calls[1].query.match(/BEGIN;/g) ?? []).length, 1);
});

test('network, HTTP and malformed ACK outcomes are never retried and retain cleanup marker', async () => {
  for (const response of [new Error('private provider detail'), { ok: false, status: 500, body: 'private' },
    { ok: true, body: '<html>private</html>' }, ok({ error: 'private' }), ok([null]), ok([[]])]) {
    const f = fakeLease(); let calls = 0;
    const run = main(ARGS, { resolveTarget: async () => TARGET, lease: f.lease,
      queryImpl: async () => { calls += 1; if (response instanceof Error) throw response; return response; },
      measure: ({ runSql }) => runSql('BEGIN; INSERT INTO fixture VALUES (1); ROLLBACK;') });
    await assert.rejects(run, error => error.message === 'org_leak_query_unsettled');
    assert.equal(calls, 1); assert.equal(f.state.pending, true); assert.equal(f.state.released, false);
  }
});

test('swallowed unknown ACK cannot be cleared by a subsequent successful read or a green return', async () => {
  const f = fakeLease(); let calls = 0;
  await assert.rejects(main(ARGS, { resolveTarget: async () => TARGET, lease: f.lease,
    queryImpl: async () => { calls += 1; if (calls === 1) throw new Error('timeout'); return ok([]); },
    measure: async ({ runSql }) => {
      await assert.rejects(runSql('BEGIN; INSERT INTO fixture VALUES (1); ROLLBACK;'));
      await assert.rejects(runSql('SELECT 1;'));
      return 0;
    } }), /unsettled/);
  assert.equal(calls, 1); assert.equal(f.state.pending, true); assert.equal(f.state.released, false);
});

test('lease loss after a successful SQL response prevents new work and keeps marker', async () => {
  const f = fakeLease(); let calls = 0;
  await assert.rejects(main(ARGS, { resolveTarget: async () => TARGET, lease: f.lease,
    queryImpl: async () => { calls += 1; f.state.ready = false; return ok([]); },
    measure: ({ runSql }) => runSql('SELECT 1;') }), /unsettled/);
  assert.equal(calls, 1); assert.equal(f.state.released, false);
});

test('TEST inventory is derived from its own catalog, never from a production artifact', async () => {
  let query;
  const inventory = await loadOrgLeakInventory(TARGET, async sql => {
    query = sql; return [{ table_name: 'income_expense_types', authenticated_can_select: false }];
  }, 'Z:/nonexistent-root-no-production-inventory');
  assert.match(query, /has_table_privilege\('authenticated'/);
  assert.equal(inventory.environment, 'test'); assert.equal(inventory.projectRef, REF);
  assert.equal(inventory.source, 'live-catalog'); assert.equal(inventory.rows[0].authenticated_can_select, false);
});

test('empty, malformed or duplicate TEST permission metadata fails closed', async () => {
  const row = { table_name: 'income_expense_types', authenticated_can_select: true };
  for (const rows of [[], [{ ...row, authenticated_can_select: null }], [{ ...row, table_name: '' }], [row, row]]) {
    await assert.rejects(loadOrgLeakInventory(TARGET, async () => rows), /inventory_invalid/);
  }
});

function fixtureQuery({ failExemptions = false } = {}) {
  return async ({ ref, query }) => {
    assert.equal(ref, REF);
    if (query.includes('u.email') && query.includes('FROM public.organization_memberships')) return ok([{ uid: UID, org: ORG, email: 'private-test-user@example.invalid' }]);
    if (query.includes('AS doi_chung_duong_tong')) {
      const synthetic = query.includes('INSERT INTO auth.users');
      return ok([{ current_user: 'authenticated', rolbypassrls: false,
        auth_uid: synthetic ? SYNTHETIC_UID : UID, my_orgs: synthetic ? SYNTHETIC_ORG : ORG,
        doi_chung_duong_tong: synthetic ? 0 : 1, doi_chung_duong_ngoai: 0,
        bang: [{ bang: 'income_expense_types', tong: synthetic ? 0 : 1, ngoai: 0, tu_choi: false }] }]);
    }
    if (query.includes('AS tong;')) return ok([{ tong: 0 }]);
    if (query.includes('AS ten FROM pg_class')) return ok([{ ten: 'income_expense_types' }]);
    if (query.includes('AS ten') && query.includes('NOT EXISTS')) return ok([]);
    if (query.includes('CREATE TEMP TABLE _null_org')) return ok([{ bang: [] }]);
    if (query.includes('has_table_privilege')) return ok([{ table_name: 'income_expense_types', authenticated_can_select: true }]);
    if (query.includes('FROM pg_policy')) return ok([]);
    if (query.includes('SELECT table_name FROM app_private.org_boundary_exemptions')) {
      if (failExemptions) throw new Error('private SQL failure');
      return ok([]);
    }
    throw new Error('Unexpected fixture SQL shape');
  };
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'org-leak-target-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'generated'), { recursive: true });
  writeFileSync(join(root, 'docs', 'generated', 'org-leak-baseline.json'), 'production sentinel');
  writeFileSync(join(root, 'docs', 'generated', 'org-boundary-inventory.json'), 'invalid production JSON must never be read');
  return root;
}

test('full synthetic TEST flow writes only TEST baseline and masks fixture actor emails', async t => {
  const root = temporaryRoot(t), f = fakeLease(); const logs = [];
  t.mock.method(console, 'log', (...parts) => logs.push(parts.join(' ')));
  assert.equal(await main([...ARGS, '--write'], { root, resolveTarget: async () => TARGET,
    lease: f.lease, queryImpl: fixtureQuery() }), 0);
  const path = join(root, '.cache', 'migration-targets', 'test', REF, 'org-leak-baseline.json');
  const text = readFileSync(path, 'utf8'), result = JSON.parse(text);
  assert.equal(result.environment, 'test'); assert.equal(result.projectRef, REF);
  assert.match(result.authorizationMethod, /not an Auth JWT login/);
  assert.equal(result.inventorySource, 'live-catalog');
  assert.equal(text.includes('private-test-user'), false);
  assert.equal(logs.join('\n').includes('private-test-user'), false);
  assert.equal(readFileSync(join(root, 'docs', 'generated', 'org-leak-baseline.json'), 'utf8'), 'production sentinel');
  assert.equal(f.state.released, true);
});

test('late SQL uncertainty does not write a seemingly valid TEST baseline', async t => {
  const root = temporaryRoot(t), f = fakeLease();
  t.mock.method(console, 'log', () => {});
  await assert.rejects(main([...ARGS, '--write'], { root, resolveTarget: async () => TARGET,
    lease: f.lease, queryImpl: fixtureQuery({ failExemptions: true }) }), /exemptions_unavailable/);
  assert.equal(existsSync(join(root, '.cache', 'migration-targets', 'test', REF, 'org-leak-baseline.json')), false);
  assert.equal(f.state.pending, true); assert.equal(f.state.released, false);
});

test('query adapter does not leak raw transport details even outside the CLI wrapper', async () => {
  const adapter = createOrgLeakQuery(TARGET, { execute: fn => fn() }, async () => { throw new Error('SECRET'); });
  await assert.rejects(adapter.query('SELECT 1'), { message: 'org_leak_query_unsettled' });
  assert.throws(adapter.assertSettled, /unsettled/);
});

test('missing, malformed or leaking negative control fails with code 3 before any fixture write', async t => {
  t.mock.method(console, 'error', () => {});
  for (const rows of [[], [{}], [{ tong: null }], [{ tong: '-1' }], [{ tong: 'NaN' }],
    [{ tong: 1 }], [{ tong: 0 }, { tong: 0 }]]) {
    const root = temporaryRoot(t), f = fakeLease(), calls = [], respond = fixtureQuery();
    const result = await main([...ARGS, '--write'], { root, resolveTarget: async () => TARGET, lease: f.lease,
      queryImpl: async input => {
        calls.push(input.query);
        return input.query.includes('AS tong;') ? ok(rows) : respond(input);
      } });
    assert.equal(result, MA_THOAT_CHOT_HONG);
    assert.equal(calls.some(sql => sql.includes('INSERT INTO auth.users')), false);
    assert.equal(existsSync(join(root, '.cache', 'migration-targets', 'test', REF, 'org-leak-baseline.json')), false);
    assert.equal(f.state.released, true); // SQL settled; measurement is invalid, not an unknown write.
  }
});

test('null/missing/impossible org-column counts cannot be coerced into a clean baseline', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  for (const mutate of [
    row => { row.bang[0].tong = null; },
    row => { delete row.bang[0].ngoai; },
    row => { row.bang[0].ngoai = 'NaN'; },
    row => { row.bang[0].ngoai = -1; },
    row => { row.bang[0].ngoai = 2; },
    row => { row.bang = []; },
    row => { row.bang.push({ ...row.bang[0] }); },
    row => { row.bang[0].bang = 'unrequested_table'; },
    row => { row.doi_chung_duong_ngoai = null; },
    row => { delete row.doi_chung_duong_tong; },
    row => { row.bang[0] = { bang: 'income_expense_types', tong: null, ngoai: null, tu_choi: true }; },
    row => { delete row.bang[0].tu_choi; },
  ]) {
    const root = temporaryRoot(t), f = fakeLease(), respond = fixtureQuery();
    const result = await main([...ARGS, '--write'], { root, resolveTarget: async () => TARGET, lease: f.lease,
      queryImpl: async input => {
        const response = await respond(input);
        if (input.query.includes('AS doi_chung_duong_tong')) {
          const rows = JSON.parse(response.body); mutate(rows[0]); return ok(rows);
        }
        return response;
      } });
    assert.equal(result, MA_THOAT_CHOT_HONG);
    assert.equal(existsSync(join(root, '.cache', 'migration-targets', 'test', REF, 'org-leak-baseline.json')), false);
    assert.equal(f.state.released, true);
  }
});

test('empty org-column inventory is not a zero-table successful security measurement', async t => {
  const root = temporaryRoot(t), f = fakeLease(), respond = fixtureQuery();
  t.mock.method(console, 'error', () => {});
  const result = await main([...ARGS, '--write'], { root, resolveTarget: async () => TARGET, lease: f.lease,
    queryImpl: input => input.query.includes('AS ten FROM pg_class') ? ok([]) : respond(input) });
  assert.equal(result, MA_THOAT_CHOT_HONG);
  assert.equal(existsSync(join(root, '.cache', 'migration-targets', 'test', REF, 'org-leak-baseline.json')), false);
});

test('SQLSTATE 42501 has a distinct producer marker and is reported as denial, never visible zero', async t => {
  const root = temporaryRoot(t), f = fakeLease(), respond = fixtureQuery(); const actorSql = [];
  t.mock.method(console, 'log', () => {});
  const result = await main([...ARGS, '--write'], { root, resolveTarget: async () => TARGET, lease: f.lease,
    queryImpl: async input => {
      const response = await respond(input), rows = JSON.parse(response.body);
      if (input.query.includes('AS ten FROM pg_class')) rows.push({ ten: 'private_org_table' });
      if (input.query.includes('AS doi_chung_duong_tong')) {
        actorSql.push(input.query);
        rows[0].bang.push({ bang: 'private_org_table', tong: null, ngoai: null, tu_choi: true });
      }
      if (input.query.includes('has_table_privilege')) rows.push({ table_name: 'private_org_table', authenticated_can_select: false });
      return ok(rows);
    } });
  assert.equal(result, 0);
  for (const sql of actorSql) {
    assert.match(sql, /EXCEPTION WHEN insufficient_privilege THEN[\s\S]*?VALUES \(b, NULL, NULL, true\);/);
    assert.match(sql, /WHEN OTHERS THEN\s+INSERT INTO _kq VALUES \(b, NULL, NULL, false\);/);
    assert.match(sql, /'tu_choi',tu_choi/);
  }
  const baseline = JSON.parse(readFileSync(join(root, '.cache', 'migration-targets', 'test', REF, 'org-leak-baseline.json'), 'utf8'));
  const denied = baseline.rows.find(row => row.table_name === 'private_org_table');
  assert.equal(denied.measurement, 'DENIED'); assert.equal(denied.group, 'B_KHONG_CAP_QUYEN');
  assert.equal(denied.visible_foreign, null); assert.equal(denied.ground_truth_total, null);
  assert(Object.values(denied.theoVai).every(actor => actor.tu_choi === true));
});

async function noOrgCase(t, rows) {
  const root = temporaryRoot(t), f = fakeLease(), respond = fixtureQuery();
  const result = await main([...ARGS, '--write'], { root, resolveTarget: async () => TARGET, lease: f.lease,
    queryImpl: input => {
      if (input.query.includes('AS ten') && input.query.includes('NOT EXISTS')) return ok([{ ten: 'private_no_org' }]);
      if (input.query.includes('SELECT pg_temp._quet0();')) {
        return ok([{ current_user: 'authenticated', rolbypassrls: false,
          auth_uid: SYNTHETIC_UID, my_orgs: SYNTHETIC_ORG, bang: rows }]);
      }
      return respond(input);
    } });
  const path = join(root, '.cache', 'migration-targets', 'test', REF, 'org-leak-baseline.json');
  return { result, baseline: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null, state: f.state };
}

test('no-org missing/duplicate/unexpected rows, NULL and NaN counts fail closed', async t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const clean = { bang: 'private_no_org', tong: 0, tu_choi: false };
  for (const rows of [undefined, [], [clean, clean], [{ ...clean, bang: 'different_table' }],
    [{ ...clean, tong: null }], [{ ...clean, tong: 'NaN' }], [{ ...clean, tong: -1 }],
    [{ bang: clean.bang, tong: 0 }], [{ ...clean, tong: 1, tu_choi: true }],
    [{ ...clean, tong: undefined, tu_choi: true }]]) {
    const run = await noOrgCase(t, rows);
    assert.equal(run.result, MA_THOAT_CHOT_HONG); assert.equal(run.baseline, null);
    assert.equal(run.state.released, true);
  }
});

test('no-org 42501 denial stays explicit in report while a counted leak still blocks', async t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const denied = { bang: 'private_no_org', tong: 0, tu_choi: true };
  const run = await noOrgCase(t, [denied]);
  assert.equal(run.result, 0); assert.deepEqual(run.baseline.noOrg, [denied]);
  const leak = await noOrgCase(t, [{ ...denied, tong: 1, tu_choi: false }]);
  assert.equal(leak.result, 1); assert.equal(leak.baseline, null);
});
