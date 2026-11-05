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
-- CÁCH LÀM. Với mỗi hàm như trên: cấp tường minh cho đúng vai THẬT SỰ dùng, rồi REVOKE ... FROM PUBLIC.
--  1. Vai thật sự dùng (anon, authenticated, service_role, supabase_read_only_user) suy từ pg_depend — đúng những đường mà
--     vai đó tự chạy hàm mà KHÔNG gọi tên nó (vai API không có USAGE app_private nên không gọi tên được):
--       · policy RLS: vai chịu policy (thuộc vai của policy hoặc policy TO public, không BYPASSRLS) và có quyền trên bảng;
--       · view security_invoker: vai đọc được view;
--       · default/generated, CHECK, chỉ mục biểu thức, WHEN của trigger: vai ghi được bảng.
--     Chỉ cấp khi vai đó đang có quyền NHỜ PUBLIC (đã có quyền riêng thì để nguyên ACL). Hàm public vốn đã cấp riêng cho ba
--     vai API (mặc định Supabase) nên không đổi. Đo prod/TEST: cấp đúng 4 dòng — authenticated trên 3 helper app_private
--     trong policy TO authenticated (buildings_i_can_see, invoice_of_payment_collection, user_of_invoice) và
--     supabase_read_only_user trên vn_local_date (view building_coverage). Mọi hàm app_private khác (vd
--     ensure_org_boundary_v1 chạy DDL) chỉ còn chủ gọi được. supabase_read_only_user (BYPASSRLS, không ghi) chỉ nhận hàm
--     INVOKER mà view nó đọc dùng tới; gọi thẳng hàm ứng dụng qua endpoint read-only không còn (đọc chẩn đoán đi pooler).
--  2. Cửa đã cố ý đóng với anon giữ đóng: hàm mà ACL cấp authenticated nhưng KHÔNG cấp anon thì không cấp anon. Đo prod:
--     đúng get_change_breakdown_v2 và get_deposit_breakdown_v2 (20260621000001 đã REVOKE anon; anon gọi được chỉ nhờ PUBLIC).
--     Nếu một đường pg_depend đòi anon chạy hàm đã đóng thì dừng (cần người quyết định), không tự mở lại.
--  3. Hàm trigger và event trigger: không cấp cho ai. PostgreSQL không kiểm EXECUTE lúc bắn trigger hay event trigger, chỉ
--     lúc CREATE TRIGGER (do chủ hàm chạy migration). Test PG cục bộ chứng minh chúng vẫn chạy.
--  4. Không cấp (đã chứng minh không cần): hermes_store_learning và hermes_learning_ingest chỉ gọi
--     app_private.hermes_store_learning_ingest_v1; hermes_store_host và hermes_store_executor chỉ gọi 22 hàm
--     hermes_store_* / hermes_zalo_provisioning_* cấp riêng, đều DEFINER (store-transport chỉ gửi câu kiểm vai trên
--     pg_catalog và đúng các hàm đó); authenticator, supabase_storage_admin gọi hàm ứng dụng sau khi SET ROLE sang vai API;
--     supabase_auth_admin không có auth hook, trigger trên auth.users là DEFINER; pgbouncer chỉ dùng pgbouncer.get_auth;
--     cli_login_postgres làm việc sau SET ROLE postgres; supabase_etl_admin, supabase_replication_admin,
--     supabase_functions_admin không gọi hàm ứng dụng; dashboard_user, supabase_privileged_role, supabase_realtime_admin,
--     ie_canonical_writer là NOLOGIN và không đường chạy nào biến chúng thành current_user. pg_cron: 11 job đều chạy
--     bằng postgres, là chủ mọi hàm này. ie_detail_reader thuộc authenticated nên thừa hưởng quyền của authenticated.
--  5. ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC: hàm postgres tạo sau này không
--     tự cấp PUBLIC. Mặc định Supabase theo schema (public, storage: anon/authenticated/service_role) giữ nguyên. Hàm mới
--     ở app_private chỉ chủ gọi được, nên hàm app_private dùng trong policy, view hay default phải GRANT EXECUTE tường
--     minh cho vai gọi — gate check-definer-acl đỏ nếu thiếu. PostgreSQL không cho thu PUBLIC theo từng schema, nên lệnh
--     này áp cho mọi schema mà postgres tạo hàm (ngoài public/app_private, postgres chỉ sở hữu hàm extension).
--  6. Tự kiểm sau áp, đỏ là cuộn cả file: còn hàm cấp PUBLIC; vai thật sự dùng thiếu quyền; anon mở lại cửa đã đóng; vai
--     bị chặn gọi được hàm DEFINER ngoài hàm riêng của nó; mặc định hàm của postgres còn cấp PUBLIC.
-- Idempotent: lượt hai không còn hàm cấp PUBLIC nên không GRANT/REVOKE gì, tự kiểm vẫn chạy. Không đổi thân hàm, không DROP.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $thu$
DECLARE
  f record;
  v_role text;
  v_can text[];
  v_giu_vai text[] := '{}';
  v_giu_ham oid[] := '{}';
  v_dong_anon oid[] := '{}';
  v_thu integer := 0;
  v_cap integer := 0;
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
      -- Vai tự chạy hàm qua đối tượng phụ thuộc (pg_depend), không gọi tên nó.
      SELECT COALESCE(array_agg(r.rolname::text ORDER BY r.rolname),'{}') INTO v_can
      FROM pg_catalog.pg_roles r
      WHERE r.rolname IN ('anon','authenticated','service_role','supabase_read_only_user')
        AND (r.rolname<>'supabase_read_only_user' OR NOT f.prosecdef)
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.refclassid='pg_catalog.pg_proc'::regclass AND d.refobjid=f.oid AND (
            (d.classid='pg_catalog.pg_policy'::regclass AND NOT r.rolbypassrls AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy x
              WHERE x.oid=d.objid AND (0=ANY(x.polroles) OR EXISTS (SELECT 1 FROM unnest(x.polroles) g(oid)
                WHERE g.oid<>0 AND pg_catalog.pg_has_role(r.oid,g.oid,'USAGE')))
                AND pg_catalog.has_table_privilege(r.oid,x.polrelid,'SELECT,INSERT,UPDATE,DELETE')))
            OR (d.classid='pg_catalog.pg_rewrite'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite x
              JOIN pg_catalog.pg_class c ON c.oid=x.ev_class WHERE x.oid=d.objid
                AND lower(COALESCE((SELECT o.option_value FROM pg_catalog.pg_options_to_table(c.reloptions) o
                  WHERE o.option_name='security_invoker'),'false')) IN ('true','on','1')
                AND pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT')))
            OR (d.classid='pg_catalog.pg_attrdef'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_attrdef x
              WHERE x.oid=d.objid AND pg_catalog.has_table_privilege(r.oid,x.adrelid,'INSERT,UPDATE')))
            OR (d.classid='pg_catalog.pg_constraint'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint x
              WHERE x.oid=d.objid AND (x.conrelid=0 OR pg_catalog.has_table_privilege(r.oid,x.conrelid,'INSERT,UPDATE'))))
            OR (d.classid='pg_catalog.pg_class'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_index x
              WHERE x.indexrelid=d.objid AND pg_catalog.has_table_privilege(r.oid,x.indrelid,'INSERT,UPDATE')))
            OR (d.classid='pg_catalog.pg_trigger'::regclass AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger x
              WHERE x.oid=d.objid AND pg_catalog.has_table_privilege(r.oid,x.tgrelid,'INSERT,UPDATE,DELETE')))));
      -- Cửa đã cố ý đóng với anon (cấp authenticated, không cấp anon) giữ đóng; đường phụ thuộc đòi mở thì dừng.
      IF EXISTS (SELECT 1 FROM pg_catalog.aclexplode(f.acl) a WHERE a.grantee='authenticated'::regrole AND a.privilege_type='EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(f.acl) a WHERE a.grantee='anon'::regrole AND a.privilege_type='EXECUTE') THEN
        IF 'anon'=ANY(v_can) THEN RAISE EXCEPTION 'public_execute_anon_da_dong_nhung_can: %',f.sig; END IF;
        v_dong_anon:=v_dong_anon||f.oid;
      END IF;
      FOREACH v_role IN ARRAY v_can LOOP
        v_giu_vai:=v_giu_vai||v_role; v_giu_ham:=v_giu_ham||f.oid;
        -- Đã có quyền không qua PUBLIC (cấp thẳng hoặc thừa hưởng) thì để nguyên ACL.
        CONTINUE WHEN EXISTS (SELECT 1 FROM pg_catalog.aclexplode(f.acl) a
          WHERE a.grantee<>0 AND a.privilege_type='EXECUTE' AND pg_catalog.pg_has_role(v_role,a.grantee,'USAGE'));
        EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO %I',f.sig,v_role);
        v_cap:=v_cap+1;
      END LOOP;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC',f.sig);
    v_thu:=v_thu+1;
  END LOOP;
  IF EXISTS (SELECT 1 FROM unnest(v_giu_vai,v_giu_ham) k(rolname,fn)
      WHERE NOT pg_catalog.has_function_privilege(k.rolname,k.fn,'EXECUTE')) THEN
    RAISE EXCEPTION 'public_execute_vai_dang_dung_mat_quyen';
  END IF;
  IF pg_catalog.to_regrole('anon') IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(v_dong_anon) k(fn)
      WHERE pg_catalog.has_function_privilege('anon',k.fn,'EXECUTE')) THEN
    RAISE EXCEPTION 'public_execute_mo_lai_anon_da_dong';
  END IF;
  RAISE NOTICE 'public_execute: thu PUBLIC trên % hàm, cấp % dòng cho vai thật sự dùng, giữ đóng anon trên % hàm',
    v_thu,v_cap,cardinality(v_dong_anon);
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
