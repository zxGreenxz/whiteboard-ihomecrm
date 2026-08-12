-- Shim NỀN TẢNG cho diễn tập khôi phục trên PostgreSQL trần.
--
-- VIẾT TAY, KHÁC HẲN roles.sql
--   `roles.sql` do `capture-schema-baseline.mjs` sinh ra và chỉ chụp role của
--   ỨNG DỤNG (7 role: ie_canonical_writer, openclaw_*, supabase_privileged_role).
--   Đúng phạm vi của nó — những thứ dưới đây KHÔNG phải của app, chúng do nền
--   tảng Supabase dựng sẵn trong mọi project. Chụp chúng vào baseline sẽ là chép
--   lại hạ tầng của người khác vào bản sao lưu của mình.
--
-- VÌ SAO VẪN CẦN
--   Diễn tập khôi phục chạy trên `postgres:17.6` TRẦN — không có role, schema hay
--   extension nào của Supabase. Đo thật 12/08/2026, khôi phục thẳng lên PG trần:
--     tables 427/439 · views 14/14 · policies 512/1193 (43%) · triggers 485/493
--   1123 lỗi, và 614 trong số đó chỉ là một câu: role "authenticated" does not
--   exist. Chính nó nuốt mất 681 policy.
--
--   Nghĩa là con số "43% policy" KHÔNG phải bản sao lưu hỏng — mà là phép đo sai
--   môi trường. Không có shim này thì mỗi lần diễn tập đều đỏ vì cùng một lý do
--   không liên quan gì tới chất lượng bản sao lưu, và một phép kiểm đỏ thường
--   trực vì lý do sai là phép kiểm người ta sẽ ngừng đọc.
--
-- PHẠM VI CỐ Ý HẸP: chỉ dựng đúng thứ `schema.sql` THAM CHIẾU, đo bằng cách đọc
-- chính file đó. Thêm thứ Supabase có mà baseline không dùng sẽ làm diễn tập
-- "dễ hơn thực tế" — che mất đúng loại lệch mà nó sinh ra để bắt.
--
-- KHÔNG BAO GIỜ chạy file này lên project thật. Nó chỉ dành cho đích diễn tập.

-- ── Role nền tảng ────────────────────────────────────────────────────────────
-- `authenticated` là role duy nhất `schema.sql` tham chiếu (614 lần).
--
-- `anon` và `service_role` thì KHÔNG xuất hiện trong schema.sql — bản đầu vì thế
-- không tạo chúng, đúng nguyên tắc hẹp ở trên. Nhưng đo tiếp 12/08/2026 cho thấy
-- phạm vi đó hẹp QUÁ MỘT BƯỚC: diễn tập đầy đủ không dừng ở baseline, nó còn
-- replay 35 migration sau mốc cutoff, và **23 trong số đó chết cùng một câu**
-- `role "anon" does not exist`. Phạm vi đúng là "thứ mà BÀI DIỄN TẬP tham chiếu",
-- không phải "thứ mà schema.sql tham chiếu".
--
-- Vẫn giữ nguyên tắc: chỉ ba role nền tảng này, không chép cả bộ role của Supabase.
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Schema nền tảng ──────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;

-- ── auth.users ───────────────────────────────────────────────────────────────
-- 183 tham chiếu, hầu hết là khoá ngoại `REFERENCES auth.users(id)`. Chỉ cần cột
-- `id` để khoá ngoại dựng được; KHÔNG dựng lại toàn bộ bảng users của GoTrue —
-- diễn tập kiểm cấu trúc của app, không kiểm hạ tầng đăng nhập.
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);

-- ── auth.uid() / auth.jwt() / auth.role() ────────────────────────────────────
-- 650 policy gọi `auth.uid()`. Trả NULL là đúng ngữ nghĩa cho một phiên không
-- đăng nhập, và đủ để policy DỰNG ĐƯỢC — thứ diễn tập cần đếm. Nó KHÔNG mô phỏng
-- hành vi lúc chạy, và đừng dùng bản khôi phục này để kết luận về RLS: phép kiểm
-- RLS-với-role-thật là bước riêng, chạy sau, trên dữ liệu thật.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;

-- ── extensions.digest() ──────────────────────────────────────────────────────
-- 149 tham chiếu. Trên Supabase đây là `pgcrypto` được cài vào schema
-- `extensions`. Cài thật thay vì viết hàm giả: pgcrypto có sẵn trong image
-- postgres chính thức, và một `digest()` giả sẽ làm mọi cột sinh từ nó SAI GIÁ
-- TRỊ mà vẫn dựng được — kiểu hỏng tệ nhất.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
