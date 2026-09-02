-- =============================================================================
-- reserve_ai_usage phải BIẾT công ty nào đang tiêu hạn mức
--
-- LỖ ĐANG VÁ
--   Bản gốc (`20260710200000:205-306`) INSERT một dòng `pending` vào
--   `ai_usage_logs` mà KHÔNG nêu `organization_id`. Cột đó không được để trống:
--   `20260811060000` gắn trigger `trg_autofill_org_strict` BEFORE INSERT, và
--   hàm `app_private.autofill_org_strict` (`20260811020000:31-86`) chỉ điền
--   được khi suy ra ĐÚNG MỘT membership ACTIVE từ `user_id` (rồi tới `owner_id`).
--   Không suy được thì nó RAISE 23502, `reserve_ai_usage` cuộn lại, và llm-proxy
--   trả 500 `internal` — một thông báo không nói gì về nguyên nhân thật.
--
--   Hôm nay chưa nổ vì cả ba người từng gọi Copilot trên production đều thuộc
--   đúng một công ty. Nhưng Copilot vừa có ô CHỌN công ty
--   (`list_my_copilot_organizations_v1`, `20260814032500`) — người đa tổ chức là
--   kịch bản được thiết kế cho tính năng này, không phải ngoại lệ hiếm. Với họ
--   thì hoặc mỗi lượt gọi chết 500, hoặc — tệ hơn — trigger suy ra được MỘT công
--   ty nào đó và ghi hạn mức vào công ty người dùng KHÔNG chọn.
--
-- VÌ SAO THAM SỐ CHỨ KHÔNG PHẢI SUY TIẾP TỪ user_id
--   Suy từ `user_id` là đoán, và nó đoán sai đúng ở chỗ quan trọng: người dùng
--   đã nói họ đang làm việc cho công ty nào bằng cách chọn trên giao diện. Con
--   số phải vào sổ theo lời đó. Trigger vẫn giữ nguyên và vẫn là lưới cuối cho
--   các đường ghi khác — nó chỉ không còn là đường ghi CHÍNH của Copilot nữa
--   (hàm điền sẵn `organization_id` thì `autofill_org_strict` return ngay).
--
-- VÌ SAO DROP RỒI CREATE, KHÔNG CREATE OR REPLACE
--   Thêm một tham số là một chữ ký KHÁC. `CREATE OR REPLACE` khi đó không thay
--   gì cả — nó đẻ thêm một overload, và bản 6 tham số cũ vẫn gọi được, vẫn
--   INSERT thiếu `organization_id`. Vá mà để nguyên đường cũ thì không phải vá.
--   (Án lệ trong repo: overload RPC làm PostgREST chọn nhầm bản.)
--
-- VÌ SAO `DEFAULT NULL` CHỨ KHÔNG PHẢI THAM SỐ TRẦN
--   Đây KHÔNG phải cách đóng cửa sổ 500 giữa migration và deploy proxy — cửa sổ
--   đó chỉ đóng bằng một việc: deploy llm-proxy NGAY sau khi migration này chạy.
--   `DEFAULT NULL` giải quyết chuyện khác, và giải quyết hai chuyện:
--     (1) ĐƯỜNG LÙI CỦA PROXY. Nếu phải rollback llm-proxy về bản 6 tham số sau
--         khi migration đã chạy, lời gọi 6 tham số vẫn PHÂN GIẢI được sang hàm
--         này (PostgreSQL điền default cho tham số cuối) thay vì chết PGRST202
--         "function not found". Nó trả `organization_required` — một lỗi 400 nói
--         đúng nguyên nhân — chứ không phải 404 nói sai nguyên nhân.
--     (2) NHÁNH `organization_required` Ở TẦNG RPC MỚI VỚI TỚI ĐƯỢC. Tham số
--         trần làm PostgREST chặn ngay ở khâu phân giải hàm, nên `RAISE
--         'organization_required'` bên dưới là mã chết: không lời gọi nào chạm
--         tới nó. Có default thì hàng rào thứ hai (sau hàng rào header của
--         proxy) mới thật sự là hàng rào, và test (h2) của proxy mới đo được
--         thứ có thật.
--   `DEFAULT NULL` KHÔNG nới lỏng gì: `RAISE 'organization_required'` khi NULL
--   giữ nguyên và đứng trước mọi thứ khác. Thiếu org vẫn là hỏng, chỉ khác ở
--   chỗ nó hỏng bằng câu nói đúng sự thật.
--
-- QUYỀN TRÊN TỔ CHỨC — BÁM ĐÚNG DANH BẠ ĐÃ CÓ
--   Điều kiện ở đây chép theo `list_my_copilot_organizations_v1`: công ty phải
--   `ACTIVE`, người dùng phải có membership `ACTIVE` trên chính nó, HOẶC là super
--   admin và công ty không phải org sandbox. Hai lớp phải nói cùng một điều: nếu
--   danh bạ không cho chọn org sandbox mà reserve vẫn nhận, thì một client sửa
--   tay header sẽ ghi được usage vào đúng cái org mà ~110 policy RESTRICTIVE
--   (`20260801020000`) đang giấu.
--
--   KHÔNG dùng `public.is_super_admin()` như danh bạ: hàm đó đọc `auth.uid()`,
--   còn hàm này chạy dưới `service_role` từ edge function nên `auth.uid()` là
--   NULL. Người dùng ở đây là `p_user_id`, nên phải tra thẳng `public.super_admins`.
--
-- ĐIỀU NÀY KHÔNG PHỦ
--   Mô hình quota giữ NGUYÊN: `daily_usd_cap_tenant` vẫn đo theo `owner_id` suy
--   từ `staff_assignments`, không đo theo tổ chức. Đổi trục hạn mức là thay đổi
--   nghiệp vụ khác, không đi ké vào đây. Org vào sổ trước; ai muốn tính hạn mức
--   theo org thì đã có cột để tính.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ── 1. Bỏ chữ ký 6 tham số ───────────────────────────────────────────────────
-- Phải DROP trước CREATE (xem đầu file). `IF EXISTS` để chạy lượt hai và chạy
-- trên database dựng lại từ baseline đều im lặng đi qua.
DROP FUNCTION IF EXISTS public.reserve_ai_usage(uuid, text, text, text, text, numeric);

-- ── 2. Chữ ký 7 tham số ──────────────────────────────────────────────────────
-- Thân hàm chép nguyên từ `20260710200000` — cùng thứ tự gate, cùng mã lỗi mà
-- proxy đang map sang HTTP status: copilot_disabled | not_entitled |
-- not_permitted | rate_limited | daily_quota. Phần THÊM chỉ có ba chỗ, đánh dấu
-- bằng "(G0-B)".
CREATE OR REPLACE FUNCTION public.reserve_ai_usage(
  p_user_id uuid,
  p_feature text,
  p_provider text,
  p_model text,
  p_task_id text,
  p_est_cost_usd numeric,
  -- DEFAULT NULL: lời gọi 6 tham số (proxy bản cũ, hoặc proxy vừa bị rollback)
  -- vẫn phân giải được sang hàm này và rơi vào `organization_required` bên dưới,
  -- thay vì chết PGRST202. Xem "VÌ SAO `DEFAULT NULL`" ở đầu file.
  p_organization_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $fn$
DECLARE
  v_day date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  v_settings public.ai_copilot_settings%ROWTYPE;
  v_ent public.ai_copilot_entitlements%ROWTYPE;
  v_perms jsonb;
  v_owner uuid;
  v_sum numeric;
  v_id uuid;
  v_est numeric := GREATEST(COALESCE(p_est_cost_usd, 0), 0);
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'not_entitled'; END IF;
  IF p_feature NOT IN ('chat','ui_control') THEN RAISE EXCEPTION 'copilot_disabled'; END IF;

  -- (G0-B) a0. Công ty phải được NÓI, không được suy.
  -- Đứng trước mọi thứ khác, kể cả advisory lock: đây là phép kiểm rẻ nhất và
  -- một request thiếu org không đáng giữ khoá của cả ngày.
  -- Nhánh này SỐNG chứ không phải mã chết: tham số có `DEFAULT NULL` nên lời gọi
  -- 6 tham số đi tới được đây (thay vì bị chặn ở khâu phân giải hàm).
  IF p_organization_id IS NULL THEN RAISE EXCEPTION 'organization_required'; END IF;

  -- (G0-B) a1. …và phải là công ty người dùng được phép làm việc cho.
  -- Điều kiện chép theo `list_my_copilot_organizations_v1` (`20260814032500`):
  -- LEFT JOIN một lượt thay vì hai nhánh OR rời, để người vừa là super admin vừa
  -- có membership vẫn đi đúng một đường.
  IF NOT EXISTS (
    SELECT 1
      FROM public.organizations o
      LEFT JOIN public.organization_memberships m
             ON m.organization_id = o.id
            AND m.user_id = p_user_id
            AND m.status  = 'ACTIVE'
     WHERE o.id = p_organization_id
       AND o.status = 'ACTIVE'
       AND (
             m.user_id IS NOT NULL
             OR (EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = p_user_id)
                 AND NOT (o.id = ANY (public.sandbox_org_ids())))
           )
  ) THEN
    RAISE EXCEPTION 'organization_forbidden';
  END IF;

  -- Serialize mọi reservation trong ngày (VN) → cap user/tenant/global chính xác
  PERFORM pg_advisory_xact_lock(hashtext('ai_usage_reserve_' || v_day::text));

  -- a. Kill switch global
  SELECT * INTO v_settings FROM public.ai_copilot_settings WHERE id = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'copilot_disabled'; END IF;
  IF p_feature = 'chat' AND NOT v_settings.chat_enabled THEN RAISE EXCEPTION 'copilot_disabled'; END IF;
  IF p_feature = 'ui_control' AND NOT v_settings.ui_control_enabled THEN RAISE EXCEPTION 'copilot_disabled'; END IF;

  -- b. Entitlement opt-in (không có dòng = không được dùng)
  SELECT * INTO v_ent FROM public.ai_copilot_entitlements WHERE user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_entitled'; END IF;
  IF p_feature = 'chat' AND NOT v_ent.chat_enabled THEN RAISE EXCEPTION 'not_entitled'; END IF;
  IF p_feature = 'ui_control' AND NOT v_ent.ui_control_enabled THEN RAISE EXCEPTION 'not_entitled'; END IF;

  -- c. Permission (granular cho staff; owner sentinel pass — entitlement mới là gate thật)
  v_perms := public.ai_copilot_perms_for(p_user_id);
  IF NOT (v_perms ? '__superadmin') THEN
    IF p_feature = 'chat' AND COALESCE(v_perms->'ai_copilot'->>'view','') <> 'true' THEN
      RAISE EXCEPTION 'not_permitted';
    END IF;
    IF p_feature = 'ui_control' AND COALESCE(v_perms->'ai_copilot'->>'ui_control','') <> 'true' THEN
      RAISE EXCEPTION 'not_permitted';
    END IF;
  END IF;

  -- d. Mark expired: pending quá 5' → 'expired' (VẪN tính quota đến hết ngày)
  UPDATE public.ai_usage_logs SET status = 'expired'
  WHERE status = 'pending' AND created_at < now() - interval '5 minutes';

  -- e. Rate limit theo user (mọi request 60s gần nhất, kể cả lỗi)
  IF (SELECT count(*) FROM public.ai_usage_logs
      WHERE user_id = p_user_id AND created_at > now() - interval '60 seconds')
     >= v_settings.rate_per_min THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- f. Resolve owner (tenant): staff → owner đầu tiên (full-scope ưu tiên); owner → chính mình
  SELECT sa.user_id INTO v_owner
  FROM public.staff_assignments sa
  WHERE sa.staff_id = p_user_id AND sa.user_id <> p_user_id
  ORDER BY (sa.building_id IS NULL) DESC, sa.created_at ASC
  LIMIT 1;
  IF v_owner IS NULL THEN v_owner := p_user_id; END IF;

  -- g. Quota 3 cấp (ngày VN; cost = COALESCE(cost thật, reserved); pending+expired đều tính; so sánh >=)
  SELECT COALESCE(sum(COALESCE(cost_usd, reserved_cost_usd)), 0) INTO v_sum
  FROM public.ai_usage_logs
  WHERE user_id = p_user_id AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = v_day;
  IF v_sum + v_est >= v_settings.daily_usd_cap_user AND v_settings.daily_usd_cap_user > 0 THEN
    RAISE EXCEPTION 'daily_quota';
  END IF;

  SELECT COALESCE(sum(COALESCE(cost_usd, reserved_cost_usd)), 0) INTO v_sum
  FROM public.ai_usage_logs
  WHERE owner_id = v_owner AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = v_day;
  IF v_sum + v_est >= v_settings.daily_usd_cap_tenant AND v_settings.daily_usd_cap_tenant > 0 THEN
    RAISE EXCEPTION 'daily_quota';
  END IF;

  SELECT COALESCE(sum(COALESCE(cost_usd, reserved_cost_usd)), 0) INTO v_sum
  FROM public.ai_usage_logs
  WHERE (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = v_day;
  IF v_sum + v_est >= v_settings.daily_usd_cap_global AND v_settings.daily_usd_cap_global > 0 THEN
    RAISE EXCEPTION 'daily_quota';
  END IF;

  -- h. Insert pending reservation
  -- (G0-B) `organization_id` nêu TƯỜNG MINH: trigger trg_autofill_org_strict
  -- thấy cột đã có giá trị thì return ngay, nên không còn chỗ nào đoán nữa.
  INSERT INTO public.ai_usage_logs
    (user_id, owner_id, organization_id, provider, model, feature, task_id, reserved_cost_usd, status)
  VALUES
    (p_user_id, v_owner, p_organization_id, p_provider, p_model, p_feature, p_task_id, v_est, 'pending')
  RETURNING id INTO v_id;

  RETURN v_id;
END $fn$;

COMMENT ON FUNCTION public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid) IS
  'Giữ chỗ một lượt gọi AI: kill switch → entitlement → permission → rate → quota 3 cấp → dòng '
  'pending trong ai_usage_logs. Từ G0-B nhận p_organization_id (công ty người dùng đang chọn trên '
  'giao diện). Tham số khai DEFAULT NULL để lời gọi 6 tham số của proxy bản cũ vẫn phân giải được '
  '(không PGRST202) nhưng vẫn BẮT BUỘC về nghiệp vụ: organization_required nếu NULL/thiếu, '
  'organization_forbidden nếu người dùng '
  'không có membership ACTIVE trên org ACTIVE đó và cũng không phải super admin ngoài org sandbox. '
  'Chỉ service_role gọi được; llm-proxy map các mã lỗi này sang HTTP status.';

-- DROP đã xoá sạch ACL cũ, nên REVOKE/GRANT ở đây là bắt buộc chứ không phải
-- nhắc lại. Án lệ: REVOKE ... FROM PUBLIC KHÔNG cắt `anon` trên Supabase — phải
-- gọi tên từng vai.
REVOKE ALL ON FUNCTION public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog, nên chạy được trên database rỗng vừa dựng từ
-- baseline. KHÔNG gọi thử hàm: mỗi lượt gọi thành công là một dòng `pending`
-- trong sổ chi phí và một suất hạn mức ngày bị giữ 5 phút.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
BEGIN
  -- (1) Chữ ký MỚI phải tồn tại.
  IF to_regprocedure('public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)') IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_usage 7 tham so khong ton tai. DUNG.';
  END IF;

  -- (2) Chữ ký CŨ phải biến mất khỏi catalog — còn một HÀM 6 tham số riêng là
  --     còn đường INSERT thiếu organization_id.
  --     `to_regprocedure` tra khớp ĐÚNG số tham số và không xét DEFAULT, nên
  --     phép kiểm này vẫn đúng sau khi tham số cuối nhận DEFAULT NULL: catalog
  --     chỉ còn một hàm 7 tham số, dù LỜI GỌI 6 tham số vẫn phân giải sang nó
  --     (và rơi vào organization_required) — đó là chủ ý, xem đầu file.
  IF to_regprocedure('public.reserve_ai_usage(uuid, text, text, text, text, numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'Chu ky 6 tham so van con — overload nay van ghi thieu organization_id. DUNG.';
  END IF;

  -- (3) anon/authenticated KHÔNG được gọi: trình duyệt giữ hạn mức trực tiếp là
  --     tự cấp cho mình quyền tiêu tiền của công ty.
  IF has_function_privilege('anon', 'public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon van goi duoc reserve_ai_usage. DUNG.';
  END IF;
  IF has_function_privilege('authenticated', 'public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated van goi duoc reserve_ai_usage. DUNG.';
  END IF;

  -- (4) service_role PHẢI gọi được — mất quyền này là Copilot chết hoàn toàn.
  IF NOT has_function_privilege('service_role', 'public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role mat quyen goi reserve_ai_usage. DUNG.';
  END IF;

  RAISE NOTICE 'Nghiem thu dat: chu ky 7 tham so co, chu ky 6 tham so da bo, ACL dung vai.';
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK (lưu ý: quay lại là mở lại đường ghi thiếu organization_id):
--   DROP FUNCTION IF EXISTS public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid);
--   -- rồi CREATE OR REPLACE lại bản 6 tham số theo 20260710200000:205-306,
--   -- kèm REVOKE/GRANT cho chữ ký đó.
--   -- Ghi chú: rollback RIÊNG llm-proxy về bản 6 tham số thì KHÔNG cần chạm
--   -- database — nhờ `DEFAULT NULL`, lời gọi 6 tham số vẫn phân giải sang hàm
--   -- này và trả organization_required (400), không phải PGRST202 (404).
-- =============================================================================
