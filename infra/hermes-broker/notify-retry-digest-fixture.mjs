import { readFileSync } from 'node:fs';

export const NOTIFY_RETRY_DIGEST_PATH = 'supabase/migrations/20261015185559_hermes_notify_retry_digest_v1.sql';
export const notifyRetryDigestSql = () => readFileSync(process.env.HERMES_NOTIFY_RETRY_DIGEST_SQL ?? NOTIFY_RETRY_DIGEST_PATH, 'utf8');

/** Applies the WHOLE notify retry/digest forward migration twice (idempotency)
 * on a focused fixture. It replaces the task-follow tick and the schedule sweep,
 * so a fixture that installs only one area gets inert placeholders for the other
 * area's absent relations/functions (same names and signatures; never executed
 * by its tests). Objects the fixture already installed are never touched. */
export async function applyNotifyRetryDigest(db, sql = notifyRetryDigestSql()) {
  await db.exec(`DO $placeholders$ BEGIN
    IF to_regclass('public.jobs') IS NULL THEN CREATE TABLE public.jobs(); END IF;
    IF to_regclass('app_private.hermes_task_follows') IS NULL THEN
      CREATE TABLE app_private.hermes_task_follows(id uuid,overdue_notified_at timestamptz); END IF;
    IF to_regprocedure('app_private.hermes_task_follow_tick_v1(integer)') IS NULL THEN
      CREATE FUNCTION app_private.hermes_task_follow_tick_v1(p_limit integer DEFAULT 500) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'; END IF;
    IF to_regprocedure('app_private.hermes_task_follow_notify_v1(uuid,uuid,text,jsonb,text,uuid)') IS NULL THEN
      CREATE FUNCTION app_private.hermes_task_follow_notify_v1(p_org uuid,p_user uuid,p_kind text,p_items jsonb,p_detail text,p_job uuid)
        RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; END IF;
    IF to_regclass('app_private.hermes_schedule_incidents') IS NULL THEN CREATE TABLE app_private.hermes_schedule_incidents(); END IF;
    IF to_regprocedure('app_private.hermes_schedule_notify_v1(uuid,text)') IS NULL THEN
      CREATE FUNCTION app_private.hermes_schedule_notify_v1(p_incident uuid,p_phase text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'; END IF;
    IF to_regprocedure('app_private.hermes_schedule_message_v1(text,text,jsonb,text,timestamptz)') IS NULL THEN
      CREATE FUNCTION app_private.hermes_schedule_message_v1(p_reason text,p_phase text,p_detail jsonb,p_label text,p_expires timestamptz)
        RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'; END IF;
    IF to_regprocedure('public.hermes_room_schedule_sweep_v1(uuid,uuid[])') IS NULL THEN
      CREATE FUNCTION public.hermes_room_schedule_sweep_v1(p_instance_id uuid,p_organization_ids uuid[] DEFAULT '{}')
        RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'; END IF;
  END $placeholders$`);
  await db.exec(sql); await db.exec(sql);
}
