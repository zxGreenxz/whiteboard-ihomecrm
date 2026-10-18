-- A first commission payment may use a different cashbook than the planned one.
-- The canonical writers already check approval, custody, period and evidence.
-- Mark only their final header stamp as POST, preserving the immutable audit and
-- the reason requirement for direct edits, attachment removal and reversal.
BEGIN;
DO $patch$
DECLARE
 signature text;
 definition text;
 old_declaration constant text := '  v_new_post bigint;';
 old_post constant text := '  v_new_post := v_ie.posting_version + 1;';
 old_response constant text := '  v_resp := jsonb_build_object(''voucherId'', v_voucher, ''postingId'', v_posting_id,';
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'public.post_approved_income_expense_v2(jsonb)',
  'public.approve_and_post_income_expense_v2(jsonb)'
 ] LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
  IF strpos(definition,'commission-canonical-first-post-v1') > 0 THEN CONTINUE; END IF;
  IF array_length(string_to_array(definition,old_declaration),1) <> 2
   OR array_length(string_to_array(definition,old_post),1) <> 2
   OR array_length(string_to_array(definition,old_response),1) <> 2
   OR strpos(definition,'account_id = v_cashbook,') = 0 THEN
   RAISE EXCEPTION 'Commission posting patch: unexpected definition for %',signature;
  END IF;
  definition:=replace(definition,old_declaration,old_declaration||E'\n  v_commission_post_context uuid;');
  definition:=replace(definition,old_post,$body$
  -- commission-canonical-first-post-v1: private context after successful posting.
  -- Never accept a client reason/context; ordinary first payment is not an edit.
  IF v_ie.posting_status = 'UNPOSTED' AND app_private.is_commission_voucher_v1(v_voucher) THEN
    v_commission_post_context := app_private.begin_commission_reason_v1(
      v_voucher, v_ie.contract_id, v_ie.commission_kind, 'POST', NULL);
  END IF;
  v_new_post := v_ie.posting_version + 1;$body$);
  definition:=replace(definition,old_response,$body$
  DELETE FROM app_private.commission_reason_contexts WHERE context_id = v_commission_post_context;
  $body$||ltrim(old_response));
  EXECUTE definition;
 END LOOP;
END
$patch$;
COMMIT;
