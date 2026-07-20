-- =============================================
-- Migration: Bat lai thuong ky HD ngoai gio 50k cho loai viec `checkin`.
--
-- BUG: 20260630000002_ledger_drop_contract_branch bo nhanh (C) CONTRACT
--   (doc bang `contracts`) khoi salary_work_ledger va chuyen thuong +50k sang
--   viec co `job_types.is_contract = true`. Nhung KHONG job_type nao duoc bat
--   `is_contract`, va `checkin` van de `bonus_amount = 0`
--   => thuong ky HD ngoai gio / CN / Le CHET HOAN TOAN tu 30/06/2026.
--
-- FIX: checkin => is_contract = true, bonus_amount = 50000
--   (khop `salary_bonus_rules.rules->>'afterHourContract'` = 50000).
--
-- Hieu luc:
--   - Nhanh (A) JOB: chi cong 50k khi hoan thanh SAU afterHourMark (18:00)
--     HOAC CN/Le — viec checkin trong gio van 0d.
--   - Nhanh (B) DAY_BONUS: phu cap CN/Le (30k/ngay) nay mo rong cho ngay
--     CN/Le co viec checkin, khong chi rieng viec sua.
--   - award_job_bonus popup dong bo cung quy tac (cung doc job_types).
--
-- An toan: kiem tra 2026-07-20 — KHONG thang nao dang LOCK
--   (salary_monthly deu DRAFT, locked_at IS NULL) => khong pha snapshot nao.
--   Ledger la RPC computed nen so thang 6/7 tinh lai theo config moi.
-- =============================================

BEGIN;

UPDATE public.job_types
SET is_contract  = true,
    bonus_amount = 50000,
    updated_at   = now()
WHERE name = 'checkin';

COMMIT;
