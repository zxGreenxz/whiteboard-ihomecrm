-- ACB Gmail inbox: private transport state, owner-bound authorization and atomic V5 posting.
-- No transaction wrapper: compatible with TEST forward migration lane.
SET lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.bank_email_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL,
 bank_account text NOT NULL UNIQUE CHECK(bank_account ~ '^[0-9]{6,30}$'),
 account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
 enabled boolean NOT NULL DEFAULT false,
 auto_enabled_at timestamptz,
 status text NOT NULL DEFAULT 'DISCONNECTED' CHECK(status IN ('DISCONNECTED','AUTHORIZING','CONNECTED','RECONNECT_REQUIRED')),
 email text,
 last_synced_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.bank_email_transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 connection_id uuid NOT NULL REFERENCES public.bank_email_connections(id) ON DELETE RESTRICT,
 message_id text NOT NULL CHECK(length(message_id) BETWEEN 1 AND 128),
 internal_date timestamptz NOT NULL,
 verified boolean NOT NULL,
 account text, amount numeric, balance numeric, currency text, direction text,
 occurred_at timestamptz, bank_reference text, description text,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','POSTED','IGNORED')),
 reason text,
 invoice_id uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
 receipt jsonb,
 created_at timestamptz NOT NULL UNIQUE,
 UNIQUE(connection_id,message_id)
);
CREATE INDEX IF NOT EXISTS bank_email_transactions_org_cursor ON public.bank_email_transactions(organization_id,created_at DESC);
-- Bank reference claim survives posting reversal, reauthorization and mailbox redelivery.
CREATE TABLE IF NOT EXISTS app_private.bank_email_sources (
 bank_account text NOT NULL, bank_reference text NOT NULL,
 transaction_id uuid NOT NULL REFERENCES public.bank_email_transactions(id) ON DELETE RESTRICT,
 PRIMARY KEY(bank_account,bank_reference), UNIQUE(transaction_id)
);
CREATE TABLE IF NOT EXISTS app_private.bank_email_credentials (
 connection_id uuid PRIMARY KEY REFERENCES public.bank_email_connections(id) ON DELETE RESTRICT,
 email text NOT NULL UNIQUE CHECK(email=lower(email)),
 encrypted_refresh_token text NOT NULL CHECK(length(encrypted_refresh_token) BETWEEN 1 AND 16384),
 history_id numeric(40,0), watch_expires_at timestamptz,
 scan_page_token text, scan_history_id numeric(40,0),
 history_page_token text, history_start_id numeric(40,0)
);
CREATE TABLE IF NOT EXISTS app_private.bank_email_page_messages (
 connection_id uuid NOT NULL REFERENCES app_private.bank_email_credentials(connection_id) ON DELETE CASCADE,
 message_id text NOT NULL CHECK(message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 PRIMARY KEY(connection_id,message_id)
);
-- Replace only the draft implementation's bounded progress cache on TEST reapplication.
ALTER TABLE app_private.bank_email_credentials DROP COLUMN IF EXISTS processed_message_ids;
CREATE TABLE IF NOT EXISTS app_private.bank_email_oauth_states (
 state_hash text PRIMARY KEY CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 connection_id uuid NOT NULL REFERENCES public.bank_email_connections(id) ON DELETE RESTRICT,
 encrypted_verifier text NOT NULL CHECK(length(encrypted_verifier) BETWEEN 1 AND 16384),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS app_private.bank_email_jobs (
 connection_id uuid PRIMARY KEY REFERENCES public.bank_email_connections(id) ON DELETE RESTRICT,
 generation bigint NOT NULL DEFAULT 1, claimed_generation bigint,
 due_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_token uuid, leased_until timestamptz
);
REVOKE ALL ON app_private.bank_email_sources,app_private.bank_email_credentials,app_private.bank_email_page_messages,
 app_private.bank_email_oauth_states,app_private.bank_email_jobs FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.bank_email_connections,public.bank_email_transactions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.bank_email_connections,public.bank_email_transactions TO authenticated;
ALTER TABLE public.bank_email_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_email_transactions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_private.bank_email_assert_actor_v1(p_org uuid,p_owner uuid,p_account uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE m uuid; a boolean;
BEGIN
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_owner THEN RAISE EXCEPTION 'bank_email_not_permitted' USING ERRCODE='42501'; END IF;
 SELECT id INTO m FROM public.organization_memberships WHERE organization_id=p_org AND user_id=p_owner AND status='ACTIVE'
  AND coalesce(valid_from,'-infinity'::timestamptz)<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp()) LIMIT 1;
 IF m IS NULL OR NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=p_org AND status='ACTIVE')
 OR NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=p_account AND organization_id=p_org AND deleted_at IS NULL AND NOT coalesce(is_virtual,false)) THEN
 RAISE EXCEPTION 'bank_email_not_permitted' USING ERRCODE='42501'; END IF;
 SELECT org_wide INTO a FROM app_private.authorized_scope_v3('auto_debt.edit',p_org);
 IF NOT coalesce(a,false) OR app_private.ie_has_cashbook_possession_v1(p_org,p_account,m) IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM public.buildings b WHERE b.organization_id=p_org AND b.deleted_at IS NULL
  AND public.can_access_building(b.id) IS TRUE
  AND coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(p_owner,p_org,'thu_tien.collect',b.id,NULL)),false)
  AND app_private.receiving_cashbook_allowed_v1(p_org,b.id,'TK',m,p_account) IS TRUE) THEN
 RAISE EXCEPTION 'bank_email_not_permitted' USING ERRCODE='42501'; END IF;
 RETURN m;
END $fn$;
CREATE OR REPLACE FUNCTION public.bank_email_access_v1(p_connection_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.bank_email_connections;
BEGIN
 SELECT * INTO c FROM public.bank_email_connections WHERE id=p_connection_id;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
 RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $fn$;
CREATE OR REPLACE FUNCTION public.bank_email_transaction_access_v1(p_transaction_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.bank_email_connections; t public.bank_email_transactions; i public.invoices; m uuid;
BEGIN
 SELECT * INTO t FROM public.bank_email_transactions WHERE id=p_transaction_id;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO c FROM public.bank_email_connections WHERE id=t.connection_id;
 m:=app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
 IF t.invoice_id IS NULL THEN RETURN true; END IF;
 SELECT * INTO i FROM public.invoices WHERE id=t.invoice_id AND deleted_at IS NULL;
 RETURN i.id IS NOT NULL AND public.can_access_building(i.building_id) IS TRUE
  AND coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(c.owner_id,c.organization_id,'thu_tien.collect',i.building_id,NULL)),false)
  AND app_private.receiving_cashbook_allowed_v1(c.organization_id,i.building_id,'TK',m,c.account_id) IS TRUE;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $fn$;
DROP POLICY IF EXISTS bank_email_connections_owner ON public.bank_email_connections;
CREATE POLICY bank_email_connections_owner ON public.bank_email_connections FOR SELECT TO authenticated USING(public.bank_email_access_v1(id));
DROP POLICY IF EXISTS bank_email_transactions_owner ON public.bank_email_transactions;
CREATE POLICY bank_email_transactions_owner ON public.bank_email_transactions FOR SELECT TO authenticated USING(public.bank_email_transaction_access_v1(id));
DROP POLICY IF EXISTS bank_email_connections_hide_sandbox_admin ON public.bank_email_connections;
CREATE POLICY bank_email_connections_hide_sandbox_admin ON public.bank_email_connections AS RESTRICTIVE FOR ALL TO authenticated
 USING(NOT coalesce(organization_id=ANY(public.sandbox_org_ids()),false)) WITH CHECK(NOT coalesce(organization_id=ANY(public.sandbox_org_ids()),false));
DROP POLICY IF EXISTS bank_email_transactions_hide_sandbox_admin ON public.bank_email_transactions;
CREATE POLICY bank_email_transactions_hide_sandbox_admin ON public.bank_email_transactions AS RESTRICTIVE FOR ALL TO authenticated
 USING(NOT coalesce(organization_id=ANY(public.sandbox_org_ids()),false)) WITH CHECK(NOT coalesce(organization_id=ANY(public.sandbox_org_ids()),false));

CREATE OR REPLACE FUNCTION app_private.bank_email_connection_json_v1(c public.bank_email_connections)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object('id',c.id,'organizationId',c.organization_id,'bankAccount',c.bank_account,'accountId',c.account_id,
 'enabled',c.enabled,'autoEnabledAt',c.auto_enabled_at,'status',c.status,'email',c.email,'lastSyncedAt',c.last_synced_at,'lastError',c.last_error,'createdAt',c.created_at)
$fn$;
CREATE OR REPLACE FUNCTION app_private.bank_email_receipt_v1(t public.bank_email_transactions)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object('id',t.id,'status',t.status,'reason',t.reason,'invoiceId',t.invoice_id,'receipt',t.receipt)
$fn$;
CREATE OR REPLACE FUNCTION app_private.bank_email_transaction_json_v1(t public.bank_email_transactions)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app_private AS $fn$
 SELECT app_private.bank_email_receipt_v1(t)||jsonb_build_object('connectionId',t.connection_id,'messageId',t.message_id,'internalDate',t.internal_date,
 'verified',t.verified,'account',t.account,'amount',t.amount,'balance',t.balance,'currency',t.currency,'direction',t.direction,
 'occurredAt',t.occurred_at,'bankReference',t.bank_reference,'description',t.description,'createdAt',t.created_at)
$fn$;

CREATE OR REPLACE FUNCTION public.bank_email_setup_v1(p_organization_id uuid,p_bank_account text,p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.bank_email_connections;
BEGIN
 PERFORM app_private.bank_email_assert_actor_v1(p_organization_id,auth.uid(),p_account_id);
 IF p_bank_account IS NULL OR p_bank_account !~ '^[0-9]{6,30}$' THEN RAISE EXCEPTION 'bank_email_invalid_account' USING ERRCODE='22023'; END IF;
 INSERT INTO public.bank_email_connections(organization_id,owner_id,bank_account,account_id)
 VALUES(p_organization_id,auth.uid(),p_bank_account,p_account_id) ON CONFLICT(bank_account) DO NOTHING;
 SELECT * INTO c FROM public.bank_email_connections WHERE bank_account=p_bank_account FOR UPDATE;
 IF c.organization_id IS DISTINCT FROM p_organization_id OR c.owner_id IS DISTINCT FROM auth.uid() OR c.account_id IS DISTINCT FROM p_account_id THEN
 RAISE EXCEPTION 'bank_email_account_already_mapped' USING ERRCODE='23505'; END IF;
 RETURN app_private.bank_email_connection_json_v1(c);
END $fn$;
CREATE OR REPLACE FUNCTION public.bank_email_set_enabled_v1(p_connection_id uuid,p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.bank_email_connections;
BEGIN
 SELECT * INTO c FROM public.bank_email_connections WHERE id=p_connection_id FOR UPDATE;
 PERFORM app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
 IF p_enabled IS NULL OR (p_enabled AND c.status <> 'CONNECTED') THEN RAISE EXCEPTION 'bank_email_not_connected' USING ERRCODE='22023'; END IF;
 UPDATE public.bank_email_connections SET enabled=p_enabled,
 auto_enabled_at=CASE WHEN p_enabled AND NOT enabled THEN clock_timestamp() ELSE auto_enabled_at END WHERE id=c.id RETURNING * INTO c;
 RETURN app_private.bank_email_connection_json_v1(c);
END $fn$;
CREATE OR REPLACE FUNCTION public.bank_email_disconnect_v1(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.bank_email_connections;
BEGIN
 SELECT * INTO c FROM public.bank_email_connections WHERE id=p_connection_id FOR UPDATE;
 -- Owner may always revoke their own OAuth grant, even after permission removal.
 IF auth.uid() IS NULL OR c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'bank_email_not_permitted' USING ERRCODE='42501'; END IF;
 UPDATE public.bank_email_connections SET enabled=false,status='DISCONNECTED' WHERE id=c.id RETURNING * INTO c;
 DELETE FROM app_private.bank_email_oauth_states WHERE connection_id=c.id;
 INSERT INTO app_private.bank_email_jobs(connection_id) VALUES(c.id) ON CONFLICT(connection_id) DO UPDATE
 SET generation=bank_email_jobs.generation+1,due_at=clock_timestamp(),lease_token=NULL,leased_until=NULL;
 RETURN app_private.bank_email_connection_json_v1(c);
END $fn$;
CREATE OR REPLACE FUNCTION public.bank_email_my_connections_v1()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE rows jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'bank_email_not_permitted' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'email',email,'status',status,'organizationId',organization_id) ORDER BY created_at),'[]')
 INTO rows FROM public.bank_email_connections WHERE owner_id=auth.uid();
 RETURN jsonb_build_object('connections',rows);
END $fn$;
CREATE OR REPLACE FUNCTION public.bank_email_oauth_begin_v1(p_connection_id uuid,p_state_hash text,p_verifier_encrypted text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.bank_email_connections;
BEGIN
 SELECT * INTO c FROM public.bank_email_connections WHERE id=p_connection_id FOR UPDATE;
 PERFORM app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
 IF EXISTS(SELECT 1 FROM app_private.bank_email_credentials WHERE connection_id=c.id) THEN RAISE EXCEPTION 'bank_email_disconnect_required' USING ERRCODE='55000'; END IF;
 DELETE FROM app_private.bank_email_oauth_states WHERE connection_id=c.id OR expires_at<clock_timestamp();
 INSERT INTO app_private.bank_email_oauth_states(state_hash,connection_id,encrypted_verifier,expires_at)
 VALUES(p_state_hash,c.id,p_verifier_encrypted,clock_timestamp()+interval '10 minutes');
 UPDATE public.bank_email_connections SET status='AUTHORIZING',enabled=false,last_error=NULL WHERE id=c.id;
 RETURN jsonb_build_object('id',c.id,'status','AUTHORIZING');
END $fn$;
CREATE OR REPLACE FUNCTION public.bank_email_list_v1(p_organization_id uuid,p_before timestamptz DEFAULT NULL,p_limit integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE cs jsonb; ts jsonb; more boolean; c public.bank_email_connections; lim integer:=least(greatest(coalesce(p_limit,30),1),100);
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.organization_memberships WHERE user_id=auth.uid() AND organization_id=p_organization_id AND status='ACTIVE')
 OR NOT coalesce((SELECT org_wide FROM app_private.authorized_scope_v3('auto_debt.edit',p_organization_id)),false) THEN
 RAISE EXCEPTION 'bank_email_not_permitted' USING ERRCODE='42501'; END IF;
 FOR c IN SELECT * FROM public.bank_email_connections WHERE organization_id=p_organization_id AND owner_id=auth.uid() LOOP
 PERFORM app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id); END LOOP;
 SELECT coalesce(jsonb_agg(app_private.bank_email_connection_json_v1(x) ORDER BY x.created_at),'[]') INTO cs FROM public.bank_email_connections x WHERE organization_id=p_organization_id AND owner_id=auth.uid();
 SELECT coalesce(jsonb_agg(app_private.bank_email_transaction_json_v1(x) ORDER BY x.created_at DESC),'[]') INTO ts FROM
 (SELECT t.* FROM public.bank_email_transactions t JOIN public.bank_email_connections con ON con.id=t.connection_id
 WHERE t.organization_id=p_organization_id AND con.owner_id=auth.uid() AND public.bank_email_transaction_access_v1(t.id) AND (p_before IS NULL OR t.created_at<p_before) ORDER BY t.created_at DESC LIMIT lim) x;
 SELECT count(*)>lim INTO more FROM (SELECT 1 FROM public.bank_email_transactions t JOIN public.bank_email_connections con ON con.id=t.connection_id
 WHERE t.organization_id=p_organization_id AND con.owner_id=auth.uid() AND public.bank_email_transaction_access_v1(t.id) AND (p_before IS NULL OR t.created_at<p_before) LIMIT lim+1) x;
 RETURN jsonb_build_object('connections',cs,'transactions',ts,'hasMore',more);
END $fn$;

-- Called only under authenticated owner claims; source lock + invoice lock held through V5.
CREATE OR REPLACE FUNCTION public.bank_email_transaction_v1(p_transaction_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE t public.bank_email_transactions;
BEGIN
 IF public.bank_email_transaction_access_v1(p_transaction_id) IS NOT TRUE THEN RAISE EXCEPTION 'bank_email_not_permitted' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM public.bank_email_transactions WHERE id=p_transaction_id;
 RETURN app_private.bank_email_transaction_json_v1(t);
END $fn$;
DROP FUNCTION IF EXISTS public.bank_email_review_v1(uuid,text,boolean);
DROP FUNCTION IF EXISTS app_private.bank_email_post_v1(uuid,text);
CREATE OR REPLACE FUNCTION app_private.bank_email_post_v1(p_transaction uuid,p_invoice_number text DEFAULT NULL,p_expected_invoice_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.bank_email_connections; t public.bank_email_transactions; i public.invoices; m uuid; ids uuid[]; r jsonb; why text;
BEGIN
 SELECT * INTO t FROM public.bank_email_transactions WHERE id=p_transaction FOR UPDATE;
 SELECT * INTO c FROM public.bank_email_connections WHERE id=t.connection_id FOR UPDATE;
 m:=app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
 IF c.status<>'CONNECTED' THEN RAISE EXCEPTION 'bank_email_not_connected' USING ERRCODE='42501'; END IF;
 IF t.invoice_id IS NOT NULL THEN
  SELECT * INTO i FROM public.invoices WHERE id=t.invoice_id;
  IF public.can_access_building(i.building_id) IS NOT TRUE
   OR NOT coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(c.owner_id,c.organization_id,'thu_tien.collect',i.building_id,NULL)),false)
   OR app_private.receiving_cashbook_allowed_v1(c.organization_id,i.building_id,'TK',m,c.account_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'bank_email_not_permitted' USING ERRCODE='42501'; END IF;
 END IF;
 IF t.status IN('POSTED','IGNORED') THEN RETURN app_private.bank_email_receipt_v1(t); END IF;
 PERFORM 1 FROM app_private.bank_email_sources WHERE transaction_id=t.id FOR UPDATE;
 IF NOT FOUND OR NOT t.verified OR t.reason='PARSE_ERROR' OR t.account IS DISTINCT FROM c.bank_account OR t.currency IS DISTINCT FROM 'VND'
 OR t.direction IS DISTINCT FROM 'CREDIT' OR t.amount IS NULL OR t.amount<=0 OR t.amount>1e15 OR t.amount<>trunc(t.amount)
 OR t.occurred_at IS NULL OR t.occurred_at>clock_timestamp()+interval '5 minutes' OR t.internal_date>clock_timestamp()+interval '5 minutes' THEN why:='UNSAFE_TRANSACTION';
 ELSIF p_invoice_number IS NULL AND (NOT c.enabled OR c.auto_enabled_at IS NULL OR t.occurred_at<c.auto_enabled_at OR t.internal_date<c.auto_enabled_at) THEN why:='AUTO_DISABLED_OR_OLD';
 ELSE
  SELECT array_agg(inv.id) INTO ids FROM public.invoices inv WHERE inv.organization_id=c.organization_id AND inv.deleted_at IS NULL
   AND CASE WHEN p_invoice_number IS NOT NULL THEN inv.invoice_number=p_invoice_number ELSE
    strpos(' '||regexp_replace(upper(coalesce(t.description,'')),'[^[:alnum:]_-]+',' ','g')||' ',' '||upper(inv.invoice_number)||' ')>0 END;
  IF coalesce(cardinality(ids),0)<>1 THEN why:='INVOICE_NOT_UNIQUE';
  ELSE
   SELECT * INTO i FROM public.invoices WHERE id=ids[1] FOR UPDATE;
   IF p_invoice_number IS NOT NULL AND i.id IS DISTINCT FROM p_expected_invoice_id THEN RAISE EXCEPTION 'bank_email_selection_changed' USING ERRCODE='PT409'; END IF;
   IF public.can_access_building(i.building_id) IS NOT TRUE
    OR NOT coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(c.owner_id,c.organization_id,'thu_tien.collect',i.building_id,NULL)),false)
    OR app_private.receiving_cashbook_allowed_v1(c.organization_id,i.building_id,'TK',m,c.account_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'bank_email_not_permitted' USING ERRCODE='42501'; END IF;
   IF i.total_amount-coalesce(i.paid_amount,0) IS DISTINCT FROM t.amount OR i.total_amount-coalesce(i.paid_amount,0)<=0 THEN why:='AMOUNT_MISMATCH';
   ELSE
    r:=public.record_invoice_collection_v5(i.id,(t.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
      jsonb_build_array(jsonb_build_object('payment_method','TK','gross_amount',t.amount,'account_id',c.account_id)),
      'REJECT',false,'ACB email '||t.bank_reference,NULL,coalesce(i.paid_amount,0),'acb-email:'||t.id::text);
    IF r->>'collection_id' IS NULL OR r->>'invoice_id' IS DISTINCT FROM i.id::text
     OR (r->>'gross_amount')::numeric IS DISTINCT FROM t.amount OR (r->>'applied_amount')::numeric IS DISTINCT FROM t.amount
     OR (r->>'change_amount')::numeric IS DISTINCT FROM 0 OR (r->>'credit_amount')::numeric IS DISTINCT FROM 0 OR (r->>'rounding_amount')::numeric IS DISTINCT FROM 0 THEN
     RAISE EXCEPTION 'bank_email_invalid_canonical_receipt' USING ERRCODE='22023'; END IF;
    UPDATE public.bank_email_transactions SET status='POSTED',reason=NULL,invoice_id=i.id,receipt=r WHERE id=t.id RETURNING * INTO t;
    UPDATE public.notifications SET subject='ACB: đã ghi thu hóa đơn',content='Khoản chuyển khoản đã được đối soát và ghi thu.'
     WHERE organization_id=c.organization_id AND user_id=c.owner_id AND metadata->>'bankEmailTransactionId'=t.id::text;
    RETURN app_private.bank_email_receipt_v1(t);
   END IF;
  END IF;
 END IF;
 UPDATE public.bank_email_transactions SET reason=why WHERE id=t.id RETURNING * INTO t;
 RETURN app_private.bank_email_receipt_v1(t);
END $fn$;
CREATE OR REPLACE FUNCTION app_private.bank_email_try_post_v1(p_transaction uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE t public.bank_email_transactions; c public.bank_email_connections;
BEGIN
 SELECT * INTO t FROM public.bank_email_transactions WHERE id=p_transaction;
 SELECT * INTO c FROM public.bank_email_connections WHERE id=t.connection_id;
 -- Authority denial is never converted into an apparently successful replay.
 PERFORM app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
 IF t.status IN('POSTED','IGNORED') THEN RETURN app_private.bank_email_post_v1(t.id); END IF;
 BEGIN
  RETURN app_private.bank_email_post_v1(t.id);
 EXCEPTION WHEN insufficient_privilege THEN
  UPDATE public.bank_email_transactions SET reason='PERMISSION_REQUIRED' WHERE id=t.id RETURNING * INTO t;
 WHEN SQLSTATE '55000' OR SQLSTATE '22023' OR SQLSTATE 'P0001' THEN
  UPDATE public.bank_email_transactions SET reason='WRITER_REJECTED' WHERE id=t.id RETURNING * INTO t;
 END;
 RETURN app_private.bank_email_receipt_v1(t);
END $fn$;
CREATE OR REPLACE FUNCTION public.bank_email_review_v1(p_transaction_id uuid,p_invoice_number text,p_ignore boolean DEFAULT false,p_expected_invoice_id uuid DEFAULT NULL,p_expected_amount numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.bank_email_connections; t public.bank_email_transactions;
BEGIN
 SELECT c0.* INTO c FROM public.bank_email_connections c0 JOIN public.bank_email_transactions t0 ON t0.connection_id=c0.id WHERE t0.id=p_transaction_id FOR UPDATE OF c0;
 PERFORM app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
 SELECT * INTO t FROM public.bank_email_transactions WHERE id=p_transaction_id FOR UPDATE;
 IF NOT coalesce(p_ignore,false) THEN
  IF p_expected_invoice_id IS NULL OR p_expected_amount IS NULL OR p_expected_amount<=0 OR p_expected_amount>1e15 THEN RAISE EXCEPTION 'bank_email_expected_selection_required' USING ERRCODE='22023'; END IF;
  IF t.amount IS DISTINCT FROM p_expected_amount OR (t.invoice_id IS NOT NULL AND t.invoice_id<>p_expected_invoice_id) THEN RAISE EXCEPTION 'bank_email_selection_changed' USING ERRCODE='PT409'; END IF;
 END IF;
 IF t.status='POSTED' THEN RETURN app_private.bank_email_post_v1(t.id); END IF;
 IF coalesce(p_ignore,false) THEN
  IF t.status='PENDING' THEN UPDATE public.bank_email_transactions SET status='IGNORED',reason='USER_IGNORED' WHERE id=t.id RETURNING * INTO t; END IF;
  RETURN app_private.bank_email_receipt_v1(t);
 END IF;
 IF p_invoice_number IS NULL OR length(btrim(p_invoice_number)) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'bank_email_invoice_required' USING ERRCODE='22023'; END IF;
 RETURN app_private.bank_email_post_v1(t.id,btrim(p_invoice_number),p_expected_invoice_id);
END $fn$;

CREATE OR REPLACE FUNCTION public.bank_email_worker_v1(p_operation text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.bank_email_connections; t public.bank_email_transactions; s app_private.bank_email_oauth_states; j app_private.bank_email_jobs;
 v app_private.bank_email_credentials; r jsonb; jobs jsonb:='[]'; parsed jsonb; src uuid; stamp timestamptz; n integer;
 old_claims text:=current_setting('request.jwt.claims',true); old_sub text:=current_setting('request.jwt.claim.sub',true); old_role text:=current_setting('request.jwt.claim.role',true);
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' THEN RAISE EXCEPTION 'bank_email_worker_only' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR pg_column_size(p_payload)>32768 OR p_payload ?| ARRAY['actor','actorId','ownerId','organizationId'] THEN
 RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
 IF p_operation='oauth_consume' THEN
  UPDATE app_private.bank_email_oauth_states SET consumed_at=clock_timestamp()
  WHERE state_hash=p_payload->>'stateHash' AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING * INTO s;
  IF NOT FOUND THEN RAISE EXCEPTION 'bank_email_invalid_state' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('connectionId',s.connection_id,'encryptedVerifier',s.encrypted_verifier);
 ELSIF p_operation='oauth_complete' THEN
  SELECT * INTO s FROM app_private.bank_email_oauth_states WHERE state_hash=p_payload->>'stateHash';
  SELECT * INTO c FROM public.bank_email_connections WHERE id=s.connection_id FOR UPDATE;
  SELECT * INTO s FROM app_private.bank_email_oauth_states WHERE state_hash=p_payload->>'stateHash' FOR UPDATE;
  IF s.consumed_at IS NULL OR s.completed_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR c.status IS DISTINCT FROM 'AUTHORIZING' THEN
  RAISE EXCEPTION 'bank_email_invalid_state' USING ERRCODE='42501'; END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',c.owner_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',c.owner_id::text,true); PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
  IF coalesce(p_payload->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' OR length(p_payload->>'email')>254
   OR coalesce(p_payload->>'historyId','') !~ '^[0-9]{1,40}$' OR p_payload->>'watchExpiresAt' IS NULL OR NOT isfinite((p_payload->>'watchExpiresAt')::timestamptz)
   OR (p_payload->>'watchExpiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
  INSERT INTO app_private.bank_email_credentials(connection_id,email,encrypted_refresh_token,history_id,watch_expires_at)
  VALUES(c.id,lower(p_payload->>'email'),p_payload->>'encryptedRefreshToken',NULL,(p_payload->>'watchExpiresAt')::timestamptz);
  UPDATE app_private.bank_email_oauth_states SET completed_at=clock_timestamp(),encrypted_verifier='consumed' WHERE state_hash=s.state_hash;
  UPDATE public.bank_email_connections SET status='CONNECTED',email=lower(p_payload->>'email'),enabled=false,last_error=NULL WHERE id=c.id;
  INSERT INTO app_private.bank_email_jobs(connection_id) VALUES(c.id) ON CONFLICT(connection_id) DO UPDATE SET due_at=clock_timestamp(),generation=bank_email_jobs.generation+1;
  r:=jsonb_build_object('id',c.id,'status','CONNECTED');
 ELSIF p_operation='enqueue' THEN
  INSERT INTO app_private.bank_email_jobs(connection_id) SELECT id FROM public.bank_email_connections WHERE status='CONNECTED' AND email=lower(p_payload->>'email')
  ON CONFLICT(connection_id) DO UPDATE SET generation=bank_email_jobs.generation+1,due_at=clock_timestamp();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN jsonb_build_object('queued',n);
 ELSIF p_operation='claim' THEN
  -- Same lock order as every mutating user/worker operation: connection, then job.
  FOR c IN SELECT con.* FROM app_private.bank_email_jobs job JOIN public.bank_email_connections con ON con.id=job.connection_id
   WHERE job.due_at<=clock_timestamp() AND (job.leased_until IS NULL OR job.leased_until<clock_timestamp())
    AND con.status IN('CONNECTED','DISCONNECTED') ORDER BY job.due_at LIMIT 10 FOR UPDATE OF con SKIP LOCKED LOOP
   SELECT * INTO j FROM app_private.bank_email_jobs WHERE connection_id=c.id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND OR j.due_at>clock_timestamp() OR j.leased_until>=clock_timestamp() THEN CONTINUE; END IF;
   IF c.status='CONNECTED' THEN
    BEGIN
     PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',c.owner_id,'role','authenticated')::text,true);
     PERFORM set_config('request.jwt.claim.sub',c.owner_id::text,true); PERFORM set_config('request.jwt.claim.role','authenticated',true);
     PERFORM app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
    EXCEPTION WHEN insufficient_privilege THEN
     PERFORM set_config('request.jwt.claims',coalesce(old_claims,''),true); PERFORM set_config('request.jwt.claim.sub',coalesce(old_sub,''),true); PERFORM set_config('request.jwt.claim.role',coalesce(old_role,''),true);
     UPDATE public.bank_email_connections SET enabled=false,status='RECONNECT_REQUIRED',last_error='PERMISSION_REVOKED' WHERE id=c.id;
     UPDATE app_private.bank_email_jobs SET lease_token=NULL,leased_until=NULL WHERE connection_id=c.id;
     CONTINUE;
    END;
    PERFORM set_config('request.jwt.claims',coalesce(old_claims,''),true); PERFORM set_config('request.jwt.claim.sub',coalesce(old_sub,''),true); PERFORM set_config('request.jwt.claim.role',coalesce(old_role,''),true);
   END IF;
   UPDATE app_private.bank_email_jobs SET lease_token=gen_random_uuid(),leased_until=clock_timestamp()+interval '120 seconds',claimed_generation=generation
   WHERE connection_id=j.connection_id RETURNING * INTO j;
   SELECT * INTO v FROM app_private.bank_email_credentials WHERE connection_id=c.id;
   IF v.connection_id IS NULL THEN DELETE FROM app_private.bank_email_jobs WHERE connection_id=c.id; CONTINUE; END IF;
   jobs:=jobs||jsonb_build_array(jsonb_build_object('connectionId',c.id,'leaseToken',j.lease_token,'encryptedRefreshToken',v.encrypted_refresh_token,
   'email',v.email,'historyId',v.history_id::text,'watchExpiresAt',v.watch_expires_at,'scanPageToken',v.scan_page_token,'scanHistoryId',v.scan_history_id::text,
   'historyPageToken',v.history_page_token,'historyStartId',v.history_start_id::text,
   'disconnect',c.status='DISCONNECTED'));
  END LOOP;
  RETURN jsonb_build_object('jobs',jobs);
 ELSIF p_operation IN('checkpoint','watch_metadata','scan_checkpoint','history_checkpoint','page_progress','page_pending','ingest','finish','fail') THEN
  SELECT * INTO c FROM public.bank_email_connections WHERE id=(p_payload->>'connectionId')::uuid FOR UPDATE;
  SELECT * INTO j FROM app_private.bank_email_jobs WHERE connection_id=c.id FOR UPDATE;
  IF j.lease_token IS NULL OR j.lease_token IS DISTINCT FROM (p_payload->>'leaseToken')::uuid OR j.leased_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'bank_email_lease_lost' USING ERRCODE='40001'; END IF;
  IF p_operation='finish' THEN
   IF c.status='DISCONNECTED' THEN DELETE FROM app_private.bank_email_credentials WHERE connection_id=c.id; DELETE FROM app_private.bank_email_jobs WHERE connection_id=c.id;
   ELSE UPDATE app_private.bank_email_jobs SET lease_token=NULL,leased_until=NULL,due_at=CASE WHEN generation>claimed_generation OR EXISTS(SELECT 1 FROM app_private.bank_email_credentials WHERE connection_id=c.id AND (scan_history_id IS NOT NULL OR history_start_id IS NOT NULL)) THEN clock_timestamp() ELSE clock_timestamp()+interval '5 minutes' END WHERE connection_id=c.id;
    UPDATE public.bank_email_connections SET last_synced_at=clock_timestamp(),last_error=NULL WHERE id=c.id;
   END IF; RETURN jsonb_build_object('ok',true);
  ELSIF p_operation='fail' THEN
   IF coalesce(p_payload->>'errorCode','') !~ '^[A-Z0-9_]{1,80}$' OR jsonb_typeof(p_payload->'reconnect') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
   UPDATE public.bank_email_connections SET last_error=p_payload->>'errorCode',
    status=CASE WHEN (p_payload->>'reconnect')::boolean AND status<>'DISCONNECTED' THEN 'RECONNECT_REQUIRED' ELSE status END,
    enabled=CASE WHEN (p_payload->>'reconnect')::boolean THEN false ELSE enabled END WHERE id=c.id;
   UPDATE app_private.bank_email_jobs SET lease_token=NULL,leased_until=NULL,due_at=clock_timestamp()+interval '1 minute' WHERE connection_id=c.id;
   RETURN jsonb_build_object('ok',true);
  END IF;
  IF c.status<>'CONNECTED' THEN RAISE EXCEPTION 'bank_email_not_connected' USING ERRCODE='42501'; END IF;
  IF p_operation IN('page_progress','page_pending') THEN
   IF coalesce(p_payload->>'mode','') NOT IN('scan','history')
    OR length(coalesce(p_payload->>'pageToken',''))>4096 THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
   SELECT * INTO v FROM app_private.bank_email_credentials WHERE connection_id=c.id;
   IF (p_payload->>'mode'='scan' AND (v.scan_history_id IS NULL OR v.scan_page_token IS DISTINCT FROM p_payload->>'pageToken'))
    OR (p_payload->>'mode'='history' AND (v.history_start_id IS NULL OR v.scan_history_id IS NOT NULL OR v.history_page_token IS DISTINCT FROM p_payload->>'pageToken')) THEN
    RAISE EXCEPTION 'bank_email_page_conflict' USING ERRCODE='40001'; END IF;
   IF p_operation='page_pending' THEN
    IF jsonb_typeof(p_payload->'messageIds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(p_payload->'messageIds')>500 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'messageIds') item
      WHERE jsonb_typeof(item)<>'string' OR item#>>'{}' !~ '^[A-Za-z0-9_-]{1,128}$') THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
    SELECT coalesce(jsonb_agg(item.value ORDER BY item.ord),'[]') INTO r FROM jsonb_array_elements(p_payload->'messageIds') WITH ORDINALITY item(value,ord)
     WHERE NOT EXISTS(SELECT 1 FROM app_private.bank_email_page_messages done WHERE done.connection_id=c.id AND done.message_id=item.value#>>'{}');
    RETURN jsonb_build_object('pendingMessageIds',r);
   END IF;
   IF coalesce(p_payload->>'messageId','') !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
   INSERT INTO app_private.bank_email_page_messages(connection_id,message_id) VALUES(c.id,p_payload->>'messageId') ON CONFLICT DO NOTHING;
   RETURN jsonb_build_object('ok',true);
  END IF;
  IF p_operation='watch_metadata' THEN
   IF p_payload->>'watchExpiresAt' IS NULL OR NOT isfinite((p_payload->>'watchExpiresAt')::timestamptz) OR (p_payload->>'watchExpiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
   UPDATE app_private.bank_email_credentials SET watch_expires_at=(p_payload->>'watchExpiresAt')::timestamptz WHERE connection_id=c.id;
   RETURN jsonb_build_object('ok',true);
  END IF;
  IF p_operation='scan_checkpoint' THEN
   IF coalesce(p_payload->>'scanHistoryId','') !~ '^[0-9]{1,40}$' OR jsonb_typeof(p_payload->'complete') IS DISTINCT FROM 'boolean'
    OR length(coalesce(p_payload->>'pageToken',''))>4096 THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
   SELECT * INTO v FROM app_private.bank_email_credentials WHERE connection_id=c.id;
   IF v.scan_history_id IS NOT NULL AND v.scan_history_id<>(p_payload->>'scanHistoryId')::numeric THEN RAISE EXCEPTION 'bank_email_scan_conflict' USING ERRCODE='40001'; END IF;
   IF (p_payload->>'complete')::boolean THEN
    IF v.scan_history_id IS NULL THEN RAISE EXCEPTION 'bank_email_scan_not_started' USING ERRCODE='22023'; END IF;
    DELETE FROM app_private.bank_email_page_messages WHERE connection_id=c.id;
    UPDATE app_private.bank_email_credentials SET history_id=greatest(history_id,scan_history_id),scan_history_id=NULL,scan_page_token=NULL WHERE connection_id=c.id;
   ELSE
    IF v.scan_history_id IS NULL OR v.scan_page_token IS DISTINCT FROM p_payload->>'pageToken' THEN DELETE FROM app_private.bank_email_page_messages WHERE connection_id=c.id; END IF;
    UPDATE app_private.bank_email_credentials SET
    scan_history_id=(p_payload->>'scanHistoryId')::numeric,scan_page_token=p_payload->>'pageToken',history_start_id=NULL,history_page_token=NULL WHERE connection_id=c.id;
   END IF;
   RETURN jsonb_build_object('ok',true);
  END IF;
  IF p_operation='history_checkpoint' THEN
   IF coalesce(p_payload->>'startHistoryId','') !~ '^[0-9]{1,40}$' OR jsonb_typeof(p_payload->'complete') IS DISTINCT FROM 'boolean'
    OR length(coalesce(p_payload->>'pageToken',''))>4096 THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
   SELECT * INTO v FROM app_private.bank_email_credentials WHERE connection_id=c.id;
   IF v.scan_history_id IS NOT NULL OR (v.history_start_id IS NOT NULL AND v.history_start_id<>(p_payload->>'startHistoryId')::numeric)
    OR (v.history_start_id IS NULL AND v.history_id IS DISTINCT FROM (p_payload->>'startHistoryId')::numeric) THEN RAISE EXCEPTION 'bank_email_history_conflict' USING ERRCODE='40001'; END IF;
   IF (p_payload->>'complete')::boolean THEN
    IF coalesce(p_payload->>'finalHistoryId','') !~ '^[0-9]{1,40}$' OR (p_payload->>'finalHistoryId')::numeric<(p_payload->>'startHistoryId')::numeric THEN RAISE EXCEPTION 'bank_email_invalid_history' USING ERRCODE='22023'; END IF;
    DELETE FROM app_private.bank_email_page_messages WHERE connection_id=c.id;
    UPDATE app_private.bank_email_credentials SET history_id=greatest(history_id,(p_payload->>'finalHistoryId')::numeric),history_start_id=NULL,history_page_token=NULL WHERE connection_id=c.id;
   ELSE
    IF v.history_start_id IS NULL OR v.history_page_token IS DISTINCT FROM p_payload->>'pageToken' THEN DELETE FROM app_private.bank_email_page_messages WHERE connection_id=c.id; END IF;
    UPDATE app_private.bank_email_credentials SET
    history_start_id=(p_payload->>'startHistoryId')::numeric,history_page_token=p_payload->>'pageToken' WHERE connection_id=c.id;
   END IF;
   RETURN jsonb_build_object('ok',true);
  END IF;
  IF p_operation='checkpoint' THEN
   IF coalesce(p_payload->>'historyId','') !~ '^[0-9]{1,40}$' THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
   UPDATE app_private.bank_email_credentials SET history_id=greatest(history_id,(p_payload->>'historyId')::numeric),
    watch_expires_at=coalesce((p_payload->>'watchExpiresAt')::timestamptz,watch_expires_at) WHERE connection_id=c.id;
   RETURN jsonb_build_object('ok',true);
  END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',c.owner_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',c.owner_id::text,true); PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM app_private.bank_email_assert_actor_v1(c.organization_id,c.owner_id,c.account_id);
  SELECT * INTO t FROM public.bank_email_transactions WHERE connection_id=c.id AND message_id=p_payload->>'messageId';
  IF FOUND THEN r:=app_private.bank_email_try_post_v1(t.id);
  ELSE
   IF coalesce(p_payload->>'messageId','') !~ '^[A-Za-z0-9_-]{1,128}$' OR jsonb_typeof(p_payload->'verified') IS DISTINCT FROM 'boolean'
    OR p_payload->>'internalDate' IS NULL OR NOT isfinite((p_payload->>'internalDate')::timestamptz) THEN RAISE EXCEPTION 'bank_email_invalid_payload' USING ERRCODE='22023'; END IF;
   parsed:=p_payload->'parsed';
   IF parsed IS NOT NULL AND parsed<>'null'::jsonb THEN
    IF jsonb_typeof(parsed)<>'object' OR coalesce(parsed->>'account','') !~ '^[0-9]{6,30}$'
     OR jsonb_typeof(parsed->'amount') IS DISTINCT FROM 'number' OR (parsed->>'amount')::numeric NOT BETWEEN 1 AND 1e15 OR (parsed->>'amount')::numeric<>trunc((parsed->>'amount')::numeric)
     OR jsonb_typeof(parsed->'balance') IS DISTINCT FROM 'number' OR (parsed->>'balance')::numeric NOT BETWEEN 0 AND 1e15 OR (parsed->>'balance')::numeric<>trunc((parsed->>'balance')::numeric)
     OR length(coalesce(parsed->>'currency','')) NOT BETWEEN 1 AND 8 OR length(coalesce(parsed->>'direction','')) NOT BETWEEN 1 AND 16
     OR length(coalesce(parsed->>'bankReference','')) NOT BETWEEN 1 AND 128 OR length(coalesce(parsed->>'description',''))>4000
     OR parsed->>'occurredAt' IS NULL OR NOT isfinite((parsed->>'occurredAt')::timestamptz) THEN RAISE EXCEPTION 'bank_email_invalid_parsed' USING ERRCODE='22023'; END IF;
   END IF;
   -- Global cursor serialization prevents equal timestamp rows across connections.
   PERFORM pg_advisory_xact_lock(741512,1);
   SELECT greatest(clock_timestamp(),coalesce(max(created_at)+interval '1 microsecond',clock_timestamp())) INTO stamp FROM public.bank_email_transactions;
   INSERT INTO public.bank_email_transactions(organization_id,connection_id,message_id,internal_date,verified,account,amount,balance,currency,direction,occurred_at,bank_reference,description,reason,created_at)
   VALUES(c.organization_id,c.id,p_payload->>'messageId',(p_payload->>'internalDate')::timestamptz,(p_payload->>'verified')::boolean,
    parsed->>'account',(parsed->>'amount')::numeric,(parsed->>'balance')::numeric,parsed->>'currency',parsed->>'direction',(parsed->>'occurredAt')::timestamptz,
    parsed->>'bankReference',parsed->>'description',CASE WHEN p_payload->>'parseError' IS NOT NULL OR parsed IS NULL OR parsed='null'::jsonb THEN 'PARSE_ERROR' END,stamp) RETURNING * INTO t;
   -- Unverified/ambiguous mail must never reserve another genuine transfer's source reference.
   IF t.verified AND t.reason IS NULL AND t.account=c.bank_account AND t.currency='VND' AND t.direction='CREDIT' THEN
    INSERT INTO app_private.bank_email_sources(bank_account,bank_reference,transaction_id) VALUES(c.bank_account,t.bank_reference,t.id) ON CONFLICT(bank_account,bank_reference) DO NOTHING;
    SELECT transaction_id INTO src FROM app_private.bank_email_sources WHERE bank_account=c.bank_account AND bank_reference=t.bank_reference FOR UPDATE;
    IF src<>t.id THEN
     DELETE FROM public.bank_email_transactions WHERE id=t.id;
     SELECT * INTO t FROM public.bank_email_transactions WHERE id=src;
     r:=app_private.bank_email_try_post_v1(t.id);
    END IF;
   END IF;
   IF r IS NULL THEN
    r:=app_private.bank_email_try_post_v1(t.id);
    INSERT INTO public.notifications(user_id,type,channel,subject,content,organization_id,metadata,status)
    VALUES(c.owner_id,'CUSTOM','IN_APP',CASE WHEN r->>'status'='POSTED' THEN 'ACB: đã ghi thu hóa đơn' ELSE 'ACB: thư chờ kiểm tra' END,
     CASE WHEN r->>'status'='POSTED' THEN 'Khoản chuyển khoản đã được đối soát và ghi thu.' ELSE 'Có thư ngân hàng cần kiểm tra; chưa ghi thu hóa đơn.' END,
     c.organization_id,jsonb_build_object('url','/settings/categories/auto-debt','bankEmailTransactionId',t.id),'PENDING');
   END IF;
  END IF;
 ELSE RAISE EXCEPTION 'bank_email_unknown_operation' USING ERRCODE='22023';
 END IF;
 PERFORM set_config('request.jwt.claims',coalesce(old_claims,''),true); PERFORM set_config('request.jwt.claim.sub',coalesce(old_sub,''),true); PERFORM set_config('request.jwt.claim.role',coalesce(old_role,''),true);
 RETURN r;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('request.jwt.claims',coalesce(old_claims,''),true); PERFORM set_config('request.jwt.claim.sub',coalesce(old_sub,''),true); PERFORM set_config('request.jwt.claim.role',coalesce(old_role,''),true);
 RAISE;
END $fn$;

REVOKE ALL ON FUNCTION app_private.bank_email_assert_actor_v1(uuid,uuid,uuid),app_private.bank_email_connection_json_v1(public.bank_email_connections),
 app_private.bank_email_receipt_v1(public.bank_email_transactions),app_private.bank_email_transaction_json_v1(public.bank_email_transactions),app_private.bank_email_post_v1(uuid,text,uuid),app_private.bank_email_try_post_v1(uuid)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.bank_email_access_v1(uuid),public.bank_email_transaction_access_v1(uuid),public.bank_email_setup_v1(uuid,text,uuid),public.bank_email_set_enabled_v1(uuid,boolean),
 public.bank_email_disconnect_v1(uuid),public.bank_email_my_connections_v1(),public.bank_email_transaction_v1(uuid),public.bank_email_oauth_begin_v1(uuid,text,text),public.bank_email_list_v1(uuid,timestamptz,integer),public.bank_email_review_v1(uuid,text,boolean,uuid,numeric)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bank_email_access_v1(uuid),public.bank_email_transaction_access_v1(uuid),public.bank_email_setup_v1(uuid,text,uuid),public.bank_email_set_enabled_v1(uuid,boolean),
 public.bank_email_disconnect_v1(uuid),public.bank_email_my_connections_v1(),public.bank_email_transaction_v1(uuid),public.bank_email_oauth_begin_v1(uuid,text,text),public.bank_email_list_v1(uuid,timestamptz,integer),public.bank_email_review_v1(uuid,text,boolean,uuid,numeric) TO authenticated;
REVOKE ALL ON FUNCTION public.bank_email_worker_v1(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bank_email_worker_v1(text,jsonb) TO service_role;
DO $publication$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
  IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='bank_email_connections') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.bank_email_connections; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='bank_email_transactions') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.bank_email_transactions; END IF;
 END IF;
END $publication$;
