-- Dọn hàm máy chủ mồ côi (việc sau plan «sửa khoá vĩnh viễn sau rớt mạng»; chủ dự án duyệt 28/11/2026).
--
-- VÌ SAO
--   Đợt 9 (#512), đợt 10c (#519) và đợt 11 (#520) đã gỡ mọi nơi gọi ở web của một nhóm RPC. Các hàm vẫn nằm trên máy
--   chủ và vai đăng nhập vẫn gọi thẳng được qua API (một hàm cho cả vai chưa đăng nhập). Tệp này XOÁ hàm không còn ai gọi
--   ở bất kỳ đâu, và THU QUYỀN gọi thẳng của hàm chỉ còn được hàm khác trên máy chủ gọi.
--
-- ĐO TRƯỚC KHI VIẾT (production, chỉ đọc, 28/11/2026; bảng đầy đủ ở mô tả PR)
--   (a) mã nguồn origin/main, (b) PR đang mở, (c) catalog và dữ liệu (thân hàm mọi schema, trigger, policy, view, matview,
--   mặc định cột, ràng buộc, pg_depend, cron.job, sổ hành động trợ lý, mọi cột tên chứa rpc/function/proc/handler/tool),
--   (d) log API khoảng 90 ngày kèm phép đối chứng, (e) bản web cũ còn mở trong máy người dùng.
--
-- NỘI DUNG — chỉ hai loại lệnh: DROP FUNCTION và REVOKE. Không đụng dữ liệu, không đổi bảng, không CREATE OR REPLACE thân nào.
--   XOÁ (không còn ai gọi):
--     bulk_create_meter_readings(jsonb), bulk_create_meter_readings_v1(jsonb), bulk_approve_meter_readings_v1(uuid[]),
--     confirm_reconciliation(uuid), cancel_reconciliation(uuid).
--   THU QUYỀN gọi thẳng (REVOKE ALL … FROM PUBLIC, anon, authenticated; giữ service_role và chủ hàm):
--     approve_invoice_v1(uuid)          — còn được copilot_execute_invoice_duyet_v1 (SECURITY DEFINER) gọi bên trong;
--     approve_meter_reading_v1(uuid)    — còn được copilot_execute_meter_reading_duyet_v1 (SECURITY DEFINER) gọi bên trong;
--     verify_income_expense(uuid, text) — còn được verify_income_expense_v1 (SECURITY DEFINER) gọi cho phiếu đường cũ,
--                                         ngay dưới khoá dòng của nó.
--   GIỮ NGUYÊN (không lệnh nào, chỉ hậu kiểm md5 + ACL): decide_financial_request_v2, unapprove_invoice_v1,
--     unapprove_meter_reading_v1, get_approval_request_detail_compat_v2, withdraw_financial_request_v1,
--     verify_income_expense_v1.
--
-- HÀNG RÀO (hai khối DO chạy TRƯỚC mọi lệnh; lỗi thì dừng cả tệp)
--   $requires$ — thân đang chạy phải đúng thân đã rà (md5 prosrc, bỏ CR) cho cả 14 hàm; mỗi tên bị đụng đúng một bản ở
--     public; hàm sắp xoá đã vắng (lượt hai) thì bỏ qua; hàm sắp thu quyền phải còn và service_role còn gọi được; hàm giữ
--     nguyên không được HẸP quyền hơn production (so «tập production ⊆ tập đang có», không so tuyệt đối — bản dựng lại
--     của Restore Drill mang quyền rộng hơn production); chụp thân + ACL hàm giữ nguyên để hậu kiểm so lại.
--   $hang_rao$ — hàm sắp XOÁ: không thân hàm nào khác (mọi schema người dùng), trigger, policy, view, matview, mặc định
--     cột, ràng buộc, phụ thuộc pg_depend, việc cron hay dòng sổ hành động trợ lý còn nhắc tên. Hàm sắp THU QUYỀN: mọi
--     thân hàm nhắc tên đều SECURITY DEFINER, và không trigger / policy / view / mặc định cột / ràng buộc / phụ thuộc /
--     việc cron / dòng sổ trợ lý nào nhắc tên (những nơi đó chạy bằng quyền của người gọi hoặc được gọi thẳng).
--   Mục đích: phiên khác vừa thêm người gọi giữa lúc đo và lúc áp thì tệp tự dừng.
--
-- LÙI: tệp khôi phục sinh từ production trước khi áp (pg_get_functiondef + đúng ACL hiện tại của từng hàm bị xoá; GRANT
--   trả quyền cho từng hàm bị thu) — đường dẫn và tệp migration gốc của từng thân ghi ở mô tả PR. Lane cũng tự sao lưu.
--   Phần không lùi được: không có.
-- AN TOÀN CHẠY LẠI: DROP … IF EXISTS; REVOKE lặp lại không đổi gì; $requires$ bỏ qua hàm sắp xoá đã vắng.

DO $requires$
DECLARE
  r record;
  v_md5 text;
  v_khac text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.bulk_create_meter_readings(jsonb)',      'bulk_create_meter_readings',     'cc4f1f5d096eb596ae33d4ac38f49718', 'xoa'),
      ('public.bulk_create_meter_readings_v1(jsonb)',   'bulk_create_meter_readings_v1',  '5fc23a265189cc580b49726791704ac6', 'xoa'),
      ('public.bulk_approve_meter_readings_v1(uuid[])', 'bulk_approve_meter_readings_v1', '4fb98d3e892b30cc92388af95910e267', 'xoa'),
      ('public.confirm_reconciliation(uuid)',           'confirm_reconciliation',         'ba98ef471687b3cc3668c03a04987a6c', 'xoa'),
      ('public.cancel_reconciliation(uuid)',            'cancel_reconciliation',          '3c55458446a5c35b34ff99381a838de8', 'xoa'),
      ('public.approve_invoice_v1(uuid)',               'approve_invoice_v1',             '3ead9c52ee446478d6e3f90ecb7f0eab', 'thu_quyen'),
      ('public.approve_meter_reading_v1(uuid)',         'approve_meter_reading_v1',       'ecb7bf708540193568e922a9c809f907', 'thu_quyen'),
      ('public.verify_income_expense(uuid,text)',       'verify_income_expense',          '39fd56487277e0729900b861152d2c67', 'thu_quyen')
    ) AS v(fn, ten, base_md5, muc) LOOP
    -- Đúng một bản mang tên này ở public, và đó là chữ ký đã rà (bản trùng tên lạ thì DROP / REVOKE sẽ trượt sang bản khác).
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_khac
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.ten
       AND p.oid IS DISTINCT FROM to_regprocedure(r.fn);
    IF v_khac IS NOT NULL THEN
      RAISE EXCEPTION 'don_ham_mo_coi: có bản trùng tên chưa rà của %: % — DỪNG', r.ten, v_khac USING ERRCODE = '55000';
    END IF;
    IF to_regprocedure(r.fn) IS NULL THEN
      IF r.muc = 'xoa' THEN
        CONTINUE; -- lượt hai: đã xoá
      END IF;
      RAISE EXCEPTION 'don_ham_mo_coi: thiếu % — hàm sắp thu quyền phải còn (hàm khác trên máy chủ đang gọi nó)', r.fn
        USING ERRCODE = '55000';
    END IF;
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.base_md5 THEN
      RAISE EXCEPTION 'don_ham_mo_coi: % KHÁC thân đã rà (md5 %) — DỪNG, đo lại người gọi', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
    -- Hàm sắp thu quyền: service_role phải đang gọi được (tệp giữ quyền đó; hậu kiểm đòi nó còn).
    IF r.muc = 'thu_quyen' AND NOT has_function_privilege('service_role', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'don_ham_mo_coi: service_role đang không gọi được % — khác lúc đo, DỪNG', r.fn USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Sáu hàm GIỮ NGUYÊN (tệp không đụng): thân đúng thân đã rà; quyền KHÔNG HẸP hơn production (mỗi vai production được
  -- EXECUTE thì nay vẫn được). Không so quyền tuyệt đối: bản dựng lại của Restore Drill (baseline chụp --no-acl +
  -- platform-shim cấp EXECUTE mọi hàm public) mang quyền RỘNG hơn production, mà tệp này không kéo ACL của các hàm đó.
  -- Chụp lại thân + ACL ngay trước các lệnh để hậu kiểm chứng minh tệp này không làm chúng đổi.
  FOR r IN SELECT * FROM (VALUES
      ('public.decide_financial_request_v2(uuid,text,text)', 'de18b25abe4d72a7de5eb9ff6b79e461', ARRAY['authenticated', 'service_role']),
      ('public.unapprove_invoice_v1(uuid)',                  'a7fbfae5812272a8ad2b0236126f46f5', ARRAY['authenticated', 'service_role']),
      ('public.unapprove_meter_reading_v1(uuid)',            'afa86393045e9b270b3c226b99b43d58', ARRAY['authenticated', 'service_role']),
      ('public.get_approval_request_detail_compat_v2(uuid)', '733a1e80b9d35dfd60f5e773e4654cfa', ARRAY['authenticated']),
      ('public.withdraw_financial_request_v1(uuid,text)',    'e017dc822074b30cb800645d8dadeb48', ARRAY['authenticated', 'service_role']),
      ('public.verify_income_expense_v1(uuid,text,boolean)', '5c6cc367eb9324083277f1b72061dbef', ARRAY['authenticated', 'service_role'])
    ) AS v(fn, base_md5, vai) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.base_md5 THEN
      RAISE EXCEPTION 'don_ham_mo_coi: % (giữ nguyên) KHÁC thân đã rà (md5 %) — DỪNG', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
    SELECT string_agg(x, ', ') INTO v_khac FROM unnest(r.vai) AS x WHERE NOT has_function_privilege(x, r.fn, 'EXECUTE');
    IF v_khac IS NOT NULL THEN
      RAISE EXCEPTION 'don_ham_mo_coi: % (giữ nguyên) hẹp quyền hơn production — % không gọi được — DỪNG', r.fn, v_khac
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  PERFORM set_config('don_ham_mo_coi.giu_nguyen_truoc', (
    SELECT jsonb_object_agg(x.fn, jsonb_build_object('md5', md5(replace(p.prosrc, chr(13), '')), 'acl', coalesce(p.proacl::text, 'NULL')))::text
      FROM unnest(ARRAY['public.decide_financial_request_v2(uuid,text,text)', 'public.unapprove_invoice_v1(uuid)',
                        'public.unapprove_meter_reading_v1(uuid)', 'public.get_approval_request_detail_compat_v2(uuid)',
                        'public.withdraw_financial_request_v1(uuid,text)', 'public.verify_income_expense_v1(uuid,text,boolean)']) AS x(fn)
      JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(x.fn)), false);
END
$requires$;

DO $hang_rao$
DECLARE
  v_xoa text[] := ARRAY['bulk_create_meter_readings', 'bulk_create_meter_readings_v1', 'bulk_approve_meter_readings_v1',
                        'confirm_reconciliation', 'cancel_reconciliation'];
  v_thu text[] := ARRAY['approve_invoice_v1', 'approve_meter_reading_v1', 'verify_income_expense'];
  v_ten text;
  v_re text;
  v_noi text;
BEGIN
  FOREACH v_ten IN ARRAY v_xoa || v_thu LOOP
    v_re := '\m' || v_ten || '\M';

    -- Thân hàm khác (mọi schema người dùng). Hàm sắp xoá: không ai được nhắc (trừ chính nhóm sắp xoá, không hàm nào
    -- trong nhóm nhắc hàm khác trong nhóm). Hàm sắp thu quyền: chỉ hàm SECURITY DEFINER được nhắc.
    SELECT string_agg(n.nspname || '.' || p.proname || CASE WHEN p.prosecdef THEN '' ELSE ' (INVOKER)' END, ', ')
      INTO v_noi
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND NOT (n.nspname = 'public' AND p.proname = v_ten)
       AND p.prosrc ~ v_re
       AND CASE WHEN v_ten = ANY (v_xoa)
                THEN NOT (n.nspname = 'public' AND p.proname = ANY (v_xoa))
                ELSE NOT p.prosecdef END;
    IF v_noi IS NOT NULL THEN
      RAISE EXCEPTION 'don_ham_mo_coi: % còn được nhắc trong thân hàm: % — DỪNG, đo lại người gọi', v_ten, v_noi
        USING ERRCODE = '55000';
    END IF;

    -- Trigger, policy, view, matview, mặc định cột, ràng buộc, phụ thuộc pg_depend.
    SELECT string_agg(x, ', ') INTO v_noi FROM (
      SELECT 'trigger ' || t.tgrelid::regclass::text || '.' || t.tgname AS x
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE NOT t.tgisinternal AND ((n.nspname = 'public' AND p.proname = v_ten) OR pg_catalog.pg_get_triggerdef(t.oid) ~ v_re)
      UNION ALL
      SELECT 'policy ' || po.schemaname || '.' || po.tablename || '.' || po.policyname
        FROM pg_catalog.pg_policies po WHERE coalesce(po.qual, '') ~ v_re OR coalesce(po.with_check, '') ~ v_re
      UNION ALL
      SELECT 'view ' || vw.schemaname || '.' || vw.viewname FROM pg_catalog.pg_views vw
       WHERE vw.schemaname NOT IN ('pg_catalog', 'information_schema') AND vw.definition ~ v_re
      UNION ALL
      SELECT 'matview ' || mv.schemaname || '.' || mv.matviewname FROM pg_catalog.pg_matviews mv WHERE mv.definition ~ v_re
      UNION ALL
      SELECT 'mặc định cột ' || ad.adrelid::regclass::text FROM pg_catalog.pg_attrdef ad
       WHERE pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) ~ v_re
      UNION ALL
      SELECT 'ràng buộc ' || co.conrelid::regclass::text || '.' || co.conname FROM pg_catalog.pg_constraint co
       WHERE co.contype IN ('c', 'x') AND pg_catalog.pg_get_constraintdef(co.oid) ~ v_re
      UNION ALL
      SELECT 'pg_depend ' || d.classid::regclass::text || ' #' || d.objid::text FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_proc p ON p.oid = d.refobjid JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE d.refclassid = 'pg_catalog.pg_proc'::regclass AND n.nspname = 'public' AND p.proname = v_ten
    ) q;
    IF v_noi IS NOT NULL THEN
      RAISE EXCEPTION 'don_ham_mo_coi: % còn được dùng ở: % — DỪNG', v_ten, v_noi USING ERRCODE = '55000';
    END IF;

    -- Sổ hành động của trợ lý (người gọi nằm trong DỮ LIỆU): không dòng nào được khai hàm này ở bất kỳ cột nào.
    IF to_regclass('app_private.copilot_action_registry') IS NOT NULL THEN
      EXECUTE 'SELECT string_agg(r.action_id, '', '') FROM app_private.copilot_action_registry r WHERE row_to_json(r)::text ~ $1'
        INTO v_noi USING v_re;
      IF v_noi IS NOT NULL THEN
        RAISE EXCEPTION 'don_ham_mo_coi: sổ hành động trợ lý còn khai % ở: % — DỪNG', v_ten, v_noi USING ERRCODE = '55000';
      END IF;
    END IF;

    -- Việc cron (chạy bằng quyền chủ việc nhưng sẽ hỏng nếu hàm bị xoá; với hàm thu quyền thì là người gọi chưa rà).
    IF to_regclass('cron.job') IS NOT NULL THEN
      EXECUTE 'SELECT string_agg(j.jobname, '', '') FROM cron.job j WHERE j.command ~ $1' INTO v_noi USING v_re;
      IF v_noi IS NOT NULL THEN
        RAISE EXCEPTION 'don_ham_mo_coi: việc cron còn gọi %: % — DỪNG', v_ten, v_noi USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;
END
$hang_rao$;

-- ── XOÁ ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.bulk_create_meter_readings(jsonb);
DROP FUNCTION IF EXISTS public.bulk_create_meter_readings_v1(jsonb);
DROP FUNCTION IF EXISTS public.bulk_approve_meter_readings_v1(uuid[]);
DROP FUNCTION IF EXISTS public.confirm_reconciliation(uuid);
DROP FUNCTION IF EXISTS public.cancel_reconciliation(uuid);

-- ── THU QUYỀN gọi thẳng ──────────────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.approve_invoice_v1(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_meter_reading_v1(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_income_expense(uuid, text) FROM PUBLIC, anon, authenticated;

-- ── Hậu kiểm ─────────────────────────────────────────────────────────────────────────────────────────────────────────
DO $hau_kiem$
DECLARE
  r record;
  v_md5 text;
  v_truoc jsonb;
  v_con text;
BEGIN
  -- Năm hàm bị xoá: không còn bản nào mang tên đó ở public.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_con
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('bulk_create_meter_readings', 'bulk_create_meter_readings_v1', 'bulk_approve_meter_readings_v1',
                       'confirm_reconciliation', 'cancel_reconciliation');
  IF v_con IS NOT NULL THEN
    RAISE EXCEPTION 'don_ham_mo_coi: còn hàm lẽ ra đã xoá: %', v_con USING ERRCODE = '55000';
  END IF;

  -- Ba hàm bị thu quyền: thân không đổi, vẫn SECURITY DEFINER; vai chưa đăng nhập / đăng nhập không gọi được, không còn
  -- dòng PUBLIC (proacl NULL cũng là PUBLIC); service_role và chủ hàm vẫn gọi được; chủ của MỌI hàm khác nhắc tên nó vẫn
  -- gọi được nó (người gọi bên trong máy chủ chạy bằng quyền chủ hàm của họ — trên Supabase chủ là postgres, KHÔNG phải
  -- superuser, nên điều này phải nhờ dòng ACL của chủ hàm, không nhờ quyền vượt).
  FOR r IN SELECT * FROM (VALUES
      ('public.approve_invoice_v1(uuid)',         'approve_invoice_v1',       '3ead9c52ee446478d6e3f90ecb7f0eab'),
      ('public.approve_meter_reading_v1(uuid)',   'approve_meter_reading_v1', 'ecb7bf708540193568e922a9c809f907'),
      ('public.verify_income_expense(uuid,text)', 'verify_income_expense',    '39fd56487277e0729900b861152d2c67')
    ) AS v(fn, ten, base_md5) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.base_md5 THEN
      RAISE EXCEPTION 'don_ham_mo_coi: % sau áp khác thân đã rà (md5 %)', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
    IF has_function_privilege('authenticated', r.fn, 'EXECUTE')
       OR has_function_privilege('anon', r.fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', r.fn, 'EXECUTE')
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                       WHERE p.oid = to_regprocedure(r.fn) AND p.proacl IS NOT NULL AND p.prosecdef
                         AND has_function_privilege(p.proowner, p.oid, 'EXECUTE'))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) a
                   WHERE p.oid = to_regprocedure(r.fn) AND a.grantee = 0) THEN
      RAISE EXCEPTION 'don_ham_mo_coi: % sai quyền sau thu (phải: không PUBLIC/anon/authenticated, còn service_role và chủ hàm, SECURITY DEFINER)', r.fn
        USING ERRCODE = '55000';
    END IF;
    SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO v_con
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.oid <> to_regprocedure(r.fn)
       AND p.prosrc ~ ('\m' || r.ten || '\M')
       AND NOT has_function_privilege(p.proowner, to_regprocedure(r.fn), 'EXECUTE');
    IF v_con IS NOT NULL THEN
      RAISE EXCEPTION 'don_ham_mo_coi: chủ của % không còn gọi được % — DỪNG', v_con, r.fn USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Sáu hàm GIỮ NGUYÊN: thân + ACL y như ảnh chụp ngay trước các lệnh ($requires$) — tệp này không làm chúng đổi.
  v_truoc := nullif(current_setting('don_ham_mo_coi.giu_nguyen_truoc', true), '')::jsonb;
  SELECT string_agg(x.fn, ', ') INTO v_con
    FROM unnest(ARRAY['public.decide_financial_request_v2(uuid,text,text)', 'public.unapprove_invoice_v1(uuid)',
                      'public.unapprove_meter_reading_v1(uuid)', 'public.get_approval_request_detail_compat_v2(uuid)',
                      'public.withdraw_financial_request_v1(uuid,text)', 'public.verify_income_expense_v1(uuid,text,boolean)']) AS x(fn)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(x.fn)
   WHERE p.oid IS NULL OR v_truoc IS NULL
      OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM v_truoc -> x.fn ->> 'md5'
      OR coalesce(p.proacl::text, 'NULL') IS DISTINCT FROM v_truoc -> x.fn ->> 'acl';
  IF v_con IS NOT NULL THEN
    RAISE EXCEPTION 'don_ham_mo_coi: hàm giữ nguyên bị đổi thân / ACL trong lúc áp: %', v_con USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('don_ham_mo_coi.giu_nguyen_truoc', '', false);
END
$hau_kiem$;
