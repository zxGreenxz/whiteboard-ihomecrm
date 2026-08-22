-- =====================================================================
-- TÁCH Ô KPI "Đã hoàn cọc": bao nhiêu là CỌC, bao nhiêu KHÔNG PHẢI cọc
-- Chốt với chủ dự án 22/08/2026 (phương án B).
--
-- BỐI CẢNH: phiếu chi `system_source='termination.refund'` CỐ Ý mang mọi khoản
-- trả lại khách — chú thích trong chính hàm này viết "cả phiếu là số tiền TRẢ
-- LẠI KHÁCH". Nó đã gộp sẵn 'Hoàn tiền thừa thanh lý' (credit khách trả dư) bên
-- cạnh hoàn cọc từ trước, và đợt 20260822093000 gộp thêm 'Hoàn tiền phòng thanh
-- lý'. Ô KPI mang nhãn "Đã hoàn cọc" mà cộng cả ba là nói quá về cọc.
--
-- KHÔNG đổi `refund_total` — nó vẫn phải là TIỀN THẬT ĐÃ RA KHỎI KÉT theo quyết
-- định của chủ 30/07/2026 (§1ter.1), và đẳng thức
-- `refund_linked_total + refund_posted_orphan_total = refund_total` mà UI dùng để
-- quyết định có tin số của server hay không PHẢI giữ nguyên. Chỉ THÊM khoá.
--
-- Tách theo `income_expense_items.accounting_class` ('DEPOSIT' vs còn lại) —
-- phân loại CÓ CẤU TRÚC do trigger đặt theo `income_expense_types.is_deposit`.
-- KHÔNG khớp theo tên hạng mục: tên có hai biến thể lịch sử ('Hoàn cọc thanh lý'
-- 24 dòng và 'Hoàn trả thanh lý' 7 dòng) nên khớp tên sẽ sót mất 19.168.800đ.
--
-- Chữ ký GIỮ NGUYÊN ⇒ CREATE OR REPLACE thay tại chỗ, ACL không mất.
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_refund_forfeit_summary(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'Không thấy get_refund_forfeit_summary(uuid[]) — cây mã đã lệch. DỪNG.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.get_refund_forfeit_summary(p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT t.id                        AS term_id,
           t.contract_id               AS contract_id,
           t.termination_type          AS tt,
           t.status                    AS tstatus,
           COALESCE(t.total_deposit, 0) AS td,
           COALESCE(t.refund_amount, 0) AS ra
    FROM public.contract_terminations t
    JOIN public.contracts c ON c.id = t.contract_id
    JOIN public.rooms r ON r.id = c.room_id
    WHERE (p_building_ids IS NULL OR r.building_id = ANY(p_building_ids))
  ),
  -- Phiếu hoàn cọc còn sống (kể cả CHƯA DUYỆT — chúng là "chờ chi", phải đếm
  -- vào refund_pending_*; CANCELLED thì loại hẳn). `is_posted` = tiền ĐÃ RA KÉT.
  rv AS (
    SELECT ie.id, ie.contract_id, ie.building_id, ie.total_amount,
           (ie.approval_status = 'APPROVED'
             AND ie.posting_status = 'POSTED'
             AND ie.active_posting_id_v2 IS NOT NULL) AS is_posted,
           -- Phần CỌC của phiếu = tổng các dòng hạng mục accounting_class='DEPOSIT'.
           -- Đây là phân loại CÓ CẤU TRÚC (trigger đặt theo income_expense_types
           -- .is_deposit), KHÔNG phải khớp tên hạng mục — tên có hai biến thể lịch
           -- sử ('Hoàn cọc thanh lý' và 'Hoàn trả thanh lý') nên khớp tên sẽ sót.
           COALESCE((
             SELECT SUM(item.amount)
             FROM public.income_expense_items item
             WHERE item.income_expense_id = ie.id
               AND item.accounting_class = 'DEPOSIT'
           ), 0) AS deposit_amount
    FROM public.income_expenses ie
    WHERE ie.system_source = 'termination.refund'
      AND ie.type = 'EXPENSE'
      AND ie.deleted_at IS NULL
      AND ie.approval_status IN ('APPROVED','UNAPPROVED')
  ),
  -- Gộp theo từng hồ sơ thanh lý để `td`/`ra` không bị nhân bản khi một HĐ
  -- mang nhiều phiếu hoàn.
  per_term AS (
    SELECT b.*,
           COALESCE(SUM(rv.total_amount) FILTER (WHERE rv.is_posted), 0)     AS posted_amount,
           COUNT(rv.id)                 FILTER (WHERE rv.is_posted)          AS posted_vouchers,
           COALESCE(SUM(rv.total_amount) FILTER (WHERE NOT rv.is_posted), 0) AS unposted_amount,
           COALESCE(SUM(rv.deposit_amount) FILTER (WHERE NOT rv.is_posted), 0) AS unposted_deposit_amount,
           COUNT(rv.id)                 FILTER (WHERE NOT rv.is_posted)      AS unposted_vouchers
    FROM base b
    LEFT JOIN rv ON rv.contract_id = b.contract_id
    GROUP BY b.term_id, b.contract_id, b.tt, b.tstatus, b.td, b.ra
  ),
  -- Phiếu hoàn ĐÃ GHI SỔ nhưng KHÔNG có hồ sơ thanh lý nào — chỉ để GHI NHẬN.
  orphan AS (
    SELECT COALESCE(SUM(rv.total_amount), 0) AS amount, COUNT(*) AS cnt
    FROM rv
    WHERE rv.is_posted
      AND (p_building_ids IS NULL OR rv.building_id = ANY(p_building_ids))
      AND NOT EXISTS (SELECT 1 FROM public.contract_terminations t2
                       WHERE t2.contract_id = rv.contract_id)
  ),
  -- QUYẾT ĐỊNH CỦA CHỦ 30/07: KPI "Đã hoàn cọc" phải là TIỀN THẬT ĐÃ RA KHỎI KÉT,
  -- tức MỌI phiếu hoàn đã ghi sổ — kể cả phiếu không nối được hồ sơ thanh lý.
  -- Lý do: nếu chỉ lấy phần nối được hồ sơ (4.302.000đ) thì khai THIẾU 23.737.100đ
  -- tiền đã chi thật, tức đổi lỗi khai thừa hôm nay thành lỗi khai thiếu.
  -- Đối chiếu: refund_total = refund_linked_total + refund_posted_orphan_total.
  posted_all AS (
    SELECT COALESCE(SUM(rv.total_amount), 0) AS amount, COUNT(*) AS cnt
    FROM rv
    WHERE rv.is_posted
      AND (p_building_ids IS NULL OR rv.building_id = ANY(p_building_ids))
  )
  SELECT jsonb_build_object(
    -- ── Bốn khoá CŨ, giữ nguyên tên (frontend đang đọc) ──
    -- Tiền hoàn ĐÃ RA KÉT = TẤT CẢ phiếu hoàn POSTED (org thật: 28.039.100đ / 10).
    -- KHÔNG dùng cột GENERATED, và KHÔNG giới hạn theo hồ sơ thanh lý.
    'refund_total',  (SELECT amount FROM posted_all),
    'refund_count',  (SELECT cnt    FROM posted_all),

    -- Phần nối được hồ sơ thanh lý — đây là phần khớp đúng BẢNG bên dưới KPI
    -- (org thật: 4.302.000đ / 2 hồ sơ). Chênh lệch với refund_total chính là
    -- refund_posted_orphan_total, phải hiện thành một dòng cảnh báo trên UI.
    -- ⚠ ĐƠN VỊ: refund_linked_count đếm HỒ SƠ THANH LÝ (một hồ sơ có thể mang
    -- nhiều phiếu hoàn), KHÁC ĐƠN VỊ với refund_count / refund_posted_orphan_count
    -- (đếm PHIẾU). Cần số phiếu của phần nối được thì dùng refund_voucher_count
    -- ở dưới — đừng trộn hai đơn vị vào một phép trừ/cộng.
    'refund_linked_total', (SELECT COALESCE(SUM(posted_amount), 0) FROM per_term WHERE tt <> 'FORFEIT'),
    'refund_linked_count', (SELECT COUNT(*)                        FROM per_term WHERE tt <> 'FORFEIT' AND posted_vouchers > 0),
    'forfeit_total', (SELECT COALESCE(SUM(td), 0)                 FROM per_term WHERE tt =  'FORFEIT'),
    'forfeit_count', (SELECT COUNT(*)                             FROM per_term WHERE tt =  'FORFEIT'),

    -- ── Khoá MỚI (WS-D dùng; client cũ bỏ qua an toàn) ──
    -- Số PHIẾU hoàn đã ghi sổ NỐI ĐƯỢC hồ sơ thanh lý non-FORFEIT — tức cùng đơn
    -- vị với refund_count/refund_posted_orphan_count, và luôn ≤ refund_count
    -- (refund_count đã đếm MỌI phiếu POSTED, kể cả phiếu mồ côi). Nó có thể lớn
    -- hơn refund_linked_count khi một hồ sơ mang nhiều phiếu hoàn — đó là lý do
    -- khoá này tồn tại. (Ghi chú cũ nói "có thể > refund_count" là SAI đơn vị.)
    'refund_voucher_count',        (SELECT COALESCE(SUM(posted_vouchers), 0)  FROM per_term WHERE tt <> 'FORFEIT'),
    -- Đã tạo phiếu hoàn nhưng CHƯA ghi sổ ⇒ "chờ chi", không phải "đã hoàn".
    'refund_pending_total',        (SELECT COALESCE(SUM(unposted_amount), 0)  FROM per_term WHERE tt <> 'FORFEIT'),
    'refund_pending_count',        (SELECT COUNT(*)                           FROM per_term WHERE tt <> 'FORFEIT' AND unposted_vouchers > 0),
    -- "Net quyết toán lịch sử" = ĐÚNG công thức CŨ (cột GENERATED), giữ lại để
    -- đối chiếu chứ KHÔNG dùng làm KPI tiền ra két. Org thật = 8.290.000đ / 3.
    'refund_net_settlement_total', (SELECT COALESCE(SUM(GREATEST(0, ra)), 0)  FROM per_term WHERE tt <> 'FORFEIT'),
    'refund_net_settlement_count', (SELECT COUNT(*)                           FROM per_term WHERE tt <> 'FORFEIT'),
    -- refund_amount ÂM = khách còn nợ, phải hiện "Khách còn nợ", tuyệt đối
    -- không hiện "Đã hoàn 0đ" (2 HĐ DEMO đang bị vậy, −2.241.000đ mỗi HĐ).
    'customer_debt_total',         (SELECT COALESCE(SUM(-ra), 0)              FROM per_term WHERE tt <> 'FORFEIT' AND ra < 0),
    'customer_debt_count',         (SELECT COUNT(*)                           FROM per_term WHERE tt <> 'FORFEIT' AND ra < 0),
    -- GHI NHẬN (không sửa): phiếu hoàn đã ghi sổ mà không có hồ sơ thanh lý.
    -- Org thật hôm nay: 23.737.100đ / 8 phiếu (đo lại 30/07).
    --
    -- ĐỐI CHIẾU — PHẢI VIẾT ĐÚNG ĐƠN VỊ (sửa 30/07 sau rà vòng 2):
    --   • theo TIỀN  : refund_linked_total (4.302.000) + refund_posted_orphan_total
    --                  (23.737.100) = refund_total (28.039.100)  ← đẳng thức UI dùng
    --   • theo PHIẾU : refund_voucher_count (2) + refund_posted_orphan_count (8)
    --                  = refund_count (10)
    -- KHÔNG viết "2 + 8 = 10 phiếu" với số 2 lấy từ refund_linked_count: khoá đó
    -- đếm HỒ SƠ. Hôm nay hai số trùng nhau (2 hồ sơ mang đúng 2 phiếu) nên đẳng
    -- thức sai đơn vị vẫn "đúng" — nó vỡ ngay lần đầu một hồ sơ mang 2 phiếu hoàn.
    -- Đẳng thức theo phiếu cũng chỉ đúng khi (đo prod 30/07, cả hai = 0):
    -- phiếu hoàn POSTED gắn hồ sơ FORFEIT = 0, và HĐ có >1 hồ sơ thanh lý = 0
    -- (idx_terminations_unique_contract giữ điều thứ hai). Nếu về sau một trong
    -- hai khác 0 thì phần dư nằm ngoài cả linked lẫn orphan — phải bổ sung khoá,
    -- đừng chỉnh con số cho khớp.
    'refund_posted_orphan_total',  (SELECT amount FROM orphan),
    'refund_posted_orphan_count',  (SELECT cnt    FROM orphan),

    -- ── Tách ô KPI: bao nhiêu là CỌC, bao nhiêu KHÔNG PHẢI cọc ──
    --
    -- VÌ SAO CẦN: phiếu 'termination.refund' cố ý mang MỌI khoản trả lại khách
    -- (chú thích ở đầu hàm nói rõ: "cả phiếu là số tiền TRẢ LẠI KHÁCH"), nên nó
    -- đã gộp sẵn 'Hoàn tiền thừa thanh lý' bên cạnh hoàn cọc, và từ 22/08/2026
    -- gộp thêm 'Hoàn tiền phòng thanh lý'. Ô KPI mang nhãn "Đã hoàn cọc" mà cộng
    -- cả ba là nói quá về cọc. Giữ nguyên tổng (nó vẫn là tiền đã ra két), nhưng
    -- trả thêm số để UI bóc tách được.
    --
    -- non_deposit DERIVE TỪ total_amount, KHÔNG cộng lại từ hạng mục: nhờ vậy
    -- đẳng thức deposit + non_deposit = refund_total ĐÚNG THEO CẤU TRÚC. Nếu về
    -- sau có phiếu mà tổng hạng mục lệch total_amount thì phần lệch lộ ra ở
    -- non_deposit thay vì biến mất im lặng. (Đo prod 22/08/2026: 29/29 phiếu
    -- khớp tuyệt đối, chênh 0đ.)
    'refund_deposit_total', (
      SELECT COALESCE(SUM(rv.deposit_amount), 0)
      FROM rv
      WHERE rv.is_posted
        AND (p_building_ids IS NULL OR rv.building_id = ANY(p_building_ids))
    ),
    'refund_non_deposit_total', (
      SELECT COALESCE(SUM(rv.total_amount - rv.deposit_amount), 0)
      FROM rv
      WHERE rv.is_posted
        AND (p_building_ids IS NULL OR rv.building_id = ANY(p_building_ids))
    ),
    -- Cùng phép tách cho phần CHỜ CHI.
    --
    -- ⚠ PHẢI đi qua per_term, KHÔNG quét thẳng rv. `refund_pending_total` đếm
    -- theo HỒ SƠ THANH LÝ non-FORFEIT, còn rv chứa MỌI phiếu (kể cả phiếu mồ côi
    -- và phiếu gắn hồ sơ bỏ cọc). Bản đầu tôi quét rv và postflight bắt ngay:
    -- pending deposit + non_deposit <> refund_pending_total. Hai tập khác nhau
    -- thì dòng phụ trên UI sẽ nói khác con số ngay phía trên nó.
    'refund_pending_deposit_total', (
      SELECT COALESCE(SUM(unposted_deposit_amount), 0)
      FROM per_term WHERE tt <> 'FORFEIT'
    ),
    'refund_pending_non_deposit_total', (
      SELECT COALESCE(SUM(unposted_amount - unposted_deposit_amount), 0)
      FROM per_term WHERE tt <> 'FORFEIT'
    )
  );
$function$
;

DO $postflight$
DECLARE
  v jsonb;
BEGIN
  v := public.get_refund_forfeit_summary(NULL);

  -- Đẳng thức UI dùng để quyết định có tin số server không — phải còn nguyên.
  IF round((v->>'refund_linked_total')::numeric)
     + round((v->>'refund_posted_orphan_total')::numeric)
     <> round((v->>'refund_total')::numeric) THEN
    RAISE EXCEPTION 'Đẳng thức linked + orphan = total đã vỡ. DỪNG.';
  END IF;

  -- Đẳng thức MỚI: hai phần tách phải cộng lại đúng bằng tổng.
  IF round((v->>'refund_deposit_total')::numeric)
     + round((v->>'refund_non_deposit_total')::numeric)
     <> round((v->>'refund_total')::numeric) THEN
    RAISE EXCEPTION 'deposit + non_deposit <> refund_total. DỪNG.';
  END IF;
  IF round((v->>'refund_pending_deposit_total')::numeric)
     + round((v->>'refund_pending_non_deposit_total')::numeric)
     <> round((v->>'refund_pending_total')::numeric) THEN
    RAISE EXCEPTION 'pending deposit + non_deposit <> refund_pending_total. DỪNG.';
  END IF;

  -- Bốn khoá cũ phải còn (frontend đang đọc).
  IF NOT (v ? 'refund_total' AND v ? 'refund_count'
          AND v ? 'forfeit_total' AND v ? 'forfeit_count') THEN
    RAISE EXCEPTION 'Mất khoá cũ trong hình dạng trả về. DỪNG.';
  END IF;
END
$postflight$;

COMMIT;

NOTIFY pgrst, 'reload schema';
