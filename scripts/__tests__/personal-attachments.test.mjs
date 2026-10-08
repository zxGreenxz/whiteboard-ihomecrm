import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const base = readFileSync(new URL('../../supabase/migrations/20261004212309_personal_finance_wallets.sql', import.meta.url), 'utf8');
const hardening = readFileSync(new URL('../../supabase/migrations/20261004212701_personal_finance_rpc_only.sql', import.meta.url), 'utf8');
const attachment = readFileSync(new URL('../../supabase/migrations/20261007155311_personal_transaction_attachments.sql', import.meta.url), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const upload = '33333333-3333-4333-8333-333333333333', bucket = 'personal-finance-attachments';
const ownPath = `${owner}/${upload}.webp`, foreignPath = `${other}/${upload}.webp`;

async function setup(sql = attachment) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA storage;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA auth,storage TO authenticated,anon;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES('${owner}'),('${other}');
    CREATE TABLE app_private.org_boundary_exemptions(table_name text PRIMARY KEY,reason text,decided_by text,expires_at date,replacement_policy text);
    CREATE TABLE public.personal_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id),type text NOT NULL,amount numeric NOT NULL,txn_date date NOT NULL,description text,category text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),deleted_at timestamptz);
    ALTER TABLE public.personal_transactions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY personal_txn_own ON public.personal_transactions FOR SELECT TO authenticated USING(user_id=auth.uid());
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,owner_id text,metadata jsonb,UNIQUE(bucket_id,name));
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated,anon;
    CREATE POLICY existing_broad_policy ON storage.objects FOR ALL TO public USING(true) WITH CHECK(true);
    INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('${bucket}','${ownPath}','${owner}'),('${bucket}','${foreignPath}','${other}');
  `);
  await db.exec(base + hardening + sql);
  return db;
}
async function as(db, actor, fn, role = 'authenticated') {
  return db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor ?? '']);
    return fn(tx);
  });
}
const snapshot = async (db, actor = owner) => as(db, actor, async tx => {
  await tx.query('SELECT public.personal_finance_bootstrap()');
  return (await tx.query('SELECT public.personal_finance_snapshot() AS value')).rows[0].value;
});
const mutate = (db, payload, actor = owner, key = crypto.randomUUID()) => as(db, actor, async tx =>
  (await tx.query('SELECT public.personal_finance_mutate($1::uuid,$2::jsonb) AS value', [key, JSON.stringify(payload)])).rows[0].value);
const inputFor = snap => ({ type: 'EXPENSE', amount: 80_000, txn_date: '2026-10-07', wallet_id: snap.wallets[0].id, category_id: snap.categories.find(c => c.seed_key === 'food').id });

test('attachments migrate twice, persist, preserve on unrelated edits and unlink without deleting file', async () => {
  const db = await setup();
  try {
    await db.exec(attachment);
    const input = inputFor(await snapshot(db));
    const key = crypto.randomUUID(), payload = { action: 'transaction.batch', rows: [{ ...input, attachment_paths: [ownPath] }] };
    const receipt = await mutate(db, payload, owner, key);
    assert.deepEqual(receipt.entities[0].attachment_paths, [ownPath]);
    assert.deepEqual(await mutate(db, payload, owner, key), receipt);
    let row = receipt.entities[0];
    row = (await mutate(db, { action: 'transaction.update', id: row.id, expected_version: row.version, data: { description: 'mới' } })).entities[0];
    assert.deepEqual(row.attachment_paths, [ownPath]);
    const omitted = (await mutate(db, { action: 'transaction.create', data: input })).entities[0];
    assert.deepEqual(omitted.attachment_paths, []);
    row = (await mutate(db, { action: 'transaction.update', id: row.id, expected_version: row.version, data: { attachment_paths: [] } })).entities[0];
    assert.deepEqual((await snapshot(db)).transactions.find(t => t.id === row.id).attachment_paths, []);
    assert.equal((await db.query('SELECT count(*)::int n FROM storage.objects WHERE name=$1', [ownPath])).rows[0].n, 1);
    assert.deepEqual(await mutate(db, payload, owner, key), receipt, 'unlink must not change original durable receipt');
  } finally { await db.close(); }
});

test('RPC rejects foreign/missing/invalid attachment references and rolls back the whole batch', async () => {
  const db = await setup();
  try {
    const input = inputFor(await snapshot(db));
    for (const paths of [[foreignPath], [`${owner}/44444444-4444-4444-8444-444444444444.jpg`], null, {}, [1], ['https://example.com/bill.jpg'], Array(21).fill(ownPath)]) {
      await assert.rejects(mutate(db, { action: 'transaction.batch', rows: [input, { ...input, attachment_paths: paths }] }));
      assert.equal((await snapshot(db)).transactions.length, 0);
    }
    await db.query('UPDATE storage.objects SET owner_id=$1 WHERE name=$2', [other, ownPath]);
    await assert.rejects(mutate(db, { action: 'transaction.create', data: { ...input, attachment_paths: [ownPath] } }));
  } finally { await db.close(); }
});

test('storage restrictive fences enforce owner access even with an existing broad permissive policy', async () => {
  const db = await setup();
  try {
    assert.deepEqual((await as(db, owner, tx => tx.query('SELECT name FROM storage.objects ORDER BY name'))).rows.map(r => r.name), [ownPath]);
    assert.equal((await as(db, null, tx => tx.query('SELECT name FROM storage.objects'), 'anon')).rows.length, 0);
    const newPath = `${owner}/55555555-5555-4555-8555-555555555555.jpg`;
    await as(db, owner, tx => tx.query('INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES($1,$2,$3)', [bucket, newPath, owner]));
    await assert.rejects(as(db, other, tx => tx.query('INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES($1,$2,$3)', [bucket, `${owner}/66666666-6666-4666-8666-666666666666.jpg`, other])));
    await assert.rejects(as(db, owner, tx => tx.query('INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES($1,$2,$3)', [bucket, `${owner}/77777777-7777-4777-8777-777777777777.jpg`, other])));
    assert.equal((await as(db, owner, tx => tx.query('DELETE FROM storage.objects WHERE name=$1 RETURNING id', [ownPath]))).rows.length, 0);
    assert.equal((await as(db, owner, tx => tx.query('UPDATE storage.objects SET metadata=$1 WHERE name=$2 RETURNING id', ['{}', ownPath]))).rows.length, 0);
    const b = (await db.query('SELECT * FROM storage.buckets WHERE id=$1', [bucket])).rows[0];
    assert.equal(b.public, false); assert.equal(b.file_size_limit, 5 * 1024 * 1024);
  } finally { await db.close(); }
});

test('attachment owner invariant kills a missing storage-owner check', async () => {
  const guard = ' AND o.owner_id=u::text';
  assert.equal(attachment.split(guard).length, 2);
  const db = await setup(attachment.replace(guard, ''));
  try {
    const input = inputFor(await snapshot(db));
    await db.query('UPDATE storage.objects SET owner_id=$1 WHERE name=$2', [other, ownPath]);
    // This is the same assertion as the real invariant above: it must turn red for this mutant.
    await assert.rejects(() => assert.rejects(mutate(db, { action: 'transaction.create', data: { ...input, attachment_paths: [ownPath] } })), { code: 'ERR_ASSERTION' });
  } finally { await db.close(); }
});

test('owner read invariant kills a missing restrictive fence', async () => {
  const from = attachment.indexOf('CREATE POLICY personal_attachment_read_fence');
  const until = attachment.indexOf(';', from) + 1;
  assert(from > 0 && until > from);
  const db = await setup(attachment.slice(0, from) + attachment.slice(until));
  try {
    const rows = (await as(db, owner, tx => tx.query('SELECT name FROM storage.objects ORDER BY name'))).rows;
    assert.throws(() => assert.deepEqual(rows.map(r => r.name), [ownPath]), { code: 'ERR_ASSERTION' });
  } finally { await db.close(); }
});
