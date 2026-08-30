-- =============================================================================
-- DIỄN TẬP xoá hai tổ chức Test (cccc) / Demo (dddd) — kết thúc bằng ROLLBACK
--
-- Chạy: node scripts/query-sql.mjs scripts/org-split-prepared/03-dien-tap-xoa-hai-org.sql
--
-- File này KHÔNG ghi gì. Nó xoá thật bên trong một transaction rồi ROLLBACK, để
-- trả lời ba câu trước khi ai đó bấm nút thật:
--   1. Có xoá hết được không, hay có bảng nào chặn?
--   2. Xoá xong có để lại tham chiếu treo ở đâu không?
--   3. Mất bao lâu?
--
-- ------------------------------- VÌ SAO replica -----------------------------
-- ~60 bảng có guard bất biến (append-only / immutable / retention / freeze tài
-- chính) chặn cả DELETE lẫn UPDATE, và chúng gắn theo BẢNG chứ không theo tổ
-- chức. Kế hoạch bản đầu đề xuất tắt trigger rồi bật lại, kèm một rủi ro được
-- ghi là "không loại bỏ được": trong cửa sổ vài giây đó, tiến trình KHÁC ghi vào
-- database cũng sẽ ghi được thứ bình thường bị chặn.
--
-- Rủi ro đó BIẾN MẤT nếu dùng SET LOCAL session_replication_role = 'replica'
-- thay vì ALTER TABLE ... DISABLE TRIGGER:
--   • ALTER TABLE đổi CATALOG — mọi session đều thấy, đó là chỗ sinh ra rủi ro.
--   • session_replication_role là GUC theo session, và SET LOCAL còn thu hẹp
--     xuống theo TRANSACTION. Session khác không hề bị ảnh hưởng.
-- Đã kiểm trên chính production: role `postgres` (rolsuper = false) đặt được
-- GUC này — Supabase cho phép qua supautils, đúng như cách nó cho tạo event
-- trigger ở GĐ5.
--
-- ĐÁNH ĐỔI phải biết: 'replica' cũng tắt luôn trigger CƯỠNG CHẾ KHOÁ NGOẠI và
-- các hành vi ON DELETE CASCADE / SET NULL (chúng cũng là trigger). Nghĩa là:
--   • Thứ tự xoá không còn quan trọng — không có gì để vi phạm.
--   • Nhưng CASCADE sẽ KHÔNG tự chạy, nên bảng con phải tự xoá.
--   • Và toàn vẹn phải TỰ KIỂM sau đó. Đó là bước 4 dưới đây, quét TOÀN BỘ khoá
--     ngoại của schema public chứ không chỉ những bảng có organization_id — vì
--     đúng chỗ nguy hiểm nhất là bảng KHÔNG có cột đó (12 bảng thuộc GĐ7).
-- =============================================================================

BEGIN;
SET LOCAL statement_timeout = '900s';
-- Lần diễn tập đầu chết vì DEADLOCK với tiến trình OpenClaw đang ghi
-- openclaw_runtime_cells. Transaction này đụng 173 bảng nên chắc chắn giao cắt
-- với runtime đang sống. lock_timeout biến "treo vô hạn / deadlock" thành một
-- lỗi nhanh và đọc được, để chạy lại lúc runtime rảnh thay vì ngồi đoán.
SET LOCAL lock_timeout = '15s';

-- lock_timeout KHÔNG cứu được deadlock — bộ dò deadlock bắn trước nó. Hai lần
-- diễn tập đầu đều chết đúng một chỗ: openclaw_runtime_cells, vì runtime
-- OpenClaw đang sống và ôm khoá dòng ở đó trong khi transaction này ôm khoá
-- chỗ khác mà nó cần.
--
-- Cách chữa là ĐOẠT khoá bảng nóng NGAY ĐẦU, trước khi ôm bất cứ khoá nào
-- khác: đối phương sẽ chặn ngay từ lệnh đầu tiên của nó thay vì chặn ở giữa
-- chừng, nên không có vòng nào để tạo. Deadlock cần hai bên giành khoá theo
-- thứ tự NGƯỢC nhau; ép thứ tự ở đây là bỏ điều kiện đó đi.
-- Thứ tự dưới đây KHÔNG tuỳ tiện, nó là kết quả của ba lần diễn tập chết:
--   lần 1+2: chết ở openclaw_runtime_cells (runtime OpenClaw đang ghi)
--   lần 3  : đoạt được cell rồi, chết ở tận DELETE FROM organizations — vòng ba
--            bên, vì organizations là thứ MỌI truy vấn RLS đều đọc
--            (my_org_ids / is_super_admin / sandbox_org_ids).
-- Nên phải đoạt organizations TRƯỚC TIÊN. Từ giây đó mọi giao dịch mới bị chặn
-- sạch ở lệnh đầu của nó, không ai kịp ôm nửa bộ khoá.
--
-- HỆ QUẢ PHẢI NÓI RÕ: đây là một cú ĐỨNG HÌNH toàn ứng dụng khoảng 15–20 giây
-- (xoá ~9s + tự kiểm ~7s), không phải một "cửa sổ rủi ro". Khác nhau ở chỗ:
-- đứng hình thì người dùng thấy chậm rồi thôi; cửa sổ rủi ro thì có thứ lọt qua
-- mà không ai biết. Ở đây không có gì lọt qua được.
-- Bảng `public.openclaw_runtime_cells` từng được khoá cùng ở đây; nó bị DROP
-- ngày 30/08/2026 (migration 20260830085316 xoá toàn bộ OpenClaw), nên dòng
-- LOCK cũ sẽ làm cả transaction diễn tập chết ở lệnh thứ hai.
LOCK TABLE public.organizations           IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE dt_log(buoc text, chi_tiet text, so bigint, ms numeric);
CREATE TEMP TABLE dt_xoa(bang text, so_dong bigint);
CREATE TEMP TABLE dt_treo(bang_con text, cot text, bang_cha text, so_mo_coi bigint);

-- ---------------------------------------------------------------------------
-- BƯỚC 1 — điều kiện tiên quyết: không dòng nào của công ty thật trỏ sang hai
-- tổ chức sắp xoá. Đo LẠI ngay tại đây, không tin lần đo cũ: chính GĐ6 từng
-- sinh ra một đường vi phạm SAU khi phép đo trước đó trả về sạch.
-- ---------------------------------------------------------------------------
DO $b1$
DECLARE r record; v bigint; v_tong bigint := 0; t0 timestamptz := clock_timestamp();
BEGIN
  FOR r IN
    SELECT con.relname AS bc, acon.attname AS cc, cha.relname AS bp, acha.attname AS cp
      FROM pg_constraint k
      JOIN pg_class con ON con.oid = k.conrelid
      JOIN pg_class cha ON cha.oid = k.confrelid
      JOIN pg_attribute acon ON acon.attrelid = k.conrelid  AND acon.attnum = k.conkey[1]
      JOIN pg_attribute acha ON acha.attrelid = k.confrelid AND acha.attnum = k.confkey[1]
     WHERE k.contype = 'f' AND array_length(k.conkey,1) = 1
       AND con.relnamespace = 'public'::regnamespace
       AND cha.relnamespace = 'public'::regnamespace
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid=con.oid
                    AND x.attname='organization_id' AND x.attnum>0 AND NOT x.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute y WHERE y.attrelid=cha.oid
                    AND y.attname='organization_id' AND y.attnum>0 AND NOT y.attisdropped)
  LOOP
    BEGIN
      EXECUTE format(
        'SELECT count(*) FROM public.%I c JOIN public.%I p ON p.%I = c.%I '
        'WHERE c.organization_id NOT IN (%L,%L) AND p.organization_id IN (%L,%L)',
        r.bc, r.bp, r.cp, r.cc,
        'cccc0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001',
        'cccc0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001')
      INTO v;
      v_tong := v_tong + coalesce(v,0);
      IF v > 0 THEN
        INSERT INTO dt_treo VALUES (r.bc, r.cc || ' (TIÊN QUYẾT)', r.bp, v);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  INSERT INTO dt_log VALUES ('1-tien-quyet',
    CASE WHEN v_tong = 0 THEN 'TÁCH RỜI — không tổ chức nào khác trỏ sang cccc/dddd'
         ELSE 'CÓ THAM CHIẾU CHÉO — xem bảng dt_treo' END,
    v_tong, round(extract(epoch FROM clock_timestamp()-t0)::numeric*1000,1));

  IF v_tong > 0 THEN
    RAISE EXCEPTION 'Còn % đường tham chiếu từ tổ chức khác sang cccc/dddd — xoá lúc này để lại tham chiếu treo. DỪNG.', v_tong;
  END IF;
END $b1$;

-- ---------------------------------------------------------------------------
-- BƯỚC 2 — hạ guard THEO TRANSACTION, không đụng catalog.
-- ---------------------------------------------------------------------------
SET LOCAL session_replication_role = 'replica';

-- BƯỚC 2b — ba trigger KHÔNG chịu chế độ replica.
--
-- Đo được: trong toàn schema public chỉ có 5 trigger đặt tgenabled='A' (ALWAYS),
-- và chỉ 3 trong số đó thực sự chặn DELETE:
--   approval_rule_sets.a00_rule_set_immutable        (2 dòng của hai org)
--   approval_rules.a00_rules_immutable               (6 dòng)
--   income_expense_audit_log.a00_audit_log_guard     (407 dòng)
-- Hai cái còn lại vô can: a00_audit_log_no_truncate chỉ chặn TRUNCATE, còn
-- a00_guard_tenant_role_permission_domain chỉ chặn INSERT/UPDATE OF
-- permission_key. Không cái nào có cửa thoát bằng GUC — phải tắt đích danh.
--
-- Đây là chỗ DUY NHẤT đụng vào catalog, và phạm vi là 3 bảng chứ không phải
-- ~60. Quan trọng hơn: ALTER TABLE ... DISABLE TRIGGER giữ khoá SHARE ROW
-- EXCLUSIVE trên bảng, mà khoá đó xung khắc với ROW EXCLUSIVE của mọi
-- INSERT/UPDATE/DELETE. Nên trong lúc transaction này chạy, session khác muốn
-- ghi vào 3 bảng đó sẽ ĐỢI chứ không lọt qua guard đang tắt. Cửa sổ rủi ro mà
-- kế hoạch bản đầu ghi là "không loại bỏ được" thực ra không tồn tại ở đây.
ALTER TABLE public.approval_rule_sets       DISABLE TRIGGER a00_rule_set_immutable;
ALTER TABLE public.approval_rules           DISABLE TRIGGER a00_rules_immutable;
ALTER TABLE public.income_expense_audit_log DISABLE TRIGGER a00_audit_log_guard;

-- ---------------------------------------------------------------------------
-- BƯỚC 3a — bảng KHÔNG có cột organization_id nhưng treo vào bảng có.
--
-- Prod có 12 bảng như vậy. Vòng xoá ở bước 3 dò theo cột organization_id nên
-- KHÔNG chạm tới chúng — mà cha của chúng thì bị xoá, và ở chế độ replica
-- ON DELETE CASCADE cũng không chạy. Kết quả: mồ côi âm thầm. Lần diễn tập đầu
-- lộ đúng 12 dòng mồ côi ở room_price_history (4 dòng × 3 đường FK).
--
-- Phải làm TRƯỚC bước 3, lúc cha còn sống, thì mới đọc được org của cha.
-- Luật: chỉ xoá dòng mà MỌI đường FK sang bảng có org đều trỏ về cccc/dddd.
-- Dòng nào vừa trỏ sang hai tổ chức đó vừa trỏ sang tổ chức khác thì DỪNG —
-- đó là dữ liệu bắc cầu giữa hai công ty, phải có người quyết chứ không đoán.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE dt_khong_org(bang text, id uuid);

DO $b3a$
DECLARE
  r record; v bigint; v_mo_ho bigint; v_tong bigint := 0;
  v_dieu_kien text;
BEGIN
  FOR r IN
    SELECT c.relname AS bang
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r','p') AND NOT c.relispartition
       AND c.relname <> 'organizations'
       AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                        AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                        AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped)
  LOOP
    -- Gom mọi đường FK của bảng này sang một bảng CÓ organization_id.
    SELECT string_agg(format(
             'EXISTS (SELECT 1 FROM public.%I p WHERE p.%I = t.%I AND p.organization_id = ANY (%L::uuid[]))',
             cha.relname, acha.attname, acon.attname,
             '{cccc0000-0000-4000-8000-000000000001,dddd0000-0000-4000-8000-000000000001}'), ' OR ')
      INTO v_dieu_kien
      FROM pg_constraint k
      JOIN pg_class con ON con.oid = k.conrelid
      JOIN pg_class cha ON cha.oid = k.confrelid
      JOIN pg_attribute acon ON acon.attrelid = k.conrelid  AND acon.attnum = k.conkey[1]
      JOIN pg_attribute acha ON acha.attrelid = k.confrelid AND acha.attnum = k.confkey[1]
     WHERE k.contype = 'f' AND array_length(k.conkey,1) = 1
       AND con.relname = r.bang
       AND con.relnamespace = 'public'::regnamespace
       AND cha.relnamespace = 'public'::regnamespace
       AND EXISTS (SELECT 1 FROM pg_attribute y WHERE y.attrelid = cha.oid
                    AND y.attname = 'organization_id' AND y.attnum > 0 AND NOT y.attisdropped);

    CONTINUE WHEN v_dieu_kien IS NULL;

    EXECUTE format('INSERT INTO dt_khong_org SELECT %L, t.id FROM public.%I t WHERE %s',
                   r.bang, r.bang, v_dieu_kien);
    GET DIAGNOSTICS v = ROW_COUNT;
    v_tong := v_tong + v;
  END LOOP;

  -- Chốt chống đoán bừa: dòng đã đánh dấu mà còn trỏ sang tổ chức KHÁC thì dừng.
  v_mo_ho := 0;
  FOR r IN SELECT DISTINCT bang FROM dt_khong_org LOOP
    SELECT string_agg(format(
             'EXISTS (SELECT 1 FROM public.%I p WHERE p.%I = t.%I AND p.organization_id IS NOT NULL '
             'AND NOT (p.organization_id = ANY (%L::uuid[])))',
             cha.relname, acha.attname, acon.attname,
             '{cccc0000-0000-4000-8000-000000000001,dddd0000-0000-4000-8000-000000000001}'), ' OR ')
      INTO v_dieu_kien
      FROM pg_constraint k
      JOIN pg_class con ON con.oid = k.conrelid
      JOIN pg_class cha ON cha.oid = k.confrelid
      JOIN pg_attribute acon ON acon.attrelid = k.conrelid  AND acon.attnum = k.conkey[1]
      JOIN pg_attribute acha ON acha.attrelid = k.confrelid AND acha.attnum = k.confkey[1]
     WHERE k.contype = 'f' AND array_length(k.conkey,1) = 1
       AND con.relname = r.bang
       AND con.relnamespace = 'public'::regnamespace
       AND cha.relnamespace = 'public'::regnamespace
       AND EXISTS (SELECT 1 FROM pg_attribute y WHERE y.attrelid = cha.oid
                    AND y.attname = 'organization_id' AND y.attnum > 0 AND NOT y.attisdropped);

    CONTINUE WHEN v_dieu_kien IS NULL;

    EXECUTE format(
      'SELECT count(*) FROM public.%I t WHERE t.id IN (SELECT id FROM dt_khong_org WHERE bang = %L) AND (%s)',
      r.bang, r.bang, v_dieu_kien) INTO v;
    v_mo_ho := v_mo_ho + v;
  END LOOP;

  IF v_mo_ho > 0 THEN
    RAISE EXCEPTION '% dòng ở bảng không có organization_id vừa trỏ sang cccc/dddd vừa trỏ sang tổ chức khác — bắc cầu giữa hai công ty, phải có người quyết. DỪNG.', v_mo_ho;
  END IF;

  INSERT INTO dt_log VALUES ('3a-khong-co-cot-org', 'dòng đánh dấu ở bảng thiếu cột org', v_tong, NULL);
END $b3a$;

-- ---------------------------------------------------------------------------
-- BƯỚC 3 — xoá. Thứ tự không quan trọng ở chế độ replica, nhưng vẫn xoá theo
-- tên để kết quả lặp lại được giữa các lần chạy.
-- ---------------------------------------------------------------------------
DO $b3$
DECLARE r record; v bigint; v_tong bigint := 0; t0 timestamptz := clock_timestamp();
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_attribute x ON x.attrelid = c.oid AND x.attname = 'organization_id'
                         AND x.attnum > 0 AND NOT x.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r','p') AND NOT c.relispartition
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'DELETE FROM public.%I WHERE organization_id IN (%L,%L)',
      r.relname,
      'cccc0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001');
    GET DIAGNOSTICS v = ROW_COUNT;
    IF v > 0 THEN
      INSERT INTO dt_xoa VALUES (r.relname, v);
      v_tong := v_tong + v;
    END IF;
  END LOOP;

  -- Dòng ở bảng thiếu cột org, đã đánh dấu và đã kiểm không mập mờ ở bước 3a.
  FOR r IN SELECT DISTINCT bang AS relname FROM dt_khong_org LOOP
    EXECUTE format('DELETE FROM public.%I WHERE id IN (SELECT id FROM dt_khong_org WHERE bang = %L)',
                   r.relname, r.relname);
    GET DIAGNOSTICS v = ROW_COUNT;
    IF v > 0 THEN
      INSERT INTO dt_xoa VALUES (r.relname || ' [thiếu cột org]', v);
      v_tong := v_tong + v;
    END IF;
  END LOOP;

  -- Chính hai dòng tổ chức. organizations khoá theo id chứ không organization_id.
  DELETE FROM public.organizations
   WHERE id IN ('cccc0000-0000-4000-8000-000000000001',
                'dddd0000-0000-4000-8000-000000000001');
  GET DIAGNOSTICS v = ROW_COUNT;
  IF v > 0 THEN INSERT INTO dt_xoa VALUES ('organizations', v); v_tong := v_tong + v; END IF;

  INSERT INTO dt_log VALUES ('3-xoa', 'tổng số dòng đã xoá', v_tong,
    round(extract(epoch FROM clock_timestamp()-t0)::numeric*1000,1));
END $b3$;

-- ---------------------------------------------------------------------------
-- BƯỚC 4 — dựng guard lại TRƯỚC khi kiểm, để phép kiểm chạy dưới đúng luật
-- thường ngày chứ không dưới luật nới lỏng vừa dùng để xoá.
-- ---------------------------------------------------------------------------
SET LOCAL session_replication_role = 'origin';

ALTER TABLE public.approval_rule_sets       ENABLE ALWAYS TRIGGER a00_rule_set_immutable;
ALTER TABLE public.approval_rules           ENABLE ALWAYS TRIGGER a00_rules_immutable;
ALTER TABLE public.income_expense_audit_log ENABLE ALWAYS TRIGGER a00_audit_log_guard;

-- Bật lại phải trả về ĐÚNG 'A' (ALWAYS). `ENABLE TRIGGER` trơn sẽ đặt 'O' và
-- âm thầm hạ cấp ba guard mạnh nhất của hệ thống xuống loại tắt-được-bằng-GUC.
DO $b4$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE t.tgname IN ('a00_rule_set_immutable','a00_rules_immutable','a00_audit_log_guard')
     AND t.tgenabled = 'A';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'Chỉ % / 3 guard trở lại trạng thái ALWAYS. DỪNG.', v_n;
  END IF;
END $b4$;

-- ---------------------------------------------------------------------------
-- BƯỚC 5 — TỰ KIỂM TOÀN VẸN. Quét MỌI khoá ngoại một cột của schema public,
-- kể cả bảng không có organization_id — đó mới là chỗ CASCADE-không-chạy có thể
-- để lại mồ côi.
-- ---------------------------------------------------------------------------
DO $b5$
DECLARE r record; v bigint; v_tong bigint := 0; t0 timestamptz := clock_timestamp();
BEGIN
  FOR r IN
    SELECT con.relname AS bc, acon.attname AS cc, cha.relname AS bp, acha.attname AS cp
      FROM pg_constraint k
      JOIN pg_class con ON con.oid = k.conrelid
      JOIN pg_class cha ON cha.oid = k.confrelid
      JOIN pg_attribute acon ON acon.attrelid = k.conrelid  AND acon.attnum = k.conkey[1]
      JOIN pg_attribute acha ON acha.attrelid = k.confrelid AND acha.attnum = k.confkey[1]
     WHERE k.contype = 'f' AND array_length(k.conkey,1) = 1
       AND con.relnamespace = 'public'::regnamespace
       AND cha.relnamespace = 'public'::regnamespace
  LOOP
    BEGIN
      EXECUTE format(
        'SELECT count(*) FROM public.%I c WHERE c.%I IS NOT NULL '
        'AND NOT EXISTS (SELECT 1 FROM public.%I p WHERE p.%I = c.%I)',
        r.bc, r.cc, r.bp, r.cp, r.cc) INTO v;
      IF v > 0 THEN
        INSERT INTO dt_treo VALUES (r.bc, r.cc, r.bp, v);
        v_tong := v_tong + v;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO dt_treo VALUES (r.bc, r.cc || ' [LỖI ' || SQLSTATE || ']', r.bp, -1);
    END;
  END LOOP;

  INSERT INTO dt_log VALUES ('5-toan-ven',
    CASE WHEN v_tong = 0 THEN 'KHÔNG có tham chiếu treo'
         ELSE 'CÓ tham chiếu treo — xem dt_treo' END,
    v_tong, round(extract(epoch FROM clock_timestamp()-t0)::numeric*1000,1));
END $b5$;

-- ---------------------------------------------------------------------------
-- BƯỚC 6 — còn sót dòng nào của hai tổ chức không?
-- ---------------------------------------------------------------------------
DO $b6$
DECLARE r record; v bigint; v_tong bigint := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
      JOIN pg_attribute x ON x.attrelid=c.oid AND x.attname='organization_id'
                         AND x.attnum>0 AND NOT x.attisdropped
     WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
       AND NOT c.relispartition
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IN (%L,%L)',
      r.relname,'cccc0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001')
      INTO v;
    v_tong := v_tong + v;
  END LOOP;
  INSERT INTO dt_log VALUES ('6-con-sot', 'dòng còn lại của cccc/dddd', v_tong, NULL);
END $b6$;

-- ---------------------------------------------------------------------------
-- KẾT QUẢ
-- ---------------------------------------------------------------------------
SELECT
  (SELECT so FROM dt_log WHERE buoc='1-tien-quyet')                       AS tham_chieu_cheo_truoc,
  (SELECT so FROM dt_log WHERE buoc='3-xoa')                              AS so_dong_da_xoa,
  (SELECT ms FROM dt_log WHERE buoc='3-xoa')                              AS xoa_ms,
  (SELECT count(*) FROM dt_xoa)                                           AS so_bang_dung_toi,
  (SELECT so FROM dt_log WHERE buoc='5-toan-ven')                         AS so_dong_mo_coi,
  (SELECT ms FROM dt_log WHERE buoc='5-toan-ven')                         AS kiem_ms,
  (SELECT so FROM dt_log WHERE buoc='6-con-sot')                          AS con_sot,
  CASE WHEN (SELECT so FROM dt_log WHERE buoc='5-toan-ven') = 0
        AND (SELECT so FROM dt_log WHERE buoc='6-con-sot') = 0
       THEN 'SẠCH — đủ điều kiện COMMIT'
       ELSE 'BẨN — KHÔNG được commit' END                                 AS phan_quyet,
  (SELECT coalesce(string_agg(bang_con||'.'||cot||' -> '||bang_cha||' ('||so_mo_coi||')', ' | '
                              ORDER BY so_mo_coi DESC), '(không có)')
     FROM dt_treo)                                                        AS treo_chi_tiet,
  (SELECT coalesce(string_agg(bang||'('||so_dong||')', ', ' ORDER BY so_dong DESC), '')
     FROM (SELECT * FROM dt_xoa ORDER BY so_dong DESC LIMIT 15) s)        AS top15_bang_xoa;

ROLLBACK;
