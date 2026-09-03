-- G5-C (1/8, dot 1) — Action L5 `income_expense.duyet` theo khuon direct_l5_v1.
--
-- BOC RPC GOC CO SAN: `approve_income_expense_v1(p_voucher_id uuid)` (SECURITY
-- DEFINER, doc production 03/09/2026 — dung `auth.uid()` truc tiep, quyen theo
-- `v_row.user_id = actor OR is_super_admin() OR can_do_on_building('income_expenses',
-- 'approve', building_id)`). Wrapper goi NGUYEN VEN, KHONG noi rong quyen: cung
-- phien `auth.uid()`, khong tham so nao them.
--
-- VI SAO LA L5 — day la DUYET mot phieu thu/chi, dao nguoc duoc mot phan qua
-- `cancel_income_expense_flex_v1` nhung anh huong ke toan that. Theo Contract,
-- direct_l5_v1 doi `consent_required='step_up'` — PIN da la dieu kien de ke
-- hoach duoc APPROVED (`copilot_plan_approve_v1`, G5-A), nen execute cua rieng
-- action nay CHI con kiem "co dang chay trong mot ke hoach hay khong" bang
-- marker `app.copilot_plan_context` — RAISE `l5_requires_plan` (42501) neu bi
-- goi thang ngoai `copilot_plan_execute_step_v1`.
--
-- VA DONG THOI VA HAM DONG CO CUA ENGINE — muc 0 duoi day CREATE OR REPLACE
-- `copilot_plan_execute_step_v1` (than chep NGUYEN VEN tu production, doc qua
-- Management API ngay truoc khi viet file) de them nhanh `executor_kind =
-- 'direct_l5_v1'`: giong het nhanh `nonce_abi_v1` (goi lai preview de lay nonce
-- MOI, kiem canonical moi khop `payload_digest` da duyet), CHI KHAC MOT DONG —
-- `set_config('app.copilot_plan_context', plan_id||':'||step_no, true)` NGAY
-- TRUOC khi EXECUTE execute_rpc. Khong dong nao khac trong ham bi sua.
--
-- CHINH SACH VAN L4 — `max_direct_risk` mac dinh van 'L4' (G0), nen moi ke
-- hoach mang buoc L5 se bi tu choi tu luc TAO (`plan_risk_not_allowed`,
-- `copilot_plan_create_v1`) hoac tu luc CHAY (`policy_changed`,
-- `copilot_plan_execute_step_v1`) cho toi khi G5-D mo van — dung y thiet ke.
--
-- READBACK — verify_kind `ie_approved`: doc lai `income_expenses`, doi
-- `approval_status = 'APPROVED'`. Sai danh tinh (to chuc khac) -> mot ma
-- (`copilot_write_readback_mismatch`); sai trang thai -> ma khac
-- (`copilot_draft_invariant_violation`) — cung khuon hai tang loi da dung o
-- G2-E.
--
-- HOAN TAC — `cancel_income_expense_flex_v1(p_voucher, p_reason, ...)` (da
-- kiem chu ky ton tai tren production). Khong tu dong goi — chi ghi ten trong
-- registry lam tai lieu cho nguoi/AI biet duong lui.
--
-- DUONG LUI CUA MIGRATION — CREATE OR REPLACE `copilot_plan_execute_step_v1`
-- ve lai than goc (khong co nhanh direct_l5_v1); DROP hai ham wrapper; DELETE
-- hang registry `income_expense.duyet` va hang co `('action','income_expense.duyet')`.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. VA DONG CO KE HOACH — them nhanh executor_kind = 'direct_l5_v1'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_plan_execute_step_v1(p_plan_id uuid, p_step_no integer, p_expected_plan_version integer, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_plan        app_private.copilot_plans%ROWTYPE;
  v_step        app_private.copilot_plan_steps%ROWTYPE;
  v_reg         app_private.copilot_action_registry%ROWTYPE;
  v_snapshot    jsonb := '{}'::jsonb;
  v_max_direct  text;
  v_policy_rev  bigint;
  v_next        int;
  v_version     int;
  v_kq          jsonb;
  v_ket         jsonb;
  v_canon_moi   jsonb;
  v_nonce       text;
  v_bang        text;
  v_entity_id   uuid;
  v_audit_id    uuid;
  v_trang_thai  text;
  v_after       jsonb;
  v_after_hex   text;
  v_voucher     uuid;
  v_idem        boolean := false;
  v_loi         text := NULL;
  v_chi_tiet    text := NULL;
  v_sqlstate    text := NULL;
  v_su_kien     text := NULL;
  v_ledger_id   uuid;
  v_plan_status text;
  v_buoc_status text;
  v_chan        int[];
  v_j           int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL OR p_step_no IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Tổ chức đi vào như một tham số RIÊNG và phải khớp kế hoạch. Đây là hàng rào
  -- chống "đổi công ty giữa phiên": client bind org của phiên vào lời gọi, nên
  -- một kế hoạch của công ty A không chạy được từ màn hình công ty B.
  IF p_organization_id IS NULL OR v_plan.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF v_plan.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'plan_not_approved: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;

  -- QUÁ HẠN THỰC THI. Ghi rồi TRẢ VỀ (quyết định 4 ở đầu file): mọi bước còn chờ
  -- thành BLOCKED và kế hoạch thành EXPIRED, nếu không nó nằm mãi ở APPROVED và
  -- hạn mức "3 kế hoạch mở" sẽ đếm nhầm.
  IF COALESCE(v_plan.execute_deadline, v_plan.expires_at) <= clock_timestamp() THEN
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
      'step_no',         p_step_no,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'execute')));
    RETURN jsonb_build_object(
      'ok',           false,
      'error_code',   'plan_expired',
      'plan_id',      v_plan.id,
      'plan_version', v_version,
      'plan_status',  'EXPIRED',
      'step', jsonb_build_object(
        'step_no', p_step_no, 'status', 'BLOCKED', 'outcome', NULL,
        'error_code', 'plan_expired'),
      'next_step_no', NULL);
  END IF;

  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = '40001';
  END IF;

  -- BƯỚC TUYẾN TÍNH. Chỉ bước PENDING nhỏ nhất được chạy, và mọi bước trước nó
  -- phải DONE. Không có đường nhảy cóc: bước 3 thường phụ thuộc kết quả bước 1.
  SELECT min(step_no) INTO v_next
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND status = 'PENDING';
  IF v_next IS NULL THEN
    RAISE EXCEPTION 'plan_no_pending_step' USING ERRCODE = '22023';
  END IF;
  IF p_step_no IS DISTINCT FROM v_next THEN
    RAISE EXCEPTION 'step_order: buoc ke tiep la %', v_next USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND step_no < p_step_no AND status <> 'DONE'
  ) THEN
    RAISE EXCEPTION 'step_order: con buoc truoc chua xong' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_step
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND step_no = p_step_no
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- ---------------------------------------------------------------------
  -- TẦNG (2) — TIỀN KIỂM, ngay trước khi ghi. Không phải kiểm lại cho vui:
  -- giữa lúc duyệt và lúc bấm chạy có tới 30 phút.
  -- ---------------------------------------------------------------------
  BEGIN
    IF NOT app_private.copilot_action_flag_allows_v1(
             'copilot.execution_plan', v_plan.organization_id) THEN
      RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
    END IF;

    -- Fix round 1 (F2, review): mot han muc da bi THU HOI GIUA luc tu duyet
    -- va luc chay khong duoc phep tiep tuc chay ngam. Thu hoi (tung cai hoac
    -- kill switch "tat ca") phai DUNG duoc mot ke hoach dang o giua chung,
    -- khong chi chan duoc nhung ke hoach CHUA lap — neu khong, "Thu hoi tat
    -- ca" tren trang quan tri chi la mot nut trang tri cho cac buoc da kip
    -- APPROVED truoc do. Chi ap dung cho ke hoach tu duyet theo uy quyen
    -- dung; duong bam tay/PIN khong mang grant nao de kiem.
    IF v_plan.consent_kind = 'standing_grant' THEN
      IF EXISTS (
        SELECT 1
          FROM unnest(v_plan.standing_grant_ids) AS gid
         WHERE NOT EXISTS (
           SELECT 1 FROM app_private.copilot_standing_grants g
            WHERE g.id = gid
              AND g.revoked_at IS NULL
              AND g.expires_at > clock_timestamp()
         )
      ) THEN
        RAISE EXCEPTION 'grant_revoked' USING ERRCODE = '42501';
      END IF;
    END IF;

    SELECT * INTO v_reg
      FROM app_private.copilot_action_registry
     WHERE action_id = v_step.action_id;
    IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
      RAISE EXCEPTION 'registry_changed' USING ERRCODE = '42501';
    END IF;

    -- POLICY, ĐO LẠI NGAY TRƯỚC KHI GHI.
    --
    --   `copilot_action_gate_v1` không biết trần rủi ro và không biết danh sách
    --   vai — nó đo registry + cờ + cấm khẩn cấp + phạm vi quyền. Kế hoạch được
    --   duyệt xong còn 30 phút để chạy, và trong 30 phút đó van có thể bị hạ.
    --   Không hỏi lại nghĩa là một lần hạ trần rủi ro không dừng được thứ đang
    --   chạy dở — đúng lúc người ta hạ trần vì đang có sự cố.
    --
    --   Cả ba vế (revision đã đổi / vai không còn được phép / bước vượt trần)
    --   cùng ném `policy_changed`: với người bấm chúng là một chuyện.
    SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
      FROM app_private.copilot_action_policy WHERE id;
    IF v_max_direct IS NULL OR v_policy_rev IS NULL THEN
      RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
    END IF;
    IF v_policy_rev IS DISTINCT FROM v_plan.policy_revision
       OR NOT app_private.copilot_plan_role_allowed_v1(v_plan.organization_id)
       OR (v_reg.executor_kind <> 'maker_submit_v1'
           AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
             > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)) THEN
      RAISE EXCEPTION 'policy_changed' USING ERRCODE = '42501';
    END IF;

    v_snapshot := app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);

    -- Digest đã duyệt phải còn khớp `canonical` đang lưu. Vế này bắt đúng một
    -- kiểu tấn công: sửa thẳng hàng bước trong database giữa duyệt và chạy.
    IF v_step.canonical IS NULL
       OR v_step.payload_digest IS NULL
       OR app_private.copilot_payload_hash_v1(v_step.canonical)
            IS DISTINCT FROM v_step.payload_digest THEN
      RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
    END IF;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
    v_loi := split_part(v_chi_tiet, ':', 1);
    v_su_kien := 'step_blocked';
  END;

  -- ---------------------------------------------------------------------
  -- TẦNG (3) — KHỐI CON THỰC THI. Mọi hiệu ứng ghi nằm trong đây và chỉ
  -- trong đây, nên một lỗi bất kỳ cuốn ngược sạch mà giao dịch ngoài vẫn
  -- sống để ghi sổ.
  -- ---------------------------------------------------------------------
  IF v_loi IS NULL THEN
    BEGIN
      IF v_reg.executor_kind = 'nonce_abi_v1' THEN
        -- XEM TRƯỚC LẠI để lấy nonce MỚI. Nonce này sinh ra và bị tiêu trong
        -- đúng giao dịch này; nó không tồn tại ở đâu khác, không ai cầm được.
        -- Tên hàm đến từ REGISTRY (CHECK regex + hai CHECK theo hàng).
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING v_plan.organization_id, v_step.payload;
        v_canon_moi := v_kq -> 'canonical';
        v_nonce := v_kq ->> 'confirmation_nonce';
        -- Thế giới đã đổi (giá, hạng mục, tên toà…) thì `canonical` mới sẽ băm
        -- ra khác. Dừng lại: thứ sắp ghi không còn là thứ người dùng đã duyệt.
        IF jsonb_typeof(COALESCE(v_canon_moi, 'null'::jsonb)) <> 'object'
           OR app_private.copilot_payload_hash_v1(v_canon_moi)
                IS DISTINCT FROM v_step.payload_digest THEN
          RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
        END IF;

        EXECUTE format('SELECT public.%I($1, $2)', v_reg.execute_rpc)
           INTO v_ket
          USING v_nonce, v_canon_moi;

      ELSIF v_reg.executor_kind = 'direct_l5_v1' THEN
        -- G5-C: L5 dung lai dung mo hinh preview/execute cua nonce_abi_v1 (nonce
        -- mot lan, canonical chot lai bang payload_digest), CHI KHAC mot dong:
        -- danh dau ngu canh ke hoach TRUOC khi goi execute_rpc. Ham execute cua
        -- moi action L5 tu kiem current_setting('app.copilot_plan_context') va
        -- tu choi 42501 l5_requires_plan neu bi goi truc tiep ngoai ke hoach nay
        -- (PIN step-up da la dieu kien de ke hoach duoc APPROVED tu truoc, o
        -- copilot_plan_approve_v1 — o day chi con la khoa "phai di qua ke hoach").
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING v_plan.organization_id, v_step.payload;
        v_canon_moi := v_kq -> 'canonical';
        v_nonce := v_kq ->> 'confirmation_nonce';
        IF jsonb_typeof(COALESCE(v_canon_moi, 'null'::jsonb)) <> 'object'
           OR app_private.copilot_payload_hash_v1(v_canon_moi)
                IS DISTINCT FROM v_step.payload_digest THEN
          RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
        END IF;

        PERFORM set_config('app.copilot_plan_context',
                            v_plan.id::text || ':' || p_step_no::text, true);
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.execute_rpc)
           INTO v_ket
          USING v_nonce, v_canon_moi;

      ELSIF v_reg.executor_kind = 'maker_submit_v1' THEN
        IF v_step.ref_step IS NOT NULL THEN
          -- `{$ref_step: n}`: thực thể do bước n vừa tạo. Đọc từ KẾT QUẢ ĐÃ GHI
          -- của bước đó, không từ payload — payload không biết id sẽ là gì.
          SELECT NULLIF(s.outcome ->> 'entity_id', '')::uuid INTO v_voucher
            FROM app_private.copilot_plan_steps s
           WHERE s.plan_id = v_plan.id
             AND s.step_no = v_step.ref_step
             AND s.status = 'DONE';
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'ref_step_unresolved' USING ERRCODE = '22023';
          END IF;
        ELSE
          v_voucher := NULLIF(v_step.canonical ->> 'voucher_id', '')::uuid;
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'step_voucher_invalid' USING ERRCODE = '22023';
          END IF;
        END IF;
        v_ket := app_private.copilot_plan_submit_voucher_v1(
                   v_plan.organization_id, v_voucher, v_plan.id, v_step.step_no);

      ELSE
        RAISE EXCEPTION 'executor_not_supported' USING ERRCODE = '0A000';
      END IF;

      v_trang_thai := COALESCE(v_ket ->> 'status', 'da_thuc_hien');
      v_bang := COALESCE(NULLIF(v_ket ->> 'entity_table', ''), v_reg.produces_entity_table);
      v_entity_id := NULLIF(v_ket ->> 'entity_id', '')::uuid;
      v_audit_id := NULLIF(v_ket ->> 'audit_id', '')::uuid;
      -- Chạy lại một bước đã ghi KHÔNG phải lỗi: lớp chống-lặp của chính action
      -- trả về bản ghi cũ. Bước vẫn DONE, chỉ mang cờ `idempotent`.
      v_idem := v_trang_thai IN ('da_thuc_hien_truoc_do', 'da_tao_truoc_do')
                OR COALESCE((v_ket ->> 'idempotent')::boolean, false);

      -- ĐỌC LẠI TỪ BẢNG. Tên bảng đến từ kết quả của RPC đã chạy hoặc từ
      -- registry — KHÔNG từ tham số của người gọi — và vẫn đi qua `%I` cộng một
      -- ràng buộc hình dạng, nên trường hợp xấu nhất là một định danh không tồn
      -- tại (bước FAILED), không phải một câu lệnh chắp nối.
      IF v_entity_id IS NULL OR v_bang IS NULL OR v_bang !~ '^[a-z_][a-z0-9_]*$' THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', v_bang)
         INTO v_after
        USING v_entity_id;
      IF v_after IS NULL
         OR NULLIF(v_after ->> 'organization_id', '')::uuid
              IS DISTINCT FROM v_plan.organization_id THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;

      -- Bất biến theo `verify_kind` của registry. Sai ở đây nghĩa là hàng ghi ra
      -- KHÔNG đúng thứ thẻ xem trước đã hứa — cuốn ngược, đừng chữa.
      CASE v_reg.verify_kind
        WHEN 'ie_draft' THEN
          IF v_after ->> 'approval_status' IS DISTINCT FROM 'UNAPPROVED'
             OR v_after ->> 'posting_status' IS DISTINCT FROM 'UNPOSTED'
             OR NULLIF(v_after ->> 'user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'approval_request_pending' THEN
          IF v_after ->> 'state' IS DISTINCT FROM 'PENDING_APPROVAL'
             OR NULLIF(v_after ->> 'maker_user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'hold_pending_approval' THEN
          IF v_after ->> 'status' IS DISTINCT FROM 'PENDING_APPROVAL' THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        ELSE
          -- 'readback': tồn tại + đúng tổ chức đã là toàn bộ lời hứa.
          NULL;
      END CASE;
    EXCEPTION WHEN others THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
      v_loi := split_part(v_chi_tiet, ':', 1);
      v_su_kien := 'step_failed';
    END;
  END IF;

  -- ---------------------------------------------------------------------
  -- ĐUÔI — chạy ở GIAO DỊCH NGOÀI. Đây là chỗ trạng thái và sổ được ghi, và
  -- đó là lý do chúng sống sót qua lần cuộn ngược của khối con.
  -- ---------------------------------------------------------------------
  IF v_loi IS NULL THEN
    v_after_hex := encode(
      extensions.digest(convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex');

    UPDATE app_private.copilot_plan_steps
       SET status = 'DONE',
           outcome = jsonb_build_object(
             'entity_table', v_bang,
             'entity_id',    v_entity_id,
             'audit_id',     v_audit_id,
             'idempotent',   v_idem,
             'status',       v_trang_thai),
           error_code = NULL,
           error_detail = NULL,
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'step_done',
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_plan.version + 1,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'step_up_id',          v_plan.step_up_confirmation_id,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'after_digest',        v_after_hex,
      'entity_table',        v_bang,
      'entity_id',           v_entity_id,
      'audit_id',            v_audit_id,
      -- G5-B: bao cao ngay cua uy quyen dung can tong tien theo ngay. Chi doc
      -- tu canonical DA CHOT o buoc xem truoc lai (v_step.canonical) — khong
      -- bao gio doc tu payload tho cua client.
      'amount',              NULLIF(v_step.canonical ->> 'amount', ''),
      'outcome', jsonb_build_object('status', v_trang_thai, 'idempotent', v_idem)));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    v_buoc_status := 'DONE';
    SELECT min(step_no) INTO v_next
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    v_plan_status := CASE WHEN v_next IS NULL THEN 'DONE' ELSE 'APPROVED' END;

    UPDATE app_private.copilot_plans
       SET status = v_plan_status, version = version + 1, updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

  ELSE
    v_buoc_status := CASE WHEN v_su_kien = 'step_blocked' THEN 'BLOCKED' ELSE 'FAILED' END;

    UPDATE app_private.copilot_plan_steps
       SET status = v_buoc_status,
           error_code = v_loi,
           error_detail = left(COALESCE(v_chi_tiet, ''), 1000),
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    -- Một bước hỏng làm CẢ kế hoạch dừng. Không có "bỏ qua rồi chạy tiếp": bước
    -- sau thường tựa vào kết quả bước trước, và đoán xem cái nào độc lập là đúng
    -- kiểu suy luận mà một hệ ghi tiền không được phép làm.
    SELECT array_agg(step_no ORDER BY step_no) INTO v_chan
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_failed'
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    v_plan_status := 'FAILED';
    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           failure_reason = v_su_kien || ':' || p_step_no::text || ':' || COALESCE(v_loi, '?'),
           updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               v_su_kien,
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_version,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'step_up_id',          v_plan.step_up_confirmation_id,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'error_code',          v_loi,
      'sqlstate',            v_sqlstate,
      -- KHÔNG nhét `SQLERRM` thô vào đây. `copilot_plan_get_v1` trả 20 dòng sổ
      -- cho chủ kế hoạch, nên mọi thứ vào `outcome` là thứ ra tới trình duyệt.
      -- Thông điệp đầy đủ ở lại `copilot_plan_steps.error_detail` — cột mà
      -- `copilot_plan_summary_v1` không đọc.
      'outcome', jsonb_build_object('plan_status', 'FAILED')));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    -- Mỗi bước bị chặn theo có một dòng sổ riêng. Gộp lại thành một dòng sẽ làm
    -- việc dựng lại "bước nào đã không chạy" thành suy đoán.
    IF v_chan IS NOT NULL THEN
      FOREACH v_j IN ARRAY v_chan LOOP
        PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
          'event',           'step_blocked',
          'organization_id', v_plan.organization_id,
          'plan_id',         v_plan.id,
          'step_no',         v_j,
          'plan_version',    v_version,
          'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                               WHERE plan_id = v_plan.id AND step_no = v_j),
          'permission_key',  'copilot.execution_plan',
          'consent_id',      v_plan.consent_confirmation_id,
          'consent_kind',    v_plan.consent_kind,
          'step_up_id',      v_plan.step_up_confirmation_id,
          'error_code',      'plan_failed',
          'outcome',         jsonb_build_object('nguyen_nhan_tu_buoc', p_step_no)));
      END LOOP;
    END IF;
    v_next := NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok',           v_loi IS NULL,
    'error_code',   v_loi,
    'plan_id',      v_plan.id,
    'plan_version', v_version,
    'plan_status',  v_plan_status,
    'step', jsonb_build_object(
      'step_no',    p_step_no,
      'status',     v_buoc_status,
      'outcome',    CASE WHEN v_loi IS NULL THEN jsonb_build_object(
                           'entity_table', v_bang,
                           'entity_id',    v_entity_id,
                           'audit_id',     v_audit_id,
                           'idempotent',   v_idem)
                         ELSE NULL END,
      'error_code', v_loi),
    'next_step_no', v_next);
END
$function$
;

-- ---------------------------------------------------------------------------
-- 1. XEM TRUOC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_ie_duyet_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_ie_duyet$
DECLARE
  v_actor     uuid := auth.uid();
  v_snapshot  jsonb;
  v_ie_id     uuid;
  v_ie        public.income_expenses%ROWTYPE;
  v_toa       text;
  v_scope     record;
  v_nonce     bytea;
  v_canonical jsonb;
  v_canh_bao  text := NULL;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('income_expense.duyet', p_organization_id);

  BEGIN
    v_ie_id := (p_payload ->> 'income_expense_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_ie_id IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  -- Fail-closed theo TO CHUC: phieu cua cong ty khac tra ve DUNG cau nhu phieu
  -- khong ton tai.
  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_ie_id
     AND deleted_at IS NULL
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Phieu da HUY la trang thai chet — approve_income_expense_v1 se RAISE chac
  -- chan. Chan o day de khong dot mot nonce cho mot yeu cau da biet truoc se
  -- hong.
  IF v_ie.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'voucher_cancelled' USING ERRCODE = '55000';
  END IF;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('income_expenses.approve', p_organization_id) s;
  -- Phieu khong gan toa KHONG phai "khong co gi de kiem" — no la "khong pham
  -- vi nao bao duoc no". Fail-closed, cung khuon voi cac action truoc.
  IF NOT COALESCE(v_scope.org_wide, false)
     AND (v_ie.building_id IS NULL
          OR NOT (v_ie.building_id = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  IF v_ie.building_id IS NOT NULL THEN
    SELECT b.name INTO v_toa FROM public.buildings b WHERE b.id = v_ie.building_id;
  END IF;

  IF v_ie.approval_status = 'APPROVED' THEN
    v_canh_bao := 'Phieu DA duyet tu truoc — thao tac nay se khong doi gi (idempotent).';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id',   p_organization_id,
    'income_expense_id', v_ie_id
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'income_expense.duyet', app_private.copilot_payload_hash_v1(v_canonical),
     'income_expenses.approve', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha',             v_toa,
      'loai_phieu',          v_ie.type,
      'ten_phieu',           v_ie.name,
      'so_tien',             v_ie.total_amount,
      'trang_thai_hien_tai', v_ie.approval_status,
      'hau_qua',             'Se duyet phieu — approval_status chuyen sang APPROVED',
      'canh_bao',            v_canh_bao
    )
  );
END
$xem_truoc_ie_duyet$;

COMMENT ON FUNCTION public.copilot_preview_ie_duyet_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc duyet phieu thu/chi (boc approve_income_expense_v1). Goi copilot_action_gate_v1 truoc khi phat nonce; chan som phieu da huy.';

REVOKE ALL ON FUNCTION public.copilot_preview_ie_duyet_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_ie_duyet$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_ie_duyet_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_ie_duyet_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_ie_duyet_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_ie_duyet_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_ie_duyet$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_ie_duyet_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_ie_duyet$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_ie_id     uuid;
  v_key       text;
  v_prev      public.ai_write_audit%ROWTYPE;
  v_before    jsonb;
  v_after     jsonb;
  v_ie        public.income_expenses%ROWTYPE;
  v_audit_id  uuid;
  v_ledger_id uuid;
  v_sqlstate  text;
  v_message   text;
BEGIN
  -- L5: goi truc tiep ngoai mot ke hoach da duyet (PIN) bi tu choi ngay tu dau.
  -- Marker nay CHI duoc `copilot_plan_execute_step_v1` dat truoc khi EXECUTE.
  IF current_setting('app.copilot_plan_context', true) IS NULL
     OR current_setting('app.copilot_plan_context', true) = '' THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_confirmation_nonce IS NULL
     OR p_confirmation_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;

  v_hash := app_private.copilot_payload_hash_v1(p_payload);

  SELECT * INTO v_row
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(
           decode(p_confirmation_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.tool IS DISTINCT FROM 'income_expense.duyet'
     OR v_row.permission_key IS DISTINCT FROM 'income_expenses.approve' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;
  IF v_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;
  IF v_row.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_org   := (p_payload ->> 'organization_id')::uuid;
    v_ie_id := (p_payload ->> 'income_expense_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_ie_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('income_expense.duyet', v_org);

  v_key := 'copilot_action:income_expense.duyet:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'income_expenses',
      'entity_id',    v_prev.entity_id,
      'audit_id',     v_prev.id,
      'ledger_id',    NULL
    );
  END IF;

  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_row.id
     AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  -- Phieu phai con song va dung to chuc. Kiem lai o day chu khong tin buoc
  -- xem truoc: giua hai buoc co toi 5 phut.
  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_ie_id
     AND deleted_at IS NULL
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- `before_digest` LUON khac NULL o mot hanh dong DUYET: phieu phai ton tai
  -- truoc do moi duyet duoc, khac voi mot hanh dong TAO moi.
  v_before := to_jsonb(v_ie);

  BEGIN
    PERFORM public.approve_income_expense_v1(v_ie_id);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'action_failed',
      'organization_id',     v_org,
      'action_id',           'income_expense.duyet',
      'permission_key',      'income_expenses.approve',
      'permission_snapshot', v_snapshot,
      'consent_kind',        'click',
      'consent_id',          v_row.id,
      'payload_digest',      encode(v_hash, 'hex'),
      'before_digest',       encode(extensions.digest(
                               convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
      'entity_table',        'income_expenses',
      'entity_id',           v_ie_id,
      'error_code',          v_message,
      'sqlstate',            v_sqlstate
    ));
    RAISE;
  END;

  -- READBACK — doc lai tu BANG, khong tin ket qua void cua RPC goc.
  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_ie_id;
  IF NOT FOUND
     OR v_ie.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_ie.approval_status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_ie);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'income_expense.duyet', v_key, 'income_expenses',
     v_ie.id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'income_expense.duyet',
    'permission_key',      'income_expenses.approve',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'income_expenses',
    'entity_id',           v_ie.id,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'income_expenses',
    'entity_id',    v_ie.id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_ie_duyet$;

COMMENT ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong mot ke hoach (l5_requires_plan), goi lai approve_income_expense_v1, doc lai de ep approval_status=APPROVED, ghi ai_write_audit + so hanh dong voi before/after digest.';

REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_ie_duyet$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_ie_duyet_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_ie_duyet$;

-- ---------------------------------------------------------------------------
-- 3. SO DANG KY + CONG TAC
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled, grantable
)
VALUES (
  'income_expense.duyet',
  1,
  'Duyệt phiếu thu/chi',
  'income_expenses.approve',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_ie_duyet_v1',
  'copilot_execute_ie_duyet_v1',
  'ie_approved',
  'income_expenses',
  'income_expenses',
  'cancel_income_expense_flex_v1',
  'Huy duyet qua cancel_income_expense_flex_v1(p_voucher, p_reason, p_expected_approval_version, p_expected_posting_version) tren giao dien Thu chi — can ly do >= 8 ky tu. Khong tu dong goi.',
  'income_expense.duyet',
  true,
  false
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'income_expense.duyet', 'disabled',
  'seed kill switch cho action L5 duyet phieu thu/chi (G5-C dot 1) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903190255_copilot_action_ie_duyet_v1',
  'migration:20260903190255_copilot_action_ie_duyet_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- ---------------------------------------------------------------------------
-- NGHIEM THU — chi soi catalog, chay duoc tren database rong.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
  v_than  text;
BEGIN
  FOREACH v_ten IN ARRAY ARRAY[
    'public.copilot_preview_ie_duyet_v1(uuid, jsonb)',
    'public.copilot_execute_ie_duyet_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C ie_duyet: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('app_private.copilot_action_gate_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_gate_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_ledger_append_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_ledger_append_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('public.approve_income_expense_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'approve_income_expense_v1 missing — baseline phai co truoc';
  END IF;
  IF to_regprocedure('public.cancel_income_expense_flex_v1(uuid, text, bigint, bigint)') IS NULL THEN
    RAISE EXCEPTION 'cancel_income_expense_flex_v1 missing — rollback_rpc phai ton tai that';
  END IF;

  -- Dong co ke hoach phai da mang nhanh direct_l5_v1 (muc 0 cua file nay).
  SELECT pg_get_functiondef('public.copilot_plan_execute_step_v1(uuid, integer, integer, uuid)'::regprocedure)
    INTO v_than;
  IF v_than !~ 'direct_l5_v1' THEN
    RAISE EXCEPTION 'copilot_plan_execute_step_v1 chua co nhanh direct_l5_v1 — muc 0 cua migration nay chua chay dung';
  END IF;
  IF v_than !~ 'app\.copilot_plan_context' THEN
    RAISE EXCEPTION 'copilot_plan_execute_step_v1 chua dat marker app.copilot_plan_context';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_ie_duyet_v1(uuid, jsonb)',
      'public.copilot_execute_ie_duyet_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C ie_duyet: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'income_expense.duyet'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'income_expenses.approve'
       AND grantable = false
       AND rollback_rpc = 'cancel_income_expense_flex_v1'
  ) THEN
    RAISE EXCEPTION 'seed registry income_expense.duyet sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'income_expense.duyet'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: income_expense.duyet';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
