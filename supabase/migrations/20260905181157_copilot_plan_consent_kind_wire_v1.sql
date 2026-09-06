-- =============================================================================
-- copilot_plan_consent_kind_wire_v1 — hàng ghi đúng, sổ đúng, VỎ TRẢ VỀ im lặng
-- Ngày 05/09/2026 · ca 6 (PIN + duyệt + chạy bước L5) của ma trận L5 còn đỏ ở HAI dòng
-- =============================================================================
-- VẤN ĐỀ (a) — `consent_kind` không có trong bất kỳ vỏ trả về nào của `approve`
--   E2E thật (run 33981613157, bản dựng 80845f0a đang chạy production, Mức 3 BẬT)
--   làm ca 6 của `.e2e-fleet/specs/copilot-plan-l5-matrix.spec.ts:976` đỏ:
--
--     expect(d.consent_kind).toBe('step_up');
--       Expected: "step_up"
--       Received: undefined
--
--   Hai dòng ngay trên nó XANH (`plan_status = 'APPROVED'`, version +1), tức đường
--   PIN → duyệt đã chạy đúng. Đọc `pg_get_functiondef` của bản đang chạy:
--   `copilot_plan_approve_v1` tính `CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up'
--   ELSE 'click' END` ở BỐN chỗ — hai lần vào hàng `copilot_plans`, hai lần vào dòng
--   sổ — nhưng KHÔNG chỗ nào trong ba `RETURN jsonb_build_object(...)` dựng khoá
--   `consent_kind`. Cùng một lớp lỗi với `standing_grant_ids` đã vá ở 20260905133739:
--   sự thật có trong DB, chỉ đường dây ra ngoài bị hụt một khoá.
--
--   Cách vá KHÔNG phải là chép lại biểu thức CASE vào ba vỏ trả về — bốn bản sao đã đủ
--   để trôi, sáu bản thì chắc chắn trôi. Đưa về MỘT biến `v_consent_kind`, gán đúng một
--   lần cho mỗi nhánh ngay sau khi biết `v_step_up_id`, rồi cả hàng ghi, cả dòng sổ, cả
--   vỏ trả về đều đọc chính biến đó. Hàng = sổ = dây được bảo đảm bằng CẤU TRÚC, không
--   bằng sự cẩn thận của người sửa lần sau.
--
-- VẤN ĐỀ (b) — `after_digest` KHÔNG BAO GIỜ ra tới trình duyệt, và đó là chủ ý
--   Dòng kế tiếp của ca 6 (`:994`) đòi `expect(step?.after_digest).toMatch(/^[0-9a-f]{64}$/)`.
--   Yêu cầu này KHÔNG THỂ thoả với thiết kế hiện hành, và không phải vì thiếu sót:
--   `public.copilot_plan_get_v1` và `public.copilot_action_ledger_list_v1` — hai đường
--   đọc sổ duy nhất PostgREST với tới được — cùng lược đúng ba cột
--   `payload_digest`/`before_digest`/`after_digest`, kèm CÙNG một câu lý do
--   ("một hex 64 ký tự trong tay trình duyệt chỉ mời người ta thử đoán ngược").
--   `app_private` không nằm trong `exposed_schemas` nên bảng sổ cũng không đọc trực tiếp.
--   Một quyết định bảo mật được viết hai lần, giống nhau từng chữ, thì bài test phải đổi
--   — không phải hàng rào.
--
--   Nhưng ca 6 vẫn cần chứng minh một điều thật: bước L5 CÓ ghi digest sau-khi-ghi.
--   Chứng minh sự CÓ MẶT mà không tiết lộ GIÁ TRỊ: thêm ba cờ boolean
--   `has_payload_digest`/`has_before_digest`/`has_after_digest` vào bản đọc sổ của
--   `copilot_plan_get_v1`. Một chữ `true` không giúp đoán ngược bất cứ thứ gì.
--
-- PHẠM VI — hẹp đúng bằng chỗ hụt
--   * Hai hàm, cùng chữ ký cũ y nguyên → CREATE OR REPLACE, không DROP, không overload,
--     PostgREST không phải chọn giữa hai bản.
--   * `copilot_action_ledger_list_v1` KHÔNG đụng tới: đó là bản đọc sổ toàn tổ chức của
--     trang quản trị, không phải bản đọc một kế hoạch, và nó không có ca nào đang đòi.
--   * Ba digest thô vẫn KHÔNG ra ngoài ở cả hai đường — khối nghiệm thu dưới canh.
--   * Phát lại nguyên khối REVOKE cho cả hai hàm: CREATE OR REPLACE giữ ACL cũ, nhưng
--     phát lại là idempotent và giữ `check-definer-acl` xanh khi hàm được sinh lại trên
--     DB rỗng (Contract: hàm SECURITY DEFINER phải REVOKE anon + authenticated RIÊNG —
--     REVOKE FROM PUBLIC không cắt anon trên Supabase).
--   * Thân hai hàm dưới đây được sinh TỪ `pg_get_functiondef` của production (luật nhà:
--     chép writer thì lấy bản đang chạy, không lấy chữ trong file migration cũ), rồi
--     thay đúng những chỗ nêu trên.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- (a) copilot_plan_approve_v1 — MỘT biến `v_consent_kind`, ba vỏ trả về cùng đọc
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_plan_approve_v1(p_plan_id uuid, p_consent_nonce text, p_plan_digest text, p_expected_plan_version integer, p_step_up_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor      uuid := auth.uid();
  v_conf       app_private.copilot_write_confirmations%ROWTYPE;
  v_plan       app_private.copilot_plans%ROWTYPE;
  v_reg        app_private.copilot_action_registry%ROWTYPE;
  v_step       app_private.copilot_plan_steps%ROWTYPE;
  v_max_direct text;
  v_policy_rev bigint;
  v_ly_do      text := NULL;
  v_chi_tiet   text := NULL;
  v_buoc_hong  int := NULL;
  v_version    int;
  v_han        timestamptz;
  -- G5-A: hàng token step-up (nếu client trình) và id của nó sau khi tiêu.
  v_step_up    app_private.copilot_write_confirmations%ROWTYPE;
  v_step_up_id uuid := NULL;
  -- G5-E ca 6: MỘT biến cho loại đồng ý. Hàng `copilot_plans`, dòng sổ và vỏ trả về
  -- đều đọc chính biến này. Trước đợt này biểu thức CASE bị chép BỐN lần (hai vào
  -- hàng, hai vào sổ) còn ba vỏ trả về thì không có gì — nên client nhận `undefined`.
  v_consent_kind text := NULL;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Hình sai thì không cần chạm bảng nonce: một lời gọi không có nonce thật
  -- không được phép soi cả bảng đó.
  IF p_consent_nonce IS NULL OR p_consent_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;
  IF p_plan_digest IS NULL OR p_plan_digest !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;

  -- Khoá hàng nonce ngay từ đầu: hai lần bấm song song phải có đúng một lần thắng.
  SELECT * INTO v_conf
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(decode(p_consent_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  -- Nonce của người khác trả về cùng một câu với "không tìm thấy" — trả lời khác
  -- đi là xác nhận giúp kẻ gọi rằng nonce đó có thật.
  IF v_conf.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_conf.tool IS DISTINCT FROM 'lap_ke_hoach'
     OR v_conf.permission_key IS DISTINCT FROM 'copilot.execution_plan' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_conf.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    -- Hai tab. Không chờ: một trong hai đang ở giữa một chuỗi ghi tiền.
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.organization_id IS DISTINCT FROM v_conf.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;
  -- Ba vế phải trùng nhau: vân tay lưu trong kế hoạch, `payload_hash` của hàng
  -- nonce, và chuỗi giao diện echo lại. Lệch một vế nghĩa là thứ người dùng nhìn
  -- thấy không phải thứ sắp chạy.
  IF v_plan.plan_digest IS DISTINCT FROM decode(p_plan_digest, 'hex')
     OR v_conf.payload_hash IS DISTINCT FROM v_plan.plan_digest THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_plan.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'plan_not_draft: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;
  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = '40001';
  END IF;

  -- QUÁ HẠN. Ghi trạng thái rồi TRẢ VỀ, không RAISE — xem quyết định 4 ở đầu file.
  IF v_plan.expires_at <= clock_timestamp() THEN
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_expired'
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    UPDATE app_private.copilot_plans
       SET status = 'EXPIRED', version = version + 1,
           failure_reason = 'plan_expired', updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_expired',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'approve')));
    RETURN jsonb_build_object(
      'ok',               false,
      'error_code',       'plan_expired',
      'plan_id',          v_plan.id,
      'plan_version',     v_version,
      'plan_status',      'EXPIRED',
      'consent_kind',     v_plan.consent_kind,
      'execute_deadline', NULL);
  END IF;

  -- Đổi thứ tự: quá hạn của KẾ HOẠCH được kiểm TRƯỚC quá hạn của
  -- CONFIRMATION, để nhánh ghi-rồi-RETURN plan_expired phía trên với tới được.
  -- Trước đợt này cửa nonce (bên trên, cùng khối duyệt) luôn đứng trước cửa kế
  -- hoạch nên plan_expired là mã chết — vì thời điểm tạo gán CÙNG một hạn cho cả
  -- hai hàng. Xem G3-FIX brief mục 1 + task-G3-E2E-report.md §6.
  IF v_conf.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;

  SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
    FROM app_private.copilot_action_policy WHERE id;
  -- Thiếu hàng policy KHÔNG được rơi vào im lặng: `v_max_direct` NULL làm điều
  -- kiện step-up ngay dưới lặng lẽ sai, và phép so trần rủi ro trong vòng lặp
  -- cũng thành vô nghĩa. Van trần rủi ro mà biến mất thì đóng cửa, đừng đoán.
  IF v_max_direct IS NULL OR v_policy_rev IS NULL THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;

  -- ĐIỂM NỐI #3 — step-up PIN (G5-A). Kế hoạch L5 dưới trần L5 mà không có
  -- token → từ chối ngay, không chạm bảng token.
  IF v_plan.max_risk = 'L5' AND v_max_direct = 'L5' AND p_step_up_token IS NULL THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
  END IF;
  IF p_step_up_token IS NOT NULL THEN
    -- Hình sai thì không soi bảng — cùng kỷ luật với nonce cấp kế hoạch ở trên.
    IF p_step_up_token !~ '^[0-9a-fA-F]{64}$' THEN
      RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_step_up
      FROM app_private.copilot_write_confirmations c
     WHERE c.nonce_digest = extensions.digest(decode(p_step_up_token, 'hex'), 'sha256')
     FOR UPDATE;

    -- Mọi nhánh sai của token đều trả CÙNG một mã `step_up_required` — token
    -- của người khác, sai tool/permission_key, đã tiêu, hết hạn, hay lệch tổ
    -- chức đều là "chưa xác thực hợp lệ" dưới góc nhìn của người gọi; phân biệt
    -- ra sẽ xác nhận giúp kẻ tấn công token nào "gần đúng".
    IF NOT FOUND
       OR v_step_up.user_id IS DISTINCT FROM v_actor
       OR v_step_up.tool IS DISTINCT FROM 'step_up'
       OR v_step_up.permission_key IS DISTINCT FROM 'copilot.step_up'
       OR v_step_up.consumed_at IS NOT NULL
       OR v_step_up.expires_at <= clock_timestamp()
       OR v_step_up.organization_id IS DISTINCT FROM v_plan.organization_id
       OR v_step_up.payload_hash IS DISTINCT FROM app_private.copilot_payload_hash_v1(
            jsonb_build_object('org', v_plan.organization_id)) THEN
      RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
    END IF;

    -- Fix round 1 (F3): KHONG tieu token o day nua. Tieu no cung mot diem
    -- voi nonce cap ke hoach (nhanh that bai / nhanh thanh cong ben duoi),
    -- de mot lan RAISE cua kill-switch/policy-missing GIUA cho nay va do
    -- khong dot mat token ma khong duyet duoc gi (bug that: ban truoc tieu
    -- token o day, truoc ca kill-switch, nen mot RAISE ngay sau van thieu
    -- token du no chua bao gio thuc su chay).
  END IF;

  -- Công tắc của cả cơ chế, hỏi LẠI. Tắt giữa lúc lập và lúc bấm là chuyện thật
  -- (đó chính là ý nghĩa của một kill switch), và ở đây chưa có gì để ghi lại
  -- nên NÉM là câu trả lời đúng: kế hoạch ở nguyên DRAFT rồi tự hết hạn.
  IF NOT app_private.copilot_action_flag_allows_v1(
           'copilot.execution_plan', v_plan.organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  -- POLICY ĐƯỢC ÉP LẠI Ở ĐÂY, KHÔNG CHỈ Ở LÚC LẬP.
  --
  --   `copilot_action_gate_v1` KHÔNG biết gì về trần rủi ro hay danh sách vai:
  --   nó đo registry + cờ + cấm khẩn cấp + phạm vi quyền. Nghĩa là nếu policy
  --   chỉ được ép ở `create`, thì một lần hạ trần L4 → L3 (hoặc bỏ `owner` khỏi
  --   `allowed_roles`) ở phút thứ 2 KHÔNG chạm được vào một kế hoạch lập ở phút
  --   0: nó vẫn duyệt được ở phút 3 và chạy tới phút 35. Van mà không có tác
  --   dụng lên thứ đang chờ chạy thì nó không phải van.
  --
  --   Ba vế, và cả ba đi cùng một mã `policy_changed` vì với người bấm chúng là
  --   một chuyện: luật đã đổi kể từ lúc kế hoạch này được lập.
  IF v_policy_rev IS DISTINCT FROM v_plan.policy_revision THEN
    v_ly_do := 'policy_changed';
  ELSIF NOT app_private.copilot_plan_role_allowed_v1(v_plan.organization_id) THEN
    v_ly_do := 'policy_changed';
  END IF;

  -- KIỂM LẠI TOÀN BỘ BƯỚC NGAY TRƯỚC KHI DUYỆT. Giữa lúc lập và lúc bấm có tới 5
  -- phút: đủ để ai đó thu quyền, tắt một action, hoặc kéo cầu dao khẩn cấp.
  FOR v_step IN
    SELECT * FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id ORDER BY step_no
  LOOP
    -- Vế policy ở trên đã chốt lý do thì bước ĐẦU TIÊN mang nó — không chạy tiếp
    -- vòng lặp để một mã lỗi khác đè lên.
    IF v_ly_do IS NOT NULL THEN
      v_buoc_hong := v_step.step_no;
      EXIT;
    END IF;
    BEGIN
      SELECT * INTO v_reg
        FROM app_private.copilot_action_registry
       WHERE action_id = v_step.action_id;
      IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
        v_ly_do := 'registry_changed';
      -- Trần rủi ro, đo LẠI theo policy của lúc BẤM. Miễn trừ vẫn theo đúng một
      -- `executor_kind` như ở `create`, không theo mức rủi ro.
      ELSIF v_reg.executor_kind <> 'maker_submit_v1'
            AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
              > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
        v_ly_do := 'policy_changed';
      ELSE
        PERFORM app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);
      END IF;
    EXCEPTION WHEN others THEN
      -- Giữ nguyên mã lỗi THẬT của cửa đã chặn (`copilot_action_disabled`,
      -- `tenant_emergency_denied`, `not_permitted`…). Ép tất cả về một chữ
      -- `step_not_permitted` sẽ làm người trực sự cố đi sửa phân quyền cho một
      -- lệnh cấm khẩn cấp — cùng lớp lỗi mà thứ tự bốn cửa của G2-A đã sửa.
      GET STACKED DIAGNOSTICS v_chi_tiet = MESSAGE_TEXT;
      v_ly_do := COALESCE(NULLIF(split_part(v_chi_tiet, ':', 1), ''), 'step_not_permitted');
    END;
    IF v_ly_do IS NOT NULL THEN
      v_buoc_hong := v_step.step_no;
      EXIT;
    END IF;
  END LOOP;

  IF v_ly_do IS NOT NULL THEN
    -- NONCE VẪN BỊ TIÊU. Người dùng đã bấm; phiếu đồng ý đó đã được dùng, và
    -- việc kế hoạch không chạy được là câu trả lời chứ không phải một lần bấm
    -- hỏng. Để nonce sống tiếp là mở đường thử lại tới khi lọt.
    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_conf.id AND consumed_at IS NULL;

    -- Fix round 1 (F3): token step-up (neu co) tieu CUNG luc voi nonce --
    -- xem chu thich day du o nhanh thanh cong ben duoi.
    IF v_step_up.id IS NOT NULL THEN
      UPDATE app_private.copilot_write_confirmations
         SET consumed_at = clock_timestamp()
       WHERE id = v_step_up.id AND consumed_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
      END IF;
      v_step_up_id := v_step_up.id;
    END IF;
    v_consent_kind := CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END;
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED',
           error_code = CASE WHEN step_no = v_buoc_hong THEN v_ly_do ELSE 'plan_failed' END
     WHERE plan_id = v_plan.id AND status = 'PENDING';

    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           consent_confirmation_id = v_conf.id,
           consent_kind = v_consent_kind,
           step_up_confirmation_id = v_step_up_id,
           -- Cùng khuôn với `execute_step`: <sự kiện sổ>:<bước>:<mã lỗi thật>.
           -- Mã lỗi thật là `policy_changed`, `registry_changed`,
           -- `copilot_action_disabled`, `tenant_emergency_denied`,
           -- `not_permitted`… — xem khối EXCEPTION ở vòng lặp trên.
           failure_reason = 'step_blocked:' || v_buoc_hong::text || ':' || v_ly_do,
           updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;

    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'step_blocked',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         v_buoc_hong,
      'plan_version',    v_version,
      'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                           WHERE plan_id = v_plan.id AND step_no = v_buoc_hong),
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_conf.id,
      'consent_kind',    v_consent_kind,
      'step_up_id',      v_step_up_id,
      'error_code',      v_ly_do,
      'outcome',         jsonb_build_object('giai_doan', 'approve', 'plan_status', 'FAILED')));

    RETURN jsonb_build_object(
      'ok',               false,
      'error_code',       v_ly_do,
      'plan_id',          v_plan.id,
      'plan_version',     v_version,
      'plan_status',      'FAILED',
      'consent_kind',     v_consent_kind,
      'execute_deadline', NULL,
      'step_no',          v_buoc_hong);
  END IF;

  -- CAS TIÊU NONCE. `consumed_at IS NULL` trong WHERE là thứ biến hai lần bấm
  -- song song thành một lần duyệt.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_conf.id AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  -- Fix round 1 (F3): TIEU token step-up O DAY -- CUNG mot diem voi nonce
  -- cap ke hoach (ngay tren). Truoc do token chi duoc VALIDATE (SELECT ...
  -- FOR UPDATE + 7 dieu kien OR), khong bi tieu -- neu khong, mot lan RAISE
  -- kill-switch/policy-missing O TREN diem nay se dot token ma khong duyet
  -- duoc gi (nguoi dung phai xac thuc PIN lai tu dau de lay token moi, dung
  -- luc nonce cap ke hoach VAN CON SONG vi no cung khong bi tieu som).
  IF v_step_up.id IS NOT NULL THEN
    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_step_up.id AND consumed_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
    END IF;
    v_step_up_id := v_step_up.id;
  END IF;
  v_consent_kind := CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END;
  v_han := clock_timestamp() + interval '30 minutes';
  UPDATE app_private.copilot_plans
     SET status = 'APPROVED',
         approved_at = clock_timestamp(),
         execute_deadline = v_han,
         consent_confirmation_id = v_conf.id,
         consent_kind = v_consent_kind,
         step_up_confirmation_id = v_step_up_id,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE id = v_plan.id AND version = p_expected_plan_version
  RETURNING version INTO v_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
  END IF;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_approved',
    'organization_id', v_plan.organization_id,
    'plan_id',         v_plan.id,
    'plan_version',    v_version,
    'permission_key',  'copilot.execution_plan',
    'permission_snapshot', jsonb_build_object(
      'registry_revision', v_plan.registry_revision,
      'policy_revision',   v_policy_rev,
      'max_direct_risk',   v_max_direct,
      'plan_max_risk',     v_plan.max_risk,
      'step_count',        v_plan.step_count,
      'is_super_admin',    public.is_super_admin(),
      'checked_at',        clock_timestamp()),
    'consent_id',      v_conf.id,
    'consent_kind',    v_consent_kind,
    'step_up_id',      v_step_up_id,
    'payload_digest',  encode(v_plan.plan_digest, 'hex'),
    'outcome', jsonb_build_object('plan_status', 'APPROVED', 'execute_deadline', v_han)));

  RETURN jsonb_build_object(
    'ok',               true,
    'error_code',       NULL,
    'plan_id',          v_plan.id,
    'plan_version',     v_version,
    'plan_status',      'APPROVED',
    'consent_kind',     v_consent_kind,
    'execute_deadline', v_han);
END
$function$;

COMMENT ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) IS
  'Duyet ke hoach thuc thi: tieu nonce cap ke hoach, kiem lai policy/registry/quyen NGAY LUC BAM, va '
  'tu G5-A xac thuc + tieu token step-up that cho ke hoach L5 duoi tran L5. Ghi-roi-RETURN cho ba nhanh '
  'phai de lai bang chung (het han, mat quyen luc duyet, buoc hong luc chay); moi nhanh khac RAISE. '
  'Tu 05/09/2026 ca ba vo tra ve deu mang consent_kind, doc tu MOT bien v_consent_kind ma hang '
  'copilot_plans va dong so cung doc — hang = so = day, bao dam bang cau truc.';

REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM PUBLIC;
DO $thu_hoi_approve$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_approve_v1(uuid, text, text, integer, text) TO authenticated;
  END IF;
END
$thu_hoi_approve$;

-- ---------------------------------------------------------------------------
-- (b) copilot_plan_get_v1 — ba digest vẫn KHÔNG ra ngoài, chỉ thêm cờ CÓ/KHÔNG
-- ---------------------------------------------------------------------------
--
-- Ba cột `payload_digest`/`before_digest`/`after_digest` vẫn bị trừ khỏi `to_jsonb(t)`
-- y như cũ. Thứ thêm vào là ba boolean nói SỰ CÓ MẶT của chúng. Vì sao đủ và vì sao an
-- toàn: người duyệt (và bài test) cần biết "bước này CÓ ghi digest sau-khi-ghi hay
-- không" để phát hiện một bước chạy mà không để lại dấu; giá trị hex thì không ai cần
-- ở trình duyệt, và để lộ nó là mời người ta thử đoán ngược. `true` không đoán được gì.
CREATE OR REPLACE FUNCTION public.copilot_plan_get_v1(p_plan_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_plan  app_private.copilot_plans%ROWTYPE;
  v_so    jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_plan FROM app_private.copilot_plans WHERE id = p_plan_id;
  -- Kế hoạch của người khác trả về ĐÚNG câu như kế hoạch không tồn tại.
  IF NOT FOUND
     OR (v_plan.user_id IS DISTINCT FROM v_actor AND NOT public.is_super_admin()) THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 20 dòng sổ gần nhất, VẪN bỏ ba cột digest. Chúng là bằng chứng nội bộ để đối
  -- chiếu payload; một chuỗi hex 64 ký tự trong tay trình duyệt chỉ mời người ta
  -- thử đoán ngược. Thay vào đó là ba cờ nói SỰ CÓ MẶT: người duyệt (và bài test
  -- ma trận L5) cần biết một bước có để lại digest hay không — `true` thì không
  -- đoán ngược được gì.
  SELECT COALESCE(jsonb_agg(
           (to_jsonb(t) - 'payload_digest' - 'before_digest' - 'after_digest')
           || jsonb_build_object(
                'has_payload_digest', t.payload_digest IS NOT NULL,
                'has_before_digest',  t.before_digest  IS NOT NULL,
                'has_after_digest',   t.after_digest   IS NOT NULL)), '[]'::jsonb)
    INTO v_so
    FROM (
      SELECT l.*
        FROM app_private.copilot_action_ledger l
       WHERE l.plan_id = p_plan_id
       ORDER BY l.created_at DESC
       LIMIT 20
    ) t;

  RETURN app_private.copilot_plan_summary_v1(p_plan_id)
         || jsonb_build_object('ok', true, 'error_code', NULL, 'ledger', v_so);
END
$function$;

COMMENT ON FUNCTION public.copilot_plan_get_v1(uuid) IS
  'Doc trang thai that cua mot ke hoach (chu ke hoach hoac super admin) kem 20 dong so gan nhat. '
  'Khong tra nonce, canonical, payload hay digest tho. Tu 05/09/2026 moi dong so kem ba co '
  'has_payload_digest/has_before_digest/has_after_digest — noi SU CO MAT cua digest ma khong noi '
  'gia tri. Client mat ket noi thi goi ham nay, khong doan.';

REVOKE ALL ON FUNCTION public.copilot_plan_get_v1(uuid) FROM PUBLIC;
DO $thu_hoi_doc$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_get_v1(uuid) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_get_v1(uuid) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_get_v1(uuid) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_get_v1(uuid) TO authenticated;
  END IF;
END
$thu_hoi_doc$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog nên chạy được cả trên DB rỗng của Restore Drill
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_duyet text;
  v_doc   text;
  v_acl   text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_duyet
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'copilot_plan_approve_v1'
     AND pg_get_function_identity_arguments(p.oid)
         = 'p_plan_id uuid, p_consent_nonce text, p_plan_digest text, p_expected_plan_version integer, p_step_up_token text';
  IF v_duyet IS NULL THEN
    RAISE EXCEPTION 'nghiem_thu: khong thay public.copilot_plan_approve_v1 dung chu ky 5 tham so';
  END IF;

  SELECT pg_get_functiondef(p.oid), p.proacl::text INTO v_doc, v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'copilot_plan_get_v1'
     AND pg_get_function_identity_arguments(p.oid) = 'p_plan_id uuid';
  IF v_doc IS NULL THEN
    RAISE EXCEPTION 'nghiem_thu: khong thay public.copilot_plan_get_v1(p_plan_id uuid)';
  END IF;

  -- 1) (a) MỘT biến, và biểu thức CASE CHỈ còn sống trong phép gán biến đó.
  --    Hai lần là đúng: một cho nhánh FAILED, một cho nhánh APPROVED — mỗi nhánh gán
  --    sau khi đã biết token step-up có được tiêu hay không. Bất kỳ lần thứ ba nào
  --    nghĩa là biểu thức lại bị chép vào hàng ghi, dòng sổ hay vỏ trả về, tức là
  --    đúng cái nguyên nhân đợt này đang vá đã quay lại.
  IF v_duyet !~ 'v_consent_kind text' THEN
    RAISE EXCEPTION 'nghiem_thu: approve thieu bien v_consent_kind';
  END IF;
  IF ( SELECT count(*) FROM regexp_matches(v_duyet, 'CASE WHEN v_step_up_id IS NOT NULL', 'g') ) <> 2
     OR ( SELECT count(*) FROM regexp_matches(v_duyet, 'v_consent_kind := CASE WHEN v_step_up_id IS NOT NULL', 'g') ) <> 2 THEN
    RAISE EXCEPTION 'nghiem_thu: bieu thuc CASE consent_kind phai xuat hien dung 2 lan va CHI trong phep gan v_consent_kind (dang co %)',
      ( SELECT count(*) FROM regexp_matches(v_duyet, 'CASE WHEN v_step_up_id IS NOT NULL', 'g') );
  END IF;

  -- 2) (a) Ba VỎ TRẢ VỀ phải mang khoá — đây chính là chỗ hụt làm ca 6 đỏ.
  --    Không đếm trần chuỗi `'consent_kind'` (sáu chỗ: ba dòng sổ + ba vỏ trả về, đếm
  --    trần thì không phân biệt được cái nào). Neo vào tư thế RIÊNG của vỏ trả về:
  --    khoá đứng ngay sau `'plan_status', '<HOA>'`. Ba dòng sổ không có tư thế đó —
  --    ở chúng `plan_status` nằm lồng trong `'outcome'` và theo sau là khoá khác.
  IF ( SELECT count(*) FROM regexp_matches(v_duyet, '''plan_status'',\s+''[A-Z]+'',\s+''consent_kind''', 'g') ) <> 3 THEN
    RAISE EXCEPTION 'nghiem_thu: approve phai co dung 3 vo tra ve mang consent_kind, dang co %',
      ( SELECT count(*) FROM regexp_matches(v_duyet, '''plan_status'',\s+''[A-Z]+'',\s+''consent_kind''', 'g') );
  END IF;

  -- 3) (a) Hai hàng ghi vẫn nhận đúng biến đó — hàng = sổ = dây.
  IF ( SELECT count(*) FROM regexp_matches(v_duyet, 'consent_kind = v_consent_kind', 'g') ) <> 2 THEN
    RAISE EXCEPTION 'nghiem_thu: hai cau ghi copilot_plans phai gan consent_kind = v_consent_kind';
  END IF;

  -- 4) (b) Ba cờ có mặt.
  IF v_doc !~ 'has_payload_digest' OR v_doc !~ 'has_before_digest' OR v_doc !~ 'has_after_digest' THEN
    RAISE EXCEPTION 'nghiem_thu: ban doc ke hoach thieu co has_*_digest';
  END IF;

  -- 5) (b) HÀNG RÀO KHÔNG NỚI: ba cột digest thô vẫn bị trừ. Đây là bất biến đắt nhất
  --    của đợt này — thêm cờ mà đánh rơi phép trừ thì digest ra thẳng trình duyệt.
  IF v_doc !~ '- ''payload_digest''' OR v_doc !~ '- ''before_digest''' OR v_doc !~ '- ''after_digest''' THEN
    RAISE EXCEPTION 'nghiem_thu: ban doc ke hoach danh roi phep tru ba cot digest';
  END IF;

  -- 6) Khuôn hai hàm không được nới.
  IF v_duyet !~ 'SECURITY DEFINER' OR v_doc !~ 'SECURITY DEFINER' THEN
    RAISE EXCEPTION 'nghiem_thu: mot trong hai ham mat SECURITY DEFINER';
  END IF;
  IF v_doc !~ 'STABLE' THEN
    RAISE EXCEPTION 'nghiem_thu: copilot_plan_get_v1 mat STABLE';
  END IF;
  IF v_duyet !~ 'SET search_path' OR v_doc !~ 'SET search_path' THEN
    RAISE EXCEPTION 'nghiem_thu: mot trong hai ham mat search_path ghim';
  END IF;

  -- 7) ACL: PUBLIC không được còn EXECUTE. `has_function_privilege('public',...)` trả
  --    true qua đường thừa kế nên không dùng được — soi thẳng proacl. `proacl IS NULL`
  --    nghĩa là VẪN còn mặc định EXECUTE-cho-PUBLIC, tức là THẤT BẠI.
  IF v_acl IS NULL OR v_acl ~ '(\{|,)=[a-zA-Z*]*X' THEN
    RAISE EXCEPTION 'nghiem_thu: copilot_plan_get_v1 con EXECUTE cho PUBLIC (proacl=%)', COALESCE(v_acl, 'NULL');
  END IF;
END
$nghiem_thu$;

-- Hai hàm giữ nguyên chữ ký nên PostgREST không phải học lại tham số, nhưng vỏ
-- trả về đổi (thêm `consent_kind`, thêm ba cờ `has_*_digest`) — nạp lại schema
-- cache để bản đọc mới ra ngay, không chờ hết TTL.
NOTIFY pgrst, 'reload schema';

COMMIT;
