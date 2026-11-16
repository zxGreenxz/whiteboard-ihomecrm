-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — BẢN LÙI R2: huỷ (VOID) các dòng lương ghi bù của Đợt 3a (20261115113530).
--
-- DÙNG KHI: lùi toàn phần Đợt 3a, SAU R7b (công tắc không còn ON); chạy được cả trước lẫn sau R1. Công tắc còn ON
--   (kể cả khi đang đóng băng) ⇒ dừng R2_ROUTE: huỷ dòng ghi bù làm số dư được phép chi nhảy lên khi lệnh chi /
--   duyệt còn chạy hoặc sẽ chạy lại ngay khi gỡ đóng băng.
-- CÁCH ÁP — tệp này KHÔNG phải migration, chỉ dùng khi phải lùi; nội dung đã là migration hoàn chỉnh.
--   Runbook: docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/README.md
--   1. node scripts/tao-ten-migration.mjs so_tong_loi_nhuan_huy_ghi_bu   (chỉ IN ra tên <timestamp>_<slug>.sql)
--   2. tạo supabase/migrations/<tên vừa in> chứa NGUYÊN VĂN tệp này → git add <tệp đó> → npm run provenance:generate
--   3. npm run migrate:forward -- <tệp>            (dry-run: lane dán HAI lượt trong một giao dịch rồi ROLLBACK)
--   4. npm run migrate:forward -- <tệp> --apply    (chỉ sau dry-run xanh)
--
-- LÀM GÌ
--   Dòng C4 ghi bù = nguồn BACKFILL (chỉ hàm ghi bù một lần của Đợt 3a ghi nguồn này), còn LINKED. Bản C3 của
--   ghi bù = bản do CHÍNH hàm ghi bù tạo (sự kiện SALARY_FROZEN payload.source = BACKFILL), còn FROZEN; bản C3
--   có từ trước mà ghi bù chỉ gắn vào thì giữ nguyên.
--   0. Dừng (không ghi gì) khi: ghi bù đã THAY một bản C3 có từ trước (payload.voided_settlement_id — C3 chỉ
--      FROZEN → VOID nên bản lùi không dựng lại được bản cũ) ⇒ R2_C3_THAY; bản C3 của ghi bù đang được dòng
--      phiếu lương KHÁC (không phải ghi bù, chưa VOID) dùng ⇒ R2_C3_DUNG_CHUNG; không có tài khoản chủ ⇒ R2_ACTOR.
--   1. C4 LINKED không có chuyển hợp lệ sang VOID ⇒ tắt ĐÍCH DANH a00_profit_ledger_salary_lines_guard trong
--      giao dịch, LINKED → VOID (salary_voucher_id = NULL, voided_at, void_reason), bật lại ngay. ALTER TABLE
--      giữ SHARE ROW EXCLUSIVE tới COMMIT: không phiên nào thấy trigger ở trạng thái tắt.
--   2. C3 của ghi bù FROZEN → VOID (chuyển hợp lệ, trigger vẫn bật).
--   3. Nhật ký C5 SALARY_VOIDED (actor = tài khoản chủ TENANT_OWNER kích hoạt sớm nhất, như D3a): một dòng mỗi
--      dòng C4; bản C3 bị huỷ mà không dòng C4 nào trong lượt này trỏ tới cũng có một dòng.
--   4. Hậu kiểm: không còn dòng BACKFILL LINKED; đúng các dòng / bản đã chọn thành VOID; trigger bật lại ('O');
--      policy / RLS / trigger của bảng C4 không đổi (event trigger chạy sau mỗi ALTER TABLE); số dư KHÔNG mốc
--      của từng cổ đông tăng đúng Σ(phần đầu tư − phần trừ tạm ứng) của các dòng có phiếu lương còn sống.
--
-- AN TOÀN CHẠY LẠI: không còn dòng ghi bù LINKED / bản C3 của ghi bù FROZEN ⇒ bỏ qua, không ghi gì (không tắt
--   trigger). Công ty thật vắng (Restore Drill) ⇒ bỏ qua như D3a/D3b.
-- THỨ TỰ lùi toàn phần: R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1; R6 LUÔN trước R1 — xem runbook.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $r2$
DECLARE
  c_org   constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa  constant text := 'shareholder_profit.ledger_payout.v1';
  c_ly_do constant text := 'R2 (bản lùi Đợt 3a): huỷ dòng ghi bù lương của migration 20261115113530';
  v_actor uuid;
  v_dong  jsonb;
  v_c3    uuid[];
  v_n     integer;
  v_lech  text;
  v_so_du_truoc  jsonb;
  v_bao_ve_truoc text;
  v_bao_ve_sau   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c_org) THEN
    RAISE NOTICE 'R2: không có công ty thật (database dùng một lần) — bỏ qua';
    RETURN;
  END IF;
  -- Thứ tự khoá G v2: công ty trước.
  IF app_private.lock_org_for_decision_v1(c_org) IS NULL THEN
    RAISE EXCEPTION 'R2_ORG: công ty không còn hoạt động' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', l.id, 'voucher', l.salary_voucher_id, 'settlement', l.settlement_id, 'sh', l.shareholder_id,
           'ky', l.period_month, 'y', l.investment_amount, 'd', l.advance_offset_amount,
           'song', app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)) ORDER BY l.id), '[]'::jsonb)
    INTO v_dong
    FROM app_private.profit_ledger_salary_settlement_vouchers l
   WHERE l.organization_id = c_org AND l.source = 'BACKFILL' AND l.state = 'LINKED';
  SELECT COALESCE(array_agg(DISTINCT c.id ORDER BY c.id), '{}'::uuid[])
    INTO v_c3
    FROM app_private.profit_ledger_events e
    JOIN app_private.profit_ledger_salary_settlements c ON c.id = e.settlement_id
   WHERE e.organization_id = c_org AND e.event_kind = 'SALARY_FROZEN' AND e.payload ->> 'source' = 'BACKFILL'
     AND c.state = 'FROZEN';

  IF jsonb_array_length(v_dong) = 0 AND cardinality(v_c3) = 0 THEN
    RAISE NOTICE 'R2: không còn dòng ghi bù LINKED hay bản đóng băng của ghi bù — bỏ qua';
    RETURN;
  END IF;
  -- Theo CHẾ ĐỘ chứ không theo route: ON đang đóng băng (sau R7a, trước R7b) vẫn chặn — R7c sẽ đưa về CANONICAL.
  IF (SELECT f.mode FROM app_private.server_feature_flags f WHERE f.feature_key = c_khoa) IN ('ON', 'CANARY') THEN
    RAISE EXCEPTION 'R2_ROUTE: công tắc còn ON (kể cả khi đang đóng băng) — chạy R7b (về SHADOW) trước: huỷ ghi bù khi còn chi theo sổ tổng làm số dư được phép chi nhảy lên'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM app_private.profit_ledger_events e
              WHERE e.organization_id = c_org AND e.event_kind = 'SALARY_FROZEN' AND e.payload ->> 'source' = 'BACKFILL'
                AND e.settlement_id = ANY (v_c3) AND e.payload ->> 'voided_settlement_id' IS NOT NULL) THEN
    RAISE EXCEPTION 'R2_C3_THAY: ghi bù đã thay một bản đóng băng lương có từ trước — bản lùi không dựng lại được bản cũ; xử lý tay'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.profit_ledger_salary_settlement_vouchers l
              WHERE l.settlement_id = ANY (v_c3) AND l.source <> 'BACKFILL' AND l.state <> 'VOID') THEN
    RAISE EXCEPTION 'R2_C3_DUNG_CHUNG: bản đóng băng lương của ghi bù đang được dòng phiếu lương khác dùng — xử lý tay'
      USING ERRCODE = '55000';
  END IF;

  SELECT m.user_id INTO v_actor
    FROM public.organization_memberships m
    JOIN public.role_bindings rb ON rb.membership_id = m.id
    JOIN public.organization_roles vai ON vai.id = rb.role_id AND vai.organization_id = m.organization_id
   WHERE m.organization_id = c_org
     AND m.status = 'ACTIVE'
     AND m.activated_at IS NOT NULL
     AND (m.valid_to IS NULL OR m.valid_to > now())
     AND (rb.valid_from IS NULL OR rb.valid_from <= now())
     AND (rb.valid_to IS NULL OR rb.valid_to > now())
     AND vai.system_key = 'TENANT_OWNER'
     AND vai.status = 'ACTIVE'
   ORDER BY m.activated_at, m.user_id
   LIMIT 1;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'R2_ACTOR: không tìm thấy tài khoản chủ (vai TENANT_OWNER, đã kích hoạt)' USING ERRCODE = '55000';
  END IF;

  -- Ảnh chụp trước: số dư KHÔNG mốc của từng cổ đông có dòng bị huỷ; chốt bảo vệ của bảng C4.
  SELECT COALESCE(jsonb_object_agg(s.sh::text,
           (app_private.profit_ledger_balance_core_v1(c_org, 'SHAREHOLDER', s.sh, NULL, NULL, NULL) ->> 'balance')::numeric), '{}'::jsonb)
    INTO v_so_du_truoc
    FROM (SELECT DISTINCT (x ->> 'sh')::uuid AS sh FROM jsonb_array_elements(v_dong) x) s;
  SELECT md5(concat_ws('#',
           (SELECT string_agg(concat_ws('|', p.polname, p.polcmd::text, p.polpermissive::text, p.polroles::text,
                                        pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)),
                              ',' ORDER BY p.polname)
              FROM pg_policy p WHERE p.polrelid = 'app_private.profit_ledger_salary_settlement_vouchers'::regclass),
           (SELECT c.relrowsecurity::text || c.relforcerowsecurity::text FROM pg_class c
             WHERE c.oid = 'app_private.profit_ledger_salary_settlement_vouchers'::regclass),
           (SELECT string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::text, ',' ORDER BY t.tgname)
              FROM pg_trigger t
             WHERE t.tgrelid = 'app_private.profit_ledger_salary_settlement_vouchers'::regclass AND NOT t.tgisinternal)))
    INTO v_bao_ve_truoc;

  IF jsonb_array_length(v_dong) > 0 THEN
    ALTER TABLE app_private.profit_ledger_salary_settlement_vouchers DISABLE TRIGGER a00_profit_ledger_salary_lines_guard;
    UPDATE app_private.profit_ledger_salary_settlement_vouchers
       SET state = 'VOID', salary_voucher_id = NULL, voided_at = clock_timestamp(), void_reason = c_ly_do
     WHERE id IN (SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(v_dong) x)
       AND state = 'LINKED' AND source = 'BACKFILL';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    ALTER TABLE app_private.profit_ledger_salary_settlement_vouchers ENABLE TRIGGER a00_profit_ledger_salary_lines_guard;
    IF v_n <> jsonb_array_length(v_dong) THEN
      RAISE EXCEPTION 'R2_SAU: huỷ % dòng ghi bù, phải là %', v_n, jsonb_array_length(v_dong) USING ERRCODE = '55000';
    END IF;
  END IF;

  UPDATE app_private.profit_ledger_salary_settlements
     SET state = 'VOID', voided_at = clock_timestamp(), void_reason = c_ly_do
   WHERE id = ANY (v_c3) AND state = 'FROZEN';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> cardinality(v_c3) THEN
    RAISE EXCEPTION 'R2_SAU: huỷ % bản đóng băng của ghi bù, phải là %', v_n, cardinality(v_c3) USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id, voucher_id,
    settlement_id, line_id, amount, actor_id, reason, payload)
  SELECT c_org, 'SALARY_VOIDED', 'SHAREHOLDER', (x ->> 'sh')::uuid, (x ->> 'voucher')::uuid, (x ->> 'settlement')::uuid,
         (x ->> 'id')::uuid, (x ->> 'y')::numeric, v_actor, c_ly_do,
         jsonb_build_object('source', 'BACKFILL', 'rollback', 'R2', 'period_month', x ->> 'ky',
                            'advance_offset_amount', (x ->> 'd')::numeric,
                            'settlement_voided', COALESCE((x ->> 'settlement')::uuid = ANY (v_c3), false))
    FROM jsonb_array_elements(v_dong) x;
  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id, settlement_id,
    amount, actor_id, reason, payload)
  SELECT c_org, 'SALARY_VOIDED', 'SHAREHOLDER', c.shareholder_id, c.id, c.investment_month, v_actor, c_ly_do,
         jsonb_build_object('source', 'BACKFILL', 'rollback', 'R2', 'period_month', c.period_month, 'settlement_only', true)
    FROM app_private.profit_ledger_salary_settlements c
   WHERE c.id = ANY (v_c3)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_dong) x WHERE (x ->> 'settlement')::uuid = c.id);

  -- Hậu kiểm.
  IF EXISTS (SELECT 1 FROM app_private.profit_ledger_salary_settlement_vouchers l
              WHERE l.organization_id = c_org AND l.source = 'BACKFILL' AND l.state = 'LINKED')
     OR EXISTS (SELECT 1 FROM app_private.profit_ledger_salary_settlement_vouchers l
                 WHERE l.id IN (SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(v_dong) x)
                   AND (l.state <> 'VOID' OR l.salary_voucher_id IS NOT NULL))
     OR EXISTS (SELECT 1 FROM app_private.profit_ledger_salary_settlements c WHERE c.id = ANY (v_c3) AND c.state <> 'VOID') THEN
    RAISE EXCEPTION 'R2_SAU: còn dòng ghi bù LINKED hoặc dòng / bản đã chọn chưa VOID' USING ERRCODE = '55000';
  END IF;
  SELECT md5(concat_ws('#',
           (SELECT string_agg(concat_ws('|', p.polname, p.polcmd::text, p.polpermissive::text, p.polroles::text,
                                        pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)),
                              ',' ORDER BY p.polname)
              FROM pg_policy p WHERE p.polrelid = 'app_private.profit_ledger_salary_settlement_vouchers'::regclass),
           (SELECT c.relrowsecurity::text || c.relforcerowsecurity::text FROM pg_class c
             WHERE c.oid = 'app_private.profit_ledger_salary_settlement_vouchers'::regclass),
           (SELECT string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::text, ',' ORDER BY t.tgname)
              FROM pg_trigger t
             WHERE t.tgrelid = 'app_private.profit_ledger_salary_settlement_vouchers'::regclass AND NOT t.tgisinternal)))
    INTO v_bao_ve_sau;
  IF v_bao_ve_sau IS DISTINCT FROM v_bao_ve_truoc
     OR (SELECT t.tgenabled FROM pg_trigger t
          WHERE t.tgrelid = 'app_private.profit_ledger_salary_settlement_vouchers'::regclass
            AND t.tgname = 'a00_profit_ledger_salary_lines_guard') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'R2_SAU: policy / RLS / trigger của bảng dòng phiếu lương đã đổi hoặc trigger chặn chưa bật lại'
      USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(md5(s.sh::text), ', ') INTO v_lech
    FROM (SELECT (x ->> 'sh')::uuid AS sh,
                 sum(CASE WHEN (x ->> 'song')::boolean THEN (x ->> 'y')::numeric - (x ->> 'd')::numeric ELSE 0 END) AS tang
            FROM jsonb_array_elements(v_dong) x GROUP BY 1) s
   WHERE (app_private.profit_ledger_balance_core_v1(c_org, 'SHAREHOLDER', s.sh, NULL, NULL, NULL) ->> 'balance')::numeric
         IS DISTINCT FROM (v_so_du_truoc ->> s.sh::text)::numeric + s.tang;
  IF v_lech IS NOT NULL THEN
    RAISE EXCEPTION 'R2_SAU: số dư không mốc của cổ đông không tăng đúng phần ghi bù đã huỷ: %', v_lech USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'R2: huỷ % dòng ghi bù và % bản đóng băng của ghi bù', jsonb_array_length(v_dong), cardinality(v_c3);
END
$r2$;

COMMIT;
