import { readFileSync } from 'node:fs';

export const REVIEW_FIXES_PATH = 'supabase/migrations/20261015130000_hermes_review_fixes_v1.sql';
export const reviewFixesSql = () => readFileSync(process.env.HERMES_REVIEW_FIXES_SQL ?? REVIEW_FIXES_PATH, 'utf8');

/** Applies the WHOLE review-fix migration twice (idempotency) on a focused
 * fixture. It replaces functions from three batch files, so a fixture that
 * installs only one area gets inert placeholders for the other areas' absent
 * relations/functions (same names and signatures; never executed by its tests).
 * Objects the fixture already installed are never touched. */
export async function applyReviewFixes(db, sql = reviewFixesSql()) {
  await db.exec(`DO $placeholders$ BEGIN
    IF to_regclass('public.jobs') IS NULL THEN CREATE TABLE public.jobs(); END IF;
    IF to_regclass('app_private.hermes_task_follows') IS NULL THEN CREATE TABLE app_private.hermes_task_follows(); END IF;
    IF to_regprocedure('app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)') IS NULL THEN
      CREATE FUNCTION app_private.hermes_task_follow_grant_v1(f app_private.hermes_task_follows) RETURNS text LANGUAGE sql AS 'SELECT NULL::text'; END IF;
    IF to_regprocedure('app_private.hermes_task_follow_tick_v1(integer)') IS NULL THEN
      CREATE FUNCTION app_private.hermes_task_follow_tick_v1(p_limit integer DEFAULT 500) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'; END IF;
    IF to_regprocedure('app_private.hermes_task_follow_member_v1(uuid,uuid)') IS NULL THEN
      CREATE FUNCTION app_private.hermes_task_follow_member_v1(p_org uuid,p_user uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false'; END IF;
    IF to_regprocedure('app_private.hermes_finance_extend_options_v1(jsonb,text)') IS NULL THEN
      CREATE FUNCTION app_private.hermes_finance_extend_options_v1(p_result jsonb,p_kind text) RETURNS jsonb LANGUAGE sql AS 'SELECT p_result'; END IF;
  END $placeholders$`);
  await db.exec(sql); await db.exec(sql);
}
