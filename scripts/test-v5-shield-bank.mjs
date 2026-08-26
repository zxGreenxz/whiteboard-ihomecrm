#!/usr/bin/env node
// V5.1 harness: ap migration 2 lan (idempotency) + assertions luat moi + legacy bat bien,
// tat ca trong MOT transaction roi ROLLBACK — khong de lai dau vet tren DB.
// Pattern ke thua scripts/test-v5-streak-recompute-alias.mjs.
import { readFileSync } from "node:fs";

const migrationFiles = [
  "supabase/migrations/20260826120000_v5_1_khien_3_lop_phep_nam_moc_2tr5.sql",
  "supabase/migrations/20260826123000_v5_1_my_day_phep_nam.sql",
  "supabase/migrations/20260826150000_v5_1_thang_2tr5_ap_ca_t7_t8.sql",
];
const projectRef = JSON.parse(
  readFileSync("supabase/.temp/linked-project.json", "utf8"),
).ref;
const localConfig = readFileSync("CLAUDE.local.md", "utf8");
const pat = (localConfig.match(/sbp_[a-z0-9]+/) || [])[0];

if (!pat) {
  console.error("Missing Supabase PAT in CLAUDE.local.md");
  process.exit(1);
}

const migrationBody = migrationFiles
  .map((f) =>
    readFileSync(f, "utf8")
      .replace(/^﻿?\s*BEGIN;\s*/i, "")
      .replace(/\s*COMMIT;[\s\S]*$/i, ""),
  )
  .join("\n");

const JOEY = "d45a7506-5250-4d99-ac94-9f73cbd4df17";

const assertions = String.raw`
DO $test$
DECLARE
  v_joey uuid := '${JOEY}';
  v_owner uuid := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_eff jsonb;
  v_r jsonb; v_r2 jsonb; v_m jsonb;
  v_d date;
  v_sum numeric;
BEGIN
  -- ===== A. effective_milestones v2 =====
  v_eff := public.public_v5_effective_milestones('[4,8,13,18,23,"n_top"]'::jsonb,
            '[300000,400000,500000,500000,400000,400000]'::jsonb, 26);
  IF jsonb_array_length(v_eff) <> 6
     OR (v_eff->5->>'at')::int <> 26 OR (v_eff->5->>'delta')::numeric <> 400000 THEN
    RAISE EXCEPTION 'A1 fail: n=26 dinh dong sai: %', v_eff;
  END IF;
  SELECT COALESCE(SUM((e->>'delta')::numeric),0) INTO v_sum FROM jsonb_array_elements(v_eff) e;
  IF v_sum <> 2500000 THEN RAISE EXCEPTION 'A1 fail: tong % <> 2.5tr', v_sum; END IF;

  v_eff := public.public_v5_effective_milestones('[4,8,13,18,23,"n_top"]'::jsonb,
            '[300000,400000,500000,500000,400000,400000]'::jsonb, 23);
  IF (SELECT COUNT(*) FROM jsonb_array_elements(v_eff) e WHERE (e->>'at')::int = 23) <> 1 THEN
    RAISE EXCEPTION 'A2 fail: n=23 khong merge: %', v_eff;
  END IF;
  IF (SELECT (e->>'delta')::numeric FROM jsonb_array_elements(v_eff) e WHERE (e->>'at')::int = 23) <> 800000 THEN
    RAISE EXCEPTION 'A2 fail: delta merge <> 800k: %', v_eff;
  END IF;
  SELECT COALESCE(SUM((e->>'delta')::numeric),0) INTO v_sum FROM jsonb_array_elements(v_eff) e;
  IF v_sum <> 2500000 THEN RAISE EXCEPTION 'A2 fail: tong % <> 2.5tr', v_sum; END IF;

  v_eff := public.public_v5_effective_milestones('[4,8,13,18,23,"n_top"]'::jsonb,
            '[300000,400000,500000,500000,400000,400000]'::jsonb, 22);
  IF (v_eff->jsonb_array_length(v_eff)-1->>'at')::int <> 22
     OR (v_eff->jsonb_array_length(v_eff)-1->>'delta')::numeric <> 800000 THEN
    RAISE EXCEPTION 'A3 fail: n=22 cat/don sai: %', v_eff;
  END IF;

  v_eff := public.public_v5_effective_milestones('[4,8,13,18,23,"full_month"]'::jsonb,
            '[300000,500000,600000,600000,500000,500000]'::jsonb, 26);
  SELECT COALESCE(SUM((e->>'delta')::numeric),0) INTO v_sum FROM jsonb_array_elements(v_eff) e;
  IF v_sum <> 3000000 THEN RAISE EXCEPTION 'A4 fail: legacy full_month tong % <> 3tr', v_sum; END IF;

  -- ===== D. Legacy (thang 7 THAT cua Joey): co che khien cu, THANG TIEN moi 2.5tr =====
  -- Joey T7: best 24 = N_chuan 24 (3 phep) -> cham dinh dong -> full 2.5tr, tong 8.5tr
  v_r := public.v5_recompute_streak(v_joey, DATE '2026-07-01');
  IF (v_r->>'best')::int <> 24 OR (v_r->>'breaks_no_leave')::int <> 0 THEN
    RAISE EXCEPTION 'D1 fail: legacy thang 7 doi hanh vi chuoi: %', v_r;
  END IF;
  SELECT COALESCE(SUM((b->>'delta')::numeric),0) INTO v_sum FROM jsonb_array_elements(v_r->'banked') b;
  IF v_sum <> 2500000 THEN RAISE EXCEPTION 'D1 fail: banked thang 7 = % <> 2.5tr (thang moi)', v_sum; END IF;
  v_m := public.v5_month_money(v_joey, DATE '2026-07-01');
  IF (v_m->>'total')::numeric <> 8500000 OR (v_m->>'streak_budget')::numeric <> 2500000 THEN
    RAISE EXCEPTION 'D2 fail: money thang 7 (ky vong 8.5tr / tran 2.5tr): %', v_m;
  END IF;
  v_m := public.v5_month_money(v_joey, DATE '2026-10-01');
  IF (v_m->>'streak_budget')::numeric <> 2500000 THEN
    RAISE EXCEPTION 'E fail: budget thang 10 <> 2.5tr: %', v_m;
  END IF;

  -- ===== Dung san khau tong hop: bank_from lui ve 01/07, xoa sach dau chan Joey =====
  UPDATE public.salary_bonus_rules
  SET rules = jsonb_set(rules, '{system_v5,shield_bank_from}', '"2026-07-01"')
  WHERE user_id = v_owner;
  DELETE FROM public.salary_attendance_day WHERE user_id = v_joey AND work_date >= DATE '2026-07-01';
  DELETE FROM public.salary_streak_state WHERE user_id = v_joey AND period_month >= DATE '2026-07-01';
  DELETE FROM public.salary_shield_seed WHERE user_id = v_joey;

  -- Thang 7 tong hop: tick DU 100% ngay lam viec + 2 Chu nhat (05 & 12/07)
  v_d := DATE '2026-07-01';
  WHILE v_d <= DATE '2026-07-31' LOOP
    IF EXTRACT(dow FROM v_d) <> 0 OR v_d IN (DATE '2026-07-05', DATE '2026-07-12') THEN
      INSERT INTO public.salary_attendance_day (user_id, work_date, status, organization_id)
      VALUES (v_joey, v_d, 'ticked', 'aaaa0000-0000-4000-8000-000000000001');
    END IF;
    v_d := v_d + 1;
  END LOOP;

  -- ===== B. Bank tai mung 1/8: perfect = 0(seed)+1(thang 7 hoan hao), sunday = 1.0 =====
  v_r := public.v5_shield_bank(v_joey, DATE '2026-08-01');
  IF (v_r->>'perfect')::int <> 1 OR (v_r->>'sunday')::numeric <> 1.0 THEN
    RAISE EXCEPTION 'B fail: bank = % (ky vong perfect 1, sunday 1.0)', v_r;
  END IF;

  -- Thang 8 tong hop: tick 01,07,08,10-15,17-22,24-26; LO 03,04,05,06 (4 ngay)
  v_d := DATE '2026-08-01';
  WHILE v_d <= DATE '2026-08-26' LOOP
    IF EXTRACT(dow FROM v_d) <> 0 AND v_d NOT IN
       (DATE '2026-08-03', DATE '2026-08-04', DATE '2026-08-05', DATE '2026-08-06') THEN
      INSERT INTO public.salary_attendance_day (user_id, work_date, status, organization_id)
      VALUES (v_joey, v_d, 'ticked', 'aaaa0000-0000-4000-8000-000000000001');
    END IF;
    v_d := v_d + 1;
  END LOOP;

  -- ===== C. Recompute thang 8 theo luat moi =====
  -- Tieu: 03/08 → free(1→0) · 04/08 → perfect(1→0) · 05/08 → sunday(1.0→0) · 06/08 → DUT
  v_r := public.v5_recompute_streak(v_joey, DATE '2026-08-01');
  IF (v_r->>'breaks_no_leave')::int <> 4 THEN RAISE EXCEPTION 'C1 fail breaks: %', v_r; END IF;
  IF (v_r->>'shields_free_left')::int <> 0
     OR (v_r->>'shields_perfect_left')::int <> 0
     OR (v_r->>'sunday_points_left')::numeric <> 0 THEN
    RAISE EXCEPTION 'C2 fail thu tu tieu khien: %', v_r;
  END IF;
  IF (v_r->>'best')::int <> 17 OR (v_r->>'current')::int <> 17 THEN
    RAISE EXCEPTION 'C3 fail chuoi (ky vong 17): %', v_r;
  END IF;
  SELECT COALESCE(SUM((b->>'delta')::numeric),0) INTO v_sum FROM jsonb_array_elements(v_r->'banked') b;
  IF v_sum <> 1200000 THEN RAISE EXCEPTION 'C4 fail banked % <> 1.2tr (moc 4+8+13)', v_sum; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'banked') b WHERE (b->>'milestone')::int = 18) THEN
    RAISE EXCEPTION 'C4 fail: moc 18 khong duoc bank';
  END IF;
  -- Idempotency: chay lan 2 ket qua y het
  v_r2 := public.v5_recompute_streak(v_joey, DATE '2026-08-01');
  IF v_r IS DISTINCT FROM v_r2 THEN
    RAISE EXCEPTION 'C5 fail idempotency: % <> %', v_r, v_r2;
  END IF;

  PERFORM set_config('v5_shield_test.staff_id', v_joey::text, true);
END;
$test$;

-- ===== Quota phep theo nam + quyen (duoi role authenticated) =====
SELECT set_config('request.jwt.claim.sub', current_setting('v5_shield_test.staff_id'), true);
SET LOCAL ROLE authenticated;

DO $auth_path$
DECLARE
  v_r jsonb;
BEGIN
  -- F: client khong duoc goi ham noi bo
  BEGIN
    PERFORM public.v5_shield_bank(current_setting('v5_shield_test.staff_id')::uuid, DATE '2026-09-01');
    RAISE EXCEPTION 'F fail: authenticated goi duoc v5_shield_bank';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.v5_recompute_streak_legacy(current_setting('v5_shield_test.staff_id')::uuid, DATE '2026-07-01');
    RAISE EXCEPTION 'F fail: authenticated goi duoc v5_recompute_streak_legacy';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- Phep nam: bank_from (in-test) 2026-07-01, xin 31/08 (Mon) → quota LEAST(12, 8) = 8, da dung 0
  v_r := public.request_paid_leave(DATE '2026-08-31', 'harness V5.1');
  IF v_r->>'status' <> 'pending_leave' OR (v_r->>'quota_left')::int <> 7 THEN
    RAISE EXCEPTION 'G fail quota nam: %', v_r;
  END IF;
END;
$auth_path$;

RESET ROLE;
`;

const sql = `BEGIN;\n${migrationBody}\n${migrationBody}\n${assertions}\nROLLBACK;`;
const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  },
);
const body = await response.text();

if (!response.ok) {
  console.error(`V5.1 shield-bank validation failed (${response.status})`);
  console.error(body.slice(0, 4000));
  process.exit(1);
}

console.log(
  "PASS A-G: migration idempotent ×2, moc n_top, bank suy-ra-tu-so, thu tu tieu 3 lop, legacy bat bien, phep nam, quyen noi bo — ROLLBACK sach.",
);
