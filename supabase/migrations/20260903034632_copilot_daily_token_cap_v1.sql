-- =============================================================================
-- Hạn mức Copilot phải đo bằng thứ CÓ THẬT: token, không phải USD
--
-- LỖ ĐANG VÁ
--   `ai_copilot_settings` có ba cap USD (`daily_usd_cap_user` 2, `_tenant` 10,
--   `_global` 30 — `20260710200000:21-30`). Cả ba đo `sum(COALESCE(cost_usd,
--   reserved_cost_usd))`. Nhưng hai provider đang BẬT đều báo giá 0:
--     · OpenRouter chạy model đuôi `:free`, `input_price = output_price = 0`
--       (`pricing_mode = 'free'`, `20260710200000:349-351` + `20260829080000`);
--     · 9Router là `self_hosted` và `20260829080000` ép thẳng cả hai giá về 0.
--   Nhân bao nhiêu token với 0 vẫn ra 0, nên `v_sum + v_est >= cap` KHÔNG BAO
--   GIỜ đúng. Ba cap USD là ba hàng rào bằng giấy: chúng tồn tại trong bảng, hiện
--   trên màn hình quản trị, và không chặn được một lượt gọi nào.
--
--   Rào duy nhất còn thật là `rate_per_min` (20). Nó đo SỐ LƯỢT trong 60 giây,
--   không đo KHỐI LƯỢNG: 20 lượt/phút, mỗi lượt 100k token đầu vào, chạy suốt
--   ngày — hợp lệ theo mọi hàng rào hiện có.
--
-- VÌ SAO ĐO TOKEN
--   Token là đơn vị mà mọi provider đều đếm, kể cả khi họ không tính tiền: hạn
--   mức free của OpenRouter tính theo request/token, còn 9Router self-host thì
--   trần thật là thời gian máy — cũng tỉ lệ với token. Giá có thể bằng 0; khối
--   lượng thì không bao giờ.
--
-- ĐIỀU NÀY KHÔNG PHỦ — ghi ra để không ai tin quá lời
--   `ai_usage_logs.total_tokens` chỉ có giá trị SAU khi `finalize_ai_usage` ghi
--   xuống. Dòng `pending` đang bay có total_tokens = 0, nên cửa này KHÔNG chặn
--   được một burst đồng thời trong cùng một khoảnh khắc — việc đó là của
--   `rate_per_min`. Cửa token chặn thứ khác: dòng chảy tích luỹ suốt cả ngày.
--   Hai rào đo hai chuyện, và cần cả hai.
--
--   Cap USD giữ NGUYÊN, không gỡ. Ngày nào bật một provider có giá thật thì
--   chúng sống lại đúng lúc, không phải viết lại.
--
-- VÌ SAO `CREATE OR REPLACE` Ở ĐÂY LÀ ĐÚNG (khác `20260902132418`)
--   Migration đó THÊM một tham số, tức một chữ ký KHÁC — `CREATE OR REPLACE` khi
--   đó chỉ đẻ thêm overload nên nó buộc phải DROP trước. Ở đây chữ ký GIỮ NGUYÊN
--   đúng 7 tham số: không overload nào sinh ra, và `CREATE OR REPLACE` giữ luôn
--   ACL (không có khoảnh khắc nào hàm tồn tại mà service_role chưa được GRANT
--   lại). REVOKE/GRANT bên dưới vẫn viết đủ, vì file này còn phải chạy được trên
--   database dựng lại từ baseline + forward lane.
--
-- SLUG OPENROUTER ĐÃ CHẾT
--   `qwen/qwen3-next-80b-a3b-instruct:free` trả 404 "unavailable for free" (đo
--   03/09/2026). Để trong danh sách là mời người dùng chọn một model chắc chắn
--   hỏng, rồi đọc lỗi upstream mà không hiểu vì sao. `default_model` của
--   openrouter đang là nemotron (đã tra sản xuất 03/09/2026) nên gỡ nó không
--   đụng gì; câu lệnh vẫn tự phòng cho database mà ai đó đã đổi default_model
--   bằng tay, vì trigger `validate_ai_provider_pricing_v1` sẽ RAISE
--   'default_model must match a model id'.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ── 1. Hai cột cap token ─────────────────────────────────────────────────────
-- 0 = TẮT hạn mức (cùng quy ước với ba cap USD: chỉ so sánh khi `cap > 0`).
-- Mặc định 300.000 token/user/ngày ≈ 20–30 cuộc trò chuyện dài, và
-- 1.500.000 token/tenant/ngày ≈ 5 người dùng hết suất — đủ rộng để không ai
-- chạm phải khi làm việc bình thường, đủ hẹp để một vòng lặp hỏng không chạy
-- được cả đêm.
-- `IF NOT EXISTS` để migration chạy lượt hai im lặng đi qua.
ALTER TABLE public.ai_copilot_settings
  ADD COLUMN IF NOT EXISTS daily_tokens_cap_user int NOT NULL DEFAULT 300000,
  ADD COLUMN IF NOT EXISTS daily_tokens_cap_tenant int NOT NULL DEFAULT 1500000;

COMMENT ON COLUMN public.ai_copilot_settings.daily_tokens_cap_user IS
  'Trần token/ngày (giờ VN) cho MỘT người dùng; 0 = tắt hạn mức. Đo sum(total_tokens) '
  'đã finalize, nên nó chặn dòng chảy tích luỹ chứ không chặn burst — burst là việc của rate_per_min.';
COMMENT ON COLUMN public.ai_copilot_settings.daily_tokens_cap_tenant IS
  'Trần token/ngày (giờ VN) cho MỘT tenant (đo theo owner_id như cap USD tenant); 0 = tắt hạn mức.';

-- ── 2. reserve_ai_usage: thêm cửa token, chữ ký KHÔNG ĐỔI ────────────────────
-- Thân hàm chép nguyên từ `20260902132418`; phần THÊM chỉ có hai chỗ, đánh dấu
-- bằng "(G1-F)". Mọi gate cũ giữ nguyên thứ tự: org → kill switch → entitlement
-- → permission → rate → quota USD → (mới) quota token → INSERT.
CREATE OR REPLACE FUNCTION public.reserve_ai_usage(
  p_user_id uuid,
  p_feature text,
  p_provider text,
  p_model text,
  p_task_id text,
  p_est_cost_usd numeric,
  -- DEFAULT NULL: lời gọi 6 tham số (proxy bản cũ, hoặc proxy vừa bị rollback)
  -- vẫn phân giải được sang hàm này và rơi vào `organization_required` bên dưới,
  -- thay vì chết PGRST202. Xem `20260902132418`.
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
  v_tokens bigint;   -- (G1-F) sum(int) trả bigint; numeric ở đây là sai kiểu
  v_id uuid;
  v_est numeric := GREATEST(COALESCE(p_est_cost_usd, 0), 0);
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'not_entitled'; END IF;
  IF p_feature NOT IN ('chat','ui_control') THEN RAISE EXCEPTION 'copilot_disabled'; END IF;

  -- a0. Công ty phải được NÓI, không được suy.
  IF p_organization_id IS NULL THEN RAISE EXCEPTION 'organization_required'; END IF;

  -- a1. …và phải là công ty người dùng được phép làm việc cho.
  -- Điều kiện chép theo `list_my_copilot_organizations_v1` (`20260814032500`).
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

  -- (G1-F) g2. Quota TOKEN/ngày — hàng rào duy nhất còn cắn khi giá bằng 0.
  -- Cùng biên ngày `v_day` với ba cap USD ở trên: hai cách tính "hôm nay" trong
  -- một hàm là hai sự thật, và người dùng sẽ gặp cái khắt khe hơn mà không hiểu.
  -- Mã lỗi RIÊNG (`daily_token_quota`, không gộp vào `daily_quota`): người đọc
  -- cần biết đã chạm trần TOKEN — nói "hết hạn mức USD" khi tiêu 0 đồng là nói
  -- sai, và quản trị sẽ đi nới nhầm cột.
  SELECT COALESCE(sum(total_tokens), 0) INTO v_tokens
  FROM public.ai_usage_logs
  WHERE user_id = p_user_id AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = v_day;
  IF v_settings.daily_tokens_cap_user > 0 AND v_tokens >= v_settings.daily_tokens_cap_user THEN
    RAISE EXCEPTION 'daily_token_quota';
  END IF;

  SELECT COALESCE(sum(total_tokens), 0) INTO v_tokens
  FROM public.ai_usage_logs
  WHERE owner_id = v_owner AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = v_day;
  IF v_settings.daily_tokens_cap_tenant > 0 AND v_tokens >= v_settings.daily_tokens_cap_tenant THEN
    RAISE EXCEPTION 'daily_token_quota';
  END IF;

  -- h. Insert pending reservation
  -- `organization_id` nêu TƯỜNG MINH: trigger trg_autofill_org_strict thấy cột
  -- đã có giá trị thì return ngay, nên không còn chỗ nào đoán nữa.
  INSERT INTO public.ai_usage_logs
    (user_id, owner_id, organization_id, provider, model, feature, task_id, reserved_cost_usd, status)
  VALUES
    (p_user_id, v_owner, p_organization_id, p_provider, p_model, p_feature, p_task_id, v_est, 'pending')
  RETURNING id INTO v_id;

  RETURN v_id;
END $fn$;

COMMENT ON FUNCTION public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid) IS
  'Giữ chỗ một lượt gọi AI: kill switch → entitlement → permission → rate → quota USD 3 cấp → '
  'quota TOKEN 2 cấp (G1-F: cap USD không cắn khi provider báo giá 0) → dòng pending trong '
  'ai_usage_logs. Nhận p_organization_id (công ty người dùng đang chọn trên giao diện); '
  'DEFAULT NULL chỉ để lời gọi 6 tham số của proxy bản cũ vẫn phân giải được, nghiệp vụ vẫn '
  'BẮT BUỘC: organization_required nếu NULL, organization_forbidden nếu không có membership '
  'ACTIVE trên org ACTIVE đó và cũng không phải super admin ngoài org sandbox. Chỉ service_role '
  'gọi được; llm-proxy map các mã lỗi này sang HTTP status.';

-- `CREATE OR REPLACE` giữ nguyên ACL cũ, nên hai dòng dưới là để file TỰ ĐỨNG
-- VỮNG khi replay lên database dựng từ baseline. Án lệ: REVOKE ... FROM PUBLIC
-- KHÔNG cắt `anon` trên Supabase — phải gọi tên từng vai.
REVOKE ALL ON FUNCTION public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid) TO service_role;

-- ── 3. Gỡ slug OpenRouter đã chết ────────────────────────────────────────────
-- Lọc theo `model->>'id'` chứ KHÔNG trừ nguyên phần tử jsonb (`models - '{…}'`):
-- phép trừ đó buộc vào ĐÚNG hình dạng phần tử hôm nay, mà `20260829080000` vừa
-- nhét thêm khoá `pricing_mode` vào từng phần tử — lần thêm khoá tiếp theo sẽ
-- làm nó lặng lẽ không khớp gì cả, và không ai biết.
-- Dựng lại mảng bằng `jsonb_agg` các phần tử NGUYÊN VẸN (giữ thứ tự bằng
-- ORDINALITY) nên mọi khoá của model còn lại đi qua y nguyên — điều kiện để
-- trigger `validate_ai_provider_pricing_v1` (`20260829080000`) không RAISE.
-- Mệnh đề EXISTS làm lượt hai không đụng gì (và không đánh thức trigger).
UPDATE public.ai_providers
   SET models = COALESCE((
         SELECT jsonb_agg(item.model ORDER BY item.ord)
           FROM jsonb_array_elements(public.ai_providers.models) WITH ORDINALITY AS item(model, ord)
          WHERE item.model->>'id' IS DISTINCT FROM 'qwen/qwen3-next-80b-a3b-instruct:free'
       ), '[]'::jsonb),
       -- Tự phòng: nếu database nào đó đã trỏ default_model vào slug vừa gỡ thì
       -- trigger RAISE 'default_model must match a model id' và cả migration
       -- cuộn lại. Trên sản xuất giá trị đang là nemotron (tra 03/09/2026), nên
       -- nhánh CASE này là lưới an toàn chứ không phải thay đổi cấu hình.
       default_model = CASE
         WHEN default_model = 'qwen/qwen3-next-80b-a3b-instruct:free'
           THEN 'nvidia/nemotron-3-super-120b-a12b:free'
         ELSE default_model
       END
 WHERE provider = 'openrouter'
   AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(public.ai_providers.models) AS item(model)
          WHERE item.model->>'id' = 'qwen/qwen3-next-80b-a3b-instruct:free'
       );

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog, nên chạy được trên database rỗng vừa dựng từ
-- baseline. KHÔNG gọi thử hàm: mỗi lượt gọi thành công là một dòng `pending`
-- trong sổ chi phí và một suất hạn mức ngày bị giữ 5 phút.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
BEGIN
  -- (1) Hai cột cap token phải có mặt, đúng kiểu, NOT NULL.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ai_copilot_settings'
       AND column_name = 'daily_tokens_cap_user' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Thieu cot daily_tokens_cap_user (NOT NULL). DUNG.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ai_copilot_settings'
       AND column_name = 'daily_tokens_cap_tenant' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Thieu cot daily_tokens_cap_tenant (NOT NULL). DUNG.';
  END IF;

  -- (2) Chữ ký 7 tham số còn nguyên…
  IF to_regprocedure('public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)') IS NULL THEN
    RAISE EXCEPTION 'reserve_ai_usage 7 tham so khong ton tai. DUNG.';
  END IF;
  -- (3) …và KHÔNG mọc lại bản 6 tham số. Một overload ở đây là một đường ghi
  --     thiếu organization_id sống lại (án lệ `20260902132418`).
  IF to_regprocedure('public.reserve_ai_usage(uuid, text, text, text, text, numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'Chu ky 6 tham so quay lai — overload nay ghi thieu organization_id. DUNG.';
  END IF;

  -- (4) Thân hàm phải THẬT SỰ có cửa token — đọc prosrc, không tin vào việc file
  --     đã chạy. `CREATE OR REPLACE` im lặng khi bị một migration sau ghi đè.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'reserve_ai_usage'
       AND p.prosrc LIKE '%daily_token_quota%'
  ) THEN
    RAISE EXCEPTION 'reserve_ai_usage khong con cua token (daily_token_quota). DUNG.';
  END IF;

  -- (5) anon/authenticated KHÔNG được gọi; service_role PHẢI gọi được.
  IF has_function_privilege('anon', 'public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon van goi duoc reserve_ai_usage. DUNG.';
  END IF;
  IF has_function_privilege('authenticated', 'public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated van goi duoc reserve_ai_usage. DUNG.';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reserve_ai_usage(uuid, text, text, text, text, numeric, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role mat quyen goi reserve_ai_usage. DUNG.';
  END IF;

  -- (6) Slug chết không còn trong danh sách model của openrouter.
  --     Dùng EXISTS trên bảng: database rỗng không có dòng nào thì im lặng qua.
  IF EXISTS (
    SELECT 1
      FROM public.ai_providers p,
           LATERAL jsonb_array_elements(p.models) AS item(model)
     WHERE p.provider = 'openrouter'
       AND item.model->>'id' = 'qwen/qwen3-next-80b-a3b-instruct:free'
  ) THEN
    RAISE EXCEPTION 'Slug qwen free da chet van con trong ai_providers.openrouter. DUNG.';
  END IF;

  RAISE NOTICE 'Nghiem thu dat: 2 cot cap token, cua daily_token_quota, ACL dung vai, slug chet da go.';
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK (quay lại là bỏ hàng rào khối lượng duy nhất đang cắn):
--   BEGIN;
--   -- 1. CREATE OR REPLACE lại reserve_ai_usage theo `20260902132418` (bỏ khối
--   --    (G1-F) g2), rồi REVOKE/GRANT cho chữ ký 7 tham số.
--   -- 2. ALTER TABLE public.ai_copilot_settings
--   --      DROP COLUMN IF EXISTS daily_tokens_cap_user,
--   --      DROP COLUMN IF EXISTS daily_tokens_cap_tenant;
--   --    (Bỏ cột TRƯỚC khi thay hàm sẽ làm hàm cũ nổ giữa chừng — thay hàm trước.)
--   -- 3. Slug qwen free KHÔNG khôi phục: nó trả 404 thật, thêm lại là mời người
--   --    dùng chọn một model chắc chắn hỏng.
--   COMMIT;
-- Nới hạn mức KHÔNG cần rollback: UPDATE public.ai_copilot_settings
--   SET daily_tokens_cap_user = 0, daily_tokens_cap_tenant = 0 WHERE id = true;
-- =============================================================================
