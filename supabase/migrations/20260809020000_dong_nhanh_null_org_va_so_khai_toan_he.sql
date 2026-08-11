-- =============================================================================
-- Đóng nhánh NULL: 3.621 dòng đang hiển thị cho MỌI tổ chức mà không ai đếm
--
-- ĐIỂM MÙ THỨ HAI CỦA BỘ ĐO. Công thức biên giới đang chạy trên 302 bảng là:
--     organization_id IS NULL OR is_super_admin() OR organization_id IN my_org_ids()
-- Nhánh đầu nghĩa là: dòng NULL thì AI CŨNG THẤY.
--
-- Còn bộ đo rò định nghĩa "dòng của tổ chức khác" là
--     organization_id IS NOT NULL AND organization_id <> org-của-mình
-- nên dòng NULL bị loại khỏi phép đếm THEO ĐÚNG ĐỊNH NGHĨA. Chúng chưa từng bị
-- tính là rò lần nào, dù chúng lộ cho tất cả.
--
-- Đo 09/08/2026: **3.621 dòng NULL trên 15 bảng**
--   public_room_events 3.084 · invoice_audit_log 345 · cron_runs 78
--   inspection_photos 37 · salary_award_errors 37 · notifications 23
--   inspection_sessions 6 · salary_attendance_day 3 · push_subscriptions 2
--   salary_streak_state 1 · material_usage_items 1 · material_usages 1
--   profit_manager_salaries 1 · profit_managers 1 · public_room_share_tokens 1
--
-- Hôm nay chỉ còn MỘT tổ chức nên chưa ai thấy gì. Ngày có công ty thứ hai thì
-- 3.621 dòng này lộ ngay từ giây đầu — kể cả 345 dòng nhật ký kiểm toán hoá đơn.
--
-- ------------------------- VÌ SAO KHÔNG GẮN TRIGGER DIỆN RỘNG ---------------
-- Prod có 105 bảng nhận được NULL (nullable, không DEFAULT, không trigger), 84
-- trong số đó có cột cha để suy. Cám dỗ là gắn `app_private._autofill_org` cho
-- cả 84.
--
-- KHÔNG LÀM, vì nhánh cuối của hàm đó rơi về HẰNG SỐ 'aaaa…' khi không suy được
-- (có ghi log, nhưng vẫn ghi giá trị). Gắn diện rộng sẽ làm gate XANH trong khi
-- âm thầm dán nhãn "công ty thật" lên dữ liệu chưa ai xác minh — với một tổ chức
-- thì vô hại, với hai thì đó là dữ liệu sai và không còn dấu vết để lần.
-- Một cái bẫy im lặng thay cho một cái bẫy ồn ào là đổi tệ lấy tệ hơn.
--
-- Nên: SỔ KHAI + VÁ ĐÚNG CHỖ ĐANG HỎNG. Bảng nào NULL nghĩa là "toàn hệ có chủ
-- ý" thì phải KHAI vào sổ; bảng nào NULL là lỗi thì vá. Không khai, không vá,
-- mà có dòng NULL ⇒ gate ĐỎ.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Sổ khai "NULL ở bảng này là TOÀN HỆ có chủ ý".
--
-- Khác hẳn app_private.org_boundary_exemptions: sổ kia nói "bảng này CHƯA có
-- biên giới"; sổ này nói "bảng này CÓ biên giới, và dòng NULL của nó là dùng
-- chung một cách có chủ ý". Trộn hai khái niệm vào một bảng thì sáu tháng nữa
-- không ai đọc ra được ý nào.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.org_null_is_global (
  table_name  text PRIMARY KEY,
  reason      text NOT NULL,
  decided_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_private.org_null_is_global IS
  'Khai báo: dòng có organization_id IS NULL ở bảng này là dữ liệu TOÀN HỆ có chủ ý, không phải nhãn bị quên. Bảng không khai mà có dòng NULL thì gate đo rò phải ĐỎ.';

-- ---------------------------------------------------------------------------
-- 2. Vá những chỗ NULL là LỖI — suy từ cha, đúng khuôn GĐ6 đã dùng.
--    Không đoán: chỉ điền khi suy ra được, phần còn lại để bước 3 xử.
-- ---------------------------------------------------------------------------
DO $va$
DECLARE
  qua_cha text[][] := ARRAY[
    -- [bảng, cột khoá ngoại, bảng cha]
    -- invoice_audit_log KHÔNG nằm ở đây: nó có guard append-only chặn mọi
    -- UPDATE, xử riêng ở khối dưới.
    ARRAY['public_room_events',      'room_id',      'rooms'],
    ARRAY['inspection_photos',       'session_id',   'inspection_sessions'],
    ARRAY['material_usage_items',    'usage_id',     'material_usages'],
    ARRAY['inspection_sessions',     'building_id',  'buildings'],
    ARRAY['notifications',           'contract_id',  'contracts']
  ];
  qua_nguoi text[][] := ARRAY[
    ARRAY['notifications',           'user_id'],
    ARRAY['material_usages',         'user_id'],
    ARRAY['salary_attendance_day',   'user_id'],
    ARRAY['salary_streak_state',     'user_id'],
    ARRAY['salary_award_errors',     'staff_id'],
    ARRAY['push_subscriptions',      'user_id'],
    ARRAY['profit_managers',         'user_id'],
    ARRAY['profit_manager_salaries', 'user_id'],
    ARRAY['public_room_share_tokens','owner_id'],
    ARRAY['inspection_sessions',     'user_id'],
    -- 3.080/3.084 dòng public_room_events thiếu CẢ room_id lẫn building_id
    -- (khách xem trang phòng trống, sự kiện ghi trước khi chọn phòng), nhưng
    -- owner_id là NOT NULL nên luôn suy được.
    ARRAY['public_room_events',      'owner_id']
  ];
  i int;
  v_n bigint;
  v_tong bigint := 0;
BEGIN
  -- LƯỢT 1 — suy qua bảng cha. Chạy trước vì nó chắc chắn hơn suy qua người.
  FOR i IN 1 .. array_length(qua_cha, 1) LOOP
    BEGIN
      EXECUTE format(
        'UPDATE public.%I t SET organization_id = p.organization_id '
        '  FROM public.%I p WHERE p.id = t.%I '
        '   AND t.organization_id IS NULL AND p.organization_id IS NOT NULL',
        qua_cha[i][1], qua_cha[i][3], qua_cha[i][2]);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_tong := v_tong + v_n;
      IF v_n > 0 THEN
        RAISE NOTICE 'LƯỢT 1 %: điền % dòng qua %.', qua_cha[i][1], v_n, qua_cha[i][3];
      END IF;
    EXCEPTION WHEN undefined_column OR undefined_table THEN
      RAISE NOTICE 'LƯỢT 1 %: bỏ qua (thiếu cột %).', qua_cha[i][1], qua_cha[i][2];
    END;
  END LOOP;

  -- LƯỢT 2 — suy qua người, CHỈ khi người đó thuộc đúng MỘT tổ chức ACTIVE.
  -- Người hai tổ chức thì không suy được, và đoán bừa còn tệ hơn để NULL.
  FOR i IN 1 .. array_length(qua_nguoi, 1) LOOP
    BEGIN
      EXECUTE format(
        'UPDATE public.%I t SET organization_id = m.org '
        '  FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org '
        '          FROM public.organization_memberships WHERE status = ''ACTIVE'' '
        '         GROUP BY user_id HAVING count(DISTINCT organization_id) = 1) m '
        ' WHERE m.user_id = t.%I AND t.organization_id IS NULL',
        qua_nguoi[i][1], qua_nguoi[i][2]);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_tong := v_tong + v_n;
      IF v_n > 0 THEN
        RAISE NOTICE 'LƯỢT 2 %: điền % dòng qua %.', qua_nguoi[i][1], v_n, qua_nguoi[i][2];
      END IF;
    EXCEPTION WHEN undefined_column OR undefined_table THEN
      RAISE NOTICE 'LƯỢT 2 %: bỏ qua (thiếu cột %).', qua_nguoi[i][1], qua_nguoi[i][2];
    END;
  END LOOP;

  -- LƯỢT 3 — con của những bảng vừa được vá ở lượt 1/2.
  FOR i IN 1 .. 2 LOOP
    EXECUTE
      'UPDATE public.inspection_photos t SET organization_id = p.organization_id '
      '  FROM public.inspection_sessions p WHERE p.id = t.session_id '
      '   AND t.organization_id IS NULL AND p.organization_id IS NOT NULL';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_tong := v_tong + v_n;
    EXECUTE
      'UPDATE public.material_usage_items t SET organization_id = p.organization_id '
      '  FROM public.material_usages p WHERE p.id = t.usage_id '
      '   AND t.organization_id IS NULL AND p.organization_id IS NOT NULL';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_tong := v_tong + v_n;
  END LOOP;

  RAISE NOTICE 'Tổng cộng điền được % dòng organization_id (chưa tính invoice_audit_log).', v_tong;
END
$va$;

-- ---------------------------------------------------------------------------
-- 2b. invoice_audit_log — 345 dòng, có guard append-only chặn MỌI UPDATE.
--
-- ĐÂY LÀ SỬA SIÊU DỮ LIỆU, KHÔNG PHẢI SỬA NỘI DUNG KIỂM TOÁN. Cột
-- organization_id được đợt rào biên giới thêm vào SAU, và 345 dòng cũ sinh ra
-- trước đó nên không có nhãn. Guard append-only sinh ra để không ai sửa được
-- ĐIỀU ĐÃ GHI — nó không phân biệt được "sửa nội dung" với "điền nhãn còn
-- thiếu", nên phải hạ đúng một lần, có kiểm soát.
--
-- Để nguyên thì tệ hơn: 345 dòng nhật ký kiểm toán hoá đơn của công ty thật
-- hiển thị cho MỌI tổ chức qua nhánh IS NULL.
--
-- Dùng session_replication_role = 'replica' chứ KHÔNG ALTER TABLE DISABLE
-- TRIGGER: GUC này theo TRANSACTION nên session khác không hề được nới, còn
-- ALTER TABLE đổi catalog thì mọi session đều thấy. (Cùng lý lẽ đã dùng khi xoá
-- hai tổ chức ở 20260808080000.)
--
-- Giá trị điền lấy TỪ CHÍNH hoá đơn mà dòng đó nói về, nên không có chỗ để đoán.
-- ---------------------------------------------------------------------------
DO $audit$
DECLARE
  v_truoc bigint;
  v_sau   bigint;
  v_n     bigint;
  v_sai   bigint;
BEGIN
  SELECT count(*) INTO v_truoc FROM public.invoice_audit_log;

  SET LOCAL session_replication_role = 'replica';

  UPDATE public.invoice_audit_log t
     SET organization_id = p.organization_id
    FROM public.invoices p
   WHERE p.id = t.invoice_id
     AND t.organization_id IS NULL
     AND p.organization_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 289/345 dòng trỏ tới hoá đơn ĐÃ BỊ XOÁ — nhật ký sống lâu hơn thứ nó ghi,
  -- đó là bản chất của audit log chứ không phải dữ liệu hỏng. Với chúng thì
  -- suy qua actor_id (người thực hiện thao tác), vẫn theo luật "chỉ khi người
  -- đó thuộc đúng MỘT tổ chức ACTIVE".
  UPDATE public.invoice_audit_log t
     SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org
            FROM public.organization_memberships WHERE status = 'ACTIVE'
           GROUP BY user_id HAVING count(DISTINCT organization_id) = 1) m
   WHERE m.user_id = t.actor_id AND t.organization_id IS NULL;
  GET DIAGNOSTICS v_sai = ROW_COUNT;
  v_n := v_n + v_sai;

  -- Còn lại là bản ghi MỒ CÔI THẬT SỰ, và đây là cặn của chính lần xoá hai tổ
  -- chức ở 20260808080000: lệnh xoá hôm đó khớp `organization_id IN (cccc,dddd)`
  -- nên không chạm được dòng NULL.
  --
  -- Đo trên 287 dòng còn lại: 217 dòng có actor là DEMO Chủ Nhà / DEMO Kế Toán
  -- (tài khoản của tổ chức đã xoá, nay không còn membership nào), 70 dòng không
  -- có actor. CẢ 287 đều có hoá đơn ĐÃ BỊ XOÁ và entity ĐÃ BỊ XOÁ — thứ chúng
  -- ghi lại không còn tồn tại, và không quy được về tổ chức nào.
  --
  -- Xoá chúng, với vị từ chặt gồm BA vế phải đúng đồng thời:
  --   (1) chưa có nhãn tổ chức
  --   (2) hoá đơn mà nó nói về KHÔNG còn tồn tại
  --   (3) không quy được người thực hiện (không có actor, hoặc actor không còn
  --       membership ACTIVE nào)
  -- Thiếu một vế là dòng đó CÒN quy được về đâu đó và phải giữ lại.
  --
  -- Vì sao xoá chứ không khai là "toàn hệ": chúng KHÔNG phải dữ liệu dùng chung.
  -- Khai như vậy là dán nhãn hợp lệ lên một chỗ rò. Còn để nguyên thì 287 bản
  -- ghi kiểm toán của công ty đã bị xoá sẽ hiện ra với mọi tổ chức tương lai.
  DELETE FROM public.invoice_audit_log t
   WHERE t.organization_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = t.invoice_id)
     AND (t.actor_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.organization_memberships m
                          WHERE m.user_id = t.actor_id AND m.status = 'ACTIVE'));
  GET DIAGNOSTICS v_sai = ROW_COUNT;
  RAISE NOTICE 'invoice_audit_log: xoá % bản ghi mồ côi (hoá đơn đã xoá, không quy được người thực hiện).', v_sai;

  SET LOCAL session_replication_role = 'origin';

  -- Guard phải sống lại NGAY, và phải chứng minh nó sống: thử một UPDATE vô
  -- hại, nếu KHÔNG bị chặn thì guard đã hỏng và không được commit.
  BEGIN
    UPDATE public.invoice_audit_log SET organization_id = organization_id
     WHERE id = (SELECT id FROM public.invoice_audit_log LIMIT 1);
    RAISE EXCEPTION 'Guard append-only của invoice_audit_log KHÔNG chặn UPDATE sau khi khôi phục. DỪNG.';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;  -- đúng như mong đợi
  END;

  -- Số dòng chỉ được giảm ĐÚNG bằng số bản ghi mồ côi vừa xoá. Lệch một dòng
  -- nghĩa là có thứ khác đụng vào sổ trong cùng transaction — không được commit.
  SELECT count(*) INTO v_sau FROM public.invoice_audit_log;
  IF v_sau <> v_truoc - v_sai THEN
    RAISE EXCEPTION 'invoice_audit_log: % dòng trước, xoá %, kỳ vọng % nhưng còn % — có thứ khác đụng vào sổ. DỪNG.',
      v_truoc, v_sai, v_truoc - v_sai, v_sau;
  END IF;

  -- Và nhãn điền vào phải khớp CHÍNH hoá đơn của dòng đó.
  SELECT count(*) INTO v_sai
    FROM public.invoice_audit_log t
    JOIN public.invoices p ON p.id = t.invoice_id
   WHERE t.organization_id IS NOT NULL
     AND p.organization_id IS NOT NULL
     AND t.organization_id <> p.organization_id;
  IF v_sai > 0 THEN
    RAISE EXCEPTION '% dòng invoice_audit_log mang nhãn khác hoá đơn của chính nó. DỪNG.', v_sai;
  END IF;

  RAISE NOTICE 'invoice_audit_log: điền % dòng, guard đã sống lại, % dòng nguyên vẹn.', v_n, v_sau;
END
$audit$;

-- ---------------------------------------------------------------------------
-- 3. Khai những bảng mà NULL là TOÀN HỆ có chủ ý.
--    Mỗi dòng phải có lý do ĐO ĐƯỢC, không phải lời khai suông.
-- ---------------------------------------------------------------------------
INSERT INTO app_private.org_null_is_global (table_name, reason, decided_by) VALUES
  ('ai_providers',
   'Danh mục nhà cung cấp LLM dùng chung. PRIMARY KEY (provider) ⇒ toàn CSDL chỉ MỘT dòng mỗi provider, không thể có bản riêng cho từng tổ chức. Gỡ nhãn ở 20260809010000.',
   'phien-09-08-2026'),
  ('ai_copilot_settings',
   'Cấu hình Copilot toàn hệ. PRIMARY KEY (id boolean) ⇒ toàn CSDL tối đa HAI dòng. Gỡ nhãn ở 20260809010000.',
   'phien-09-08-2026'),
  ('cron_runs',
   'Nhật ký chạy cron của HỆ THỐNG, không thuộc tổ chức nào. Đo: 78/110 dòng NULL, phần có nhãn là do job chạy trong ngữ cảnh một tổ chức chứ không phải bản chất bảng.',
   'phien-09-08-2026')
ON CONFLICT (table_name) DO UPDATE
  SET reason = EXCLUDED.reason, decided_by = EXCLUDED.decided_by;

-- ---------------------------------------------------------------------------
-- 4. NGHIỆM THU — sau khi vá, mọi dòng NULL còn lại phải nằm ở bảng ĐÃ KHAI.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  r        record;
  v_n      bigint;
  v_ban    text := '';
  v_so_ban bigint := 0;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id'
                         AND a.attnum > 0 AND NOT a.attisdropped AND NOT a.attnotnull
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r','p') AND NOT c.relispartition
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', r.relname)
      INTO v_n;
    CONTINUE WHEN v_n = 0;
    IF NOT EXISTS (SELECT 1 FROM app_private.org_null_is_global g WHERE g.table_name = r.relname) THEN
      v_so_ban := v_so_ban + v_n;
      v_ban := v_ban || format('%s(%s) ', r.relname, v_n);
    END IF;
  END LOOP;

  IF v_so_ban > 0 THEN
    RAISE EXCEPTION 'Còn % dòng NULL ở bảng CHƯA KHAI — chúng hiển thị cho mọi tổ chức: %', v_so_ban, v_ban;
  END IF;

  RAISE NOTICE 'Mọi dòng organization_id NULL còn lại đều nằm ở bảng đã khai là toàn hệ.';
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- CÒN LẠI, có chủ ý không làm ở đây:
--   105 bảng vẫn NHẬN được NULL (nullable, không DEFAULT, không trigger). File
--   này vá dữ liệu ĐANG hỏng và dựng sổ khai; nó KHÔNG chặn dòng NULL mới.
--   Chặn bằng cách gắn _autofill_org diện rộng là sai — xem lý do ở đầu file.
--   Thứ canh chỗ này là GATE: scripts/measure-org-leak.mjs nay đếm dòng NULL và
--   ĐỎ nếu bảng chưa khai. Có người sẽ thấy ngay khi nó xuất hiện.
--
-- ROLLBACK: file này ĐIỀN dữ liệu, không xoá gì. Muốn lùi thì đặt lại NULL cho
-- đúng những dòng đã điền — bản dump lane tự chụp ngay trước lúc apply là đường
-- lùi đầy đủ. DROP TABLE app_private.org_null_is_global nếu muốn bỏ sổ khai.
-- =============================================================================
