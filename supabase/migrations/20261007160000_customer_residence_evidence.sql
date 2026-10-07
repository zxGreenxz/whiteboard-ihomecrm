-- Contract facts remain separate from confirmed personal residence evidence.
-- Forward-only correction: never rewrite the immutable event ledger.

CREATE OR REPLACE FUNCTION app_private.residence_iso_date_v1(p_day date)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN isfinite(p_day) AND p_day BETWEEN date '0001-01-01' AND date '9999-12-31'
    THEN to_char(p_day, 'YYYY-MM-DD') END
$$;

-- Expiry alone is not departure. Only a completed CREATE_NEW renewal whose
-- successor explicitly points back proves that the old contract was replaced.
CREATE OR REPLACE FUNCTION app_private.residence_contract_current_v2(p_contract uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contracts c
    WHERE c.id = p_contract AND c.deleted_at IS NULL
      AND c.status::text IN ('ACTIVE', 'EXTENDED', 'EXPIRED')
      AND c.actual_end_date IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.contract_exit_cases x WHERE x.contract_id = c.id)
      AND NOT (c.status::text = 'EXPIRED' AND EXISTS (
        SELECT 1 FROM public.contract_extensions e
        JOIN public.contracts successor ON successor.id = e.new_contract_id
          AND successor.parent_contract_id = c.id
          AND successor.organization_id = c.organization_id
        WHERE e.contract_id = c.id AND e.extension_type::text = 'CREATE_NEW'
          AND e.status IN ('APPROVED', 'COMPLETED')
      ))
  )
$$;
REVOKE ALL ON FUNCTION app_private.residence_iso_date_v1(date),
  app_private.residence_contract_current_v2(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Only entering the final state captures current parties. A later metadata
-- edit or APPROVED -> COMPLETED transition cannot turn today's members into
-- parties to a historical operation. Snapshot sources are immutable/idempotent.
CREATE OR REPLACE FUNCTION app_private.record_residence_source_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN (
    'contract_transfers', 'contract_extensions', 'contract_terminations'
  ) THEN
    IF OLD.status IN ('APPROVED', 'COMPLETED') THEN RETURN NEW; END IF;
    IF NEW.status NOT IN ('APPROVED', 'COMPLETED') THEN RETURN NEW; END IF;
  END IF;
  PERFORM app_private.ingest_residence_source_v1(TG_TABLE_NAME, to_jsonb(NEW));
  RETURN NEW;
END
$$;

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
    GREATEST(t.created_at, t.approved_at)>=transaction_timestamp() AND to_jsonb(t)->>'old_tenant_id'=OLD.customer_id::text) THEN
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
    AND t.status IN ('APPROVED', 'COMPLETED' ) AND GREATEST(t.created_at, t.approved_at)>=transaction_timestamp() AND
    to_jsonb(t)->>'new_tenant_id'=cu::text) THEN RETURN NULL;
END IF;

  -- A direct insert proves an administrative membership action, not arrival.
  k:='MEMBER_ADDED';

 ELSE
  IF EXISTS(SELECT 1 FROM public.contract_transfers t WHERE t.contract_id=c.id AND t.transfer_type='TENANT_CHANGE'
    AND t.status IN ('APPROVED', 'COMPLETED' ) AND GREATEST(t.created_at, t.approved_at)>=transaction_timestamp() AND
    to_jsonb(t)->>'old_tenant_id'=cu::text) THEN RETURN NULL;
END IF;

  k:='MEMBER_REMOVED';
 END IF;

 PERFORM app_private.append_customer_residence_v1(c.id, cu, k, public.org_today_v1(c.organization_id), null,
   auth.uid());

 RETURN NULL;

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

  k:='CONTRACT_ACTIVATED';
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
    t.new_room_id=NEW.room_id AND GREATEST(t.created_at, t.approved_at)>=transaction_timestamp() AND t.status IN ('APPROVED', 'COMPLETED' ))
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
 WHERE c.organization_id=p_organization_id AND cc.customer_id=ANY(p_customer_ids) AND app_private.residence_contract_current_v2(c.id)),
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
   SELECT jsonb_build_object('date', app_private.residence_iso_date_v1(candidate.effective_date), 'kind', candidate.kind)
   FROM (
     SELECT e.id, e.kind, e.recorded_at,
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
               AND arrival.kind IN ('MEMBER_ADDED', 'CHECKED_IN', 'CONTRACT_ACTIVATED', 'TENANT_TRANSFER_IN' )
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
 'departure_date' , CASE WHEN NOT restricted AND jsonb_array_length(accommodations)=0 THEN departure->'date' END,
 'departure_kind', CASE WHEN NOT restricted AND jsonb_array_length(accommodations)=0 THEN departure->'kind' END,
 'last_contract_end', CASE WHEN NOT restricted AND jsonb_array_length(accommodations)=0
   AND has_history AND departure IS NULL
   AND NOT EXISTS (SELECT 1 FROM app_private.customer_residence_events e
     WHERE e.organization_id=p_organization_id AND e.customer_id=summaries.customer_id AND e.kind<>'OBSERVED')
   -- Every known OBSERVED association must be accounted for. An older known
   -- end cannot fill an unknown, hidden or deleted later contract's ending.
   AND NOT EXISTS (
     SELECT 1 FROM (
       SELECT e.contract_id FROM app_private.customer_residence_events e
       WHERE e.organization_id=p_organization_id AND e.customer_id=summaries.customer_id
       UNION
       SELECT cc.contract_id FROM public.contract_customers cc
       WHERE cc.customer_id=summaries.customer_id
     ) ref
     LEFT JOIN public.contracts known ON known.id=ref.contract_id
     LEFT JOIN public.rooms known_room ON known_room.id=known.room_id
     WHERE (known.organization_id=p_organization_id AND known.deleted_at IS NULL
       AND known.status::text IN ('TERMINATED','TRANSFERRED','EXPIRED')
       AND app_private.residence_iso_date_v1(known.actual_end_date) IS NOT NULL
       AND app_private.residence_scope_v1(known.organization_id,known_room.building_id)) IS NOT TRUE
   )
   THEN (SELECT jsonb_build_object('contract_id', c.id, 'date', app_private.residence_iso_date_v1(c.actual_end_date))
     FROM public.contract_customers cc JOIN public.contracts c ON c.id=cc.contract_id
     JOIN public.rooms r ON r.id=c.room_id
     WHERE cc.customer_id=summaries.customer_id AND c.organization_id=p_organization_id
       AND c.status::text IN ('TERMINATED','TRANSFERRED','EXPIRED')
       AND app_private.residence_iso_date_v1(c.actual_end_date) IS NOT NULL
       AND app_private.residence_scope_v1(c.organization_id,r.building_id)
     ORDER BY c.actual_end_date DESC,c.id LIMIT 1) END,
 'incomplete' , incomplete OR restricted OR (has_history AND jsonb_array_length(accommodations)=0 AND (departure IS NULL OR departure->>'date' IS NULL))) ORDER BY customer_id), '[]' ) INTO result FROM summaries;

 RETURN result;

END $$;

CREATE OR REPLACE FUNCTION public.get_customer_residence_history_v1(
  p_organization_id uuid, p_customer_id uuid, p_before_id bigint DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'Invalid history page' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.assert_residence_reader_v1(p_organization_id, ARRAY[p_customer_id]);

  WITH page AS MATERIALIZED (
    SELECT e.* FROM app_private.customer_residence_events e
    WHERE e.organization_id = p_organization_id AND e.customer_id = p_customer_id
      AND (p_before_id IS NULL OR e.id < p_before_id)
      AND app_private.residence_scope_v1(e.organization_id, e.building_id)
    ORDER BY e.id DESC LIMIT p_limit + 1
  ), shown AS MATERIALIZED (
    SELECT * FROM page ORDER BY id DESC LIMIT p_limit
  ), referenced AS (
    SELECT contract_id FROM shown
    UNION
    SELECT cc.contract_id FROM public.contract_customers cc
    JOIN public.contracts c ON c.id = cc.contract_id
    WHERE p_before_id IS NULL AND cc.customer_id = p_customer_id
      AND c.organization_id = p_organization_id
  ), visible_contracts AS MATERIALIZED (
    -- An old visible event does not authorize revealing a now-hidden room.
    SELECT c.*, r.building_id, r.name AS room_name, b.name AS building_name
    FROM referenced ref JOIN public.contracts c ON c.id = ref.contract_id
    JOIN public.rooms r ON r.id = c.room_id
    JOIN public.buildings b ON b.id = r.building_id
    WHERE c.organization_id = p_organization_id
      AND app_private.residence_scope_v1(c.organization_id, r.building_id)
  ), segments AS MATERIALIZED (
    SELECT s.*, b.name AS building_name
    FROM public.get_room_residence_segments_v1(
      ARRAY(SELECT id FROM visible_contracts)
    ) s
    JOIN visible_contracts c ON c.id = s.contract_id
    JOIN public.rooms r ON r.id = s.room_id
    JOIN public.buildings b ON b.id = r.building_id
    -- The canonical reader has its own scope; apply this reader's stricter
    -- contracts.view + historical building + organization scope to every row.
    WHERE app_private.residence_scope_v1(c.organization_id, r.building_id)
  ), contexts AS (
    SELECT jsonb_build_object(
      'contract_id', c.id, 'contract_number', c.contract_number, 'status', c.status::text,
      'building_id', c.building_id, 'room_id', c.room_id,
      'building_name', c.building_name, 'room_name', c.room_name,
      'signed_date', app_private.residence_iso_date_v1(c.signed_date),
      'start_date', app_private.residence_iso_date_v1(c.start_date),
      'end_date', app_private.residence_iso_date_v1(c.end_date),
      'actual_end_date', app_private.residence_iso_date_v1(c.actual_end_date),
      'room_segments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'room_id', s.room_id, 'room_name', s.room_name, 'building_name', s.building_name,
        'from_date', app_private.residence_iso_date_v1(s.from_date),
        'to_date', app_private.residence_iso_date_v1(s.to_date),
        'source_path', s.source_path, 'trusted', s.trusted, 'diagnostic', s.diagnostic
      ) ORDER BY s.seg_index) FROM segments s WHERE s.contract_id = c.id), '[]'::jsonb)
    ) AS value, c.id
    FROM visible_contracts c
  )
  SELECT jsonb_build_object(
    'events', COALESCE((SELECT jsonb_agg(to_jsonb(s)-'source_key' ORDER BY id DESC) FROM shown s), '[]'::jsonb),
    'next_before_id', CASE WHEN (SELECT count(*) FROM page) > p_limit
      THEN (SELECT min(id) FROM shown) END,
    'contract_contexts', COALESCE((SELECT jsonb_agg(value ORDER BY id) FROM contexts), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION app_private.refresh_residence_customer_v1(p_customer uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.customers cu SET status_v2=CASE WHEN EXISTS(
  SELECT 1 FROM public.contract_customers cc JOIN public.contracts c ON c.id=cc.contract_id
  WHERE cc.customer_id=cu.id AND c.organization_id=cu.organization_id AND app_private.residence_contract_current_v2(c.id)
 ) THEN 'RENTING' ::public.customer_status_v2 ELSE 'MOVED_OUT' ::public.customer_status_v2 END,
 updated_at=clock_timestamp() WHERE cu.id=p_customer;

END $$;

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
 WHERE c.organization_id=p_organization_id AND app_private.residence_contract_current_v2(c.id)
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

CREATE OR REPLACE FUNCTION public.customer_residence_matches_location_v1(p_org uuid, p_customer uuid, p_building
  uuid, p_room uuid, p_history boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_customers cc JOIN public.contracts c ON c.id=cc.contract_id JOIN
   public.rooms r ON r.id=c.room_id
 WHERE cc.customer_id=p_customer AND c.organization_id=p_org AND app_private.residence_contract_current_v2(c.id)
 AND (p_building IS NULL OR r.building_id=p_building) AND (p_room IS NULL OR r.id=p_room) AND
   app_private.residence_scope_v1(p_org, r.building_id))
 OR (p_history AND EXISTS(SELECT 1 FROM app_private.customer_residence_events e WHERE e.organization_id=p_org AND
   e.customer_id=p_customer
 AND (p_building IS NULL OR e.building_id=p_building) AND (p_room IS NULL OR e.room_id=p_room) AND
   app_private.residence_scope_v1(p_org, e.building_id)))
$$;

-- Replacements preserve grants; spell out the intended surface again.
REVOKE ALL ON FUNCTION app_private.record_residence_source_v1(),
  app_private.record_residence_membership_v1(), app_private.record_residence_contract_v1(),
  app_private.refresh_residence_customer_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_customer_residence_history_v1(uuid,uuid,bigint,integer),
  public.get_customer_residence_summaries_v1(uuid,uuid[]),
  public.get_customer_residence_location_ids_v1(uuid,uuid,uuid,boolean,uuid,integer),
  public.customer_residence_matches_location_v1(uuid,uuid,uuid,uuid,boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_residence_history_v1(uuid,uuid,bigint,integer),
  public.get_customer_residence_summaries_v1(uuid,uuid[]),
  public.get_customer_residence_location_ids_v1(uuid,uuid,uuid,boolean,uuid,integer),
  public.customer_residence_matches_location_v1(uuid,uuid,uuid,uuid,boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
