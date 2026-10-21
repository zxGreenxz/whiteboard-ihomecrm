import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ID, khungChuaBayGio, taoDbThongBao } from './fixtures/notificationPipelineDb';

/**
 * Migration 20261021171253_hoan_push_gio_yen_lane_thang_v1 (gói B mục B13): bốn lane bắn push thẳng (pg_net) hỏi
 * app_private.notify_push_allowed_now_v1 trước khi bắn; đang giờ yên ⇒ không gọi net.http_post, dòng chuông thành
 * QUEUED cho drain chung. Thân bốn hàm lấy NGUYÊN VĂN từ file nguồn (đã đo: khớp byte với production 22/10), chạy
 * sau fixture pipeline (20261021171249 có helper giờ yên), migration vá chạy hai lượt.
 */
const LANE = 'supabase/migrations/20261021171253_hoan_push_gio_yen_lane_thang_v1.sql';
const NGUON = {
  task: ['supabase/migrations/20261015110000_hermes_task_follow_v1.sql', 'app_private.hermes_task_follow_notify_v1'],
  lich1: ['supabase/migrations/20261015100000_hermes_schedule_health_v1.sql', 'app_private.hermes_schedule_notify_v1'],
  lich2: ['supabase/migrations/20261015185559_hermes_notify_retry_digest_v1.sql', 'app_private.hermes_schedule_notify_v2'],
  zalo: ['supabase/migrations/20261009171352_zalo_canh_gac_worker.sql', 'app_private.zalo_canh_gac_bao_v1'],
} as const;
// Hàm phụ mà bốn hàm trên gọi — cũng lấy bản SỐNG (định nghĩa cuối) thay vì giả.
const PHU = [
  ['supabase/migrations/20261015130000_hermes_review_fixes_v1.sql', 'app_private.hermes_task_follow_member_v1'],
  ['supabase/migrations/20261015110000_hermes_task_follow_v1.sql', 'app_private.hermes_task_follow_iso_v1'],
  ['supabase/migrations/20261016085117_hermes_sale_listing_no_page_v1.sql', 'app_private.hermes_schedule_message_v1'],
] as const;

/** Câu CREATE OR REPLACE FUNCTION cuối cùng của `ten` trong file, tới hết dollar-quote đóng thân. */
function trichHam(file: string, ten: string): string {
  const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const start = src.lastIndexOf(`CREATE OR REPLACE FUNCTION ${ten}(`);
  if (start < 0) throw new Error(`không thấy ${ten} trong ${file}`);
  const as = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(src.slice(start))!;
  const bodyStart = start + as.index + as[0].length;
  const end = src.indexOf(as[1], bodyStart) + as[1].length;
  return `${src.slice(start, end)};`;
}

let db: PGlite;
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SCHEDULE = u(950), GRANT = u(951);

beforeAll(async () => {
  db = await taoDbThongBao();
  await db.exec(`
    CREATE SCHEMA net;
    CREATE TABLE public.test_http(id bigserial PRIMARY KEY, url text, body jsonb, headers jsonb);
    CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}',
      timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
      INSERT INTO public.test_http(url, body, headers) VALUES (url, body, headers) RETURNING id $$;
    CREATE FUNCTION app_private.lifecycle_reminder_service_jwt_v1() RETURNS text LANGUAGE sql AS $$ SELECT 'jwt-thu'::text $$;
    CREATE FUNCTION app_private.ie_actor_is_company_owner_v1(uuid, uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $2 = '${ID.chu}'::uuid $$;
    CREATE TABLE app_private.hermes_room_schedules(id uuid PRIMARY KEY, grant_id uuid);
    CREATE TABLE app_private.hermes_schedule_grants(id uuid PRIMARY KEY, settings jsonb NOT NULL DEFAULT '{}', expires_at timestamptz);
    CREATE TABLE app_private.hermes_schedule_incidents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), schedule_id uuid, user_id uuid,
      organization_id uuid, reason text, detail jsonb NOT NULL DEFAULT '{}', opened_at timestamptz DEFAULT clock_timestamp(), closed_at timestamptz);
    INSERT INTO app_private.hermes_room_schedules VALUES ('${SCHEDULE}', '${GRANT}');
    INSERT INTO app_private.hermes_schedule_grants VALUES ('${GRANT}', '{}', now() + interval '1 day');
  `);
  for (const [file, ten] of PHU) await db.exec(trichHam(file, ten));
  for (const [file, ten] of Object.values(NGUON)) {
    await db.exec(trichHam(file, ten));
    // ACL production 22/10: chỉ postgres (proacl postgres=X/postgres) — file nguồn REVOKE ở khối riêng.
    const sig = (await db.query<{ s: string }>(
      "SELECT p.oid::regprocedure::text s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname || '.' || p.proname = $1", [ten])).rows[0].s;
    await db.exec(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
  }
  const sql = readFileSync(LANE, 'utf8');
  await db.exec(sql);
  await db.exec(sql);
}, 60000);
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.notifications; DELETE FROM public.test_http; DELETE FROM public.notification_quiet_hours;
    DELETE FROM app_private.notification_org_config; DELETE FROM app_private.hermes_schedule_incidents; DELETE FROM public.push_subscriptions;
    INSERT INTO app_private.notification_org_config(organization_id, quiet_start, quiet_end) VALUES ('${ID.org}', 0, 0);`);
});

const gioYenCaNhan = async () => {
  const { start, end } = khungChuaBayGio();
  await db.query('INSERT INTO public.notification_quiet_hours VALUES ($1, $2, true, $3, $4, now())', [ID.chu, ID.org, start, end]);
};
const http = async () => (await db.query<{ n: number }>('SELECT count(*)::int n FROM public.test_http')).rows[0].n;
const pushStates = async () => (await db.query<{ push_state: string | null }>('SELECT push_state FROM public.notifications ORDER BY created_at')).rows.map((r) => r.push_state);

describe('neo vá', () => {
  it('mỗi neo có đúng một lần trong thân nguồn; sau hai lượt mỗi hàm hỏi giờ yên đúng một chỗ', async () => {
    const neo: Record<string, string[]> = {
      task: ['  BEGIN v_jwt:=app_private.lifecycle_reminder_service_jwt_v1();'],
      lich1: ['  v_jwt text; v_error text; v_req bigint;', '  IF v_jwt IS NOT NULL THEN'],
      lich2: ['  v_lines text; v_title text; v_body text; v_hash text; v_jwt text; v_error text; v_req bigint;', '  IF v_jwt IS NOT NULL THEN'],
      zalo: ["  v_reqs    bigint[] := '{}';", '    IF v_jwt IS NOT NULL THEN'],
    };
    for (const [k, [file, ten]] of Object.entries(NGUON)) {
      const than = trichHam(file, ten);
      for (const n of neo[k]) expect(than.split(n), `${ten}: ${n}`).toHaveLength(2);
      const song = (await db.query<{ d: string }>('SELECT pg_get_functiondef(to_regprocedure(p.oid::regprocedure::text)) d FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname || \'.\' || p.proname = $1', [ten])).rows[0].d;
      expect(song.split('notify_push_allowed_now_v1')).toHaveLength(2);
    }
  });
});

describe('Hermes task', () => {
  const goi = () => db.query("SELECT app_private.hermes_task_follow_notify_v1($1, $2, 'due', $3::jsonb, null, null)",
    [ID.org, ID.chu, JSON.stringify([{ jobId: u(960), code: 'V1', title: 'Sửa điện' }])]);

  it('ngoài giờ yên: bắn thẳng như cũ', async () => {
    await goi();
    expect(await http()).toBe(1);
    expect(await pushStates()).toEqual([null]);
  });

  it('giờ yên cá nhân: không bắn, dòng QUEUED (đánh dấu pushDeferred) và drain chung nhặt khi hết giờ yên', async () => {
    await gioYenCaNhan();
    await goi();
    expect(await http()).toBe(0);
    const r = (await db.query<{ push_state: string; metadata: { pushDeferred: string } }>('SELECT push_state, metadata FROM public.notifications')).rows[0];
    expect(r).toMatchObject({ push_state: 'QUEUED', metadata: { pushDeferred: 'quiet_hours' } });
    await db.query("INSERT INTO public.push_subscriptions(user_id, endpoint) VALUES ($1, 'ep')", [ID.chu]);
    expect(await db.query('SELECT * FROM public.notify_claim_push_batch_v2(10)').then((x) => x.rows)).toHaveLength(0);
    await db.query('UPDATE public.notification_quiet_hours SET enabled = false');
    const lo = (await db.query<{ url: string; organization_id: string }>('SELECT * FROM public.notify_claim_push_batch_v2(10)')).rows;
    expect(lo).toHaveLength(1);
    expect(lo[0]).toMatchObject({ url: '/tasks', organization_id: ID.org });
  });
});

describe('Canh gác Zalo', () => {
  const goi = () => db.query("SELECT app_private.zalo_canh_gac_bao_v1($1, 'Zalo mất kết nối', 'Tài khoản A', 'k1', 'mat_ket_noi', 'zalo')", [ID.org]);

  it('ngoài giờ yên: bắn cho chủ công ty; giờ yên: chuông QUEUED, không bắn', async () => {
    await goi();
    expect(await http()).toBe(1);
    expect(await pushStates()).toEqual([null]);
    await db.exec('DELETE FROM public.notifications; DELETE FROM public.test_http;');
    await gioYenCaNhan();
    await goi();
    expect(await http()).toBe(0);
    expect(await pushStates()).toEqual(['QUEUED']);
  });
});

describe('Lịch Hermes', () => {
  const sc = async () => (await db.query<{ id: string }>(
    "INSERT INTO app_private.hermes_schedule_incidents(schedule_id, user_id, organization_id, reason) VALUES ($1, $2, $3, 'grant_expired') RETURNING id",
    [SCHEDULE, ID.chu, ID.org])).rows[0].id;

  it('v1 (một sự cố): giờ yên ⇒ QUEUED không bắn; ngoài giờ yên ⇒ bắn', async () => {
    await db.query("SELECT app_private.hermes_schedule_notify_v1($1, 'opened')", [await sc()]);
    expect(await http()).toBe(1);
    await db.exec('DELETE FROM public.notifications; DELETE FROM public.test_http;');
    await gioYenCaNhan();
    await db.query("SELECT app_private.hermes_schedule_notify_v1($1, 'opened')", [await sc()]);
    expect(await http()).toBe(0);
    expect(await pushStates()).toEqual(['QUEUED']);
  });

  it('v2 (gộp nhiều sự cố): giờ yên ⇒ một dòng QUEUED, không bắn', async () => {
    await gioYenCaNhan();
    const ids = [await sc(), await sc()];
    const r = (await db.query<{ v: { bell: boolean; incidents: number } }>("SELECT app_private.hermes_schedule_notify_v2($1::uuid[], 'opened') v", [ids])).rows[0].v;
    expect(r).toMatchObject({ bell: true, incidents: 2 });
    expect(await http()).toBe(0);
    expect(await pushStates()).toEqual(['QUEUED']);
  });
});
