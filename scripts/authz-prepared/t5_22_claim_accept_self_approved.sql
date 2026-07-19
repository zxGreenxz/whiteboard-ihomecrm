-- t5_22 — claim_canonical_income_expense_draft_v1 chấp nhận self-approved-at-birth
-- Đi kèm t5_21 (create writer sinh phiếu APPROVED theo phương án auto-duyệt đã chốt).
-- Guard 23514 cũ đòi UNAPPROVED tuyệt đối → chặn phiếu tự-duyệt ngay lúc claim.
-- Nới ĐÚNG MỘT hình dạng: APPROVED + approved_by = maker (chính người tạo), cả 2
-- overload. Không nới: approval_request / posting / posted_at_v2 / reversed /
-- system_source — vẫn từ chối như cũ. Sinh từ pg_get_functiondef bản sống 2026-07-19.

CREATE OR REPLACE FUNCTION app_private.claim_canonical_income_expense_draft_v1(p_income_expense_id uuid, p_idempotency_key text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$

declare

  v_row public.income_expenses;

  v_op app_private.canonical_write_operations;

  v_actor uuid;

begin

  if current_user <> 'ie_canonical_writer' then

    raise exception 'canonical claim capability required' using errcode = '42501';

  end if;



  v_actor := app_private.current_uid_v1();  -- DEFINER delegate; role has no auth USAGE

  if v_actor is null then

    raise exception 'authentication required' using errcode = '42501';

  end if;



  v_row := app_private.ie_lock_row_for_claim_v1(p_income_expense_id);



  if v_row.user_id is distinct from v_actor then

    raise exception 'claim actor is not the maker' using errcode = '42501';

  end if;

  -- t5_22: phuong an org = phieu thuong TU DUYET khi tao -> chap nhan them
  -- hinh dang "APPROVED tu luc sinh boi chinh maker" (self-approved-at-birth).
  if (v_row.approval_status is distinct from 'UNAPPROVED'
      and not (v_row.approval_status = 'APPROVED'
               and v_row.approved_by is not distinct from v_actor))
     or v_row.approval_request_id is not null

     or v_row.posting_id is not null

     or v_row.posted_at_v2 is not null

     or v_row.reversed_by_posting_id is not null

     or v_row.system_source is not null then

    raise exception 'row is not claimable as canonical draft' using errcode = '23514';

  end if;

  if v_row.source_payload_hash is null

     or v_row.source_payload_hash !~ '^[0-9a-f]{32}$' then

    raise exception 'row lacks canonical payload hash' using errcode = '23514';

  end if;



  v_op := app_private.ie_lock_operation_for_claim_v1(

    v_row.organization_id, v_row.building_id::text, v_actor,

    p_idempotency_key, v_row.source_payload_hash);



  insert into app_private.income_expense_flow_ownership (

    income_expense_id, organization_id, writer_operation,

    payload_hash_scheme, payload_hash_value,

    maker_user_id, claimed_by_user_id, correlation_id)

  values (

    v_row.id, v_row.organization_id, v_op.operation,

    'PG_MD5_JSONB_TEXT_V1', v_row.source_payload_hash,

    v_row.user_id, v_actor, null);



  insert into app_private.income_expense_flow_ownership_events (

    organization_id, income_expense_id, event_type, actor_user_id, detail)

  values (

    v_row.organization_id, v_row.id, 'FLOW_CLAIMED', v_actor,

    jsonb_build_object('operation', v_op.operation,

                       'idempotency_key', p_idempotency_key));

end;

$function$;

CREATE OR REPLACE FUNCTION app_private.claim_canonical_income_expense_draft_v1(p_income_expense_id uuid, p_idempotency_key text, p_capability_nonce text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$

declare

  v_row public.income_expenses;

  v_op app_private.canonical_write_operations;

  v_actor uuid;

begin

  if not app_private.has_ie_claim_capability_v1(p_capability_nonce) then

    raise exception 'canonical claim capability required' using errcode = '42501';

  end if;



  v_actor := app_private.current_uid_v1();

  if v_actor is null then

    raise exception 'authentication required' using errcode = '42501';

  end if;



  v_row := app_private.ie_lock_row_for_claim_v1(p_income_expense_id);

  if v_row.user_id is distinct from v_actor then

    raise exception 'claim actor is not the maker' using errcode = '42501';

  end if;

  -- t5_22: phuong an org = phieu thuong TU DUYET khi tao -> chap nhan them
  -- hinh dang "APPROVED tu luc sinh boi chinh maker" (self-approved-at-birth).
  if (v_row.approval_status is distinct from 'UNAPPROVED'
      and not (v_row.approval_status = 'APPROVED'
               and v_row.approved_by is not distinct from v_actor))
     or v_row.approval_request_id is not null

     or v_row.posting_id is not null

     or v_row.posted_at_v2 is not null

     or v_row.reversed_by_posting_id is not null

     or v_row.system_source is not null then

    raise exception 'row is not claimable as canonical draft' using errcode = '23514';

  end if;

  if v_row.source_payload_hash is null

     or v_row.source_payload_hash !~ '^[0-9a-f]{32}$' then

    raise exception 'row lacks canonical payload hash' using errcode = '23514';

  end if;



  v_op := app_private.ie_lock_operation_for_claim_v1(

    v_row.organization_id, v_row.building_id::text, v_actor,

    p_idempotency_key, v_row.source_payload_hash);



  insert into app_private.income_expense_flow_ownership (

    income_expense_id, organization_id, writer_operation,

    payload_hash_scheme, payload_hash_value,

    maker_user_id, claimed_by_user_id, correlation_id)

  values (

    v_row.id, v_row.organization_id, v_op.operation,

    'PG_MD5_JSONB_TEXT_V1', v_row.source_payload_hash,

    v_row.user_id, v_actor, null);



  insert into app_private.income_expense_flow_ownership_events (

    organization_id, income_expense_id, event_type, actor_user_id, detail)

  values (

    v_row.organization_id, v_row.id, 'FLOW_CLAIMED', v_actor,

    jsonb_build_object('operation', v_op.operation,

                       'idempotency_key', p_idempotency_key));

end;

$function$
;
