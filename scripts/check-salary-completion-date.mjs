#!/usr/bin/env node
/**
 * check-salary-completion-date — chốt bất biến "lương tính theo THỜI ĐIỂM HOÀN
 * THÀNH, không phải thời điểm TẠO công việc" bằng dữ liệu thật.
 *
 * Vì sao cần: quyết định nằm 100% trong plpgsql (salary_work_ledger), nên vitest
 * không quan sát được. Test tĩnh ở src/lib/__tests__/salaryCompletionDate.test.ts
 * chỉ chặn hình dạng SQL; file này chạy LOGIC THẬT.
 *
 * Fixture ranh giới: job TẠO 31/07 23:50 VN, HOÀN THÀNH 01/08 00:10 VN.
 *   - Phải VẮNG MẶT ở kỳ 2026-07
 *   - Phải CÓ MẶT ở kỳ 2026-08 với occurred_date = 2026-08-01
 * Case này fail dưới CẢ HAI regression: đổi sang created_at (rơi vào tháng 7),
 * VÀ bỏ vn_local_date (UTC 2026-07-31T17:10Z đọc thành 31/07, cũng tháng 7).
 *
 * An toàn: toàn bộ chạy trong MỘT transaction kết thúc bằng ROLLBACK — không
 * dòng nào tồn tại sau khi chạy, kể cả khi assertion fail.
 *
 * Dùng: node scripts/check-salary-completion-date.mjs
 * Exit 1 nếu bất biến bị phá.
 */
import { readFileSync } from "node:fs";

const REF = readFileSync("supabase/.temp/project-ref", "utf8").trim();
const PAT = (readFileSync("CLAUDE.local.md", "utf8").match(/sbp_[a-z0-9]+/) || [])[0];
if (!PAT) {
  console.error("❌ Không đọc được Supabase PAT từ CLAUDE.local.md");
  process.exit(1);
}

const SQL = `
BEGIN;

DO $check$
DECLARE
  v_owner  uuid;
  v_staff  uuid;
  v_jt     uuid;
  v_job    uuid := gen_random_uuid();
  v_live   uuid := gen_random_uuid();
  v_n      int;
  v_date   date;
  v_photo  boolean;
  v_stamp  timestamptz;
BEGIN
  SELECT sa.user_id INTO v_owner FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1;
  SELECT c.staff_id INTO v_staff FROM public.manager_salary_config c
   WHERE c.user_id = v_owner AND c.is_active LIMIT 1;
  SELECT jt.id INTO v_jt FROM public.job_types jt
   WHERE COALESCE(jt.bonus_amount,0) > 0 AND COALESCE(jt.counts_for_salary,true)
     AND NOT COALESCE(jt.is_contract,false)   -- tránh gate ngoài-giờ làm nhiễu phép thử
   ORDER BY jt.bonus_amount DESC LIMIT 1;

  IF v_owner IS NULL OR v_staff IS NULL OR v_jt IS NULL THEN
    RAISE EXCEPTION 'Thiếu dữ liệu nền (owner=% staff=% job_type=%)', v_owner, v_staff, v_jt;
  END IF;

  -- ===== PHẦN 1: bất biến của LEDGER (fixture ranh giới tháng) =====
  -- Tắt trigger để dựng được mốc quá khứ; đây là phép thử của LEDGER, không
  -- phải của trigger (trigger được thử riêng ở phần 2).
  SET LOCAL session_replication_role = replica;

  INSERT INTO public.jobs (id, user_id, code, title, status, job_type_id, assignee_id,
                           created_at, completion_time, attachments)
  VALUES (v_job, v_owner, 'JOB-CHECK-' || substr(v_job::text, 1, 8),
          '[check-salary-completion-date] fixture ranh giới tháng', 'COMPLETED', v_jt, v_staff,
          TIMESTAMPTZ '2026-07-31 23:50:00+07',   -- TẠO tháng 7
          TIMESTAMPTZ '2026-08-01 00:10:00+07',   -- HOÀN THÀNH tháng 8
          '["check/fixture.jpg"]'::jsonb);

  SET LOCAL session_replication_role = origin;

  -- (1a) KHÔNG được xuất hiện ở kỳ tháng 7
  SELECT COUNT(*) INTO v_n FROM public.salary_work_ledger(DATE '2026-07-01', NULL) l
   WHERE l.source_id = v_job;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL (1a): job hoàn thành 01/08 lại rơi vào kỳ 2026-07 (% dòng). Ledger đang bucket theo created_at?', v_n;
  END IF;

  -- (1b) PHẢI xuất hiện ở kỳ tháng 8, đúng ngày 01/08
  SELECT COUNT(*), MIN(l.occurred_date), BOOL_OR(l.has_photo)
    INTO v_n, v_date, v_photo
    FROM public.salary_work_ledger(DATE '2026-08-01', NULL) l
   WHERE l.source_id = v_job;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL (1b): job hoàn thành 01/08 không có ở kỳ 2026-08 (% dòng)', v_n;
  END IF;
  IF v_date <> DATE '2026-08-01' THEN
    RAISE EXCEPTION 'FAIL (1c): occurred_date = % (mong đợi 2026-08-01). Thiếu vn_local_date → đang đọc giờ UTC?', v_date;
  END IF;

  -- (1d) cổng ảnh: ảnh chỉ nằm ở cột 'attachments' vẫn phải tính là có bằng chứng
  IF NOT v_photo THEN
    RAISE EXCEPTION 'FAIL (1d): has_photo = false dù có ảnh trong jobs.attachments. job_photo_ok bị bỏ?';
  END IF;

  RAISE NOTICE 'OK (1) ledger: vắng ở kỳ 07, có ở kỳ 08 ngày %, has_photo = %', v_date, v_photo;

  -- ===== PHẦN 2: trigger đóng dấu completion_time phía server =====
  -- Client KHÔNG được tự chọn mốc. Ghi thẳng như PostgREST làm, kèm giờ bịa.
  INSERT INTO public.jobs (id, user_id, code, title, status, job_type_id, assignee_id)
  VALUES (v_live, v_owner, 'JOB-CHECK2-' || substr(v_live::text, 1, 8),
          '[check-salary-completion-date] fixture trigger', 'IN_PROGRESS', v_jt, v_staff);

  UPDATE public.jobs
     SET status = 'COMPLETED',
         completion_time = TIMESTAMPTZ '2026-01-01 03:00:00+07'  -- giờ bịa, phải bị ghi đè
   WHERE id = v_live;

  SELECT completion_time INTO v_stamp FROM public.jobs WHERE id = v_live;
  IF v_stamp < now() - INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'FAIL (2): completion_time = % — giờ do client gửi KHÔNG bị server ghi đè. Trigger jobs_stamp_completion_time hỏng?', v_stamp;
  END IF;
  RAISE NOTICE 'OK (2) trigger: giờ bịa 2026-01-01 bị ghi đè thành %', v_stamp;

  -- (2b) CHECK constraint: COMPLETED mà thiếu completion_time phải bị chặn
  BEGIN
    SET LOCAL session_replication_role = replica;
    UPDATE public.jobs SET completion_time = NULL WHERE id = v_live;
    SET LOCAL session_replication_role = origin;
    RAISE EXCEPTION 'FAIL (2b): đặt được completion_time = NULL trên job COMPLETED — thiếu CHECK constraint';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK (2b) constraint chặn completion_time NULL trên job COMPLETED';
  END;

  RAISE NOTICE 'TẤT CẢ BẤT BIẾN ĐỀU ĐÚNG';
END
$check$;

ROLLBACK;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const body = await res.text();
if (res.status >= 200 && res.status < 300) {
  console.log("✅ Bất biến 'lương tính theo lúc HOÀN THÀNH' còn nguyên.");
  console.log("   - job tạo 31/07 23:50 VN, hoàn thành 01/08 00:10 VN → chỉ tính vào kỳ 2026-08");
  console.log("   - occurred_date = 2026-08-01 (vn_local_date đúng múi giờ)");
  console.log("   - ảnh nằm ở cột attachments vẫn tính là có bằng chứng");
  console.log("   - server ghi đè completion_time do client gửi");
  console.log("   - CHECK chặn COMPLETED thiếu completion_time");
  console.log("   (mọi fixture đã ROLLBACK — không còn dòng nào trong DB)");
  process.exit(0);
}

console.error(`❌ FAIL — HTTP ${res.status}`);
console.error(body.slice(0, 2000));
process.exit(1);
