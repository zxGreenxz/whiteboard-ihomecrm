-- Network Center: danh sách thiết bị đang kết nối KHÔNG lộ khách thuê cho người thiếu customers.view
--
-- Lỗ (xác minh trên source 18/10/2026): public.network_center_list_clients_v1, bản sống ở
-- 20260729145000_network_center_connection_host_fix.sql:406-470, chỉ gọi
-- app_private.network_center_require_view_v1 (network_center.view ở toà) rồi JOIN thẳng
-- public.customers, trả 'customerName', 'customerId', 'contractId' cho MỌI người xem được
-- Network Center của toà. Hàm là SECURITY DEFINER nên đi vòng qua RLS customers_select_rbac
-- (20260726130000_rls_setbased_missed_tables.sql:33-35: customers.view + chủ hồ sơ khách là
-- thành viên ACTIVE của công ty — current_visible_owner_ids()).
--
-- Sửa (không đổi chữ ký, không đổi kiểu trả về, khoá JSON giữ nguyên):
--   · 'customerName', 'customerId' chỉ có khi người gọi có customers.view Ở TOÀ NÀY
--     (can_do_on_building) VÀ chủ hồ sơ thuộc current_visible_owner_ids() VÀ hồ sơ thuộc công
--     ty của toà hoặc chưa gắn công ty (organization_id NULL — như customers_org_boundary của
--     web); còn lại null. Super admin không phải thành viên công ty của toà cũng không thấy
--     tên khách ở đây — chặt hơn web (web có customers_super_admin_all), có chủ ý: Network
--     Center không phải đường xem hồ sơ khách.
--   · 'contractId' (định danh hợp đồng của khách đang dùng mạng) chỉ có khi có customers.view
--     ở toà; còn lại null.
--   · 'roomId', 'roomHint' (tên phòng) giữ nguyên: thuộc phạm vi network_center.view của toà.
--   Web (src/lib/network-center/dto.ts clientItemSchema) đã cho cả ba trường nullable, và
--   mapClient tự rơi về "Chưa liên kết khách thuê".
-- ACL: chỉ authenticated (bỏ service_role — thân hàm đòi auth.uid() nên service_role vốn
-- không gọi được thành công; không nơi nào phía máy chủ gọi hàm này).
--
-- Chạy lại được: CREATE OR REPLACE; chốt đầu nhận thân cũ (còn JOIN customers không điều
-- kiện) hoặc thân mới (đã có v_show_customer). Nghiệm thu chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $chot$
DECLARE v_src text; v_secdef boolean;
BEGIN
  SELECT p.prosrc, p.prosecdef INTO v_src, v_secdef
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.network_center_list_clients_v1(uuid,timestamp with time zone,uuid,integer)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'chot: thieu public.network_center_list_clients_v1';
  END IF;
  IF v_secdef IS NOT TRUE
     OR position('network_center_require_view_v1' in v_src) = 0
     OR position('host(item.observed_ip)' in v_src) = 0
     OR (position('LEFT JOIN public.customers customer ON customer.id = link.customer_id' in v_src) = 0
         AND position('v_show_customer' in v_src) = 0) THEN
    RAISE EXCEPTION 'chot: network_center_list_clients_v1 khong con la ban 20260729145000 hoac ban va nay - doc lai ban dang chay truoc khi de';
  END IF;
END
$chot$;

CREATE OR REPLACE FUNCTION public.network_center_list_clients_v1(
  p_building_id uuid,
  p_before_seen_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_scope record; v_result jsonb; v_show_customer boolean; v_owners uuid[];
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100
     OR ((p_before_seen_at IS NULL) <> (p_before_id IS NULL)) THEN
    RAISE EXCEPTION 'Invalid client cursor' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_view_v1(p_building_id);
  -- Như RLS customers_select_rbac của web, nhưng theo đúng toà đang xem: customers.view ở toà
  -- này, và chủ hồ sơ khách là thành viên ACTIVE của công ty người gọi.
  v_show_customer := COALESCE(public.can_do_on_building('customers', 'view', p_building_id), false);
  v_owners := CASE WHEN v_show_customer
                   THEN COALESCE(public.current_visible_owner_ids(), '{}'::uuid[])
                   ELSE '{}'::uuid[] END;

  WITH page AS (
    SELECT client.*, link.room_id,
           CASE WHEN v_show_customer THEN link.contract_id END AS contract_id,
           customer.id AS customer_id,
           room.name AS room_name, customer.full_name AS customer_name
    FROM public.network_client_current client
    LEFT JOIN LATERAL (
      SELECT candidate.room_id, candidate.contract_id, candidate.customer_id
      FROM public.network_client_links candidate
      WHERE candidate.organization_id = client.organization_id
        AND candidate.building_id = client.building_id
        AND candidate.client_fingerprint = client.client_fingerprint
        AND candidate.valid_from <= client.observed_at
        AND (candidate.valid_to IS NULL OR candidate.valid_to > client.observed_at)
      ORDER BY candidate.confidence DESC, candidate.valid_from DESC, candidate.id DESC
      LIMIT 1
    ) link ON true
    LEFT JOIN public.rooms room ON room.id = link.room_id
    LEFT JOIN public.customers customer
      ON v_show_customer
     AND customer.id = link.customer_id
     AND (customer.organization_id IS NULL OR customer.organization_id = v_scope.organization_id)
     AND customer.user_id = ANY (v_owners)
    WHERE client.organization_id = v_scope.organization_id
      AND client.building_id = p_building_id
       AND client.expires_at > statement_timestamp()
      AND (p_before_id IS NULL OR ROW(client.last_seen_at, client.id) < ROW(p_before_seen_at, p_before_id))
    ORDER BY client.last_seen_at DESC, client.id DESC
    LIMIT p_limit + 1
  ), items AS (
    SELECT * FROM page ORDER BY last_seen_at DESC, id DESC LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', item.id, 'hostname', item.hostname, 'address', host(item.observed_ip),
      'macAddress', item.observed_mac::text, 'sessionType', item.session_type,
      'connectionType', item.connection_type, 'roomHint', coalesce(item.room_name, item.room_hint),
      'customerName', item.customer_name, 'roomId', item.room_id,
      'contractId', item.contract_id, 'customerId', item.customer_id,
      'rxBps', item.rx_bps, 'txBps', item.tx_bps,
      'randomizedMac', item.randomized_mac, 'sessionIdentity', item.session_key,
      'lastSeenAt', item.last_seen_at, 'expiresAt', item.expires_at
    ) ORDER BY item.last_seen_at DESC, item.id DESC) FROM items item), '[]'::jsonb),
    'nextCursor', CASE WHEN (SELECT count(*) FROM page) > p_limit THEN (
      SELECT jsonb_build_object('seenAt', item.last_seen_at, 'id', item.id)
      FROM items item ORDER BY item.last_seen_at, item.id LIMIT 1
    ) ELSE NULL END
  ) INTO v_result;
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_list_clients_v1(
  uuid,timestamp with time zone,uuid,integer
)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_list_clients_v1(
  uuid,timestamp with time zone,uuid,integer
)
  TO authenticated;

DO $nghiem_thu$
DECLARE v_fn regprocedure := to_regprocedure('public.network_center_list_clients_v1(uuid,timestamp with time zone,uuid,integer)');
  v_src text; v_secdef boolean; v_volatile "char"; v_config text[];
BEGIN
  SELECT p.prosrc, p.prosecdef, p.provolatile, p.proconfig INTO v_src, v_secdef, v_volatile, v_config
    FROM pg_proc p WHERE p.oid = v_fn;
  IF v_secdef IS NOT TRUE OR v_volatile <> 's'
     OR v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']::text[] THEN
    RAISE EXCEPTION 'nghiem_thu: network_center_list_clients_v1 sai definer/volatility/search_path (%, %, %)',
      v_secdef, v_volatile, v_config;
  END IF;
  IF position('network_center_require_view_v1' in v_src) = 0
     OR position('can_do_on_building(''customers'', ''view'', p_building_id)' in v_src) = 0
     OR position('current_visible_owner_ids()' in v_src) = 0
     OR position('customer.user_id = ANY (v_owners)' in v_src) = 0
     OR position('CASE WHEN v_show_customer THEN link.contract_id END' in v_src) = 0
     OR position('host(item.observed_ip)' in v_src) = 0 THEN
    RAISE EXCEPTION 'nghiem_thu: network_center_list_clients_v1 thieu cua customers.view/chu ho so';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: ACL network_center_list_clients_v1 phai chi authenticated';
  END IF;
END
$nghiem_thu$;

COMMIT;
NOTIFY pgrst, 'reload schema';
