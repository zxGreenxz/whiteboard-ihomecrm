-- Termination — Hotfix 7z: thanh lý move-out vỡ 55000 với 55 HĐ prod.
--
-- Trigger classify_termination_payment_v1 (26bf179, 21/07 — đợt khoá chuỗi
-- hạch toán thanh lý, TRƯỚC Thu Chi V2) đối chiếu payment CT với context và đòi
-- hoá đơn nợ khớp `invoice.user_id = context.user_id` (chủ HĐ) + room_id.
-- Giả định "hoá đơn nợ luôn do chủ HĐ lập" SAI với dữ liệu thật: 71 hoá đơn nợ
-- của 55 HĐ đang hiệu lực do NGƯỜI KHÁC lập (staff lập hộ) + 1 ca room lịch sử
-- lệch ⇒ move-out các HĐ đó nổ "Payment move-out does not match the active
-- termination context".
--
-- Nới ĐÚNG PHẠM VI: bỏ ràng buộc người-lập-hoá-đơn (user_id) và room_id của
-- HOÁ ĐƠN — neo an toàn là hoá đơn thuộc ĐÚNG HỢP ĐỒNG + org + toà trong
-- context per-transaction của writer. Mọi chốt còn lại giữ nguyên: context
-- per-txn/per-pid, contract khớp chủ HĐ + phòng, method CT, ngày = move_out,
-- amount ≤ nợ còn lại, core-writer capability.

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='app_private' AND p.proname='classify_termination_payment_v1';

  IF v_def LIKE '%7z: invoice maker relax%' THEN
    RETURN; -- đã vá
  END IF;

  v_def := replace(v_def,
'JOIN public.invoices invoice
        ON invoice.id = NEW.invoice_id
       AND invoice.organization_id = context_row.organization_id
       AND invoice.user_id = context_row.user_id
       AND invoice.contract_id = context_row.contract_id
       AND invoice.building_id = context_row.building_id
       AND invoice.room_id = context_row.room_id
       AND invoice.deleted_at IS NULL',
'JOIN public.invoices invoice
        ON invoice.id = NEW.invoice_id
       AND invoice.organization_id = context_row.organization_id
       -- 7z: invoice maker relax — hoá đơn nợ có thể do staff lập hộ (70 ca
       -- prod) hoặc mang room lịch sử khác (1 ca); neo an toàn = ĐÚNG HỢP ĐỒNG
       -- trong context per-txn, không phải người lập/phòng của hoá đơn.
       AND invoice.contract_id = context_row.contract_id
       AND invoice.building_id = context_row.building_id
       AND invoice.deleted_at IS NULL');

  IF v_def NOT LIKE '%7z: invoice maker relax%' THEN
    RAISE EXCEPTION 'termination maker relax: pattern không khớp — kiểm tra thủ công';
  END IF;
  EXECUTE v_def;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
