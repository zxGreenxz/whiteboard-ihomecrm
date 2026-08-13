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
-- `email` phải có: forward lane có migration đọc `u.email` từ `auth.users` và
-- chết với "column u.email does not exist" nếu bảng chỉ có `id`. Cùng bài học
-- phạm vi như phần role ở trên — biên phải tính cả forward lane, không chỉ
-- baseline. Vẫn KHÔNG dựng lại toàn bộ bảng users của GoTrue: chỉ hai cột mà
-- diễn tập thật sự chạm tới.
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;

-- Quyền trên schema `public`. Trên Supabase, ba role nền tảng có sẵn quyền này;
-- Postgres trần thì không, và một migration trong forward lane chết với
-- "permission denied for schema public".
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA auth, extensions TO authenticated, anon, service_role;

-- ── Default privileges của nền tảng ──────────────────────────────────────────
-- Supabase đặt sẵn ALTER DEFAULT PRIVILEGES trong `public` cho ba role nền
-- tảng, nên MỌI bảng/hàm tạo ra trên production tự mang GRANT cho chúng.
-- Baseline thì chụp bằng `pg_dump --no-acl` (cố ý — ACL production lẫn cả
-- lịch sử REVOKE tay không replay được), nên không có khối này thì object
-- khôi phục ra đời TRẦN quyền. Đo 13/08/2026, replay 39 file forward lane
-- thiếu nó thì chết hai kiểu, cùng một gốc:
--   · 20260807183000 REVOKE building_of_* FROM PUBLIC rồi VERIFY rằng
--     authenticated vẫn còn EXECUTE — còn thật trên production nhờ grant
--     riêng do default privileges phát lúc tạo hàm; trên bản khôi phục hàm
--     chỉ có PUBLIC mặc định, REVOKE xong là trụi → "authenticated MẤT quyền".
--   · 20260809010000 tự SET LOCAL ROLE authenticated trong khối nghiệm thu
--     rồi SELECT ai_providers → "permission denied for table ai_providers".
--     Thông điệp dễ đọc nhầm thành lỗi superuser; thật ra là SET ROLE hạ
--     quyền xuống một role không được GRANT gì trên bảng.
-- Phải đứng TRƯỚC schema.sql vì default privileges chỉ áp cho object tạo SAU
-- nó — đúng trật tự mà nền tảng thật có. Chỉ schema `public`: Supabase cũng
-- chỉ đặt sẵn ở đó; quyền trên app_private là của app tự GRANT qua migration,
-- shim mà cấp hộ là làm diễn tập dễ hơn thực tế.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated, anon, service_role;

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
