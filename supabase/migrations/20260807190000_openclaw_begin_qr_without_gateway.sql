-- Cùng một phụ thuộc media gateway, ở một cửa nữa mà đợt trước tôi khoanh sót.
--
-- 20260807180000 nới điều kiện chốt NGẮT kết nối, nhưng `openclaw_begin_qr_login_v1`
-- cũng từ chối mọi lần lấy mã QR khi còn bản thu hồi chưa được ký — ở HAI mệnh đề,
-- cả hai viết dạng phủ định `revocation.acknowledged_at is null`, nên phép tìm theo
-- `acknowledged_at is not null` của đợt trước không thấy.
--
-- Hệ quả đo được trên production: tài khoản đã về DISCONNECTED nhưng bấm "Lấy mã QR"
-- vẫn trả 404 QR_NOT_AVAILABLE, vì Edge ánh xạ MỌI mã lỗi SQL lạ về đúng một câu đó
-- (nhánh default của mapRpcError) — lỗi thật P0002 "query returned no rows" bị che.
--
-- Dùng lại đúng cờ đã khai ở migration trước: gateway ON thì đòi biên nhận y như cũ.

begin;

CREATE OR REPLACE FUNCTION public.openclaw_begin_qr_login_v1(p_request jsonb, p_client_operation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select app_private.openclaw_actor_id_v1()); v_org uuid := (p_request ->> 'organizationId')::uuid;
  v_operation jsonb; v_request_hash text; v_account public.openclaw_accounts%rowtype;
  v_cell public.openclaw_runtime_cells%rowtype; v_lease public.openclaw_runtime_leases%rowtype;
  v_command_id uuid := gen_random_uuid(); v_challenge_id uuid := gen_random_uuid();
  v_payload jsonb; v_payload_bytes bytea; v_result jsonb;
  v_issued_at timestamptz := statement_timestamp();
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','cellId','browserNonceHash','authSessionHash','disclosureVersion'],
    array['version','organizationId','accountId','cellId','browserNonceHash','authSessionHash','disclosureVersion']
  );
  if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform app_private.lock_org_for_decision_v1(v_org);
  perform app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_connections', 'bắt đầu đăng nhập QR OpenClaw Zalo');
  v_operation := app_private.openclaw_begin_client_operation_v1(
    v_org, v_actor, 'openclaw_begin_qr_login_v1', p_client_operation_id, p_request
  );
  if coalesce((v_operation ->> 'conflict')::boolean, false) then return v_operation; end if;
  if coalesce((v_operation ->> 'isReplay')::boolean, false) then return v_operation -> 'safeResult'; end if;
  v_request_hash := v_operation ->> 'requestHash';
  select account.* into strict v_account from public.openclaw_accounts account
  where account.organization_id = v_org and account.id = (p_request ->> 'accountId')::uuid
    and account.is_active
    and account.connection_state in ('DISCONNECTED','QR_PENDING')
    and not exists (
      select 1 from public.openclaw_generation_revocations revocation
      where revocation.organization_id=account.organization_id
        and revocation.account_id=account.id
        and revocation.principal_kind='CHANNEL'
        and revocation.revocation_kind in ('SESSION','MEDIA')
        and revocation.acknowledged_at is null
        and app_private.openclaw_media_revocation_gateway_enabled_v1()
    )
    and not exists (
      select 1
      from public.openclaw_runtime_commands command
      join public.openclaw_generation_revocations revocation
        on revocation.organization_id=command.organization_id
       and revocation.command_id=command.id
       and revocation.account_id=command.account_id
       and revocation.cell_id=command.cell_id
       and revocation.principal_kind='CHANNEL'
       and revocation.revocation_kind='SESSION'
      where command.organization_id=account.organization_id
        and command.account_id=account.id
        and command.command_kind='DISCONNECT'
        and (
          (revocation.acknowledged_at is null
            and app_private.openclaw_media_revocation_gateway_enabled_v1())
          or not (
            (command.state='ACKNOWLEDGED'
              and command.effect_disposition='PROVIDER_CONFIRMED')
            or (command.state in ('FAILED','REVOKED')
              and command.effect_disposition='SEALED_UNCONFIRMED'
              and command.sealed_at is not null)
          )
        )
    )
  for update;
  select cell.* into strict v_cell from public.openclaw_runtime_cells cell
  where cell.organization_id = v_org and cell.account_id = v_account.id
    and cell.id = (p_request ->> 'cellId')::uuid and cell.is_current and cell.state = 'READY'
  for update;
  select lease.* into strict v_lease from public.openclaw_runtime_leases lease
  where lease.organization_id = v_org and lease.account_id = v_account.id
    and lease.cell_id = v_cell.id and lease.status = 'ACTIVE'
    and lease.expires_at > statement_timestamp() for update;
  if v_account.disclosure_acknowledged_version is distinct from v_account.disclosure_version
     or v_account.disclosure_acknowledged_at is null
  then
    raise exception 'current disclosure acknowledgement required' using errcode = '42501';
  end if;
  if (p_request ->> 'browserNonceHash') !~ '^[0-9a-f]{64}$'
     or (p_request ->> 'authSessionHash') !~ '^[0-9a-f]{64}$'
     or (p_request ->> 'disclosureVersion')::integer <> v_account.disclosure_version
  then raise exception 'QR request binding mismatch' using errcode = '40001'; end if;
  update public.openclaw_qr_challenges
  set active_slot = false, challenge_status = 'REVOKED', revoked_at = statement_timestamp(),
      ciphertext=null,cipher_iv=null,auth_tag=null,
      material_version=0,material_published_at=null
  where organization_id = v_org and account_id = v_account.id and active_slot;
  update public.openclaw_runtime_commands command set
    state='REVOKED',claim_token_hash=null,lease_expires_at=null,
    acknowledged_at=null,updated_at=statement_timestamp()
  where command.organization_id=v_org and command.account_id=v_account.id
    and command.command_kind='QR_LOGIN'
    and command.state in ('PENDING','LEASED','ACKNOWLEDGED')
    and exists (
      select 1 from public.openclaw_qr_challenges challenge
      where challenge.organization_id=command.organization_id
        and challenge.account_id=command.account_id
        and challenge.runtime_command_id=command.id
        and challenge.challenge_status='REVOKED'
        and challenge.revoked_at=statement_timestamp()
    );
  v_payload := jsonb_build_object(
    'version', 1, 'challengeId', v_challenge_id, 'browserNonceHash', p_request ->> 'browserNonceHash'
  );
  v_payload_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
  insert into public.openclaw_runtime_commands (
    id, organization_id, account_id, cell_id, command_key, command_kind,
    source_session_generation,target_session_generation,
    source_connection_generation,target_connection_generation,
    expected_session_generation, expected_connection_generation, expected_fencing_token,
    payload, payload_bytes, payload_hash, created_by
  ) values (
    v_command_id, v_org, v_account.id, v_cell.id, 'qr:' || v_challenge_id::text,
    'QR_LOGIN',v_account.session_generation,v_account.session_generation,
    v_account.connection_generation,v_account.connection_generation+1,
    v_account.session_generation, v_account.connection_generation,
    v_lease.fencing_token, v_payload, v_payload_bytes,
    encode(extensions.digest(v_payload_bytes, 'sha256'), 'hex'), v_actor
  );
  insert into public.openclaw_qr_challenges (
    id, organization_id, account_id, cell_id, runtime_command_id,
    challenge_version, challenge_status, active_slot,
    ciphertext, cipher_iv, auth_tag, material_version, material_published_at,
    actor_id, auth_session_hash, browser_nonce_hash, issued_at, expires_at
  ) values (
    v_challenge_id, v_org, v_account.id, v_cell.id, v_command_id,
    v_account.connection_generation + 1, 'PENDING', true,
    null, null, null, 0, null, v_actor,
    p_request ->> 'authSessionHash', p_request ->> 'browserNonceHash',
    v_issued_at, v_issued_at + interval '120 seconds'
  );
  update public.openclaw_accounts
  set connection_state = 'QR_PENDING', effective_mode = 'DRAFT_ONLY',
      connection_generation = connection_generation + 1, updated_at = statement_timestamp()
  where organization_id = v_org and id = v_account.id;
  v_result := jsonb_build_object(
    'version', 1, 'organizationId', v_org, 'accountId', v_account.id,
    'cellId', v_cell.id, 'challengeId', v_challenge_id,
    'runtimeCommandId', v_command_id,
    'issuedAt',v_issued_at,'expiresAt',v_issued_at + interval '120 seconds',
    'status', 'PENDING'
  );
  return app_private.openclaw_finish_browser_write_v1(
    v_org, v_actor, 'openclaw_begin_qr_login_v1', p_client_operation_id,
    v_request_hash, 'OPENCLAW_QR_LOGIN_BEGUN', v_result
  );
end;
$function$;

commit;
