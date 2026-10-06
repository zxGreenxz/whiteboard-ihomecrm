#!/usr/bin/env node
import { assertTestLease, withTestLock } from './test-env/lock.mjs';
// JWT/PostgREST authorization regression. Fixtures live ONLY in guarded TEST.
// Fixture setup bypasses business triggers locally; assertions never bypass RLS.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { credential, ketNoi, batBuocDichTest, congCu, psql, psqlJson, lit } from './test-env/lib.mjs';
import { matKhauTest } from './test-env/hau-ky.mjs';

export const ORIGINAL_VOUCHER_ID = '5af4bc29-6111-4d49-865b-b6894a4d9131';
export const RPC = 'read_income_expense_details_v1';
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const OTHER_ORG = 'dddd0000-0000-4000-8000-000000000001';
const REPORT = '.superpowers/sdd/2026-09-28-quyen-doc-chi-tiet-phieu/jwt-report.md';

export async function testConnection() {
  const cred = credential();
  const { test } = await ketNoi(cred);
  await batBuocDichTest(cred, test);
  assert(cred.testPublishableKey, 'TEST_SUPABASE_PUBLISHABLE_KEY required; never use service key as actor');
  return { cred, test, url: `https://${cred.testRef}.supabase.co` };
}

export async function signInTest(ctx, email, password) {
  const r = await fetch(`${ctx.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ctx.cred.testPublishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(r.status, 200, `TEST authentication HTTP ${r.status}; credentials not logged`);
  const session = await r.json();
  assert(session.access_token && session.user?.id, 'JWT session required');
  return session;
}

export async function originalTestSession(ctx) {
  const email = 'nathan@username.ihomecrm.local';
  return signInTest(ctx, email, process.env.TEST_PASS || matKhauTest(ctx.cred.passwordSeed, email));
}

export async function request(ctx, jwt, path, body, profile = 'public') {
  const start = performance.now();
  const r = await fetch(`${ctx.url}/rest/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      apikey: ctx.cred.testPublishableKey, Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json', 'Accept-Profile': profile, 'Content-Profile': profile,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json();
  return { status: r.status, ok: r.ok, json, ms: performance.now() - start };
}

const idsOf = rows => rows.map(r => r.id).sort();
const sqlIds = ids => ids.map(lit).join(',');
const replicaTransaction = (ctx, sql) => psql(ctx.test, `BEGIN; SET LOCAL session_replication_role=replica; ${sql} COMMIT;`);

export async function runHarness({ baseline = false, context, lease, reportPath = REPORT } = {}) {
  const ctx = context ?? await testConnection();
  if (!lease) return withTestLock(ctx, held => runHarness({ baseline, context: ctx, lease: held, reportPath }));
  await assertTestLease(lease, ctx.test);
  const cases = [], measures = [], coverage = {};
  const check = async (name, fn) => {
    try { await fn(); cases.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
    catch (error) { cases.push({ name, status: 'FAIL', error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
  };
  const get = async (jwt, path) => {
    const r = await request(ctx, jwt, path); assert.equal(r.status, 200, `${path.split('?')[0]} HTTP ${r.status}`); return r.json;
  };
  const read = async (jwt, ids, org = ORG) => {
    const r = await request(ctx, jwt, `rpc/${RPC}`, { p_organization_id: org, p_voucher_ids: ids });
    assert.equal(r.status, 200, `reader HTTP ${r.status}, code=${r.json?.code ?? '?'}, ids=${ids.length}, first=${ids[0] ?? 'empty'}, ms=${Math.round(r.ms)}`);
    assert(Array.isArray(r.json.rows), 'reader must return rows array'); measures.push(r.ms); return r.json.rows;
  };
  const truth = psqlJson(ctx.test, `select v.id,v.user_id,v.building_id,v.account_id,b.name building_name,
      i.id item_id,i.income_expense_type_id,i.accounting_class,i.amount::text amount,t.name type_name
    from public.income_expenses v join public.buildings b on b.id=v.building_id
    join public.income_expense_items i on i.income_expense_id=v.id
    join public.income_expense_types t on t.id=i.income_expense_type_id where v.id=${lit(ORIGINAL_VOUCHER_ID)}`);
  assert.equal(truth.length, 1, 'clone must contain the one-item original regression; no empty-fixture pass');
  const original = truth[0];
  const originalSession = await originalTestSession(ctx);
  const originalJwt = originalSession.access_token;
  let actorId;
  const fixtureIds = [], accountIds = [randomUUID(), randomUUID()];
  const membershipId = randomUUID(), bindingId = randomUUID();
  const suffix = randomBytes(6).toString('hex');
  try {
    await check('original.header-visible', async () => assert.deepEqual(idsOf(await get(originalJwt,
      `income_expenses?select=id&id=eq.${ORIGINAL_VOUCHER_ID}`)), [ORIGINAL_VOUCHER_ID]));
    await check('original.direct-items-complete', async () => assert.deepEqual(idsOf(await get(originalJwt,
      `income_expense_items?select=id&income_expense_id=eq.${ORIGINAL_VOUCHER_ID}`)), [original.item_id]));
    await check('original.building-stays-private', async () => assert.deepEqual(await get(originalJwt,
      `buildings?select=id&id=eq.${original.building_id}`), []));
    await check('original.reader-item-type-and-label', async () => {
      const rows = await read(originalJwt, [ORIGINAL_VOUCHER_ID]); assert.equal(rows.length, 1);
      assert.equal(rows[0].header.id, ORIGINAL_VOUCHER_ID); assert.equal(rows[0].building_name, original.building_name);
      assert.equal(rows[0].expected_item_count, 1); assert.equal(rows[0].items_complete, true);
      assert.deepEqual(rows[0].issues, []); assert.equal(rows[0].items[0].id, original.item_id);
      assert.equal(rows[0].items[0].type_name, original.type_name);
      assert.equal(Number(rows[0].items[0].amount), 941040); assert.equal(typeof rows[0].items[0].amount, 'string');
    });
    if (!baseline) {
      const password = `Tt!${randomBytes(20).toString('base64url')}`;
      const email = `voucher-read-${suffix}@example.invalid`;
      const created = await fetch(`${ctx.url}/auth/v1/admin/users`, {
        method: 'POST', headers: { apikey: ctx.cred.testSecretKey, Authorization: `Bearer ${ctx.cred.testSecretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      assert.equal(created.status, 200, `fixture actor creation HTTP ${created.status}`);
      actorId = (await created.json()).id; assert(actorId, 'actor id required');
      const otherBuilding = psqlJson(ctx.test, `select id from public.buildings where organization_id=${lit(OTHER_ORG)} and deleted_at is null order by id limit 1`)[0]?.id;
      assert(otherBuilding, 'cross-org fixture must have a real building');
      const fixtures = Object.fromEntries(['owner', 'possession', 'none', 'restricted', 'cross', 'zero', 'large', 'change', 'rounding', 'recipient'].map(name => [name, randomUUID()]));
      fixtureIds.push(...Object.values(fixtures));
      replicaTransaction(ctx, `
        insert into public.organization_memberships(id,organization_id,user_id,member_type,status,valid_from)
          values(${lit(membershipId)},${lit(ORG)},${lit(actorId)},'STAFF','ACTIVE',now()-interval '2 days');
        insert into public.accounts(id,organization_id,user_id,name,code) values
          (${lit(accountIds[0])},${lit(ORG)},${lit(actorId)},'JWT fixture owner',${lit(`JWT${suffix}O`)}),
          (${lit(accountIds[1])},${lit(ORG)},${lit(original.user_id)},'JWT fixture possession',${lit(`JWT${suffix}P`)});
        insert into public.cashbook_possession_bindings(id,organization_id,cashbook_id,membership_id,possession_kind,valid_from)
          values(${lit(bindingId)},${lit(ORG)},${lit(accountIds[1])},${lit(membershipId)},'CUSTODIAN',now()-interval '2 days');
        ${Object.entries(fixtures).map(([name, id]) => {
          const org = name === 'cross' ? OTHER_ORG : ORG;
          const account = ['none', 'recipient'].includes(name) ? 'NULL' : lit(name === 'possession' ? accountIds[1] : accountIds[0]);
          return `insert into public.income_expenses(id,user_id,code,type,name,building_id,voucher_date,total_amount,approval_status,organization_id,account_id,change_account_id,rounding_account_id,has_restricted_item,salary_staff_id)
          values(${lit(id)},${lit(original.user_id)},${lit(`JWT-${suffix}-${name}`)},'EXPENSE',${lit(`JWT fixture ${name}`)},${lit(name === 'cross' ? otherBuilding : original.building_id)},current_date,200,'UNAPPROVED',${lit(org)},${['change','rounding'].includes(name) ? 'NULL' : account},${name === 'change' ? account : 'NULL'},${name === 'rounding' ? account : 'NULL'},${name === 'restricted'},${name === 'recipient' ? lit(actorId) : 'NULL'});
          insert into public.income_expense_items(id,income_expense_id,income_expense_type_id,quantity,unit_price,amount,organization_id,accounting_class,start_date,end_date)
          select gen_random_uuid(),${lit(id)},${lit(original.income_expense_type_id)},1,100,100,${lit(org)},${lit(original.accounting_class)},'2026-08-01','2026-08-31' from generate_series(1,${name === 'zero' ? 0 : name === 'large' ? 1001 : 2});`;
        }).join('\n')}
      `);
      const actor = await signInTest(ctx, email, password), jwt = actor.access_token;
      const expectComplete = async (id, count = 2) => {
        const header = await get(jwt, `income_expenses?select=id&id=eq.${id}`); assert.deepEqual(idsOf(header), [id]);
        const expected = psqlJson(ctx.test, `select id from public.income_expense_items where income_expense_id=${lit(id)} order by id`);
        assert.equal(expected.length, count, 'fixture truth must be nonempty except actual-zero case');
        const rows = await read(jwt, [id]); assert.equal(rows.length, 1); const row = rows[0];
        assert.equal(row.header.id, id); assert.equal(row.expected_item_count, count); assert.equal(row.items_complete, true);
        assert.deepEqual(row.issues, []); assert.deepEqual(idsOf(row.items), idsOf(expected));
        assert.equal(row.building_name, original.building_name);
        return row;
      };
      const expectDenied = async (id, org = ORG) => {
        assert.deepEqual(await get(jwt, `income_expenses?select=id&id=eq.${id}`), []);
        assert.deepEqual(await get(jwt, `income_expense_items?select=id&income_expense_id=eq.${id}`), []);
        const r = await request(ctx, jwt, `rpc/${RPC}`, { p_organization_id: org, p_voucher_ids: [id] });
        assert(r.status === 403 || (r.status === 200 && r.json.rows?.length === 0), `denial must be 403 or empty rows; got ${r.status}`);
      };
      await check('scope.owner-other-creator', () => expectComplete(fixtures.owner));
      await check('writes.append-denied-for-read-only-actor', async () => {
        const r = await request(ctx, jwt, 'rpc/append_income_expense_supplement_v1', {
          p_voucher: fixtures.owner, p_note: 'JWT fixture forbidden append', p_attachments: [], p_idempotency_key: `jwt-${suffix}-append`,
        });
        assert.equal(r.status, 403); assert.equal(r.json.code, '42501');
        assert.equal(psqlJson(ctx.test, `select count(*)::int n from public.income_expense_supplements where income_expense_id=${lit(fixtures.owner)}`)[0].n, 0);
      });
      await check('writes.revise-denied-for-read-only-actor', async () => {
        const r = await request(ctx, jwt, 'rpc/revise_pending_income_expense_v1', {
          p_voucher: fixtures.owner, p_expected_approval_version: 1, p_patch: { name: 'JWT forbidden edit' }, p_idempotency_key: `jwt-${suffix}-revise`,
        });
        assert.equal(r.status, 403); assert.equal(r.json.code, '42501');
        assert.equal(psqlJson(ctx.test, `select name from public.income_expenses where id=${lit(fixtures.owner)}`)[0].name, 'JWT fixture owner');
      });
      await check('scope.building-and-rooms-not-expanded', async () => {
        assert.deepEqual(await get(jwt, `buildings?select=id&id=eq.${original.building_id}`), []);
        assert.deepEqual(await get(jwt, `rooms?select=id&building_id=eq.${original.building_id}`), []);
      });
      await check('scope.no-access', () => expectDenied(fixtures.none));
      await check('scope.creator-alone-denied', async () => {
        replicaTransaction(ctx, `update public.income_expenses set user_id=${lit(actorId)} where id=${lit(fixtures.none)};`);
        await expectDenied(fixtures.none);
      });
      await check('scope.restricted-denied', () => expectDenied(fixtures.restricted));
      await check('scope.cross-org-denied', () => expectDenied(fixtures.cross, OTHER_ORG));
      await check('scope.mixed-org-no-leak', async () => {
        const rows = await read(jwt, [fixtures.owner, fixtures.cross, fixtures.restricted, fixtures.none]);
        assert.deepEqual(rows.map(r => r.header.id), [fixtures.owner]);
      });
      await check('scope.salary-recipient', () => expectComplete(fixtures.recipient));
      for (const kind of ['CUSTODIAN', 'OPERATOR', 'KNOWER']) {
        await check(`scope.possession-${kind}`, async () => {
          replicaTransaction(ctx, `update public.cashbook_possession_bindings set possession_kind=${lit(kind)} where id=${lit(bindingId)};`);
          await expectComplete(fixtures.possession);
        });
      }
      for (const leg of ['change', 'rounding']) await check(`scope.${leg}-cashbook-leg`, () => expectComplete(fixtures[leg]));
      await check('scope.possession-expired-owner-remains', async () => {
        replicaTransaction(ctx, `update public.cashbook_possession_bindings set valid_to=now()-interval '1 day' where id=${lit(bindingId)};`);
        await expectDenied(fixtures.possession); await expectComplete(fixtures.owner);
      });
      await check('scope.membership-inactive', async () => {
        replicaTransaction(ctx, `update public.organization_memberships set status='SUSPENDED' where id=${lit(membershipId)};`);
        try { await expectDenied(fixtures.owner); await expectDenied(fixtures.recipient); }
        finally { replicaTransaction(ctx, `update public.organization_memberships set status='ACTIVE' where id=${lit(membershipId)};`); }
      });
      await check('scope.active-expired-membership-parent-parity', async () => {
        replicaTransaction(ctx, `update public.organization_memberships set valid_to=now()-interval '1 day',revoked_at=now()-interval '1 day' where id=${lit(membershipId)};`);
        try { await expectComplete(fixtures.owner); }
        finally { replicaTransaction(ctx, `update public.organization_memberships set valid_to=null,revoked_at=null where id=${lit(membershipId)};`); }
      });
      await check('data.actual-zero-is-complete', () => expectComplete(fixtures.zero, 0));
      await check('data.more-than-1000-items-complete', () => expectComplete(fixtures.large, 1001));
      await check('data.inner-items-filter-parent-visible', async () => {
        const rows = await get(jwt, `income_expenses?select=id,items:income_expense_items!inner(id)&id=eq.${fixtures.owner}`);
        assert.equal(rows.length, 1); assert.equal(rows[0].items.length, 2);
      });
      await check('boundary.missing-id', async () => assert.deepEqual(await read(jwt, [randomUUID()]), []));
      await check('boundary.201-ids-rejected', async () => {
        const r = await request(ctx, jwt, `rpc/${RPC}`, { p_organization_id: ORG, p_voucher_ids: Array.from({ length: 201 }, () => randomUUID()) });
        assert.equal(r.status, 400); assert.equal(r.json.code, '22023', 'reject parameter size, not missing RPC');
      });
      await check('boundary.private-helper-not-callable', async () => {
        for (const profile of ['public', 'app_private']) {
          const r = await request(ctx, jwt, 'rpc/ie_detail_metadata_v1', { p_organization_id: ORG, p_voucher_ids: [fixtures.owner, fixtures.cross] }, profile);
          assert(!r.ok && [400, 401, 403, 404, 406].includes(r.status), `private helper exposed: ${r.status}`);
        }
        const acl = psqlJson(ctx.test, `select has_function_privilege('authenticated','app_private.ie_detail_metadata_v1(uuid,uuid[])','EXECUTE') granted`);
        assert.equal(acl[0]?.granted, false);
      });
      await check('scope.owner-plus-possession-revoke-binding', async () => {
        replicaTransaction(ctx, `update public.cashbook_possession_bindings set cashbook_id=${lit(accountIds[0])},valid_to=null where id=${lit(bindingId)};`);
        await expectComplete(fixtures.owner);
        replicaTransaction(ctx, `update public.cashbook_possession_bindings set valid_to=now()-interval '1 day' where id=${lit(bindingId)};`);
        await expectComplete(fixtures.owner);
      });
      for (const invalidOrg of [null, OTHER_ORG]) {
        await check(`data.${invalidOrg ? 'mismatched' : 'null'}-item-org-incomplete`, async () => {
          const [item] = psqlJson(ctx.test, `select id from public.income_expense_items where income_expense_id=${lit(fixtures.owner)} order by id limit 1`);
          replicaTransaction(ctx, `update public.income_expense_items set organization_id=${invalidOrg ? lit(invalidOrg) : 'NULL'} where id=${lit(item.id)};`);
          try {
            const [row] = await read(jwt, [fixtures.owner]);
            assert.equal(row.expected_item_count, 2); assert.equal(row.items.length, 1);
            assert.equal(row.items_complete, false); assert(row.issues.includes('SCOPE_MISMATCH'));
            assert(row.issues.includes('ITEMS_INCOMPLETE')); assert(!row.items.some(i => i.id === item.id));
          } finally { replicaTransaction(ctx, `update public.income_expense_items set organization_id=${lit(ORG)} where id=${lit(item.id)};`); }
        });
      }
      await check('data.concurrent-header-items-same-snapshot', async () => {
        const id = fixtures.owner;
        const writer = spawn(congCu('psql'), ['-d', ctx.test, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
          env: process.env, stdio: ['pipe', 'ignore', 'pipe'],
        });
        let finished = false, stderr = '', writerError = null;
        writer.stderr.setEncoding('utf8'); writer.stderr.on('data', chunk => { stderr += chunk; });
        // Resolve lifecycle first, then assert the captured error: an early
        // subprocess failure must not become an unhandled rejection that exits
        // Node before the outer fixture cleanup can run.
        const done = new Promise(resolveDone => {
          writer.on('error', error => { finished = true; writerError = error; resolveDone(); });
          writer.on('close', code => {
            finished = true;
            if (code !== 0) writerError = new Error(`fixture writer exit ${code}: ${stderr.slice(0, 300)}`);
            resolveDone();
          });
        });
        // Keep each transaction open after changing only the header, then change
        // both items. Readers must never expose this uncommitted intermediate state.
        writer.stdin.end(Array.from({ length: 10 }, (_, index) => {
          const amount = index % 2 ? 100 : 200;
          return `BEGIN; SET LOCAL session_replication_role=replica;
            UPDATE public.income_expenses SET total_amount=${amount * 2} WHERE id=${lit(id)};
            SELECT pg_sleep(0.3);
            UPDATE public.income_expense_items SET unit_price=${amount},amount=${amount} WHERE income_expense_id=${lit(id)};
            COMMIT; SELECT pg_sleep(0.1);`;
        }).join('\n'));
        let overlap = 0;
        try {
          for (let index = 0; index < 12; index += 1) {
            const startedDuringWrite = !finished;
            const [row] = await read(jwt, [id]);
            if (startedDuringWrite && !finished) overlap += 1;
            assert.equal(row.items_complete, true); assert.equal(row.items.length, 2);
            assert.equal(Number(row.header.total_amount), row.items.reduce((sum, item) => sum + Number(item.amount), 0));
          }
          await done;
          assert.ifError(writerError);
          assert(overlap >= 2, `need >=2 reads during concurrent writer, observed ${overlap}`);
          coverage.concurrentReadsDuringWrite = overlap;
        } finally {
          await done;
          replicaTransaction(ctx, `update public.income_expenses set total_amount=200 where id=${lit(id)};
            update public.income_expense_items set unit_price=100,amount=100 where income_expense_id=${lit(id)};`);
        }
      });
      await check('original.all-visible-pagination-complete', async () => {
        const visible = [];
        for (let offset = 0; ; offset += 200) {
          const page = await get(originalJwt, `income_expenses?select=id,building_id&organization_id=eq.${ORG}&deleted_at=is.null&order=id&limit=200&offset=${offset}`);
          visible.push(...page.filter(v => !fixtureIds.includes(v.id))); if (page.length < 200) break;
          assert(offset < 100000, 'unexpected >100k visible vouchers; stop instead of unbounded scan');
        }
        assert(visible.some(v => v.id === ORIGINAL_VOUCHER_ID));
        assert.equal(new Set(visible.map(v => v.id)).size, visible.length, 'stable pagination must not duplicate ids');
        Object.assign(coverage, { actor: 'NATHAN', fixtureIdsExcluded: true, visible: visible.length, missingItems: 0, missingLabels: 0 });
        for (let start = 0; start < visible.length; start += 200) {
          const ids = visible.slice(start, start + 200).map(v => v.id);
          const expected = psqlJson(ctx.test, `select v.id,(select count(*)::int from public.income_expense_items i where i.income_expense_id=v.id) item_count,b.name building_name
            from public.income_expenses v left join public.buildings b on b.id=v.building_id and b.organization_id=v.organization_id where v.id in (${sqlIds(ids)})`);
          const rows = await read(originalJwt, ids);
          assert.deepEqual(rows.map(r => r.header.id).sort(), [...ids].sort(), 'reader cannot silently lose visible headers');
          for (const row of rows) {
            const actual = expected.find(v => v.id === row.header.id); assert(actual);
            if (row.items.length !== actual.item_count || !row.items_complete) coverage.missingItems += 1;
            if (actual.building_name !== row.building_name) coverage.missingLabels += 1;
          }
        }
        assert.equal(coverage.missingItems, 0); assert.equal(coverage.missingLabels, 0);
      });
    }
  } finally {
    if (actorId) {
      try {
      replicaTransaction(ctx, `delete from public.income_expense_supplements where income_expense_id in (${sqlIds(fixtureIds) || 'NULL'});
        delete from public.income_expense_revisions where income_expense_id in (${sqlIds(fixtureIds) || 'NULL'});
        delete from public.income_expense_items where income_expense_id in (${sqlIds(fixtureIds) || 'NULL'});
        delete from public.income_expenses where id in (${sqlIds(fixtureIds) || 'NULL'});
        delete from public.cashbook_possession_bindings where id=${lit(bindingId)};
        delete from public.accounts where id in (${sqlIds(accountIds)});
        delete from public.organization_memberships where id=${lit(membershipId)};`);
      const r = await fetch(`${ctx.url}/auth/v1/admin/users/${actorId}`, { method: 'DELETE',
        headers: { apikey: ctx.cred.testSecretKey, Authorization: `Bearer ${ctx.cred.testSecretKey}` } });
      assert.equal(r.status, 200, `fixture actor cleanup HTTP ${r.status}`);
      assert.equal(psqlJson(ctx.test, `select count(*)::int n from public.income_expenses where id in (${sqlIds(fixtureIds) || 'NULL'})`)[0].n, 0);
      } catch (error) {
        cases.push({ name: 'fixture.cleanup', status: 'FAIL', error: `${error.message}; fixture actor ${actorId}` });
        console.log(`FAIL fixture.cleanup: ${error.message}; fixture actor ${actorId}`);
      }
    }
    const sorted = measures.sort((a, b) => a - b);
    const report = `# JWT voucher detail read — ${baseline ? 'RED baseline' : 'TEST'}\n\nDate: ${new Date().toISOString()}\n\n` +
      `Target: guarded ihomecrm-test; real JWT + PostgREST; no production writes.\nFixture setup/cleanup uses transaction-local replica mode to avoid financial/notifier triggers; this suite does not certify the full writer matrix.\n\n` +
      cases.map(c => `- ${c.status}: ${c.name}${c.error ? ` — ${c.error.replaceAll('\n', ' ').slice(0, 600)}` : ''}`).join('\n') +
      `\n\nReader latency p95 (${sorted.length} samples): ${sorted.length ? `${sorted[Math.ceil(sorted.length * .95) - 1].toFixed(1)} ms` : 'not measured'}.\n\n` +
      `Coverage: ${JSON.stringify(coverage)}.\n\n` +
      `RED baseline before schema: original header=1, direct items=0 (expected item 6c3035b2-7f98-49a8-b5fb-216a43423461), direct building=0; reader HTTP404/PGRST202.\n\n` +
      `Not verified here: approval/cancellation and legacy writer RPC matrix, financial writer CAS/concurrent revision, shareholder/profit-manager recipients, storage download. Concurrent snapshot test only changes isolated fixture header/items atomically; it does not certify financial writer concurrency. ACTIVE membership with expired timestamps intentionally follows current header semantics and remains a separate hardening gap.\n`;
    const path = resolve(reportPath); mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `\n\n---\n\n${report}`);
  }
  const failed = cases.filter(c => c.status === 'FAIL');
  assert.equal(failed.length, 0, `${failed.length}/${cases.length} authorization cases failed; see ${REPORT}`);
  return { passed: cases.length, report: reportPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args[0] !== '--env' || args[1] !== 'test' || args.slice(2).some(a => a !== '--baseline')) {
    console.error('Usage: node scripts/test-voucher-detail-read-authz.mjs --env test [--baseline]');
    process.exitCode = 1;
  } else {
    runHarness({ baseline: args.includes('--baseline') }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
