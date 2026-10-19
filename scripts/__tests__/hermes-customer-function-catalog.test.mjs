import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from '../../infra/hermes-broker/customer-action-fixture.mjs';
import { verifyCustomerFunctionCatalog, splitHermesFunctionStatements } from '../hermes-task-function-contract.mjs';

const path = 'supabase/migrations/20261014104442_hermes_customer_lead_create_action_v1.sql';
const source = () => ({ path, bytes: readFileSync(path) });
async function fixture(t) {
  const { db } = await setup(t);
  const pool = { async connect() { return { query: (...args) => db.query(...args), release() {} }; } };
  return { db, pool, verify: () => verifyCustomerFunctionCatalog(pool, [source()]) };
}

test('customer catalog verifies all five functions and private receipt boundary', { timeout: 60000 }, async t => {
  const { db, verify } = await fixture(t);
  const before = (await db.query('SHOW search_path')).rows;
  await verify();
  assert.deepEqual((await db.query('SHOW search_path')).rows, before);
});

test('customer metadata successor is path/body bound and keeps STABLE, owner and execute checks', { timeout: 60000 }, async t => {
  const { db, pool } = await fixture(t);
  const path = 'supabase/migrations/20261019034254_hermes_metadata_read_snapshot_v1.sql';
  const bytes = readFileSync(path), candidate = { path, bytes };
  const declaration = splitHermesFunctionStatements(bytes.toString('utf8')).find(statement =>
    statement.includes('CREATE OR REPLACE FUNCTION public.hermes_customer_create_capabilities_v1('));
  assert(declaration); await db.exec(declaration);
  const verify = next => verifyCustomerFunctionCatalog(pool, [source(), next ?? candidate]);
  await verify();
  await assert.rejects(verify({ ...candidate, path: path.replace('metadata_read_snapshot', 'unreviewed') }), { code: 'live_customer_definition_mismatch' });
  const changed = bytes.toString('utf8').replace('DECLARE member jsonb;context jsonb;policy', 'DECLARE  member jsonb;context jsonb;policy');
  assert.notEqual(changed, bytes.toString('utf8'));
  await assert.rejects(verify({ ...candidate, bytes: Buffer.from(changed) }), { code: 'live_customer_body_mismatch' });
  for (const [change, undo, code] of [
    ['VOLATILE', 'STABLE', 'live_customer_definition_mismatch'],
  ]) {
    await db.exec('ALTER FUNCTION public.hermes_customer_create_capabilities_v1(uuid) ' + change);
    await assert.rejects(verify(), { code });
    await db.exec('ALTER FUNCTION public.hermes_customer_create_capabilities_v1(uuid) ' + undo);
  }
  await db.exec('GRANT EXECUTE ON FUNCTION public.hermes_customer_create_capabilities_v1(uuid) TO service_role');
  await assert.rejects(verify(), { code: 'live_customer_acl_mismatch' });
});

test('customer SQL-standard body and invoker mode mutations are rejected', { timeout: 60000 }, async t => {
  const { db, verify } = await fixture(t);
  const original = (await db.query('SELECT pg_get_functiondef($1::regprocedure) definition', ['public.hermes_customer_create_action_v1(jsonb,text,text,jsonb)'])).rows[0].definition;
  await db.exec(original.replace('p_binding, p_kind, p_operation, p_input', 'p_binding, COALESCE(p_kind,p_kind), p_operation, p_input'));
  await assert.rejects(verify(), { code: 'live_customer_sql_standard_body_mismatch' });
  await db.exec(original);
  await verify();
  await db.exec('ALTER FUNCTION app_private.hermes_customer_insert_v1(jsonb) SECURITY DEFINER');
  await assert.rejects(verify(), { code: 'live_customer_definition_mismatch' });
  await db.exec('ALTER FUNCTION app_private.hermes_customer_insert_v1(jsonb) SECURITY INVOKER');
  await verify();
});

test('customer execute ACL and receipt RLS mutations are rejected', { timeout: 60000 }, async t => {
  const { db, verify } = await fixture(t);
  await db.exec('GRANT EXECUTE ON FUNCTION public.hermes_customer_create_action_v1(jsonb,text,text,jsonb) TO service_role');
  await assert.rejects(verify(), { code: 'live_customer_acl_mismatch' });
  await db.exec('REVOKE EXECUTE ON FUNCTION public.hermes_customer_create_action_v1(jsonb,text,text,jsonb) FROM service_role');
  await verify();
  await db.exec('ALTER TABLE app_private.hermes_customer_create_receipts DISABLE ROW LEVEL SECURITY');
  await assert.rejects(verify(), { code: 'live_customer_private_boundary_mismatch' });
  await db.exec('ALTER TABLE app_private.hermes_customer_create_receipts ENABLE ROW LEVEL SECURITY');
  await verify();
});
