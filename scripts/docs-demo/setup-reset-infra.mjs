#!/usr/bin/env node
/**
 * Dựng hạ tầng RESET sandbox (idempotent — chạy lại được):
 *   - schema demo_snapshot
 *   - bảng config demo_reset_tables (seq, tbl, predicate, restore) — seed từ tables.mjs
 *   - bảng demo_reset_log (audit + cooldown)
 *   - function public.demo_reset() SECURITY DEFINER (advisory lock, cooldown 10',
 *     tripwire fail-closed, DELETE theo config, RESTORE ngược thứ tự từ snapshot,
 *     verify count từng bảng — lệch là ROLLBACK toàn bộ)
 *   - GRANT: chỉ service_role được EXECUTE
 *
 * Chạy: node scripts/docs-demo/setup-reset-infra.mjs
 */
import { runSql } from './lib.mjs'
import { RESET_TABLES } from './tables.mjs'

const configRows = RESET_TABLES.map(
  (r, i) => `(${(i + 1) * 10}, '${r.tbl}', ${`'${r.predicate.replace(/'/g, "''")}'`}, ${r.restore})`
).join(',\n  ')

const SQL = `
CREATE SCHEMA IF NOT EXISTS demo_snapshot;

CREATE TABLE IF NOT EXISTS public.demo_reset_tables (
  seq int PRIMARY KEY,
  tbl text NOT NULL,
  predicate text NOT NULL,
  restore boolean NOT NULL DEFAULT true
);
ALTER TABLE public.demo_reset_tables ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.demo_reset_tables FROM PUBLIC, anon, authenticated;

TRUNCATE public.demo_reset_tables;
INSERT INTO public.demo_reset_tables (seq, tbl, predicate, restore) VALUES
  ${configRows};

CREATE TABLE IF NOT EXISTS public.demo_reset_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'rpc',
  ok boolean NOT NULL,
  row_counts jsonb,
  error text
);
ALTER TABLE public.demo_reset_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.demo_reset_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.demo_reset()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r record;
  v_cols text;
  v_n bigint;
  v_snap bigint;
  v_counts jsonb := '{}'::jsonb;
  v_last timestamptz;
  v_wait int;
  v_bad bigint;
BEGIN
  -- 1. Chống chạy chồng
  IF NOT pg_try_advisory_xact_lock(hashtext('demo_reset')) THEN
    RAISE EXCEPTION 'RESET_IN_PROGRESS';
  END IF;

  -- 2. Cooldown 10 phút (enforce Ở DB — edge function chỉ là vỏ)
  SELECT max(created_at) INTO v_last FROM public.demo_reset_log WHERE ok;
  IF v_last IS NOT NULL AND now() - v_last < interval '10 minutes' THEN
    v_wait := ceil(extract(epoch FROM (v_last + interval '10 minutes' - now())));
    RAISE EXCEPTION 'COOLDOWN:%', v_wait;
  END IF;

  IF to_regclass('demo_snapshot.buildings') IS NULL THEN
    RAISE EXCEPTION 'NO_SNAPSHOT';
  END IF;

  -- 3. Nhận diện demo
  CREATE TEMP TABLE _du ON COMMIT DROP AS
    SELECT id FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';
  CREATE TEMP TABLE _db ON COMMIT DROP AS
    SELECT id FROM public.buildings WHERE user_id IN (SELECT id FROM _du)
    UNION
    SELECT id FROM demo_snapshot.buildings;

  -- 4. TRIPWIRE fail-closed (an toàn tenant — RAISE thay vì xoá nhầm)
  SELECT count(*) INTO v_bad FROM public.super_admins WHERE user_id IN (SELECT id FROM _du);
  IF v_bad > 0 THEN RAISE EXCEPTION 'TRIPWIRE_SUPERADMIN_DEMO'; END IF;

  SELECT count(*) INTO v_bad FROM public.staff_assignments
  WHERE (user_id IN (SELECT id FROM _du) OR staff_id IN (SELECT id FROM _du))
    AND building_id IS NULL AND area_id IS NULL;
  IF v_bad > 0 THEN RAISE EXCEPTION 'TRIPWIRE_FULLSCOPE_DEMO'; END IF;

  SELECT count(*) INTO v_bad FROM public.income_expenses
  WHERE building_id IN (SELECT id FROM _db) AND user_id NOT IN (SELECT id FROM _du);
  IF v_bad > 0 THEN RAISE EXCEPTION 'TRIPWIRE_REAL_IE_ON_DEMO_BUILDING:%', v_bad; END IF;

  SELECT count(*) INTO v_bad FROM public.invoices
  WHERE building_id IN (SELECT id FROM _db) AND user_id NOT IN (SELECT id FROM _du);
  IF v_bad > 0 THEN RAISE EXCEPTION 'TRIPWIRE_REAL_INVOICE_ON_DEMO_BUILDING:%', v_bad; END IF;

  -- 5. DELETE theo thứ tự config (con FK trước)
  FOR r IN SELECT * FROM public.demo_reset_tables ORDER BY seq LOOP
    EXECUTE format('DELETE FROM public.%I WHERE %s', r.tbl, r.predicate);
  END LOOP;

  -- 6. RESTORE ngược thứ tự (chỉ restore=true), cột giao nhau, bỏ generated columns
  FOR r IN SELECT * FROM public.demo_reset_tables WHERE restore ORDER BY seq DESC LOOP
    IF to_regclass('demo_snapshot.' || r.tbl) IS NULL THEN CONTINUE; END IF;
    SELECT string_agg(quote_ident(c.column_name), ',' ORDER BY c.ordinal_position)
      INTO v_cols
    FROM information_schema.columns c
    JOIN information_schema.columns s
      ON s.table_schema = 'demo_snapshot' AND s.table_name = c.table_name
     AND s.column_name = c.column_name
    WHERE c.table_schema = 'public' AND c.table_name = r.tbl
      AND c.is_generated = 'NEVER';
    IF v_cols IS NULL THEN CONTINUE; END IF;
    EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM demo_snapshot.%I',
                   r.tbl, v_cols, v_cols, r.tbl);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXECUTE format('SELECT count(*) FROM demo_snapshot.%I', r.tbl) INTO v_snap;
    IF v_n <> v_snap THEN
      RAISE EXCEPTION 'RESTORE_MISMATCH:%(% vs %)', r.tbl, v_n, v_snap;
    END IF;
    IF v_n > 0 THEN v_counts := v_counts || jsonb_build_object(r.tbl, v_n); END IF;
  END LOOP;

  -- 7. Audit
  INSERT INTO public.demo_reset_log (source, ok, row_counts) VALUES ('rpc', true, v_counts);
  RETURN jsonb_build_object('ok', true, 'at', now(), 'counts', v_counts);
END
$fn$;

REVOKE ALL ON FUNCTION public.demo_reset() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.demo_reset() TO service_role;

COMMENT ON FUNCTION public.demo_reset() IS
  '[DEMO-DOCS] Reset sandbox demo về baseline trong demo_snapshot. Chỉ service_role (edge fn demo-reset). Cooldown 10 phút. KHÔNG BAO GIỜ thêm tham số vào hàm này.';
`

await runSql(SQL)
console.log('✓ Hạ tầng reset: schema demo_snapshot + demo_reset_tables (' + RESET_TABLES.length + ' bảng) + demo_reset_log + function demo_reset()')
