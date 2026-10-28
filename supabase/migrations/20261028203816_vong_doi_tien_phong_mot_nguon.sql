-- =============================================================================
-- Vòng đời tiền của phòng: MỘT nguồn cho sự kiện, KPI và lane Thu tiền (29/10/2026).
--
-- LỖI (thân sống 20261018052932, md5 a637b231)
--   · INVOICE_ISSUED.amount = total_amount: cộng cả nợ cũ đã kéo từ hoá đơn trước (đếm nợ kéo hai lần)
--     và cả dòng cọc/NON_PNL trên hoá đơn.
--   · INVOICE_COLLECTION_POSTED.amount = paid_amount, ngày = paid_date/updated_at: gồm cả khoản cấn trừ
--     khi thanh lý/bỏ cọc (payment received_amount = 0), phần cọc, và phần nợ do hoá đơn sau trả hộ;
--     PARTIAL_PAID có paid_date NULL nên ngày trôi theo updated_at.
--   · DEPOSIT_REFUND_POSTED = cả phiếu termination.refund (gồm tiền thừa/tiền phòng trả khách), chỉ khi
--     đã ghi sổ — phiếu trả qua sổ ảo (NOT_APPLICABLE) không bao giờ thành "đã hoàn".
--   · COMMISSION_PAID chỉ lấy system_source contract.commission APPROVED và gọi mọi trạng thái là "đã chi";
--     sót phiếu lập tay, HHMG, phiếu chờ duyệt, thưởng Sale lập từ phiếu cọc.
--   · Không có số tổng nào trong payload ⇒ ngăn kéo/lane tự cộng hoá đơn thô theo HĐ (B1/B3).
--
-- SỬA — ba helper app_private (LANGUAGE sql STABLE SECURITY INVOKER, search_path '', chỉ owner postgres
-- gọi được; RPC DEFINER owner postgres là người gọi duy nhất):
--   H1 invoice_lifecycle_parts_v1(ids)  — F0/F1: tập S và các phần tiền của từng hoá đơn:
--      S = hoá đơn chưa xoá, khác DRAFT, tổng ≥ 0, VÀ (khác CANCELLED HOẶC invoice_direct_paid_v1 > 0) — hoá
--        đơn huỷ khi bỏ cọc mà writer cố ý giữ tiền đã thu làm doanh thu vẫn là tiền khách nộp; hoá đơn tổng
--        âm (thanh lý kiểu cũ: phạt trừ vào cọc, phần còn lại hoàn qua phiếu '[Hoàn trả thanh lý]' gắn hoá
--        đơn — invoice_direct_paid_v1 trừ phiếu đó nên ra âm) là khoản TRẢ khách, đã nằm ở phiếu hoàn (H3).
--      off(p) = chưa đảo AND received_amount = 0 (so chặt, không xét phương thức; NULL = tiền thật legacy).
--      cash = invoice_direct_paid_v1 − Σ off; phần cọc (dòng accounting_class ≠ REVENUE, bỏ DISCOUNT —
--        cùng vị ngữ "cột NULL" của invoice_amount_parts_for_v1) nhận TRƯỚC: tiền thật, rồi cấn trừ, rồi phần
--        hoá đơn sau trả hộ; rev_cash = tiền thật còn lại; cấn trừ trả dòng cọc (dep_offset) không phải cấn
--        trừ doanh thu. Phần cọc nguồn do hoá đơn gánh PAID trả hộ là phần cọc trong tiền của hoá đơn gánh.
--      carried_in = LEAST(previous_debt, Σ nguồn khai trong previous_debt_sources thuộc S);
--        new_amount = total − carried_in − phần cọc.
--      Huỷ khi bỏ cọc: total đã bị writer ghi đè = tiền đã thu, dòng hoá đơn/previous_debt giữ nguyên ⇒
--        carried_in = 0 (hoá đơn gánh huỷ chưa từng trả hộ nguồn) và phần cọc chỉ là tiền vượt Σ dòng doanh
--        thu (writer thu tiền V5 phân bổ doanh thu trước) ⇒ phát sinh = tiền đã thu, không âm.
--      carried_paid = invoice_carried_debt_v1 (chỉ gọi khi paid_amount vượt direct) — một nguồn, không suy ngược.
--      outstanding = effective_outstanding (invoice_effective_outstanding_v1 gọi MỘT lần cho cả S) − phần
--        cọc chưa tất toán (không vượt phần còn mở); PAID kẹp ≤ 0 (số lẻ đã xoá không thành nợ, thu dư vẫn
--        bù kỳ khác); CANCELLED = 0.
--   H2 contract_commission_vouchers_v1(org, ids) — F4: mọi phiếu hoa hồng/thưởng chưa huỷ/xoá của HĐ:
--      gắn thẳng HĐ (is_commission_voucher_v1) + thưởng Sale lập từ phiếu cọc (sale_bonus_claims, chỉ phiếu
--      chưa gắn HĐ, claim sớm nhất); stage PENDING/REVERSED/OFFBOOK/PAID/UNPOSTED xét theo thứ tự đó.
--   H3 termination_refund_parts_v1(ids)  — F3: từng phiếu termination.refund chưa huỷ/xoá tách dòng cọc với
--      dòng khác; đã trả = APPROVED ∧ ((POSTED ∧ active_posting_id_v2) ∨ NOT_APPLICABLE — trả ngoài sổ tiền);
--      kèm refund_amount của thanh lý hiệu lực mới nhất (như contractLifecycle.ts).
--
-- RPC get_room_cash_lifecycle_v1 — dựng NGUYÊN VĂN thân 20261018052932, chỉ đổi:
--   · hd thêm original_end_date = min(old_end_date) của gia hạn APPROVED/COMPLETED (A2);
--   · CTE ip/ex/rp/mrow/ms/rf đọc ba helper MỘT lần — sự kiện và contracts[].money cùng đọc các dòng này;
--   · nhánh hoá đơn: INVOICE_ISSUED = phần phát sinh mới, INVOICE_COLLECTION_POSTED = tiền thật theo ngày
--     thu thật, MỚI INVOICE_TERMINATION_OFFSET = phần cấn trừ trả doanh thu (via MOVE_OUT | FORFEIT; phần
--     cấn dòng cọc ở meta depositOffset); chỉ hoá đơn của phòng;
--   · nhánh phiếu: SETTLEMENT_OFFSET/DEPOSIT_FORFEIT thêm voucherId; MỚI TERMINATION_EXTRA_RECEIPT_POSTED
--     (theo phòng của hoá đơn, rồi phòng của phiếu, rồi phòng của HĐ), MỚI TERMINATION_REFUND_OFFSET_POSTED;
--     DEPOSIT_REFUND_POSTED chỉ còn dòng cọc, MỚI CUSTOMER_REFUND_POSTED cho dòng khác; 10 type
--     {COMMISSION|SALE_BONUS}_{PENDING|UNPOSTED|PAID|OFFBOOK|REVERSED} thay COMMISSION_PAID cũ;
--   · contracts[] thêm originalEndDate và money {contract, room, refund} (không phụ thuộc p_from/p_to);
--   · DEPOSIT_RECEIVED thêm meta voucherId, TERMINATION_REQUESTED thêm terminationId; events xếp thêm khoá
--     phá hoà contractId rồi voucherId/invoiceId/terminationId — mỗi dòng có id riêng ⇒ tất định cho test và
--     Hermes (phiếu thu thêm gắn hoá đơn xếp theo phiếu, không theo hoá đơn).
--   Chữ ký, RETURNS jsonb, DEFINER, search_path, cổng quyền, REVOKE/GRANT giữ nguyên. Hermes
--   (đường đọc W2-D) chỉ chép type/date/contractId/amount/trusted và khoá contracts cố định ⇒ meta,
--   money, originalEndDate không lộ; nghĩa amount của INVOICE_*, DEPOSIT_REFUND_POSTED và COMMISSION_PAID đổi.
--
-- Sổ retirement restore-before-contract-settlement-2026-09-21 ghim md5(pg_get_functiondef) của RPC. Sau khi
-- apply, khai migration này là forward succession thứ sáu CÙNG biên nhận apply: before a637b231…, after
-- md5 dưới đây, owner postgres, ACL {postgres=X/postgres,authenticated=X/postgres}; thêm ngoại lệ pinned cho
-- 20261018052932 (chốt đầu của nó ngã P0001 khi phát lại trên thân mới). md5 đo bằng PGlite.
-- Kiểu trả về (RETURNS TABLE) của ba helper đóng băng sau lần áp đầu — đổi cột phải làm _v2.
--
-- Chạy lại được: CREATE OR REPLACE; chốt đầu nhận đúng bản sống hoặc chính bản này.
-- LÙI: áp lại thân 20261018052932:45-277 (không có khối DO), rồi DROP ba helper. Không có dữ liệu phải khôi phục.
-- Không tự mở BEGIN/COMMIT: lane (và test-env:thu-sql) bọc cả file trong MỘT transaction có lock/statement timeout.
-- =============================================================================

DO $chot$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_room_cash_lifecycle_v1(uuid,date,date)');
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'chot: thieu public.get_room_cash_lifecycle_v1(uuid,date,date)';
  END IF;
  IF v_md5 NOT IN ('a637b2312d020da2f7de2da01d5b6435', 'e27f4c4977eaa881b1ffc8b595dbbc45') THEN
    RAISE EXCEPTION 'chot: get_room_cash_lifecycle_v1 da bi doi (md5 %) - doc lai ban dang chay truoc khi de', v_md5;
  END IF;
  -- Nguồn dùng chung mà ba helper đọc lại (không chép logic).
  IF to_regprocedure('app_private.invoice_direct_paid_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.invoice_carried_debt_v1(uuid)') IS NULL
     OR to_regprocedure('public.invoice_effective_outstanding_v1(uuid[])') IS NULL
     OR to_regprocedure('app_private.is_commission_voucher_v1(uuid)') IS NULL
     OR to_regclass('app_private.sale_bonus_claims') IS NULL
     OR to_regclass('app_private.termination_forfeit_authorizations') IS NULL
     OR to_regclass('public.contract_extensions') IS NULL THEN
    RAISE EXCEPTION 'chot: thieu ham/bang nguon dung chung cua vong doi tien phong';
  END IF;
END
$chot$;

-- H1 — F0/F1: mỗi hoá đơn của S một dòng. Tham số là ỨNG VIÊN (vd mọi hoá đơn của các HĐ); hàm tự lọc S.
CREATE OR REPLACE FUNCTION app_private.invoice_lifecycle_parts_v1(p_invoice_ids uuid[])
RETURNS TABLE(invoice_id uuid, contract_id uuid, room_id uuid, status text, kind text, billing_month text,
              issue_date date, total_amount numeric, direct numeric, offset_paid numeric, offset_date date,
              offset_via text, cash numeric, cash_date date, non_rev numeric, dep_paid numeric,
              dep_offset numeric, dep_unpaid numeric, rev_cash numeric, carried_in numeric, new_amount numeric,
              carried_paid numeric, effective_outstanding numeric, carried_out numeric, outstanding numeric,
              penalty numeric, source_ids uuid[])
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH cand AS MATERIALIZED (
    SELECT i.id, i.contract_id, i.room_id, i.status::text AS status, i.kind::text AS kind, i.billing_month,
           i.issue_date::date AS issue_date, i.total_amount, i.paid_amount, i.previous_debt,
           i.previous_debt_sources, app_private.invoice_direct_paid_v1(i.id) AS direct
      FROM public.invoices i
     WHERE i.id = ANY (COALESCE(p_invoice_ids, '{}'::uuid[]))
       AND i.deleted_at IS NULL AND i.status::text <> 'DRAFT'
  ),
  s AS MATERIALIZED (
    -- Hoá đơn huỷ chỉ ở lại khi còn tiền khách đã nộp (bỏ cọc: writer giữ phần đã thu làm doanh thu).
    -- Hoá đơn tổng âm là khoản trả khách (hoàn trả thanh lý kiểu cũ): tiền ra nằm ở phiếu hoàn (H3) — để lại
    -- thì direct âm thành "khách đã nộp" âm và phiếu hoàn bị tính hai lần.
    SELECT x.* FROM cand x
     WHERE (x.status <> 'CANCELLED' OR x.direct > 0) AND COALESCE(x.total_amount, 0) >= 0
  ),
  pay AS (
    SELECT p.invoice_id,
           sum(p.amount) FILTER (WHERE o.off) AS off_amount,
           max(p.payment_date::date) FILTER (WHERE o.off) AS off_date,
           max(p.payment_date::date) FILTER (WHERE NOT o.off) AS cash_date,
           bool_or(o.off AND EXISTS (SELECT 1 FROM app_private.termination_forfeit_authorizations a
                                      WHERE a.payment_id = p.id)) AS forfeit
      FROM public.payments p
     CROSS JOIN LATERAL (SELECT COALESCE(p.received_amount = 0, false) AS off) o
     WHERE p.invoice_id IN (SELECT s.id FROM s) AND p.reversed_at IS NULL
     GROUP BY p.invoice_id
  ),
  item AS (
    SELECT ii.invoice_id,
           sum(COALESCE(ii.amount, 0)) FILTER (WHERE ii.accounting_class::text IS DISTINCT FROM 'REVENUE'
                                                 AND ii.type::text <> 'DISCOUNT') AS non_rev,
           sum(COALESCE(ii.amount, 0)) FILTER (WHERE ii.accounting_class::text = 'REVENUE'
                                                 AND ii.type::text <> 'DISCOUNT') AS rev_lines,
           sum(COALESCE(ii.amount, 0)) FILTER (WHERE ii.type::text = 'PENALTY') AS penalty
      FROM public.invoice_items ii
     WHERE ii.invoice_id IN (SELECT s.id FROM s)
     GROUP BY ii.invoice_id
  ),
  pair AS (
    -- Nợ kéo theo từng nguồn, chỉ nguồn cũng nằm trong S (đọc phần tử như invoice_effective_outstanding_v1).
    SELECT s.id AS carrier_id, r.source_id, r.amount
      FROM s
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(s.previous_debt_sources) = 'array' THEN s.previous_debt_sources ELSE '[]'::jsonb END) e
     CROSS JOIN LATERAL (SELECT
       CASE WHEN jsonb_typeof(e.value) = 'object' AND e.value->>'type' = 'invoice'
             AND e.value->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (e.value->>'id')::uuid END AS source_id,
       GREATEST(CASE
         WHEN jsonb_typeof(e.value->'amount') = 'number' THEN (e.value->>'amount')::numeric
         WHEN e.value->>'amount' ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN btrim(e.value->>'amount')::numeric
         ELSE 0 END, 0) AS amount) r
     WHERE r.source_id IN (SELECT y.id FROM s y)
  ),
  src AS (
    SELECT p.carrier_id AS id, sum(p.amount) AS amount, array_agg(DISTINCT p.source_id ORDER BY p.source_id) AS ids
      FROM pair p
     GROUP BY p.carrier_id
  ),
  eff AS (
    SELECT o.invoice_id, o.effective_outstanding, o.carried_out_amount
      FROM public.invoice_effective_outstanding_v1(ARRAY(SELECT s.id FROM s)) o
  ),
  b AS (
    SELECT s.*, COALESCE(pay.off_amount, 0) AS off_amount, pay.off_date, pay.cash_date,
           COALESCE(pay.forfeit, false) AS forfeit,
           COALESCE(item.non_rev, 0) AS non_rev, COALESCE(item.rev_lines, 0) AS rev_lines,
           COALESCE(item.penalty, 0) AS penalty,
           -- Hoá đơn gánh bị huỷ chưa từng trả hộ nguồn (chỉ hoá đơn gánh PAID mới trả) và total đã bị ghi đè.
           CASE WHEN s.status = 'CANCELLED' THEN 0
                ELSE LEAST(COALESCE(s.previous_debt, 0), COALESCE(src.amount, 0)) END AS carried_in,
           COALESCE(src.ids, '{}'::uuid[]) AS source_ids,
           CASE WHEN COALESCE(s.paid_amount, 0) - s.direct > 0.5
                THEN app_private.invoice_carried_debt_v1(s.id) ELSE 0 END AS carried_paid,
           COALESCE(eff.effective_outstanding, 0) AS eff, COALESCE(eff.carried_out_amount, 0) AS carried_out
      FROM s
      LEFT JOIN pay ON pay.invoice_id = s.id
      LEFT JOIN item ON item.invoice_id = s.id
      LEFT JOIN src ON src.id = s.id
      LEFT JOIN eff ON eff.invoice_id = s.id
  ),
  m AS (
    -- Phần cọc nhận TRƯỚC: tiền thật, rồi cấn trừ, rồi phần hoá đơn sau trả hộ — dòng cọc đã tất toán bằng
    -- cách nào cũng không còn là "cọc chưa thu" (trừ nó vào nợ sẽ ra thu dư ảo, che nợ kỳ khác).
    -- Hoá đơn huỷ khi bỏ cọc: phần cọc chỉ là tiền vượt Σ dòng doanh thu (V5 phân bổ doanh thu trước; phần
    -- vượt đã bị phạt sang hoá đơn bỏ cọc qua cấn FORFEIT).
    SELECT b.*, c.cash, d.dep, p.dep_paid, o.dep_offset,
           LEAST(d.dep - p.dep_paid - o.dep_offset, GREATEST(b.carried_paid, 0)) AS dep_carried,
           d.dep - p.dep_paid - o.dep_offset - LEAST(d.dep - p.dep_paid - o.dep_offset, GREATEST(b.carried_paid, 0)) AS dep_unpaid
      FROM b
     CROSS JOIN LATERAL (SELECT b.direct - b.off_amount AS cash) c
     CROSS JOIN LATERAL (SELECT CASE WHEN b.status = 'CANCELLED'
                                     THEN LEAST(b.non_rev, GREATEST(c.cash - b.rev_lines, 0))
                                     ELSE b.non_rev END AS dep) d
     CROSS JOIN LATERAL (SELECT LEAST(d.dep, GREATEST(c.cash, 0)) AS dep_paid) p
     CROSS JOIN LATERAL (SELECT LEAST(d.dep - p.dep_paid, GREATEST(b.off_amount, 0)) AS dep_offset) o
  ),
  cin AS (
    -- Phần cọc của nguồn do hoá đơn gánh PAID trả hộ: tiền thật nằm ở hoá đơn gánh ⇒ là phần cọc trong tiền
    -- của hoá đơn gánh, không phải doanh thu của nó. Một tầng: chuỗi gánh lồng nhau không truyền tiếp.
    SELECT p.carrier_id, sum(LEAST(x.dep_carried, p.amount)) AS dep_in
      FROM pair p
      JOIN m x ON x.id = p.source_id AND x.dep_carried > 0
      JOIN m g ON g.id = p.carrier_id AND g.status = 'PAID'
     GROUP BY p.carrier_id
  )
  SELECT m.id, m.contract_id, m.room_id, m.status, m.kind, m.billing_month, m.issue_date, m.total_amount,
         m.direct, m.off_amount, m.off_date,
         CASE WHEN m.forfeit THEN 'FORFEIT' WHEN m.off_amount > 0 THEN 'MOVE_OUT' END,
         m.cash, m.cash_date, m.dep, q.dep_paid, m.dep_offset, m.dep_unpaid, m.cash - q.dep_paid,
         m.carried_in, m.total_amount - m.carried_in - m.dep,
         m.carried_paid, m.eff, m.carried_out,
         -- Phần cọc chưa tất toán không vượt phần còn mở của hoá đơn: không bao giờ đẩy nợ thành âm.
         CASE WHEN m.status = 'CANCELLED' THEN 0
              WHEN m.status = 'PAID' THEN LEAST(m.eff, 0)
              ELSE m.eff - LEAST(m.dep_unpaid, GREATEST(m.eff, 0)) END,
         m.penalty, m.source_ids
    FROM m
    LEFT JOIN cin ON cin.carrier_id = m.id
   CROSS JOIN LATERAL (SELECT LEAST(m.dep_paid + COALESCE(cin.dep_in, 0), GREATEST(m.cash, 0)) AS dep_paid) q;
$fn$;

COMMENT ON FUNCTION app_private.invoice_lifecycle_parts_v1(uuid[]) IS
  'Vòng đời tiền (F0/F1): lọc S từ ứng viên (chưa xoá, khác DRAFT, tổng ≥ 0, huỷ chỉ khi còn tiền trực tiếp) rồi '
  'mỗi hoá đơn một dòng: phát sinh mới, tiền thật (không cấn trừ received_amount = 0; cọc nhận trước, kể cả qua '
  'cấn trừ/hoá đơn gánh), cấn trừ, nợ kéo, nợ thực (invoice_effective_outstanding_v1 trên cả S). Huỷ khi bỏ cọc: '
  'không nợ kéo, doanh thu trước. INVOKER; chỉ hàm DEFINER owner postgres gọi.';
ALTER FUNCTION app_private.invoice_lifecycle_parts_v1(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.invoice_lifecycle_parts_v1(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- H2 — F4: phiếu hoa hồng môi giới / thưởng Sale của các HĐ (mọi trạng thái trừ huỷ/xoá).
CREATE OR REPLACE FUNCTION app_private.contract_commission_vouchers_v1(p_org uuid, p_contract_ids uuid[])
RETURNS TABLE(voucher_id uuid, contract_id uuid, code text, name text, kind text, link text,
              approval_status text, posting_status text, stage text, voucher_date date,
              total_amount numeric, legacy_dup boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH hit AS (
    SELECT v.id, v.contract_id AS cid, 'direct'::text AS link
      FROM public.income_expenses v
     WHERE v.organization_id = p_org AND v.contract_id = ANY (p_contract_ids)
       AND v.type::text = 'EXPENSE' AND v.deleted_at IS NULL
       AND v.approval_status::text IS DISTINCT FROM 'CANCELLED'
       AND app_private.is_commission_voucher_v1(v.id)
    UNION ALL
    -- Thưởng Sale lập từ phiếu cọc (như contract_commission_live_voucher_v1, không LIMIT): phiếu đã gắn HĐ thì
    -- nhánh trên lo ⇒ không đếm hai lần; nhiều claim cho một phiếu ⇒ một dòng theo claim sớm nhất.
    (SELECT DISTINCT ON (v.id) v.id, dep.contract_id, 'deposit_claim'::text
       FROM app_private.sale_bonus_claims cl
       JOIN public.income_expenses v ON v.id = cl.bonus_voucher_id AND v.organization_id = cl.organization_id
       JOIN public.income_expenses dep ON dep.id = cl.deposit_voucher_id AND dep.organization_id = cl.organization_id
      WHERE cl.organization_id = p_org AND dep.contract_id = ANY (p_contract_ids)
        AND v.contract_id IS NULL
        AND v.type::text = 'EXPENSE' AND v.deleted_at IS NULL
        AND v.approval_status::text IS DISTINCT FROM 'CANCELLED'
      ORDER BY v.id, cl.created_at, cl.id)
  )
  SELECT v.id, h.cid, v.code::text, v.name::text,
         CASE WHEN h.link = 'deposit_claim' THEN 'sale' ELSE COALESCE(v.commission_kind::text, 'broker') END,
         h.link, v.approval_status::text, v.posting_status::text,
         CASE WHEN v.approval_status::text = 'UNAPPROVED' THEN 'PENDING'
              WHEN v.posting_status::text = 'REVERSED' THEN 'REVERSED'
              WHEN v.posting_status::text = 'NOT_APPLICABLE' THEN 'OFFBOOK'
              WHEN v.posting_status::text = 'POSTED' AND v.active_posting_id_v2 IS NOT NULL THEN 'PAID'
              ELSE 'UNPOSTED' END,
         v.voucher_date::date, v.total_amount, COALESCE(v.commission_legacy_dup, false)
    FROM hit h
    JOIN public.income_expenses v ON v.id = h.id;
$fn$;

COMMENT ON FUNCTION app_private.contract_commission_vouchers_v1(uuid, uuid[]) IS
  'Vòng đời tiền (F4): phiếu hoa hồng/thưởng chưa huỷ/xoá của các HĐ — gắn thẳng (is_commission_voucher_v1) hoặc '
  'thưởng Sale từ phiếu cọc (sale_bonus_claims, phiếu chưa gắn HĐ). stage PENDING > REVERSED > OFFBOOK > PAID > '
  'UNPOSTED. INVOKER; chỉ hàm DEFINER owner postgres gọi.';
ALTER FUNCTION app_private.contract_commission_vouchers_v1(uuid, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.contract_commission_vouchers_v1(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- H3 — F3: phiếu hoàn khi thanh lý, từng phiếu một dòng (dòng cọc / dòng khác), kèm refund_amount của thanh
-- lý hiệu lực mới nhất. HĐ có thanh lý mà chưa có phiếu: một dòng với voucher_id NULL.
CREATE OR REPLACE FUNCTION app_private.termination_refund_parts_v1(p_contract_ids uuid[])
RETURNS TABLE(contract_id uuid, termination_id uuid, deposit_due numeric, voucher_id uuid, code text,
              voucher_date date, posted boolean, offbook boolean, in_books boolean,
              deposit_amount numeric, other_amount numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH t AS (
    SELECT DISTINCT ON (ct.contract_id) ct.contract_id, ct.id, ct.refund_amount
      FROM public.contract_terminations ct
     WHERE ct.contract_id = ANY (p_contract_ids) AND ct.status::text IN ('APPROVED', 'COMPLETED')
     ORDER BY ct.contract_id, ct.termination_date DESC NULLS LAST, ct.id DESC
  ),
  r AS (
    SELECT v.contract_id, v.id, v.code::text AS code, v.voucher_date::date AS voucher_date,
           -- Đã trả khách: ghi sổ thật, hoặc trả ngoài sổ tiền (NOT_APPLICABLE).
           COALESCE(v.approval_status::text = 'APPROVED'
             AND ((v.posting_status::text = 'POSTED' AND v.active_posting_id_v2 IS NOT NULL)
                  OR v.posting_status::text = 'NOT_APPLICABLE'), false) AS posted,
           COALESCE(v.approval_status::text = 'APPROVED' AND v.posting_status::text = 'NOT_APPLICABLE', false) AS offbook,
           COALESCE(v.posting_status::text = 'POSTED' AND v.active_posting_id_v2 IS NOT NULL, false) AS in_books,
           l.deposit_amount, l.other_amount
      FROM public.income_expenses v
     CROSS JOIN LATERAL (
       SELECT COALESCE(sum(COALESCE(it.amount, it.unit_price * it.quantity))
                FILTER (WHERE it.accounting_class::text = 'DEPOSIT'), 0) AS deposit_amount,
              COALESCE(sum(COALESCE(it.amount, it.unit_price * it.quantity))
                FILTER (WHERE it.accounting_class::text IS DISTINCT FROM 'DEPOSIT'), 0) AS other_amount
         FROM public.income_expense_items it
        WHERE it.income_expense_id = v.id) l
     WHERE v.contract_id = ANY (p_contract_ids) AND v.deleted_at IS NULL
       AND v.system_source = 'termination.refund'
       AND v.approval_status::text IS DISTINCT FROM 'CANCELLED'
  )
  SELECT k.contract_id, t.id, t.refund_amount, r.id, r.code, r.voucher_date, r.posted, r.offbook, r.in_books,
         r.deposit_amount, r.other_amount
    FROM (SELECT t.contract_id FROM t UNION SELECT r.contract_id FROM r) k
    LEFT JOIN t ON t.contract_id = k.contract_id
    LEFT JOIN r ON r.contract_id = k.contract_id;
$fn$;

COMMENT ON FUNCTION app_private.termination_refund_parts_v1(uuid[]) IS
  'Vòng đời tiền (F3): phiếu termination.refund chưa huỷ/xoá tách dòng cọc (accounting_class DEPOSIT) với dòng khác; '
  'posted = APPROVED ∧ ((POSTED ∧ active_posting_id_v2) ∨ NOT_APPLICABLE); kèm refund_amount của thanh lý '
  'APPROVED/COMPLETED mới nhất. INVOKER; chỉ hàm DEFINER owner postgres gọi.';
ALTER FUNCTION app_private.termination_refund_parts_v1(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.termination_refund_parts_v1(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_room_cash_lifecycle_v1(p_room_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_room  record;
  v_ids   uuid[];
  v_out   jsonb;
  -- "Hôm nay" phải là ngày của TỔ CHỨC, không phải ngày của phiên Postgres
  -- (phiên chạy TimeZone=UTC nên từ 00:00 đến 07:00 giờ VN nó còn là hôm qua).
  v_today date;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT r.id, r.name, r.building_id, b.name AS building_name,
         b.organization_id
    INTO v_room
    FROM rooms r JOIN buildings b ON b.id = r.building_id
   WHERE r.id = p_room_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phòng' USING ERRCODE='P0002';
  END IF;

  v_today := public.org_today_v1(v_room.organization_id);

  -- Ngoài quyền xem toà, phải có khoá của một màn đang dùng hàm này ở toà đó: Thu tiền
  -- (/thu-tien, RequirePermission thu_tien.view) hoặc BC phân bổ lợi nhuận
  -- (ProfitHubPage, reports_finance.profit_distribution). Thân trả giá thuê, cọc, số tiền
  -- hoá đơn/hoàn cọc/hoa hồng nên không mở cho người chỉ có buildings.view.
  IF NOT (public.is_admin() OR public.is_super_admin()
          OR ((public.can_access_building(v_room.building_id)
               OR public.ie_all_buildings_scope(v_room.building_id))
              AND (public.can_do_on_building('thu_tien', 'view', v_room.building_id)
                   OR public.can_do_on_building('reports_finance', 'profit_distribution', v_room.building_id)))) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem toà này' USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c.id), '{}') INTO v_ids
    FROM contracts c
   WHERE c.deleted_at IS NULL
     AND (c.room_id = p_room_id
          OR EXISTS (SELECT 1 FROM contract_transfers tr
                      WHERE tr.contract_id = c.id
                        AND tr.status IN ('COMPLETED','APPROVED')
                        AND (tr.old_room_id = p_room_id OR tr.new_room_id = p_room_id)));

  WITH seg_raw AS (
    -- Thanh cư trú trên phòng này. to_date NULL từ projection nghĩa là "không
    -- có mốc chuyển đi" — hợp đồng đã kết thúc thì đóng tại ngày kết thúc.
    SELECT s.contract_id, s.contract_number, s.seg_index, s.from_date,
           CASE
             WHEN s.to_date IS NOT NULL THEN s.to_date
             ELSE COALESCE(c.actual_end_date::date,
                    CASE WHEN c.status::text IN ('TERMINATED','EXPIRED')
                         THEN c.end_date::date END)
           END AS to_date,
           s.source_path, s.trusted, s.diagnostic
      FROM public.get_room_residence_segments_v1(v_ids) s
      JOIN contracts c ON c.id = s.contract_id
     WHERE s.room_id = p_room_id
  ),
  seg AS (
    -- Mốc đóng SỚM HƠN mốc mở = dữ liệu bẩn (hợp đồng rác kết thúc trước khi
    -- bắt đầu — có thật trên prod, phòng 401). Kẹp 0 ngày + hạ trusted + gắn
    -- diagnostic: UI vẽ thanh cảnh báo, vacancy bỏ qua.
    SELECT r.contract_id, r.contract_number, r.seg_index, r.from_date,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN r.from_date ELSE r.to_date END AS to_date,
           r.source_path,
           (r.trusted AND NOT (r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                               AND r.to_date < r.from_date)) AS trusted,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN 'SEGMENT_END_BEFORE_START' ELSE r.diagnostic END AS diagnostic
      FROM seg_raw r
  ),
  hd AS (
    SELECT c.id, c.contract_number, c.status::text AS status,
           c.start_date, c.end_date, c.actual_end_date,
           c.rent_price, c.total_deposit,
           t.full_name AS tenant_name,
           -- Hạn GỐC trước các lượt gia hạn hiệu lực (A2): min, không xếp theo ngày (có lượt cùng ngày).
           (SELECT min(x.old_end_date) FROM contract_extensions x
             WHERE x.contract_id = c.id AND x.status IN ('APPROVED','COMPLETED')) AS original_end_date
      FROM contracts c
      LEFT JOIN tenants t ON t.id = c.tenant_id
     WHERE c.id = ANY(v_ids)
  ),
  -- MỘT nguồn tiền: sự kiện và contracts[].money cùng đọc các dòng dưới (helper gọi một lần).
  -- Hoá đơn: mọi phòng của các HĐ dính phòng (H1 tự lọc tập S).
  ip AS MATERIALIZED (
    SELECT * FROM app_private.invoice_lifecycle_parts_v1(
      ARRAY(SELECT i.id FROM invoices i WHERE i.contract_id = ANY(v_ids)))
  ),
  -- Khách trả thêm khi thanh lý (tiền thật): mỗi phiếu thuộc ĐÚNG một phòng — phòng của hoá đơn, rồi
  -- phòng của phiếu, rồi phòng của HĐ.
  ex AS MATERIALIZED (
    SELECT ie.id, ie.contract_id, ie.code, ie.voucher_date, ie.total_amount, ie.invoice_id,
           ei.billing_month, COALESCE(ei.room_id, ie.room_id, ec.room_id) AS room_id,
           COALESCE(ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL, false) AS in_books
      FROM income_expenses ie
      LEFT JOIN invoices ei ON ei.id = ie.invoice_id
      LEFT JOIN contracts ec ON ec.id = ie.contract_id
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.extra_receipt' AND ie.approval_status = 'APPROVED'
  ),
  rp AS MATERIALIZED (
    SELECT * FROM app_private.termination_refund_parts_v1(v_ids)
  ),
  mrow AS (
    SELECT ip.contract_id, ip.room_id, ip.invoice_id, ip.new_amount AS issued, ip.rev_cash AS paid_cash,
           ip.offset_paid - ip.dep_offset AS offset_paid, 0::numeric AS extra, ip.outstanding, ip.non_rev
      FROM ip
    UNION ALL
    SELECT ex.contract_id, ex.room_id, NULL, 0, ex.total_amount, 0, ex.total_amount, 0, 0
      FROM ex
  ),
  -- F2: phạm vi 'contract' = cả HĐ, 'room' = phòng đang xem; không phụ thuộc p_from/p_to.
  ms AS (
    SELECT h.id AS contract_id, sc.scope,
           jsonb_build_object(
             'issued', COALESCE(sum(m.issued), 0),
             'paidCash', COALESCE(sum(m.paid_cash), 0),
             'offset', GREATEST(COALESCE(sum(m.offset_paid), 0) - COALESCE(sum(m.extra), 0), 0),
             'debt', GREATEST(COALESCE(sum(m.outstanding), 0), 0),
             'overpaid', GREATEST(-COALESCE(sum(m.outstanding), 0), 0),
             'invoiceCount', count(m.invoice_id),
             'roomCount', count(DISTINCT m.room_id) FILTER (WHERE m.invoice_id IS NOT NULL),
             'depositOnInvoices', COALESCE(sum(m.non_rev), 0)) AS money
      FROM hd h
     CROSS JOIN (VALUES ('contract'), ('room')) sc(scope)
      LEFT JOIN mrow m ON m.contract_id = h.id AND (sc.scope = 'contract' OR m.room_id = p_room_id)
     GROUP BY h.id, sc.scope
  ),
  -- F3: "Phải hoàn cọc" = refund_amount của thanh lý; phiếu lệch chỉ thành cảnh báo.
  rf AS (
    SELECT g.contract_id, jsonb_build_object(
             'depositDue', g.deposit_due,
             'depositPaid', g.deposit_paid,
             'depositOnVouchers', g.deposit_on_vouchers,
             'otherDue', g.other_due,
             'otherPaid', g.other_paid,
             'owed', CASE WHEN g.deposit_due IS NOT NULL
                          THEN GREATEST(g.deposit_due - g.deposit_paid, 0) + GREATEST(g.other_due - g.other_paid, 0) END,
             'offbook', g.offbook,
             'warnings', to_jsonb(array_remove(ARRAY[
                 CASE WHEN g.has_r AND NOT g.has_t THEN 'NO_EFFECTIVE_TERMINATION' END,
                 CASE WHEN g.has_r AND g.has_t AND abs(g.deposit_on_vouchers - GREATEST(g.deposit_due, 0)) >= 1
                      THEN 'DEPOSIT_LINE_MISMATCH' END], NULL))) AS refund
      FROM (SELECT r.contract_id,
                   bool_or(r.voucher_id IS NOT NULL) AS has_r,
                   bool_or(r.termination_id IS NOT NULL) AS has_t,
                   max(r.deposit_due) AS deposit_due,
                   COALESCE(sum(r.deposit_amount) FILTER (WHERE r.posted), 0) AS deposit_paid,
                   COALESCE(sum(r.deposit_amount), 0) AS deposit_on_vouchers,
                   COALESCE(sum(r.other_amount), 0) AS other_due,
                   COALESCE(sum(r.other_amount) FILTER (WHERE r.posted), 0) AS other_paid,
                   COALESCE(sum(r.deposit_amount + r.other_amount) FILTER (WHERE r.offbook), 0) AS offbook
              FROM rp r
             GROUP BY r.contract_id) g
  ),
  ev AS (
    SELECT 'CONTRACT_OPENED' AS type, s.from_date AS date, s.contract_id,
           NULL::numeric AS amount, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path) AS meta
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index = 0
    UNION ALL
    SELECT 'ROOM_CHANGED_IN', s.from_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path)
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index > 0
    UNION ALL
    SELECT CASE WHEN tr.id IS NOT NULL THEN 'ROOM_CHANGED_OUT' ELSE 'CONTRACT_CLOSED' END,
           s.to_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index)
      FROM seg s
      LEFT JOIN contract_transfers tr
        ON tr.contract_id = s.contract_id AND tr.old_room_id = p_room_id
       AND tr.status IN ('COMPLETED','APPROVED')
       AND COALESCE(tr.move_out_date, tr.transfer_date) = s.to_date
     WHERE s.to_date IS NOT NULL
    UNION ALL
    SELECT 'DEPOSIT_RECEIVED', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code, 'voucherId', ie.id)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source IN ('contract.deposit','deposit.reservation')
       AND ie.approval_status = 'APPROVED'
    UNION ALL
    -- Hoá đơn của PHÒNG này (H1): ISSUED = phần phát sinh mới (không gồm nợ kéo đã khai nguồn, không gồm
    -- dòng cọc); COLLECTION = tiền thật khách nộp theo ngày thu thật; cấn trừ là sự kiện riêng.
    SELECT 'INVOICE_ISSUED', COALESCE(ip.issue_date, (ip.billing_month || '-01')::date),
           ip.contract_id, ip.new_amount, true,
           jsonb_build_object('invoiceId', ip.invoice_id, 'billingMonth', ip.billing_month,
             'status', ip.status, 'kind', ip.kind, 'total', ip.total_amount,
             'carriedIn', ip.carried_in, 'depositPart', ip.non_rev, 'penalty', ip.penalty,
             'outstanding', ip.outstanding, 'carriedOpen', ip.carried_out,
             'carriedPaid', ip.carried_paid, 'sourceInvoiceIds', to_jsonb(ip.source_ids))
      FROM ip
     WHERE ip.room_id = p_room_id
    UNION ALL
    SELECT 'INVOICE_COLLECTION_POSTED', ip.cash_date, ip.contract_id, ip.rev_cash, true,
           jsonb_build_object('invoiceId', ip.invoice_id, 'billingMonth', ip.billing_month,
             'kind', ip.kind, 'depositPaid', ip.dep_paid)
      FROM ip
     WHERE ip.room_id = p_room_id AND ip.rev_cash > 0
    UNION ALL
    -- Cấn trừ trả dòng cọc trên hoá đơn (dep_offset) không phải cấn trừ doanh thu: chỉ ở meta.
    SELECT 'INVOICE_TERMINATION_OFFSET', ip.offset_date, ip.contract_id, ip.offset_paid - ip.dep_offset, true,
           jsonb_build_object('invoiceId', ip.invoice_id, 'billingMonth', ip.billing_month,
             'kind', ip.kind, 'via', ip.offset_via, 'penalty', ip.penalty, 'depositOffset', ip.dep_offset)
      FROM ip
     WHERE ip.room_id = p_room_id AND ip.offset_paid - ip.dep_offset > 0
    UNION ALL
    SELECT 'TERMINATION_REQUESTED', COALESCE(t.termination_date::date, t.created_at::date),
           t.contract_id, t.refund_amount,
           (t.status IN ('APPROVED','COMPLETED')),
           jsonb_build_object('status', t.status, 'type', t.termination_type, 'terminationId', t.id)
      FROM contract_terminations t
     WHERE t.contract_id = ANY(v_ids)
    UNION ALL
    SELECT 'SETTLEMENT_OFFSET_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code, 'voucherId', ie.id)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'DEPOSIT_FORFEIT_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code, 'voucherId', ie.id)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.forfeit_offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    -- Khoản hoàn cấn vào nợ khi thanh lý: bút toán nội bộ, không ra két.
    SELECT 'TERMINATION_REFUND_OFFSET_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('voucherId', ie.id, 'code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.rent_refund_offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'TERMINATION_EXTRA_RECEIPT_POSTED', ex.voucher_date, ex.contract_id, ex.total_amount, ex.in_books,
           jsonb_build_object('voucherId', ex.id, 'code', ex.code, 'invoiceId', ex.invoice_id,
             'billingMonth', ex.billing_month)
      FROM ex
     WHERE ex.room_id = p_room_id
    UNION ALL
    -- Phiếu hoàn khi thanh lý (H3): phần cọc và phần trả khách tiền thừa/tiền phòng là hai sự kiện.
    SELECT 'DEPOSIT_REFUND_POSTED', rp.voucher_date, rp.contract_id, rp.deposit_amount, rp.in_books,
           jsonb_build_object('code', rp.code, 'voucherId', rp.voucher_id, 'offbook', rp.offbook)
      FROM rp
     WHERE rp.posted AND rp.deposit_amount > 0
    UNION ALL
    SELECT 'CUSTOMER_REFUND_POSTED', rp.voucher_date, rp.contract_id, rp.other_amount, rp.in_books,
           jsonb_build_object('code', rp.code, 'voucherId', rp.voucher_id, 'offbook', rp.offbook)
      FROM rp
     WHERE rp.posted AND rp.other_amount > 0
    UNION ALL
    -- Hoa hồng môi giới / thưởng Sale (H2): mọi phiếu chưa huỷ; trạng thái nằm trong TÊN (Hermes chỉ giữ
    -- type/date/contractId/amount/trusted); trusted = đã ghi sổ thật.
    SELECT CASE WHEN cv.kind = 'sale' THEN 'SALE_BONUS_' ELSE 'COMMISSION_' END || cv.stage,
           cv.voucher_date, cv.contract_id, cv.total_amount, (cv.stage = 'PAID'),
           jsonb_build_object('voucherId', cv.voucher_id, 'code', cv.code, 'name', cv.name,
             'kind', cv.kind, 'link', cv.link, 'stage', cv.stage,
             'approvalStatus', cv.approval_status, 'postingStatus', cv.posting_status,
             'legacyDup', cv.legacy_dup)
      FROM app_private.contract_commission_vouchers_v1(v_room.organization_id, v_ids) cv
  ),
  ev_loc AS (
    SELECT * FROM ev
     WHERE date IS NOT NULL
       AND (p_from IS NULL OR date >= p_from)
       AND (p_to   IS NULL OR date <= p_to)
  ),
  -- Vacancy theo chuẩn island (fix #2): running max của to_date đã thấy, NULL
  -- (đang ở) coi là infinity — sau một segment mở thì không bao giờ còn gap.
  seg_sorted AS (
    SELECT s.from_date, s.to_date,
           max(COALESCE(s.to_date, 'infinity'::date)) OVER (
             ORDER BY s.from_date NULLS FIRST
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run_max_to,
           lead(s.from_date) OVER (ORDER BY s.from_date NULLS FIRST) AS next_from
      FROM seg s WHERE s.trusted
  ),
  vac AS (
    SELECT DISTINCT ss.run_max_to AS from_date, ss.next_from AS to_date,
           (ss.next_from - ss.run_max_to) AS days
      FROM seg_sorted ss
     WHERE ss.next_from IS NOT NULL
       AND ss.run_max_to <> 'infinity'::date
       AND ss.next_from > ss.run_max_to
    UNION ALL
    -- Đuôi mở: mọi segment tin cậy đều đã đóng ⇒ phòng trống từ mốc đóng muộn
    -- nhất tới hôm nay (chỉ khi thật sự đã qua ngày đó)
    SELECT max(s.to_date), NULL, (v_today - max(s.to_date))
      FROM seg s
     WHERE s.trusted
    HAVING count(*) > 0
       AND bool_and(s.to_date IS NOT NULL)
       AND max(s.to_date) < v_today
  )
  SELECT jsonb_build_object(
    'room', jsonb_build_object(
      'id', v_room.id, 'name', v_room.name,
      'buildingId', v_room.building_id, 'buildingName', v_room.building_name),
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'contracts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', h.id, 'number', h.contract_number, 'status', h.status,
        'startDate', h.start_date, 'endDate', h.end_date,
        'actualEndDate', h.actual_end_date,
        'rentPrice', h.rent_price, 'totalDeposit', h.total_deposit,
        'tenantName', h.tenant_name,
        'originalEndDate', h.original_end_date,
        'money', jsonb_build_object(
          'contract', (SELECT x.money FROM ms x WHERE x.contract_id = h.id AND x.scope = 'contract'),
          'room', (SELECT x.money FROM ms x WHERE x.contract_id = h.id AND x.scope = 'room'),
          'refund', (SELECT x.refund FROM rf x WHERE x.contract_id = h.id))) ORDER BY h.start_date)
      FROM hd h), '[]'::jsonb),
    'segments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'contractId', s.contract_id, 'contractNumber', s.contract_number,
        'segIndex', s.seg_index, 'fromDate', s.from_date, 'toDate', s.to_date,
        'sourcePath', s.source_path, 'trusted', s.trusted, 'diagnostic', s.diagnostic)
        ORDER BY s.from_date NULLS FIRST, s.seg_index)
      FROM seg s), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'type', e.type, 'date', e.date, 'contractId', e.contract_id,
        'amount', e.amount, 'trusted', e.trusted, 'meta', e.meta)
        ORDER BY e.date, e.type, e.contract_id,
                 COALESCE(e.meta->>'voucherId', e.meta->>'invoiceId', e.meta->>'terminationId', ''))
      FROM ev_loc e), '[]'::jsonb),
    'vacancies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'fromDate', v.from_date, 'toDate', v.to_date, 'days', v.days)
        ORDER BY v.from_date)
      FROM vac v), '[]'::jsonb),
    'generatedAt', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date) TO authenticated;

DO $nghiem_thu$
DECLARE v_fn regprocedure := to_regprocedure('public.get_room_cash_lifecycle_v1(uuid,date,date)');
  v_src text; v_secdef boolean; v_config text[]; v_md5 text;
  v_sig text; v_helper regprocedure; v_h record;
BEGIN
  SELECT p.prosrc, p.prosecdef, p.proconfig, md5(pg_get_functiondef(p.oid))
    INTO v_src, v_secdef, v_config, v_md5
    FROM pg_proc p WHERE p.oid = v_fn;
  IF v_secdef IS NOT TRUE
     OR v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']::text[] THEN
    RAISE EXCEPTION 'nghiem_thu: get_room_cash_lifecycle_v1 sai definer/search_path (%, %)', v_secdef, v_config;
  END IF;
  IF position('auth.uid() IS NULL' in v_src) = 0
     OR position('public.can_access_building(v_room.building_id)' in v_src) = 0
     OR position('public.can_do_on_building(''thu_tien'', ''view'', v_room.building_id)' in v_src) = 0
     OR position('public.can_do_on_building(''reports_finance'', ''profit_distribution'', v_room.building_id)' in v_src) = 0 THEN
    RAISE EXCEPTION 'nghiem_thu: get_room_cash_lifecycle_v1 thieu khoa man hinh';
  END IF;
  -- Phải đúng thân sẽ khai làm forward succession trong migration-policy.json.
  IF v_md5 <> 'e27f4c4977eaa881b1ffc8b595dbbc45' THEN
    RAISE EXCEPTION 'nghiem_thu: md5 get_room_cash_lifecycle_v1 % khac ban da khai', v_md5;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: ACL get_room_cash_lifecycle_v1 phai chi authenticated';
  END IF;
  -- Tiền phải đọc qua ba helper một nguồn.
  IF position('app_private.invoice_lifecycle_parts_v1(' in v_src) = 0
     OR position('app_private.contract_commission_vouchers_v1(' in v_src) = 0
     OR position('app_private.termination_refund_parts_v1(' in v_src) = 0 THEN
    RAISE EXCEPTION 'nghiem_thu: get_room_cash_lifecycle_v1 khong doc ba helper mot nguon';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['app_private.invoice_lifecycle_parts_v1(uuid[])',
                               'app_private.contract_commission_vouchers_v1(uuid,uuid[])',
                               'app_private.termination_refund_parts_v1(uuid[])'] LOOP
    v_helper := to_regprocedure(v_sig);
    IF v_helper IS NULL THEN
      RAISE EXCEPTION 'nghiem_thu: thieu %', v_sig;
    END IF;
    SELECT p.prosecdef, p.provolatile, p.proconfig, p.prosrc, pg_get_userbyid(p.proowner) AS owner
      INTO v_h FROM pg_proc p WHERE p.oid = v_helper;
    IF v_h.prosecdef OR v_h.provolatile <> 's'
       OR v_h.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
       OR v_h.owner <> 'postgres' THEN
      RAISE EXCEPTION 'nghiem_thu: % phai INVOKER, STABLE, search_path rong, owner postgres', v_sig;
    END IF;
    IF has_function_privilege('anon', v_helper, 'EXECUTE')
       OR has_function_privilege('authenticated', v_helper, 'EXECUTE')
       OR has_function_privilege('service_role', v_helper, 'EXECUTE') THEN
      RAISE EXCEPTION 'nghiem_thu: % khong duoc cap EXECUTE cho client', v_sig;
    END IF;
    -- Hàm đọc: không giữ khoá dòng.
    IF v_h.prosrc ~* '\mfor\s+(update|no\s+key\s+update|share|key\s+share)\M|\mlock\M' THEN
      RAISE EXCEPTION 'nghiem_thu: % khong duoc khoa dong', v_sig;
    END IF;
  END LOOP;
END
$nghiem_thu$;

NOTIFY pgrst, 'reload schema';
