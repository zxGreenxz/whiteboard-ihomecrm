-- Restore the application database contract before the 15 settlement migrations.
-- All fourteen pg_get_functiondef hashes are pinned to the pre-feature snapshots.
-- DDL only on named functions, three added triggers and their dedicated role.
-- No business INSERT/UPDATE/DELETE, no table/column changes, no CASCADE.
-- Lock business tables briefly so the before/after row fingerprints share one state.
-- Execute through migrate:forward with its fresh backup, digest and transaction guards.
BEGIN;
SET LOCAL search_path=pg_catalog,public;
CREATE TEMP TABLE IF NOT EXISTS restore_settlement_data_witness (relation_name text PRIMARY KEY, fingerprint jsonb NOT NULL) ON COMMIT DROP;
TRUNCATE pg_temp.restore_settlement_data_witness;
DO $preflight$
DECLARE f record; p record; r record; digest jsonb;
BEGIN
 FOR f IN SELECT * FROM (VALUES ('app_private.guard_income_expense_owned_payload()','18b3e1c11f3e698f1daf2cd082313448','fb01ae8c9de7b283d19ade8195eba726','postgres','{postgres=X/postgres}'),
('public.reverse_posted_income_expense_v2(uuid,uuid,date,text,text)','50cd5cb62b41700f0d2130ccdad44419','9fcc9d100dd7fd3a858038a10dc6e701','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('app_private.finance_v2_post_manual_voucher(income_expenses,uuid,uuid,uuid,date,uuid[],text)','528e457cc02ddcec3c0cd2c67044ae09','c2d88ccaae0d8c8a0d425ac4d6cd7f7f','postgres','{postgres=X/postgres}'),
('public.get_room_cash_lifecycle_v1(uuid,date,date)','4219809847a848ab9439ba2eb1a78213','2c5c0f54d345ca35c3cac80232c3d837','ie_action_snapshot_reader','{ie_action_snapshot_reader=X/ie_action_snapshot_reader,authenticated=X/ie_action_snapshot_reader}'),
('app_private.reservation_create_leg_v1(uuid,text,uuid,uuid,date,numeric)','b12a257d0820acdf10a625ae68126648','61e14ad271c7b79e5931f09ab6d0bed2','postgres','{postgres=X/postgres}'),
('public.request_income_expense_changes_v2(uuid,bigint,text,jsonb,text)','a7b885abecda8b1b8a5a6545f3c76975','c3769605c5ac35134935d49a32a5d1d9','postgres','{postgres=X/postgres,authenticated=X/postgres}'),
('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)','79dda3e01cdcdee2d36d55dd7a7df670','cdc2896ff50e836cb782219683ba5474','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)','3ed571ba5d2262ec5a125a4804ef9f4a','fbaed9b582feab422372165eb55a8288','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)','8e71112be4f8244298b347c47e15dd05','c134aa5857144c2b8f66145f0e9feab5','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('app_private.finance_v2_birth_provenance_bridge()','502b59b43551d64bf602da4b01f7d536','a8e8c8c66676f566e52edf888bc43579','postgres',NULL),
('public.resubmit_income_expense_v2(uuid,bigint,jsonb,text)','d3a9226f0b75940c354e5c81497097b4','722dcc99bec52a059f7c45c08d085f80','postgres','{postgres=X/postgres,authenticated=X/postgres}'),
('public.list_cashbooks_for_expense_v2()','b8a05055824b9bcf2f3710a4f369b267','d3e69a10cf4e1cb6c99698df62d0602a','postgres','{postgres=X/postgres,authenticated=X/postgres}'),
('public.get_room_residence_segments_v1(uuid[])','83dd49ab595599c2b8bf5f37bd6cd993','8ee45965dbcac4333dfac3a25d662f29','ie_action_snapshot_reader','{ie_action_snapshot_reader=X/ie_action_snapshot_reader,authenticated=X/ie_action_snapshot_reader}'),
('app_private.reservation_pay_refund_v1(uuid,uuid,date)','3e2484a389ff3ed00532f62f61afd6ee','94b846b86cf718a8b7a43e7bb2fbe0b9','postgres','{postgres=X/postgres}')) expected(signature,current_hash,restored_hash,current_owner,current_acl) LOOP
  SELECT md5(pg_get_functiondef(oid)) AS hash,proowner::regrole::text AS owner,proacl::text AS acl INTO p FROM pg_proc WHERE oid=to_regprocedure(f.signature);
  IF NOT FOUND OR p.hash NOT IN(f.current_hash,f.restored_hash) THEN RAISE EXCEPTION 'Restore: function definition drift: %',f.signature; END IF;
  IF p.hash=f.current_hash AND (p.owner IS DISTINCT FROM f.current_owner OR p.acl IS DISTINCT FROM f.current_acl) THEN RAISE EXCEPTION 'Restore: current function ownership/ACL drift: %',f.signature; END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES ('public.read_contract_settlement_page_v1(uuid,uuid[],text,text,integer)','0fe9c230ab4675aadc814467c96ef89d','postgres','{postgres=X/postgres,authenticated=X/postgres}'),
('app_private.is_income_expense_review_operation_v1(uuid,uuid)','e713cc86e14b588389034ec74750373e','postgres','{postgres=X/postgres}'),
('app_private.authorize_income_expense_review_v1(income_expenses,text)','513ac209277c5b6ffb3b13a8c25217c2','postgres','{postgres=X/postgres}'),
('app_private.income_expense_action_scope_v1(uuid)','38d6b30b15990db2c3ab043eb2161865','postgres','{postgres=X/postgres,ie_action_snapshot_reader=X/postgres}'),
('public.read_income_expense_action_snapshots_v1(uuid,uuid[])','a9f0074e0fe76add7b52aec790fe56cf','ie_action_snapshot_reader','{ie_action_snapshot_reader=X/ie_action_snapshot_reader,authenticated=X/ie_action_snapshot_reader}'),
('app_private.room_lifecycle_org_visible_v1(uuid)','bfe10acb39d5df5aa48995a2731532b1','postgres','{postgres=X/postgres,ie_action_snapshot_reader=X/postgres}'),
('app_private.income_expense_action_capabilities_v1(uuid,uuid)','f9990586ef08a9a83fa225b186c60699','postgres','{postgres=X/postgres,ie_action_snapshot_reader=X/postgres}'),
('app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid)','bb9f487c42e0b7e1ce6a4084c216f133','postgres','{postgres=X/postgres,ie_action_snapshot_reader=X/postgres}'),
('public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer)','111961b0e0700535acfe0af478ed2ea4','ie_action_snapshot_reader','{ie_action_snapshot_reader=X/ie_action_snapshot_reader,authenticated=X/ie_action_snapshot_reader}'),
('app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid)','e2a106e767e060d7b9540673d6134cae','postgres','{postgres=X/postgres,ie_action_snapshot_reader=X/postgres}'),
('app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid)','9cadfa6a7a2c2864ed99c26fe2ab763e','postgres','{postgres=X/postgres,ie_action_snapshot_reader=X/postgres}'),
('public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)','37f886b6cf56450fa40c0e544999e2c4','ie_action_snapshot_reader','{ie_action_snapshot_reader=X/ie_action_snapshot_reader,authenticated=X/ie_action_snapshot_reader}'),
('public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric)','f8acf6adaa1e8da590c373735fb4768c','ie_action_snapshot_reader','{ie_action_snapshot_reader=X/ie_action_snapshot_reader,authenticated=X/ie_action_snapshot_reader}'),
('app_private.contract_settlement_create_facts_v1(uuid,text,uuid)','b97c2f4d3e9ff2fa3cefae1f32072c80','postgres','{postgres=X/postgres,ie_action_snapshot_reader=X/postgres}'),
('public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb)','19d5834bed3c4fdbba5c14967a796ffe','postgres','{postgres=X/postgres,authenticated=X/postgres}'),
('app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text)','9d0ce57d4ccc0818bbdc5aa09e3b56ca','postgres','{postgres=X/postgres}'),
('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text)','0409f151a3cf489c8977307892c6c6ad','postgres','{postgres=X/postgres,authenticated=X/postgres}'),
('app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)','c5305a2c11de314dc4eb4b04d8cdfdaa','postgres','{postgres=X/postgres,ie_action_snapshot_reader=X/postgres}'),
('app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)','a7e62c0b18de2e41dad077dc71e0c3cf','ie_action_snapshot_reader','{ie_action_snapshot_reader=X/ie_action_snapshot_reader}'),
('app_private.sale_bonus_source_claims_v1(uuid,uuid,uuid)','85c05498f001dec9b6eb581b711682a3','postgres','{postgres=X/postgres}'),
('app_private.guard_sale_bonus_source_claim_v1()','f804cf51e0aa37c7e7d03bd5d0760ffb','postgres','{postgres=X/postgres}'),
('app_private.reservation_refund_visible_v1(uuid,uuid,uuid)','a7ef392fa48e097862d27feda83ee31f','ie_action_snapshot_reader','{ie_action_snapshot_reader=X/ie_action_snapshot_reader,postgres=X/ie_action_snapshot_reader}'),
('app_private.reservation_refund_lock_v1(uuid,uuid,uuid)','2bb353755f22d8c7e08702fec2c6ace0','postgres','{postgres=X/postgres}'),
('app_private.reservation_create_refund_pending_leg_v1(uuid,uuid,date,numeric,text,text,text)','e59fb268a4f22bb6b08ad71feb8ece16','postgres','{postgres=X/postgres}'),
('public.create_reservation_refund_pending_v1(jsonb)','278d496fba8a08d1d1e72e2bf1312e83','postgres','{postgres=X/postgres,authenticated=X/postgres}'),
('app_private.reservation_refund_dispatch_authorized_v1(uuid,uuid,text)','f6d529ada90335ca5c0c8d613ec0cf3f','postgres','{postgres=X/postgres}'),
('public.execute_reservation_refund_action_v1(jsonb)','11b01d7f0d76e2055b30d141665d1575','postgres','{postgres=X/postgres,authenticated=X/postgres}'),
('app_private.reservation_refund_facts_v1(uuid,uuid)','0d77ad2123f48f4253d7df4babedf0c1','postgres','{postgres=X/postgres,ie_action_snapshot_reader=X/postgres}'),
('public.read_reservation_refund_workflow_v1(uuid,uuid,uuid)','44bf80a2acb361d41d18a3956d86eb06','ie_action_snapshot_reader','{ie_action_snapshot_reader=X/ie_action_snapshot_reader,authenticated=X/ie_action_snapshot_reader}'),
('app_private.reservation_refund_capability_v1(uuid,uuid)','7ea652670f4bc4a5e59387257113d40d','postgres','{postgres=X/postgres}')) expected(signature,hash,owner,acl) LOOP
  SELECT md5(pg_get_functiondef(oid)) AS hash,proowner::regrole::text AS owner,proacl::text AS acl INTO p FROM pg_proc WHERE oid=to_regprocedure(f.signature);
  IF FOUND AND (p.hash IS DISTINCT FROM f.hash OR p.owner IS DISTINCT FROM f.owner OR p.acl IS DISTINCT FROM f.acl) THEN RAISE EXCEPTION 'Restore: added function drift: %',f.signature; END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES ('public.contract_deposit_links','guard_sale_bonus_link_claim','ab86554952e7a54a262dccb6c3a53e28','O'),
('app_private.sale_bonus_claims','guard_sale_bonus_deposit_claim','46eb88e01d693101f616818ffe3f2a2f','O'),
('public.income_expenses','guard_sale_bonus_voucher_claim','42753c904979bbe5a6d35a02b9c532c2','O')) expected(relation,name,hash,enabled) LOOP
  SELECT md5(pg_get_triggerdef(oid)) AS hash,tgenabled::text AS enabled INTO p FROM pg_trigger WHERE tgrelid=to_regclass(f.relation) AND tgname=f.name;
  IF FOUND AND (p.hash IS DISTINCT FROM f.hash OR p.enabled IS DISTINCT FROM f.enabled) THEN RAISE EXCEPTION 'Restore: added trigger drift: %',f.name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR NOT rolinherit)) THEN RAISE EXCEPTION 'Restore: dedicated reader role drift'; END IF;
 -- Exclude child partitions because their rows are already covered by the parent.
 FOR r IN SELECT c.oid::regclass AS relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','app_private') AND c.relkind IN('r','p') AND NOT c.relispartition ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('LOCK TABLE %s IN SHARE MODE',r.relation);
 END LOOP;
 -- Check AFTER locking: a writer which committed while we waited must be seen.
 -- Never alter the voucher to force the restoration through these guards.
 IF EXISTS(SELECT 1 FROM public.income_expenses WHERE system_source='reservation.refund' AND deleted_at IS NULL AND (approval_status='UNAPPROVED' OR posting_status='UNPOSTED')) THEN RAISE EXCEPTION 'Restore: pending reservation refund requires compatibility review'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.canonical_write_operations WHERE created_at>='2026-09-21T03:25:00Z' AND (operation IN('income_expense.request_changes.v2','income_expense.resubmit.v2') OR operation LIKE 'reservation.refund.%')) THEN RAISE EXCEPTION 'Restore: newer workflow data requires compatibility review'; END IF;
 FOR r IN SELECT c.oid::regclass AS relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','app_private') AND c.relkind IN('r','p') AND NOT c.relispartition ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('SELECT jsonb_build_array(count(*),COALESCE(sum((''x''||substr(md5(to_jsonb(t)::text),1,16))::bit(64)::bigint::numeric),0),COALESCE(sum((''x''||substr(md5(to_jsonb(t)::text),17,16))::bit(64)::bigint::numeric),0)) FROM %s t',r.relation) INTO digest;
  INSERT INTO pg_temp.restore_settlement_data_witness VALUES(r.relation::text,digest);
 END LOOP;
END $preflight$;

-- Restore app_private.guard_income_expense_owned_payload(); pre-feature MD5 fb01ae8c9de7b283d19ade8195eba726.
CREATE OR REPLACE FUNCTION app_private.guard_income_expense_owned_payload()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$
declare
  v_authorized boolean;
  v_annotate_free text[];
begin
  if tg_op = 'DELETE' then
    if app_private.is_income_expense_flow_owned(old.id) then
      raise exception 'canonical income expense % is frozen (delete rejected)', old.id
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- WP1: cửa ANNOTATE đứng TRƯỚC early-return.
    -- Trước WP1 khối này nằm SAU early-return "phiếu không flow-owned",
    -- nên phần tự kiểm delta chỉ có hiệu lực trên 175/2528 phiếu: mở scope
    -- ANNOTATE trên một phiếu KHÔNG flow-owned rồi UPDATE total_amount là đi
    -- lọt (đã đo trên prod: total_amount thành 999999.00, không ai lên tiếng).
    -- Năng lực vẫn nằm ở app_private.ie_flex_writer_xids (chỉ writer definer
    -- mở được), KHÔNG mượn cột purpose của ie_transition_authorization vì cột
    -- đó bị writer canon ghi đè và purpose FINANCE_V2_LIFECYCLE làm tắt cầu a85.
    -- ĐỢT C: cửa ĐỔI SỔ QUỸ của phiếu THU (move_income_voucher_cashbook_v1).
    -- Guard chặn account_id vì cột đó không nằm trong allowlist lifecycle —
    -- đúng với mọi writer khác, nhưng hàm kia tồn tại CHÍNH ĐỂ đổi cột đó, và
    -- nó phải để cầu a85 chạy (đảo bút toán sổ cũ + ghi generation mới ở sổ
    -- mới) nên không dùng được token FINANCE_V2_LIFECYCLE. Cho ĐÚNG
    -- account_id + updated_at, không cột nào khác; mọi khoá kỳ vẫn chặn vì
    -- check_lock / profit_lock chỉ miễn trừ scope ANNOTATE.
    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'CASHBOOK_MOVE'
    ) then
      if (to_jsonb(old) - array['account_id','updated_at'])
         is distinct from
         (to_jsonb(new) - array['account_id','updated_at']) then
        raise exception 'cashbook move scope may only change account_id of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'ANNOTATE'
    ) then
      -- a001_ie_lifecycle_normalize chạy TRƯỚC trigger này và ĐIỀN
      -- posting_mode / posting_status / review_state khi chúng đang NULL, ở
      -- MỌI update. Prod còn 173 phiếu NULL (75 trong đó flow-owned — tức
      -- annotate trên chúng đang hỏng sẵn từ Đợt 2, bản vá này chữa luôn).
      -- Chỉ miễn ĐÚNG chiều NULL -> giá trị, không miễn cả cột.
      v_annotate_free := array['attachments','notes','updated_at'];
      if old.posting_mode   is null then v_annotate_free := v_annotate_free || 'posting_mode'; end if;
      if old.posting_status is null then v_annotate_free := v_annotate_free || 'posting_status'; end if;
      if old.review_state   is null then v_annotate_free := v_annotate_free || 'review_state'; end if;

      if (to_jsonb(old) - v_annotate_free)
         is distinct from
         (to_jsonb(new) - v_annotate_free) then
        raise exception 'annotate scope may only change attachments/notes of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

    -- ĐỢT D: cửa GẮN PHIẾU CỌC VÀO HỢP ĐỒNG (create_contract_v2 và
    -- trg_contract_link_orphan_deposits). Hai hàm đó vốn đã mở scope
    -- 'LINK_CONTRACT' và mô tả đúng cửa này trong comment, nhưng nhánh guard
    -- tương ứng bị mất khi hàm được vá lại ngoài migration ⇒ mọi hợp đồng ký
    -- trên phòng "Đã cọc" fail 55000. Không dùng token lifecycle được vì
    -- contract_id không nằm trong allowlist (và không nên nằm: allowlist áp
    -- cho MỌI writer có token). Cửa này một chiều NULL -> NOT NULL nên không
    -- re-parent / không gỡ link được qua đây; thanh lý muốn đổi phải đi
    -- đường riêng. Phiếu legacy (không flow-owned) không cần cửa nhưng vẫn đi
    -- qua đây khi writer mở scope — giữ một đường ghi duy nhất, đồng thời
    -- siết luôn đường legacy.
    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'LINK_CONTRACT'
    ) then
      if old.contract_id is not null or new.contract_id is null then
        raise exception 'link contract scope may only set contract_id from NULL of %', old.id
          using errcode = '55000';
      end if;
      if (to_jsonb(old) - array['contract_id','updated_at'])
         is distinct from
         (to_jsonb(new) - array['contract_id','updated_at']) then
        raise exception 'link contract scope may only change contract_id of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

    -- ĐỢT E: cửa BÀN GIAO TIỀN MẶT (create_cash_handover gắn phiếu vào phiên:
    -- handover_id NULL -> id; confirm_cancel_handover nhả phiếu khi cả hai bên
    -- xác nhận hủy: id -> NULL). Guard chưa từng có cửa này — phiếu sinh trước
    -- 18/07/2026 đều legacy nên rơi early-return, mọi phiên bàn giao CONFIRMED
    -- trong lịch sử có 0 phiếu canonical; từ khi màn Thu/Chi đi
    -- create_income_expense_v1 thì phiếu mới flow-owned, và phiên đầu tiên quét
    -- chúng (07/08/2026) chết 55000 nguyên khối. Token lifecycle không dùng
    -- được: handover_id không nằm trong allowlist (và không nên nằm). Cửa cho
    -- đổi ĐÚNG handover_id, cả hai chiều — chiều và điều kiện nghiệp vụ do
    -- writer + trigger trg_ie_handover_guard giữ (phiếu trong phiên sống bị
    -- khoá; nhả chỉ sau khi phiên CANCELLED bởi 2 bên xác nhận).
    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'HANDOVER'
    ) then
      if (to_jsonb(old) - array['handover_id','updated_at'])
         is distinct from
         (to_jsonb(new) - array['handover_id','updated_at']) then
        raise exception 'handover scope may only change handover_id of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

    if not app_private.is_income_expense_flow_owned(old.id)
       and not (new.id is distinct from old.id
                and app_private.is_income_expense_flow_owned(new.id)) then
      return new; -- unmarked legacy row: unchanged behavior
    end if;

    -- canonical row: check for a live transition token in THIS transaction
    select exists (
      select 1 from app_private.ie_transition_authorization t
       where t.income_expense_id = old.id and t.xid = pg_current_xact_id()
    ) into v_authorized;

    if not v_authorized then
      raise exception 'canonical income expense % is frozen (update rejected)', old.id
        using errcode = '55000';
    end if;

    -- ALLOWLIST, not denylist. t5_08 widened: lifecycle metadata
    -- (approved_by/approved_at, verified_*) joins the original lifecycle
    -- columns. EVERY other column must be NOT DISTINCT FROM its old value.
    if (to_jsonb(old) - array['approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'birth_operation_id','birth_txid','source_payload_hash',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note',
                              'review_state','review_version','review_reason',
                              'approval_version','posting_version',
                              'posting_status','posting_mode','active_posting_id_v2',
                              'cancellation_kind','deleted_at','approval_request_id','notes'])
       is distinct from
       (to_jsonb(new) - array['approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'birth_operation_id','birth_txid','source_payload_hash',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note',
                              'review_state','review_version','review_reason',
                              'approval_version','posting_version',
                              'posting_status','posting_mode','active_posting_id_v2',
                              'cancellation_kind','deleted_at','approval_request_id','notes']) then
      raise exception 'authorized transition may only change lifecycle columns of %', old.id
        using errcode = '55000';
    end if;
    return new;
  end if;

  return new;
end;
$function$
;

-- Restore public.reverse_posted_income_expense_v2(uuid,uuid,date,text,text); pre-feature MD5 9fcc9d100dd7fd3a858038a10dc6e701.
CREATE OR REPLACE FUNCTION public.reverse_posted_income_expense_v2(p_voucher uuid, p_cashbook uuid, p_posted_on date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_orig public.income_expense_postings;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'cb', p_cashbook, 'on', p_posted_on, 'r', p_reason)::text);
  v_op app_private.canonical_write_operations;
  v_rev_id uuid := gen_random_uuid();
  v_line record;
  v_new_post bigint;
  v_resp jsonb;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_cashbook IS NULL OR p_posted_on IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: cashbook, postedOn and idempotency key are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  PERFORM app_private.reservation_authorize_reversal_v1(p_voucher,p_cashbook);
  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.reverse.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');

  -- Reverse capability + CUSTODIAN of the exact cashbook.
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.reverse', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: income_expenses.reverse required in scope' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.accounts a WHERE a.id = p_cashbook AND a.organization_id = v_ie.organization_id
    AND a.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: cashbook % not found', p_cashbook USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_cashbook_access_v2(v_ie.organization_id, p_cashbook, 'CUSTODIAN', v_mid);

  IF v_ie.approval_status <> 'APPROVED' OR v_ie.posting_status <> 'POSTED' OR v_ie.active_posting_id_v2 IS NULL THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: only an APPROVED+POSTED voucher can be reversed (%, %)',
      v_ie.approval_status, v_ie.posting_status USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, p_cashbook, p_posted_on) THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: posted_on % is inside a locked cashbook period', p_posted_on USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_orig FROM public.income_expense_postings p WHERE p.id = v_ie.active_posting_id_v2 FOR UPDATE;
  IF NOT FOUND OR v_orig.event_kind <> 'POSTING' THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: active posting not found for voucher %', p_voucher USING ERRCODE = '55000';
  END IF;
  IF v_orig.account_id <> p_cashbook THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2: cashbook does not match the original posting' USING ERRCODE = '55000';
  END IF;

  -- New REVERSAL event (original is never mutated).
  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_version, event_kind, idempotency_key, source_kind, posting_generation,
    reversal_of_id, reversal_reason, created_at
  ) VALUES (
    v_rev_id, v_orig.organization_id, v_orig.voucher_id, v_orig.posting_subject_kind, v_orig.posting_subject_id,
    v_orig.direction, v_orig.account_id, v_orig.gross_amount, v_orig.voucher_amount_snapshot, v_orig.amount_basis,
    -v_orig.net_cash_effect, p_posted_on, v_mid, v_uid,
    v_orig.approval_version, 'REVERSAL', p_idempotency_key || ':reversal', 'MANUAL', v_orig.posting_generation,
    v_orig.id, p_reason, now()
  );

  -- Opposing signed lines for every original line.
  FOR v_line IN
    SELECT * FROM public.income_expense_posting_lines l WHERE l.posting_id = v_orig.id
  LOOP
    INSERT INTO public.income_expense_posting_lines (
      id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at
    ) VALUES (
      gen_random_uuid(), v_line.organization_id, v_rev_id, v_line.account_id, 'REVERSAL', -v_line.signed_amount, now()
    );
  END LOOP;

  v_new_post := v_ie.posting_version + 1;
  UPDATE public.income_expenses ie
     SET active_posting_id_v2 = NULL, posting_status = 'REVERSED',
         reversed_by_posting_id = v_rev_id, posting_version = v_new_post, updated_at = now()
   WHERE ie.id = p_voucher;

  v_resp := jsonb_build_object('voucherId', p_voucher, 'reversalPostingId', v_rev_id,
                               'postingStatus', 'REVERSED', 'postingVersion', v_new_post);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.reverse.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'REVERSED', v_ie.review_version, v_ie.approval_version, v_new_post);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.reverse.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$function$
;

-- Restore app_private.finance_v2_post_manual_voucher(income_expenses,uuid,uuid,uuid,date,uuid[],text); pre-feature MD5 c2d88ccaae0d8c8a0d425ac4d6cd7f7f.
CREATE OR REPLACE FUNCTION app_private.finance_v2_post_manual_voucher(p_ie income_expenses, p_actor_user uuid, p_actor_membership uuid, p_cashbook uuid, p_posted_on date, p_evidence_ids uuid[], p_idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_posting_id uuid := gen_random_uuid();
  v_gen integer;
  v_signed numeric(18,2);
  v_ev uuid;
  v_ev_count integer := 0;
BEGIN
  IF p_ie.total_amount <= 0 THEN
    RAISE EXCEPTION 'finance_v2_post_manual_voucher: voucher total must be positive to post' USING ERRCODE = '55000';
  END IF;

  -- At least one FINALIZED evidence for a manual posting.
  IF p_evidence_ids IS NULL OR array_length(p_evidence_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required' USING ERRCODE = '55000';
  END IF;

  v_signed := CASE WHEN p_ie.type = 'INCOME' THEN p_ie.total_amount ELSE -p_ie.total_amount END;

  -- 7x: re-post sau reversal = thế hệ bút toán MỚI (unique generation giữ 1
  -- POSTING active/thế hệ; bút toán cũ + reversal bất biến).
  SELECT COALESCE(MAX(p2.posting_generation), 0) + 1 INTO v_gen
  FROM public.income_expense_postings p2
  WHERE p2.organization_id = p_ie.organization_id
    AND p2.posting_subject_kind = 'VOUCHER'
    AND p2.posting_subject_id = p_ie.id
    AND p2.event_kind = 'POSTING';

  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_version, event_kind, idempotency_key, source_kind, posting_generation, created_at
  ) VALUES (
    v_posting_id, p_ie.organization_id, p_ie.id, 'VOUCHER', p_ie.id,
    p_ie.type, p_cashbook, p_ie.total_amount, p_ie.total_amount, 'VOUCHER_TOTAL',
    v_signed, p_posted_on, p_actor_membership, p_actor_user,
    p_ie.approval_version, 'POSTING', p_idempotency_key || ':posting', 'MANUAL', v_gen, now()
  );

  INSERT INTO public.income_expense_posting_lines (
    id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at
  ) VALUES (
    gen_random_uuid(), p_ie.organization_id, v_posting_id, p_cashbook, 'MAIN', v_signed, now()
  );

  -- Attach evidence: lock FINALIZED rows, link ORIGINAL, flip to ATTACHED.
  FOREACH v_ev IN ARRAY p_evidence_ids LOOP
    PERFORM 1 FROM public.finance_evidence_objects e
     WHERE e.id = v_ev AND e.organization_id = p_ie.organization_id
       AND e.state = 'FINALIZED'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance_v2_post_manual_voucher: evidence % is not FINALIZED in tenant', v_ev USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.income_expense_posting_evidence (
      id, organization_id, posting_id, evidence_id, relation_kind, created_at
    ) VALUES (
      gen_random_uuid(), p_ie.organization_id, v_posting_id, v_ev, 'ORIGINAL', now()
    );
    UPDATE public.finance_evidence_objects e SET state = 'ATTACHED' WHERE e.id = v_ev;
    v_ev_count := v_ev_count + 1;
  END LOOP;

  IF v_ev_count = 0 THEN
    RAISE EXCEPTION 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required' USING ERRCODE = '55000';
  END IF;

  RETURN v_posting_id;
END
$function$
;

-- Restore public.get_room_cash_lifecycle_v1(uuid,date,date); pre-feature MD5 2c5c0f54d345ca35c3cac80232c3d837.
CREATE OR REPLACE FUNCTION public.get_room_cash_lifecycle_v1(p_room_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_room  record;
  v_ids   uuid[];
  v_out   jsonb;
  -- "Hôm nay" phải là ngày của TỔ CHỨC, không phải ngày của phiên Postgres
  -- (phiên chạy TimeZone=UTC nên từ 00:00 đến 07:00 giờ VN nó còn là hôm qua).
  v_today date;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT r.id, r.name, r.building_id, b.name AS building_name,
         b.organization_id
    INTO v_room
    FROM rooms r JOIN buildings b ON b.id = r.building_id
   WHERE r.id = p_room_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phòng' USING ERRCODE='P0002';
  END IF;

  v_today := public.org_today_v1(v_room.organization_id);

  IF NOT (public.can_access_building(v_room.building_id)
          OR public.ie_all_buildings_scope(v_room.building_id)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem toà này' USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c.id), '{}') INTO v_ids
    FROM contracts c
   WHERE c.deleted_at IS NULL
     AND (c.room_id = p_room_id
          OR EXISTS (SELECT 1 FROM contract_transfers tr
                      WHERE tr.contract_id = c.id
                        AND tr.status IN ('COMPLETED','APPROVED')
                        AND (tr.old_room_id = p_room_id OR tr.new_room_id = p_room_id)));

  WITH seg_raw AS (
    -- Thanh cư trú trên phòng này. to_date NULL từ projection nghĩa là "không
    -- có mốc chuyển đi" — hợp đồng đã kết thúc thì đóng tại ngày kết thúc.
    SELECT s.contract_id, s.contract_number, s.seg_index, s.from_date,
           CASE
             WHEN s.to_date IS NOT NULL THEN s.to_date
             ELSE COALESCE(c.actual_end_date::date,
                    CASE WHEN c.status::text IN ('TERMINATED','EXPIRED')
                         THEN c.end_date::date END)
           END AS to_date,
           s.source_path, s.trusted, s.diagnostic
      FROM public.get_room_residence_segments_v1(v_ids) s
      JOIN contracts c ON c.id = s.contract_id
     WHERE s.room_id = p_room_id
  ),
  seg AS (
    -- Mốc đóng SỚM HƠN mốc mở = dữ liệu bẩn (hợp đồng rác kết thúc trước khi
    -- bắt đầu — có thật trên prod, phòng 401). Kẹp 0 ngày + hạ trusted + gắn
    -- diagnostic: UI vẽ thanh cảnh báo, vacancy bỏ qua.
    SELECT r.contract_id, r.contract_number, r.seg_index, r.from_date,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN r.from_date ELSE r.to_date END AS to_date,
           r.source_path,
           (r.trusted AND NOT (r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                               AND r.to_date < r.from_date)) AS trusted,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN 'SEGMENT_END_BEFORE_START' ELSE r.diagnostic END AS diagnostic
      FROM seg_raw r
  ),
  hd AS (
    SELECT c.id, c.contract_number, c.status::text AS status,
           c.start_date, c.end_date, c.actual_end_date,
           c.rent_price, c.total_deposit,
           t.full_name AS tenant_name
      FROM contracts c
      LEFT JOIN tenants t ON t.id = c.tenant_id
     WHERE c.id = ANY(v_ids)
  ),
  ev AS (
    SELECT 'CONTRACT_OPENED' AS type, s.from_date AS date, s.contract_id,
           NULL::numeric AS amount, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path) AS meta
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index = 0
    UNION ALL
    SELECT 'ROOM_CHANGED_IN', s.from_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path)
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index > 0
    UNION ALL
    SELECT CASE WHEN tr.id IS NOT NULL THEN 'ROOM_CHANGED_OUT' ELSE 'CONTRACT_CLOSED' END,
           s.to_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index)
      FROM seg s
      LEFT JOIN contract_transfers tr
        ON tr.contract_id = s.contract_id AND tr.old_room_id = p_room_id
       AND tr.status IN ('COMPLETED','APPROVED')
       AND COALESCE(tr.move_out_date, tr.transfer_date) = s.to_date
     WHERE s.to_date IS NOT NULL
    UNION ALL
    SELECT 'DEPOSIT_RECEIVED', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source IN ('contract.deposit','deposit.reservation')
       AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'INVOICE_ISSUED', COALESCE(i.issue_date::date, (i.billing_month || '-01')::date),
           i.contract_id, i.total_amount, true,
           jsonb_build_object('billingMonth', i.billing_month, 'status', i.status)
      FROM invoices i
     WHERE i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status NOT IN ('CANCELLED','DRAFT')
    UNION ALL
    SELECT 'INVOICE_COLLECTION_POSTED', COALESCE(i.paid_date::date, i.updated_at::date),
           i.contract_id, i.paid_amount, true,
           jsonb_build_object('billingMonth', i.billing_month)
      FROM invoices i
     WHERE i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status IN ('PAID','PARTIAL_PAID')
       AND COALESCE(i.paid_amount,0) > 0
    UNION ALL
    SELECT 'TERMINATION_REQUESTED', COALESCE(t.termination_date::date, t.created_at::date),
           t.contract_id, t.refund_amount,
           (t.status IN ('APPROVED','COMPLETED')),
           jsonb_build_object('status', t.status, 'type', t.termination_type)
      FROM contract_terminations t
     WHERE t.contract_id = ANY(v_ids)
    UNION ALL
    SELECT 'SETTLEMENT_OFFSET_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'DEPOSIT_FORFEIT_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.forfeit_offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'DEPOSIT_REFUND_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.refund' AND ie.approval_status = 'APPROVED'
       AND ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL
    UNION ALL
    SELECT 'COMMISSION_PAID', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code, 'name', ie.name)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'contract.commission' AND ie.approval_status = 'APPROVED'
  ),
  ev_loc AS (
    SELECT * FROM ev
     WHERE date IS NOT NULL
       AND (p_from IS NULL OR date >= p_from)
       AND (p_to   IS NULL OR date <= p_to)
  ),
  -- Vacancy theo chuẩn island (fix #2): running max của to_date đã thấy, NULL
  -- (đang ở) coi là infinity — sau một segment mở thì không bao giờ còn gap.
  seg_sorted AS (
    SELECT s.from_date, s.to_date,
           max(COALESCE(s.to_date, 'infinity'::date)) OVER (
             ORDER BY s.from_date NULLS FIRST
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run_max_to,
           lead(s.from_date) OVER (ORDER BY s.from_date NULLS FIRST) AS next_from
      FROM seg s WHERE s.trusted
  ),
  vac AS (
    SELECT DISTINCT ss.run_max_to AS from_date, ss.next_from AS to_date,
           (ss.next_from - ss.run_max_to) AS days
      FROM seg_sorted ss
     WHERE ss.next_from IS NOT NULL
       AND ss.run_max_to <> 'infinity'::date
       AND ss.next_from > ss.run_max_to
    UNION ALL
    -- Đuôi mở: mọi segment tin cậy đều đã đóng ⇒ phòng trống từ mốc đóng muộn
    -- nhất tới hôm nay (chỉ khi thật sự đã qua ngày đó)
    SELECT max(s.to_date), NULL, (v_today - max(s.to_date))
      FROM seg s
     WHERE s.trusted
    HAVING count(*) > 0
       AND bool_and(s.to_date IS NOT NULL)
       AND max(s.to_date) < v_today
  )
  SELECT jsonb_build_object(
    'room', jsonb_build_object(
      'id', v_room.id, 'name', v_room.name,
      'buildingId', v_room.building_id, 'buildingName', v_room.building_name),
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'contracts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', h.id, 'number', h.contract_number, 'status', h.status,
        'startDate', h.start_date, 'endDate', h.end_date,
        'actualEndDate', h.actual_end_date,
        'rentPrice', h.rent_price, 'totalDeposit', h.total_deposit,
        'tenantName', h.tenant_name) ORDER BY h.start_date)
      FROM hd h), '[]'::jsonb),
    'segments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'contractId', s.contract_id, 'contractNumber', s.contract_number,
        'segIndex', s.seg_index, 'fromDate', s.from_date, 'toDate', s.to_date,
        'sourcePath', s.source_path, 'trusted', s.trusted, 'diagnostic', s.diagnostic)
        ORDER BY s.from_date NULLS FIRST, s.seg_index)
      FROM seg s), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'type', e.type, 'date', e.date, 'contractId', e.contract_id,
        'amount', e.amount, 'trusted', e.trusted, 'meta', e.meta)
        ORDER BY e.date, e.type)
      FROM ev_loc e), '[]'::jsonb),
    'vacancies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'fromDate', v.from_date, 'toDate', v.to_date, 'days', v.days)
        ORDER BY v.from_date)
      FROM vac v), '[]'::jsonb),
    'generatedAt', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$
;

-- Restore app_private.reservation_create_leg_v1(uuid,text,uuid,uuid,date,numeric); pre-feature MD5 61e14ad271c7b79e5931f09ab6d0bed2.
CREATE OR REPLACE FUNCTION app_private.reservation_create_leg_v1(p_settlement uuid, p_kind text, p_voucher uuid, p_account uuid, p_day date, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE s public.reservation_deposit_settlements; src public.income_expenses; tid uuid; mid uuid;
  actor_name text; title text; side text; source text; is_dep boolean; posting uuid;
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.reservation_settlement_write_tokens
    WHERE settlement_id=s.id AND xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Thiếu quyền ghi hồ sơ bỏ cọc' USING ERRCODE='42501';
  END IF;
  SELECT * INTO src FROM public.income_expenses WHERE id=s.source_voucher_id;
  SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
  SELECT COALESCE(NULLIF(btrim(full_name),''),NULLIF(btrim(email),'')) INTO actor_name FROM public.profiles WHERE id=auth.uid();
  IF p_kind='REVENUE' THEN
    title:='Doanh thu bỏ cọc giữ chỗ'; side:='INCOME'; source:='reservation.forfeit_revenue'; is_dep:=false;
  ELSIF p_kind='OFFSET' THEN
    title:='Cấn cọc giữ chỗ chuyển doanh thu'; side:='EXPENSE'; source:='reservation.forfeit_offset'; is_dep:=true;
  ELSIF p_kind='REFUND' THEN
    title:='Hoàn cọc giữ chỗ'; side:='EXPENSE'; source:='reservation.refund'; is_dep:=true;
  ELSE RAISE EXCEPTION 'Loại bút toán bỏ cọc không hợp lệ' USING ERRCODE='22023'; END IF;
  tid:=app_private.ensure_income_expense_type_v1(s.organization_id,auth.uid(),title,lower(side),NULL,NULL,false,is_dep,false,false,false,true);
  INSERT INTO public.reservation_settlement_vouchers(voucher_id,settlement_id,organization_id,kind)
    VALUES(p_voucher,s.id,s.organization_id,p_kind);
  INSERT INTO public.income_expenses(id,organization_id,user_id,type,name,building_id,room_id,account_id,
    voucher_date,total_amount,approval_status,posting_mode,posting_status,system_source,payer_name,notes,maker_membership_id,creator_name)
  VALUES(p_voucher,s.organization_id,auth.uid(),side,title,s.building_id,s.room_id,p_account,
    p_day,p_amount,'UNAPPROVED',CASE WHEN p_kind='REFUND' THEN 'CASHBOOK' ELSE 'NON_CASH' END,
    CASE WHEN p_kind='REFUND' THEN 'UNPOSTED' ELSE 'NOT_APPLICABLE' END,source,src.payer_name,
    'Xử lý phiếu cọc '||COALESCE(src.code,src.id::text)||'. '||s.reason_text,mid,actor_name);
  INSERT INTO public.income_expense_items(organization_id,income_expense_id,income_expense_type_id,
    description,quantity,unit_price,amount,accounting_class,start_date,end_date)
  VALUES(s.organization_id,p_voucher,tid,title,1,p_amount,p_amount,CASE WHEN is_dep THEN 'DEPOSIT' ELSE 'PNL' END,p_day,p_day);
  -- Specialized authorized decision, retaining the canonical manual birth boundary.
  -- Token suppresses both legacy posting bridges; shared core owns cash calculations.
  INSERT INTO app_private.ie_transition_authorization(income_expense_id,xid,purpose)
    VALUES(p_voucher,pg_current_xact_id(),'FINANCE_V2_LIFECYCLE')
    ON CONFLICT(income_expense_id) DO UPDATE SET xid=EXCLUDED.xid,purpose=EXCLUDED.purpose,granted_at=now();
  UPDATE public.income_expenses SET approval_status='APPROVED',approved_by=auth.uid(),approved_at=now(),
    review_state='RESOLVED',approval_version=approval_version+1,updated_at=now() WHERE id=p_voucher;
  IF p_kind='REFUND' THEN
    posting:=app_private.finance_v2_post_voucher_with_source_v1(
      p_org=>s.organization_id,p_voucher_id=>p_voucher,p_source_kind=>'RESERVATION_REFUND',
      p_external_kind=>'RESERVATION_REFUND_VOUCHER',p_external_id=>p_voucher,p_external_line_id=>NULL,
      p_posted_on=>p_day,p_amount_basis=>'VOUCHER_TOTAL',p_generation=>1);
    UPDATE public.income_expenses SET active_posting_id_v2=posting,posting_id=posting,posting_status='POSTED',
      posted_at_v2=now(),posting_version=posting_version+1,updated_at=now() WHERE id=p_voucher;
  END IF;
  DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id=p_voucher AND xid=pg_current_xact_id();
END $function$
;

-- Restore public.request_income_expense_changes_v2(uuid,bigint,text,jsonb,text); pre-feature MD5 c3769605c5ac35134935d49a32a5d1d9.
CREATE OR REPLACE FUNCTION public.request_income_expense_changes_v2(p_voucher uuid, p_expected_review_version bigint, p_reason text, p_field_mask jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'r', p_reason, 'm', p_field_mask)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.request_changes.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.approve', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: approver capability required in scope' USING ERRCODE = '42501';
  END IF;

  IF v_ie.approval_status <> 'UNAPPROVED' OR v_ie.review_state NOT IN ('PENDING','DISPUTED') THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: voucher not in a requestable state (%, %)',
      v_ie.approval_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;
  IF v_ie.review_version <> p_expected_review_version THEN
    RAISE EXCEPTION 'request_income_expense_changes_v2: review_version mismatch' USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET review_state = 'CHANGES_REQUESTED', review_reason = p_reason,
         change_field_mask = p_field_mask, review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;

  UPDATE public.approval_requests ar
     SET state = 'CHANGES_REQUESTED', outcome_kind = 'REQUEST_CHANGES', outcome_reason = p_reason,
         closed_by_membership_id = v_mid, closed_at = now()
   WHERE ar.organization_id = v_ie.organization_id
     AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
     AND ar.state = 'PENDING_APPROVAL';

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'UNAPPROVED',
                               'reviewState', 'CHANGES_REQUESTED', 'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.request_changes.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'REQUEST_CHANGES', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.request_changes.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$function$
;

-- Restore public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text); pre-feature MD5 cdc2896ff50e836cb782219683ba5474.
CREATE OR REPLACE FUNCTION public.create_termination_refund_voucher_v1(p_obligation_id uuid, p_account_id uuid DEFAULT NULL::uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_o     public.termination_refund_obligations;
  v_c     public.contracts;
  v_tstatus text;
  v_bld   uuid;
  v_acc   uuid;
  v_type  uuid;
  v_ie    uuid;
  v_code  text;
  v_is_owner boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_o FROM termination_refund_obligations
   WHERE id = p_obligation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy nghĩa vụ hoàn' USING ERRCODE='P0002';
  END IF;

  -- Khoá HỒ SƠ: tuần tự hoá mọi lần sinh phiếu trên cùng hồ sơ (kể cả khi hai
  -- người gọi trên HAI phiên bản nghĩa vụ khác nhau), và đọc status dưới khoá.
  SELECT status INTO v_tstatus FROM contract_terminations
   WHERE id = v_o.termination_id FOR UPDATE;
  IF v_tstatus IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy hồ sơ thanh lý của nghĩa vụ này' USING ERRCODE='P0002';
  END IF;

  -- F3: hồ sơ CHƯA DUYỆT thì không có phiếu chi. DRAFT/PENDING_APPROVAL sửa
  -- được số ⇒ phiếu sinh lúc này là chi theo một con số chưa ai chốt.
  IF v_tstatus NOT IN ('APPROVED','COMPLETED') THEN
    RAISE EXCEPTION
      'Hồ sơ thanh lý đang ở trạng thái % — phải được duyệt (APPROVED/COMPLETED) rồi mới sinh phiếu hoàn.',
      v_tstatus USING ERRCODE='55000';
  END IF;

  -- F2a: gỡ link tới phiếu đã HUỶ/XOÁ ở mọi phiên bản nghĩa vụ của hồ sơ này.
  -- Không có bước này thì khoá "một phiếu sống một hồ sơ" bên dưới sẽ giết luôn
  -- đường nghiệp vụ hợp lệ "huỷ phiếu sai rồi sinh lại phiếu mới".
  UPDATE termination_refund_obligations o
     SET voucher_id = NULL
   WHERE o.organization_id = v_o.organization_id
     AND o.termination_id  = v_o.termination_id
     AND o.voucher_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM income_expenses ie
                  WHERE ie.id = o.voucher_id
                    AND (ie.approval_status = 'CANCELLED' OR ie.deleted_at IS NOT NULL));

  -- F2b: hồ sơ đã có phiếu SỐNG ở BẤT KỲ phiên bản nghĩa vụ nào ⇒ trả phiếu đó,
  -- tuyệt đối không đẻ phiếu thứ hai. (Bản cũ chỉ nhìn voucher_id của CHÍNH
  -- phiên bản đang gọi — record thêm version mới là lách qua được.)
  SELECT o.voucher_id, ie.code INTO v_ie, v_code
    FROM termination_refund_obligations o
    JOIN income_expenses ie ON ie.id = o.voucher_id
   WHERE o.organization_id = v_o.organization_id
     AND o.termination_id  = v_o.termination_id
     AND o.voucher_id IS NOT NULL
   ORDER BY o.version DESC
   LIMIT 1;
  IF v_ie IS NOT NULL THEN
    RETURN jsonb_build_object('voucherId', v_ie, 'code', v_code,
                              'alreadyCreated', true);
  END IF;

  SELECT * INTO v_c FROM contracts WHERE id = v_o.contract_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hợp đồng' USING ERRCODE='P0002'; END IF;
  SELECT r.building_id INTO v_bld FROM rooms r WHERE r.id = v_c.room_id;
  IF v_bld IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng không gắn phòng/toà — không xác định được toà để ghi phiếu'
      USING ERRCODE='22023';
  END IF;

  IF NOT (public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE='42501';
  END IF;

  IF v_o.requested_amount <= 0 THEN
    RAISE EXCEPTION 'Nghĩa vụ này không phải hoàn tiền (số hoàn %đ) — không sinh phiếu chi.',
      round(v_o.requested_amount)::bigint USING ERRCODE='22023';
  END IF;

  -- ══ CHỐT CHẶN: nghĩa vụ lệch thì phải CHỦ ép, kèm lý do ═══════════
  IF v_o.obligation_status <> 'OK' THEN
    v_is_owner := public.is_super_admin()
               OR app_private.is_org_owner_v1(v_o.organization_id, v_actor);
    IF NOT p_force THEN
      RAISE EXCEPTION
        'Nghĩa vụ này đang cảnh báo [%]: %. Muốn vẫn sinh phiếu thì chủ tổ chức phải ép (p_force) kèm lý do.',
        v_o.obligation_status, COALESCE(v_o.warning,'(không rõ)')
        USING ERRCODE = '55000';
    END IF;
    IF NOT v_is_owner THEN
      RAISE EXCEPTION
        'Chỉ chủ tổ chức hoặc super admin mới ép sinh phiếu hoàn khi nghĩa vụ đang cảnh báo [%].',
        v_o.obligation_status USING ERRCODE = '42501';
    END IF;
    IF COALESCE(length(btrim(p_force_reason)),0) < 8 THEN
      RAISE EXCEPTION 'Ép sinh phiếu phải kèm lý do ít nhất 8 ký tự' USING ERRCODE='22023';
    END IF;
  END IF;

  -- Sổ quỹ: bắt buộc là sổ THẬT (không ảo) — hoàn cọc là tiền ra khỏi két.
  v_acc := p_account_id;
  IF v_acc IS NOT NULL THEN
    PERFORM 1 FROM accounts a
     WHERE a.id = v_acc AND a.deleted_at IS NULL
       AND a.organization_id = v_o.organization_id
       AND NOT COALESCE(a.is_virtual,false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ, khác tổ chức, hoặc là SỔ ẢO (hoàn cọc là tiền thật ra khỏi két)'
        USING ERRCODE='22023';
    END IF;
  END IF;

  v_type := app_private.ensure_income_expense_type_v1(
              v_o.organization_id, v_actor, 'Hoàn tiền cọc', 'expense',
              NULL, NULL, false, true, false, false, false, false);

  -- F1: 'termination.refund' — ĐÚNG chuỗi mà ô KPI /deposits,
  -- useDepositDashboard, useContractDetailData và voucherSources đang lọc.
  -- Chuỗi cũ 'termination.refund.v2' không màn nào đọc ⇒ tiền ra khỏi két mà
  -- mọi báo cáo vẫn nói "chưa hoàn".
  INSERT INTO income_expenses
    (user_id, organization_id, type, name, building_id, room_id, contract_id,
     voucher_date, total_amount, approval_status, account_id, system_source, notes)
  VALUES
    (v_actor, v_o.organization_id, 'EXPENSE',
     'Hoàn tiền cọc — HĐ ' || COALESCE(v_c.contract_number, left(v_c.id::text,8)),
     v_bld, v_c.room_id, v_o.contract_id,
     public.org_today_v1(v_o.organization_id), v_o.requested_amount,
     'UNAPPROVED', v_acc, 'termination.refund',
     CASE WHEN v_o.obligation_status <> 'OK'
          THEN 'ÉP SINH dù cảnh báo [' || v_o.obligation_status || ']: ' || btrim(p_force_reason)
          ELSE 'Sinh từ nghĩa vụ hoàn cọc đã đối chiếu với cọc thật' END)
  RETURNING id, code INTO v_ie, v_code;

  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, accounting_class,
     description, quantity, unit_price, amount)
  -- accounting_class CHECK chỉ nhận PNL / DEPOSIT / CUSTOMER_CREDIT / INTERNAL.
  -- Hoàn cọc là DEPOSIT (bảng cân đối), KHÔNG phải chi phí kinh doanh (PNL) —
  -- ghi nhầm PNL là thổi phồng chi phí và làm lệch Báo cáo Lợi Nhuận.
  VALUES (v_ie, v_type, 'DEPOSIT', 'Hoàn cọc thanh lý', 1,
          v_o.requested_amount, v_o.requested_amount);

  UPDATE termination_refund_obligations SET voucher_id = v_ie WHERE id = p_obligation_id;

  RETURN jsonb_build_object(
    'voucherId', v_ie, 'code', v_code, 'amount', v_o.requested_amount,
    'obligationStatus', v_o.obligation_status, 'forced', (v_o.obligation_status <> 'OK'),
    'note', 'Phiếu ở trạng thái CHỜ DUYỆT — tiền chỉ ra khỏi két khi có người duyệt.');
END;
$function$
;

-- Restore public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb); pre-feature MD5 fbaed9b582feab422372165eb55a8288.
CREATE OR REPLACE FUNCTION public.create_sale_bonus_from_deposit_v1(p_deposit_voucher_id uuid, p_amount numeric, p_recipient text DEFAULT NULL::text, p_account_number text DEFAULT NULL::text, p_bank text DEFAULT NULL::text, p_voucher_date date DEFAULT NULL::date, p_account_id uuid DEFAULT NULL::uuid, p_attachments jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_dep   public.income_expenses;
  v_org   uuid;
  v_bld   uuid;
  v_room  uuid;
  v_cap   numeric;
  v_type  uuid;
  v_ie    uuid;
  v_code  text;
  v_exist uuid;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
  v_acc_org   uuid;
  v_acc_owner uuid;
  v_acc_ok    boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền thưởng phải lớn hơn 0' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_attachments) <> 'array' THEN
    RAISE EXCEPTION 'Ảnh chứng từ không hợp lệ (cần mảng URL)' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_attachments) e
     WHERE jsonb_typeof(e) <> 'string'
  ) THEN
    RAISE EXCEPTION 'Ảnh chứng từ không hợp lệ (mỗi phần tử phải là URL dạng chuỗi)'
      USING ERRCODE = '23514';
  END IF;

  -- Khoá phiếu cọc: hai người cùng bấm thưởng cho một phiếu cọc phải xếp hàng.
  SELECT * INTO v_dep FROM public.income_expenses
   WHERE id = p_deposit_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu cọc' USING ERRCODE = 'P0002';
  END IF;
  IF v_dep.deleted_at IS NOT NULL OR v_dep.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu cọc đã huỷ — không thưởng được' USING ERRCODE = '55000';
  END IF;
  IF v_dep.type IS DISTINCT FROM 'INCOME' THEN
    RAISE EXCEPTION 'Phiếu này không phải phiếu thu cọc' USING ERRCODE = '22023';
  END IF;

  v_org  := v_dep.organization_id;
  v_bld  := v_dep.building_id;
  v_room := v_dep.room_id;

  IF NOT (public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld)
       OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền tạo phiếu trên toà này' USING ERRCODE = '42501';
  END IF;

  -- ══ SỔ QUỸ — tuỳ chọn, nhưng đã chọn thì phải có quyền ════════════
  IF p_account_id IS NOT NULL THEN
    SELECT a.organization_id, a.user_id INTO v_acc_org, v_acc_owner
      FROM public.accounts a
     WHERE a.id = p_account_id AND a.deleted_at IS NULL;
    IF v_acc_org IS NULL OR v_acc_org IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
    END IF;
    -- §9.2: CUSTODIAN/OPERATOR làm mọi loại phiếu; KNOWER chỉ Phiếu thu, mà đây
    -- là phiếu CHI ⇒ KNOWER không đủ.
    v_acc_ok := (v_acc_owner = v_actor) OR EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
        JOIN public.organization_memberships m ON m.id = b.membership_id
       WHERE b.cashbook_id = p_account_id
         AND b.organization_id = v_org
         AND m.user_id = v_actor
         AND m.status = 'ACTIVE'
         AND b.valid_to IS NULL
         AND b.possession_kind IN ('CUSTODIAN','OPERATOR')
    );
    IF NOT COALESCE(v_acc_ok, false) THEN
      RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ══ CHỐNG CHI TRÙNG — hai hướng ═══════════════════════════════════
  -- (a) Chính phiếu cọc này đã thưởng chưa.
  SELECT sbc.bonus_voucher_id INTO v_exist
    FROM app_private.sale_bonus_claims sbc
    JOIN public.income_expenses bon ON bon.id = sbc.bonus_voucher_id
   WHERE sbc.deposit_voucher_id = p_deposit_voucher_id
     AND bon.deleted_at IS NULL AND bon.approval_status <> 'CANCELLED';
  IF v_exist IS NOT NULL THEN
    SELECT code INTO v_code FROM public.income_expenses WHERE id = v_exist;
    RAISE EXCEPTION 'Phiếu cọc này đã được thưởng Sale rồi (phiếu %)', COALESCE(v_code, v_exist::text)
      USING ERRCODE = 'P0001';
  END IF;

  -- (b) Phiếu cọc đã gắn hợp đồng, mà hợp đồng đó đã thưởng qua đường khác.
  IF v_dep.contract_id IS NOT NULL THEN
    SELECT ie.id INTO v_exist FROM public.income_expenses ie
     WHERE ie.contract_id = v_dep.contract_id AND ie.commission_kind = 'sale'
       AND ie.deleted_at IS NULL AND ie.approval_status <> 'CANCELLED'
       AND NOT COALESCE(ie.commission_legacy_dup, false)
     LIMIT 1;
    IF v_exist IS NOT NULL THEN
      SELECT code INTO v_code FROM public.income_expenses WHERE id = v_exist;
      RAISE EXCEPTION 'Hợp đồng của phiếu cọc này đã được thưởng Sale rồi (phiếu %)',
        COALESCE(v_code, v_exist::text) USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ══ TRẦN — chỉ áp khi chủ đã công bố ══════════════════════════════
  v_cap := app_private.sale_bonus_cap_for_v1(v_org, v_bld, public.org_today_v1(v_org));
  IF v_cap IS NOT NULL AND p_amount > v_cap THEN
    RAISE EXCEPTION
      'Thưởng % vượt trần % của toà này. Muốn chi cao hơn thì chủ phải nâng trần ở Cài đặt.',
      replace(to_char(round(p_amount), 'FM999G999G999G999'), ',', '.') || 'đ',
      replace(to_char(round(v_cap),   'FM999G999G999G999'), ',', '.') || 'đ'
      USING ERRCODE = '55000';
  END IF;

  v_type := app_private.ensure_income_expense_type_v1(
              v_org, v_actor, 'Thưởng nóng Sale', 'expense',
              NULL, NULL, false, false, false, false, false, false);

  -- Cấp phát UUID TRƯỚC để mở được cửa `SALE_BONUS_DEPOSIT` cho đúng phiếu này:
  -- `trigger_ie_commission_guard` chạy BEFORE INSERT nên cửa phải mở trước đó,
  -- mà bảng cửa khoá theo id phiếu. Đóng cửa ngay sau lệnh INSERT.
  v_ie := gen_random_uuid();
  PERFORM app_private.begin_ie_flex_write_v1(v_ie, 'SALE_BONUS_DEPOSIT');

  INSERT INTO public.income_expenses
    (id, user_id, organization_id, type, name, building_id, room_id, contract_id,
     voucher_date, total_amount, approval_status, commission_kind, system_source,
     account_id, attachments, receive_bank_account, receive_bank_name, notes)
  VALUES
    (v_ie, v_actor, v_org, 'EXPENSE',
     'Thưởng nóng Sale' || COALESCE(' — ' || NULLIF(btrim(p_recipient), ''), ''),
     v_bld, v_room,
     -- Cố ý GIỮ NGUYÊN contract_id của phiếu cọc (thường là NULL lúc này).
     -- Không tự bịa hợp đồng: quan hệ nằm ở sổ claim bên dưới.
     v_dep.contract_id,
     COALESCE(p_voucher_date, public.org_today_v1(v_org)),
     p_amount, 'UNAPPROVED', 'sale', 'contract.commission',
     p_account_id,
     v_attachments,
     NULLIF(btrim(p_account_number), ''),
     NULLIF(btrim(p_bank), ''),
     'Thưởng Sale theo phiếu cọc ' || COALESCE(v_dep.code, left(v_dep.id::text, 8))
       || COALESCE(' — ' || NULLIF(btrim(p_recipient), ''), '')
       || COALESCE(' — STK ' || NULLIF(btrim(p_account_number), ''), '')
       || COALESCE(' — ' || NULLIF(btrim(p_bank), ''), ''))
  RETURNING code INTO v_code;

  PERFORM app_private.end_ie_flex_write_v1(v_ie);

  INSERT INTO public.income_expense_items
    (income_expense_id, income_expense_type_id, accounting_class,
     description, quantity, unit_price, amount)
  VALUES (v_ie, v_type, 'PNL',
          'Thưởng nóng Sale — phiếu cọc ' || COALESCE(v_dep.code, left(v_dep.id::text, 8)),
          1, p_amount, p_amount);

  INSERT INTO app_private.sale_bonus_claims
    (organization_id, deposit_voucher_id, contract_id, bonus_voucher_id, amount, created_by)
  VALUES (v_org, p_deposit_voucher_id, v_dep.contract_id, v_ie, p_amount, v_actor);

  RETURN jsonb_build_object(
    'voucherId', v_ie, 'code', v_code, 'amount', p_amount,
    'depositVoucherId', p_deposit_voucher_id,
    'note', 'Phiếu thưởng đã tạo và đang CHỜ DUYỆT. Khi hợp đồng của phiếu cọc này được ký, hệ thống sẽ tự biết là đã thưởng rồi.');
END;
$function$
;

-- Restore public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb); pre-feature MD5 c134aa5857144c2b8f66145f0e9feab5.
CREATE OR REPLACE FUNCTION public.create_commission_voucher(p_contract_id uuid, p_kind text, p_amount numeric, p_voucher_date date, p_account_id uuid DEFAULT NULL::uuid, p_payer_name text DEFAULT NULL::text, p_recipient_name text DEFAULT NULL::text, p_recipient_bank text DEFAULT NULL::text, p_recipient_account text DEFAULT NULL::text, p_item_description text DEFAULT NULL::text, p_attachments jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_contract record;
  v_existing record;
  v_type_id uuid;
  v_type_name text;
  v_kind_label text;
  v_creator text;
  v_name text;
  v_id uuid;
  v_code text;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('broker', 'sale') THEN
    RAISE EXCEPTION 'Loại hoa hồng không hợp lệ: %', COALESCE(p_kind, 'null')
      USING ERRCODE = '23514';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền hoa hồng phải lớn hơn 0'
      USING ERRCODE = '23514';
  END IF;
  IF p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Thiếu ngày chi' USING ERRCODE = '23502';
  END IF;
  IF jsonb_typeof(v_attachments) <> 'array' THEN
    RAISE EXCEPTION 'Ảnh chứng từ không hợp lệ (cần mảng URL)'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    contract_row.id,
    contract_row.contract_number,
    room_row.id AS room_id,
    building_row.id AS building_id,
    building_row.user_id AS owner_id,
    COALESCE(contract_row.organization_id, building_row.organization_id)
      AS organization_id
  INTO v_contract
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hợp đồng' USING ERRCODE = 'P0002';
  END IF;
  IF v_contract.organization_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa thuộc tổ chức'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    public.can_access_building(v_contract.building_id)
    OR public.ie_all_buildings_scope(v_contract.building_id)
    OR v_contract.owner_id = v_uid
    OR public.is_admin()
    OR public.is_super_admin()
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền chi hoa hồng cho tòa nhà này'
      USING ERRCODE = '42501';
  END IF;

  v_kind_label := CASE p_kind
    WHEN 'broker' THEN 'hoa hồng môi giới'
    ELSE 'thưởng nóng Sale'
  END;

  PERFORM pg_advisory_xact_lock(
    hashtext('commission:' || p_contract_id::text || ':' || p_kind)
  );

  SELECT voucher.code
    INTO v_existing
  FROM public.income_expenses voucher
  WHERE voucher.contract_id = p_contract_id
    AND voucher.commission_kind = p_kind
    AND voucher.deleted_at IS NULL
    AND voucher.approval_status <> 'CANCELLED'
  ORDER BY voucher.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'HĐ % đã có phiếu % (mã %). Mỗi hợp đồng chỉ chi 1 lần — không thể tạo thêm. Nếu phiếu cũ sai, hãy hủy phiếu đó trước.',
      COALESCE(v_contract.contract_number, ''),
      v_kind_label,
      v_existing.code
      USING ERRCODE = 'P0001';
  END IF;

  -- SALE_BONUS_SEES_DEPOSIT_CLAIM: phiếu thưởng Sale có thể đã sinh từ PHIẾU CỌC lúc
  -- hợp đồng chưa tồn tại. Phiếu đó contract_id NULL nên VÔ HÌNH với cả
  -- advisory lock, pre-check P0001 lẫn unique index ở trên. Không có chốt
  -- này thì mở luồng "thưởng từ phiếu cọc" là mở toang khoá chống chi trùng.
  IF p_kind = 'sale' THEN
    DECLARE v_prev uuid; v_prev_code text;
    BEGIN
      SELECT bon.id, bon.code INTO v_prev, v_prev_code
        FROM app_private.sale_bonus_claims sbc
        JOIN public.income_expenses dep ON dep.id = sbc.deposit_voucher_id
        JOIN public.income_expenses bon ON bon.id = sbc.bonus_voucher_id
       WHERE dep.contract_id = p_contract_id
         AND bon.deleted_at IS NULL
         AND bon.approval_status <> 'CANCELLED'
       LIMIT 1;
      IF v_prev IS NOT NULL THEN
        RAISE EXCEPTION 'Hợp đồng này đã được thưởng Sale từ phiếu cọc rồi (phiếu %)',
          COALESCE(v_prev_code, v_prev::text) USING ERRCODE = 'P0001';
      END IF;
    END;
  END IF;

  v_type_name := CASE p_kind
    WHEN 'broker' THEN 'Hoa hồng môi giới'
    ELSE 'Thưởng nóng Sale'
  END;

  SELECT t.id
    INTO v_type_id
  FROM public.income_expense_types AS t
  WHERE t.organization_id = v_contract.organization_id
    AND lower(btrim(t.type)) = 'expense'
    AND public.normalize_income_expense_type_name(t.name) =
        public.normalize_income_expense_type_name(v_type_name)
  ORDER BY COALESCE(t.is_default, false) DESC, t.created_at, t.id
  LIMIT 1;

  IF v_type_id IS NULL THEN
    v_type_id := app_private.ensure_income_expense_type_v1(
      p_organization_id => v_contract.organization_id,
      p_user_id => v_contract.owner_id,
      p_name => v_type_name,
      p_type => 'expense',
      p_description => CASE p_kind
        WHEN 'broker' THEN 'Tự động tạo khi tạo hợp đồng — % tiền phòng theo bậc tháng cấu hình ở tòa nhà.'
        ELSE 'Thưởng cho Sale khi tạo hợp đồng — số tiền do người dùng nhập.'
      END,
      p_force_approval => true,
      p_system_only => true
    );
  END IF;

  SELECT COALESCE(
           NULLIF(profile.full_name, ''),
           NULLIF(profile.email, ''),
           auth_user.email,
           'Người dùng'
         )
    INTO v_creator
  FROM auth.users auth_user
  LEFT JOIN public.profiles profile ON profile.id = auth_user.id
  WHERE auth_user.id = v_uid;

  -- TÊN THEO PHÒNG (02/09/2026): "Hoa hồng <Phòng>/<Tòa> - dd/mm/yyyy - STT".
  -- Facts NULL (HĐ không có phòng) ⇒ giữ tên cũ để không bao giờ chặn tạo phiếu.
  v_name := COALESCE(
    app_private.commission_voucher_name_v1(p_kind, p_contract_id),
    btrim(
      CASE p_kind
        WHEN 'broker' THEN 'Hoa hồng môi giới HĐ '
        ELSE 'Thưởng nóng Sale HĐ '
      END || COALESCE(v_contract.contract_number, '')
    )
  );

  INSERT INTO public.income_expenses (
    user_id,
    organization_id,
    creator_name,
    type,
    approval_status,
    name,
    building_id,
    room_id,
    tenant_id,
    contract_id,
    voucher_date,
    account_id,
    payer_name,
    receive_bank_name,
    receive_bank_account,
    notes,
    attachments,
    business_result_accounting,
    repeat_cycle,
    repeat_infinity,
    repeat_count,
    repeat_remaining,
    commission_kind,
    system_source
  ) VALUES (
    v_uid,
    v_contract.organization_id,
    v_creator,
    'EXPENSE',
    'UNAPPROVED',
    v_name,
    v_contract.building_id,
    v_contract.room_id,
    NULL,
    p_contract_id,
    p_voucher_date,
    p_account_id,
    p_payer_name,
    p_recipient_bank,
    p_recipient_account,
    CASE
      WHEN COALESCE(p_recipient_name, '') <> ''
        THEN 'Người nhận: ' || p_recipient_name
      ELSE NULL
    END,
    v_attachments,
    NULL,
    'NONE',
    false,
    0,
    0,
    p_kind,
    'contract.commission'
  )
  RETURNING id, code INTO v_id, v_code;

  INSERT INTO public.income_expense_items (
    income_expense_id,
    income_expense_type_id,
    organization_id,
    description,
    quantity,
    unit_price,
    start_date,
    end_date
  ) VALUES (
    v_id,
    v_type_id,
    v_contract.organization_id,
    COALESCE(NULLIF(p_item_description, ''), v_name),
    1,
    p_amount,
    p_voucher_date,
    p_voucher_date
  );

  -- COMMISSION_AUTOPAY_V1: hoa hồng môi giới đủ bốn điều kiện chủ chốt 31/07 thì
  -- máy duyệt hộ và ghi sổ luôn. Thiếu một điều ⇒ để nguyên chờ duyệt (hành
  -- vi cũ). Bảng bậc rỗng ⇒ luôn rơi vào NO_TIER ⇒ không phiếu nào tự duyệt.
  IF p_kind = 'broker' AND v_id IS NOT NULL THEN
    DECLARE v_chk jsonb; v_acc_ok boolean;
    BEGIN
      v_chk := app_private.commission_autopay_check_v1(p_contract_id, p_amount);
      SELECT (a.id IS NOT NULL AND NOT COALESCE(a.is_virtual,false)) INTO v_acc_ok
        FROM public.accounts a
       WHERE a.id = (SELECT account_id FROM public.income_expenses WHERE id = v_id);
      IF (v_chk->>'verdict') = 'VALID' AND COALESCE(v_acc_ok,false) THEN
        PERFORM app_private.special_fee_approve_and_post_v1(v_id, 'BROKER_COMMISSION');
      END IF;
    END;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'code', v_code);
END
$function$
;

-- Restore app_private.finance_v2_birth_provenance_bridge(); pre-feature MD5 a8e8c8c66676f566e52edf888bc43579.
CREATE OR REPLACE FUNCTION app_private.finance_v2_birth_provenance_bridge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_txid xid8;
  v_hash text;
BEGIN
  IF NEW.approval_status = 'UNAPPROVED' AND NEW.birth_operation_id IS NULL THEN
    IF NEW.id IS NULL THEN
      NEW.id := gen_random_uuid();
    END IF;
    -- 7w: writer cũ quên organization_id → suy từ toà/sổ.
    IF NEW.organization_id IS NULL AND NEW.building_id IS NOT NULL THEN
      SELECT b.organization_id INTO NEW.organization_id
      FROM public.buildings b WHERE b.id = NEW.building_id;
    END IF;
    IF NEW.organization_id IS NULL AND NEW.account_id IS NOT NULL THEN
      SELECT a.organization_id INTO NEW.organization_id
      FROM public.accounts a WHERE a.id = NEW.account_id;
    END IF;
    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'Phiếu chờ duyệt thiếu organization (toà/sổ không xác định) — liên hệ quản trị'
        USING ERRCODE = '23502';
    END IF;
    SELECT b.birth_txid, b.payload_hash INTO v_txid, v_hash
    FROM app_private.finance_v2_register_birth_v1(
      NEW.organization_id, NEW.id, COALESCE(auth.uid(), NEW.user_id),
      'BIRTH_BRIDGE', NEW.source_payload_hash) b;
    NEW.birth_operation_id := NEW.id;
    NEW.birth_txid := v_txid;
    NEW.source_payload_hash := COALESCE(NEW.source_payload_hash, v_hash);
  END IF;
  RETURN NEW;
END
$function$
;

-- Restore public.resubmit_income_expense_v2(uuid,bigint,jsonb,text); pre-feature MD5 722dcc99bec52a059f7c45c08d085f80.
CREATE OR REPLACE FUNCTION public.resubmit_income_expense_v2(p_voucher uuid, p_expected_review_version bigint, p_patch jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_uid uuid; v_mid uuid; v_ie public.income_expenses;
  v_hash text := md5(jsonb_build_object('v', p_voucher, 'erv', p_expected_review_version, 'p', p_patch)::text);
  v_op app_private.canonical_write_operations; v_new_rev bigint; v_resp jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.resubmit.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN RETURN COALESCE(v_op.response_payload, '{}'::jsonb); END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher, 'CANONICAL_INCOME_EXPENSE');

  -- Only the original maker resubmits after changes were requested.
  IF v_ie.maker_user_id IS NULL OR v_ie.maker_user_id <> v_uid THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: only the original maker may resubmit' USING ERRCODE = '42501';
  END IF;
  IF v_ie.approval_status <> 'UNAPPROVED' OR v_ie.review_state <> 'CHANGES_REQUESTED' THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: only a CHANGES_REQUESTED voucher can be resubmitted (%, %)',
      v_ie.approval_status, v_ie.review_state USING ERRCODE = '55000';
  END IF;
  IF v_ie.review_version <> p_expected_review_version THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: review_version mismatch' USING ERRCODE = '55000';
  END IF;
  -- Guard: no PENDING request may remain open before a fresh submission.
  IF EXISTS (SELECT 1 FROM public.approval_requests ar
             WHERE ar.organization_id = v_ie.organization_id
               AND ar.subject_type = 'INCOME_EXPENSE' AND ar.subject_id = p_voucher
               AND ar.state = 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'resubmit_income_expense_v2: an open approval request already exists' USING ERRCODE = '55000';
  END IF;

  v_new_rev := v_ie.review_version + 1;
  UPDATE public.income_expenses ie
     SET review_state = 'PENDING', review_reason = NULL, change_field_mask = NULL,
         review_version = v_new_rev, updated_at = now()
   WHERE ie.id = p_voucher;

  v_resp := jsonb_build_object('voucherId', p_voucher, 'approvalStatus', 'UNAPPROVED',
                               'reviewState', 'PENDING', 'reviewVersion', v_new_rev);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.resubmit.v2', p_voucher::text, v_uid, p_idempotency_key,
    p_voucher, v_resp, 'RESUBMITTED', v_new_rev, v_ie.approval_version, v_ie.posting_version);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.resubmit.v2', p_voucher, v_uid, p_idempotency_key);
  RETURN v_resp;
END
$function$
;

-- Restore public.list_cashbooks_for_expense_v2(); pre-feature MD5 d3e69a10cf4e1cb6c99698df62d0602a.
CREATE OR REPLACE FUNCTION public.list_cashbooks_for_expense_v2()
 RETURNS TABLE(id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
  SELECT a.id, a.name
  FROM public.cashbook_possession_bindings b
  JOIN public.organization_memberships m ON m.id = b.membership_id
  JOIN public.accounts a ON a.id = b.cashbook_id
  WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
    AND b.valid_to IS NULL AND b.possession_kind = 'CUSTODIAN'
    AND a.deleted_at IS NULL;
$function$
;

-- Restore public.get_room_residence_segments_v1(uuid[]); pre-feature MD5 8ee45965dbcac4333dfac3a25d662f29.
CREATE OR REPLACE FUNCTION public.get_room_residence_segments_v1(p_contract_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(contract_id uuid, contract_number text, seg_index integer, room_id uuid, room_name text, from_date date, to_date date, source_path text, transfer_id uuid, trusted boolean, diagnostic text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH c AS (
    SELECT ct.id, ct.contract_number, ct.room_id AS cur_room,
           ct.start_date, ct.status::text AS c_status, ct.parent_contract_id
      FROM contracts ct
      LEFT JOIN rooms r ON r.id = ct.room_id
     WHERE ct.deleted_at IS NULL
       AND (p_contract_ids IS NULL OR ct.id = ANY(p_contract_ids))
       -- Cổng quyền: không có quyền trên toà ⇒ không thấy gì. Segments là tiện
       -- ích đọc, KHÔNG được thành kênh soi lịch sử toà mình không được xem.
       AND (r.building_id IS NULL
         OR public.can_access_building(r.building_id)
         OR public.ie_all_buildings_scope(r.building_id)
         OR public.is_admin() OR public.is_super_admin())
  ),
  -- Bước chuyển hợp lệ. CỐ Ý loại TENANT_CHANGE (đổi người, không đổi phòng),
  -- DRAFT (chưa duyệt) và CANCELLED (đã bỏ) — chúng KHÔNG cắt đoạn phòng.
  t AS (
    SELECT tr.contract_id,
           tr.id            AS transfer_id,
           tr.old_room_id,
           tr.new_room_id,
           COALESCE(tr.move_out_date, tr.transfer_date) AS eff_out,
           COALESCE(tr.move_in_date,  tr.transfer_date) AS eff_in,
           tr.transfer_date,
           CASE tr.status WHEN 'COMPLETED' THEN 'TRANSFER_ROOM_COMPLETED'
                          WHEN 'APPROVED'  THEN 'TRIGGER_APPROVED'
                          ELSE 'UNKNOWN' END AS source_path,
           row_number() OVER (PARTITION BY tr.contract_id
                              ORDER BY COALESCE(tr.move_in_date, tr.transfer_date),
                                       tr.transfer_date, tr.id) AS rn,
           count(*)    OVER (PARTITION BY tr.contract_id) AS n_tr
      FROM contract_transfers tr
      JOIN c ON c.id = tr.contract_id
     WHERE tr.transfer_type IN ('ROOM_CHANGE','BOTH_CHANGE')
       AND tr.status IN ('COMPLETED','APPROVED')
  ),
  -- Chẩn đoán ở mức HỢP ĐỒNG. Bất kỳ mâu thuẫn nào ⇒ cả chuỗi mất tin cậy.
  diag AS (
    SELECT c.id AS contract_id,
           CASE
             -- Có bằng chứng từng chuyển (dữ liệu lịch sử đường B) mà không có dòng nào
             WHEN (c.c_status = 'TRANSFERRED' OR c.parent_contract_id IS NOT NULL)
                  AND NOT EXISTS (SELECT 1 FROM t WHERE t.contract_id = c.id)
               THEN 'SEGMENT_HISTORY_INCOMPLETE: hợp đồng mang dấu vết đã chuyển (status/parent) nhưng không có dòng contract_transfers nào'
             -- Bước chuyển đầu tiên thiếu phòng cũ ⇒ không neo được đoạn đầu
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id AND t.rn=1 AND t.old_room_id IS NULL)
               THEN 'SEGMENT_HISTORY_INCOMPLETE: bước chuyển đầu tiên thiếu old_room_id'
             -- Thiếu mốc ngày
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id
                            AND (t.eff_in IS NULL OR t.eff_out IS NULL))
               THEN 'SEGMENT_HISTORY_INCOMPLETE: có bước chuyển thiếu mốc ngày (move_in/move_out/transfer_date đều rỗng)'
             -- Thiếu phòng mới
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id AND t.new_room_id IS NULL)
               THEN 'SEGMENT_HISTORY_INCOMPLETE: có bước chuyển thiếu new_room_id'
             -- ⚠ THỨ TỰ HAI PHÉP KIỂM DƯỚI ĐÂY LÀ CÓ CHỦ Ý — tôi từng để ngược và
             -- test bắt được: khi hai bước chuyển TRÙNG NGÀY hiệu lực thì
             -- row_number() xếp chúng theo `(eff_in, transfer_date, id)`, mà id là
             -- tuỳ ý ⇒ THỨ TỰ đã không đáng tin. Mọi kết luận của phép kiểm
             -- "chuỗi có nối" đều dựa trên thứ tự đó, nên nếu chạy trước nó sẽ báo
             -- "chuỗi không nối" — đúng là AMBIGUOUS nhưng SAI NGUYÊN NHÂN, khiến
             -- người rà tay đi tìm lỗi nối trong khi lỗi thật là trùng ngày.
             -- Chẩn đoán gốc phải nói trước.
             WHEN EXISTS (
               SELECT 1 FROM t a JOIN t b
                 ON b.contract_id=a.contract_id AND b.transfer_id <> a.transfer_id
                AND b.eff_in = a.eff_in
                WHERE a.contract_id=c.id)
               THEN 'SEGMENT_HISTORY_AMBIGUOUS: hai bước chuyển cùng ngày hiệu lực — không xác định được thứ tự'
             -- Chuỗi không nối: phòng cũ của bước n phải là phòng mới của bước n−1
             WHEN EXISTS (
               SELECT 1 FROM t a JOIN t b ON b.contract_id=a.contract_id AND b.rn=a.rn-1
                WHERE a.contract_id=c.id AND a.old_room_id IS DISTINCT FROM b.new_room_id)
               THEN 'SEGMENT_HISTORY_AMBIGUOUS: chuỗi chuyển phòng không nối (phòng cũ của bước sau khác phòng mới của bước trước)'
             -- Phòng hiện tại phải bằng phòng mới của bước cuối
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id)
                  AND c.cur_room IS DISTINCT FROM
                      (SELECT t2.new_room_id FROM t t2
                        WHERE t2.contract_id=c.id ORDER BY t2.rn DESC LIMIT 1)
               THEN 'SEGMENT_HISTORY_AMBIGUOUS: contracts.room_id không khớp phòng cuối chuỗi chuyển'
             ELSE NULL
           END AS diagnostic
      FROM c
  ),
  -- Đoạn ĐẦU = phòng cũ của bước chuyển thứ nhất; nếu không có transfer thì là
  -- phòng hiện tại.
  head AS (
    SELECT c.id AS contract_id, c.contract_number, 0 AS seg_index,
           COALESCE((SELECT t.old_room_id FROM t WHERE t.contract_id=c.id AND t.rn=1),
                    c.cur_room) AS room_id,
           -- Step 4: CHỈ tin start_date khi hợp đồng không có transfer và không
           -- mang dấu vết đã chuyển. Ngược lại trả NULL = "chưa biết", KHÔNG bịa.
           CASE WHEN NOT EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id)
                     AND c.c_status <> 'TRANSFERRED'
                     AND c.parent_contract_id IS NULL
                THEN c.start_date ELSE NULL END AS from_date,
           (SELECT t.eff_out FROM t WHERE t.contract_id=c.id AND t.rn=1) AS to_date,
           'CONTRACT_START'::text AS source_path,
           NULL::uuid AS transfer_id
      FROM c
  ),
  -- Mỗi bước chuyển mở một đoạn mới ở phòng mới.
  tail AS (
    SELECT t.contract_id, c.contract_number, t.rn::int AS seg_index,
           t.new_room_id AS room_id,
           t.eff_in AS from_date,
           (SELECT n.eff_out FROM t n
             WHERE n.contract_id=t.contract_id AND n.rn=t.rn+1) AS to_date,
           t.source_path, t.transfer_id
      FROM t JOIN c ON c.id = t.contract_id
  ),
  allseg AS (SELECT * FROM head UNION ALL SELECT * FROM tail)
  SELECT s.contract_id, s.contract_number, s.seg_index, s.room_id,
         r.name AS room_name, s.from_date, s.to_date, s.source_path, s.transfer_id,
         (d.diagnostic IS NULL) AS trusted,
         d.diagnostic
    FROM allseg s
    JOIN diag d ON d.contract_id = s.contract_id
    LEFT JOIN rooms r ON r.id = s.room_id
   ORDER BY s.contract_number NULLS LAST, s.contract_id, s.seg_index;
$function$
;

-- Restore app_private.reservation_pay_refund_v1(uuid,uuid,date); pre-feature MD5 94b846b86cf718a8b7a43e7bb2fbe0b9.
CREATE OR REPLACE FUNCTION app_private.reservation_pay_refund_v1(p_settlement uuid, p_account uuid, p_day date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE s public.reservation_deposit_settlements; a public.accounts; mid uuid; remaining numeric; vid uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement FOR UPDATE;
  PERFORM app_private.reservation_settlement_authorize_v1(s.source_voucher_id);
  SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
  SELECT * INTO a FROM public.accounts WHERE id=p_account FOR UPDATE;
  IF NOT FOUND OR a.organization_id IS DISTINCT FROM s.organization_id OR a.deleted_at IS NOT NULL OR a.is_virtual THEN
    RAISE EXCEPTION 'Chọn sổ quỹ thực đang hoạt động trong tổ chức này để hoàn tiền' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.assert_cashbook_access_v2(s.organization_id,a.id,'CUSTODIAN',mid);
  IF p_day IS NULL OR p_day<s.settlement_date OR p_day>public.org_today_v1(s.organization_id) THEN
    RAISE EXCEPTION 'Ngày hoàn tiền không hợp lệ' USING ERRCODE='22023';
  END IF;
  remaining:=s.refund_amount-app_private.reservation_settlement_refunded_v1(s.id);
  IF remaining<=0 THEN RAISE EXCEPTION 'Khoản cọc này không còn tiền chờ hoàn' USING ERRCODE='55000'; END IF;
  PERFORM app_private.reservation_create_leg_v1(s.id,'REFUND',vid,p_account,p_day,remaining);
  UPDATE public.reservation_deposit_settlements SET refund_voucher_id=vid WHERE id=s.id;
  IF app_private.reservation_settlement_refunded_v1(s.id)<>s.refund_amount THEN
    RAISE EXCEPTION 'Số tiền hoàn đã ghi sổ không khớp' USING ERRCODE='23514';
  END IF;
  RETURN vid;
END $function$
;
-- Restore only the grants/owners changed by the removed feature.
-- Request/resubmit ACLs are evidenced by the live catalog captured 2026-09-20T17:15Z.
GRANT EXECUTE ON FUNCTION public.request_income_expense_changes_v2(uuid,bigint,text,jsonb,text),public.resubmit_income_expense_v2(uuid,bigint,jsonb,text) TO service_role;
ALTER FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date) OWNER TO postgres;
ALTER FUNCTION public.get_room_residence_segments_v1(uuid[]) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.get_room_cash_lifecycle_v1(uuid,date,date),public.get_room_residence_segments_v1(uuid[]) TO service_role;
COMMENT ON FUNCTION public.list_cashbooks_for_expense_v2() IS NULL;
DROP TRIGGER IF EXISTS guard_sale_bonus_link_claim ON public.contract_deposit_links;
DROP TRIGGER IF EXISTS guard_sale_bonus_deposit_claim ON app_private.sale_bonus_claims;
DROP TRIGGER IF EXISTS guard_sale_bonus_voucher_claim ON public.income_expenses;

-- RESTRICT is intentional: any unaccounted dependency aborts the entire transaction.
DROP FUNCTION IF EXISTS
public.read_contract_settlement_page_v1(uuid,uuid[],text,text,integer),
app_private.is_income_expense_review_operation_v1(uuid,uuid),
app_private.authorize_income_expense_review_v1(income_expenses,text),
app_private.income_expense_action_scope_v1(uuid),
public.read_income_expense_action_snapshots_v1(uuid,uuid[]),
app_private.room_lifecycle_org_visible_v1(uuid),
app_private.income_expense_action_capabilities_v1(uuid,uuid),
app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid),
public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer),
app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid),
app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid),
public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid),
public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric),
app_private.contract_settlement_create_facts_v1(uuid,text,uuid),
public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb),
app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text),
public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text),
app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid),
app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean),
app_private.sale_bonus_source_claims_v1(uuid,uuid,uuid),
app_private.guard_sale_bonus_source_claim_v1(),
app_private.reservation_refund_visible_v1(uuid,uuid,uuid),
app_private.reservation_refund_lock_v1(uuid,uuid,uuid),
app_private.reservation_create_refund_pending_leg_v1(uuid,uuid,date,numeric,text,text,text),
public.create_reservation_refund_pending_v1(jsonb),
app_private.reservation_refund_dispatch_authorized_v1(uuid,uuid,text),
public.execute_reservation_refund_action_v1(jsonb),
app_private.reservation_refund_facts_v1(uuid,uuid),
public.read_reservation_refund_workflow_v1(uuid,uuid,uuid),
app_private.reservation_refund_capability_v1(uuid,uuid)
RESTRICT;
DO $role_cleanup$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader') THEN
  REVOKE USAGE ON SCHEMA public,auth,app_private FROM ie_action_snapshot_reader;
  REVOKE SELECT(income_expense_id,organization_id,flow_kind) ON app_private.income_expense_flow_ownership FROM ie_action_snapshot_reader;
  REVOKE SELECT(organization_id,operation,subject_id,completed_at,payload_hash) ON app_private.canonical_write_operations FROM ie_action_snapshot_reader;
  REVOKE authenticated FROM ie_action_snapshot_reader;
  -- DROP ROLE removes membership entries, but refuses all residual object dependencies.
  DROP ROLE ie_action_snapshot_reader;
 END IF;
END $role_cleanup$;
DO $verify$
DECLARE f record; r record; p record; digest jsonb;
BEGIN
 FOR f IN SELECT * FROM (VALUES ('app_private.guard_income_expense_owned_payload()','fb01ae8c9de7b283d19ade8195eba726'),
('public.reverse_posted_income_expense_v2(uuid,uuid,date,text,text)','9fcc9d100dd7fd3a858038a10dc6e701'),
('app_private.finance_v2_post_manual_voucher(income_expenses,uuid,uuid,uuid,date,uuid[],text)','c2d88ccaae0d8c8a0d425ac4d6cd7f7f'),
('public.get_room_cash_lifecycle_v1(uuid,date,date)','2c5c0f54d345ca35c3cac80232c3d837'),
('app_private.reservation_create_leg_v1(uuid,text,uuid,uuid,date,numeric)','61e14ad271c7b79e5931f09ab6d0bed2'),
('public.request_income_expense_changes_v2(uuid,bigint,text,jsonb,text)','c3769605c5ac35134935d49a32a5d1d9'),
('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)','cdc2896ff50e836cb782219683ba5474'),
('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)','fbaed9b582feab422372165eb55a8288'),
('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)','c134aa5857144c2b8f66145f0e9feab5'),
('app_private.finance_v2_birth_provenance_bridge()','a8e8c8c66676f566e52edf888bc43579'),
('public.resubmit_income_expense_v2(uuid,bigint,jsonb,text)','722dcc99bec52a059f7c45c08d085f80'),
('public.list_cashbooks_for_expense_v2()','d3e69a10cf4e1cb6c99698df62d0602a'),
('public.get_room_residence_segments_v1(uuid[])','8ee45965dbcac4333dfac3a25d662f29'),
('app_private.reservation_pay_refund_v1(uuid,uuid,date)','94b846b86cf718a8b7a43e7bb2fbe0b9')) expected(signature,hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure(f.signature))) IS DISTINCT FROM f.hash THEN RAISE EXCEPTION 'Restore: final definition mismatch: %',f.signature; END IF;
 END LOOP;
 FOR f IN SELECT * FROM (VALUES ('app_private.guard_income_expense_owned_payload()','postgres','{postgres=X/postgres}'),
('public.reverse_posted_income_expense_v2(uuid,uuid,date,text,text)','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('app_private.finance_v2_post_manual_voucher(income_expenses,uuid,uuid,uuid,date,uuid[],text)','postgres','{postgres=X/postgres}'),
('public.get_room_cash_lifecycle_v1(uuid,date,date)','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('app_private.reservation_create_leg_v1(uuid,text,uuid,uuid,date,numeric)','postgres','{postgres=X/postgres}'),
('public.request_income_expense_changes_v2(uuid,bigint,text,jsonb,text)','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('app_private.finance_v2_birth_provenance_bridge()','postgres',NULL),
('public.resubmit_income_expense_v2(uuid,bigint,jsonb,text)','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('public.list_cashbooks_for_expense_v2()','postgres','{postgres=X/postgres,authenticated=X/postgres}'),
('public.get_room_residence_segments_v1(uuid[])','postgres','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
('app_private.reservation_pay_refund_v1(uuid,uuid,date)','postgres','{postgres=X/postgres}')) expected(signature,owner,acl) LOOP
  SELECT proowner::regrole::text AS owner,proacl::text AS acl INTO p FROM pg_proc WHERE oid=to_regprocedure(f.signature);
  IF NOT FOUND OR p.owner IS DISTINCT FROM f.owner OR p.acl IS DISTINCT FROM f.acl THEN RAISE EXCEPTION 'Restore: final owner/ACL mismatch: %',f.signature; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader') THEN RAISE EXCEPTION 'Restore: reader role remains'; END IF;
 FOR f IN SELECT * FROM (VALUES ('public.read_contract_settlement_page_v1(uuid,uuid[],text,text,integer)','read_contract_settlement_page_v1'),
('app_private.is_income_expense_review_operation_v1(uuid,uuid)','is_income_expense_review_operation_v1'),
('app_private.authorize_income_expense_review_v1(income_expenses,text)','authorize_income_expense_review_v1'),
('app_private.income_expense_action_scope_v1(uuid)','income_expense_action_scope_v1'),
('public.read_income_expense_action_snapshots_v1(uuid,uuid[])','read_income_expense_action_snapshots_v1'),
('app_private.room_lifecycle_org_visible_v1(uuid)','room_lifecycle_org_visible_v1'),
('app_private.income_expense_action_capabilities_v1(uuid,uuid)','income_expense_action_capabilities_v1'),
('app_private.settlement_event_expense_ids_v1(uuid,uuid,uuid[],uuid)','settlement_event_expense_ids_v1'),
('public.read_contract_settlement_events_v1(uuid,uuid[],text,text,integer)','read_contract_settlement_events_v1'),
('app_private.settlement_financial_source_ids_v1(uuid,uuid,uuid)','settlement_financial_source_ids_v1'),
('app_private.settlement_financial_evidence_v1(uuid,uuid[],uuid)','settlement_financial_evidence_v1'),
('public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)','read_contract_settlement_financial_facts_v1'),
('public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric)','read_contract_settlement_create_source_v1'),
('app_private.contract_settlement_create_facts_v1(uuid,text,uuid)','contract_settlement_create_facts_v1'),
('public.update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb)','update_income_expense_recipient_v1'),
('app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text)','create_termination_refund_voucher_with_recipient_v1'),
('public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text)','create_termination_refund_voucher_v1'),
('app_private.settlement_termination_voucher_link_v1(uuid,uuid,uuid,uuid)','settlement_termination_voucher_link_v1'),
('app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)','settlement_termination_breakdown_v1'),
('app_private.sale_bonus_source_claims_v1(uuid,uuid,uuid)','sale_bonus_source_claims_v1'),
('app_private.guard_sale_bonus_source_claim_v1()','guard_sale_bonus_source_claim_v1'),
('app_private.reservation_refund_visible_v1(uuid,uuid,uuid)','reservation_refund_visible_v1'),
('app_private.reservation_refund_lock_v1(uuid,uuid,uuid)','reservation_refund_lock_v1'),
('app_private.reservation_create_refund_pending_leg_v1(uuid,uuid,date,numeric,text,text,text)','reservation_create_refund_pending_leg_v1'),
('public.create_reservation_refund_pending_v1(jsonb)','create_reservation_refund_pending_v1'),
('app_private.reservation_refund_dispatch_authorized_v1(uuid,uuid,text)','reservation_refund_dispatch_authorized_v1'),
('public.execute_reservation_refund_action_v1(jsonb)','execute_reservation_refund_action_v1'),
('app_private.reservation_refund_facts_v1(uuid,uuid)','reservation_refund_facts_v1'),
('public.read_reservation_refund_workflow_v1(uuid,uuid,uuid)','read_reservation_refund_workflow_v1'),
('app_private.reservation_refund_capability_v1(uuid,uuid)','reservation_refund_capability_v1')) removed(signature,name) LOOP
  IF to_regprocedure(f.signature) IS NOT NULL THEN RAISE EXCEPTION 'Restore: removed function remains: %',f.signature; END IF;
  -- One name also has the restored legacy four-argument overload; its callers stay.
  IF f.name<>'create_termination_refund_voucher_v1' AND EXISTS(SELECT 1 FROM pg_proc proc JOIN pg_namespace n ON n.oid=proc.pronamespace WHERE n.nspname IN('public','app_private','api') AND proc.prokind='f' AND proc.prosrc ~ ('\m'||f.name||'\s*\(')) THEN RAISE EXCEPTION 'Restore: surviving function references removed helper: %',f.name; END IF;
 END LOOP;
 FOR r IN SELECT * FROM pg_temp.restore_settlement_data_witness ORDER BY relation_name LOOP
  EXECUTE format('SELECT jsonb_build_array(count(*),COALESCE(sum((''x''||substr(md5(to_jsonb(t)::text),1,16))::bit(64)::bigint::numeric),0),COALESCE(sum((''x''||substr(md5(to_jsonb(t)::text),17,16))::bit(64)::bigint::numeric),0)) FROM %s t',r.relation_name::regclass) INTO digest;
  IF digest IS DISTINCT FROM r.fingerprint THEN RAISE EXCEPTION 'Restore: business data changed: %',r.relation_name; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.income_expenses'::regclass AND tgname='a00_ie_owned_payload_freeze' AND tgfoid='app_private.guard_income_expense_owned_payload()'::regprocedure AND tgenabled='O') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.income_expenses'::regclass AND tgname='a86_finance_v2_birth_provenance' AND tgfoid='app_private.finance_v2_birth_provenance_bridge()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'Restore: existing voucher protection trigger missing'; END IF;
END $verify$;
NOTIFY pgrst,'reload schema';
COMMIT;
