-- Them gia tri 'SALARY_BONUS' vao enum notification_type cho thong bao thuong viec.
-- ADD VALUE IF NOT EXISTS — an toan chay lai; PG15 cho phep trong transaction
-- mien khong dung gia tri moi ngay trong cung transaction (khong dung o day).
-- PHAI chay file nay TRUOC va o mot transaction RIENG voi RPC award_job_bonus
-- (file 20260629000011) vi RPC do co INSERT dung 'SALARY_BONUS'.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'SALARY_BONUS';
