-- =====================================================================
-- Đợt 1 · Step 2c — MỘT nguồn sự thật cho "hợp đồng này đang giữ bao nhiêu cọc"
--
-- Plan ghi: "Broker và Plan 2 BẮT BUỘC reuse helper này, không sao chép công thức."
-- Lý do: cọc là chỗ dễ tính sai nhất trong hệ, vì có BỐN loại dòng tiền trộn lẫn
-- và một loại KHÔNG PHẢI TIỀN MẶT.
--
-- ĐO TRÊN PROD 30/07/2026 (nền của mọi quy tắc dưới đây):
--   VÀO  (INCOME, hạng mục có chữ "cọc"):
--     contract.deposit            287 phiếu — **243 nằm trên SỔ ẢO**, chỉ 33 POSTED
--     NULL                        187 phiếu — 161 đã CANCELLED
--     invoice.payment              11 · termination.forfeit_revenue 9 (9 ảo)
--     backfill.initial_deposit      8 (8 ảo) · deposit.reservation 5
--     invoice.collection.v5         3 · contract.create.v2 1
--   RA   (EXPENSE, hạng mục có chữ "cọc"):
--     termination.refund           13 · termination.offset 13
--     termination.forfeit_offset    9 (9 ảo) · NULL 6
--
-- ⚠ ĐIỀU QUAN TRỌNG NHẤT: **243/287 phiếu cọc lớn nhất nằm trên SỔ ẢO.** Đó là
--   đợt backfill cọc đầu kỳ 28/07 (231 phiếu ~998,44 triệu) — ghi nhận cho đủ sổ
--   sách, **sổ quỹ thật KHÔNG hề đổi**. Ai cộng thẳng chúng vào "tiền đang giữ" sẽ
--   tưởng két có gần một tỉ không có thật. Vì vậy hàm này tách BA rổ, và
--   `netHeld` **chỉ** gồm tiền thật.
--
-- BỐN QUY TẮC:
--   1. realPostedIn        — INCOME cọc, POSTED, sổ THẬT (không ảo) ⇒ tiền đã vào két
--   2. postedReleaseOut    — EXPENSE cọc, POSTED, sổ THẬT ⇒ tiền đã ra khỏi két
--   3. recognizedHistoricalIn — cọc trên SỔ ẢO ⇒ ghi nhận, KHÔNG BAO GIỜ thành tiền
--   4. huỷ / xoá / đảo     — KHÔNG tính vào rổ nào
--   netHeld = realPostedIn − postedReleaseOut   (cố ý KHÔNG cộng rổ 3)
--
-- KHÔNG ĐỤNG TIỀN: chỉ CREATE hàm đọc. Không DML.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.nrm_vn(text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu nrm_vn — không nhận diện được hạng mục cọc. DỪNG.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='accounts' AND column_name='is_virtual') THEN
    RAISE EXCEPTION 'Thiếu accounts.is_virtual — không tách được rổ ghi nhận. DỪNG.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='income_expenses'
                    AND column_name='posting_status') THEN
    RAISE EXCEPTION 'Thiếu income_expenses.posting_status. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Các DÒNG NGUỒN, có thứ tự ổn định. Preview và submit dùng CHUNG hàm này.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.contract_deposit_sources_v1(
  p_organization_id uuid,
  p_contract_id     uuid,
  p_as_of           timestamptz DEFAULT now()
)
 RETURNS TABLE (
   voucher_id     uuid,
   code           text,
   direction      text,        -- IN | OUT
   bucket         text,        -- REAL_CASH | RECOGNIZED_HISTORICAL | EXCLUDED
   exclude_reason text,
   amount         numeric,
   signed_amount  numeric,     -- + vào, − ra; 0 nếu EXCLUDED
   account_id     uuid,
   is_virtual     boolean,
   system_source  text,
   voucher_date   date,
   created_at     timestamptz
 )
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT ie.id, ie.code,
         CASE WHEN ie.type = 'INCOME' THEN 'IN' ELSE 'OUT' END,
         CASE
           WHEN ie.deleted_at IS NOT NULL              THEN 'EXCLUDED'
           WHEN ie.approval_status = 'CANCELLED'       THEN 'EXCLUDED'
           WHEN ie.approval_status <> 'APPROVED'       THEN 'EXCLUDED'
           WHEN ie.posting_status = 'REVERSED'         THEN 'EXCLUDED'
           WHEN COALESCE(a.is_virtual, false)          THEN 'RECOGNIZED_HISTORICAL'
           WHEN ie.posting_status = 'POSTED'           THEN 'REAL_CASH'
           ELSE 'EXCLUDED'
         END,
         CASE
           WHEN ie.deleted_at IS NOT NULL        THEN 'đã xoá'
           WHEN ie.approval_status = 'CANCELLED' THEN 'đã huỷ'
           WHEN ie.approval_status <> 'APPROVED' THEN 'chưa duyệt'
           WHEN ie.posting_status = 'REVERSED'   THEN 'đã đảo bút toán'
           WHEN COALESCE(a.is_virtual,false)     THEN NULL
           WHEN ie.posting_status <> 'POSTED'    THEN 'chưa ghi sổ'
           ELSE NULL
         END,
         ie.total_amount,
         CASE
           WHEN ie.deleted_at IS NOT NULL
             OR ie.approval_status = 'CANCELLED'
             OR ie.approval_status <> 'APPROVED'
             OR ie.posting_status = 'REVERSED'
             OR (NOT COALESCE(a.is_virtual,false) AND ie.posting_status <> 'POSTED')
           THEN 0
           WHEN ie.type = 'INCOME' THEN ie.total_amount
           ELSE -ie.total_amount
         END,
         ie.account_id, COALESCE(a.is_virtual, false), ie.system_source,
         ie.voucher_date, ie.created_at
    FROM public.income_expenses ie
    LEFT JOIN public.accounts a ON a.id = ie.account_id
   WHERE ie.organization_id = p_organization_id
     AND ie.contract_id = p_contract_id
     AND ie.created_at <= p_as_of
     -- Hạng mục CỌC. Nhận theo TÊN LOẠI (nrm_vn) chứ không theo system_source:
     -- đo thật cho thấy cọc đến từ 12 nguồn khác nhau, kể cả NULL, nên khoá theo
     -- nguồn là bỏ sót ngay.
     AND EXISTS (
       SELECT 1 FROM public.income_expense_items it
       JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
        WHERE it.income_expense_id = ie.id
          AND public.nrm_vn(t.name) LIKE '%coc%')
   -- Thứ tự ỔN ĐỊNH: hai lần gọi phải cho cùng một danh sách.
   ORDER BY ie.created_at, ie.id;
$function$;

REVOKE ALL ON FUNCTION app_private.contract_deposit_sources_v1(uuid,uuid,timestamptz)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION app_private.contract_deposit_sources_v1(uuid,uuid,timestamptz) IS
  'Các dòng nguồn cọc của một hợp đồng, đã phân rổ REAL_CASH / RECOGNIZED_HISTORICAL '
  '/ EXCLUDED kèm lý do loại. Nhận diện cọc theo TÊN LOẠI (cọc đến từ 12 nguồn khác '
  'nhau kể cả system_source NULL). Thứ tự ổn định theo (created_at, id).';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Tổng hợp + trạng thái cơ sở
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.resolve_signed_contract_deposit_basis_v1(
  p_organization_id uuid,
  p_contract_id     uuid,
  p_as_of           timestamptz DEFAULT now()
)
 RETURNS jsonb
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH s AS (
    SELECT * FROM app_private.contract_deposit_sources_v1(p_organization_id, p_contract_id, p_as_of)
  ),
  agg AS (
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE bucket='REAL_CASH' AND direction='IN'), 0)   AS real_in,
      COALESCE(SUM(amount) FILTER (WHERE bucket='REAL_CASH' AND direction='OUT'), 0)  AS real_out,
      COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END)
               FILTER (WHERE bucket='RECOGNIZED_HISTORICAL'), 0)                      AS hist_in,
      count(*) FILTER (WHERE bucket='REAL_CASH')             AS n_real,
      count(*) FILTER (WHERE bucket='RECOGNIZED_HISTORICAL') AS n_hist,
      count(*) FILTER (WHERE bucket='EXCLUDED')              AS n_excl,
      count(*)                                                AS n_all
    FROM s
  )
  SELECT jsonb_build_object(
    'organizationId',          p_organization_id,
    'contractId',              p_contract_id,
    'asOf',                    p_as_of,
    'realPostedIn',            agg.real_in,
    'postedReleaseOut',        agg.real_out,
    'recognizedHistoricalIn',  agg.hist_in,
    -- netHeld CỐ Ý không cộng rổ ghi nhận: 243/287 phiếu cọc nằm trên sổ ảo, cộng
    -- vào là báo két có gần một tỉ không có thật.
    'netHeld',                 agg.real_in - agg.real_out,
    'counts', jsonb_build_object('realCash', agg.n_real, 'recognized', agg.n_hist,
                                 'excluded', agg.n_excl, 'total', agg.n_all),
    'basisStatus',
      CASE
        WHEN agg.n_all = 0                                 THEN 'NO_SOURCE'
        WHEN agg.real_in - agg.real_out < 0                THEN 'NEGATIVE_HELD'
        WHEN agg.n_real = 0 AND agg.n_hist > 0             THEN 'RECOGNIZED_ONLY'
        ELSE 'OK'
      END,
    'basisReason',
      CASE
        WHEN agg.n_all = 0
          THEN 'Hợp đồng không có phiếu cọc nào.'
        WHEN agg.real_in - agg.real_out < 0
          THEN 'Tiền cọc đã trả ra NHIỀU HƠN tiền đã thu thật — phải rà tay trước khi hoàn tiếp.'
        WHEN agg.n_real = 0 AND agg.n_hist > 0
          THEN 'Cọc chỉ được GHI NHẬN trên sổ ảo, chưa từng vào két thật. Hoàn tiền mặt sẽ là chi tiền chưa hề thu.'
        ELSE NULL
      END,
    -- Vân tay: đổi một dòng nguồn nào là đổi vân tay ⇒ submit phát hiện được
    -- rằng cơ sở đã trôi kể từ lúc preview.
    'fingerprint', (
      SELECT md5(COALESCE(string_agg(
        s.voucher_id::text || ':' || s.bucket || ':' || round(s.signed_amount)::text,
        '|' ORDER BY s.created_at, s.voucher_id), 'EMPTY'))
      FROM s),
    'sources', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'voucherId', s.voucher_id, 'code', s.code, 'direction', s.direction,
               'bucket', s.bucket, 'excludeReason', s.exclude_reason,
               'amount', s.amount, 'signedAmount', s.signed_amount,
               'isVirtual', s.is_virtual, 'systemSource', s.system_source,
               'voucherDate', s.voucher_date)
             ORDER BY s.created_at, s.voucher_id)
      FROM s), '[]'::jsonb)
  )
  FROM agg;
$function$;

REVOKE ALL ON FUNCTION app_private.resolve_signed_contract_deposit_basis_v1(uuid,uuid,timestamptz)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION app_private.resolve_signed_contract_deposit_basis_v1(uuid,uuid,timestamptz) IS
  'Đợt 1 Step 2c: MỘT nguồn sự thật cho "hợp đồng đang giữ bao nhiêu cọc". Broker và '
  'Plan 2 BẮT BUỘC reuse, không chép lại công thức. netHeld = realPostedIn − '
  'postedReleaseOut và CỐ Ý không cộng recognizedHistoricalIn — 243/287 phiếu cọc '
  'nằm trên SỔ ẢO (backfill 28/07, ~998tr) nên cộng vào là báo két có tiền không có '
  'thật. basisStatus cảnh báo NEGATIVE_HELD (trả ra nhiều hơn thu thật) và '
  'RECOGNIZED_ONLY (chưa từng vào két — hoàn tiền mặt là chi khoản chưa hề thu). '
  'fingerprint đổi khi bất kỳ dòng nguồn nào đổi, để submit biết cơ sở đã trôi kể từ '
  'preview. Lõi nội bộ: KHÔNG cấp cho client.';

DO $selfcheck$
DECLARE
  v_code text;   -- thân hàm TỔNG HỢP
  v_src  text;   -- thân hàm NGUỒN
BEGIN
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app_private' AND p.proname='resolve_signed_contract_deposit_basis_v1';
  -- Mấy mệnh đề loại trừ nằm ở hàm NGUỒN, không ở hàm tổng hợp — bản đầu soi nhầm
  -- thân hàm nên RAISE oan. Đọc đúng chỗ.
  SELECT lower(regexp_replace(p.prosrc,'--[^\n]*','','g')) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app_private' AND p.proname='contract_deposit_sources_v1';

  -- netHeld TUYỆT ĐỐI không được cộng rổ ghi nhận.
  IF v_code ~ 'real_in\s*-\s*real_out\s*\+\s*.*hist' OR v_code ~ 'hist_in\s*\+\s*agg\.real_in' THEN
    RAISE EXCEPTION 'netHeld đang cộng cả rổ ghi nhận (sổ ảo) — báo tiền không có thật. DỪNG.';
  END IF;
  IF position('real_in - agg.real_out' IN v_code) = 0 THEN
    RAISE EXCEPTION 'netHeld không còn là realPostedIn − postedReleaseOut. DỪNG.';
  END IF;
  -- Phải loại đủ bốn trạng thái không tính (ở hàm NGUỒN).
  IF position('cancelled' IN v_src) = 0 OR position('reversed' IN v_src) = 0
     OR position('deleted_at' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Hàm nguồn thiếu loại trừ huỷ/đảo/xoá. DỪNG.';
  END IF;
  -- Sổ ẢO phải rơi vào rổ ghi nhận, KHÔNG vào tiền thật.
  IF position('is_virtual' IN v_src) = 0 OR position('recognized_historical' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Hàm nguồn không tách rổ sổ ảo — 243/287 phiếu cọc sẽ bị tính thành tiền thật. DỪNG.';
  END IF;
  -- Không cấp cho client.
  IF has_function_privilege('authenticated',
       'app_private.resolve_signed_contract_deposit_basis_v1(uuid,uuid,timestamptz)','EXECUTE')
     OR has_function_privilege('anon',
       'app_private.contract_deposit_sources_v1(uuid,uuid,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'Hàm cơ sở cọc đang gọi được từ client — REVOKE. DỪNG.';
  END IF;
  -- VOLATILE (nhánh authz/khoá dòng — án lệ 25006).
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='app_private'
                AND p.proname IN ('resolve_signed_contract_deposit_basis_v1','contract_deposit_sources_v1')
                AND p.provolatile <> 'v') THEN
    RAISE EXCEPTION 'Hàm cơ sở cọc phải VOLATILE. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
