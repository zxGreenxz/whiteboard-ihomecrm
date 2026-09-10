// Prepares a reviewable, ROLLBACK-only metadata repair. Never connects to a database.
// Production application still requires PROJECT_CONTRACT.md §4 backup/provenance.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
export const marker = 'voucher_image_access_repair_20260910';

export function prepareRepair(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) throw new Error('Empty evidence');
  const keys = new Set();
  const rows = evidence.map(x => {
    const l = x.original_link;
    const v = x.vouchers?.[0];
    if (!l || l.bucket_id !== 'income-expense-attachments' ||
        l.organization_id !== null || l.derivation !== 'quarantine' ||
        !uuid.test(l.owner_user_id) || !uuid.test(x.storage_object_id) ||
        x.storage_owner !== l.owner_user_id || x.object_name !== l.object_name ||
        !x.object_name.startsWith(`${l.owner_user_id}/`) ||
        x.archived_at !== null || x.is_delete_marker !== false || x.is_supplement !== false ||
        !Number.isFinite(Date.parse(l.created_at)) ||
        x.vouchers?.length !== 1 || !uuid.test(v?.id) || !uuid.test(v?.org) || v.deleted !== null ||
        !Array.isArray(x.finance_evidence) || x.finance_evidence.length > 1 ||
        (x.finance_evidence.length === 1 && (x.finance_evidence[0].org !== v.org ||
          !['ATTACHED', 'FINALIZED'].includes(x.finance_evidence[0].state)))) {
      throw new Error(`Evidence is incomplete, protected, or ambiguous: ${x.object_name}`);
    }
    if (keys.has(x.object_name)) throw new Error('Duplicate object');
    keys.add(x.object_name);
    // NONE must be an explicit empty snapshot, never missing evidence. The unique
    // existing voucher is authoritative; this repair does not fabricate finance rows.
    return [x.object_name, x.storage_object_id, v.id, v.org, l.owner_user_id, l.created_at,
      x.finance_evidence[0]?.state ?? 'NONE'];
  }).sort((a, b) => a[0].localeCompare(b[0]));
  const values = rows.map(r => `    (${r.map(quote).join(', ')})`).join(',\n');
  return `-- REVIEW DRAFT: ${rows.length} verified images; metadata only; no policy/function changes.
-- Snapshot: tryymsxyyckgbrmmvozx, 2026-09-10. Obtain fresh backup/provenance before applying.
-- Final ROLLBACK is intentional. This file does not authorize a production write.
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $repair$
DECLARE
  r record;
  obj storage.objects;
  link app_private.storage_object_links;
  voucher public.income_expenses;
  stored_url text;
  changed integer;
  repaired integer := 0;
  already_repaired integer := 0;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Administrative reviewed repair required' USING ERRCODE='42501';
  END IF;
  FOR r IN SELECT * FROM (VALUES
${values}
  ) expected(object_name, object_id, voucher_id, org_id, owner_id, link_created_at, evidence_state)
  ORDER BY object_name LOOP
    stored_url := 'https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/income-expense-attachments/' || r.object_name;
    SELECT * INTO voucher FROM public.income_expenses WHERE id=r.voucher_id::uuid FOR SHARE;
    IF NOT FOUND OR voucher.organization_id IS DISTINCT FROM r.org_id::uuid
       OR voucher.deleted_at IS NOT NULL
       OR NOT COALESCE(voucher.attachments @> jsonb_build_array(stored_url), false) THEN
      RAISE EXCEPTION 'Voucher changed: %', r.object_name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.income_expenses v
       WHERE v.attachments @> jsonb_build_array(stored_url)
         AND v.organization_id IS DISTINCT FROM r.org_id::uuid) THEN
      RAISE EXCEPTION 'Cross-organization reference: %', r.object_name;
    END IF;
    IF (SELECT count(*) FROM public.income_expenses v
        WHERE v.attachments @> jsonb_build_array(stored_url)) <> 1 THEN
      RAISE EXCEPTION 'Voucher reference is no longer unique: %', r.object_name;
    END IF;
    SELECT * INTO obj FROM storage.objects
      WHERE bucket_id='income-expense-attachments' AND name=r.object_name FOR SHARE;
    IF NOT FOUND OR obj.id IS DISTINCT FROM r.object_id::uuid
       OR COALESCE(obj.owner_id,obj.owner::text) IS DISTINCT FROM r.owner_id
       OR obj.archived_at IS NOT NULL OR obj.is_delete_marker IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Storage identity changed: %', r.object_name;
    END IF;
    IF app_private.ie_storage_is_supplement_v1('income-expense-attachments',r.object_name) THEN
      RAISE EXCEPTION 'Protected supplement: %', r.object_name;
    END IF;
    PERFORM 1 FROM public.finance_evidence_objects f
      WHERE f.bucket_id='income-expense-attachments' AND f.object_name=r.object_name FOR SHARE;
    IF r.evidence_state = 'NONE' THEN
      IF EXISTS (SELECT 1 FROM public.finance_evidence_objects f
          WHERE f.bucket_id='income-expense-attachments' AND f.object_name=r.object_name) THEN
        RAISE EXCEPTION 'Finance evidence appeared since review: %', r.object_name;
      END IF;
    ELSIF (SELECT count(*) FROM public.finance_evidence_objects f
          WHERE f.bucket_id='income-expense-attachments' AND f.object_name=r.object_name) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.finance_evidence_objects f
          WHERE f.bucket_id='income-expense-attachments' AND f.object_name=r.object_name
            AND f.organization_id=r.org_id::uuid AND f.state=r.evidence_state) THEN
      RAISE EXCEPTION 'Finance evidence changed or quarantined: %', r.object_name;
    END IF;
    SELECT * INTO link FROM app_private.storage_object_links
      WHERE bucket_id='income-expense-attachments' AND object_name=r.object_name FOR UPDATE;
    IF NOT FOUND OR link.owner_user_id IS DISTINCT FROM r.owner_id::uuid
       OR link.created_at IS DISTINCT FROM r.link_created_at::timestamptz THEN
      RAISE EXCEPTION 'Access link identity changed: %', r.object_name;
    END IF;
    IF link.organization_id=r.org_id::uuid AND link.derivation='${marker}' THEN
      already_repaired := already_repaired + 1;
      CONTINUE;
    END IF;
    IF link.organization_id IS NOT NULL OR link.derivation <> 'quarantine' THEN
      RAISE EXCEPTION 'Access link already classified: %', r.object_name;
    END IF;
    UPDATE app_private.storage_object_links SET organization_id=r.org_id::uuid, derivation='${marker}'
      WHERE bucket_id='income-expense-attachments' AND object_name=r.object_name
        AND organization_id IS NULL AND derivation='quarantine'
        AND owner_user_id=r.owner_id::uuid AND created_at=r.link_created_at::timestamptz;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'Concurrent link change: %', r.object_name; END IF;
    repaired := repaired + 1;
  END LOOP;
  IF repaired + already_repaired <> ${rows.length} THEN RAISE EXCEPTION 'Repair count mismatch'; END IF;
  RAISE NOTICE 'Repaired %, already repaired %', repaired, already_repaired;
END $repair$;
ROLLBACK;
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node prepare-repair.mjs evidence.json review.sql');
  const sql = prepareRepair(JSON.parse(readFileSync(input, 'utf8')));
  writeFileSync(output, sql, { flag: 'wx' });
  console.log('Created ROLLBACK-only SQL for review. No database connection or write performed.');
}
