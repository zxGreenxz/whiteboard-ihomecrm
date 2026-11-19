-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — BẢN LÙI R4: bốn phiếu chia lợi nhuận cũ về "KQKD tự động" (lùi X3 của Đợt 3a,
-- 20261115113530).
--
-- DÙNG KHI: lùi toàn phần Đợt 3a. Không phụ thuộc công tắc (chạy được cả trước lẫn sau R1).
-- CÁCH ÁP — tệp này KHÔNG phải migration, chỉ dùng khi phải lùi; nội dung đã là migration hoàn chỉnh.
--   Runbook: docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/README.md
--   1. node scripts/tao-ten-migration.mjs so_tong_loi_nhuan_kqkd_tu_dong   (chỉ IN ra tên <timestamp>_<slug>.sql)
--   2. tạo supabase/migrations/<tên vừa in> chứa NGUYÊN VĂN tệp này → git add <tệp đó> → npm run provenance:generate
--   3. npm run migrate:forward -- <tệp>            (dry-run: lane dán HAI lượt trong một giao dịch rồi ROLLBACK)
--   4. npm run migrate:forward -- <tệp> --apply    (chỉ sau dry-run xanh)
--
-- LÀM GÌ (đối xứng X3, cùng khuôn kiểm)
--   0. Khoá công ty → khoá bốn phiếu. Bốn phiếu phải cùng ở "KQKD: không" (lượt một) hoặc đã cùng ở "KQKD: tự
--      động" (lượt hai / đã lùi) — lẫn lộn ⇒ dừng R4_TRANG_THAI (không làm nửa vời). Khi còn phải đổi KQKD: phiếu
--      phải còn đúng điều kiện như lúc X3 (sống, không bàn giao / gắn người nhận / nguồn máy, đã duyệt, đã ghi sổ,
--      sổ quỹ chưa chốt qua ngày phiếu) ⇒ không thì dừng R4_DIEU_KIEN (hỏi chủ).
--   1. Tắt ĐÍCH DANH a02_ie_profit_lock_upd, a00_ie_owned_payload_freeze trong giao dịch → business_result_accounting
--      = NULL (trigger ie_business_result tính lại KQKD và has_restricted_item) → has_restricted_item = false cho
--      hai phiếu 21/05 (đúng giá trị TRƯỚC X3; giá trị đó vốn lệch hạng mục "chia lợi nhuận" là hạng mục hạn chế —
--      chủ muốn giữ "hạn chế" thì để c_han_che_cu là mảng rỗng) → bật lại ngay.
--   2. Hậu kiểm như X3: chỉ đổi đúng các cột cho phép; KQKD tự động (kqkd_amount = total_amount, tính vào KQKD);
--      has_restricted_item đúng giá trị chọn; bút toán, số dư sổ quỹ, yêu cầu duyệt không đổi; policy / RLS /
--      trigger của income_expenses không đổi và hai khoá bật lại ('O').
--   3. Nhật ký phiếu KQKD_OVERRIDE ("KQKD: không" → "KQKD: tự động") CHỈ cho phiếu đổi trong lượt này; người ghi =
--      tài khoản chủ TENANT_OWNER kích hoạt sớm nhất (như D3a). Nhật ký X3 không xoá.
--
-- AN TOÀN CHẠY LẠI: bốn phiếu đã KQKD tự động và has_restricted_item đúng ⇒ bỏ qua, không ghi gì (không tắt
--   trigger, không thêm nhật ký). Công ty thật vắng (Restore Drill) ⇒ bỏ qua như D3a/D3b.
-- THỨ TỰ lùi toàn phần: R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1; R6 LUÔN trước R1 — xem runbook.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $r4$
DECLARE
  c_org       constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_phieu     constant uuid[] := ARRAY['2488536d-1a38-4f8e-840e-d27cb690629c',
                                       '33c8b388-079a-48d7-a7a7-ab0141b26eb8',
                                       'd66ba7f7-a7d9-4123-8ed0-4e3e53b6cd45',
                                       'e6bff80c-ec79-4073-9a8a-b7bb4256adba']::uuid[];
  -- Hai phiếu 21/05: has_restricted_item = false trước X3 (xem đầu file).
  c_han_che_cu constant uuid[] := ARRAY['d66ba7f7-a7d9-4123-8ed0-4e3e53b6cd45',
                                        'e6bff80c-ec79-4073-9a8a-b7bb4256adba']::uuid[];
  c_cot_doi   constant text[] := ARRAY['business_result_accounting', 'kqkd_amount', 'counts_in_business_result',
                                       'updated_at', 'has_restricted_item'];
  c_ly_do     constant text := 'R4 (bản lùi Đợt 3a, migration 20261115113530)';
  v_actor     uuid;
  v_co        integer;
  v_null      integer;
  v_false     integer;
  v_han_che_doi integer;
  v_doi       uuid[];
  v_truoc     jsonb;
  v_han_che   jsonb;
  v_so_quy    uuid[];
  v_tong_truoc numeric;
  v_tong_sau  numeric;
  v_but_toan_truoc jsonb;
  v_but_toan_sau jsonb;
  v_yeu_cau_truoc text;
  v_yeu_cau_sau text;
  v_bao_ve_truoc text;
  v_bao_ve_sau text;
  r           record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c_org) THEN
    RAISE NOTICE 'R4: không có công ty thật (database dùng một lần) — bỏ qua';
    RETURN;
  END IF;
  -- Thứ tự khoá G v2: công ty trước, rồi bốn phiếu theo id.
  IF app_private.lock_org_for_decision_v1(c_org) IS NULL THEN
    RAISE EXCEPTION 'R4_ORG: công ty không còn hoạt động' USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu) ORDER BY ie.id FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE ie.business_result_accounting IS NULL),
         count(*) FILTER (WHERE ie.business_result_accounting IS FALSE),
         count(*) FILTER (WHERE ie.id = ANY (c_han_che_cu) AND ie.has_restricted_item)
    INTO v_co, v_null, v_false, v_han_che_doi
    FROM public.income_expenses ie
   WHERE ie.id = ANY (c_phieu) AND ie.organization_id = c_org;
  IF v_co <> cardinality(c_phieu) THEN
    RAISE EXCEPTION 'R4_PHIEU: chỉ thấy % / % phiếu chia lợi nhuận cũ của công ty', v_co, cardinality(c_phieu)
      USING ERRCODE = '55000';
  END IF;
  IF v_null = v_co AND v_han_che_doi = 0 THEN
    IF EXISTS (SELECT 1 FROM public.income_expenses ie
                WHERE ie.id = ANY (c_phieu) AND (ie.kqkd_amount <> ie.total_amount OR NOT ie.counts_in_business_result)) THEN
      RAISE EXCEPTION 'R4_SAU: bốn phiếu đã KQKD tự động nhưng số KQKD chưa khớp tiền phiếu' USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'R4: bốn phiếu đã ở KQKD tự động — bỏ qua';
    RETURN;
  END IF;
  IF v_null <> v_co AND v_false <> v_co THEN
    RAISE EXCEPTION 'R4_TRANG_THAI: bốn phiếu không cùng trạng thái KQKD (tự động %, không %) — không làm nửa vời, kiểm tay',
      v_null, v_false USING ERRCODE = '55000';
  END IF;
  IF v_false = v_co AND EXISTS (
    SELECT 1 FROM public.income_expenses ie
     WHERE ie.id = ANY (c_phieu)
       AND (ie.deleted_at IS NOT NULL OR ie.handover_id IS NOT NULL OR ie.shareholder_id IS NOT NULL
            OR ie.profit_manager_id IS NOT NULL OR ie.system_source IS NOT NULL OR ie.type <> 'EXPENSE'
            OR ie.approval_status <> 'APPROVED' OR ie.posting_status IS DISTINCT FROM 'POSTED'
            OR COALESCE(app_private.cashbook_closed_through_v1(ie.account_id) >= ie.voucher_date, false))) THEN
    RAISE EXCEPTION 'R4_DIEU_KIEN: một phiếu không còn đúng điều kiện như lúc X3 (đã xoá / bàn giao / gắn người nhận / sổ đã chốt) — hỏi chủ'
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
    RAISE EXCEPTION 'R4_ACTOR: không tìm thấy tài khoản chủ (vai TENANT_OWNER, đã kích hoạt)' USING ERRCODE = '55000';
  END IF;

  -- Ảnh chụp trước (cùng khuôn X3).
  SELECT jsonb_object_agg(ie.id::text, to_jsonb(ie) - c_cot_doi), array_agg(DISTINCT ie.account_id)
    INTO v_truoc, v_so_quy
    FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu);
  -- has_restricted_item đích: hai phiếu c_han_che_cu ⇒ false; phiếu khác ⇒ giá trị recompute_ie_business_result tính.
  SELECT jsonb_object_agg(ie.id::text,
           CASE WHEN ie.id = ANY (c_han_che_cu) THEN false
                ELSE (SELECT COALESCE(bool_or(t.is_restricted), false)
                        FROM public.income_expense_items i
                        LEFT JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
                       WHERE i.income_expense_id = ie.id) END)
    INTO v_han_che
    FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu);
  SELECT COALESCE(sum(l.signed_amount), 0) INTO v_tong_truoc
    FROM public.income_expense_posting_lines l WHERE l.account_id = ANY (v_so_quy);
  SELECT jsonb_object_agg(x.id::text, x.n) INTO v_but_toan_truoc
    FROM (SELECT ie.id, (SELECT count(*) FROM public.income_expense_postings p WHERE p.voucher_id = ie.id) AS n
            FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu)) x;
  SELECT md5(COALESCE(string_agg(to_jsonb(ar)::text, ',' ORDER BY ar.id), '')) INTO v_yeu_cau_truoc
    FROM public.approval_requests ar WHERE ar.subject_type = 'FINANCIAL_VOUCHER' AND ar.subject_id = ANY (c_phieu);
  SELECT md5(concat_ws('#',
           (SELECT string_agg(concat_ws('|', p.polname, p.polcmd::text, p.polpermissive::text, p.polroles::text,
                                        pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)),
                              ',' ORDER BY p.polname)
              FROM pg_policy p WHERE p.polrelid = 'public.income_expenses'::regclass),
           (SELECT c.relrowsecurity::text || c.relforcerowsecurity::text FROM pg_class c WHERE c.oid = 'public.income_expenses'::regclass),
           (SELECT string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::text, ',' ORDER BY t.tgname)
              FROM pg_trigger t WHERE t.tgrelid = 'public.income_expenses'::regclass AND NOT t.tgisinternal)))
    INTO v_bao_ve_truoc;

  ALTER TABLE public.income_expenses DISABLE TRIGGER a02_ie_profit_lock_upd;
  ALTER TABLE public.income_expenses DISABLE TRIGGER a00_ie_owned_payload_freeze;

  WITH doi AS (
    UPDATE public.income_expenses
       SET business_result_accounting = NULL,
           updated_at = now()
     WHERE id = ANY (c_phieu)
       AND business_result_accounting IS FALSE
    RETURNING id)
  SELECT COALESCE(array_agg(doi.id ORDER BY doi.id), '{}'::uuid[]) INTO v_doi FROM doi;
  UPDATE public.income_expenses
     SET has_restricted_item = false
   WHERE id = ANY (c_han_che_cu)
     AND has_restricted_item;

  ALTER TABLE public.income_expenses ENABLE TRIGGER a02_ie_profit_lock_upd;
  ALTER TABLE public.income_expenses ENABLE TRIGGER a00_ie_owned_payload_freeze;

  -- Hậu kiểm (sai ⇒ RAISE, cả giao dịch cuộn lại — kể cả bốn lệnh ALTER).
  IF cardinality(v_doi) <> v_false THEN
    RAISE EXCEPTION 'R4_SAU: trả % phiếu về KQKD tự động, phải là %', cardinality(v_doi), v_false USING ERRCODE = '55000';
  END IF;
  FOR r IN SELECT ie.* FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu) LOOP
    IF (to_jsonb(r) - c_cot_doi) IS DISTINCT FROM (v_truoc -> r.id::text)
       OR r.business_result_accounting IS NOT NULL
       OR r.kqkd_amount <> r.total_amount
       OR NOT r.counts_in_business_result
       OR r.has_restricted_item IS DISTINCT FROM (v_han_che ->> r.id::text)::boolean THEN
      RAISE EXCEPTION 'R4_SAU: phiếu % đổi ngoài các cột cho phép hoặc chưa về KQKD tự động', r.id USING ERRCODE = '55000';
    END IF;
  END LOOP;
  SELECT COALESCE(sum(l.signed_amount), 0) INTO v_tong_sau
    FROM public.income_expense_posting_lines l WHERE l.account_id = ANY (v_so_quy);
  SELECT jsonb_object_agg(x.id::text, x.n) INTO v_but_toan_sau
    FROM (SELECT ie.id, (SELECT count(*) FROM public.income_expense_postings p WHERE p.voucher_id = ie.id) AS n
            FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu)) x;
  SELECT md5(COALESCE(string_agg(to_jsonb(ar)::text, ',' ORDER BY ar.id), '')) INTO v_yeu_cau_sau
    FROM public.approval_requests ar WHERE ar.subject_type = 'FINANCIAL_VOUCHER' AND ar.subject_id = ANY (c_phieu);
  SELECT md5(concat_ws('#',
           (SELECT string_agg(concat_ws('|', p.polname, p.polcmd::text, p.polpermissive::text, p.polroles::text,
                                        pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)),
                              ',' ORDER BY p.polname)
              FROM pg_policy p WHERE p.polrelid = 'public.income_expenses'::regclass),
           (SELECT c.relrowsecurity::text || c.relforcerowsecurity::text FROM pg_class c WHERE c.oid = 'public.income_expenses'::regclass),
           (SELECT string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::text, ',' ORDER BY t.tgname)
              FROM pg_trigger t WHERE t.tgrelid = 'public.income_expenses'::regclass AND NOT t.tgisinternal)))
    INTO v_bao_ve_sau;
  IF v_tong_sau IS DISTINCT FROM v_tong_truoc OR v_but_toan_sau IS DISTINCT FROM v_but_toan_truoc
     OR v_yeu_cau_sau IS DISTINCT FROM v_yeu_cau_truoc THEN
    RAISE EXCEPTION 'R4_SAU: bút toán / số dư sổ quỹ / yêu cầu duyệt đã đổi' USING ERRCODE = '55000';
  END IF;
  IF v_bao_ve_sau IS DISTINCT FROM v_bao_ve_truoc
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgrelid = 'public.income_expenses'::regclass
            AND t.tgname IN ('a02_ie_profit_lock_upd', 'a00_ie_owned_payload_freeze') AND t.tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'R4_SAU: policy / RLS / trigger của income_expenses đã đổi hoặc hai khoá chưa bật lại đúng' USING ERRCODE = '55000';
  END IF;

  FOR r IN SELECT x.id FROM unnest(v_doi) AS x(id) ORDER BY x.id LOOP
    PERFORM app_private.append_income_expense_event_v1(
      c_org, r.id, 'KQKD_OVERRIDE', v_actor, c_ly_do, 'KQKD: không', 'KQKD: tự động',
      'R4: lùi Đợt 3a — phiếu chia lợi nhuận cũ về KQKD tự động'
        || CASE WHEN r.id = ANY (c_han_che_cu) THEN '; hạng mục hạn chế về như trước X3' ELSE '' END);
  END LOOP;
  RAISE NOTICE 'R4: % phiếu về KQKD tự động, % phiếu trả has_restricted_item về false', cardinality(v_doi), v_han_che_doi;
END
$r4$;

COMMIT;
