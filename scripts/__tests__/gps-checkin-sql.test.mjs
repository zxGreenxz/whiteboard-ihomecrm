// Điểm danh GPS: chạy chính migration trên PGlite với bộ khung tối thiểu rồi đo hành vi.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../../supabase/migrations/20261109042309_gps_checkin_v1.sql', import.meta.url), 'utf8');

const org = 'a0000000-0000-4000-8000-000000000001';
const owner = 'c0000000-0000-4000-8000-000000000001';
const staff = 'c0000000-0000-4000-8000-000000000002';
const other = 'c0000000-0000-4000-8000-000000000003';
const demoOrg = 'a0000000-0000-4000-8000-000000000002';
const demoOwner = 'c0000000-0000-4000-8000-000000000004';
const building = 'b0000000-0000-4000-8000-000000000001';
const device = 'd0000000-0000-4000-8000-000000000001';
// 05/01/2026 là Thứ Hai; 04/01/2026 là Chủ nhật.
const monday = '2026-01-05';
// Ngày cố định sẽ rơi ra ngoài hạn lưu; ca cần toạ độ dùng Thứ Hai cách đây trên một tuần.
const recentMonday = (() => {
  const d = new Date(Date.now() + 7 * 3_600_000);
  d.setUTCDate(d.getUTCDate() - 7 - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();
const hex = (ch) => ch.repeat(64);
const vn = (date, hhmm) => `${date}T${hhmm}:00+07:00`;

let db;

async function as(user) {
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [user ?? '']);
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const json = async (sql, params = []) => Object.values(await one(sql, params))[0];
async function fails(sql, params, code) {
  let caught;
  try { await db.query(sql, params); } catch (error) { caught = error; }
  expect(caught, `không báo lỗi: ${sql}`).toBeDefined();
  expect(caught.code).toBe(code);
}

async function setSettings({ version = 1, from = '2026-01-01T00:00:00+07:00', enabled = true, interval = 30, tolerance = 10,
  windows = [{ from: '08:00', to: '09:00' }, { from: '13:30', to: '14:00' }], skipSunday = true, skipHolidays = true, skipLeave = true, retention = 180 } = {}) {
  await db.query(`INSERT INTO app_private.gps_checkin_settings
    (organization_id, version, effective_from, enabled, interval_min, late_tolerance_min, windows, skip_sunday, skip_holidays, skip_approved_leave, retention_days, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
  [org, version, from, enabled, interval, tolerance, JSON.stringify(windows), skipSunday, skipHolidays, skipLeave, retention, owner]);
}

async function pairDevice({ paired = '2026-01-01T00:00:00+07:00', credential = hex('a'), id = 'e0000000-0000-4000-8000-000000000001' } = {}) {
  await db.query(`INSERT INTO app_private.gps_checkin_devices (id, organization_id, user_id, device_id, credential_digest, fingerprint, paired_at)
    VALUES ($1,$2,$3,$4,$5,'sha256:x',$6)`, [id, org, staff, device, credential, paired]);
}

const setApplies = (applies, from) => db.query(
  `INSERT INTO app_private.gps_checkin_members (organization_id, user_id, applies, effective_from, created_by) VALUES ($1,$2,$3,$4,$5)`,
  [org, staff, applies, from, owner],
);

const ping = (id, slotAt, recordedAt, fix = { status: 'fresh', lat: 10.001, lng: 106.001, accuracyM: 12, provider: 'fused', ageMs: 800, mock: false }, reason = null) => ({
  schemaVersion: 1, event: 'location.ping', id, deviceId: device, slotAt, recordedAt, settingsVersion: 1, fix, reason, device: { batteryPct: 64 },
});
const ingest = (event, hash = hex('1'), credential = hex('a')) =>
  json(`SELECT public.gps_checkin_ingest_v1($1, $2::jsonb, $3)`, [credential, JSON.stringify(event), hash]);
const expected = async (date) => (await db.query(
  `SELECT to_char(slot_at AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI') AS t FROM app_private.gps_checkin_expected_slots_v1($1,$2,$3::date)`, [org, staff, date],
)).rows.map((r) => r.t);
const day = (date) => json(`SELECT app_private.gps_checkin_day_v1($1,$2,$3::date)`, [org, staff, date]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.organization_memberships(user_id uuid, organization_id uuid, status text);
    CREATE TABLE public.manager_salary_config(staff_id uuid, organization_id uuid, is_active boolean, effective_from date, effective_to date, alias text, role_title text);
    CREATE TABLE public.salary_attendance_day(user_id uuid, organization_id uuid, work_date date, status text);
    CREATE TABLE public.salary_holidays(organization_id uuid, holiday_date date);
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text, latitude double precision, longitude double precision, deleted_at timestamptz, is_virtual boolean);
    CREATE FUNCTION public.vn_local_date(ts timestamptz) RETURNS date LANGUAGE sql IMMUTABLE AS $$ SELECT (ts AT TIME ZONE 'Asia/Ho_Chi_Minh')::date $$;
    CREATE FUNCTION public.v5_distance_m(a double precision, b double precision, c double precision, d double precision) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT round(sqrt(power((a-c)*111000,2)+power((b-d)*109000,2)))::int $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT coalesce(array_agg(organization_id),'{}') FROM public.organization_memberships WHERE user_id = auth.uid() AND status='ACTIVE' $$;
    CREATE FUNCTION app_private.ie_actor_is_company_owner_v1(p_org uuid, p_actor uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT (p_actor = '${owner}'::uuid AND p_org = '${org}'::uuid) OR (p_actor = '${demoOwner}'::uuid AND p_org = '${demoOrg}'::uuid) $$;
    CREATE FUNCTION app_private.v5_salary_org_of_user_v1(p_user uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
      DECLARE v uuid;
      BEGIN
        IF p_user = NULLIF(current_setting('test.ambiguous', true), '')::uuid THEN
          RAISE EXCEPTION 'v5_salary_org_ambiguous: % thuoc 2 to chuc', p_user USING ERRCODE = 'P0001';
        END IF;
        SELECT organization_id INTO v FROM public.organization_memberships WHERE user_id = p_user AND status='ACTIVE'
        ORDER BY (organization_id = '${org}'::uuid) DESC LIMIT 1;
        RETURN v;
      END $$;
  `);
  await db.exec(migration);
  await db.query(`INSERT INTO public.organizations VALUES ($1)`, [org]);
  for (const id of [owner, staff, other]) {
    await db.query(`INSERT INTO auth.users VALUES ($1)`, [id]);
    await db.query(`INSERT INTO public.organization_memberships VALUES ($1,$2,'ACTIVE')`, [id, org]);
  }
  await db.query(`INSERT INTO public.organizations VALUES ($1)`, [demoOrg]);
  await db.query(`INSERT INTO auth.users VALUES ($1)`, [demoOwner]);
  await db.query(`INSERT INTO public.organization_memberships VALUES ($1,$2,'ACTIVE')`, [demoOwner, demoOrg]);
  await db.query(`INSERT INTO public.profiles VALUES ($1,'QUẢN LÝ A')`, [staff]);
  await db.query(`INSERT INTO public.manager_salary_config VALUES ($1,$2,true,'2026-01-01',NULL,'Quản lý A','Quản lý')`, [staff, org]);
  await db.query(`INSERT INTO public.buildings VALUES ($1,$2,'Toà A',10,106,NULL,false)`, [building, org]);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec(`
    TRUNCATE app_private.gps_checkin_pings, app_private.gps_checkin_pair_codes, app_private.gps_checkin_devices,
      app_private.gps_checkin_members, app_private.gps_checkin_settings;
    DELETE FROM public.salary_holidays; DELETE FROM public.salary_attendance_day;
    DELETE FROM public.organization_memberships WHERE organization_id = '${demoOrg}' AND user_id <> '${demoOwner}';
  `);
  await as(null);
});

test('khoá ACL: bảng kín với mọi vai, cổng nhận chỉ service_role, hàm nội bộ không ai gọi được', async () => {
  const row = await one(`SELECT
    has_table_privilege('authenticated','app_private.gps_checkin_pings','SELECT') AS a,
    has_table_privilege('service_role','app_private.gps_checkin_devices','SELECT') AS b,
    has_function_privilege('authenticated','public.gps_checkin_ingest_v1(text,jsonb,text)','EXECUTE') AS c,
    has_function_privilege('service_role','public.gps_checkin_ingest_v1(text,jsonb,text)','EXECUTE') AS d,
    has_function_privilege('anon','public.gps_checkin_slots_v1(uuid,date)','EXECUTE') AS e,
    has_function_privilege('authenticated','app_private.staff_day_can_view_v1(uuid)','EXECUTE') AS f,
    has_function_privilege('authenticated','public.gps_checkin_slots_v1(uuid,date)','EXECUTE') AS g`);
  expect(row).toEqual({ a: false, b: false, c: false, d: true, e: false, f: false, g: true });
});

test('chuẩn hoá khung giờ: sắp xếp, từ chối sai dạng, ngược, chồng và chạm nhau', async () => {
  const fn = `SELECT app_private.gps_checkin_normalize_windows_v1($1::jsonb)`;
  expect(await json(fn, [JSON.stringify([{ from: '13:30', to: '17:30' }, { from: '08:00', to: '11:30' }])]))
    .toEqual([{ from: '08:00', to: '11:30' }, { from: '13:30', to: '17:30' }]);
  for (const [windows, message] of [
    [[], 'count'],
    [Array.from({ length: 7 }, (_, i) => ({ from: `0${i}:00`, to: `0${i}:30` })), 'count'],
    [[{ from: '8:00', to: '09:00' }], 'format'],
    [[{ from: '08:03', to: '09:00' }], 'format'],
    [[{ from: '09:00', to: '08:00' }], 'order'],
    [[{ from: '08:00', to: '10:00' }, { from: '09:00', to: '11:00' }], 'overlap'],
    [[{ from: '08:00', to: '10:00' }, { from: '10:00', to: '11:00' }], 'overlap'],
  ]) {
    await expect(db.query(fn, [JSON.stringify(windows)])).rejects.toThrow(`gps_windows_${message}`);
  }
});

test('mốc mong đợi: nhiều khung, không vượt cuối khung, bỏ ngày nghỉ theo công tắc', async () => {
  await setSettings({ windows: [{ from: '08:00', to: '08:45' }, { from: '13:30', to: '14:00' }] });
  expect(await expected(monday)).toEqual(['08:00', '08:30', '13:30', '14:00']);
  expect(await expected('2026-01-04')).toEqual([]);

  await db.query(`INSERT INTO public.salary_holidays VALUES ($1,'2026-01-06')`, [org]);
  expect(await expected('2026-01-06')).toEqual([]);
  await db.query(`INSERT INTO public.salary_attendance_day VALUES ($1,$2,'2026-01-07','leave_approved')`, [staff, org]);
  expect(await expected('2026-01-07')).toEqual([]);
  await db.query(`INSERT INTO public.salary_attendance_day VALUES ($1,$2,'2026-01-08','pending_leave')`, [staff, org]);
  expect(await expected('2026-01-08')).toHaveLength(4);
});

test('tắt công tắc nghỉ thì ngày đó vẫn có mốc; tắt tính năng hoặc tắt theo người thì không', async () => {
  await setSettings({ skipSunday: false });
  expect(await expected('2026-01-04')).not.toEqual([]);
  await db.exec(`UPDATE app_private.gps_checkin_settings SET enabled = false`);
  expect(await expected(monday)).toEqual([]);
  await db.exec(`UPDATE app_private.gps_checkin_settings SET enabled = true`);
  await setApplies(false, '2026-01-01T00:00:00+07:00');
  expect(await expected(monday)).toEqual([]);
});

test('tắt theo người chỉ có hiệu lực từ lúc tắt: ngày trước vẫn còn mốc, bật lại thì có mốc tiếp', async () => {
  await setSettings({ windows: [{ from: '08:00', to: '09:00' }] });
  await setApplies(false, vn('2026-01-06', '00:00'));
  await setApplies(true, vn('2026-01-08', '08:15'));
  expect(await expected(monday)).toEqual(['08:00', '08:30', '09:00']);
  expect(await expected('2026-01-07')).toEqual([]);
  expect(await expected('2026-01-08')).toEqual(['08:30', '09:00']);
});

test('đổi cài đặt giữa ngày: mốc trước theo bản cũ, mốc sau theo bản mới', async () => {
  await setSettings({ version: 1, windows: [{ from: '08:00', to: '09:00' }] });
  await setSettings({ version: 2, from: vn(monday, '08:15'), interval: 15, windows: [{ from: '08:00', to: '08:45' }] });
  expect(await expected(monday)).toEqual(['08:00', '08:15', '08:30', '08:45']);
});

test('trạng thái từng mốc: có dấu, đứng yên, mất tín hiệu, đã tắt, chưa tới', async () => {
  await setSettings({ windows: [{ from: '08:00', to: '10:30' }] });
  await pairDevice();
  const d = recentMonday;
  const stale = { status: 'stale', lat: 10.001, lng: 106.001, accuracyM: 30, provider: 'network', ageMs: 1_800_000, mock: false };
  const tooOld = { ...stale, ageMs: 7_200_000 };
  await ingestRaw(hex('b'), vn(d, '08:00'), vn(d, '08:00'));
  await ingestRaw(hex('c'), vn(d, '08:30'), vn(d, '08:31'), stale, null, true);
  await ingestRaw(hex('d'), vn(d, '09:00'), vn(d, '09:00'), tooOld, null, true);
  await ingestRaw(hex('e'), vn(d, '09:30'), vn(d, '09:30'), { status: 'none' }, 'location_off');
  await ingestRaw(hex('f'), vn(d, '10:00'), vn(d, '10:00'), { status: 'none' }, 'paused');
  await ingestRaw(hex('7'), vn(d, '10:30'), vn(d, '10:30'), stale, null, false);

  const result = await day(d);
  expect(result.slots.map((s) => s.status)).toEqual(['ok', 'ok_stationary', 'missing', 'missing', 'paused', 'missing']);
  expect(result.slots[2].reason).toBe('timeout');
  expect(result.slots[3].reason).toBe('location_off');
  expect(result.slots[5].reason).toBe('timeout');
  expect(result.counts).toMatchObject({ ok: 1, stationary: 1, missing: 3, paused: 1, mock: 0 });
  expect(result.slots[0].nearest_building_name).toBe('Toà A');
  expect(result.slots[0].lat).not.toBeNull();
  // Mốc mất tín hiệu có toạ độ cũ trong dòng nhưng không được trả ra để vẽ.
  expect(result.slots[2].lat).toBeNull();
  expect(result.slots[2].nearest_building_id).toBeNull();

  const future = await day('2099-01-05');
  expect(future.slots.every((s) => s.status === 'future')).toBe(true);
});

/** Ghi thẳng một dấu cho ngày đã qua, vì cổng nhận từ chối dấu quá 14 ngày. */
async function ingestRaw(id, slotAt, recordedAt, fix = { status: 'fresh', lat: 10.001, lng: 106.001, accuracyM: 12, provider: 'fused', ageMs: 800, mock: false }, reason = null, idle = false) {
  await db.query(`INSERT INTO app_private.gps_checkin_pings
    (organization_id, user_id, device_ref, external_id, payload_hash, slot_at, recorded_at, fix_status, lat, lng, accuracy_m, fix_age_ms, reason, nearest_building_id, nearest_distance_m, device_idle)
    VALUES ($1,$2,'e0000000-0000-4000-8000-000000000001',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,50,$14)`,
  [org, staff, id, hex('1'), slotAt, recordedAt, fix.status, fix.lat ?? null, fix.lng ?? null, fix.accuracyM ?? null, fix.ageMs ?? null, reason, building, idle]);
}

test('mốc trước khi ghép máy không tính vào mẫu số', async () => {
  await setSettings({ windows: [{ from: '08:00', to: '10:00' }] });
  await pairDevice({ paired: vn(monday, '09:05') });
  const result = await day(monday);
  // 09:00 đã qua lúc ghép nên không tính, dù ghép trong hạn trễ của mốc đó.
  expect(result.slots.map((s) => s.at).length).toBe(2);
  expect(result.paired).toBe(true);
  const noDevice = await json(`SELECT app_private.gps_checkin_day_v1($1,$2,$3::date)`, [org, other, monday]);
  expect(noDevice.slots).toEqual([]);
  expect(noDevice.paired).toBe(false);
});

test('mốc trong khoảng máy đã thu hồi mà chưa ghép máy mới không tính', async () => {
  await setSettings({ windows: [{ from: '08:00', to: '10:00' }] });
  await pairDevice();
  await db.query(`UPDATE app_private.gps_checkin_devices SET revoked_at = $1`, [vn(monday, '08:45')]);
  await pairDevice({ paired: vn(monday, '09:20'), credential: hex('b'), id: 'e0000000-0000-4000-8000-000000000002' });
  const result = await day(monday);
  expect(result.slots.map((s) => new Date(s.at).toISOString())).toEqual(
    ['08:00', '08:30', '09:30', '10:00'].map((t) => new Date(vn(monday, t)).toISOString()),
  );
});

test('một người ở hai tổ chức: chủ tổ chức kia không xem được, không thu hồi được máy', async () => {
  await setSettings({ windows: [{ from: '08:00', to: '09:00' }] });
  await pairDevice();
  await db.query(`INSERT INTO public.organization_memberships VALUES ($1,$2,'ACTIVE')`, [staff, demoOrg]);
  await as(demoOwner);
  await fails(`SELECT public.gps_checkin_slots_v1($1)`, [staff], '42501');
  await fails(`SELECT public.gps_checkin_device_revoke_v1('e0000000-0000-4000-8000-000000000001')`, [], '42501');
  await as(owner);
  expect(await json(`SELECT public.gps_checkin_slots_v1($1)`, [staff])).toMatchObject({ enabled: true });
});

test('người ở hai tổ chức cùng có luật lương: người ngoài nhận 42501, không thấy lỗi kèm UUID', async () => {
  await db.query(`SELECT set_config('test.ambiguous', $1, false)`, [staff]);
  try {
    await as(owner);
    await fails(`SELECT public.gps_checkin_slots_v1($1)`, [staff], '42501');
  } finally {
    await db.query(`SELECT set_config('test.ambiguous', '', false)`);
  }
});

test('cổng nhận: nhận, trùng, trùng khác nội dung, ngoài khung, ngày nghỉ, sai máy, sai bearer', async () => {
  const now = new Date();
  await setSettings({ windows: [{ from: '00:00', to: '23:55' }], interval: 15, skipSunday: false });
  await pairDevice();
  const slot = new Date(Math.floor(now.getTime() / 900_000) * 900_000).toISOString();

  const first = await ingest(ping(hex('b'), slot, slot));
  expect(first.status).toBe('accepted');
  expect(first.settings).toMatchObject({ version: 1, enabled: true, applies: true, intervalMin: 15 });
  const stored = await one(`SELECT count(*)::int AS n, max(nearest_distance_m) AS d FROM app_private.gps_checkin_pings`);
  expect(stored.n).toBe(1);
  expect(stored.d).toBeGreaterThan(0);

  expect((await ingest(ping(hex('b'), slot, slot))).status).toBe('duplicate');
  await expect(ingest(ping(hex('b'), slot, slot), hex('2'))).rejects.toMatchObject({ code: 'PT409' });
  await expect(ingest(ping(hex('c'), slot, slot), hex('1'), hex('9'))).rejects.toMatchObject({ code: '28000' });
  await expect(ingest({ ...ping(hex('c'), slot, slot), deviceId: 'd0000000-0000-4000-8000-00000000000f' })).rejects.toMatchObject({ code: 'PT409' });

  // Mốc thứ hai của cùng máy cho cùng giờ mốc: chỉ được một dấu, dù id khác.
  await expect(ingest(ping(hex('c'), slot, slot), hex('7'))).rejects.toMatchObject({ code: 'PT409' });

  // slotAt không phải mốc mong đợi thì không lưu, dù giờ ghi vẫn trong hạn của một mốc khác.
  const offGrid = new Date(new Date(slot).getTime() + 7 * 60_000).toISOString();
  expect((await ingest(ping(hex('6'), offGrid, slot))).status).toBe('ignored_out_of_window');

  // Khung giờ đặt cách giờ hiện tại 6 tiếng: mốc đang xét nằm ngoài khung ở bất kỳ giờ nào trong ngày.
  const vnHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hour12: false }).format(now)) % 24;
  const elsewhere = String((vnHour + 6) % 24).padStart(2, '0');
  await db.query(`UPDATE app_private.gps_checkin_settings SET windows = $1::jsonb`, [JSON.stringify([{ from: `${elsewhere}:00`, to: `${elsewhere}:05` }])]);
  expect((await ingest(ping(hex('d'), slot, slot))).status).toBe('ignored_out_of_window');
  expect((await one(`SELECT count(*)::int AS n FROM app_private.gps_checkin_pings`)).n).toBe(1);

  await db.exec(`UPDATE app_private.gps_checkin_settings SET enabled = false`);
  expect((await ingest(ping(hex('e'), slot, slot))).status).toBe('ignored_off_day');
});

test('chặn tần suất: quá trần một phút thì PT429 và không thêm dòng', async () => {
  await setSettings({ windows: [{ from: '00:00', to: '23:55' }], interval: 15, skipSunday: false });
  await pairDevice();
  const slot = new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString();
  await db.exec(`INSERT INTO app_private.gps_checkin_pings
    (organization_id, user_id, device_ref, external_id, payload_hash, slot_at, recorded_at, fix_status)
    SELECT '${org}', '${staff}', 'e0000000-0000-4000-8000-000000000001', lpad(to_hex(n), 64, '0'), repeat('1', 64),
           '2026-01-05T00:00:00Z'::timestamptz + n * interval '1 minute', '2026-01-05T00:00:00Z', 'none'
    FROM generate_series(1, 120) AS n`);
  await expect(ingest(ping(hex('b'), slot, slot))).rejects.toMatchObject({ code: 'PT429' });
  expect((await one(`SELECT count(*)::int AS n FROM app_private.gps_checkin_pings`)).n).toBe(120);
});

test('tình trạng máy được gộp, không làm mất model đã báo lúc ghép', async () => {
  await setSettings({ windows: [{ from: '00:00', to: '23:55' }], interval: 15, skipSunday: false });
  await pairDevice();
  await db.exec(`UPDATE app_private.gps_checkin_devices SET state = '{"model":"Thu"}'`);
  const slot = new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString();
  await ingest(ping(hex('b'), slot, slot));
  expect((await one(`SELECT state FROM app_private.gps_checkin_devices`)).state).toEqual({ model: 'Thu', batteryPct: 64 });
});

test('cổng nhận từ chối giờ vô lý và toạ độ thiếu', async () => {
  await setSettings({ windows: [{ from: '00:00', to: '23:55' }], interval: 15, skipSunday: false });
  await pairDevice();
  const slot = new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
  await expect(ingest(ping(hex('b'), later, later))).rejects.toMatchObject({ code: '22023' });
  await expect(ingest(ping(hex('c'), old, old))).rejects.toMatchObject({ code: '22023' });
  await expect(ingest(ping(hex('d'), slot, slot, { status: 'fresh' }))).rejects.toMatchObject({ code: '22023' });
  await expect(ingest({ ...ping(hex('e'), slot, slot), event: 'weird' })).rejects.toMatchObject({ code: '22023' });
});

test('máy đã thu hồi hoặc người đã nghỉ thì không gửi được', async () => {
  await setSettings({ windows: [{ from: '00:00', to: '23:55' }], interval: 15, skipSunday: false });
  await pairDevice();
  const slot = new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString();
  await db.exec(`UPDATE public.organization_memberships SET status='LEFT' WHERE user_id='${staff}'`);
  await expect(ingest(ping(hex('b'), slot, slot))).rejects.toMatchObject({ code: '42501' });
  await db.exec(`UPDATE public.organization_memberships SET status='ACTIVE' WHERE user_id='${staff}'`);
  await db.exec(`UPDATE app_private.gps_checkin_devices SET revoked_at = now()`);
  await expect(ingest(ping(hex('b'), slot, slot))).rejects.toMatchObject({ code: '28000' });
});

test('hết hạn lưu thì xoá toạ độ nhưng giữ dòng để còn đếm', async () => {
  await setSettings({ windows: [{ from: '00:00', to: '23:55' }], interval: 15, skipSunday: false, retention: 30 });
  await pairDevice();
  await ingestRaw(hex('b'), '2025-06-02T08:00:00+07:00', '2025-06-02T08:00:00+07:00');
  const slot = new Date(Math.floor(Date.now() / 900_000) * 900_000).toISOString();
  await ingest(ping(hex('c'), slot, slot));
  const oldRow = await one(`SELECT lat, nearest_building_id, coords_purged_at FROM app_private.gps_checkin_pings WHERE external_id=$1`, [hex('b')]);
  expect(oldRow.lat).toBeNull();
  expect(oldRow.nearest_building_id).toBeNull();
  expect(oldRow.coords_purged_at).not.toBeNull();
  const fresh = await one(`SELECT lat FROM app_private.gps_checkin_pings WHERE external_id=$1`, [hex('c')]);
  expect(fresh.lat).not.toBeNull();
});

test('toạ độ quá hạn không đọc được dù chưa tới lần dọn; báo tình trạng máy cũng kích hoạt dọn', async () => {
  await setSettings({ from: '2025-01-01T00:00:00+07:00', windows: [{ from: '08:00', to: '09:00' }], retention: 30 });
  await pairDevice({ paired: '2025-01-01T00:00:00+07:00' });
  await ingestRaw(hex('b'), '2025-06-02T08:00:00+07:00', '2025-06-02T08:00:00+07:00');
  const before = await one(`SELECT lat FROM app_private.gps_checkin_pings`);
  expect(before.lat).not.toBeNull();
  const old = await day('2025-06-02');
  expect(old.slots[0].status).toBe('ok');
  expect(old.slots[0].lat).toBeNull();
  expect(old.slots[0].nearest_building_name).toBeNull();

  await ingest({ schemaVersion: 1, event: 'device.state', id: hex('9'), deviceId: device, recordedAt: new Date().toISOString(), device: { batteryPct: 50 } });
  expect((await one(`SELECT lat, coords_purged_at FROM app_private.gps_checkin_pings`)).lat).toBeNull();
});

test('lưu cài đặt không gửi hạn lưu thì giữ hạn đang có', async () => {
  await setSettings({ retention: 90 });
  await as(owner);
  const saved = await json(`SELECT public.gps_checkin_settings_set_v1($1::jsonb)`, [JSON.stringify({ enabled: true, interval_min: 60, late_tolerance_min: 10, windows: [{ from: '08:00', to: '09:00' }] })]);
  expect(saved).toMatchObject({ version: 2, unchanged: false });
  expect((await one(`SELECT retention_days FROM app_private.gps_checkin_settings WHERE version = 2`)).retention_days).toBe(90);
});

test('ghép máy: mã một lần, phát lại được, hết hạn và máy khác bị từ chối, máy mới thu hồi máy cũ', async () => {
  await setSettings();
  await as(staff);
  const start = await json(`SELECT public.gps_checkin_pair_start_v1()`);
  expect(start.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
  const digest = (await one(`SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS d`, [start.code])).d;
  await as(null);
  const pair = (credential, code = digest) => json(`SELECT public.gps_checkin_pair_v1($1,$2,'fp',$3::jsonb)`,
    [code, credential, JSON.stringify({ id: hex('c'), deviceId: device, device: { model: 'Thu' } })]);

  const paired = await pair(hex('a'));
  expect(paired.status).toBe('paired');
  expect(paired.user.name).toBe('QUẢN LÝ A');
  expect((await pair(hex('a'))).status).toBe('paired');
  await expect(pair(hex('b'))).rejects.toMatchObject({ code: '28000' });
  await expect(pair(hex('b'), hex('9'))).rejects.toMatchObject({ code: '28000' });

  await as(staff);
  const again = await json(`SELECT public.gps_checkin_pair_start_v1()`);
  const digest2 = (await one(`SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS d`, [again.code])).d;
  await as(null);
  await pair(hex('b'), digest2);
  const devices = (await db.query(`SELECT credential_digest, revoked_at FROM app_private.gps_checkin_devices ORDER BY paired_at`)).rows;
  expect(devices).toHaveLength(2);
  expect(devices[0].revoked_at).not.toBeNull();
  expect(devices[1].revoked_at).toBeNull();

  await db.exec(`UPDATE app_private.gps_checkin_pair_codes SET used_at = NULL, used_device_ref = NULL, expires_at = now() - interval '1 minute'`);
  await expect(pair(hex('c'), digest2)).rejects.toMatchObject({ code: '28000' });
});

test('chỉ người trong danh sách và đang được áp dụng mới tạo được mã ghép', async () => {
  await setSettings();
  await as(other);
  await fails(`SELECT public.gps_checkin_pair_start_v1()`, [], '42501');
  await as(null);
  await setApplies(false, '2026-01-01T00:00:00+07:00');
  await as(staff);
  await fails(`SELECT public.gps_checkin_pair_start_v1()`, [], '42501');
});

test('quyền: chỉ chủ đổi được cài đặt; người ngoài không xem được mốc của người khác', async () => {
  const patch = JSON.stringify({ enabled: true, interval_min: 30, late_tolerance_min: 10, windows: [{ from: '08:00', to: '09:00' }] });
  await as(staff);
  await fails(`SELECT public.gps_checkin_settings_set_v1($1::jsonb)`, [patch], '42501');
  await fails(`SELECT public.gps_checkin_settings_get_v1()`, [], '42501');
  await fails(`SELECT public.gps_checkin_member_set_v1($1,false)`, [other], '42501');
  await as(other);
  await fails(`SELECT public.gps_checkin_slots_v1($1)`, [staff], '42501');
  await as(staff);
  expect(await json(`SELECT public.gps_checkin_slots_v1($1)`, [staff])).toMatchObject({ enabled: false });
  await as(null);
  await fails(`SELECT public.gps_checkin_slots_v1($1)`, [staff], '42501');

  await as(owner);
  const saved = await json(`SELECT public.gps_checkin_settings_set_v1($1::jsonb)`, [patch]);
  expect(saved).toMatchObject({ version: 1, unchanged: false });
  expect(await json(`SELECT public.gps_checkin_settings_set_v1($1::jsonb)`, [patch])).toMatchObject({ version: 1, unchanged: true });
  expect(await json(`SELECT public.gps_checkin_slots_v1($1)`, [staff])).toMatchObject({ enabled: true });
  const doc = await json(`SELECT public.gps_checkin_settings_get_v1()`);
  expect(doc.configured).toBe(true);
  expect(doc.members.map((m) => m.user.name)).toEqual(['QUẢN LÝ A']);
});
