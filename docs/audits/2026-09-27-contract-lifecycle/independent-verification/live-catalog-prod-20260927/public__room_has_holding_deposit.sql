-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.room_has_holding_deposit(p_room_id uuid) md5(prosrc)=969b762fdcb47c536d26874b1b193183
CREATE OR REPLACE FUNCTION public.room_has_holding_deposit(p_room_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_room_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.deposits d
      WHERE d.room_id = p_room_id
        AND d.deleted_at IS NULL
        AND d.contract_id IS NULL
        AND d.status IN ('PENDING','CONFIRMED')
    )
    OR EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.room_id = p_room_id
        AND ie.deleted_at IS NULL
        AND ie.contract_id IS NULL
        AND ie.type = 'INCOME'
        AND COALESCE(ie.approval_status, '') <> 'CANCELLED'
        AND public.ie_has_deposit_item(ie.id)
        AND NOT app_private.reservation_deposit_is_settled_v1(ie.id)
    )
  );
$function$

