-- Ký, nhận phòng, thu cọc và nối hồ sơ nhượng phải cùng thành công trong một giao dịch.
-- Giữ nguyên nội dung các writer hiện hành, bao gồm kiểm phiên bản và bằng chứng hoa hồng.
DO $patch$
DECLARE
  edit record;
  body text;
  patched text;
BEGIN
  FOR edit IN SELECT * FROM (VALUES
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])',
     'v_result:=public.create_contract_v2(v_payload,''draft-sign:''||d.id::text);',
     'PERFORM app_private.assert_contract_transfer_draft_v1(d.id);', true),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])',
     'UPDATE public.contract_drafts SET status=''SIGNED'',converted_contract_id=c.id WHERE id=d.id;',
     'PERFORM app_private.complete_contract_transfer_signing_v1(d.id,c.id);', false),
    ('public.cancel_contract_transfer_link_v1(uuid,uuid,bigint,text,uuid)',
     'IF p_expected_version IS NULL OR l.version<>p_expected_version',
     $guard$IF EXISTS (SELECT 1 FROM public.contract_drafts d WHERE d.id=l.new_draft_id AND d.status='SIGNED') THEN
    RAISE EXCEPTION 'Hợp đồng mới đã ký, cần đối soát hồ sơ nhượng trước khi xử lý' USING ERRCODE='55000';
  END IF;$guard$, true),
    ('public.create_contract_transfer_commission_v1(uuid,uuid,bigint,uuid,uuid,text,text)',
     'IF l.commission_voucher_id IS NOT NULL THEN RETURN app_private.contract_transfer_response_v1(l.id); END IF;',
     $zero$IF l.broker_fee=0 THEN RETURN app_private.contract_transfer_response_v1(l.id); END IF;$zero$, false)
  ) AS changes(signature, anchor, addition, insert_before) LOOP
    body := pg_get_functiondef(edit.signature::regprocedure);
    IF length(body)-length(replace(body,edit.anchor,'')) <> length(edit.anchor) THEN
      RAISE EXCEPTION 'Thân hàm % đã đổi, cần kiểm lại điểm nối nghiệp vụ nhượng',edit.signature;
    END IF;
    patched := CASE WHEN edit.insert_before THEN edit.addition||chr(10)||'  '||edit.anchor
                    ELSE edit.anchor||chr(10)||'  '||edit.addition END;
    IF strpos(body,edit.addition)=0 THEN
      EXECUTE replace(body,edit.anchor,patched);
    ELSIF strpos(body,patched)=0 OR length(body)-length(replace(body,edit.addition,''))<>length(edit.addition) THEN
      RAISE EXCEPTION 'Hàm % có kiểm nhượng sai vị trí hoặc bị lặp',edit.signature;
    END IF;
  END LOOP;
END
$patch$;

-- Bản ký và biên nhận tạo hợp đồng là nguồn bất biến cho số cọc tại thời điểm ký.
-- Hợp đồng có thể đã đổi tiền cọc, hết hạn hoặc thu thêm sau đó.
-- Chỉ bổ sung liên kết và nhật ký. Hợp đồng, chứng từ và số dư giữ theo nghiệp vụ gốc.
WITH matched AS (
  SELECT l.id, s.contract_id, s.signed_by
  FROM public.contract_transfer_links l
  JOIN public.contract_drafts d ON d.id=l.new_draft_id AND d.status='SIGNED'
    AND (d.organization_id,d.building_id,d.room_id,d.revision) =
        (l.organization_id,l.building_id,l.room_id,l.new_draft_revision)
  JOIN public.contract_draft_signings s ON s.draft_id=d.id AND s.contract_id=d.converted_contract_id
    AND (s.organization_id,s.building_id,s.room_id,s.revision) =
        (l.organization_id,l.building_id,l.room_id,l.new_draft_revision)
  JOIN public.contracts c ON c.id=s.contract_id AND c.id<>l.old_contract_id
    AND c.organization_id=l.organization_id AND c.room_id=l.room_id AND c.deleted_at IS NULL
  JOIN public.contract_exit_cases e ON e.id=l.old_exit_case_id AND e.contract_id=l.old_contract_id
    AND (e.organization_id,e.building_id,e.room_at_handover_id)=(l.organization_id,l.building_id,l.room_id)
  JOIN app_private.canonical_write_operations op ON op.organization_id=l.organization_id
    AND op.operation='contract.create.v2' AND op.actor_id=s.signed_by AND op.subject_id=s.contract_id
    AND op.subject_scope=l.room_id::text||'|'||l.starts_on::text
    AND op.idempotency_key='draft-sign:'||d.id::text AND op.completed_at IS NOT NULL
  WHERE l.state='LINKED' AND l.new_contract_id IS NULL AND l.deposit_mode='NEW_PAYMENT'
    AND s.signed_at>=l.created_at AND s.received_on=l.starts_on AND s.terms=d.payload
    AND s.terms->'customers'=l.new_party_snapshot AND e.party_snapshot=l.old_party_snapshot
    AND s.terms->'form'->>'start_date'=l.starts_on::text AND s.terms->'form'->>'end_date'=l.ends_on::text
    AND s.terms->'form'->'total_deposit'=to_jsonb(l.new_deposit_required)
    AND op.response_payload->'contract'->>'id'=c.id::text
    AND (l.mode='SELF_FOUND' OR (
      op.response_payload->'deposit_shortfall'='0'::jsonb
      AND jsonb_typeof(op.response_payload->'deposit_paid')='number'
      AND op.response_payload->'deposit_paid'>=to_jsonb(l.new_deposit_required)))
    AND NOT EXISTS (SELECT 1 FROM app_private.contract_transfer_events h WHERE h.link_id=l.id AND h.event='NEW_SIGNED')
    AND NOT EXISTS (SELECT 1 FROM public.contract_transfer_links other WHERE other.new_contract_id=c.id)
  FOR UPDATE OF l
), repaired AS (
  UPDATE public.contract_transfer_links l SET new_contract_id=m.contract_id,version=l.version+1,updated_at=clock_timestamp()
  FROM matched m WHERE l.id=m.id AND l.state='LINKED' AND l.new_contract_id IS NULL
  RETURNING l.id,l.organization_id,l.version,m.signed_by
)
INSERT INTO app_private.contract_transfer_events(link_id,organization_id,event,version,actor_id,reason)
SELECT id,organization_id,'NEW_SIGNED',version,signed_by,
  'Khôi phục liên kết theo bản ký và biên nhận tạo hợp đồng đã đối chiếu; người ký lấy từ bản ký gốc'
FROM repaired;

CREATE OR REPLACE FUNCTION app_private.contract_transfer_response_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT (to_jsonb(l)-ARRAY['old_party_snapshot','new_party_snapshot','intent_hash','request_id','new_deposit_required'])
    ||jsonb_build_object(
      'deposit_base',CASE WHEN app_private.contract_draft_scope_allowed(l.organization_id,l.building_id,'contracts.edit') THEN l.deposit_base END,
      'broker_fee',CASE WHEN app_private.contract_draft_scope_allowed(l.organization_id,l.building_id,'contracts.edit') THEN l.broker_fee END,
      'new_contract_number',c.contract_number,'commission_code',v.code,'commission_approval_status',v.approval_status,
      'signed_needs_review',l.state='LINKED' AND l.new_contract_id IS NULL AND d.status='SIGNED',
      'no_commission_due',l.state='LINKED' AND l.mode='BROKER' AND l.fee_state='APPLIED' AND l.broker_fee=0
        AND l.commission_voucher_id IS NULL AND (l.new_contract_id IS NOT NULL OR d.status<>'SIGNED'),
      'money_state',CASE
        WHEN l.state='LINKED' AND l.new_contract_id IS NULL AND d.status='SIGNED' THEN 'NEEDS_REVIEW'
        WHEN l.deposit_mode='OLD_DEPOSIT_OFFSET' THEN 'NEEDS_REVIEW'
        WHEN l.mode='SELF_FOUND' THEN 'INDEPENDENT'
        WHEN l.fee_state='PENDING' THEN 'FEE_PENDING'
        WHEN l.commission_voucher_id IS NOT NULL THEN 'COMMISSION_LINKED'
        ELSE 'COMMISSION_PENDING' END,
      'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('event',h.event,'version',h.version,'reason',h.reason,'actor_id',h.actor_id,
        'actor_name',p.full_name,'created_at',h.created_at) ORDER BY h.version)
        FROM app_private.contract_transfer_events h LEFT JOIN public.profiles p ON p.id=h.actor_id WHERE h.link_id=l.id),'[]'::jsonb))
  FROM public.contract_transfer_links l JOIN public.contract_drafts d ON d.id=l.new_draft_id
    LEFT JOIN public.contracts c ON c.id=l.new_contract_id LEFT JOIN public.income_expenses v ON v.id=l.commission_voucher_id
  WHERE l.id=p_id
$fn$;
