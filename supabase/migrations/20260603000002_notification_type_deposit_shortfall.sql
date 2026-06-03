-- Them gia tri 'DEPOSIT_SHORTFALL' vao enum notification_type de nhac HD thieu coc.
-- ADD VALUE IF NOT EXISTS — an toan chay lai; PG15 cho phep trong transaction
-- mien khong dung gia tri moi ngay trong cung transaction (khong dung o day).
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'DEPOSIT_SHORTFALL';
