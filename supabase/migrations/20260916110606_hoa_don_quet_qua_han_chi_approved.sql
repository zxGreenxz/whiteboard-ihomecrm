-- =============================================================================
-- Hoá đơn — hàm quét "quá hạn" phải nói cùng luật với recompute (H1.5).
-- Phát hiện 16/09/2026 khi gộp đợt rà soát 15/09: plan H1 đổi thứ tự nhánh
-- trong recompute_invoice_for_id (PARTIAL_PAID ưu tiên trước OVERDUE) nhưng
-- mark_overdue_invoices_v1 — được useCheckOverdueInvoices gọi mỗi lần mở trang
-- hoá đơn — vẫn đánh ('APPROVED','PARTIAL_PAID') quá hạn thành OVERDUE.
-- Hai writer ngược luật ⇒ trạng thái lật qua lật lại theo từng thao tác.
--
-- NGUỒN: thân hàm chép từ pg_get_functiondef của PRODUCTION 16/09/2026,
--   md5 bản gốc 8d94d4376789caffc541301ffe19bc11, chỉ đổi mệnh đề WHERE.
-- Kèm: org_today_v1(NULL) → org_today_v1(i.organization_id) (cùng lớp H1.7 —
--   NULL suy org từ auth.uid(), sai cho người thuộc nhiều tổ chức).
-- KHÔNG đổi chữ ký ⇒ CREATE OR REPLACE; ACL khẳng định lại. Idempotent.
-- KHÔNG backfill: hoá đơn đang OVERDUE mà đã thu một phần sẽ về PARTIAL_PAID
--   ở lần recompute kế tiếp (đo 15/09: 8 hoá đơn như vậy trên production).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.mark_overdue_invoices_v1()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  update public.invoices i
     set status = 'OVERDUE'
   where i.deleted_at is null
     -- H1.5 (15/09/2026): PARTIAL_PAID đứng TRƯỚC OVERDUE trong
     -- recompute_invoice_for_id. Nếu hàm quét này vẫn đánh hoá đơn đã thu một
     -- phần thành OVERDUE thì mỗi lần mở trang lật sang OVERDUE, mỗi lần có
     -- thu/hoàn tác lại lật về PARTIAL_PAID — hai writer nói hai luật. Phần
     -- "quá hạn" của hoá đơn thu một phần nay đọc bằng cột suy public.is_overdue.
     and i.status = 'APPROVED'
     and coalesce(i.paid_amount, 0) = 0
     and i.due_date < public.org_today_v1(i.organization_id)
     and app_private.can_edit_invoice_building_v1(i.building_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

REVOKE ALL ON FUNCTION public.mark_overdue_invoices_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_overdue_invoices_v1() TO authenticated, service_role;

-- Tự kiểm: hàm quét không còn động tới PARTIAL_PAID.
DO $tu_kiem$
DECLARE v_def text := pg_get_functiondef('public.mark_overdue_invoices_v1()'::regprocedure);
BEGIN
  -- Soi LITERAL có nháy, vì chú thích trong thân hàm có nhắc tên trạng thái.
  IF v_def LIKE '%''PARTIAL_PAID''%' THEN
    RAISE EXCEPTION 'mark_overdue_invoices_v1 vẫn đánh PARTIAL_PAID thành OVERDUE. DỪNG.';
  END IF;
  IF v_def NOT LIKE '%coalesce(i.paid_amount, 0) = 0%' THEN
    RAISE EXCEPTION 'mark_overdue_invoices_v1 thiếu điều kiện paid_amount = 0. DỪNG.';
  END IF;
END
$tu_kiem$;
