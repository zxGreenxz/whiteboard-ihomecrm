-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.recompute_room_reservation(p_room_id uuid) md5(prosrc)=6d44c873ab6d17a1d398db0b02fcc155
CREATE OR REPLACE FUNCTION public.recompute_room_reservation(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status      text;
  v_has_active  boolean;
  v_has_holding boolean;
BEGIN
  IF p_room_id IS NULL THEN
    RETURN;
  END IF;

  SELECT status INTO v_status
  FROM rooms
  WHERE id = p_room_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- HĐ đang hiệu lực sở hữu OCCUPIED → reconcile cọc không can thiệp.
  SELECT EXISTS (
    SELECT 1 FROM contracts c
    WHERE c.room_id = p_room_id
      AND c.deleted_at IS NULL
      AND c.status IN ('ACTIVE','EXTENDED')
  ) INTO v_has_active;
  IF v_has_active THEN
    RETURN;
  END IF;

  v_has_holding := public.room_has_holding_deposit(p_room_id);

  IF v_status = 'AVAILABLE' AND v_has_holding THEN
    UPDATE rooms SET status = 'RESERVED', updated_at = NOW() WHERE id = p_room_id;
  ELSIF v_status = 'RESERVED' AND NOT v_has_holding THEN
    UPDATE rooms SET status = 'AVAILABLE', updated_at = NOW() WHERE id = p_room_id;
  END IF;
END;
$function$

