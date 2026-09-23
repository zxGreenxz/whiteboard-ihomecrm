-- =============================================================================
-- DỌN TÀN DƯ ORG TEST CŨ (cccc) + VÁ DÒNG MỒ CÔI VI PHẠM KHOÁ NGOẠI
-- =============================================================================
--
-- VÌ SAO (đo trên production 23/09/2026, chỉ đọc):
--   1. Org TEST cccc0000-… đã xoá khỏi public.organizations ngày 08/08
--      (20260808080000), nhưng lần xoá đó chỉ quét schema public. Còn sót 4.560
--      dòng mang organization_id = cccc trong 9 bảng app_private (nhật ký ghi,
--      change log, liên kết 2.832 file bản sao…).
--   2. Dòng MỒ CÔI trên 16 khoá ngoại đang mang cờ "đã kiểm" (convalidated): dòng
--      con trỏ tới dòng cha không còn — xoá cha dưới session_replication_role =
--      replica (FK không được kiểm) ở lần xoá 08/08 và ở các lượt dọn fixture E2E
--      của org DEMO (08–12/09). Hệ quả thật: mọi lần KHÔI PHỤC production từ
--      pg_dump đều vấp 16 ràng buộc này (lộ ra khi dựng môi trường TEST).
--      Phân bố: org cccc và org DEMO dddd — 0 dòng org THẬT.
--
-- XOÁ GÌ — mọi DELETE đều TỰ KÈM điều kiện org, không có DELETE nào khác:
--   a. mọi dòng organization_id = cccc (org không còn tồn tại) — public, app_private;
--   b. dòng vi phạm khoá ngoại MÀ organization_id ∈ {cccc, dddd}, lặp tới điểm dừng
--      (xoá cha mồ côi làm lộ con mồ côi — chế độ replica không cascade);
--   c. gỡ cron clone_org_sync_worker (cơ chế đồng bộ org TEST cũ).
-- Diễn tập trên bản sao production (môi trường TEST): 4.560 dòng cccc + 355 dòng
-- mồ côi DEMO/cccc (gồm 36 dòng bút toán chi tiết của 12 bút toán DEMO mồ côi, 10
-- thành phần hoá đơn DEMO của 9 manifest mồ côi).
--
-- TỰ KIỂM trong CÙNG transaction — sai một điểm là huỷ toàn bộ:
--   - BẰNG CHỨNG TRỰC TIẾP: mọi dòng đã xoá (DELETE … RETURNING, lưu dm_dong) đều
--     mang organization_id ∈ {cccc, dddd} — không có dòng org THẬT hay NULL nào;
--   - bất biến tiền org DEMO: dòng bút toán chi tiết / phân bổ / thành phần hoá đơn /
--     đảo phiếu bị xoá thì bản ghi CHA của nó cũng không còn (không xoá lẻ một phần
--     của bút toán hay hoá đơn còn sống);
--   - trần số dòng: tổng ≤ 6.000 (đo 4.915) — xoá vọt quá là có gì sai;
--   - 0 dòng org cccc còn lại trong public/app_private;
--   - quét lại MỌI khoá ngoại của public/app_private: 0 dòng vi phạm;
--   - trigger ALWAYS đã tắt tạm trở lại đúng 'A'.
--
-- IDEMPOTENT: lane chạy thân file HAI lần trong một transaction; lượt hai không còn
-- gì để xoá và mọi phép kiểm vẫn đạt.
-- Database rỗng (diễn tập khôi phục baseline): dừng ở bước 0 vì không có org THẬT —
-- đúng việc, đã khai trong forward-lane-expectations.json.
-- KHÔNG xoá file storage — việc đó làm riêng (tải bản lưu trước, kiểm bản gốc).
-- =============================================================================

-- BƯỚC 0 — tiền đề.
DO $b0$
BEGIN
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = 'cccc0000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Org cccc vẫn còn trong public.organizations — không phải tình huống file này dọn. DỪNG.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = 'aaaa0000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Không thấy org THẬT aaaa — sai database? DỪNG.';
  END IF;
END $b0$;

CREATE TEMP TABLE IF NOT EXISTS dm_xoa (buoc text, bang regclass, so bigint) ON COMMIT DROP;
TRUNCATE dm_xoa;
CREATE TEMP TABLE IF NOT EXISTS dm_dong (buoc text, bang regclass, dong jsonb) ON COMMIT DROP;
TRUNCATE dm_dong;
CREATE TEMP TABLE IF NOT EXISTS dm_trigger (bang regclass, ten name, PRIMARY KEY (bang, ten)) ON COMMIT DROP;
TRUNCATE dm_trigger;

-- BƯỚC 1 — hạ guard THEO TRANSACTION (như 20260808080000). Trigger thường ('O') tắt
-- theo replica; trigger ALWAYS chặn DELETE trên bảng sắp xoá thì tắt ĐÍCH DANH, ghi
-- dm_trigger để bật lại đúng 'A' ở bước 4. (Đo prod 23/09: chỉ một —
-- app_private.income_expense_flow_ownership_events.a00_flow_events_immutable; khoá
-- SHARE ROW EXCLUSIVE giữ tới COMMIT, cả file chạy ~2 giây mỗi lượt trên prod.)
SET LOCAL session_replication_role = 'replica';

-- BƯỚC 2 — xoá dòng org cccc ở mọi bảng có organization_id (public, app_private).
DO $b2$
DECLARE r record; t record; v bigint;
BEGIN
  IF current_setting('session_replication_role') <> 'replica' THEN
    RAISE EXCEPTION 'Không ở chế độ replica (chạy ngoài transaction?). DỪNG.';
  END IF;
  FOR r IN
    SELECT c.oid::regclass AS bang
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
     WHERE n.nspname IN ('public', 'app_private') AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE organization_id = %L', r.bang, 'cccc0000-0000-4000-8000-000000000001') INTO v;
    CONTINUE WHEN v = 0;
    FOR t IN SELECT tg.tgname FROM pg_trigger tg
              WHERE tg.tgrelid = r.bang AND NOT tg.tgisinternal AND tg.tgenabled = 'A' AND (tg.tgtype & 8) = 8 LOOP
      EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.bang, t.tgname);
      INSERT INTO dm_trigger VALUES (r.bang, t.tgname) ON CONFLICT DO NOTHING;
    END LOOP;
    EXECUTE format('WITH d AS (DELETE FROM %s WHERE organization_id = %L RETURNING *)
                    INSERT INTO dm_dong SELECT %L, %L::regclass, to_jsonb(d) FROM d',
                   r.bang, 'cccc0000-0000-4000-8000-000000000001', 'cccc', r.bang);
    GET DIAGNOSTICS v = ROW_COUNT;
    INSERT INTO dm_xoa VALUES ('cccc', r.bang, v);
  END LOOP;
END $b2$;

-- BƯỚC 3 — vá mồ côi: xoá dòng VI PHẠM khoá ngoại mà organization_id ∈ {cccc, dddd},
-- lặp tới điểm dừng. Dòng vi phạm thuộc org khác (kể cả NULL) KHÔNG bị xoá — nếu có,
-- bước 5 bắt và huỷ cả transaction. Bỏ FK nhân bản xuống partition (conparentid <> 0).
DO $b3$
DECLARE f record; t record; v bigint; tong_luot bigint; luot int := 0; dk_null text; dk_khop text;
BEGIN
  IF current_setting('session_replication_role') <> 'replica' THEN
    RAISE EXCEPTION 'Không ở chế độ replica. DỪNG.';
  END IF;
  LOOP
    luot := luot + 1;
    tong_luot := 0;
    FOR f IN
      SELECT co.conrelid::regclass AS con, co.confrelid::regclass AS cha,
             (SELECT array_agg(a.attname ORDER BY k.i) FROM unnest(co.conkey) WITH ORDINALITY k(n, i)
                JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.n) AS cot_con,
             (SELECT array_agg(a.attname ORDER BY k.i) FROM unnest(co.confkey) WITH ORDINALITY k(n, i)
                JOIN pg_attribute a ON a.attrelid = co.confrelid AND a.attnum = k.n) AS cot_cha
        FROM pg_constraint co
        JOIN pg_class c ON c.oid = co.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE co.contype = 'f' AND co.conparentid = 0 AND n.nspname IN ('public', 'app_private') AND NOT c.relispartition
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = co.conrelid AND a.attname = 'organization_id' AND NOT a.attisdropped)
    LOOP
      SELECT string_agg(format('c.%I IS NOT NULL', x), ' AND ') INTO dk_null FROM unnest(f.cot_con) x;
      SELECT string_agg(format('p.%I = c.%I', f.cot_cha[i], f.cot_con[i]), ' AND ') INTO dk_khop
        FROM generate_subscripts(f.cot_con, 1) i;
      EXECUTE format('SELECT count(*) FROM %s c WHERE c.organization_id IN (%L, %L) AND %s
                        AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',
                     f.con, 'cccc0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000001',
                     dk_null, f.cha, dk_khop) INTO v;
      CONTINUE WHEN v = 0;
      FOR t IN SELECT tg.tgname FROM pg_trigger tg
                WHERE tg.tgrelid = f.con AND NOT tg.tgisinternal AND tg.tgenabled = 'A' AND (tg.tgtype & 8) = 8 LOOP
        EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', f.con, t.tgname);
        INSERT INTO dm_trigger VALUES (f.con, t.tgname) ON CONFLICT DO NOTHING;
      END LOOP;
      EXECUTE format('WITH d AS (DELETE FROM %s c WHERE c.organization_id IN (%L, %L) AND %s
                        AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s) RETURNING c.*)
                      INSERT INTO dm_dong SELECT %L, %L::regclass, to_jsonb(d) FROM d',
                     f.con, 'cccc0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000001',
                     dk_null, f.cha, dk_khop, 'mo-coi-luot-' || luot, f.con);
      GET DIAGNOSTICS v = ROW_COUNT;
      INSERT INTO dm_xoa VALUES ('mo-coi-luot-' || luot, f.con, v);
      tong_luot := tong_luot + v;
    END LOOP;
    EXIT WHEN tong_luot = 0;
    IF luot >= 10 THEN
      RAISE EXCEPTION 'Vá mồ côi chưa hội tụ sau 10 lượt (lượt cuối còn xoá % dòng). DỪNG.', tong_luot;
    END IF;
  END LOOP;
END $b3$;

-- BƯỚC 4 — dựng guard lại TRƯỚC khi kiểm.
SET LOCAL session_replication_role = 'origin';

DO $b4$
DECLARE r record; v_sai int := 0;
BEGIN
  FOR r IN SELECT bang, ten FROM dm_trigger LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I', r.bang, r.ten);
  END LOOP;
  -- `ENABLE TRIGGER` trơn sẽ đặt 'O' và âm thầm hạ cấp guard — kiểm đúng 'A'.
  SELECT count(*) INTO v_sai FROM dm_trigger d JOIN pg_trigger t ON t.tgrelid = d.bang AND t.tgname = d.ten
   WHERE t.tgenabled <> 'A';
  IF v_sai > 0 THEN
    RAISE EXCEPTION '% trigger ALWAYS không trở lại trạng thái A. DỪNG.', v_sai;
  END IF;
END $b4$;

-- BƯỚC 5 — TỰ KIỂM.
DO $b5$
DECLARE r record; f record; v bigint; v_tong bigint; v_con_cccc bigint := 0; v_vi_pham bigint := 0; ct text := '';
        dk_null text; dk_khop text;
BEGIN
  -- 5a. BẰNG CHỨNG TRỰC TIẾP: không dòng nào đã xoá thuộc org THẬT hay có org NULL.
  SELECT count(*) INTO v FROM dm_dong
   WHERE (dong ->> 'organization_id') IS NULL
      OR (dong ->> 'organization_id') NOT IN ('cccc0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000001');
  IF v > 0 THEN
    RAISE EXCEPTION '% dòng đã xoá KHÔNG thuộc cccc/dddd. KHÔNG commit.', v;
  END IF;

  -- 5b. trần số dòng — đo 4.915 lúc diễn tập; vọt quá là có gì sai.
  SELECT count(*) INTO v_tong FROM dm_dong;
  IF v_tong > 6000 THEN
    RAISE EXCEPTION 'Xoá % dòng — vượt trần 6.000 (đo 4.915). KHÔNG commit.', v_tong;
  END IF;

  -- 5c. bất biến tiền org DEMO: không xoá lẻ một phần của bản ghi cha CÒN SỐNG.
  IF to_regclass('public.income_expense_posting_lines') IS NOT NULL THEN
    SELECT count(*) INTO v FROM dm_dong d
     WHERE d.bang = 'public.income_expense_posting_lines'::regclass
       AND EXISTS (SELECT 1 FROM public.income_expense_postings p WHERE p.id = (d.dong ->> 'posting_id')::uuid);
    IF v > 0 THEN RAISE EXCEPTION '% dòng bút toán chi tiết bị xoá trong khi bút toán cha còn sống. KHÔNG commit.', v; END IF;
  END IF;
  IF to_regclass('public.finance_invoice_components') IS NOT NULL THEN
    SELECT count(*) INTO v FROM dm_dong d
     WHERE d.bang = 'public.finance_invoice_components'::regclass
       AND EXISTS (SELECT 1 FROM public.finance_invoice_component_manifests m WHERE m.id = (d.dong ->> 'manifest_id')::uuid);
    IF v > 0 THEN RAISE EXCEPTION '% thành phần hoá đơn bị xoá trong khi manifest còn sống. KHÔNG commit.', v; END IF;
  END IF;
  IF to_regclass('public.finance_invoice_component_allocations') IS NOT NULL THEN
    SELECT count(*) INTO v FROM dm_dong d
     WHERE d.bang = 'public.finance_invoice_component_allocations'::regclass
       AND EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = (d.dong ->> 'invoice_id')::uuid);
    IF v > 0 THEN RAISE EXCEPTION '% phân bổ bị xoá trong khi hoá đơn còn sống. KHÔNG commit.', v; END IF;
  END IF;
  IF to_regclass('app_private.payment_reversals') IS NOT NULL THEN
    SELECT count(*) INTO v FROM dm_dong d
     WHERE d.bang = 'app_private.payment_reversals'::regclass
       AND EXISTS (SELECT 1 FROM public.payments p WHERE p.id = (d.dong ->> 'original_payment_id')::uuid);
    IF v > 0 THEN RAISE EXCEPTION '% dòng đảo thanh toán bị xoá trong khi thanh toán gốc còn sống. KHÔNG commit.', v; END IF;
  END IF;

  -- 5d. không còn dòng org cccc trong public/app_private.
  FOR r IN
    SELECT c.oid::regclass AS bang
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
     WHERE n.nspname IN ('public', 'app_private') AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE organization_id = %L', r.bang, 'cccc0000-0000-4000-8000-000000000001') INTO v;
    v_con_cccc := v_con_cccc + v;
  END LOOP;
  IF v_con_cccc > 0 THEN
    RAISE EXCEPTION 'Còn % dòng org cccc. KHÔNG commit.', v_con_cccc;
  END IF;

  -- 5e. quét lại MỌI khoá ngoại của public/app_private (kể cả bảng không có org).
  FOR f IN
    SELECT co.conname, co.conrelid::regclass AS con, co.confrelid::regclass AS cha,
           (SELECT array_agg(a.attname ORDER BY k.i) FROM unnest(co.conkey) WITH ORDINALITY k(n, i)
              JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.n) AS cot_con,
           (SELECT array_agg(a.attname ORDER BY k.i) FROM unnest(co.confkey) WITH ORDINALITY k(n, i)
              JOIN pg_attribute a ON a.attrelid = co.confrelid AND a.attnum = k.n) AS cot_cha
      FROM pg_constraint co
      JOIN pg_class c ON c.oid = co.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE co.contype = 'f' AND co.conparentid = 0 AND n.nspname IN ('public', 'app_private') AND NOT c.relispartition
  LOOP
    SELECT string_agg(format('c.%I IS NOT NULL', x), ' AND ') INTO dk_null FROM unnest(f.cot_con) x;
    SELECT string_agg(format('p.%I = c.%I', f.cot_cha[i], f.cot_con[i]), ' AND ') INTO dk_khop
      FROM generate_subscripts(f.cot_con, 1) i;
    EXECUTE format('SELECT count(*) FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',
                   f.con, dk_null, f.cha, dk_khop) INTO v;
    IF v > 0 THEN
      v_vi_pham := v_vi_pham + v;
      ct := ct || format('%s.%s (%s); ', f.con, f.conname, v);
    END IF;
  END LOOP;
  IF v_vi_pham > 0 THEN
    RAISE EXCEPTION 'Còn % dòng vi phạm khoá ngoại: %. KHÔNG commit.', v_vi_pham, ct;
  END IF;

  RAISE NOTICE 'Dọn xong: xoá % dòng (cccc %, mồ côi %) · 100%% thuộc cccc/dddd · 0 vi phạm khoá ngoại · 0 dòng cccc.',
    v_tong,
    (SELECT count(*) FROM dm_dong WHERE buoc = 'cccc'),
    (SELECT count(*) FROM dm_dong WHERE buoc LIKE 'mo-coi-%');
END $b5$;

-- BƯỚC 6 — gỡ cron đồng bộ org TEST cũ (idempotent). Hàm nó gọi gỡ ở
-- 20260923163531 cùng schema clone_org.
DO $b6$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone_org_sync_worker') THEN
    PERFORM cron.unschedule('clone_org_sync_worker');
  END IF;
END $b6$;

-- Bảng kê làm bằng chứng (lane ghi kết quả câu cuối vào evidence).
SELECT buoc, bang::text AS bang, so FROM dm_xoa WHERE so > 0 ORDER BY buoc, bang::text;
