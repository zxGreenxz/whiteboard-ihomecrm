import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = new URL('../../supabase/migrations/20260906165423_copilot_9router_vps_gemini_v1.sql', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('../../tooling/copilot-provider-catalog.json', import.meta.url), 'utf8'));
const selected = catalog.providers.find(p => p.provider === '9router');

async function setup() {
  const db = new PGlite();
  // Same provider PK/columns as the backend seed plus the later org column.
  // Install the real pricing trigger, so the migration must satisfy its contract.
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE public.ai_providers (
      provider text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false,
      label text NOT NULL, models jsonb NOT NULL DEFAULT '[]', default_model text,
      data_class text NOT NULL DEFAULT 'cloud' CHECK (data_class IN ('cloud','local_only')),
      updated_at timestamptz NOT NULL DEFAULT now(), organization_id uuid
    );`);
  await db.exec(readFileSync(new URL('../../supabase/migrations/20260829080000_copilot_provider_pricing_policy_v1.sql', import.meta.url), 'utf8'));
  return db;
}

const rows = async db => (await db.query('SELECT * FROM public.ai_providers ORDER BY provider')).rows;
const apply = db => db.exec(readFileSync(migration, 'utf8'));

test('Gemini VPS migration seeds an empty catalog with the same models as the policy contract', async () => {
  const db = await setup();
  try {
    await apply(db);
    const result = await rows(db);
    assert.equal(result.length, 1, 'must seed the global 9router provider');
    const p = result[0];
    assert.equal(p.provider, '9router');
    assert.equal(p.organization_id, null);
    assert.equal(p.enabled, true);
    assert.equal(p.data_class, 'cloud');
    assert.equal(p.default_model, selected.default_model);
    assert.deepEqual(p.models.map(({ label, ...m }) => m), selected.models);
    assert.ok(p.models.every(m => typeof m.label === 'string' && m.label.length > 0));
  } finally { await db.close(); }
}, 15_000);

test('Gemini VPS migration replaces stale cx once, keeps unrelated providers and is idempotent across commits', async () => {
  const db = await setup();
  try {
    await db.exec(`INSERT INTO public.ai_providers(provider,label,enabled,models,default_model,updated_at) VALUES
      ('9router','Old VPS',true,'[{"id":"cx/old","input_price":0,"output_price":0,"pricing_mode":"self_hosted"}]','cx/old','2026-01-01'),
      ('unrelated','Leave unchanged',true,'[{"id":"other","input_price":1,"output_price":2,"pricing_mode":"metered"}]','other','2026-01-01');`);
    const unrelated = (await rows(db)).find(p => p.provider === 'unrelated');
    await apply(db);
    const first = await rows(db);
    assert.deepEqual(first.find(p => p.provider === '9router').models.map(m => m.id), selected.models.map(m => m.id));
    assert.deepEqual(first.find(p => p.provider === 'unrelated'), unrelated);
    await apply(db);
    assert.deepEqual(await rows(db), first, 'second committed application must not even touch updated_at');
  } finally { await db.close(); }
}, 15_000);

test('Gemini VPS migration refuses a 9router row unexpectedly scoped to an organization', async () => {
  const db = await setup();
  try {
    await db.exec(`INSERT INTO public.ai_providers(provider,label,organization_id)
      VALUES ('9router','Unexpected org config','dddd0000-0000-4000-8000-000000000001');`);
    const before = await rows(db);
    await assert.rejects(apply(db), /9router must be a global provider/);
    await db.exec('ROLLBACK');
    assert.deepEqual(await rows(db), before);
  } finally { await db.close(); }
}, 15_000);
