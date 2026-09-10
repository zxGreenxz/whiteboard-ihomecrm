// Real PostgreSQL regression for the platform-only restore dependencies.
// Runs in the restore workflow without npm ci; every statement is rolled back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { goiPsql } from './lib/goi-psql-dich.mjs';

const target = process.env.DICH;
if (!target || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname)) {
  throw new Error('Platform shim tests require DICH pointing to an isolated loopback PostgreSQL database.');
}
const shim = readFileSync(new URL('../supabase/baseline/platform-shim.sql', import.meta.url), 'utf8');

test('platform shim supports storage row types, bucket FK, folder paths and replay without opening RLS', () => {
  const result = goiPsql(['-d', target, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    encoding: 'utf8', timeout: 30000,
    input: `BEGIN;
${shim}
${shim}
DO $test$
DECLARE stored storage.objects; rejected boolean := false;
BEGIN
  IF storage.foldername('actor/nested/proof.png') IS DISTINCT FROM ARRAY['actor','nested']::text[]
    OR storage.foldername('proof.png') IS DISTINCT FROM ARRAY[]::text[]
    OR storage.foldername(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Storage folder paths must retain the real platform semantics';
  END IF;
  INSERT INTO storage.buckets(id,name,public,file_size_limit) VALUES('restore-proof-test','restore-proof-test',false,5242880);
  INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata)
    VALUES('restore-proof-test','actor/proof.png','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','{"mimetype":"image/png"}') RETURNING * INTO stored;
  IF stored.id IS NULL OR stored.archived_at IS NOT NULL OR stored.is_delete_marker IS DISTINCT FROM false
    OR stored.owner_id IS DISTINCT FROM stored.owner::text OR stored.metadata->>'mimetype' IS DISTINCT FROM 'image/png' THEN
    RAISE EXCEPTION 'Storage composite fields/defaults do not match the required platform shape';
  END IF;
  BEGIN
    INSERT INTO storage.objects(bucket_id,name) VALUES('missing-bucket','proof.png');
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Storage object bucket FK must reject missing buckets'; END IF;
END $test$;
-- Give the probe SQL privileges only inside this rollback transaction. The
-- shim itself must not manufacture an allow-all Storage policy to pass replay.
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT,INSERT ON storage.objects,storage.buckets TO authenticated;
SET LOCAL ROLE authenticated;
DO $test$
DECLARE rejected boolean := false;
BEGIN
  IF EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='restore-proof-test')
    OR EXISTS(SELECT 1 FROM storage.buckets WHERE id='restore-proof-test') THEN
    RAISE EXCEPTION 'Platform Storage RLS must remain closed without an application policy';
  END IF;
  BEGIN
    INSERT INTO storage.objects(bucket_id,name) VALUES('restore-proof-test','unauthorized.png');
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Platform Storage RLS must deny unapproved writes'; END IF;
END $test$;
RESET ROLE;
ROLLBACK;`,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
});
