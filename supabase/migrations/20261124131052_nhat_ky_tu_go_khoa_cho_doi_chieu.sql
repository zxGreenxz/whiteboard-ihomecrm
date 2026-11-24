-- Nhật ký tự gỡ khoá «chờ đối chiếu» trên máy chủ (đợt 1b, 24/11/2026).
--
-- VÌ SAO. Từ đợt 1 (PR #480) người dùng được tự gỡ dấu «chờ đối chiếu» đã quá 2 phút khi máy không tự
-- kết luận được, kể cả với thao tác tiền. Chủ dự án chốt 24/11: cho làm tiếp nhưng PHẢI có nhật ký trên
-- máy chủ để chủ xem ai tự gỡ, lúc nào, thao tác gì. Tới nay mỗi lần gỡ chỉ nằm trong hàng đợi
-- localStorage `ihome:pending-valve-log:v1:<người dùng>` của trình duyệt người gỡ. File này thêm chỗ ghi
-- trên máy chủ; trình duyệt đẩy hàng đợi lên sau mỗi lần gỡ và khi mở ứng dụng.
--
-- KHÔNG CHẠM TIỀN. Một bảng chỉ thêm và hai hàm; không sửa bảng hay hàm nào có sẵn.
--
-- BẢNG app_private.pending_valve_release_log — CHỈ THÊM.
--   * Nằm ở app_private, không cấp quyền bảng cho vai nào (kể cả service_role): chỉ hai hàm dưới đây đọc/ghi.
--   * Trigger chặn UPDATE / DELETE / TRUNCATE kể cả từ hàm DEFINER sau này.
--   * Không khoá ngoại tới auth.users / organizations: người dùng hay công ty bị xoá thì dòng vẫn phải còn.
--   * Chống trùng theo (người gỡ, mã dòng do trình duyệt sinh): trình duyệt gửi lại cùng dòng (rớt mạng sau
--     khi máy chủ đã ghi) không tạo dòng thứ hai.
--   * stuck_at / released_at là giờ MÁY người gỡ (có thể lệch); received_at là giờ máy chủ nhận và là thứ tự
--     của danh sách, để một dòng mang giờ máy sai không ghim đầu hay chìm cuối danh sách.
--
-- HÀM GHI public.pending_valve_release_log_append_v1(p_entries jsonb, p_device text)
--   * Người gỡ lấy từ auth.uid(), không tin tham số; dòng mang userId khác người gọi bị từ chối (not_self).
--   * Tra chống trùng TRƯỚC mọi phép kiểm khác: dòng đã có (cùng người, cùng mã) trả duplicate/conflict dù
--     trạng thái công ty của người đó đã đổi, để trình duyệt bỏ được nó khỏi hàng đợi.
--   * Công ty của dòng: organizationId của dấu nếu là uuid. Dấu phạm vi người dùng ('actor-scope') cố ý không
--     gắn công ty (thao tác có thể thuộc bất kỳ công ty nào người đó làm việc), nên chỉ ghi khi người gỡ có
--     ĐÚNG MỘT tư cách ACTIVE còn hạn (sole_membership); nhiều công ty thì từ chối no_org và trình duyệt giữ
--     dòng lại — không đoán công ty, để không ghi dữ liệu của công ty này vào nhật ký công ty khác.
--   * Người gỡ phải đang làm ở công ty đó (tư cách ACTIVE còn hạn) hoặc là superadmin (công ty phải tồn tại);
--     hoặc vừa thôi làm: ACTIVE/SUSPENDED hết hạn chưa quá 30 ngày, REVOKED chưa quá 30 ngày — để lần gỡ ngay trước
--     khi bị tạm dừng / thu hồi vẫn lên được nhật ký nếu lần đẩy đầu bị rớt mạng.
--   * Giờ kẹt / giờ gỡ phải trong năm 1970–2099 (ngoài khoảng đó là dữ liệu hỏng: invalid). Cận dưới 1970 vì kho
--     dấu thu tiền gán giờ gửi 1970-01-01 cho dấu cũ thiếu giờ.
--   * Từng dòng một kết quả: inserted / duplicate / rejected(reason). Một dòng hỏng không làm hỏng cả lô.
--   * Tối đa 50 dòng mỗi lần gọi; tối đa 500 dòng MỚI mỗi người trong 24 giờ, và chỉ 20 nếu người đó không còn
--     làm ở công ty của dòng — dòng vượt hạn mức trả rejected(rate_limited), trình duyệt giữ lại; dòng đã có vẫn
--     trả duplicate.
--
-- HÀM ĐỌC public.pending_valve_release_log_list_v1(p_organization_id, p_limit, p_before_received_at, p_before_id)
--   * Chỉ superadmin và chủ công ty theo nghĩa CHẶT (tư cách ACTIVE loại OWNER còn hạn + binding còn hiệu
--     lực tới vai system_key = 'TENANT_OWNER'), theo đúng công ty được hỏi. Cố ý không khớp theo TÊN vai
--     ('Chủ công ty' khi system_key NULL): người giữ users.edit đổi được tên vai thường. Đo production
--     24/11/2026 (chỉ đọc): công ty thật 2 người đạt vế chặt, 1 superadmin.
--   * Người không đủ quyền nhận {allowed:false, rows:[]} để giao diện ẩn mục, KHÔNG nhận dòng nào.
--   * Mới nhất trước theo giờ máy chủ nhận, phân trang theo con trỏ (received_at, id).
--
-- Không chứa tên khách hay số tiền: dòng chỉ mang tên thao tác, namespace, khoá nghiệp vụ, mã lần gửi, mã
-- bản ghi do lõi chống ghi trùng ghi lại, và chuỗi trình duyệt (user agent) của máy gỡ.
--
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS rồi tạo lại, ACL khẳng định lại.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $requires$
BEGIN
  IF to_regnamespace('app_private') IS NULL
    OR to_regprocedure('auth.uid()') IS NULL
    OR to_regclass('public.organizations') IS NULL
    OR to_regclass('public.organization_memberships') IS NULL
    OR to_regclass('public.organization_roles') IS NULL
    OR to_regclass('public.role_bindings') IS NULL
    OR to_regclass('public.super_admins') IS NULL
    OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'pending_valve_release_log_requires_missing';
  END IF;
END $requires$;

-- ---------- 1. Bảng chỉ thêm ----------
CREATE TABLE IF NOT EXISTS app_private.pending_valve_release_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entry_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  organization_source text NOT NULL CHECK (organization_source IN ('pending', 'sole_membership')),
  pending_scope text NOT NULL CHECK (char_length(pending_scope) BETWEEN 1 AND 100),
  namespace text NOT NULL CHECK (char_length(namespace) BETWEEN 1 AND 100),
  business_key text NOT NULL CHECK (char_length(business_key) BETWEEN 1 AND 1000),
  operation text CHECK (operation IS NULL OR char_length(operation) BETWEEN 1 AND 200),
  attempt_id text NOT NULL CHECK (char_length(attempt_id) BETWEEN 1 AND 200),
  record_ids text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(record_ids) <= 100),
  record_count integer NOT NULL DEFAULT 0 CHECK (record_count BETWEEN cardinality(record_ids) AND 1000000),
  stuck_at timestamptz NOT NULL CHECK (stuck_at >= '1970-01-01T00:00:00Z' AND stuck_at < '2100-01-01T00:00:00Z'),
  released_at timestamptz NOT NULL CHECK (released_at >= '1970-01-01T00:00:00Z' AND released_at < '2100-01-01T00:00:00Z'),
  -- clock_timestamp chứ không now(): các dòng của cùng một lô giữ đúng thứ tự trong hàng đợi.
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  device text CHECK (device IS NULL OR char_length(device) BETWEEN 1 AND 300),
  CONSTRAINT pending_valve_release_log_entry_uq UNIQUE (actor_user_id, client_entry_id)
);

CREATE INDEX IF NOT EXISTS pending_valve_release_log_org_idx
  ON app_private.pending_valve_release_log (organization_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS pending_valve_release_log_actor_idx
  ON app_private.pending_valve_release_log (actor_user_id, received_at DESC);

ALTER TABLE app_private.pending_valve_release_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.pending_valve_release_log FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.pending_valve_release_log IS
  'Mỗi lần người dùng tự gỡ một dấu «chờ đối chiếu» qua hộp cảnh báo chung (van, src/lib/pendingValve.ts): ai gỡ, công ty, thao tác, giờ kẹt, giờ gỡ (giờ máy người gỡ), giờ máy chủ nhận, mã bản ghi liên quan, thiết bị. CHỈ THÊM (trigger chặn sửa/xoá). Chống trùng theo (actor_user_id, client_entry_id). Chỉ ghi qua pending_valve_release_log_append_v1, chỉ đọc qua pending_valve_release_log_list_v1.';

-- ---------- 2. Chặn sửa / xoá ----------
CREATE OR REPLACE FUNCTION app_private.pending_valve_release_log_append_only_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  RAISE EXCEPTION 'Nhật ký tự gỡ khoá chỉ được thêm, không sửa hay xoá.' USING ERRCODE = '0A000';
END
$fn$;

DROP TRIGGER IF EXISTS pending_valve_release_log_no_update_delete ON app_private.pending_valve_release_log;
CREATE TRIGGER pending_valve_release_log_no_update_delete
  BEFORE UPDATE OR DELETE ON app_private.pending_valve_release_log
  FOR EACH ROW EXECUTE FUNCTION app_private.pending_valve_release_log_append_only_v1();
DROP TRIGGER IF EXISTS pending_valve_release_log_no_truncate ON app_private.pending_valve_release_log;
CREATE TRIGGER pending_valve_release_log_no_truncate
  BEFORE TRUNCATE ON app_private.pending_valve_release_log
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.pending_valve_release_log_append_only_v1();

-- ---------- 3. Hàm ghi ----------
CREATE OR REPLACE FUNCTION public.pending_valve_release_log_append_v1(p_entries jsonb, p_device text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  c_uuid constant text := '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
  c_time constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
  v_actor uuid := auth.uid();
  v_device text := left(nullif(btrim(coalesce(p_device, '')), ''), 300);
  v_is_super boolean;
  v_active_orgs uuid[];
  v_quota integer;
  v_inactive_quota integer;
  v_member_active boolean;
  v_item jsonb;
  v_id_text text;
  v_id uuid;
  v_scope text;
  v_org uuid;
  v_source text;
  v_namespace text;
  v_business_key text;
  v_operation text;
  v_attempt text;
  v_records text[];
  v_count integer;
  v_stuck timestamptz;
  v_released timestamptz;
  v_reason text;
  v_inserted uuid;
  v_existing app_private.pending_valve_release_log%ROWTYPE;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Phiên đăng nhập không hợp lệ — đăng nhập lại.' USING ERRCODE = '42501';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'Danh sách nhật ký không hợp lệ.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_entries) > 50 THEN
    RAISE EXCEPTION 'Mỗi lần gửi tối đa 50 dòng nhật ký.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_entries) = 0 THEN
    RETURN jsonb_build_object('results', v_results);
  END IF;

  -- Tuần tự hoá theo người gỡ để hạn mức không bị lọt bởi các lần gọi song song.
  PERFORM pg_advisory_xact_lock(hashtextextended('pending_valve_release_log:' || v_actor::text, 0));
  v_quota := (SELECT count(*) FROM app_private.pending_valve_release_log l
               WHERE l.actor_user_id = v_actor AND l.received_at > now() - interval '24 hours')::integer;
  v_inactive_quota := 20 - v_quota;
  v_quota := 500 - v_quota;

  v_is_super := EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = v_actor);
  SELECT coalesce(array_agg(DISTINCT m.organization_id ORDER BY m.organization_id), '{}'::uuid[])
    INTO v_active_orgs
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.status = 'ACTIVE'
     AND m.valid_from <= now()
     AND (m.valid_to IS NULL OR m.valid_to > now());

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_entries) AS e(value) LOOP
    v_reason := NULL;
    v_id_text := CASE WHEN jsonb_typeof(v_item) = 'object' AND jsonb_typeof(v_item -> 'id') = 'string' THEN v_item ->> 'id' END;

    IF v_id_text IS NULL OR v_id_text !~ c_uuid THEN
      v_reason := 'invalid';
    ELSIF jsonb_typeof(v_item -> 'userId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item -> 'organizationId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item -> 'namespace') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item -> 'businessKey') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item -> 'attemptId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item -> 'stuckAt') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item -> 'releasedAt') IS DISTINCT FROM 'string'
      OR coalesce(jsonb_typeof(v_item -> 'operation'), 'null') NOT IN ('string', 'null')
      OR jsonb_typeof(v_item -> 'recordIds') IS DISTINCT FROM 'array'
      OR coalesce(jsonb_typeof(v_item -> 'recordCount'), 'null') NOT IN ('number', 'null') THEN
      v_reason := 'invalid';
    ELSIF lower(v_item ->> 'userId') <> v_actor::text THEN
      -- Không bỏ dòng: phiên đăng nhập có thể vừa đổi người giữa lúc trình duyệt đọc hàng đợi và lúc gửi.
      v_reason := 'not_self';
    ELSE
      v_id := v_id_text::uuid;
      v_scope := v_item ->> 'organizationId';
      v_namespace := v_item ->> 'namespace';
      v_business_key := v_item ->> 'businessKey';
      v_operation := v_item ->> 'operation';
      v_attempt := v_item ->> 'attemptId';
    END IF;

    -- Chống trùng trước mọi phép kiểm phụ thuộc trạng thái hiện tại (tư cách, hạn mức): dòng đã ghi thì
    -- luôn được báo là đã ghi.
    IF v_reason IS NULL THEN
      SELECT * INTO v_existing
        FROM app_private.pending_valve_release_log l
       WHERE l.actor_user_id = v_actor AND l.client_entry_id = v_id;
      IF FOUND THEN
        v_results := v_results || jsonb_build_array(CASE
          WHEN v_existing.pending_scope = v_scope AND v_existing.namespace = v_namespace
           AND v_existing.business_key = v_business_key AND v_existing.attempt_id = v_attempt
          THEN jsonb_build_object('id', v_id_text, 'status', 'duplicate')
          ELSE jsonb_build_object('id', v_id_text, 'status', 'rejected', 'reason', 'conflict')
        END);
        CONTINUE;
      END IF;
    END IF;

    IF v_reason IS NULL AND (
         char_length(v_scope) NOT BETWEEN 1 AND 100
      OR char_length(v_namespace) NOT BETWEEN 1 AND 100
      OR char_length(v_business_key) NOT BETWEEN 1 AND 1000
      OR char_length(v_attempt) NOT BETWEEN 1 AND 200
      OR (v_operation IS NOT NULL AND char_length(v_operation) NOT BETWEEN 1 AND 200)
      OR jsonb_array_length(v_item -> 'recordIds') > 100
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_item -> 'recordIds') AS r(value)
         WHERE jsonb_typeof(r.value) <> 'string' OR char_length(r.value #>> '{}') NOT BETWEEN 1 AND 200
      )
      OR (v_item ->> 'stuckAt') !~ c_time
      OR (v_item ->> 'releasedAt') !~ c_time
      OR (jsonb_typeof(v_item -> 'recordCount') = 'number' AND (v_item ->> 'recordCount') !~ '^[0-9]{1,7}$')) THEN
      v_reason := 'invalid';
    END IF;

    IF v_reason IS NULL THEN
      SELECT coalesce(array_agg(r.value #>> '{}' ORDER BY r.ord), '{}'::text[])
        INTO v_records
        FROM jsonb_array_elements(v_item -> 'recordIds') WITH ORDINALITY AS r(value, ord);
      v_count := greatest(coalesce((v_item ->> 'recordCount')::integer, 0), cardinality(v_records));
      IF v_count > 1000000 THEN
        v_reason := 'invalid';
      END IF;
    END IF;

    IF v_reason IS NULL THEN
      -- Ngày giờ đúng mẫu mà sai giá trị (tháng 13, giờ 25…) hay ngoài 1970–2099 là dòng hỏng, không phải lỗi cả lô.
      -- Cận dưới là 1970 chứ không phải năm triển khai: kho dấu thu tiền gán giờ gửi = 1970-01-01 cho dấu cũ thiếu
      -- giờ (src/lib/pendingCollection.ts), và máy hết pin có thể về năm 1970/2000 — những lần gỡ đó vẫn phải lên.
      BEGIN
        v_stuck := (v_item ->> 'stuckAt')::timestamptz;
        v_released := (v_item ->> 'releasedAt')::timestamptz;
        IF v_stuck < '1970-01-01T00:00:00Z' OR v_stuck >= '2100-01-01T00:00:00Z'
          OR v_released < '1970-01-01T00:00:00Z' OR v_released >= '2100-01-01T00:00:00Z' THEN
          v_reason := 'invalid';
        END IF;
      EXCEPTION WHEN data_exception THEN
        v_reason := 'invalid';
      END;
    END IF;

    IF v_reason IS NULL THEN
      IF v_scope ~ c_uuid THEN
        v_org := v_scope::uuid;
        v_source := 'pending';
      ELSIF cardinality(v_active_orgs) = 1 THEN
        v_org := v_active_orgs[1];
        v_source := 'sole_membership';
      ELSE
        v_reason := 'no_org';
      END IF;
    END IF;

    IF v_reason IS NULL THEN
      -- Đang làm ở công ty đó (hoặc superadmin): hạn mức thường. Vừa thôi làm (tư cách hết hạn / tạm dừng / thu hồi
      -- chưa quá 30 ngày): vẫn nhận, để lần gỡ ngay trước khi thôi việc không mất khi lần đẩy đầu bị rớt, nhưng chỉ
      -- trong hạn mức nhỏ — người đã bị tạm dừng hay thu hồi không đổ được nhiều dòng vào nhật ký công ty.
      v_member_active := v_org = ANY (v_active_orgs)
        OR (v_is_super AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_org));
      IF NOT v_member_active AND NOT EXISTS (
        SELECT 1 FROM public.organization_memberships m
         WHERE m.organization_id = v_org
           AND m.user_id = v_actor
           AND m.valid_from <= now()
           AND (   (m.status IN ('ACTIVE', 'SUSPENDED') AND (m.valid_to IS NULL OR m.valid_to > now() - interval '30 days'))
                OR (m.status = 'REVOKED' AND m.revoked_at > now() - interval '30 days'))
      ) THEN
        v_reason := 'not_member';
      ELSIF v_quota <= 0 OR (NOT v_member_active AND v_inactive_quota <= 0) THEN
        v_reason := 'rate_limited';
      END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object('id', v_id_text, 'status', 'rejected', 'reason', v_reason));
      CONTINUE;
    END IF;

    v_inserted := NULL;
    INSERT INTO app_private.pending_valve_release_log (
      client_entry_id, actor_user_id, organization_id, organization_source, pending_scope, namespace,
      business_key, operation, attempt_id, record_ids, record_count, stuck_at, released_at, device
    ) VALUES (
      v_id, v_actor, v_org, v_source, v_scope, v_namespace,
      v_business_key, v_operation, v_attempt, v_records, v_count, v_stuck, v_released, v_device
    )
    ON CONFLICT ON CONSTRAINT pending_valve_release_log_entry_uq DO NOTHING
    RETURNING id INTO v_inserted;

    IF v_inserted IS NOT NULL THEN
      v_quota := v_quota - 1;
      v_inactive_quota := v_inactive_quota - 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object('id', v_id_text, 'status', 'inserted'));
    ELSE
      -- Không tới được nhánh này khi các lần gọi của cùng người đã tuần tự bởi khoá ở trên; giữ để không
      -- bao giờ báo «đã ghi» cho một dòng không chắc là của lượt này.
      v_results := v_results || jsonb_build_array(jsonb_build_object('id', v_id_text, 'status', 'duplicate'));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('results', v_results);
END
$fn$;

COMMENT ON FUNCTION public.pending_valve_release_log_append_v1(jsonb, text) IS
  'Đẩy hàng đợi nhật ký tự gỡ khoá của trình duyệt lên máy chủ (tối đa 50 dòng/lần). Người gỡ = auth.uid(); dòng của người khác bị từ chối not_self. Chống trùng theo (người gỡ, id dòng) trước mọi phép kiểm khác: gửi lại cùng dòng trả duplicate, khác nội dung trả conflict, không tạo dòng thứ hai. Công ty: uuid của dấu; dấu actor-scope chỉ ghi khi người gỡ có đúng một tư cách ACTIVE (không thì no_org). Phải đang làm ở công ty đó (ACTIVE còn hạn) hoặc là superadmin, hoặc vừa thôi làm (ACTIVE/SUSPENDED hết hạn hay REVOKED chưa quá 30 ngày) — không thì not_member. Giờ ngoài 1970–2099 là invalid. Quá 500 dòng mới/người/24 giờ (20 nếu đã thôi làm ở công ty của dòng) trả rate_limited. Trả {results:[{id,status:inserted|duplicate|rejected,reason?}]}; lỗi từng dòng không làm hỏng cả lô.';

-- ---------- 4. Hàm đọc ----------
CREATE OR REPLACE FUNCTION public.pending_valve_release_log_list_v1(
  p_organization_id uuid,
  p_limit integer DEFAULT 50,
  p_before_received_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_allowed boolean;
  v_rows jsonb;
  v_total integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Phiên đăng nhập không hợp lệ — đăng nhập lại.' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu công ty cần xem nhật ký.' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Số dòng mỗi trang phải từ 1 đến 200.' USING ERRCODE = '22023';
  END IF;
  IF (p_before_received_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'Con trỏ trang không hợp lệ.' USING ERRCODE = '22023';
  END IF;

  v_allowed := EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = v_actor)
    OR EXISTS (
      SELECT 1
        FROM public.organization_memberships m
        JOIN public.role_bindings rb
          ON rb.membership_id = m.id
         AND rb.organization_id = m.organization_id
        JOIN public.organization_roles r
          ON r.id = rb.role_id
         AND r.organization_id = rb.organization_id
       WHERE m.organization_id = p_organization_id
         AND m.user_id = v_actor
         AND m.status = 'ACTIVE'
         AND m.member_type = 'OWNER'
         AND m.valid_from <= now()
         AND (m.valid_to IS NULL OR m.valid_to > now())
         AND r.system_key = 'TENANT_OWNER'
         AND r.status = 'ACTIVE'
         AND coalesce(rb.valid_from, '-infinity'::timestamptz) <= now()
         AND (rb.valid_to IS NULL OR rb.valid_to > now())
    );
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('organizationId', p_organization_id, 'allowed', false, 'rows', '[]'::jsonb, 'hasMore', false);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id,
           'entryId', t.client_entry_id,
           'actorUserId', t.actor_user_id,
           'actorName', t.actor_name,
           'organizationSource', t.organization_source,
           'namespace', t.namespace,
           'businessKey', t.business_key,
           'operation', t.operation,
           'attemptId', t.attempt_id,
           'recordIds', to_jsonb(t.record_ids),
           'recordCount', t.record_count,
           'stuckAt', t.stuck_at,
           'releasedAt', t.released_at,
           'receivedAt', t.received_at,
           'device', t.device
         ) ORDER BY t.received_at DESC, t.id DESC) FILTER (WHERE t.n <= p_limit), '[]'::jsonb),
         count(*)
    INTO v_rows, v_total
    FROM (
      SELECT l.*, nullif(btrim(p.full_name), '') AS actor_name,
             row_number() OVER (ORDER BY l.received_at DESC, l.id DESC) AS n
        FROM app_private.pending_valve_release_log l
        LEFT JOIN public.profiles p ON p.id = l.actor_user_id
       WHERE l.organization_id = p_organization_id
         AND (p_before_received_at IS NULL OR (l.received_at, l.id) < (p_before_received_at, p_before_id))
       ORDER BY l.received_at DESC, l.id DESC
       LIMIT p_limit + 1
    ) t;

  RETURN jsonb_build_object('organizationId', p_organization_id, 'allowed', true, 'rows', v_rows, 'hasMore', v_total > p_limit);
END
$fn$;

COMMENT ON FUNCTION public.pending_valve_release_log_list_v1(uuid, integer, timestamptz, uuid) IS
  'Danh sách nhật ký tự gỡ khoá của MỘT công ty, mới nhất trước theo giờ máy chủ nhận, con trỏ (p_before_received_at, p_before_id), 1–200 dòng/trang. Chỉ superadmin và chủ công ty theo nghĩa chặt (tư cách ACTIVE loại OWNER còn hạn + binding còn hiệu lực tới vai system_key=TENANT_OWNER) của đúng công ty đó; người khác nhận {allowed:false, rows:[]}. Trả {organizationId, allowed, rows, hasMore}.';

-- ---------- 5. ACL ----------
REVOKE ALL ON FUNCTION app_private.pending_valve_release_log_append_only_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pending_valve_release_log_append_v1(jsonb, text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.pending_valve_release_log_list_v1(uuid, integer, timestamptz, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.pending_valve_release_log_append_v1(jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pending_valve_release_log_list_v1(uuid, integer, timestamptz, uuid) TO authenticated;

DO $check$
DECLARE
  v_sig text;
  v_role text;
  v_priv text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.pending_valve_release_log_append_v1(jsonb,text)',
    'public.pending_valve_release_log_list_v1(uuid,integer,timestamptz,uuid)'
  ] LOOP
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
      OR has_function_privilege('anon', v_sig, 'EXECUTE')
      OR has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'pending_valve_release_log_acl_public_failed: %', v_sig;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = v_sig::regprocedure
         AND p.prosecdef
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c(setting) WHERE c.setting LIKE 'search_path=%')
    ) THEN
      RAISE EXCEPTION 'pending_valve_release_log_definer_failed: %', v_sig;
    END IF;
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'app_private.pending_valve_release_log_append_only_v1()', 'EXECUTE') THEN
      RAISE EXCEPTION 'pending_valve_release_log_acl_private_failed: %', v_role;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege(v_role, 'app_private.pending_valve_release_log', v_priv) THEN
        RAISE EXCEPTION 'pending_valve_release_log_acl_table_failed: % %', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'app_private.pending_valve_release_log'::regclass
         AND NOT t.tgisinternal
         AND t.tgname IN ('pending_valve_release_log_no_update_delete', 'pending_valve_release_log_no_truncate')) <> 2 THEN
    RAISE EXCEPTION 'pending_valve_release_log_append_only_trigger_missing';
  END IF;
END $check$;

COMMIT;
NOTIFY pgrst, 'reload schema';
