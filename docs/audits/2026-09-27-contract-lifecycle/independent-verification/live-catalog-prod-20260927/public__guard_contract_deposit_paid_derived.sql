-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.guard_contract_deposit_paid_derived() md5(prosrc)=3ad1ec545bfc4217b9d71023cc06aced
CREATE OR REPLACE FUNCTION public.guard_contract_deposit_paid_derived()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.deposit_paid IS DISTINCT FROM OLD.deposit_paid
     AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION
      'Không sửa tay được "Cọc đã thu" (% đ → % đ). Số này được TÍNH từ phiếu thu/chi cọc của hợp đồng. Muốn đổi thì thêm/sửa/huỷ phiếu cọc (hạng mục có cờ "là cọc"), hệ thống sẽ tự tính lại.',
      round(COALESCE(OLD.deposit_paid, 0))::bigint,
      round(COALESCE(NEW.deposit_paid, 0))::bigint
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$

