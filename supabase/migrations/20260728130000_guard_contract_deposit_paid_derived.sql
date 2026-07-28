-- =====================================================================
-- A3 — chặn ghi tay `contracts.deposit_paid` từ phía app
--
-- BUG: form "Sửa hợp đồng" gửi `deposit_paid` trong payload PATCH, trong khi
-- cột này là số DẪN XUẤT từ phiếu thu/chi cọc (recompute_contract_deposit_paid).
-- Form không có ô nhập cho nó — giá trị gửi lên chỉ là ảnh chụp lúc mở dialog,
-- nên nếu recompute chạy trong lúc dialog đang mở thì bấm Lưu sẽ ghi đè kết quả
-- đúng bằng số cũ. Đây là 1 trong 3 writer tranh nhau cùng một cột.
--
-- VÌ SAO KHÔNG DÙNG `REVOKE UPDATE(deposit_paid) ... FROM authenticated`:
-- đã đo trên production — `pg_attribute.attacl IS NOT NULL` = 0 dòng, tức
-- KHÔNG tồn tại ACL cấp cột nào; `authenticated` giữ UPDATE ở cấp BẢNG. REVOKE
-- cấp cột trong tình huống đó là NO-OP, chạy xong vẫn ghi được như cũ.
--
-- CÁCH ĐÚNG: trigger BEFORE UPDATE. Đã đo: đúng HAI hàm ghi cột này trong toàn
-- DB — recompute_contract_deposit_paid và settle_previous_debt_sources — cả hai
-- SECURITY DEFINER owner=postgres, nên chúng chạy dưới current_user='postgres'
-- và không bị chặn. Migration/script quản trị cũng chạy bằng postgres.
-- Chỉ chặn đúng đường app (authenticated/anon).
--
-- KHÔNG đụng đường TẠO hợp đồng: đây là BEFORE UPDATE, INSERT không fire.
-- =====================================================================

begin;

-- SECURITY INVOKER là BẮT BUỘC, không phải tuỳ chọn: trong hàm SECURITY DEFINER
-- do postgres sở hữu thì `current_user` LUÔN = 'postgres', kể cả khi người gọi
-- thật là 'authenticated' — guard sẽ không bao giờ chặn ai (đã đo: bi_chan=false).
-- Hàm này không cần đặc quyền nào, nó chỉ đọc NEW/OLD rồi RAISE.
create or replace function public.guard_contract_deposit_paid_derived()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $function$
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
$function$;

drop trigger if exists a00_guard_contract_deposit_paid on public.contracts;
create trigger a00_guard_contract_deposit_paid
  before update on public.contracts
  for each row
  execute function public.guard_contract_deposit_paid_derived();

commit;
