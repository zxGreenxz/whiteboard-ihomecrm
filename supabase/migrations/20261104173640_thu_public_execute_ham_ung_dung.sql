-- Thu EXECUTE của PUBLIC trên hàm của ứng dụng (04/11/2026, hậu kiểm review PR #371 ngày 01/11).
--
-- VẤN ĐỀ. Quyền cấp cho PUBLIC là quyền của MỌI vai trong database, kể cả vai đăng nhập thẳng qua pooler, không đi
-- PostgREST. Đo prod và TEST ngày 04/11 (hai bên giống nhau từng hàm và từng ACL): ngoài hàm của extension, public và
-- app_private còn 119 hàm cấp EXECUTE cho PUBLIC — 67 SECURITY DEFINER (21 là trigger) và 52 INVOKER; 51 hàm app_private
-- có proacl NULL, tức mặc định PUBLIC. Login hermes_store_learning (thuộc hermes_learning_ingest) vì thế gọi được 33 hàm
-- DEFINER ở public và 12 ở app_private ngoài đúng một hàm nạp của nó, rồi tự đặt request.jwt.claim.sub là giả danh người
-- dùng (vd public.bulk_create_meter_readings). Login kho bền của connector và các login nền tảng không qua API cũng vậy.
-- Quyền của PUBLIC không thu riêng cho một vai được, nên phải thu ở PUBLIC cho cả hệ thống.
--
-- CÁCH LÀM. Hành vi của vai đang dùng giữ nguyên:
--  1. Với mỗi hàm như trên: cấp tường minh trước, rồi REVOKE ... FROM PUBLIC.
--     · anon, authenticated, service_role giữ ĐÚNG quyền đang có trên mọi hàm không phải trigger: chỉ cấp khi vai đó đang
--       có quyền NHỜ PUBLIC. Thế là phủ cả đường gián tiếp: policy RLS (3 hàm app_private trong policy TO authenticated,
--       hàng trăm policy TO public), view security_invoker, default cột, hàm INVOKER gọi lồng, hàm DEFINER do
--       ie_detail_reader sở hữu (vai này thuộc authenticated nên thừa hưởng). Gồm cả 2 hàm DEFINER mà anon gọi được chỉ
--       nhờ PUBLIC dù 20260621000001 đã REVOKE anon (get_change_breakdown_v2, get_deposit_breakdown_v2: đã nằm trong
--       allowlist của check-definer-acl, trả rỗng khi không đăng nhập). Thu tiếp chúng là việc riêng.
--     · supabase_read_only_user (vai đọc của dashboard/Management API read-only) giữ quyền trên hàm INVOKER (không leo
--       quyền được): câu đọc chẩn đoán và view gọi hàm vẫn chạy. Không giữ hàm DEFINER.
--     · Hàm trigger và event trigger: không cấp cho ai. PostgreSQL không kiểm EXECUTE lúc bắn trigger hay event trigger,
--       chỉ lúc CREATE TRIGGER (do chủ hàm chạy migration). Test PG cục bộ chứng minh trigger DEFINER, trigger INVOKER và
--       event trigger vẫn chạy khi người gây ra không còn EXECUTE.
--  2. Không cấp (đã chứng minh không cần): hermes_store_learning và hermes_learning_ingest chỉ gọi
--     app_private.hermes_store_learning_ingest_v1; hermes_store_host và hermes_store_executor chỉ gọi 22 hàm
--     hermes_store_* / hermes_zalo_provisioning_* cấp riêng, đều DEFINER (store-transport chỉ gửi câu kiểm vai trên
--     pg_catalog và đúng các hàm đó); authenticator, supabase_storage_admin gọi hàm ứng dụng sau khi SET ROLE sang vai API;
--     supabase_auth_admin không có auth hook, trigger trên auth.users là DEFINER; pgbouncer chỉ dùng pgbouncer.get_auth;
--     cli_login_postgres làm việc sau SET ROLE postgres; supabase_etl_admin, supabase_replication_admin,
--     supabase_functions_admin không gọi hàm ứng dụng; dashboard_user, supabase_privileged_role, supabase_realtime_admin,
--     ie_canonical_writer là NOLOGIN và không đường chạy nào biến chúng thành current_user. pg_cron: 11 job đều chạy
--     bằng postgres, là chủ mọi hàm này.
--  3. ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC: hàm postgres tạo sau này không
--     tự cấp PUBLIC. Mặc định Supabase theo schema (public, storage: anon/authenticated/service_role) giữ nguyên. Hàm mới
--     ở app_private chỉ chủ gọi được, nên hàm app_private dùng trong policy, view hay hàm INVOKER phải GRANT EXECUTE
--     tường minh cho vai gọi. PostgreSQL không cho thu PUBLIC theo từng schema, nên lệnh này áp cho mọi schema mà postgres
--     tạo hàm (ngoài public/app_private, postgres chỉ sở hữu hàm extension trong extensions).
--  4. Tự kiểm sau áp, đỏ là cuộn cả file: còn hàm cấp PUBLIC; vai API (hoặc read-only trên INVOKER) mất quyền; vai bị chặn
--     gọi được hàm DEFINER ngoài hàm riêng của nó; mặc định hàm của postgres còn cấp PUBLIC.
-- Idempotent: lượt hai không còn hàm cấp PUBLIC nên không GRANT/REVOKE gì, tự kiểm vẫn chạy. Không đổi thân hàm, không DROP.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $thu$
DECLARE
  f record;
  v_role text;
  v_roles text[];
  v_api CONSTANT text[] := ARRAY['anon','authenticated','service_role'];
  v_giu oid[] := '{}';
  v_giu_invoker oid[] := '{}';
  v_thu integer := 0;
BEGIN
  FOR f IN
    SELECT p.oid, p.oid::regprocedure::text AS sig, p.prosecdef,
      p.prorettype IN ('pg_catalog.trigger'::regtype,'pg_catalog.event_trigger'::regtype) AS trig,
      COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner)) AS acl
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','app_private')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
    ORDER BY n.nspname,p.proname,p.oid
  LOOP
    IF NOT f.trig THEN
      v_roles:=v_api;
      IF NOT f.prosecdef THEN v_roles:=v_roles||'supabase_read_only_user'::text; END IF;
      FOREACH v_role IN ARRAY v_roles LOOP
        CONTINUE WHEN pg_catalog.to_regrole(v_role) IS NULL;
        -- Đã có quyền không qua PUBLIC (cấp thẳng hoặc thừa hưởng) thì để nguyên ACL.
        CONTINUE WHEN EXISTS (SELECT 1 FROM pg_catalog.aclexplode(f.acl) a
          WHERE a.grantee<>0 AND a.privilege_type='EXECUTE' AND pg_catalog.pg_has_role(v_role,a.grantee,'USAGE'));
        EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO %I',f.sig,v_role);
      END LOOP;
      v_giu:=v_giu||f.oid;
      IF NOT f.prosecdef THEN v_giu_invoker:=v_giu_invoker||f.oid; END IF;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC',f.sig);
    v_thu:=v_thu+1;
  END LOOP;
  -- Danh sách vai ghi lại ở đây, không dùng v_api: sửa nhầm một chỗ thì chỗ kia vẫn bắt.
  IF EXISTS (SELECT 1 FROM unnest(v_giu) k(fn) CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) r(rolname)
      WHERE pg_catalog.to_regrole(r.rolname) IS NOT NULL AND NOT pg_catalog.has_function_privilege(r.rolname,k.fn,'EXECUTE'))
    OR (pg_catalog.to_regrole('supabase_read_only_user') IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(v_giu_invoker) k(fn)
      WHERE NOT pg_catalog.has_function_privilege('supabase_read_only_user',k.fn,'EXECUTE'))) THEN
    RAISE EXCEPTION 'public_execute_vai_dang_dung_mat_quyen';
  END IF;
  RAISE NOTICE 'public_execute: thu PUBLIC trên % hàm, giữ quyền vai đang dùng trên % hàm không phải trigger',v_thu,cardinality(v_giu);
END $thu$;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $kiem$
DECLARE v_so integer; v_mau text;
BEGIN
  SELECT count(*),left(string_agg(p.oid::regprocedure::text,', ' ORDER BY p.oid::regprocedure::text),400) INTO v_so,v_mau
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','app_private')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE');
  IF v_so>0 THEN RAISE EXCEPTION 'public_execute_con_ham_cap_public: % (%)',v_so,v_mau; END IF;

  -- Vai bị chặn (và mọi nhóm nó là thành viên, kể cả nhóm chỉ SET ROLE được) không gọi được hàm DEFINER nào ngoài hàm riêng.
  SELECT count(*),left(string_agg(c.rolname||' → '||p.oid::regprocedure::text,', ' ORDER BY c.rolname,p.oid::regprocedure::text),400)
    INTO v_so,v_mau
  FROM (VALUES ('hermes_store_learning','hoc'),('hermes_learning_ingest','hoc'),('hermes_store_host','kho'),
      ('hermes_store_executor','kho'),('pgbouncer','khong'),('supabase_auth_admin','khong'),('supabase_etl_admin','khong'),
      ('supabase_functions_admin','khong'),('supabase_read_only_user','khong'),('supabase_replication_admin','khong'))
    AS c(rolname,nhom)
  JOIN pg_catalog.pg_roles r ON r.rolname=c.rolname
  JOIN pg_catalog.pg_proc p ON p.prosecdef
    AND p.prorettype NOT IN ('pg_catalog.trigger'::regtype,'pg_catalog.event_trigger'::regtype)
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace AND n.nspname IN ('public','app_private')
  WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles g
      WHERE pg_catalog.pg_has_role(r.oid,g.oid,'MEMBER') AND pg_catalog.has_function_privilege(g.oid,p.oid,'EXECUTE'))
    AND NOT (c.nhom='hoc' AND p.oid::regprocedure::text='app_private.hermes_store_learning_ingest_v1(jsonb)')
    AND NOT (c.nhom='kho' AND n.nspname='app_private' AND p.proname<>'hermes_store_learning_ingest_v1'
      AND (p.proname LIKE 'hermes\_store\_%' OR p.proname LIKE 'hermes\_zalo\_provisioning%'));
  IF v_so>0 THEN RAISE EXCEPTION 'public_execute_vai_chan_goi_duoc_definer: % (%)',v_so,v_mau; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl da
      WHERE da.defaclrole='postgres'::regrole AND da.defaclnamespace=0 AND da.defaclobjtype='f'
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(da.defaclacl) a WHERE a.grantee=0))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl da CROSS JOIN LATERAL pg_catalog.aclexplode(da.defaclacl) a
      WHERE da.defaclrole='postgres'::regrole AND da.defaclobjtype='f' AND a.grantee=0) THEN
    RAISE EXCEPTION 'public_execute_mac_dinh_postgres_con_cap_public';
  END IF;
END $kiem$;

COMMIT;
