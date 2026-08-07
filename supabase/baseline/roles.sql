-- SINH BỞI scripts/capture-schema-baseline.mjs — không sửa tay.
-- Chạy TRƯỚC schema.sql. Xem ghi chú trong script để biết vì sao file này tồn tại.

DO $$ BEGIN CREATE ROLE ie_canonical_writer NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE openclaw_function_owner NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE openclaw_maintenance_writer NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE openclaw_migration_writer NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE openclaw_runtime_writer NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE openclaw_service_dispatcher NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE supabase_privileged_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
