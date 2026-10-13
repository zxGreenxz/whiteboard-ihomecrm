import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseMigrationTargetArgs, resolveMigrationTarget, migrationTargetArgs, migrationTargetPaths,
  assertMigrationArtifactTarget, verifyTestMigrationMarker, withMigrationLease, PRODUCTION_REF } from '../lib/migration-target.mjs';
import { main, docManifestBackup, chupVanTayCatalog } from '../apply-reviewed-migration.mjs';
import { bienNhanTheoSha } from '../generate-migration-provenance.mjs';

const TEST_REF = 'abcdefghijklmnopqrst';
const TARGET = Object.freeze({ environment: 'test', projectRef: TEST_REF, pat: 'fixture-test-pat' });
const PROD = Object.freeze({ environment: 'prod', projectRef: PRODUCTION_REF });
const noProd = () => { throw new Error('production_reader_called'); };
const fullBackup = { projectRef: TEST_REF, environment: 'test', kind: 'full', tablesWithData: 565,
  excludedTableData: [], sha256: 'a'.repeat(64), file: 'fixture.dump', createdAt: '2026-10-12T00:00:00Z' };

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'migration-target-'));
  t.after(() => {
    assert(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert(resolve(root).includes('migration-target-'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('target flags are explicit, duplicate/invalid flags never fall back to production', () => {
  assert.deepEqual(parseMigrationTargetArgs([]), { environment: 'prod', expectedProjectRef: undefined });
  assert.equal(parseMigrationTargetArgs(['--env', 'test']).environment, 'test');
  for (const args of [['--env'], ['--env', 'staging'], ['--env=test'], ['--env', 'test', '--env', 'prod'],
    ['--expected-project-ref', '../prod']]) assert.throws(() => parseMigrationTargetArgs(args));
});

test('TEST resolution reads TEST credentials only and freezes the resolved target', async () => {
  const names = [];
  const values = { TEST_SUPABASE_REF: TEST_REF, TEST_SUPABASE_PAT: 'test-pat',
    TEST_SUPABASE_DB_PASSWORD: 'test-password', TEST_SUPABASE_POOLER_HOST: 'pooler.test.invalid' };
  const target = await resolveMigrationTarget(parseMigrationTargetArgs(['--env', 'test']), {
    env: {}, needsDatabase: true, readProdRef: noProd, readProdPat: noProd, readProdPassword: noProd,
    readValue: name => { names.push(name); assert(name.startsWith('TEST_')); return values[name]; },
    resolveDatabase: async env => ({ ref: env.TEST_SUPABASE_REF, user: `postgres.${env.TEST_SUPABASE_REF}`,
      host: env.TEST_SUPABASE_POOLER_HOST, port: 5432, password: env.TEST_SUPABASE_DB_PASSWORD }),
  });
  assert.equal(target.projectRef, TEST_REF);
  assert.equal(target.database.password, 'test-password');
  assert(names.includes('TEST_SUPABASE_PAT'));
  assert(Object.isFrozen(target) && Object.isFrozen(target.database));
  assert.throws(() => { target.projectRef = PRODUCTION_REF; }, TypeError);
});

test('target mismatch refuses before loading a PAT or database credentials', async () => {
  for (const options of [{ environment: 'test', expectedProjectRef: 'zzzzzzzzzzzzzzzzzzzz' }, { environment: 'prod' }]) {
    await assert.rejects(resolveMigrationTarget(options, { env: { TEST_SUPABASE_REF: TEST_REF },
      readProdRef: () => TEST_REF, readProdPat: noProd, readProdPassword: noProd,
      readValue: noProd, resolveDatabase: noProd }), /mismatch/);
  }
  await assert.rejects(resolveMigrationTarget({ environment: 'test' }, {
    env: { TEST_SUPABASE_REF: PRODUCTION_REF }, readValue: noProd,
  }), /environment_ref_mismatch/);
});

test('a database configuration cannot silently point to a different project', async () => {
  await assert.rejects(resolveMigrationTarget({ environment: 'test' }, {
    env: { TEST_SUPABASE_REF: TEST_REF, TEST_SUPABASE_PAT: 'p', TEST_SUPABASE_DB_PASSWORD: 'pw', TEST_SUPABASE_POOLER_HOST: 'h' },
    needsDatabase: true, readValue: noProd,
    resolveDatabase: async () => ({ ref: PRODUCTION_REF, user: `postgres.${PRODUCTION_REF}`, password: 'pw', host: 'h', port: 5432 }),
  }), /database_target_mismatch/);
});

test('default production still resolves the linked production ref and legacy credentials', async () => {
  const target = await resolveMigrationTarget(parseMigrationTargetArgs([]), { env: {}, readValue: noProd,
    readProdRef: () => PRODUCTION_REF, readProdPat: () => 'legacy-pat' });
  assert.equal(target.pat, 'legacy-pat');
  assert.equal(target.projectRef, PRODUCTION_REF);
});

test('TEST artifacts have isolated paths and cannot authorize production provenance', () => {
  const root = resolve('fixture-root');
  const paths = migrationTargetPaths(TARGET, root);
  assert(paths.inventory.includes(join('.cache', 'migration-targets', 'test', TEST_REF)));
  assert.notEqual(paths.evidence, migrationTargetPaths(PROD, root).evidence);
  const receipt = { ...fullBackup, file: 'migration.sql' };
  assert.equal(bienNhanTheoSha([receipt], PROD).size, 0);
  assert.equal(bienNhanTheoSha([receipt], TARGET).size, 1);
  assert.equal(bienNhanTheoSha([{ ...receipt, projectRef: PRODUCTION_REF }], PROD).size, 0);
  assert.equal(bienNhanTheoSha([{ ...receipt, projectRef: PRODUCTION_REF, environment: undefined }], PROD).size, 1);
  assert.throws(() => assertMigrationArtifactTarget({ ...receipt, environment: undefined }, TARGET), /environment/);
});

test('backup manifest is rejected on wrong project or environment despite a valid dump', () => {
  const read = manifest => docManifestBackup('BACKUP_MANIFEST=f.json', () => JSON.stringify(manifest), () => true, TARGET);
  assert.equal(read(fullBackup).ok, true);
  assert.equal(read({ ...fullBackup, projectRef: PRODUCTION_REF }).ok, false);
  assert.equal(read({ ...fullBackup, environment: 'prod' }).ok, false);
});

test('catalog subprocess receives the bound target and rejects a wrong-project fresh inventory', t => {
  const root = temporaryRoot(t);
  mkdirSync(join(root, 'scripts'));
  const paths = migrationTargetPaths(TARGET, root);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(join(root, 'scripts', 'capture-production-catalog.mjs'), `
    import assert from 'node:assert/strict'; import { writeFileSync } from 'node:fs';
    assert.deepEqual(process.argv.slice(2), ['--write', ...${JSON.stringify(migrationTargetArgs(TARGET))}]);
    writeFileSync(${JSON.stringify(paths.inventory)}, JSON.stringify({ projectRef: '${PRODUCTION_REF}',
      environment: 'prod', catalogFingerprint: 'fresh', counts: {} }));
  `);
  const result = chupVanTayCatalog({ captureRoot: root, target: TARGET });
  assert.equal(result.ok, false);
  assert.match(result.vi, /project_mismatch/);
});

test('missing/mismatched TEST markers reject without creating a marker or acquiring a lease', async () => {
  let calls = 0;
  await assert.rejects(verifyTestMigrationMarker(TARGET, { query: async () => { calls++; return [{ marker: false }]; } }), /existing_test/);
  assert.equal(calls, 1);
  await assert.rejects(verifyTestMigrationMarker(TARGET, { query: async sql => sql.includes('to_regclass')
    ? [{ marker: true, lease_marker: true }] : [{ ref: PRODUCTION_REF }] }), /marker_target_mismatch/);
});

function fakeLease() {
  const state = { writes: 0, pending: false, released: false, ready: true };
  const deps = {
    test: 'fixture-test-uri', cred: {},
    query: async sql => sql.includes('to_regclass') ? [{ marker: true, lease_marker: true }] : [{ ref: TEST_REF }],
    withTestLock: async (_context, work) => { try { return await work({}); } finally { state.released = !state.pending; } },
    assertTestLease: async () => { assert(state.ready, 'lease_lost'); },
    markTestCleanupRequired: () => { state.pending = true; state.writes++; },
    withTestCleanup: async (_lease, _test, settle) => { await settle({}); state.pending = false; },
  };
  return { state, deps };
}

test('TEST write uncertainty retains the lease marker; a confirmed rollback settles it', async () => {
  for (const outcome of ['throw', 'http500', 'ok']) {
    const { state, deps } = fakeLease();
    const run = withMigrationLease(TARGET, guard => guard.execute(async () => {
      if (outcome === 'throw') throw new Error('timeout');
      return { ok: outcome === 'ok' };
    }), deps);
    if (outcome === 'throw') await assert.rejects(run, /timeout/); else await run;
    assert.equal(state.writes, 1);
    assert.equal(state.released, outcome === 'ok');
  }
});

test('lease loss prevents a new dispatched write', async () => {
  const { state, deps } = fakeLease();
  state.ready = false;
  await assert.rejects(withMigrationLease(TARGET, guard => guard.execute(noProd), deps), /lease_lost/);
  assert.equal(state.writes, 0);
});

function laneFixture(t, { backup = fullBackup, catalogFails = false, queryFails = false } = {}) {
  const root = temporaryRoot(t);
  mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true });
  const file = 'supabase/migrations/20261012120000_test_target.sql';
  const sql = "BEGIN;\nSELECT 'target fixture';\nCOMMIT;\n";
  writeFileSync(join(root, file), sql);
  writeFileSync(join(root, 'supabase', 'migration-policy.json'), JSON.stringify({ provisionalCutoff: { version: '20260805120000' } }));
  writeFileSync(join(root, 'supabase', 'migration-provenance.json'), JSON.stringify({ entries: [{ path: file,
    sha256: createHash('sha256').update(sql).digest('hex') }] }));
  const manifestPath = join(root, 'backup.json');
  writeFileSync(manifestPath, JSON.stringify(backup));
  const observed = { queries: [], backups: 0, captures: 0 };
  const { deps, state } = fakeLease();
  return { root, file, observed, state, options: {
    root, resolveTarget: async options => { assert.equal(options.environment, 'test'); return TARGET; },
    lease: (target, work) => withMigrationLease(target, work, deps),
    query: async request => {
      assert.equal(request.ref, TEST_REF); assert.equal(request.pat, TARGET.pat);
      observed.queries.push(request.query);
      return { ok: !queryFails, status: queryFails ? 500 : 200, body: '[]' };
    },
    spawn: (_command, args) => {
      if (args[0].endsWith('backup-before-schema.mjs')) {
        observed.backups++;
        assert.deepEqual(args.slice(-4), migrationTargetArgs(TARGET));
        return { status: 0, stdout: `BACKUP_MANIFEST=${manifestPath}\n` };
      }
      return { status: 0, stdout: 'fixture' };
    },
    capture: ({ target }) => {
      assert.equal(target, TARGET); observed.captures++;
      return { ok: !catalogFails, fingerprint: 'f'.repeat(64), counts: {}, vi: 'fixture_catalog_failure' };
    },
  } };
}

test('actual dry-run path dispatches one ROLLBACK transaction to TEST, with no backup or production evidence', async t => {
  const f = laneFixture(t);
  assert.equal(await main(['node', 'runner', f.file, '--env', 'test'], f.options), 0);
  assert.equal(f.observed.queries.length, 1);
  assert.match(f.observed.queries[0], /ROLLBACK;$/);
  assert.doesNotMatch(f.observed.queries[0], /^COMMIT;$/m);
  assert.equal(f.observed.backups, 0);
  assert.equal(f.observed.captures, 0);
  assert.equal(f.state.released, true);
  assert.equal(existsSync(join(f.root, 'docs', 'generated')), false);
});

test('actual apply path binds idempotency, backup, catalog, commit and isolated evidence to TEST', async t => {
  const f = laneFixture(t);
  assert.equal(await main(['node', 'runner', f.file, '--env', 'test', '--apply'], f.options), 0);
  assert.equal(f.observed.queries.length, 2);
  assert.equal(f.observed.queries[0].match(/SELECT 'target fixture';/g).length, 2);
  assert.match(f.observed.queries[0], /ROLLBACK;$/);
  assert.match(f.observed.queries[1], /COMMIT;$/);
  assert.equal(f.observed.backups, 1);
  assert.equal(f.observed.captures, 2);
  const path = join(migrationTargetPaths(TARGET, f.root).evidence, '20261012120000_test_target.json');
  const evidence = JSON.parse(readFileSync(path));
  assertMigrationArtifactTarget(evidence, TARGET);
  assert.equal(evidence.evidenceComplete, true);
  assert.equal(bienNhanTheoSha([evidence], PROD).size, 0);
  assert.equal(existsSync(join(f.root, 'docs', 'generated')), false);
});

test('TEST uses target provenance without requiring a production catalog refresh; wrong target is rejected', async t => {
  const f = laneFixture(t);
  const sourcePath = join(f.root, 'supabase', 'migration-provenance.json');
  const manifest = JSON.parse(readFileSync(sourcePath));
  const paths = migrationTargetPaths(TARGET, f.root);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(sourcePath, JSON.stringify({ entries: [] }));
  writeFileSync(paths.provenance, JSON.stringify({ ...manifest, environment: 'test', projectRef: TEST_REF }));
  assert.equal(await main(['node', 'runner', f.file, '--env', 'test'], f.options), 0);
  writeFileSync(paths.provenance, JSON.stringify({ ...manifest, environment: 'test', projectRef: PRODUCTION_REF }));
  await assert.rejects(main(['node', 'runner', f.file, '--env', 'test'], f.options), /project_mismatch/);
  assert.equal(f.observed.queries.length, 1);
});

test('preflight failure, wrong backup, or failed catalog each stop before COMMIT', async t => {
  for (const options of [{ queryFails: true }, { backup: { ...fullBackup, projectRef: PRODUCTION_REF } }, { catalogFails: true }]) {
    const f = laneFixture(t, options);
    assert.equal(await main(['node', 'runner', f.file, '--env', 'test', '--apply'], f.options), 1);
    assert.equal(f.observed.queries.length, 1);
    assert.match(f.observed.queries[0], /ROLLBACK;$/);
    if (options.queryFails) { assert.equal(f.observed.backups, 0); assert.equal(f.state.released, false); }
  }
});
