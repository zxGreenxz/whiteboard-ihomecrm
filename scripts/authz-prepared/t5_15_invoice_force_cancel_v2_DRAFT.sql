-- t5_15_invoice_force_cancel_v2_DRAFT.sql — Force-cancel HĐ KHÔNG xoá lịch sử tiền
--
-- ⚠️ DRAFT — CHƯA APPLY PROD. Chờ review. Nền tảng khảo sát:
--    docs/authorization/TRANCHE-INVOICE-N2-SURVEY-2026-07-18.md (mục 2).
--    OWNER ĐÃ CHỐT: phương án (a) — compensating reversal (giữ lịch sử).
--
-- VẤN ĐỀ v1 (public.super_admin_force_cancel_invoice — GIỮ NGUYÊN, không drop):
--   1) DELETE excess_amounts WHERE source_invoice_id = HĐ
--   2) HARD-DELETE payments (comment thừa nhận bypass FK ON DELETE RESTRICT nhờ
--      SECURITY DEFINER) → trigger recompute reset paid=0/APPROVED
--   3) UPDATE status='CANCELLED'
--   → VI PHẠM "không xoá lịch sử tiền": phiếu thu biến mất, không audit hoàn tiền.
--   → CÒN hỏng thêm: payments nay có trigger a00_payment_canonical_link_guard
--     (BEFORE DELETE) raise 55000 nếu payment gắn voucher canonical → v1 có thể
--     FAIL ngay ở bước DELETE với payment đã sinh phiếu thu canonical.
--
-- v2 (public.super_admin_force_cancel_invoice_v2) — KHÁC v1 CÓ CHỦ ĐÍCH:
--   • super-admin-only (y hệt v1: public.is_super_admin()).
--   • KHÔNG xoá payments. Mỗi payment CÒN HIỆU LỰC (chưa từng bị hoàn tác) →
--     gọi public.reverse_invoice_payment_v3 → sinh phiếu chi bù 'Tiền thối'
--     (EXPENSE APPROVED) mà recompute_invoice_for_id TRỪ khỏi paid_amount; payment
--     GỐC còn nguyên + ghi app_private.payment_reversals (audit + anti-double).
--   • excess_amounts: chỉ DELETE row NGUỒN-TỪ-HĐ THUẦN (source_payment_id IS NULL —
--     vd row tiêu credit -X do create_invoice_v1 sinh). Row source_payment_id KHÁC
--     NULL (credit gốc từ payment + bản negate compensating do reverse_v3 vừa tạo)
--     PHẢI GIỮ để net đúng. → Xem "QUYẾT ĐỊNH excess_amounts" bên dưới.
--   • recompute → paid_amount net = Σpayments − Σrefund = 0; rồi UPDATE CANCELLED.
--   • Phục hồi (restore_invoice_v1) sau này: payment + refund đều còn → recompute
--     vẫn net paid=0 (HĐ phục hồi hiện "chưa thu"), GIỐNG hệ quả v1 nhưng CÓ audit.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ ⚠️ HAI TIỀN ĐIỀU KIỆN RUNTIME (BLOCKER) — phải chốt trước khi apply/bật:    │
-- │  [B1] Flag 'invoice.reverse_payment.v1' đang mode=OFF (verified prod) →      │
-- │       evaluate_feature_route trả 'LEGACY' → reverse_invoice_payment_v3 raise │
-- │       55000 "…hoàn tác chưa bật…" → v2 SẼ FAIL. ⇒ Phải bật flag reverse-     │
-- │       payment (đủ commit_sha/migration_sha256/maintenance_window/approval)   │
-- │       TRƯỚC, hoặc chuyển v2 sang INLINE (xem TODO-REVIEW [A]).               │
-- │  [B2] reverse_invoice_payment_v3 authorize 'thu_tien.undo' theo ACTOR trong  │
-- │       org của HĐ. authorize_tenant_action_v3 KHÔNG có nhánh bypass super-    │
-- │       admin ⇒ super-admin (bảng super_admins, GLOBAL) KHÔNG đương nhiên có   │
-- │       'thu_tien.undo' trong org đích → reverse raise 42501 → v2 FAIL. Đây là │
-- │       kịch bản CHÍNH của force-cancel (super-admin thao tác chéo org). ⇒     │
-- │       Phải cấp super-admin quyền thu_tien.undo, HOẶC thêm bypass super-admin │
-- │       vào authorize_tenant_action_v3/reverse, HOẶC chọn INLINE [A].          │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- Ghi chú call-graph: super_admin_force_cancel_invoice_v2 là SECURITY DEFINER owner
--   =postgres → gọi reverse_invoice_payment_v3 (chỉ grant postgres) OK. auth.uid()
--   KHÔNG đổi qua DEFINER nên [B2] vẫn theo super-admin thật (đúng như phân tích).

begin;

-- ============================================================================
-- super_admin_force_cancel_invoice_v2(uuid) — compensating reversal, giữ lịch sử.
-- ============================================================================
create or replace function public.super_admin_force_cancel_invoice_v2(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $function$
declare
  v_actor uuid := auth.uid();
  v_status invoice_status;
  v_deleted timestamptz;
  v_invnum text;
  v_reason text;
  v_pay record;
  v_key text;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode='42501';
  end if;
  if not public.is_super_admin() then
    raise exception 'Chỉ super admin được phép xoá hoá đơn ở trạng thái này';
  end if;

  -- Lock HĐ + validate (mirror guard v1: tồn tại / chưa soft-delete / chưa CANCELLED).
  select status, deleted_at, invoice_number
    into v_status, v_deleted, v_invnum
    from public.invoices where id = p_invoice_id for update;
  if not found or v_status is null then
    raise exception 'Hoá đơn không tồn tại';
  end if;
  if v_deleted is not null then
    raise exception 'Hoá đơn đã bị xoá trước đó';
  end if;
  if v_status = 'CANCELLED' then
    raise exception 'Hoá đơn đã ở trạng thái Đã huỷ';
  end if;

  v_reason := 'Super-admin force-cancel HĐ ' || coalesce(v_invnum, p_invoice_id::text);

  -- (1) Hoàn tác từng payment CÒN HIỆU LỰC (chưa có bản ghi trong payment_reversals
  --     → retry-safe + bỏ qua payment đã bị hoàn tác thủ công trước đó). Mỗi lần
  --     reverse_invoice_payment_v3: tạo phiếu chi bù 'Tiền thối', giữ payment gốc,
  --     negate credit-từ-payment, recompute_invoice_for_id. idempotency_key duy nhất
  --     theo (invoice,payment) — ASCII-safe khớp ^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$.
  for v_pay in
    select p.id, p.payment_date
      from public.payments p
     where p.invoice_id = p_invoice_id
       and not exists (
         select 1 from app_private.payment_reversals pr
          where pr.original_payment_id = p.id)
     order by p.payment_date nulls first, p.id
  loop
    v_key := 'fc2-' || p_invoice_id::text || '-' || v_pay.id::text;
    perform public.reverse_invoice_payment_v3(v_pay.id, v_reason, v_key);
  end loop;

  -- (2) QUYẾT ĐỊNH excess_amounts (khảo sát yêu cầu đọc kỹ legacy rồi chốt + comment):
  --     GIỮ tinh thần v1 (xoá credit nguồn-từ-HĐ) NHƯNG THU HẸP còn source_payment_id
  --     IS NULL. Lý do:
  --       • Row nguồn-từ-HĐ thuần = bút toán TIÊU credit do create_invoice_v1 sinh
  --         (amount âm, source_payment_id NULL). HĐ bị huỷ ⇒ khoản tiêu này phải mất
  --         ⇒ trả credit về hợp đồng. Vì v2 chỉ set CANCELLED (KHÔNG soft-delete),
  --         mà useExcessAmount chỉ bỏ row có source_invoice ĐÃ soft-delete (không xét
  --         CANCELLED) → nếu KHÔNG xoá, số dư credit hợp đồng sẽ sai.
  --       • AFTER DELETE có trigger excess_amounts_invoice_audit_trigger ⇒ việc xoá
  --         VẪN được ghi audit ledger (lịch sử không mất, chỉ rời bảng sống).
  --       • KHÔNG đụng row source_payment_id KHÁC NULL: đó là (a) credit GỐC từ
  --         payment và (b) bản NEGATE bù mà reverse_invoice_payment_v3 vừa chèn
  --         (source_invoice_id = HĐ, source_payment_id = payment). Xoá chúng sẽ phá
  --         net → sai số dư. Vì thế lọc source_payment_id IS NULL là BẮT BUỘC.
  delete from public.excess_amounts
   where source_invoice_id = p_invoice_id
     and source_payment_id is null;

  -- (3) Recompute (an toàn cả khi HĐ chưa thu đồng nào: vòng lặp trống) rồi override
  --     status → CANCELLED (mirror bước cuối v1: để recompute set paid xong mới huỷ).
  perform public.recompute_invoice_for_id(p_invoice_id);
  update public.invoices set status = 'CANCELLED' where id = p_invoice_id;
end;
$function$;

revoke all on function public.super_admin_force_cancel_invoice_v2(uuid) from public;
revoke all on function public.super_admin_force_cancel_invoice_v2(uuid) from anon;
grant execute on function public.super_admin_force_cancel_invoice_v2(uuid) to authenticated;

commit;

-- ============================================================================
-- TODO-REVIEW (chốt trước khi apply)
-- ----------------------------------------------------------------------------
-- [A] LỰA CHỌN LỚN: reverse_v3-loop (bản này) vs INLINE. Bản này TRUNG THÀNH với
--     chỉ đạo owner ("vòng lặp reverse_invoice_payment_v3") + tối đa tái dùng
--     đường audited, NHƯNG phụ thuộc [B1]+[B2] (flag + quyền actor). Nếu owner KHÔNG
--     muốn bật flag reverse-payment hoặc cấp thu_tien.undo cho super-admin, chuyển
--     sang INLINE: lặp payment → tự tạo phiếu chi 'Tiền thối' (get-or-create type +
--     income_expenses EXPENSE APPROVED + income_expense_items unit_price=amount) +
--     insert app_private.payment_reversals + negate excess source_payment_id, rồi
--     recompute — Y HỆT thân reverse_invoice_payment_v3 NHƯNG BỎ cổng
--     evaluate_feature_route và authorize 'thu_tien.undo' (đã chặn bằng is_super_admin
--     ở đầu hàm). INLINE độc lập, luôn chạy được cho super-admin chéo org — theo
--     phân tích đây là bản KHUYẾN NGHỊ để force-cancel thực sự dùng được. CHỜ OWNER.
--
-- [B1] Flag 'invoice.reverse_payment.v1' = OFF ⇒ reverse_v3 raise 55000 → v2 FAIL.
--      Bật flag (mode ON + đủ commit_sha/migration_sha256/maintenance_window_id/
--      approval_reference, else evaluate_feature_route trả FROZEN) TRƯỚC khi wire v2.
--
-- [B2] super-admin có thể KHÔNG có 'thu_tien.undo' trong org đích (authorize_tenant_
--      action_v3 không bypass super-admin) ⇒ reverse_v3 raise 42501 → v2 FAIL. Cấp
--      quyền hoặc thêm bypass super-admin, hoặc chọn INLINE [A]. ĐÂY LÀ BLOCKER
--      NẶNG NHẤT vì force-cancel sinh ra để super-admin thao tác chéo org.
--
-- [C] Client wiring (FE, ngoài file SQL này): useForceCancelInvoice
--     (src/hooks/useInvoices.ts:1544) đang gọi RPC 'super_admin_force_cancel_invoice'
--     (v1). Đổi sang 'super_admin_force_cancel_invoice_v2'. Toast hiện nói "payment…
--     đã bị xoá" — sửa lại cho đúng ("đã hoàn tác, giữ lịch sử"). KHÔNG drop v1 trong
--     file này (giữ để rollback nhanh); cân nhắc drop v1 ở tranche dọn dẹp sau cutover.
--
-- [D] Hệ quả RESTORE: sau v2 (payment còn + phiếu 'Tiền thối' bù) nếu restore_invoice_v1
--     → recompute net paid=0 ⇒ HĐ phục hồi "chưa thu" (giống hệ quả v1). Nếu muốn
--     restore khôi phục cả trạng thái đã-thu thì phải hoàn-tác-cái-hoàn-tác (đảo phiếu
--     'Tiền thối') — NGOÀI phạm vi nhịp này, ghi nhận để owner biết trade-off.
--
-- [E] Grant: theo mẫu t5_09 (revoke public/anon, grant authenticated). v1 prod có
--     thêm service_role — bản này bỏ (service_role bypass RLS, hiếm gọi RPC). Xác nhận.
-- ============================================================================
