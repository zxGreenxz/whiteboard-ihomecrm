# migrations-archive

Chứa các file SQL KHÔNG được apply theo luồng migration bình thường:

- `20260617000001_forfeit_full_settlement.sql` — SUPERSEDED (đánh dấu "KHÔNG APPLY
  RIÊNG"). Logic đã gộp vào migration thanh lý sau đó. Giữ để tra cứu lịch sử.
- `migrations-bundle/` — 14 file "apply_*" hand-apply thời kỳ đầu (Apr–May 2026),
  áp thủ công một lần qua Management API, KHÔNG theo timestamp ordering. Đã phản
  ánh trong DB live. Giữ để tra cứu, TUYỆT ĐỐI KHÔNG replay.

Repo này apply migration TRỰC TIẾP qua Management API (scripts/apply-sql.mjs),
KHÔNG dùng `supabase db push` (schema_migrations đứng từ Feb 2026). Mọi file trong
thư mục này nằm NGOÀI luồng đó để tránh vô tình replay.
