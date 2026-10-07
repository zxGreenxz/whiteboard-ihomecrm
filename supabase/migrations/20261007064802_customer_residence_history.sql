-- Durable customer residence evidence. No FK to mutable/deletable business rows.
CREATE TABLE IF NOT EXISTS app_private.customer_residence_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL, customer_id uuid NOT NULL, contract_id uuid NOT NULL,
 building_id uuid, room_id uuid, building_name text, room_name text, contract_number text,
 kind text NOT NULL, effective_date date, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason text, actor_id uuid, actor_name text, incomplete boolean NOT NULL DEFAULT false,
 source_key text UNIQUE
);

CREATE INDEX IF NOT EXISTS customer_residence_events_subject ON
  app_private.customer_residence_events(organization_id, customer_id, id DESC);

REVOKE ALL ON app_private.customer_residence_events FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE app_private.customer_residence_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_private.guard_customer_residence_events_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Residence evidence is immutable' USING ERRCODE='55000';
 END $$;

DROP TRIGGER IF EXISTS immutable_customer_residence_events ON app_private.customer_residence_events;

CREATE TRIGGER immutable_customer_residence_events BEFORE UPDATE OR DELETE ON app_private.customer_residence_events
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_customer_residence_events_v1();

CREATE OR REPLACE FUNCTION app_private.residence_scope_v1(p_org uuid, p_building uuid, p_action text DEFAULT 'view'
  ) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT auth.uid() IS NOT NULL AND COALESCE(p_org=ANY(public.my_org_ids()), false)
 AND NOT COALESCE(public.is_super_admin() AND p_org=ANY(public.sandbox_org_ids()), false)
 AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=p_building AND b.organization_id=p_org)
 AND COALESCE(public.can_access_building(p_building), false)
 AND COALESCE(public.can_do_on_building('contracts', p_action, p_building), false)
$$;

CREATE OR REPLACE FUNCTION app_private.append_customer_residence_v1(p_contract uuid, p_customer uuid, p_kind text,
  p_date date, p_reason text DEFAULT null, p_actor uuid DEFAULT null, p_source text DEFAULT null, p_incomplete
  boolean DEFAULT false, p_room uuid DEFAULT null, p_snapshot jsonb DEFAULT '{}' ::jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO app_private.customer_residence_events(organization_id, customer_id, contract_id, building_id, room_id,
   building_name, room_name, contract_number, kind, effective_date, reason, actor_id, actor_name, source_key,
   incomplete, recorded_at)
 SELECT c.organization_id, p_customer, c.id, r.building_id, r.id,
 CASE WHEN p_snapshot ? 'building_name' THEN p_snapshot->>'building_name' ELSE b.name END,
 CASE WHEN p_snapshot ? 'room_name' THEN p_snapshot->>'room_name' ELSE r.name END,
 CASE WHEN p_snapshot ? 'contract_number' THEN p_snapshot->>'contract_number' ELSE c.contract_number END,
 p_kind, p_date, p_reason, p_actor,
 (SELECT full_name FROM public.profiles WHERE id=p_actor), p_source, p_incomplete OR p_date IS NULL,
 COALESCE((p_snapshot->>'recorded_at')::timestamptz, clock_timestamp())
 FROM public.contracts c JOIN public.customers cu ON cu.id=p_customer AND cu.organization_id=c.organization_id
 LEFT JOIN public.rooms r ON r.id=COALESCE(p_room, c.room_id) LEFT JOIN public.buildings b ON b.id=r.building_id
 WHERE c.id=p_contract AND c.organization_id IS NOT NULL
 ON CONFLICT(source_key) DO NOTHING;

END $$;

-- Lock parent for every membership mutation, including direct DML, to serialize with reconciliation.
CREATE OR REPLACE FUNCTION app_private.guard_residence_membership_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.contracts%ROWTYPE;

BEGIN
 IF TG_OP='UPDATE' AND (NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.organization_id IS DISTINCT FROM
   OLD.organization_id) THEN
  RAISE EXCEPTION 'Membership contract and organization are immutable' USING ERRCODE='22023';
 END IF;

 SELECT * INTO c FROM public.contracts WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.contract_id ELSE NEW.contract_id
   END FOR UPDATE;

 IF TG_OP='INSERT' AND NEW.organization_id IS NULL THEN NEW.organization_id:=c.organization_id;
END IF;

 IF TG_OP<>'DELETE' AND (c.id IS NULL OR NEW.organization_id IS DISTINCT FROM c.organization_id OR NOT
   EXISTS(SELECT 1 FROM public.customers cu WHERE cu.id=NEW.customer_id AND cu.organization_id=c.organization_id))
   THEN
  RAISE EXCEPTION 'Membership organization mismatch' USING ERRCODE='42501';
 END IF;

 IF TG_OP='DELETE' THEN RETURN OLD;
 END IF;
 RETURN NEW;

END $$;

DROP TRIGGER IF EXISTS guard_residence_membership ON public.contract_customers;

CREATE TRIGGER guard_residence_membership BEFORE INSERT OR UPDATE OR DELETE ON public.contract_customers FOR EACH
  ROW EXECUTE FUNCTION app_private.guard_residence_membership_v1();

CREATE OR REPLACE FUNCTION app_private.record_residence_membership_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.contracts%ROWTYPE;
 cu uuid;
 k text;

BEGIN
 SELECT * INTO c FROM public.contracts WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.contract_id ELSE NEW.contract_id
   END;

 IF c.id IS NULL OR c.deleted_at IS NOT NULL OR c.status::text NOT IN ('ACTIVE', 'EXTENDED' , 'EXPIRED' ) THEN
   RETURN NULL;
 END IF;

 IF TG_OP='UPDATE' THEN
  IF NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN RETURN NULL;
END IF;

  IF NOT EXISTS(SELECT 1 FROM public.contract_transfers t WHERE t.contract_id=c.id AND
    t.transfer_type='TENANT_CHANGE' AND t.status IN ('APPROVED', 'COMPLETED' ) AND
    t.created_at>=transaction_timestamp() AND to_jsonb(t)->>'old_tenant_id'=OLD.customer_id::text) THEN
   PERFORM app_private.append_customer_residence_v1(c.id, OLD.customer_id, 'MEMBER_REMOVED' ,
     public.org_today_v1(c.organization_id), null, auth.uid());

  END IF;

 END IF;

 cu:=CASE WHEN TG_OP='DELETE' THEN OLD.customer_id ELSE NEW.customer_id END;

 IF TG_OP IN ('INSERT', 'UPDATE' ) THEN
  -- A signing snapshot in this transaction already records its exact parties and received date.
  IF EXISTS(SELECT 1 FROM public.contract_draft_signings s WHERE s.contract_id=c.id AND
    s.signed_at>=transaction_timestamp()
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.party_snapshot) p WHERE p->>'id'=cu::text)) THEN RETURN NULL;
 END IF;

  IF EXISTS(SELECT 1 FROM public.contract_transfers t WHERE t.contract_id=c.id AND t.transfer_type='TENANT_CHANGE'
    AND t.status IN ('APPROVED', 'COMPLETED' ) AND t.created_at>=transaction_timestamp() AND
    to_jsonb(t)->>'new_tenant_id'=cu::text) THEN RETURN NULL;
END IF;

  k:=CASE WHEN c.created_at>=transaction_timestamp() THEN 'CHECKED_IN' ELSE 'MEMBER_ADDED' END;

 ELSE
  IF EXISTS(SELECT 1 FROM public.contract_transfers t WHERE t.contract_id=c.id AND t.transfer_type='TENANT_CHANGE'
    AND t.status IN ('APPROVED', 'COMPLETED' ) AND t.created_at>=transaction_timestamp() AND
    to_jsonb(t)->>'old_tenant_id'=cu::text) THEN RETURN NULL;
END IF;

  k:='MEMBER_REMOVED';
 END IF;

 PERFORM app_private.append_customer_residence_v1(c.id, cu, k, public.org_today_v1(c.organization_id), null,
   auth.uid());

 RETURN NULL;

END $$;

DROP TRIGGER IF EXISTS record_residence_membership ON public.contract_customers;

CREATE CONSTRAINT TRIGGER record_residence_membership AFTER INSERT OR UPDATE OR DELETE ON public.contract_customers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.record_residence_membership_v1();

-- A single source dispatcher also supports evidence-only backfill. Backfill never attributes old
-- contract-only audits to today's member list; only party snapshots prove those identities.
CREATE OR REPLACE FUNCTION app_private.ingest_residence_source_v1(p_table text, p_row jsonb, p_backfill boolean
  DEFAULT false) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE cid uuid:=(p_row->>'contract_id')::uuid;
 cu uuid;
 k text;
 d date;
 party jsonb;
 room uuid;
 reason text;
 actor uuid;
 snapshot jsonb;

BEGIN
 SELECT COALESCE(jsonb_object_agg(key, value), '{}' ::jsonb) INTO snapshot
 FROM jsonb_each(p_row) WHERE key IN ('building_name', 'room_name' , 'contract_number' );

 snapshot:=snapshot||jsonb_build_object('recorded_at', COALESCE(p_row->>'signed_at', p_row->>'created_at'));

 IF p_table='contract_draft_signings' THEN
  k:='CHECKED_IN';
room:=(p_row->>'room_id')::uuid;
d:=(p_row->>'received_on')::date;
party:=p_row->'party_snapshot';
actor:=(p_row->>'signed_by')::uuid;

 ELSIF p_table='contract_exit_cases' THEN
  k:=p_row->>'initial_kind';
room:=(p_row->>'room_at_handover_id')::uuid;
d:=(p_row->>'actual_move_out_on')::date;
party:=p_row->'party_snapshot'->'customers';
reason:=p_row->>'return_note';
actor:=(p_row->>'physical_actor')::uuid;

 ELSIF p_table='contract_transfers' AND p_row->>'transfer_type'='TENANT_CHANGE' AND p_row->>'status' IN
   ('APPROVED', 'COMPLETED' ) THEN
  IF p_row->>'old_tenant_id' IS NOT NULL THEN PERFORM app_private.append_customer_residence_v1(cid,
    (p_row->>'old_tenant_id')::uuid, 'TENANT_TRANSFER_OUT' , (p_row->>'transfer_date')::date, p_row->>'reason',
    (p_row->>'approved_by')::uuid, 'transfer-out:' ||(p_row->>'id'), p_backfill, (p_row->>'old_room_id')::uuid,
    snapshot);
END IF;

  IF p_row->>'new_tenant_id' IS NOT NULL THEN PERFORM app_private.append_customer_residence_v1(cid,
    (p_row->>'new_tenant_id')::uuid, 'TENANT_TRANSFER_IN' , (p_row->>'transfer_date')::date, p_row->>'reason',
    (p_row->>'approved_by')::uuid, 'transfer-in:' ||(p_row->>'id'), p_backfill, (p_row->>'new_room_id')::uuid,
    snapshot);
END IF;

  RETURN;

 ELSE
  IF p_backfill OR p_row->>'status' NOT IN ('APPROVED', 'COMPLETED' ) THEN RETURN;
 END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id', customer_id)), '[]' ) INTO party FROM
    public.contract_customers WHERE contract_id=cid;

  actor:=(p_row->>'approved_by')::uuid;

  IF p_table='contract_transfers' THEN
   IF p_row->>'transfer_type'<>'ROOM_CHANGE' THEN RETURN;
 END IF;

   k:='ROOM_CHANGED';
d:=(p_row->>'transfer_date')::date;
room:=(p_row->>'new_room_id')::uuid;
reason:=p_row->>'reason';

  ELSIF p_table='contract_extensions' THEN k:='RENEWED';
d:=(p_row->>'extension_date')::date;
reason:=p_row->>'notes';

  ELSIF p_table='contract_terminations' THEN
   IF EXISTS(SELECT 1 FROM public.contract_exit_cases WHERE contract_id=cid) THEN RETURN;
 END IF;

   k:=CASE WHEN p_row->>'termination_type' ILIKE '%FORFEIT%' THEN 'FORFEIT' ELSE 'TERMINATED' END;

   d:=(p_row->>'actual_move_out_date')::date;
reason:=COALESCE(p_row->>'notes', p_row->>'termination_type');

  END IF;

 END IF;

 IF k IS NULL THEN RETURN;
 END IF;

 FOR cu IN SELECT COALESCE(p->>'customer_id', p->>'id')::uuid FROM jsonb_array_elements(COALESCE(party, '[]' )) p
   LOOP
  PERFORM app_private.append_customer_residence_v1(cid, cu, k, d, reason, actor,
    p_table||':'||(p_row->>'id')||':'||cu::text, p_backfill, room, snapshot);

 END LOOP;

END $$;

CREATE OR REPLACE FUNCTION app_private.record_residence_source_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN PERFORM app_private.ingest_residence_source_v1(TG_TABLE_NAME, to_jsonb(NEW));
RETURN NEW;
 END $$;

DO $$ DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['contract_draft_signings', 'contract_exit_cases' , 'contract_terminations' ,
   'contract_transfers' , 'contract_extensions' ] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS record_residence_source ON public.%I', t);

  EXECUTE format('CREATE TRIGGER record_residence_source AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE
    FUNCTION app_private.record_residence_source_v1()', t);

 END LOOP;

END $$;

CREATE OR REPLACE FUNCTION app_private.record_residence_contract_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE cu uuid;
 k text;
 d date;
 target_room uuid;

BEGIN
 IF TG_OP='DELETE' OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN k:='CONTRACT_DELETED';

 ELSIF OLD.status::text='DRAFT' AND NEW.status::text IN ('ACTIVE', 'EXTENDED' ) THEN
  IF EXISTS(SELECT 1 FROM public.contract_draft_signings s WHERE s.contract_id=OLD.id AND
    s.signed_at>=transaction_timestamp()) THEN RETURN NEW;
END IF;

  k:='CHECKED_IN';
d:=public.org_today_v1(NEW.organization_id);

 ELSIF NEW.status::text IN ('TERMINATED', 'TRANSFERRED' ) AND OLD.status IS DISTINCT FROM NEW.status THEN
  IF EXISTS(SELECT 1 FROM public.contract_exit_cases WHERE contract_id=OLD.id) OR EXISTS(SELECT 1 FROM
    public.contract_terminations WHERE contract_id=OLD.id AND status IN ('APPROVED', 'COMPLETED' )) THEN RETURN
    NEW;
END IF;

  k:='TERMINATED';
d:=NEW.actual_end_date;

 ELSIF NEW.room_id IS DISTINCT FROM OLD.room_id THEN
  IF EXISTS(SELECT 1 FROM public.contract_transfers t WHERE t.contract_id=OLD.id AND t.old_room_id=OLD.room_id AND
    t.new_room_id=NEW.room_id AND t.created_at>=transaction_timestamp() AND t.status IN ('APPROVED', 'COMPLETED' ))
    THEN RETURN NEW;
END IF;

  k:='ROOM_CHANGED';
target_room:=NEW.room_id;
 -- no audit date: leave effective date unknown
 ELSE RETURN NEW;
 END IF;

 FOR cu IN SELECT customer_id FROM public.contract_customers WHERE contract_id=OLD.id LOOP
  PERFORM app_private.append_customer_residence_v1(OLD.id, cu, k, d, null, auth.uid(), null, d IS NULL,
    target_room);

 END LOOP;

 IF TG_OP='DELETE' THEN RETURN OLD;
END IF;
RETURN NEW;

END $$;

DROP TRIGGER IF EXISTS record_residence_contract ON public.contracts;

CREATE TRIGGER record_residence_contract BEFORE DELETE ON public.contracts FOR EACH ROW EXECUTE FUNCTION
  app_private.record_residence_contract_v1();

DROP TRIGGER IF EXISTS record_residence_contract_update ON public.contracts;

CREATE CONSTRAINT TRIGGER record_residence_contract_update AFTER UPDATE ON public.contracts DEFERRABLE INITIALLY
  DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.record_residence_contract_v1();

-- Seed evidence once. Existing relations prove association, never the date of arrival.
DO $$ DECLARE r record;
BEGIN
 FOR r IN SELECT to_jsonb(s) data FROM public.contract_draft_signings s LOOP PERFORM
   app_private.ingest_residence_source_v1('contract_draft_signings', r.data, true);
END LOOP;

 FOR r IN SELECT to_jsonb(s) data FROM public.contract_transfers s WHERE s.transfer_type='TENANT_CHANGE' LOOP
   PERFORM app_private.ingest_residence_source_v1('contract_transfers', r.data, true);
END LOOP;

 FOR r IN SELECT to_jsonb(s) data FROM public.contract_exit_cases s LOOP PERFORM
   app_private.ingest_residence_source_v1('contract_exit_cases', r.data, true);
END LOOP;

 FOR r IN SELECT cc.contract_id, cc.customer_id FROM public.contract_customers cc JOIN public.contracts c ON
   c.id=cc.contract_id WHERE c.status::text<>'DRAFT' LOOP
  IF NOT EXISTS(SELECT 1 FROM app_private.customer_residence_events e WHERE e.contract_id=r.contract_id AND
    e.customer_id=r.customer_id) THEN
   PERFORM app_private.append_customer_residence_v1(r.contract_id, r.customer_id, 'OBSERVED' , null, null, null,
     'legacy:' ||r.contract_id||':'||r.customer_id, true);

  END IF;

 END LOOP;

END $$;

CREATE OR REPLACE FUNCTION public.reconcile_contract_customers_v1(p_organization_id uuid, p_contract_id uuid,
  p_expected jsonb, p_customers jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.contracts%ROWTYPE;
 b uuid;
 actual jsonb;
 expected jsonb;
 desired jsonb;

BEGIN
 SELECT * INTO c FROM public.contracts WHERE id=p_contract_id;

 SELECT building_id INTO b FROM public.rooms WHERE id=c.room_id;

 IF c.id IS NULL OR c.organization_id IS DISTINCT FROM p_organization_id OR NOT
   app_private.residence_scope_v1(p_organization_id, b, 'edit' ) THEN RAISE EXCEPTION
   'Không có quyền sửa khách hợp đồng' USING ERRCODE='42501';
 END IF;

 SELECT * INTO c FROM public.contracts WHERE id=p_contract_id FOR UPDATE;

 SELECT building_id INTO b FROM public.rooms WHERE id=c.room_id;

 IF c.organization_id IS DISTINCT FROM p_organization_id OR NOT app_private.residence_scope_v1(p_organization_id,
   b, 'edit' ) THEN RAISE EXCEPTION 'Contract scope changed' USING ERRCODE='42501';
END IF;

 IF c.deleted_at IS NOT NULL OR c.status::text NOT IN ('ACTIVE', 'EXTENDED' , 'EXPIRED' , 'DRAFT' ) THEN RAISE
   EXCEPTION 'Hợp đồng đã đóng' USING ERRCODE='55000';
END IF;

 IF jsonb_typeof(p_expected) IS DISTINCT FROM 'array' OR jsonb_typeof(p_customers) IS DISTINCT FROM 'array' OR
   jsonb_array_length(p_customers)>200 THEN RAISE EXCEPTION 'Invalid members' USING ERRCODE='22023';
END IF;

 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_customers||p_expected) j WHERE jsonb_typeof(j->'customer_id') IS
   DISTINCT FROM 'string' OR jsonb_typeof(j->'is_representative') IS DISTINCT FROM 'boolean' OR (j ? 'notes' AND
   jsonb_typeof(j->'notes') NOT IN ('string', 'null' ))) THEN RAISE EXCEPTION 'Invalid member fields' USING
   ERRCODE='22023';
END IF;

 IF (SELECT count(*)<>count(DISTINCT j->>'customer_id') FROM jsonb_array_elements(p_customers) j) THEN RAISE
   EXCEPTION 'Duplicate members' USING ERRCODE='22023';
END IF;

 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_customers) j LEFT JOIN public.customers cu ON
   cu.id=(j->>'customer_id')::uuid WHERE cu.id IS NULL OR cu.organization_id IS DISTINCT FROM p_organization_id OR
   cu.deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'Customer organization mismatch' USING ERRCODE='42501';
END IF;

 SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id', customer_id, 'is_representative' , is_representative,
   'notes' , notes) ORDER BY customer_id), '[]' ) INTO actual FROM public.contract_customers WHERE
   contract_id=p_contract_id;

 SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id', j->>'customer_id', 'is_representative' ,
   (j->>'is_representative')::boolean, 'notes' , j->>'notes') ORDER BY j->>'customer_id'), '[]' ) INTO expected
   FROM jsonb_array_elements(p_expected) j;

 SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id', j->>'customer_id', 'is_representative' ,
   (j->>'is_representative')::boolean, 'notes' , j->>'notes') ORDER BY j->>'customer_id'), '[]' ) INTO desired FROM
   jsonb_array_elements(p_customers) j;

 IF actual=desired THEN RETURN actual;
 END IF;

 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Danh sách khách đã thay đổi; tải lại để đối chiếu' USING
   ERRCODE='PT409';
 END IF;

 DELETE FROM public.contract_customers WHERE contract_id=p_contract_id AND customer_id NOT IN(SELECT
   (j->>'customer_id')::uuid FROM jsonb_array_elements(desired) j);

 UPDATE public.contract_customers cc SET is_representative=false WHERE cc.contract_id=p_contract_id AND
   cc.is_representative AND EXISTS(SELECT 1 FROM jsonb_array_elements(desired) j WHERE
   (j->>'customer_id')::uuid=cc.customer_id AND (j->>'is_representative')::boolean=false);

 UPDATE public.contract_customers cc SET is_representative=(j->>'is_representative')::boolean, notes=j->>'notes',
   updated_at=clock_timestamp()
 FROM jsonb_array_elements(desired) j WHERE cc.contract_id=p_contract_id AND
   cc.customer_id=(j->>'customer_id')::uuid
 AND (cc.is_representative IS DISTINCT FROM (j->>'is_representative')::boolean OR cc.notes IS DISTINCT FROM
   j->>'notes');

 INSERT INTO public.contract_customers(contract_id, customer_id, organization_id, is_representative, notes)
 SELECT p_contract_id, (j->>'customer_id')::uuid, p_organization_id, (j->>'is_representative')::boolean,
   j->>'notes' FROM jsonb_array_elements(desired) j
 WHERE NOT EXISTS(SELECT 1 FROM public.contract_customers cc WHERE cc.contract_id=p_contract_id AND
   cc.customer_id=(j->>'customer_id')::uuid);

 RETURN desired;

END $$;

CREATE OR REPLACE FUNCTION app_private.assert_residence_reader_v1(p_org uuid, p_customers uuid[]) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_org=ANY(public.my_org_ids()), false) OR COALESCE(public.is_super_admin()
   AND p_org=ANY(public.sandbox_org_ids()), false)
 OR EXISTS(SELECT 1 FROM unnest(p_customers) x LEFT JOIN public.customers c ON c.id=x WHERE c.id IS NULL OR
   c.organization_id IS DISTINCT FROM p_org) THEN
  RAISE EXCEPTION 'Không có quyền xem lịch sử khách hàng' USING ERRCODE='42501';
 END IF;

END $$;

CREATE OR REPLACE FUNCTION public.get_customer_residence_summaries_v1(p_organization_id uuid, p_customer_ids
  uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;

BEGIN
 IF p_customer_ids IS NULL OR cardinality(p_customer_ids)>200 OR array_position(p_customer_ids, null) IS NOT NULL
   THEN RAISE EXCEPTION 'Invalid customer page' USING ERRCODE='22023';
 END IF;

 PERFORM app_private.assert_residence_reader_v1(p_organization_id, p_customer_ids);

 WITH subjects AS(SELECT DISTINCT unnest(p_customer_ids) customer_id),
 current_rows AS(SELECT cc.customer_id, c.id contract_id, r.id room_id, r.building_id, r.name room_name, b.name
   building_name,
 app_private.residence_scope_v1(c.organization_id, r.building_id) visible
 FROM public.contract_customers cc JOIN public.contracts c ON c.id=cc.contract_id LEFT JOIN public.rooms r ON
   r.id=c.room_id LEFT JOIN public.buildings b ON b.id=r.building_id
 WHERE c.organization_id=p_organization_id AND cc.customer_id=ANY(p_customer_ids) AND c.deleted_at IS NULL AND
   c.status::text IN ('ACTIVE', 'EXTENDED' , 'EXPIRED' ) AND c.actual_end_date IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.contract_exit_cases x WHERE x.contract_id=c.id)),
 summaries AS(SELECT s.customer_id,
 COALESCE((SELECT jsonb_agg(to_jsonb(r)-'customer_id'-'visible' ORDER BY r.contract_id) FROM current_rows r WHERE
   r.customer_id=s.customer_id AND r.visible), '[]' ) accommodations,
 EXISTS(SELECT 1 FROM current_rows r WHERE r.customer_id=s.customer_id AND NOT r.visible) OR EXISTS(SELECT 1 FROM
   app_private.customer_residence_events e WHERE e.organization_id=p_organization_id AND
   e.customer_id=s.customer_id AND NOT app_private.residence_scope_v1(e.organization_id, e.building_id))
   restricted,
 EXISTS(SELECT 1 FROM app_private.customer_residence_events e WHERE e.organization_id=p_organization_id AND
   e.customer_id=s.customer_id) has_history,
 (
   SELECT candidate.effective_date
   FROM (
     SELECT e.id, e.recorded_at,
       CASE WHEN e.kind = 'CONTRACT_DELETED' THEN (
         -- Deleting an ended contract retains its actual exit. A later arrival
         -- in the same contract starts another stint, whose unknown end stays null.
         SELECT prior.effective_date
         FROM app_private.customer_residence_events prior
         WHERE prior.organization_id = e.organization_id
           AND prior.customer_id = e.customer_id
           AND prior.contract_id = e.contract_id
           AND prior.id < e.id
           AND prior.kind IN ('MEMBER_REMOVED', 'TERMINATED' , 'EARLY_RETURN' , 'ON_TIME_RETURN' , 'NATURAL_EXPIRY'
             , 'FORFEIT' )
           AND NOT EXISTS (
             SELECT 1 FROM app_private.customer_residence_events arrival
             WHERE arrival.customer_id = e.customer_id
               AND arrival.contract_id = e.contract_id
               AND arrival.id < e.id
               AND arrival.kind IN ('MEMBER_ADDED', 'CHECKED_IN' , 'TENANT_TRANSFER_IN' )
               AND (COALESCE(arrival.effective_date, (arrival.recorded_at AT TIME ZONE 'UTC' )::date),
                 arrival.recorded_at, arrival.id)
                 > (COALESCE(prior.effective_date, (prior.recorded_at AT TIME ZONE 'UTC' )::date),
                   prior.recorded_at, prior.id)
           )
         ORDER BY prior.effective_date DESC NULLS LAST, prior.recorded_at DESC, prior.id DESC
         LIMIT 1
       ) ELSE e.effective_date END AS effective_date
     FROM app_private.customer_residence_events e
     WHERE e.organization_id = p_organization_id
       AND e.customer_id = s.customer_id
       AND e.kind IN ('MEMBER_REMOVED', 'TERMINATED' , 'EARLY_RETURN' , 'ON_TIME_RETURN' , 'NATURAL_EXPIRY' ,
         'FORFEIT' , 'CONTRACT_DELETED' )
   ) candidate
   -- Event IDs order pages, not business time. Late old audits cannot replace
   -- a newer effective departure. Unknown endings use their source record time
   -- conservatively, so a recent unknown stint never borrows an older exit date.
   ORDER BY COALESCE(candidate.effective_date, (candidate.recorded_at AT TIME ZONE 'UTC' )::date) DESC,
     candidate.recorded_at DESC, candidate.id DESC
   LIMIT 1
 ) departure,
 EXISTS(SELECT 1 FROM app_private.customer_residence_events e WHERE e.organization_id=p_organization_id AND
   e.customer_id=s.customer_id AND e.incomplete) incomplete
 FROM subjects s)
 SELECT COALESCE(jsonb_agg(jsonb_build_object('customer_id', customer_id, 'current_accommodations' ,
   accommodations,
 'state' , CASE WHEN jsonb_array_length(accommodations)>0 THEN 'CURRENT' WHEN restricted THEN 'UNKNOWN' WHEN
   has_history THEN 'DEPARTED' ELSE 'NONE' END,
 'departure_date' , CASE WHEN NOT restricted AND jsonb_array_length(accommodations)=0 THEN departure END,
 'incomplete' , incomplete OR restricted OR (has_history AND jsonb_array_length(accommodations)=0 AND departure IS
   NULL)) ORDER BY customer_id), '[]' ) INTO result FROM summaries;

 RETURN result;

END $$;

CREATE OR REPLACE FUNCTION public.get_customer_residence_history_v1(p_organization_id uuid, p_customer_id uuid,
  p_before_id bigint DEFAULT null, p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;

BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_customer_id IS NULL THEN RAISE EXCEPTION
   'Invalid history page' USING ERRCODE='22023';
END IF;

 PERFORM app_private.assert_residence_reader_v1(p_organization_id, ARRAY[p_customer_id]);

 WITH page AS(SELECT e.* FROM app_private.customer_residence_events e WHERE e.organization_id=p_organization_id AND
   e.customer_id=p_customer_id
 AND (p_before_id IS NULL OR e.id<p_before_id) AND app_private.residence_scope_v1(e.organization_id, e.building_id)
   ORDER BY e.id DESC LIMIT p_limit+1),
 shown AS(SELECT * FROM page ORDER BY id DESC LIMIT p_limit)
 SELECT jsonb_build_object('events', COALESCE((SELECT jsonb_agg(to_jsonb(s)-'source_key' ORDER BY id DESC) FROM
   shown s), '[]' ),
 'next_before_id' , CASE WHEN (SELECT count(*) FROM page)>p_limit THEN (SELECT min(id) FROM shown) END) INTO
   result;

 RETURN result;

END $$;

REVOKE ALL ON FUNCTION app_private.guard_customer_residence_events_v1(), app_private.residence_scope_v1(uuid, uuid,
  text), app_private.append_customer_residence_v1(uuid, uuid, text, date, text, uuid, text, boolean, uuid, jsonb),
  app_private.guard_residence_membership_v1(), app_private.record_residence_membership_v1(),
  app_private.ingest_residence_source_v1(text, jsonb, boolean), app_private.record_residence_source_v1(),
  app_private.record_residence_contract_v1(), app_private.assert_residence_reader_v1(uuid, uuid[]) FROM PUBLIC,
  anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.reconcile_contract_customers_v1(uuid, uuid, jsonb, jsonb),
  public.get_customer_residence_summaries_v1(uuid, uuid[]), public.get_customer_residence_history_v1(uuid, uuid,
  bigint, integer) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.reconcile_contract_customers_v1(uuid, uuid, jsonb, jsonb),
  public.get_customer_residence_summaries_v1(uuid, uuid[]), public.get_customer_residence_history_v1(uuid, uuid,
  bigint, integer) TO authenticated;

-- Final-state projection drives existing customer tabs and the existing customers realtime channel.
CREATE OR REPLACE FUNCTION app_private.refresh_residence_customer_v1(p_customer uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.customers cu SET status_v2=CASE WHEN EXISTS(
  SELECT 1 FROM public.contract_customers cc JOIN public.contracts c ON c.id=cc.contract_id
  WHERE cc.customer_id=cu.id AND c.organization_id=cu.organization_id AND c.deleted_at IS NULL
  AND c.status::text IN ('ACTIVE', 'EXTENDED' , 'EXPIRED' ) AND c.actual_end_date IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.contract_exit_cases x WHERE x.contract_id=c.id)
 ) THEN 'RENTING' ::public.customer_status_v2 ELSE 'MOVED_OUT' ::public.customer_status_v2 END,
 updated_at=clock_timestamp() WHERE cu.id=p_customer;

END $$;

CREATE OR REPLACE FUNCTION app_private.refresh_residence_customer_trigger_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN PERFORM app_private.refresh_residence_customer_v1(NEW.customer_id);
RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS refresh_residence_customer ON app_private.customer_residence_events;

CREATE CONSTRAINT TRIGGER refresh_residence_customer AFTER INSERT ON app_private.customer_residence_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.refresh_residence_customer_trigger_v1();

-- Backfill is limited to customers with evidence; never reclassify an unrelated walk-in.
DO $$ DECLARE cu uuid;
BEGIN FOR cu IN SELECT DISTINCT customer_id FROM app_private.customer_residence_events LOOP PERFORM
  app_private.refresh_residence_customer_v1(cu);
END LOOP;
END $$;

REVOKE ALL ON FUNCTION app_private.refresh_residence_customer_v1(uuid),
  app_private.refresh_residence_customer_trigger_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_customer_residence_location_ids_v1(p_organization_id uuid, p_building_id uuid
  DEFAULT null, p_room_id uuid DEFAULT null, p_include_history boolean DEFAULT false, p_after_id uuid DEFAULT null,
  p_limit integer DEFAULT 500) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;

BEGIN
 PERFORM app_private.assert_residence_reader_v1(p_organization_id, ARRAY[]::uuid[]);

 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 OR (p_building_id IS NULL AND p_room_id IS NULL) THEN RAISE
   EXCEPTION 'Invalid location page' USING ERRCODE='22023';
END IF;

 WITH ids AS(
 SELECT cc.customer_id FROM public.contract_customers cc JOIN public.contracts c ON c.id=cc.contract_id JOIN
   public.rooms r ON r.id=c.room_id
 WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status::text IN ('ACTIVE', 'EXTENDED' ,
   'EXPIRED' ) AND c.actual_end_date IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.contract_exit_cases x WHERE x.contract_id=c.id)
 AND (p_building_id IS NULL OR r.building_id=p_building_id) AND (p_room_id IS NULL OR r.id=p_room_id) AND
   app_private.residence_scope_v1(p_organization_id, r.building_id)
 UNION
 SELECT e.customer_id FROM app_private.customer_residence_events e WHERE p_include_history AND
   e.organization_id=p_organization_id
 AND (p_building_id IS NULL OR e.building_id=p_building_id) AND (p_room_id IS NULL OR e.room_id=p_room_id) AND
   app_private.residence_scope_v1(e.organization_id, e.building_id)
 ) SELECT COALESCE(jsonb_agg(customer_id ORDER BY customer_id), '[]' ) INTO result FROM (SELECT customer_id FROM
   ids WHERE p_after_id IS NULL OR customer_id>p_after_id ORDER BY customer_id LIMIT p_limit) page;

 RETURN result;

END $$;

REVOKE ALL ON FUNCTION public.get_customer_residence_location_ids_v1(uuid, uuid, uuid, boolean, uuid, integer) FROM
  PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.get_customer_residence_location_ids_v1(uuid, uuid, uuid, boolean, uuid, integer)
  TO authenticated;

-- Shared scoped predicate keeps the existing statistics contract aligned with the location picker.
CREATE OR REPLACE FUNCTION public.customer_residence_matches_location_v1(p_org uuid, p_customer uuid, p_building
  uuid, p_room uuid, p_history boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_customers cc JOIN public.contracts c ON c.id=cc.contract_id JOIN
   public.rooms r ON r.id=c.room_id
 WHERE cc.customer_id=p_customer AND c.organization_id=p_org AND c.deleted_at IS NULL AND c.status::text IN
   ('ACTIVE', 'EXTENDED' , 'EXPIRED' ) AND c.actual_end_date IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.contract_exit_cases x WHERE x.contract_id=c.id)
 AND (p_building IS NULL OR r.building_id=p_building) AND (p_room IS NULL OR r.id=p_room) AND
   app_private.residence_scope_v1(p_org, r.building_id))
 OR (p_history AND EXISTS(SELECT 1 FROM app_private.customer_residence_events e WHERE e.organization_id=p_org AND
   e.customer_id=p_customer
 AND (p_building IS NULL OR e.building_id=p_building) AND (p_room IS NULL OR e.room_id=p_room) AND
   app_private.residence_scope_v1(p_org, e.building_id)))
$$;

REVOKE ALL ON FUNCTION public.customer_residence_matches_location_v1(uuid, uuid, uuid, uuid, boolean) FROM PUBLIC,
  anon, service_role;

GRANT EXECUTE ON FUNCTION public.customer_residence_matches_location_v1(uuid, uuid, uuid, uuid, boolean) TO
  authenticated;

CREATE OR REPLACE FUNCTION public.get_customer_stats(p_status text DEFAULT null, p_search text DEFAULT null,
  p_building_id uuid DEFAULT null, p_room_id uuid DEFAULT null)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('total', count(*), 'individual' , count(*) FILTER(WHERE
   cu.customer_type::text='INDIVIDUAL'),
 'organization' , count(*) FILTER(WHERE cu.customer_type::text='ORGANIZATION'), 'foreign' , count(*) FILTER(WHERE
   cu.is_foreign=true))
 FROM public.customers cu WHERE cu.deleted_at IS NULL AND (p_status IS NULL OR cu.status_v2::text=p_status)
 AND ((p_building_id IS NULL AND p_room_id IS NULL) OR
   public.customer_residence_matches_location_v1(cu.organization_id, cu.id, p_building_id, p_room_id,
   COALESCE(p_status<>'RENTING', true)))
 AND (p_search IS NULL OR btrim(p_search)='' OR cu.full_name ILIKE '%' ||p_search||'%' OR cu.phone ILIKE '%'
   ||p_search||'%' OR cu.email ILIKE '%' ||p_search||'%' OR cu.id_number ILIKE '%' ||p_search||'%')
$$;

REVOKE ALL ON FUNCTION public.get_customer_stats(text, text, uuid, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_customer_stats(text, text, uuid, uuid) TO authenticated;
