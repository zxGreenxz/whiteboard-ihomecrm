-- Hermes học có kiểm duyệt: login của job nạp đề xuất trên host (điều phối chốt 01/11/2026, thay đường tạo login ngoài repo).
-- Vai này TẠO RA Ở TRẠNG THÁI NOLOGIN và không có mật khẩu: file này công khai nên không chứa mật khẩu hay verifier. Bật đăng nhập là
-- việc riêng của scripts/hermes-learning-login.mjs (đúng một câu ALTER ROLE, verifier đọc từ file ngoài repo). Chỉ thuộc đúng một nhóm
-- hermes_learning_ingest; KHÔNG thuộc hermes_store_executor nên lộ mật khẩu job nạp không mở được kho bền của connector.
-- Chạy lại an toàn và không đụng trạng thái đăng nhập, mật khẩu đã bật. Không phụ thuộc thứ tự với 20261031041523: cửa idempotent dán
-- từng file lên production rồi ROLLBACK, nên file này tự dựng nhóm NOLOGIN (cùng định nghĩa, cùng IF NOT EXISTS) thay vì dừng khi chưa có.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_learning_ingest') THEN
    CREATE ROLE hermes_learning_ingest NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_store_learning') THEN
    CREATE ROLE hermes_store_learning NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $role$;

-- Cùng trần với kho bền của connector (hermes_store_host).
ALTER ROLE hermes_store_learning SET statement_timeout='8s';
ALTER ROLE hermes_store_learning SET lock_timeout='3s';
ALTER ROLE hermes_store_learning SET idle_in_transaction_session_timeout='10s';
GRANT hermes_learning_ingest TO hermes_store_learning;

DO $check$
DECLARE v_groups text[]; v_config text[];
BEGIN
  SELECT array_agg(g.rolname::text ORDER BY g.rolname) INTO v_groups
    FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid
    WHERE m.member='hermes_store_learning'::regrole;
  IF v_groups IS DISTINCT FROM ARRAY['hermes_learning_ingest'] THEN RAISE EXCEPTION 'hermes_store_learning_groups_unsafe'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hermes_store_learning'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolinherit))
    THEN RAISE EXCEPTION 'hermes_store_learning_role_unsafe'; END IF;
  SELECT rolconfig INTO v_config FROM pg_roles WHERE rolname='hermes_store_learning';
  IF NOT (v_config @> ARRAY['statement_timeout=8s','lock_timeout=3s','idle_in_transaction_session_timeout=10s'])
    THEN RAISE EXCEPTION 'hermes_store_learning_timeouts_missing'; END IF;
END $check$;

COMMIT;
