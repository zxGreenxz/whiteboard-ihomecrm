-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.trg_room_status_reconcile() md5(prosrc)=a684104a17c7d7334750d9210d3ec572
CREATE OR REPLACE FUNCTION public.trg_room_status_reconcile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Trước 30/08/2026 hàm này còn phát "CRM occurrence" cho OpenClaw mỗi khi
  -- phòng chuyển về AVAILABLE. OpenClaw đã xóa; việc còn lại của trigger là
  -- đồng bộ lại reservation của phòng sau khi trạng thái đổi.
  perform public.recompute_room_reservation(NEW.id);
  return null;
end;
$function$

