-- ============================================================================
-- Nút "Đồng bộ công ty TEST" — đổi sang hàng đợi chạy bằng pg_cron
-- ============================================================================
-- VÌ SAO PHẢI ĐỔI (đo được, đừng làm lại đường cũ):
--   Bộ chép bắt buộc phải chạy trong session_replication_role='replica' (tắt 407
--   trigger + kiểm tra FK). Trên Supabase, supautils CHỈ nới quyền đặt tham số đó
--   cho role `postgres`, và nó xét theo ROLE CỦA SESSION chứ không theo chủ hàm:
--     • gọi qua Management API (session = postgres) → OK
--     • gọi RPC bằng authenticated  → 42501 permission denied to set parameter
--     • gọi RPC bằng service_role   → 42501 (đã thử, cùng lỗi)
--   SECURITY DEFINER KHÔNG cứu được. Nên trình duyệt không thể tự chạy bộ chép.
--
-- CÁCH LÀM: nút bấm chỉ ĐẶT HÀNG (insert 1 dòng), một job pg_cron chạy 15 giây
-- một lần nhặt đơn và chạy — job của pg_cron chạy dưới username `postgres` nên
-- đặt được tham số. Đổi lại: bấm xong chờ tối đa ~15 giây mới bắt đầu chạy.
--
-- Cân nhắc đã bỏ: dựng edge function nối thẳng Postgres bằng mật khẩu DB. Nhanh
-- hơn nhưng phải nhét mật khẩu database production vào thêm một chỗ nữa — không
-- đáng cho một tiện ích nội bộ.
-- ============================================================================

-- ---- 1. Chuyển phần thân sang clone_org.do_sync() ---------------------------
-- Hàm này KHÔNG tự kiểm quyền: nó nằm trong schema clone_org (không expose ra
-- PostgREST) và chỉ được gọi bởi 2 chỗ đã có đặc quyền — job pg_cron và CLI
-- scripts/clone-org/clone.mjs (chạy qua PAT quản trị). Kiểm quyền nằm ở lớp
-- public.clone_org_request_sync_v1().
CREATE OR REPLACE FUNCTION clone_org.do_sync(p_actor uuid)
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
  r record;
  v_cols text;
  v_exprs text;
  v_where text;
  v_n bigint;
  v_total bigint := 0;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  IF current_setting('session_replication_role') <> 'replica' THEN
    RAISE EXCEPTION 'do_sync yêu cầu session_replication_role=replica (xem ghi chú đầu migration)'
      USING ERRCODE = '55000';
  END IF;

  v_target := (public.sandbox_org_ids())[1];
  IF v_target IS NULL OR v_target = v_source THEN
    RAISE EXCEPTION 'TRIPWIRE: org đích không hợp lệ (%)', v_target USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_target) THEN
    RAISE EXCEPTION 'Chưa có org TEST' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clone_org.user_map) THEN
    RAISE EXCEPTION 'clone_org.user_map rỗng' USING ERRCODE = '55000';
  END IF;

  INSERT INTO clone_org.sync_log (actor) VALUES (p_actor) RETURNING id INTO v_log_id;

  -- 2 trigger ENABLE ALWAYS vẫn chạy trong replica mode → tắt trong transaction.
  ALTER TABLE public.approval_rule_sets DISABLE TRIGGER a00_rule_set_immutable;
  ALTER TABLE public.approval_rules DISABLE TRIGGER a00_rules_immutable;

  CREATE TEMP TABLE _uniq ON COMMIT DROP AS
    SELECT DISTINCT t.relname::text AS tbl, a.attname::text AS col, NOT a.attnotnull AS nullable
    FROM pg_index x
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    JOIN unnest(x.indkey) k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE x.indisunique AND NOT x.indisprimary AND a.atttypid = 'uuid'::regtype
      AND pg_get_indexdef(x.indexrelid) NOT ILIKE '%organization_id%';

  FOR r IN SELECT * FROM clone_org.tables_to_clone() LOOP
    EXECUTE format('DELETE FROM public.%I WHERE organization_id = %L', r.tbl, v_target);
  END LOOP;

  TRUNCATE clone_org.idmap;
  INSERT INTO clone_org.idmap (old_id, new_id)
    SELECT old_user_id, new_user_id FROM clone_org.user_map;

  FOR r IN SELECT * FROM clone_org.tables_to_clone() WHERE has_uuid_id LOOP
    EXECUTE format(
      'INSERT INTO clone_org.idmap (old_id, new_id)
       SELECT id, gen_random_uuid() FROM public.%I WHERE organization_id = %L
       ON CONFLICT (old_id) DO NOTHING', r.tbl, v_source);
  END LOOP;

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

  -- Làm nhiễu liên hệ: thao tác thử không được nhắn/nhắc nợ trúng khách thật.
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

  -- Cắt đính kèm thu chi — chỗ DUY NHẤT app có nút xoá file storage.
  EXECUTE format('UPDATE public.income_expenses SET attachments = ''[]''::jsonb
                  WHERE organization_id = %L AND attachments <> ''[]''::jsonb', v_target);
  EXECUTE format('UPDATE public.income_expense_batches SET attachments = ''[]''::jsonb
                  WHERE organization_id = %L AND attachments <> ''[]''::jsonb', v_target);

  ALTER TABLE public.approval_rule_sets ENABLE ALWAYS TRIGGER a00_rule_set_immutable;
  ALTER TABLE public.approval_rules ENABLE ALWAYS TRIGGER a00_rules_immutable;

  UPDATE clone_org.sync_log
     SET finished_at = now(), ok = true, rows_copied = v_total,
         detail = jsonb_build_object('counts', v_counts)
   WHERE id = v_log_id;

  RETURN jsonb_build_object('ok', true, 'rows', v_total,
                            'tables', (SELECT count(*) FROM jsonb_object_keys(v_counts)),
                            'at', now());
END
$fn$;

-- Hàm cũ không dùng được từ trình duyệt (42501) — bỏ để không ai gọi nhầm.
DROP FUNCTION IF EXISTS public.clone_org_sync_v1();

-- ---- 2. Hàng đợi ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clone_org.sync_request (
  id bigserial PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RUNNING', 'DONE', 'ERROR')),
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error_text text
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_request_one_open
  ON clone_org.sync_request ((1)) WHERE state IN ('PENDING', 'RUNNING');

CREATE OR REPLACE FUNCTION public.clone_org_request_sync_v1()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'clone_org'
AS $fn$
DECLARE v_id bigint; v_last timestamptz;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Chỉ super admin được đồng bộ công ty TEST' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM clone_org.sync_request WHERE state IN ('PENDING', 'RUNNING')) THEN
    RAISE EXCEPTION 'SYNC_IN_PROGRESS' USING ERRCODE = '55000';
  END IF;

  SELECT max(finished_at) INTO v_last FROM clone_org.sync_request WHERE state = 'DONE';
  IF v_last IS NOT NULL AND now() - v_last < interval '2 minutes' THEN
    RAISE EXCEPTION 'COOLDOWN' USING ERRCODE = '55000';
  END IF;

  INSERT INTO clone_org.sync_request (requested_by) VALUES (auth.uid()) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'request_id', v_id, 'state', 'PENDING');
END
$fn$;

REVOKE ALL ON FUNCTION public.clone_org_request_sync_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_org_request_sync_v1() TO authenticated;

-- ---- 3. Người chạy (pg_cron, username = postgres) ---------------------------
CREATE OR REPLACE FUNCTION clone_org.run_pending_sync()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'clone_org'
AS $fn$
DECLARE req record; v_res jsonb;
BEGIN
  -- Không chờ: lượt sau (15 giây nữa) sẽ nhặt tiếp.
  SELECT * INTO req FROM clone_org.sync_request
   WHERE state = 'PENDING' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE clone_org.sync_request SET state = 'RUNNING', started_at = now() WHERE id = req.id;

  BEGIN
    EXECUTE 'SET LOCAL session_replication_role = replica';
    v_res := clone_org.do_sync(req.requested_by);
    UPDATE clone_org.sync_request
       SET state = 'DONE', finished_at = now(), result = v_res WHERE id = req.id;
  EXCEPTION WHEN OTHERS THEN
    -- Khối con rollback nên bản sao dở dang bị huỷ sạch; chỉ ghi lại lỗi.
    UPDATE clone_org.sync_request
       SET state = 'ERROR', finished_at = now(), error_text = SQLSTATE || ': ' || SQLERRM
     WHERE id = req.id;
  END;
END
$fn$;

SELECT cron.schedule('clone_org_sync_worker', '15 seconds',
                     $$SELECT clone_org.run_pending_sync();$$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone_org_sync_worker');

-- ---- 4. Trạng thái cho nút bấm ---------------------------------------------
CREATE OR REPLACE FUNCTION public.clone_org_sync_status_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'clone_org'
AS $$
  SELECT CASE WHEN NOT public.is_super_admin() THEN NULL::jsonb ELSE
    jsonb_build_object(
      'org_id',   (public.sandbox_org_ids())[1],
      'org_name', (SELECT name FROM public.organizations WHERE id = (public.sandbox_org_ids())[1]),
      'last_sync_at', (SELECT max(finished_at) FROM clone_org.sync_log WHERE ok),
      'rows_copied',  (SELECT rows_copied FROM clone_org.sync_log WHERE ok
                        ORDER BY finished_at DESC LIMIT 1),
      'pending', (SELECT jsonb_build_object('id', r.id, 'state', r.state,
                                            'requested_at', r.requested_at,
                                            'error', r.error_text)
                    FROM clone_org.sync_request r ORDER BY r.id DESC LIMIT 1)
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.clone_org_sync_status_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_org_sync_status_v1() TO authenticated;
