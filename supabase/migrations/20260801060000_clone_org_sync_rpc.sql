-- ============================================================================
-- ĐỒNG BỘ CÔNG TY TEST — hàm SQL để bấm một nút là chép lại dữ liệu mới nhất
-- ============================================================================
-- Trước đó bộ chép nằm ở scripts/clone-org/clone.mjs (sinh SQL rồi bắn qua
-- Management API). Nó chạy được nhưng phải có PAT + máy dev, và bị throttle
-- ~60 request/phút. Chuyển hẳn logic vào DB để:
--   • bấm nút trong app là đồng bộ được (RPC clone_org_sync_v1)
--   • chạy trong MỘT transaction — hoặc xong sạch, hoặc không đổi gì
--   • nhanh hơn nhiều (không còn round-trip mạng cho từng bảng)
--
-- NGUYÊN TẮC GIỮ NGUYÊN TỪ BẢN JS (đừng bỏ khi sửa):
--  1. session_replication_role='replica' — tắt 407 trigger + kiểm tra FK. Không
--     tắt thì trigger sinh mã / guard khoá sổ / bút toán sẽ băm nát dữ liệu chép.
--     Nhờ tắt FK nên KHÔNG cần sắp thứ tự bảng (DB có 6 cặp FK vòng).
--  2. UNIQUE INDEX vẫn còn hiệu lực — cố ý: va chạm phải nổ, không được im lặng.
--  3. Ánh xạ id theo GIÁ TRỊ mọi cột uuid qua clone_org.idmap, KHÔNG theo FK:
--     rất nhiều tham chiếu thật không có FK (finance_invoice_components.invoice_id,
--     income_expenses.posting_id, finance_room_month_snapshots.room_id…).
--  4. map_text() đổi cả uuid nhúng trong text/jsonb ⇒ URL ảnh của bản sao rơi vào
--     thư mục của user test, không dùng chung object với công ty thật.
--  5. Hai trigger ENABLE ALWAYS (approval_rule_sets/approval_rules) vẫn chạy
--     trong replica mode ⇒ phải tắt/bật ngay trong transaction này.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS clone_org;
REVOKE ALL ON SCHEMA clone_org FROM PUBLIC;

-- ---- cấu hình ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clone_org.user_map (
  old_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  new_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE
);
COMMENT ON TABLE clone_org.user_map IS
  'Ánh xạ 4 tài khoản org thật → 4 tài khoản test.*; do scripts/clone-org/create-users.mjs nạp.';

CREATE TABLE IF NOT EXISTS clone_org.skip_table (tbl text PRIMARY KEY, reason text NOT NULL);
CREATE TABLE IF NOT EXISTS clone_org.null_org_parent (tbl text, col text, PRIMARY KEY (tbl, col));
CREATE TABLE IF NOT EXISTS clone_org.code_suffix_col (tbl text, col text, PRIMARY KEY (tbl, col));
CREATE TABLE IF NOT EXISTS clone_org.idmap (old_id uuid PRIMARY KEY, new_id uuid NOT NULL);
CREATE TABLE IF NOT EXISTS clone_org.sync_log (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok boolean NOT NULL DEFAULT false,
  actor uuid,
  rows_copied bigint,
  detail jsonb
);

INSERT INTO clone_org.skip_table (tbl, reason) VALUES
  ('zalo_accounts', 'kênh gửi ra ngoài'), ('zalo_automations', 'kênh gửi ra ngoài'),
  ('zalo_conversations', 'kênh gửi ra ngoài'), ('zalo_labels', 'kênh gửi ra ngoài'),
  ('zalo_message_templates', 'kênh gửi ra ngoài'), ('zalo_messages', 'kênh gửi ra ngoài'),
  ('zalo_send_queue', 'worker quét KHÔNG lọc org — chép là nhắn khách thật'),
  ('notifications', 'thông báo'), ('notification_logs', 'thông báo'),
  ('notification_preferences', 'thông báo'), ('notification_templates', 'thông báo'),
  ('push_subscriptions', 'endpoint unique toàn cục'), ('push_send_log', 'nhật ký push'),
  ('invoice_audit_log', 'nhật ký'), ('income_expense_audit_log', 'nhật ký'),
  ('authorization_audit_events', 'nhật ký'), ('accounting_repair_audit', 'nhật ký'),
  ('income_expense_type_merge_audit', 'nhật ký'), ('accounting_integrity_exceptions', 'nhật ký'),
  ('income_expense_type_reference_repair_audit', 'nhật ký'),
  ('authorization_migration_exceptions', 'nhật ký'), ('ai_write_audit', 'nhật ký'),
  ('cron_runs', 'nhật ký'), ('salary_award_errors', 'nhật ký'),
  ('public_room_events', 'trang công khai'), ('public_room_settings', 'trang công khai'),
  ('public_room_share_tokens', 'trang công khai'), ('room_pass_listings', 'trang công khai'),
  ('lucky_events', 'trang công khai'), ('lucky_event_teams', 'trang công khai'),
  ('ai_chat_messages', 'AI'), ('ai_chat_threads', 'AI'), ('ai_providers', 'AI'),
  ('ai_usage_logs', 'AI'), ('ai_copilot_settings', 'AI'), ('ai_copilot_entitlements', 'AI'),
  ('demo_reset_tables', 'hạ tầng demo'), ('demo_reset_log', 'hạ tầng demo'),
  ('super_admins', 'TUYỆT ĐỐI không chép — super admin bypass xuyên tenant'),
  ('legacy_owner_organization_map', 'bootstrap'), ('legacy_owner_allowlist', 'bootstrap'),
  ('permission_definitions', 'danh mục dùng chung'), ('organizations', 'chính nó'),
  ('organization_invitations', 'lời mời'),
  ('profiles', 'id = auth user id, do create-users.mjs dựng')
ON CONFLICT (tbl) DO UPDATE SET reason = EXCLUDED.reason;

INSERT INTO clone_org.null_org_parent (tbl, col) VALUES
  ('inspection_photos', 'session_id'),
  ('inspection_sessions', 'user_id'), ('inspection_sessions', 'building_id'), ('inspection_sessions', 'job_id'),
  ('building_fee_accounts', 'building_id'), ('building_fee_accounts', 'user_id'),
  ('material_usages', 'user_id'), ('material_usages', 'job_id'),
  ('material_usage_items', 'usage_id'),
  ('cash_handovers', 'giver_id'), ('cash_handovers', 'receiver_id'),
  ('cash_handover_items', 'handover_id'),
  ('salary_attendance_day', 'user_id'), ('settings', 'user_id'),
  ('profit_managers', 'user_id'), ('profit_managers', 'auth_user_id'),
  ('profit_manager_salaries', 'user_id'), ('profit_manager_salaries', 'manager_id'),
  ('profit_manager_salary_buildings', 'user_id'), ('profit_manager_salary_buildings', 'salary_id')
ON CONFLICT DO NOTHING;

INSERT INTO clone_org.code_suffix_col (tbl, col) VALUES
  ('accounts', 'code'), ('cash_handovers', 'code'), ('contracts', 'public_code'),
  ('deposits', 'code'), ('document_templates', 'code'), ('invoices', 'invoice_number'),
  ('jobs', 'code'), ('material_adjustments', 'code'), ('material_purchases', 'code'),
  ('material_usages', 'code'), ('meter_readings', 'reading_code')
ON CONFLICT DO NOTHING;

-- ---- hàm ánh xạ -------------------------------------------------------------
CREATE OR REPLACE FUNCTION clone_org.map(p uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'clone_org' AS $$
  SELECT COALESCE((SELECT m.new_id FROM clone_org.idmap m WHERE m.old_id = p), p);
$$;

-- Dùng cho cột uuid nằm trong UNIQUE INDEX không kèm organization_id: không ánh
-- xạ được nghĩa là trỏ ra ngoài bản sao ⇒ phải NULL, giữ nguyên là đụng unique.
CREATE OR REPLACE FUNCTION clone_org.map_strict(p uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'clone_org' AS $$
  SELECT (SELECT m.new_id FROM clone_org.idmap m WHERE m.old_id = p);
$$;

CREATE OR REPLACE FUNCTION clone_org.map_arr(p uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'clone_org' AS $$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE
    (SELECT array_agg(clone_org.map(x) ORDER BY o) FROM unnest(p) WITH ORDINALITY t(x, o)) END;
$$;

CREATE OR REPLACE FUNCTION clone_org.map_text(p text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path TO 'pg_catalog', 'clone_org' AS $$
DECLARE u text; r text := p; n uuid;
BEGIN
  IF p IS NULL OR p !~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-' THEN RETURN p; END IF;
  FOR u IN SELECT DISTINCT m[1] FROM regexp_matches(
      p, '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') m
  LOOP
    SELECT i.new_id INTO n FROM clone_org.idmap i WHERE i.old_id = u::uuid;
    IF n IS NOT NULL THEN r := replace(r, u, n::text); END IF;
  END LOOP;
  RETURN r;
END $$;

-- ---- danh sách bảng sẽ chép -------------------------------------------------
CREATE OR REPLACE FUNCTION clone_org.tables_to_clone()
RETURNS TABLE (tbl text, has_uuid_id boolean)
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'public', 'clone_org' AS $$
  SELECT c.relname::text,
         EXISTS (SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attname = 'id'
                   AND a.atttypid = 'uuid'::regtype AND a.attnum > 0 AND NOT a.attisdropped)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'organization_id'
                  AND a.attnum > 0 AND NOT a.attisdropped)
    AND c.relname NOT LIKE 'network\_%'
    AND NOT EXISTS (SELECT 1 FROM clone_org.skip_table s WHERE s.tbl = c.relname)
  ORDER BY c.relname;
$$;

-- ============================================================================
-- public.clone_org_sync_v1() — chép lại toàn bộ dữ liệu org thật sang org TEST
-- ============================================================================
-- VOLATILE (không phải STABLE): hàm GHI dữ liệu và lấy khoá. Khai STABLE là
-- PostgREST chạy nó trong transaction READ ONLY → 25006 (án lệ đã cắn 5 lần).
CREATE OR REPLACE FUNCTION public.clone_org_sync_v1()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'clone_org'
AS $fn$
DECLARE
  v_source uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_target uuid;
  v_log_id bigint;
  v_last timestamptz;
  r record;
  v_cols text;
  v_exprs text;
  v_where text;
  v_n bigint;
  v_total bigint := 0;
  v_counts jsonb := '{}'::jsonb;
  v_dropped jsonb := '{}'::jsonb;
BEGIN
  -- Câu lệnh này chạy vài chục giây; role authenticated bị chặn ở 8s.
  SET LOCAL statement_timeout = '900s';
  SET LOCAL lock_timeout = '30s';

  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Chỉ super admin được đồng bộ công ty TEST' USING ERRCODE = '42501';
  END IF;

  v_target := (public.sandbox_org_ids())[1];
  IF v_target IS NULL OR v_target = v_source THEN
    RAISE EXCEPTION 'TRIPWIRE: org đích không hợp lệ (%)', v_target USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_target) THEN
    RAISE EXCEPTION 'Chưa có org TEST — chạy scripts/clone-org/create-users.mjs trước' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clone_org.user_map) THEN
    RAISE EXCEPTION 'clone_org.user_map rỗng — chưa ánh xạ tài khoản test' USING ERRCODE = '55000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtext('clone_org_sync')) THEN
    RAISE EXCEPTION 'SYNC_IN_PROGRESS' USING ERRCODE = '55000';
  END IF;

  SELECT max(finished_at) INTO v_last FROM clone_org.sync_log WHERE ok;
  IF v_last IS NOT NULL AND now() - v_last < interval '2 minutes' THEN
    RAISE EXCEPTION 'COOLDOWN: vừa đồng bộ lúc %, chờ 2 phút', v_last USING ERRCODE = '55000';
  END IF;

  INSERT INTO clone_org.sync_log (actor) VALUES (auth.uid()) RETURNING id INTO v_log_id;

  -- Tắt trigger + kiểm tra FK cho riêng transaction này.
  -- PHẢI dùng EXECUTE 'SET …' chứ KHÔNG dùng set_config(): supautils của Supabase
  -- chỉ nới quyền cho role postgres ở tầng câu lệnh SET (ProcessUtility hook);
  -- gọi set_config() ném thẳng 42501 permission denied to set parameter.
  EXECUTE 'SET LOCAL session_replication_role = replica';
  -- 2 trigger ENABLE ALWAYS vẫn chạy trong replica mode → tắt trong transaction.
  ALTER TABLE public.approval_rule_sets DISABLE TRIGGER a00_rule_set_immutable;
  ALTER TABLE public.approval_rules DISABLE TRIGGER a00_rules_immutable;

  -- Cột uuid nằm trong UNIQUE INDEX không kèm organization_id.
  CREATE TEMP TABLE _uniq ON COMMIT DROP AS
    SELECT DISTINCT t.relname::text AS tbl, a.attname::text AS col, NOT a.attnotnull AS nullable
    FROM pg_index x
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    JOIN unnest(x.indkey) k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE x.indisunique AND NOT x.indisprimary AND a.atttypid = 'uuid'::regtype
      AND pg_get_indexdef(x.indexrelid) NOT ILIKE '%organization_id%';

  -- 1. Dọn dữ liệu bản sao cũ.
  FOR r IN SELECT * FROM clone_org.tables_to_clone() LOOP
    EXECUTE format('DELETE FROM public.%I WHERE organization_id = %L', r.tbl, v_target);
  END LOOP;

  -- 2. Nạp ánh xạ id.
  TRUNCATE clone_org.idmap;
  INSERT INTO clone_org.idmap (old_id, new_id)
    SELECT old_user_id, new_user_id FROM clone_org.user_map;

  FOR r IN SELECT * FROM clone_org.tables_to_clone() WHERE has_uuid_id LOOP
    EXECUTE format(
      'INSERT INTO clone_org.idmap (old_id, new_id)
       SELECT id, gen_random_uuid() FROM public.%I WHERE organization_id = %L
       ON CONFLICT (old_id) DO NOTHING', r.tbl, v_source);
  END LOOP;

  -- Vét thêm dòng organization_id IS NULL nhưng cha đã vào idmap (3 vòng cho
  -- chuỗi cha–con nhiều tầng: material_usages → material_usage_items…).
  FOR i IN 1..3 LOOP
    FOR r IN
      SELECT p.tbl, string_agg(format('%I IN (SELECT old_id FROM clone_org.idmap)', p.col), ' OR ') AS pred
      FROM clone_org.null_org_parent p
      JOIN clone_org.tables_to_clone() t ON t.tbl = p.tbl AND t.has_uuid_id
      WHERE EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'public' AND c.table_name = p.tbl AND c.column_name = p.col)
      GROUP BY p.tbl
    LOOP
      EXECUTE format(
        'INSERT INTO clone_org.idmap (old_id, new_id)
         SELECT id, gen_random_uuid() FROM public.%I
         WHERE organization_id IS NULL AND (%s) ON CONFLICT (old_id) DO NOTHING', r.tbl, r.pred);
    END LOOP;
  END LOOP;

  -- 3. Chép.
  FOR r IN SELECT * FROM clone_org.tables_to_clone() LOOP
    SELECT string_agg(quote_ident(z.col), ', ' ORDER BY z.ord),
           string_agg(z.expr, ', ' ORDER BY z.ord)
      INTO v_cols, v_exprs
    FROM (
      SELECT c.column_name AS col, c.ordinal_position AS ord,
        CASE
          WHEN c.column_name = 'organization_id' THEN quote_literal(v_target) || '::uuid'
          WHEN c.udt_name = 'uuid' AND EXISTS (
                 SELECT 1 FROM _uniq u WHERE u.tbl = r.tbl AND u.col = c.column_name AND u.nullable)
            THEN 'clone_org.map_strict(src.' || quote_ident(c.column_name) || ')'
          WHEN c.udt_name = 'uuid' THEN 'clone_org.map(src.' || quote_ident(c.column_name) || ')'
          WHEN c.udt_name = '_uuid' THEN 'clone_org.map_arr(src.' || quote_ident(c.column_name) || ')'
          WHEN c.udt_name IN ('json', 'jsonb')
            THEN 'clone_org.map_text(src.' || quote_ident(c.column_name) || '::text)::' || c.udt_name
          WHEN EXISTS (SELECT 1 FROM clone_org.code_suffix_col s
                       WHERE s.tbl = r.tbl AND s.col = c.column_name)
            THEN 'CASE WHEN src.' || quote_ident(c.column_name) || ' IS NULL THEN NULL ELSE clone_org.map_text(src.'
                 || quote_ident(c.column_name) || ') || ''-T'' END'
          WHEN c.udt_name IN ('text', 'varchar')
            THEN 'clone_org.map_text(src.' || quote_ident(c.column_name) || ')'
          ELSE 'src.' || quote_ident(c.column_name)
        END AS expr
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = r.tbl
        AND c.is_generated = 'NEVER' AND c.is_identity = 'NO'
    ) z;

    IF v_cols IS NULL THEN CONTINUE; END IF;

    v_where := CASE WHEN r.has_uuid_id
                    THEN 'src.id IN (SELECT old_id FROM clone_org.idmap)'
                    ELSE format('src.organization_id = %L', v_source) END;
    -- Cột NOT NULL unique-toàn-cục không ánh xạ được ⇒ bỏ dòng (nếu không sẽ
    -- đụng unique với chính dòng của công ty thật). Có đếm, không im lặng.
    SELECT v_where || COALESCE(string_agg(
             format(' AND src.%I IN (SELECT old_id FROM clone_org.idmap)', u.col), ''), '')
      INTO v_where
    FROM _uniq u WHERE u.tbl = r.tbl AND NOT u.nullable;

    EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM public.%I src WHERE %s',
                   r.tbl, v_cols, v_exprs, r.tbl, v_where);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      v_total := v_total + v_n;
      v_counts := v_counts || jsonb_build_object(r.tbl, v_n);
    END IF;
  END LOOP;

  -- 4. Làm nhiễu liên hệ (không để thao tác thử nhắn trúng khách thật).
  FOR r IN
    SELECT c.table_name AS tbl, c.column_name AS col, (c.column_name ~* 'email') AS is_email
    FROM information_schema.columns c
    JOIN clone_org.tables_to_clone() t ON t.tbl = c.table_name
    WHERE c.table_schema = 'public' AND c.udt_name IN ('text', 'varchar')
      AND c.column_name ~* '(phone|mobile|zalo|email)'
      AND c.column_name !~* '(verified|confirmed|_at$|_id$)'
  LOOP
    EXECUTE format(
      'UPDATE public.%I SET %I = %s WHERE organization_id = %L AND %I IS NOT NULL',
      r.tbl, r.col,
      CASE WHEN r.is_email
        THEN '''test+'' || substr(md5(id::text), 1, 10) || ''@example.invalid'''
        ELSE '''09'' || lpad((abs((''x'' || substr(md5(id::text), 1, 8))::bit(32)::int) % 100000000)::text, 8, ''0'')'
      END, v_target, r.col);
  END LOOP;

  -- 5. Cắt đính kèm thu chi — chỗ DUY NHẤT app có nút xoá file storage.
  EXECUTE format('UPDATE public.income_expenses SET attachments = ''[]''::jsonb
                  WHERE organization_id = %L AND attachments <> ''[]''::jsonb', v_target);
  EXECUTE format('UPDATE public.income_expense_batches SET attachments = ''[]''::jsonb
                  WHERE organization_id = %L AND attachments <> ''[]''::jsonb', v_target);

  ALTER TABLE public.approval_rule_sets ENABLE ALWAYS TRIGGER a00_rule_set_immutable;
  ALTER TABLE public.approval_rules ENABLE ALWAYS TRIGGER a00_rules_immutable;

  UPDATE clone_org.sync_log
     SET finished_at = now(), ok = true, rows_copied = v_total,
         detail = jsonb_build_object('counts', v_counts, 'dropped', v_dropped)
   WHERE id = v_log_id;

  RETURN jsonb_build_object('ok', true, 'rows', v_total, 'tables',
                            (SELECT count(*) FROM jsonb_object_keys(v_counts)),
                            'at', now(), 'counts', v_counts);
END
$fn$;

COMMENT ON FUNCTION public.clone_org_sync_v1() IS
  'Chép lại toàn bộ dữ liệu công ty thật sang org TEST (sandbox_org_ids()[1]). '
  'Chỉ super admin. Một transaction, có advisory lock + cooldown 2 phút. '
  'Xoá sạch dữ liệu org TEST cũ rồi chép mới — mọi thay đổi đang test sẽ MẤT.';

REVOKE ALL ON FUNCTION public.clone_org_sync_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_org_sync_v1() TO authenticated;

-- ---- trạng thái lần đồng bộ gần nhất (cho nút bấm hiển thị) -----------------
CREATE OR REPLACE FUNCTION public.clone_org_sync_status_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'clone_org'
AS $$
  SELECT CASE WHEN NOT public.is_super_admin() THEN NULL::jsonb ELSE
    (SELECT jsonb_build_object(
              'org_id', (public.sandbox_org_ids())[1],
              'org_name', (SELECT name FROM public.organizations WHERE id = (public.sandbox_org_ids())[1]),
              'last_sync_at', l.finished_at,
              'last_ok', l.ok,
              'rows_copied', l.rows_copied)
       FROM clone_org.sync_log l WHERE l.ok ORDER BY l.finished_at DESC LIMIT 1)
  END;
$$;

REVOKE ALL ON FUNCTION public.clone_org_sync_status_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_org_sync_status_v1() TO authenticated;
