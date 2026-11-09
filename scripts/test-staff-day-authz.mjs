#!/usr/bin/env node
// Kiểm quyền các hàm «xem theo người» trên project TEST, bằng vai và JWT giả lập, trong ROLLBACK.
//
//   npm run with-cred -- node scripts/test-staff-day-authz.mjs             # phép đo thường, phải đạt
//   npm run with-cred -- node scripts/test-staff-day-authz.mjs --dot-bien  # gỡ cổng, phép đo PHẢI đỏ
//
// VÌ SAO ĐO TRÊN TEST: cần schema và dữ liệu thật (toà, phân công, tuyến gợi ý). Project TEST là
// bản sao; script chỉ chạy trong một transaction rồi ROLLBACK, không để lại gì.
//
// Thoát 0 đạt · 1 có ca sai · 3 không đo được (thiếu migration, thiếu người để đo).
import { withTestLock } from "./test-env/lock.mjs";
import { batBuocDichTest, credential, ketNoi, kiemCongCu, psql } from "./test-env/lib.mjs";

const ORG = "aaaa0000-0000-4000-8000-000000000001";
const DEMO_ORG = "dddd0000-0000-4000-8000-000000000001";
const DEMO_OWNER_EMAIL = "demo.chunha@username.ihomecrm.local";

const CHECKS = String.raw`
CREATE TEMP TABLE _sd_people ON COMMIT DROP AS
SELECT
  (SELECT m.user_id FROM public.organization_memberships m
    WHERE m.organization_id = '${ORG}' AND m.status = 'ACTIVE'
      AND app_private.ie_actor_is_company_owner_v1(m.organization_id, m.user_id)
      AND NOT EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = m.user_id)
    LIMIT 1) AS owner_id,
  (SELECT s.user_id FROM public.super_admins s
     JOIN public.organization_memberships m ON m.user_id = s.user_id AND m.organization_id = '${ORG}' AND m.status = 'ACTIVE'
    LIMIT 1) AS super_id,
  (SELECT x FROM app_private.staff_day_member_ids_v1('${ORG}', public.vn_local_date(now())) AS t(x) ORDER BY x LIMIT 1) AS manager_a,
  (SELECT x FROM app_private.staff_day_member_ids_v1('${ORG}', public.vn_local_date(now())) AS t(x) ORDER BY x DESC LIMIT 1) AS manager_b,
  (SELECT u.id FROM auth.users u WHERE lower(u.email) = '${DEMO_OWNER_EMAIL}' LIMIT 1) AS demo_owner;

GRANT SELECT ON _sd_people TO authenticated, anon;

DO $sd_preflight$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM _sd_people;
  IF p.owner_id IS NULL OR p.super_id IS NULL OR p.manager_a IS NULL OR p.manager_a = p.manager_b OR p.demo_owner IS NULL THEN
    RAISE EXCEPTION 'SD_KHONG_DO_DUOC: thieu nguoi de do %', to_jsonb(p);
  END IF;

  -- Quản lý B đồng thời là thành viên DEMO (chỉ trong transaction này): chủ DEMO không được
  -- nhờ tư cách thành viên chung mà đọc dữ liệu công ty thật của người đó.
  INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status)
  SELECT '${DEMO_ORG}', p.manager_b, 'STAFF', 'ACTIVE'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.organization_id = '${DEMO_ORG}' AND m.user_id = p.manager_b AND m.status IN ('INVITED', 'ACTIVE')
  );
  IF app_private.v5_salary_org_of_user_v1(p.manager_b) IS DISTINCT FROM '${ORG}'::uuid THEN
    RAISE EXCEPTION 'SD_KHONG_DO_DUOC: to chuc luong cua quan ly B khong phai cong ty that';
  END IF;
END
$sd_preflight$;

CREATE FUNCTION pg_temp.sd_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_user IS NULL THEN '' ELSE json_build_object('sub', p_user, 'role', 'authenticated')::text END, true);
END $f$;

CREATE FUNCTION pg_temp.sd_allowed(p_label text, p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  EXECUTE p_sql INTO v;
  IF v IS NULL THEN RAISE EXCEPTION 'SD_SAI % : tra NULL', p_label; END IF;
  RAISE NOTICE 'dat  %', p_label;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'SD_SAI % : dang le duoc phep nhung nhan 42501', p_label;
END $f$;

CREATE FUNCTION pg_temp.sd_denied(p_label text, p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'dat  %', p_label;
    RETURN;
  END;
  RAISE EXCEPTION 'SD_SAI % : dang le bi chan 42501 nhung lai chay duoc', p_label;
END $f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, anon;

DO $sd_acl$
DECLARE v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.staff_day_team_v1(date,uuid)', 'public.staff_day_summary_v1(uuid,date)', 'public.staff_day_route_v1(uuid)',
    'public.staff_day_journey_v1(uuid,date)', 'public.staff_day_calendar_v1(uuid,date)',
    'public.staff_period_report_v1(date,date,uuid)', 'public.staff_period_review_set_v1(uuid,date,date,text,text)',
    'public.gps_checkin_slots_v1(uuid,date)', 'public.gps_checkin_settings_get_v1(uuid)', 'public.gps_checkin_settings_set_v1(jsonb)'
  ] LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'SD_SAI ACL %', v_sig;
    END IF;
  END LOOP;
END
$sd_acl$;

SET LOCAL ROLE authenticated;

DO $sd_cases$
DECLARE
  p record;
  v_month date := date_trunc('month', public.vn_local_date(now()))::date;
  v_to date := (date_trunc('month', public.vn_local_date(now())) + interval '1 month - 1 day')::date;
  v_readers text[];
  v_writers text[];
  v_sql text;
BEGIN
  SELECT * INTO p FROM _sd_people;

  v_readers := ARRAY[
    format('SELECT public.staff_day_summary_v1(%L)', p.manager_b),
    format('SELECT public.staff_day_route_v1(%L)', p.manager_b),
    format('SELECT public.staff_day_journey_v1(%L)', p.manager_b),
    format('SELECT public.staff_day_calendar_v1(%L)', p.manager_b),
    format('SELECT public.gps_checkin_slots_v1(%L)', p.manager_b)
  ];
  v_writers := ARRAY[
    'SELECT public.staff_day_team_v1()',
    format('SELECT public.staff_period_report_v1(%L, %L)', v_month, v_to),
    'SELECT public.gps_checkin_settings_get_v1()',
    format('SELECT public.staff_period_review_set_v1(%L, %L, %L, %L, %L)', p.manager_b, v_month, v_to, 'A', 'x'),
    $q$SELECT public.gps_checkin_settings_set_v1('{"enabled":false,"interval_min":30,"late_tolerance_min":10,"windows":[{"from":"08:00","to":"09:00"}]}'::jsonb)$q$,
    format('SELECT public.gps_checkin_member_set_v1(%L, false)', p.manager_b)
  ];

  -- Chủ công ty không phải super admin: đây là ca hôm nay RLS đang chặn.
  PERFORM pg_temp.sd_as(p.owner_id);
  FOREACH v_sql IN ARRAY v_readers LOOP PERFORM pg_temp.sd_allowed('chu cong ty: ' || left(v_sql, 45), v_sql); END LOOP;
  PERFORM pg_temp.sd_allowed('chu cong ty: ca doi', 'SELECT public.staff_day_team_v1()');
  PERFORM pg_temp.sd_allowed('chu cong ty: bao cao', format('SELECT public.staff_period_report_v1(%L, %L)', v_month, v_to));
  PERFORM pg_temp.sd_allowed('chu cong ty: cai dat', 'SELECT public.gps_checkin_settings_get_v1()');

  PERFORM pg_temp.sd_as(p.super_id);
  PERFORM pg_temp.sd_allowed('super admin: ca doi', 'SELECT public.staff_day_team_v1()');
  PERFORM pg_temp.sd_allowed('super admin: xem nguoi', v_readers[1]);

  -- Quản lý A xem quản lý B: phải chặn hết. Tự xem mình thì được.
  PERFORM pg_temp.sd_as(p.manager_a);
  FOREACH v_sql IN ARRAY v_readers LOOP PERFORM pg_temp.sd_denied('quan ly xem cheo: ' || left(v_sql, 45), v_sql); END LOOP;
  FOREACH v_sql IN ARRAY v_writers LOOP PERFORM pg_temp.sd_denied('quan ly lam viec cua chu: ' || left(v_sql, 45), v_sql); END LOOP;
  PERFORM pg_temp.sd_allowed('quan ly tu xem', format('SELECT public.staff_day_summary_v1(%L)', p.manager_a));

  -- Chủ công ty DEMO hỏi người ở cả hai tổ chức: dữ liệu đọc ra là của công ty thật nên phải chặn.
  PERFORM pg_temp.sd_as(p.demo_owner);
  FOREACH v_sql IN ARRAY v_readers LOOP PERFORM pg_temp.sd_denied('chu DEMO xem nguoi hai to chuc: ' || left(v_sql, 45), v_sql); END LOOP;

  -- Không đăng nhập.
  PERFORM pg_temp.sd_as(NULL);
  FOREACH v_sql IN ARRAY v_readers LOOP PERFORM pg_temp.sd_denied('khong dang nhap: ' || left(v_sql, 45), v_sql); END LOOP;
  PERFORM pg_temp.sd_denied('khong dang nhap: ca doi', 'SELECT public.staff_day_team_v1()');
END
$sd_cases$;

RESET ROLE;

-- Xem người khác không được ghi hộ họ: khác get_my_day_summary (hàm đó recompute streak).
DO $sd_readonly$
DECLARE p record; v_before text; v_after text;
BEGIN
  SELECT * INTO p FROM _sd_people;
  SELECT md5(string_agg(sss::text, '|' ORDER BY sss.id)) INTO v_before FROM public.salary_streak_state sss;
  PERFORM pg_temp.sd_as(p.owner_id);
  PERFORM public.staff_day_summary_v1(p.manager_a);
  PERFORM public.staff_day_team_v1();
  PERFORM public.staff_day_calendar_v1(p.manager_a);
  SELECT md5(string_agg(sss::text, '|' ORDER BY sss.id)) INTO v_after FROM public.salary_streak_state sss;
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'SD_SAI: xem nguoi khac da ghi vao salary_streak_state';
  END IF;
  RAISE NOTICE 'dat  xem nguoi khac khong ghi du lieu';
END
$sd_readonly$;
`;

const DOT_BIEN = [
  ["cổng xem theo người không kiểm gì", `
CREATE OR REPLACE FUNCTION app_private.staff_day_can_view_v1(p_target uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$ SELECT p_target IS NOT NULL AND (SELECT auth.uid()) IS NOT NULL $fn$;
`],
  ["cổng xem cho qua theo bất kỳ tổ chức chung nào", `
CREATE OR REPLACE FUNCTION app_private.staff_day_can_view_v1(p_target uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT p_target = (SELECT auth.uid()) OR EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = p_target AND m.status = 'ACTIVE'
      AND app_private.ie_actor_is_company_owner_v1(m.organization_id, (SELECT auth.uid()))
  )
$fn$;
`],
  ["cổng cả đội không kiểm vai chủ", `
CREATE OR REPLACE FUNCTION app_private.staff_day_viewer_org_v1(p_org uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE(p_org, app_private.v5_salary_org_of_user_v1((SELECT auth.uid())));
END
$fn$;
`],
];

async function main() {
  const dotBien = process.argv.includes("--dot-bien");
  kiemCongCu();
  const cred = credential();
  const { test } = await ketNoi(cred);
  await batBuocDichTest(cred, test);
  return withTestLock({ cred, test }, async () => {
    // Không dùng dungKhiLoi của psql(): nó cắt 1500 ký tự đầu của stderr, dòng lỗi nằm sau các NOTICE.
    const chay = (truoc) => psql(test, `\\set ON_ERROR_STOP on\nBEGIN;\n${truoc}${CHECKS}\nROLLBACK;\n`, { dungKhiLoi: false });

    if (dotBien) {
      let lot = 0;
      for (const [ten, mutation] of DOT_BIEN) {
        const run = chay(mutation);
        const sai = run.stderr.match(/SD_SAI[^\n]*/)?.[0];
        if (run.status === 0) {
          console.error(`❌ ĐỘT BIẾN LỌT (${ten}): phép đo vẫn đạt.`);
          lot += 1;
        } else if (sai) {
          console.log(`✅ Bắt được (${ten}): ${sai}`);
        } else {
          console.error(`⚠️ KHÔNG ĐO ĐƯỢC (${ten}): ${run.stderr.slice(-600)}`);
          return 3;
        }
      }
      return lot > 0 ? 1 : 0;
    }

    const run = chay("");
    if (run.status === 0) {
      const passed = (run.stderr.match(/NOTICE:\s+dat /g) ?? []).length;
      console.log(`✅ Quyền xem theo người: đạt ${passed} ca (TEST, ROLLBACK).`);
      return 0;
    }
    if (run.stderr.includes("SD_KHONG_DO_DUOC") || /ERROR:.*does not exist/.test(run.stderr)) {
      console.error(`⚠️ KHÔNG ĐO ĐƯỢC: ${run.stderr.slice(-600)}`);
      return 3;
    }
    console.error(`❌ ${run.stderr.match(/SD_SAI[^\n]*/)?.[0] ?? run.stderr.slice(-800)}`);
    return 1;
  });
}

main().then((code) => process.exit(process.exitCode || code), (error) => {
  console.error(`❌ ${error.message}`);
  process.exit(3);
});
