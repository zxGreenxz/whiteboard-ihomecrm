-- Only attached to the reviewed business tables. Parent identifiers come from
-- trigger arguments owned by this migration, never from a client table name.
CREATE OR REPLACE FUNCTION app_private.fill_business_organization_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  j jsonb := to_jsonb(NEW);
  v_org uuid := NEW.organization_id;
  v_parent uuid;
  v_orgs uuid[];
  i integer := 0;
BEGIN
  IF TG_OP='UPDATE' AND OLD.organization_id IS NOT NULL
    AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Không thể đổi công ty của bản ghi đã có công ty' USING ERRCODE='42501';
  END IF;
  WHILE i<TG_NARGS LOOP
    IF j->>TG_ARGV[i] IS NOT NULL THEN
      EXECUTE format('SELECT organization_id FROM public.%I WHERE id=$1',TG_ARGV[i+1])
        INTO v_parent USING (j->>TG_ARGV[i])::uuid;
      IF v_parent IS NULL THEN
        RAISE EXCEPTION 'Hồ sơ liên kết chưa xác định được công ty' USING ERRCODE='22023';
      END IF;
      IF v_org IS NOT NULL AND v_org<>v_parent THEN
        RAISE EXCEPTION 'Các hồ sơ liên kết phải thuộc cùng công ty' USING ERRCODE='42501';
      END IF;
      v_org := v_parent;
    END IF;
    i := i+2;
  END LOOP;
  IF v_org IS NULL AND auth.uid() IS NOT NULL THEN
    v_org := app_private.working_organization_v1();
  ELSIF v_org IS NULL AND j->>'user_id' IS NOT NULL THEN
    -- Service writers may retain one proven owner company, never a default.
    SELECT array_agg(DISTINCT m.organization_id) INTO v_orgs
      FROM public.organization_memberships m
     WHERE m.user_id=(j->>'user_id')::uuid
       AND app_private.active_working_membership_v1(m.user_id,m.organization_id);
    IF cardinality(v_orgs)=1 THEN v_org := v_orgs[1]; END IF;
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Chưa xác định được công ty cho bản ghi' USING ERRCODE='22023';
  END IF;
  NEW.organization_id := v_org;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION app_private.fill_business_organization_v1() FROM PUBLIC,anon,authenticated,service_role;
