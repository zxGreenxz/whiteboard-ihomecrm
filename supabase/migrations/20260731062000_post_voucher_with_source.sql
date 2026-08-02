-- =====================================================================
-- Đợt 1 — LÕI GHI SỔ DÙNG CHUNG, source-aware: MAIN + CHANGE + ROUNDING
-- kèm CHỐT KỲ nằm BÊN TRONG hàm.
--
-- VÌ SAO CÓ FILE NÀY: hôm nay mỗi adapter tự chép lại công thức ghi sổ.
-- `app_private.post_collection_tender_v2` là bản làm ĐÚNG (MAIN/CHANGE/ROUNDING,
-- net_cash_effect cộng đủ ba vế, replay theo external source). Hai plan sắp thêm
-- năm adapter nữa; nếu mỗi cái tự chép thì chỗ nào quên cộng CHANGE là lệch quỹ
-- âm thầm. File này rút phần chung ra MỘT chỗ để các adapter gọi lại.
--
-- ⚠ ROUTE OFF: hàm này ra đời với **0 caller**. Không adapter nào gọi cho tới
-- Đợt 5. Nó KHÔNG thể tự sinh bút toán, và KHÔNG đụng một dòng dữ liệu nào đang
-- có. Đó là lý do apply được ngay mà không cần canary.
--
-- ĐO TRƯỚC KHI VIẾT (không suy luận từ file):
--   • `income_expense_posting_lines.line_kind` CHECK IN ('MAIN','CHANGE','ROUNDING','REVERSAL')
--     và `signed_amount <> 0` ⇒ TUYỆT ĐỐI không được ghi dòng 0đ, phải bỏ qua.
--   • `income_expense_postings.gross_amount > 0` ⇒ không post phiếu 0đ.
--   • `posting_subject_kind IN ('VOUCHER','SALARY_TRANCHE')` và CHECK
--     `posting_subject_kind <> 'VOUCHER' OR voucher_id = posting_subject_id`.
--   • Ba unique index quyết định ngữ nghĩa replay:
--       ux_ie_postings_external_source (org, ext_kind, ext_id, ext_line_id, event_kind)
--         WHERE ext_kind IS NOT NULL
--         ⚠ ĐÍNH CHÍNH (review bắt): index này KHÔNG gác được khi ext_line_id NULL —
--         btree mặc định coi NULL là KHÁC NULL, nên hai dòng (org,K,X,NULL,'POSTING')
--         không đụng nhau. Khoá replay THẬT là ux_ie_postings_org_idempotency, vì
--         v_idem đã COALESCE(line,'-'). Đừng đổi công thức v_idem mà không hiểu điều này.
--       ux_ie_postings_org_idempotency  (org, idempotency_key)
--       ux_ie_postings_subject_generation (org, subject_kind, subject_id, generation)
--         WHERE event_kind='POSTING'      ← MỘT posting sống / một phiếu / một thế hệ
--   • Hàm chốt kỳ đã có, và NẰM Ở `app_private` — KHÔNG phải `public`:
--       app_private.finance_v2_is_cashbook_period_open(org, cashbook, posted_on)
--       app_private.finance_v2_is_recognition_period_open(org, period)
--     ⚠ Bản đầu của file này viết `public.` ở CẢ BỐN chỗ (2 preflight + 2 thân
--     hàm). Hậu quả: preflight RAISE ⇒ rollback, hàm không bao giờ ra đời; và nếu
--     ai gỡ preflight cho "qua cửa" thì thân hàm ném 42883 ở MỌI lời gọi vì tên
--     đã qualify cứng nên search_path không cứu được. Review đối kháng bắt được,
--     hai lượt phản biện đều không bác nổi. Tự kiểm ở cuối file nay phải soi
--     TÊN CÓ SCHEMA, không so chuỗi trần (so trần khớp luôn cả tên sai schema).
--
-- KHÔNG ĐỤNG TIỀN: chỉ CREATE một hàm mới, 0 caller. Không sửa writer nào đang chạy.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('app_private.post_collection_tender_v2(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu post_collection_tender_v2 — khuôn tham chiếu không còn. DỪNG, không vá mù.';
  END IF;
  IF to_regprocedure('app_private.finance_v2_is_cashbook_period_open(uuid,uuid,date)') IS NULL
     OR to_regprocedure('app_private.finance_v2_is_recognition_period_open(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm chốt kỳ — không dựng được backstop. DỪNG.';
  END IF;
  -- Ba unique index phải còn, vì ngữ nghĩa replay của hàm dựa vào chúng.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='income_expense_postings'
                   AND indexname='ux_ie_postings_external_source') THEN
    RAISE EXCEPTION 'Thiếu ux_ie_postings_external_source — replay theo nguồn sẽ vỡ. DỪNG.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='income_expense_postings'
                   AND indexname='ux_ie_postings_subject_generation') THEN
    RAISE EXCEPTION 'Thiếu ux_ie_postings_subject_generation. DỪNG.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION app_private.finance_v2_post_voucher_with_source_v1(
  p_org             uuid,
  p_voucher_id      uuid,
  p_source_kind     text,          -- nhãn adapter, vd 'SPECIAL_FEE_V1'
  p_external_kind   text,          -- họ nguồn ngoài, vd 'SPECIAL_FEE'
  p_external_id     uuid,          -- id nguồn ngoài
  p_external_line_id uuid DEFAULT NULL,
  p_posted_on       date  DEFAULT NULL,   -- NULL ⇒ voucher_date của phiếu
  p_amount_basis    text  DEFAULT 'VOUCHER_TOTAL',
  p_generation      bigint DEFAULT 1
)
 RETURNS uuid
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_ie        public.income_expenses;
  v_posting   uuid;
  v_signed    numeric(18,2);
  v_change    numeric(18,2);
  v_round     numeric(18,2);
  v_posted_on date;
  v_mid       uuid;
  v_idem      text;
BEGIN
  IF p_org IS NULL OR p_voucher_id IS NULL THEN
    RAISE EXCEPTION 'post_voucher_with_source: thiếu org hoặc voucher' USING ERRCODE = '22023';
  END IF;
  IF p_external_kind IS NULL OR p_external_id IS NULL THEN
    -- Không cho ghi sổ "không rõ nguồn": khoá replay dựa vào bộ ba này, thiếu là
    -- mất luôn khả năng chống ghi hai lần.
    RAISE EXCEPTION 'post_voucher_with_source: thiếu external_kind/external_id — không có khoá replay'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(p_source_kind),'') = '' THEN
    RAISE EXCEPTION 'post_voucher_with_source: thiếu source_kind' USING ERRCODE = '22023';
  END IF;
  -- `amount_basis` có CHECK ba giá trị. Không kiểm ở đây thì adapter truyền nhãn
  -- riêng (rất tự nhiên vì tham số mở) sẽ chết bằng 23514 kèm nguyên văn constraint
  -- — đúng loại thông điệp mà file này tuyên bố muốn tránh.
  IF p_amount_basis NOT IN ('VOUCHER_TOTAL','EXTERNAL_TENDER_GROSS','SALARY_TRANCHE_CASH') THEN
    RAISE EXCEPTION
      'post_voucher_with_source: amount_basis % không hợp lệ (chỉ nhận VOUCHER_TOTAL, EXTERNAL_TENDER_GROSS, SALARY_TRANCHE_CASH)',
      p_amount_basis USING ERRCODE = '22023';
  END IF;

  -- Khoá phiếu trước khi đọc: hai adapter cùng post một phiếu phải xếp hàng.
  SELECT * INTO v_ie FROM public.income_expenses WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_voucher_with_source: không thấy phiếu %', p_voucher_id USING ERRCODE = 'P0002';
  END IF;
  IF v_ie.organization_id IS DISTINCT FROM p_org THEN
    -- Chặn ghi chéo tổ chức. Không có mệnh đề này thì adapter truyền nhầm org là
    -- bút toán rơi sang tenant khác.
    RAISE EXCEPTION 'post_voucher_with_source: phiếu % không thuộc org %', p_voucher_id, p_org
      USING ERRCODE = '42501';
  END IF;
  IF v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'post_voucher_with_source: phiếu % đã huỷ', p_voucher_id USING ERRCODE = '55000';
  END IF;
  -- Bản đầu CHỈ soi deleted_at ⇒ lõi chịu ghi sổ cho cả phiếu CANCELLED lẫn phiếu
  -- CHƯA DUYỆT (review bắt; trên prod có 256 phiếu ở hai trạng thái đó). Ghi bút
  -- toán cho phiếu chưa ai duyệt là đưa tiền vào sổ trước khi có người chịu trách
  -- nhiệm; ghi cho phiếu đã huỷ là hồi sinh khoản đã bỏ. Chặn cả hai.
  IF v_ie.approval_status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION
      'post_voucher_with_source: phiếu % đang ở trạng thái % — chỉ ghi sổ phiếu ĐÃ DUYỆT',
      COALESCE(v_ie.code, p_voucher_id::text), COALESCE(v_ie.approval_status,'(rỗng)')
      USING ERRCODE = '55000';
  END IF;

  -- ══ REPLAY: đã post cho đúng nguồn này rồi thì trả lại bản cũ ═══════
  -- Kiểm TRƯỚC mọi tác dụng phụ và trước cả chốt kỳ: gọi lại lần hai không được
  -- ném lỗi "kỳ đã khoá" cho một bút toán ĐÃ tồn tại hợp lệ.
  SELECT p.id INTO v_posting
    FROM public.income_expense_postings p
   WHERE p.organization_id = p_org
     AND p.external_source_kind = p_external_kind
     AND p.external_source_id = p_external_id
     AND p.external_source_line_id IS NOT DISTINCT FROM p_external_line_id
     AND p.event_kind = 'POSTING';
  IF v_posting IS NOT NULL THEN
    RETURN v_posting;
  END IF;

  -- ══ ĐÃ CÓ POSTING KHÁC NGUỒN TRÊN CÙNG PHIẾU/THẾ HỆ? ═══════════════
  -- Bẫy thật, đo trên prod: **1.906 phiếu ĐÃ có POSTING ở generation=1**, và tất
  -- cả đều `external_source_kind IS NULL` (do cầu tự động / backfill / MANUAL
  -- sinh ra) nên phép kiểm replay ở trên KHÔNG bắt được. Không có mệnh đề này thì
  -- hàm đi tiếp, chạy backstop kỳ, tính tiền, rồi CHẾT ở
  -- ux_ie_postings_subject_generation bằng một câu 23505 thô mà adapter không
  -- hiểu — và người dùng đọc được thông điệp constraint của Postgres.
  -- KHÔNG trả về posting cũ: nó thuộc NGUỒN KHÁC, trả về là adapter tưởng nguồn
  -- của mình đã ghi sổ trong khi chưa hề.
  SELECT p.id INTO v_posting
    FROM public.income_expense_postings p
   WHERE p.organization_id = p_org
     AND p.event_kind = 'POSTING'
     AND p.posting_subject_kind = 'VOUCHER'
     AND p.posting_subject_id = p_voucher_id
     AND p.posting_generation = COALESCE(p_generation, 1);
  IF v_posting IS NOT NULL THEN
    RAISE EXCEPTION
      'Phiếu % đã được ghi sổ ở thế hệ % bởi một nguồn khác (posting %). Muốn ghi lại thì phải đảo bút toán cũ rồi tăng thế hệ, không ghi chồng.',
      COALESCE(v_ie.code, p_voucher_id::text), COALESCE(p_generation, 1), v_posting
      USING ERRCODE = '55000';
  END IF;

  v_posted_on := COALESCE(p_posted_on, v_ie.voucher_date);
  IF v_posted_on IS NULL THEN
    RAISE EXCEPTION 'post_voucher_with_source: không xác định được ngày ghi sổ' USING ERRCODE = '22023';
  END IF;

  -- ══ BACKSTOP KỲ — NẰM BÊN TRONG, không tin adapter đã kiểm ═════════
  -- Plan đòi backstop "bên trong" chính vì adapter có thể quên. Đây là hàng rào
  -- cuối trước khi bút toán rơi vào một kỳ đã chốt sổ.
  IF v_ie.account_id IS NOT NULL
     AND NOT app_private.finance_v2_is_cashbook_period_open(p_org, v_ie.account_id, v_posted_on) THEN
    RAISE EXCEPTION
      'Sổ quỹ đã chốt tới sau ngày % — không ghi sổ được. Mở lại kỳ hoặc chọn ngày khác.', v_posted_on
      USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.finance_v2_is_recognition_period_open(p_org, date_trunc('month', v_posted_on)::date) THEN
    RAISE EXCEPTION
      'Kỳ ghi nhận %/% đã khoá — không ghi sổ được.',
      to_char(v_posted_on,'MM'), to_char(v_posted_on,'YYYY')
      USING ERRCODE = '55000';
  END IF;

  -- ══ SỐ TIỀN ═══════════════════════════════════════════════════════
  IF COALESCE(v_ie.total_amount, 0) <= 0 THEN
    -- CHECK gross_amount > 0 sẽ chặn, nhưng ném lỗi rõ nghĩa ở đây tốt hơn là để
    -- người dùng đọc thông điệp constraint.
    RAISE EXCEPTION 'post_voucher_with_source: phiếu % có số tiền <= 0', p_voucher_id USING ERRCODE = '22023';
  END IF;
  v_signed := CASE WHEN v_ie.type = 'INCOME' THEN v_ie.total_amount ELSE -v_ie.total_amount END;

  -- Có số tiền mà THIẾU tài khoản đối ứng ⇒ CHẶN, không âm thầm bỏ qua.
  -- Bản đầu dùng `ELSE 0`: phiếu có change_amount 20.000 mà quên change_account_id
  -- thì net_cash_effect thiếu đúng 20.000 so với tiền mặt thật, lại KHÔNG có dòng
  -- CHANGE nào để ai đó phát hiện — phiếu vẫn POSTED "thành công". Hôm nay dữ liệu
  -- sạch (0 hàng lệch), nên đây là bẫy cho adapter mới chứ không phải nợ cũ.
  IF COALESCE(v_ie.change_amount, 0) <> 0 AND v_ie.change_account_id IS NULL THEN
    RAISE EXCEPTION
      'post_voucher_with_source: phiếu % có tiền thối %đ nhưng KHÔNG có sổ nhận tiền thối — ghi sổ sẽ lệch đúng số đó',
      COALESCE(v_ie.code, p_voucher_id::text), round(v_ie.change_amount)::bigint
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_ie.rounding_amount, 0) <> 0 AND v_ie.rounding_account_id IS NULL THEN
    RAISE EXCEPTION
      'post_voucher_with_source: phiếu % có làm tròn %đ nhưng KHÔNG có sổ nhận làm tròn',
      COALESCE(v_ie.code, p_voucher_id::text), round(v_ie.rounding_amount)::bigint
      USING ERRCODE = '22023';
  END IF;

  v_change := CASE WHEN v_ie.change_account_id IS NOT NULL THEN COALESCE(v_ie.change_amount, 0) ELSE 0 END;
  v_round  := CASE WHEN v_ie.rounding_account_id IS NOT NULL THEN COALESCE(v_ie.rounding_amount, 0) ELSE 0 END;

  SELECT om.id INTO v_mid
    FROM public.organization_memberships om
   WHERE om.organization_id = p_org
     AND om.user_id = COALESCE(v_ie.approved_by, v_ie.user_id)
     AND om.status = 'ACTIVE'
   ORDER BY om.activated_at NULLS LAST, om.id
   LIMIT 1;

  v_posting := gen_random_uuid();
  v_idem := 'fin_v2:src:' || p_external_kind || ':' || p_external_id::text
            || ':' || COALESCE(p_external_line_id::text, '-');

  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_version, event_kind, idempotency_key, source_kind,
    external_source_kind, external_source_id, external_source_line_id,
    posting_generation, created_at
  ) VALUES (
    v_posting, p_org, v_ie.id, 'VOUCHER', v_ie.id,
    v_ie.type, v_ie.account_id, v_ie.total_amount, v_ie.total_amount, p_amount_basis,
    -- net_cash_effect PHẢI cộng đủ ba vế. Đây chính là chỗ mà mỗi adapter tự chép
    -- lại rồi quên một vế ⇒ tồn quỹ lệch âm thầm. Rút về đây để chỉ còn một bản.
    v_signed + v_change + v_round,
    v_posted_on, COALESCE(v_mid, v_ie.maker_membership_id), COALESCE(v_ie.approved_by, v_ie.user_id),
    COALESCE(v_ie.approval_version, 1), 'POSTING', v_idem, p_source_kind,
    p_external_kind, p_external_id, p_external_line_id,
    COALESCE(p_generation, 1), now()
  );

  -- MAIN luôn có (đã chặn total_amount <= 0 ở trên).
  INSERT INTO public.income_expense_posting_lines
    (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
  VALUES (gen_random_uuid(), p_org, v_posting, v_ie.account_id, 'MAIN', v_signed, now());

  -- CHANGE / ROUNDING chỉ ghi khi KHÁC 0: CHECK signed_amount <> 0 sẽ nổ nếu ghi 0đ.
  IF v_change <> 0 THEN
    INSERT INTO public.income_expense_posting_lines
      (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
    VALUES (gen_random_uuid(), p_org, v_posting, v_ie.change_account_id, 'CHANGE', v_change, now());
  END IF;
  IF v_round <> 0 THEN
    INSERT INTO public.income_expense_posting_lines
      (id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at)
    VALUES (gen_random_uuid(), p_org, v_posting, v_ie.rounding_account_id, 'ROUNDING', v_round, now());
  END IF;

  RETURN v_posting;
END;
$function$;

-- Lõi nội bộ: CHỈ adapter SECURITY DEFINER được gọi. KHÔNG cấp cho client —
-- authenticated mà gọi thẳng được thì thành đường sinh bút toán tuỳ ý.
REVOKE ALL ON FUNCTION app_private.finance_v2_post_voucher_with_source_v1(
  uuid,uuid,text,text,uuid,uuid,date,text,bigint) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION app_private.finance_v2_post_voucher_with_source_v1(
  uuid,uuid,text,text,uuid,uuid,date,text,bigint) IS
  'Đợt 1: lõi ghi sổ DÙNG CHUNG cho các adapter — MAIN + CHANGE + ROUNDING, '
  'net_cash_effect cộng đủ ba vế (chỗ mà mỗi adapter tự chép rồi quên một vế là '
  'lệch quỹ âm thầm), replay theo (org, external_kind, external_id, line_id) và '
  'CHỐT KỲ nằm BÊN TRONG (không tin adapter đã kiểm). Chặn ghi chéo org, chặn '
  'phiếu đã huỷ, chặn phiếu <= 0đ, bỏ qua dòng CHANGE/ROUNDING bằng 0 (CHECK '
  'signed_amount <> 0). Ra đời với 0 CALLER — route OFF tới Đợt 5. KHÔNG cấp '
  'EXECUTE cho authenticated: gọi được thẳng là đường sinh bút toán tuỳ ý.';

DO $selfcheck$
DECLARE v_code text;
BEGIN
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app_private' AND p.proname='finance_v2_post_voucher_with_source_v1';

  IF position('for update' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Lõi ghi sổ không khoá phiếu FOR UPDATE. DỪNG.';
  END IF;
  -- Soi TÊN CÓ SCHEMA. Bản đầu so chuỗi trần 'finance_v2_is_cashbook_period_open'
  -- nên khớp luôn cả 'public.finance_v2_...' — tức phép kiểm này ĐỖ trong khi hàm
  -- gọi sai schema và chết 42883 ở mọi lời gọi. Đúng loại an toàn giả.
  IF position('app_private.finance_v2_is_cashbook_period_open' IN v_code) = 0
     OR position('app_private.finance_v2_is_recognition_period_open' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Backstop chốt kỳ không gọi đúng app_private.* — sẽ ném 42883. DỪNG.';
  END IF;
  IF position('public.finance_v2_is_' IN v_code) > 0 THEN
    RAISE EXCEPTION 'Còn gọi public.finance_v2_is_* — hai hàm đó nằm ở app_private. DỪNG.';
  END IF;
  -- Hai hàm phải THẬT SỰ phân giải được, không chỉ đúng chính tả.
  IF to_regprocedure('app_private.finance_v2_is_cashbook_period_open(uuid,uuid,date)') IS NULL
     OR to_regprocedure('app_private.finance_v2_is_recognition_period_open(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Hàm chốt kỳ không phân giải được. DỪNG.';
  END IF;
  -- Phải chặn phiếu chưa duyệt / đã huỷ.
  IF position('approval_status is distinct from ''approved''' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Lõi không chặn phiếu chưa duyệt. DỪNG.';
  END IF;
  IF position('''main''' IN v_code) = 0 OR position('''change''' IN v_code) = 0
     OR position('''rounding''' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Lõi thiếu một trong ba dòng MAIN/CHANGE/ROUNDING. DỪNG.';
  END IF;
  -- Replay phải kiểm TRƯỚC backstop kỳ (gọi lại lần hai không được ném "kỳ đã khoá").
  -- ⚠ position() trả 0 khi KHÔNG tìm thấy, mà `0 > N` luôn FALSE — nên bản đầu của
  -- phép kiểm này ĐỖ ngay cả khi cái kim đã biến mất (chỉ cần ai xuống dòng lại vị
  -- ngữ replay). Bắt buộc phải khẳng định CẢ HAI kim tồn tại trước khi so vị trí.
  IF position('external_source_kind = p_external_kind' IN v_code) = 0
     OR position('app_private.finance_v2_is_cashbook_period_open' IN v_code) = 0
     OR position('external_source_kind = p_external_kind' IN v_code)
        > position('app_private.finance_v2_is_cashbook_period_open' IN v_code) THEN
    RAISE EXCEPTION 'Kiểm replay thiếu hoặc nằm SAU backstop kỳ — gọi lại sẽ ném lỗi oan. DỪNG.';
  END IF;
  -- Phải chặn "phiếu đã có POSTING ở thế hệ này bởi nguồn khác" TRƯỚC khi INSERT,
  -- kẻo chết bằng 23505 thô của ux_ie_postings_subject_generation (1.906 phiếu
  -- trên prod đã có POSTING gen=1 với external_source_kind NULL).
  IF position('posting_generation = coalesce(p_generation' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Thiếu chốt chặn posting cùng phiếu/thế hệ — sẽ chết bằng 23505 thô. DỪNG.';
  END IF;
  -- Không được cấp cho client.
  IF has_function_privilege('authenticated',
       'app_private.finance_v2_post_voucher_with_source_v1(uuid,uuid,text,text,uuid,uuid,date,text,bigint)','EXECUTE')
     OR has_function_privilege('anon',
       'app_private.finance_v2_post_voucher_with_source_v1(uuid,uuid,text,text,uuid,uuid,date,text,bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'Lõi ghi sổ đang gọi được từ client — REVOKE. DỪNG.';
  END IF;
  -- ROUTE OFF: phải đúng 0 caller lúc ra đời.
  -- Phải BỎ COMMENT trước khi so, kẻo một dòng ghi chú vô hại kiểu
  -- "-- TODO: chuyển sang finance_v2_post_voucher_with_source_v1" trong thân hàm
  -- khác cũng làm migration abort (repo này chú thích rất dày).
  -- Và chỉ cảnh báo, KHÔNG chặn: khi Đợt 5 thêm adapter thật thì file này vẫn phải
  -- chạy lại được để vá lõi — bản đầu RAISE ở đây tự khoá đường quay lại của chính mình.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname IN ('public','app_private') AND p.prokind='f'
       AND p.proname <> 'finance_v2_post_voucher_with_source_v1'
       AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
           ILIKE '%finance_v2_post_voucher_with_source_v1%'
  ) THEN
    RAISE WARNING 'Lõi ĐÃ CÓ caller — đây không còn là trạng thái route OFF của Đợt 1.';
  END IF;
END
$selfcheck$;

COMMIT;
