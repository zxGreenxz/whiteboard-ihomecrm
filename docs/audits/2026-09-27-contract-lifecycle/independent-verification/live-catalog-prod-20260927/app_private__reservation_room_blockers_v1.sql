-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- app_private.reservation_room_blockers_v1(p_room uuid, p_exclude_voucher uuid) md5(prosrc)=9790b052a0c2334b4d2b53b57e327428
CREATE OR REPLACE FUNCTION app_private.reservation_room_blockers_v1(p_room uuid, p_exclude_voucher uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE b jsonb:='[]'; v_status text;
BEGIN
  IF p_room IS NULL THEN RETURN '["ROOM_UNAVAILABLE"]'::jsonb; END IF;
  SELECT status INTO v_status FROM public.rooms WHERE id=p_room AND deleted_at IS NULL;
  IF v_status IS NULL OR v_status NOT IN ('AVAILABLE','RESERVED') THEN b:=b||'["ROOM_UNAVAILABLE"]'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM public.contracts WHERE room_id=p_room AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED')) THEN
    b:=b||'["ACTIVE_CONTRACT"]'::jsonb;
  END IF;
  IF EXISTS(SELECT 1 FROM public.income_expenses ie WHERE ie.room_id=p_room AND ie.id IS DISTINCT FROM p_exclude_voucher
      AND ie.contract_id IS NULL AND ie.deleted_at IS NULL AND ie.type='INCOME'
      AND COALESCE(ie.approval_status,'')<>'CANCELLED' AND public.ie_has_deposit_item(ie.id)
      AND NOT app_private.reservation_deposit_is_settled_v1(ie.id))
    OR EXISTS(SELECT 1 FROM public.deposits d WHERE d.room_id=p_room AND d.contract_id IS NULL AND d.deleted_at IS NULL AND d.status IN ('PENDING','CONFIRMED')) THEN
    b:=b||'["OTHER_DEPOSIT"]'::jsonb;
  END IF;
  IF EXISTS(SELECT 1 FROM public.room_reservation_holds h WHERE h.room_id=p_room
    AND h.status IN ('PENDING_APPROVAL','APPROVED') AND h.expires_at>now()) THEN b:=b||'["UNRELATED_HOLD"]'::jsonb; END IF;
  RETURN b;
END $function$

