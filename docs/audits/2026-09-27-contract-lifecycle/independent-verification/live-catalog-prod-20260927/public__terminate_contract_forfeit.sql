-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.terminate_contract_forfeit(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb) md5(prosrc)=05d010410fcc7737036b067766433bda
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_room uuid;
  v_org uuid;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT contract_row.room_id, contract_row.organization_id
    INTO v_room, v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    PERFORM app_private.assert_contract_has_no_customer_credit_v1(
      p_contract_id, v_org
    );
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  BEGIN
    v_result := public.terminate_contract_forfeit_impl(
      p_contract_id, p_forfeit_date, COALESCE(p_extra_charges, '[]'::jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
  RETURN v_result;
END;
$function$

