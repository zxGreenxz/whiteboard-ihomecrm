-- ============================================================
-- V5 SEED — KHỞI ĐỘNG THỬ (2026-07-03)
-- Mục đích: cho JOEY + NATHAN bắt đầu dùng v5 HÔM NAY mà không mất chuỗi.
--   1) Ghi NGÀY-CÔNG (ticked) cho 01/07 & 02/07 → chuỗi = 2, hôm nay tick tiếp = 3.
--   2) Đánh dấu TOÀN BỘ 17 toà thật đã được nhân viên kiểm tra FULL vào 01/07
--      → building_coverage: last_touch = 01/07, D = 2 hôm nay (dưới SLA 4/3), không toà nào quá hạn.
-- Bỏ 7 toà ảo (Chung ×4, Kho Văn Phòng Chung, Test ×2 — 0 phòng).
-- Attribution inspection theo lịch sử job (Nathan busy 9 + 45/3TTT; Joey 6 + 65NTG).
-- Marker revert: inspection_sessions.condition_note = SEED_MARKER;
--                salary_attendance_day.evidence[].note LIKE 'seed khởi động thử%'.
-- REVERT: scripts/v5_seed_trial_start_2026_07_03_rollback.sql
-- Idempotent: chạy lại vô hại (Part A xoá-rồi-chèn theo marker; Part B tick binary).
-- ============================================================

-- ---------- PART A: 17 phiên FULL 'passed' ngày 01/07 (reset đồng hồ coverage) ----------
DELETE FROM public.inspection_sessions
WHERE session_date = DATE '2026-07-01'
  AND condition_note = 'OK — seed khởi động thử v5 (2026-07-03)';

INSERT INTO public.inspection_sessions
  (user_id, building_id, type, status, session_date, started_at, ended_at,
   dwell_seconds, photos_count, condition_note, checklist)
SELECT s.staff_id, s.building_id, 'FULL', 'passed', DATE '2026-07-01',
       TIMESTAMPTZ '2026-07-01 09:00:00+07', TIMESTAMPTZ '2026-07-01 09:30:00+07',
       1200, 0, 'OK — seed khởi động thử v5 (2026-07-03)', '[]'::jsonb
FROM (VALUES
  -- NATHAN (df8d1df5) — 10 toà
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, '59c6fc2c-2369-4ec8-b253-1ac64abb2f45'::uuid), -- 102LVT
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, 'd76268b2-9513-460d-bd2d-149e613de1ac'::uuid), -- 1392QT
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, '835cd8b8-709d-4942-9c88-d7bd987381c2'::uuid), -- 15KV
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, 'b4299169-5658-4f67-9344-e93fc4a5a81d'::uuid), -- 331PHI
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, 'a0168e75-cc75-4d17-9c9a-463c900227e1'::uuid), -- 403PVB
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, 'e823da47-9ec3-4c31-aa63-5cabc58b80b9'::uuid), -- 405PVB
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, 'd6610998-457c-4b9c-8016-073fd0f827fe'::uuid), -- 44TL
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, '2d4dbefc-0a7e-4888-b179-d02f0a8369a4'::uuid), -- 481NVK
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, 'dfca120d-2f5a-46c7-8ee1-286be6b4e6bf'::uuid), -- 512TT
  ('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, 'c4eb87df-758d-4e16-82dc-040f49e6adfc'::uuid), -- 45/3 Trần Thái Tông
  -- JOEY (d45a7506) — 7 toà
  ('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, '1eae0e82-9c58-4dba-aeb4-13ade8e1a146'::uuid), -- 111PVC
  ('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, '5f3b02fe-86b4-4605-8f5a-2d6e0503a7e2'::uuid), -- 158PVC
  ('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, 'd1428a49-d315-4bb1-833c-56dc87dd8363'::uuid), -- 162NVK
  ('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, '407328f0-bf58-4c75-8bb3-4a862c5ebb14'::uuid), -- 32PVC
  ('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, 'daeeb8c4-8553-4da6-bc17-81ec87bbe93d'::uuid), -- 417LVT
  ('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, '6e02bd65-41f2-4e5e-b755-12b65846f785'::uuid), -- 80DS3
  ('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, '62aa2f61-c410-4703-a96e-d00697818439'::uuid)  -- 65NTG
) AS s(staff_id, building_id);

-- ---------- PART B: tick ngày-công 01/07 & 02/07 (đường ghi chính, tự recompute streak) ----------
SELECT public.v5_tick_attendance('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, DATE '2026-07-01', 'FULL', NULL::uuid, 'seed khởi động thử v5 2026-07-03');
SELECT public.v5_tick_attendance('d45a7506-5250-4d99-ac94-9f73cbd4df17'::uuid, DATE '2026-07-02', 'FULL', NULL::uuid, 'seed khởi động thử v5 2026-07-03');
SELECT public.v5_tick_attendance('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, DATE '2026-07-01', 'FULL', NULL::uuid, 'seed khởi động thử v5 2026-07-03');
SELECT public.v5_tick_attendance('df8d1df5-1c24-4723-9733-4640c43c382b'::uuid, DATE '2026-07-02', 'FULL', NULL::uuid, 'seed khởi động thử v5 2026-07-03');
