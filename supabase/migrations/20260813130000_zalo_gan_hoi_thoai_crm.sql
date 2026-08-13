-- =============================================================================
-- Chat Zalo — GẮN HỘI THOẠI VÀO HỒ SƠ CRM theo số điện thoại.
--
-- Cột FK customer_id/lead_id/contract_id/room_id trên zalo_conversations có từ
-- 20260626000001 nhưng CHƯA từng có code nào ghi (kind luôn 'unknown', panel
-- Khách trọ/Lead trên FE vì thế không bao giờ khớp). File này cấp phần ghi:
--
--   • Matcher SQL zalo_match_conversation_crm(conv): match peer_phone (chuẩn
--     hoá qua phone_digits) với — theo thứ tự ưu tiên — (1) tenants có hợp
--     đồng ACTIVE (kèm contract_id/room_id), (2) customers, (3) leads.
--     CHỈ match TRONG CÙNG organization_id — SĐT trùng giữa hai công ty không
--     bao giờ gắn chéo.
--   • Trigger tự match khi hội thoại mới xuất hiện / peer_phone đổi, CHỈ khi
--     chưa có link (không ghi đè link gắn tay).
--   • RPC backfill (worker gọi sau khi sync danh bạ; người chạy tay được).
--   • RPC gắn/tháo tay + RPC đọc tóm tắt CRM cho InfoPanel (1 roundtrip).
--
-- Vì sao trigger + backfill, KHÔNG job định kỳ: mỗi lần match là 1 lookup theo
-- index biểu thức — rẻ; trigger phủ dòng mới theo thời gian thực, backfill phủ
-- dòng cũ; một job định kỳ chỉ thêm một chỗ để quên.
-- Idempotent. Chạy SAU 20260813120000 (cần phone_digits).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Index biểu thức cho match trong-org
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS customers_org_phone_digits_idx
  ON public.customers(organization_id, public.phone_digits(phone))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tenants_org_phone_digits_idx
  ON public.tenants(organization_id, public.phone_digits(phone))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_org_phone_digits_idx
  ON public.leads(organization_id, public.phone_digits(phone))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS zalo_conversations_peer_phone_digits_idx
  ON public.zalo_conversations(account_id, public.phone_digits(peer_phone))
  WHERE peer_phone IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Matcher lõi — mọi đường (trigger, backfill) đi qua đúng MỘT hàm này
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_match_conversation_crm(p_conversation_id uuid)
RETURNS text  -- 'tenant' | 'lead' | 'none'
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c          public.zalo_conversations;
  v_digits   text;
  v_customer uuid;
  v_lead     uuid;
  v_contract uuid;
  v_room     uuid;
  v_tenant   uuid;
BEGIN
  SELECT * INTO c FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  -- không ghi đè link đã có (kể cả gắn tay)
  IF c.customer_id IS NOT NULL OR c.lead_id IS NOT NULL THEN RETURN 'none'; END IF;
  v_digits := public.phone_digits(c.peer_phone);
  IF v_digits IS NULL OR length(v_digits) < 9 THEN RETURN 'none'; END IF;

  -- (1) khách trọ đang thuê: tenants (cùng org) + hợp đồng ACTIVE mới nhất
  SELECT t.id, ct.id, ct.room_id INTO v_tenant, v_contract, v_room
    FROM public.tenants t
    LEFT JOIN LATERAL (
      SELECT x.id, x.room_id FROM public.contracts x
       WHERE x.tenant_id = t.id AND x.deleted_at IS NULL AND x.status = 'ACTIVE'
       ORDER BY x.start_date DESC NULLS LAST LIMIT 1
    ) ct ON true
   WHERE t.organization_id = c.organization_id AND t.deleted_at IS NULL
     AND public.phone_digits(t.phone) = v_digits
   ORDER BY (ct.id IS NOT NULL) DESC, t.updated_at DESC
   LIMIT 1;

  -- customers cùng SĐT (hồ sơ kho khách hàng — có thể trùng người với tenant)
  SELECT cu.id INTO v_customer
    FROM public.customers cu
   WHERE cu.organization_id = c.organization_id AND cu.deleted_at IS NULL
     AND public.phone_digits(cu.phone) = v_digits
   ORDER BY cu.updated_at DESC LIMIT 1;

  IF v_tenant IS NOT NULL OR v_customer IS NOT NULL THEN
    UPDATE public.zalo_conversations
       SET customer_id = v_customer,
           contract_id = COALESCE(v_contract, contract_id),
           room_id     = COALESCE(v_room, room_id),
           kind        = 'tenant',
           profile     = jsonb_set(COALESCE(profile, '{}'::jsonb), '{kind}', '"tenant"'),
           updated_at  = now()
     WHERE id = p_conversation_id;
    RETURN 'tenant';
  END IF;

  -- (3) lead
  SELECT l.id INTO v_lead
    FROM public.leads l
   WHERE l.organization_id = c.organization_id AND l.deleted_at IS NULL
     AND public.phone_digits(l.phone) = v_digits
   ORDER BY l.updated_at DESC LIMIT 1;
  IF v_lead IS NOT NULL THEN
    UPDATE public.zalo_conversations
       SET lead_id = v_lead, kind = 'lead',
           profile = jsonb_set(COALESCE(profile, '{}'::jsonb), '{kind}', '"lead"'),
           updated_at = now()
     WHERE id = p_conversation_id;
    RETURN 'lead';
  END IF;

  RETURN 'none';
END;
$$;
COMMENT ON FUNCTION public.zalo_match_conversation_crm(uuid) IS
  'Match peer_phone ↔ tenants(+HĐ ACTIVE)/customers/leads TRONG CÙNG org. Không ghi đè link đã gắn. Trigger và backfill đều đi qua hàm này.';
REVOKE ALL ON FUNCTION public.zalo_match_conversation_crm(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_match_conversation_crm(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Trigger: match tự động khi hội thoại mới có SĐT / SĐT đổi
--    (AFTER + WHEN chưa-có-link để bulk sync không re-match vô ích)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.zalo_crm_match_after_write()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.zalo_match_conversation_crm(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_zalo_crm_match_ins ON public.zalo_conversations;
CREATE TRIGGER trg_zalo_crm_match_ins
  AFTER INSERT ON public.zalo_conversations
  FOR EACH ROW
  WHEN (NEW.peer_phone IS NOT NULL AND NEW.customer_id IS NULL AND NEW.lead_id IS NULL)
  EXECUTE FUNCTION app_private.zalo_crm_match_after_write();

DROP TRIGGER IF EXISTS trg_zalo_crm_match_upd ON public.zalo_conversations;
CREATE TRIGGER trg_zalo_crm_match_upd
  AFTER UPDATE OF peer_phone ON public.zalo_conversations
  FOR EACH ROW
  WHEN (NEW.peer_phone IS NOT NULL AND NEW.peer_phone IS DISTINCT FROM OLD.peer_phone
        AND NEW.customer_id IS NULL AND NEW.lead_id IS NULL)
  EXECUTE FUNCTION app_private.zalo_crm_match_after_write();

-- ---------------------------------------------------------------------------
-- 4. Backfill — worker gọi sau syncContacts; người có quyền chạy tay được
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_backfill_crm_links(p_account_id uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id    uuid;
  v_hit   int := 0;
  v_orgok boolean;
BEGIN
  -- service_role (worker) đi thẳng; người thì phải có quyền view ở ít nhất 1 org
  IF auth.uid() IS NOT NULL THEN
    SELECT public.zalo_can('view') INTO v_orgok;
    IF NOT v_orgok THEN
      RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
    END IF;
  END IF;

  FOR v_id IN
    SELECT c.id FROM public.zalo_conversations c
     WHERE c.customer_id IS NULL AND c.lead_id IS NULL
       AND c.peer_phone IS NOT NULL
       AND (p_account_id IS NULL OR c.account_id = p_account_id)
       AND (auth.uid() IS NULL OR c.organization_id IN (SELECT public.zalo_authorized_org_ids('view')))
  LOOP
    IF public.zalo_match_conversation_crm(v_id) <> 'none' THEN
      v_hit := v_hit + 1;
    END IF;
  END LOOP;
  RETURN v_hit;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_backfill_crm_links(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.zalo_backfill_crm_links(uuid) FROM anon;

-- ---------------------------------------------------------------------------
-- 5. Gắn / tháo tay — chặn gắn chéo công ty ngay trong RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_link_conversation(
  p_conversation_id uuid,
  p_customer_id     uuid DEFAULT NULL,
  p_lead_id         uuid DEFAULT NULL
)
RETURNS public.zalo_conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c          public.zalo_conversations;
  v_contract uuid;
  v_room     uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_customer_id IS NULL AND p_lead_id IS NULL THEN
    RAISE EXCEPTION 'Chọn khách hàng hoặc lead để gắn';
  END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại'; END IF;
  IF NOT public.zalo_can('send', c.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.customers cu
                    WHERE cu.id = p_customer_id AND cu.organization_id = c.organization_id AND cu.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Khách hàng không thuộc tổ chức của hội thoại này' USING ERRCODE = '42501';
    END IF;
    -- kéo thêm HĐ ACTIVE nếu SĐT khách khớp một tenant đang thuê
    SELECT ct.id, ct.room_id INTO v_contract, v_room
      FROM public.tenants t
      JOIN public.contracts ct ON ct.tenant_id = t.id AND ct.deleted_at IS NULL AND ct.status = 'ACTIVE'
     WHERE t.organization_id = c.organization_id AND t.deleted_at IS NULL
       AND public.phone_digits(t.phone) = (SELECT public.phone_digits(cu.phone) FROM public.customers cu WHERE cu.id = p_customer_id)
     ORDER BY ct.start_date DESC NULLS LAST LIMIT 1;

    UPDATE public.zalo_conversations
       SET customer_id = p_customer_id, lead_id = NULL,
           contract_id = v_contract, room_id = v_room,
           kind = 'tenant',
           profile = jsonb_set(COALESCE(profile,'{}'::jsonb), '{kind}', '"tenant"'),
           updated_at = now()
     WHERE id = p_conversation_id RETURNING * INTO c;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.leads l
                    WHERE l.id = p_lead_id AND l.organization_id = c.organization_id AND l.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Lead không thuộc tổ chức của hội thoại này' USING ERRCODE = '42501';
    END IF;
    UPDATE public.zalo_conversations
       SET lead_id = p_lead_id, customer_id = NULL, contract_id = NULL, room_id = NULL,
           kind = 'lead',
           profile = jsonb_set(COALESCE(profile,'{}'::jsonb), '{kind}', '"lead"'),
           updated_at = now()
     WHERE id = p_conversation_id RETURNING * INTO c;
  END IF;

  RETURN c;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_link_conversation(uuid, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_link_conversation(uuid, uuid, uuid) FROM anon;

CREATE OR REPLACE FUNCTION public.zalo_unlink_conversation(p_conversation_id uuid)
RETURNS public.zalo_conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE c public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại'; END IF;
  IF NOT public.zalo_can('send', c.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_conversations
     SET customer_id = NULL, lead_id = NULL, contract_id = NULL, room_id = NULL,
         kind = 'unknown',
         profile = jsonb_set(COALESCE(profile,'{}'::jsonb), '{kind}', '"contact"'),
         updated_at = now()
   WHERE id = p_conversation_id RETURNING * INTO c;
  RETURN c;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_unlink_conversation(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_unlink_conversation(uuid) FROM anon;

-- ---------------------------------------------------------------------------
-- 6. Tóm tắt CRM cho InfoPanel — 1 roundtrip, chỉ cột cần hiển thị.
--    STABLE + không khoá dòng (gotcha 25006: PostgREST chạy STABLE trong
--    transaction READ ONLY — tuyệt đối không FOR SHARE/UPDATE ở đây).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_get_crm_summary(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c      public.zalo_conversations;
  v_out  jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT public.zalo_can('view', c.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;

  IF c.customer_id IS NOT NULL THEN
    SELECT v_out || jsonb_build_object('customer', jsonb_build_object(
             'id', cu.id, 'full_name', cu.full_name, 'phone', cu.phone,
             'avatar_url', cu.avatar_url, 'customer_type', cu.customer_type, 'status', cu.status_v2))
      INTO v_out
      FROM public.customers cu WHERE cu.id = c.customer_id;
  END IF;

  IF c.lead_id IS NOT NULL THEN
    SELECT v_out || jsonb_build_object('lead', jsonb_build_object(
             'id', l.id, 'customer_name', l.customer_name, 'phone', l.phone,
             'status', l.status::text, 'source', l.source,
             'budget_min', l.budget_min, 'budget_max', l.budget_max,
             'move_in_date', l.move_in_date, 'next_follow_up_date', l.next_follow_up_date))
      INTO v_out
      FROM public.leads l WHERE l.id = c.lead_id;
  END IF;

  IF c.contract_id IS NOT NULL THEN
    SELECT v_out || jsonb_build_object('contract', jsonb_build_object(
             'id', ct.id, 'contract_number', ct.contract_number, 'status', ct.status::text,
             'start_date', ct.start_date, 'end_date', ct.end_date,
             'rent_price', ct.rent_price, 'payment_cycle', ct.payment_cycle))
      INTO v_out
      FROM public.contracts ct WHERE ct.id = c.contract_id;
  END IF;

  IF c.room_id IS NOT NULL THEN
    SELECT v_out || jsonb_build_object('room', jsonb_build_object(
             'id', r.id, 'code', r.code, 'name', r.name, 'floor', r.floor,
             'building_name', b.name))
      INTO v_out
      FROM public.rooms r LEFT JOIN public.buildings b ON b.id = r.building_id
     WHERE r.id = c.room_id;
  END IF;

  RETURN NULLIF(v_out, '{}'::jsonb);
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_get_crm_summary(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_get_crm_summary(uuid) FROM anon;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — fixture trên org DEMO, chạy thật cả 2 chiều match/không match.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ORG_DEMO constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  ORG_THAT constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_uid    uuid;
  v_acc    uuid;
  v_conv1  uuid;
  v_conv2  uuid;
  v_cust   uuid;
  v_kind   text;
BEGIN
  SELECT m.user_id INTO v_uid
    FROM public.organization_memberships m
   WHERE m.organization_id = ORG_DEMO AND m.status = 'ACTIVE'
   ORDER BY m.user_id LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Không có người dùng org DEMO. DỪNG.'; END IF;

  -- khách hàng DEMO với SĐT hiếm gặp
  INSERT INTO public.customers(user_id, organization_id, full_name, phone)
  VALUES (v_uid, ORG_DEMO, 'ZZ Khách nghiệm thu M4', '0999888777')
  RETURNING id INTO v_cust;

  INSERT INTO public.zalo_accounts(user_id, organization_id, kind, name, status)
  VALUES (v_uid, ORG_DEMO, 'personal', 'ZZ nghiệm thu M4', 'disconnected') RETURNING id INTO v_acc;

  -- (a) trigger match khi INSERT có peer_phone khớp customer CÙNG org
  INSERT INTO public.zalo_conversations(user_id, account_id, thread_id, peer_name, peer_phone)
  VALUES (v_uid, v_acc, 'zz_m4_khop', 'ZZ khớp', '+84 999 888 777')
  RETURNING id INTO v_conv1;
  IF (SELECT customer_id FROM public.zalo_conversations WHERE id = v_conv1) IS DISTINCT FROM v_cust THEN
    RAISE EXCEPTION 'Trigger không gắn customer cùng org theo SĐT. DỪNG.';
  END IF;
  IF (SELECT kind FROM public.zalo_conversations WHERE id = v_conv1) <> 'tenant' THEN
    RAISE EXCEPTION 'kind không được set = tenant sau match. DỪNG.';
  END IF;

  -- (b) SĐT khớp khách của org KHÁC (org THẬT) → KHÔNG được gắn chéo
  INSERT INTO public.zalo_conversations(user_id, account_id, thread_id, peer_name, peer_phone)
  SELECT v_uid, v_acc, 'zz_m4_cheo', 'ZZ chéo', cu.phone
    FROM public.customers cu
   WHERE cu.organization_id = ORG_THAT AND cu.deleted_at IS NULL
     AND public.phone_digits(cu.phone) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.customers c2
                      WHERE c2.organization_id = ORG_DEMO AND c2.deleted_at IS NULL
                        AND public.phone_digits(c2.phone) = public.phone_digits(cu.phone))
   LIMIT 1
  RETURNING id INTO v_conv2;
  IF v_conv2 IS NOT NULL THEN
    IF (SELECT customer_id FROM public.zalo_conversations WHERE id = v_conv2) IS NOT NULL THEN
      RAISE EXCEPTION 'Match GẮN CHÉO công ty theo SĐT — vi phạm tách bạch. DỪNG.';
    END IF;
  END IF;

  -- (c) backfill idempotent: chạy lại không đổi gì (link đã có không bị ghi đè)
  PERFORM public.zalo_match_conversation_crm(v_conv1);
  IF (SELECT customer_id FROM public.zalo_conversations WHERE id = v_conv1) IS DISTINCT FROM v_cust THEN
    RAISE EXCEPTION 'Match chạy lại làm đổi link đã gắn. DỪNG.';
  END IF;

  -- dọn fixture
  DELETE FROM public.zalo_conversations WHERE id IN (v_conv1, v_conv2);
  DELETE FROM public.zalo_accounts WHERE id = v_acc;
  DELETE FROM public.customers WHERE id = v_cust;

  RAISE NOTICE 'Nghiệm thu M4 đạt: match đúng trong org, không gắn chéo công ty, không ghi đè link.';
END
$nghiem_thu$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================================
-- ROLLBACK (tay): DROP 2 trigger trg_zalo_crm_match_* + hàm
-- app_private.zalo_crm_match_after_write, DROP 5 hàm public zalo_match_…/
-- zalo_backfill_crm_links/zalo_link_conversation/zalo_unlink_conversation/
-- zalo_get_crm_summary, DROP 4 index *_phone_digits_idx.
-- =============================================================================
