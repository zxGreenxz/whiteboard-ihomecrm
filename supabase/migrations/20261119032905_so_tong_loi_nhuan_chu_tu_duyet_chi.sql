-- =============================================================================
-- Sổ tổng lợi nhuận — CHỦ TỰ DUYỆT VÀ CHI phiếu chủ lập (chốt chặn F1).
--
-- VÌ SAO
--   Công ty có hai nick chủ của CÙNG một người (vai "Chủ sở hữu tổ chức": có quyền chi lợi nhuận, chi lương điều hành,
--   duyệt thu chi). F1 (20261115084015) bắt người duyệt khác người lập và khác người nhận, và người nhận không tự ghi sổ,
--   cho MỌI phiếu sổ tổng ⇒ chủ chốt chi lợi nhuận / chi lương điều hành xong phải đổi sang nick chủ còn lại để duyệt rồi
--   người giữ sổ bấm Chi; lương điều hành của chính nick đang giữ sổ thì không ai chi được. Chủ quyết (19/11/2026), "làm
--   đúng luồng thu chi": phiếu vẫn phải lưu xong ở Chờ duyệt rồi mới duyệt (rào "lập rồi mới duyệt" của vòng đời V2 GIỮ
--   NGUYÊN), bấm Chi vẫn phải có ảnh chứng từ (GIỮ NGUYÊN), nhưng nick chủ tự Duyệt / Duyệt và Chi / Chi phiếu của mình
--   như mọi phiếu thu chi.
--
-- LÀM GÌ
--   CREATE OR REPLACE app_private.guard_profit_ledger_payout_v1() (F1, trigger a06_profit_ledger_payout_guard) — giữ chữ
--   ký, chủ hàm, SECURITY DEFINER, volatility, search_path, ACL. Thân CHÉP NGUYÊN VĂN 20261115084015 (md5 668c5e5c…, bằng
--   production), chỉ nới ba luật cho phiếu maker_kind = 'OWNER' (phiếu tiền của lần chốt chi theo tháng, phiếu lương điều
--   hành, phiếu E5 cũ) khi người thao tác có quyền chi của đúng loại chủ thể (shareholder_profit.distribute cho cổ đông,
--   shareholder_profit.pay_manager cho lương điều hành):
--     (a) bước DUYỆT: người lập tự duyệt được (không ném PROFIT_LEDGER_MAKER_SELF_APPROVE);
--     (b) bước DUYỆT: người nhận (đăng nhập lúc lập hoặc hiện tại) duyệt được (không ném PROFIT_LEDGER_PAYEE_SELF_APPROVE);
--     (c) bước GHI SỔ: người nhận ghi sổ (Chi) được (không ném PROFIT_LEDGER_PAYEE_SELF_POST).
--   Bước duyệt: quyền chi tính bằng ĐÚNG lời gọi authorize_tenant_action_v3 sẵn có (toà + sổ quỹ của phiếu), dời lên TRƯỚC
--   hai luật tự duyệt — RPC duyệt V2 đã khoá chia sẻ dòng công ty bằng chính hàm này trước câu UPDATE nên thứ tự khoá không
--   đổi; câu báo, mã lỗi và thứ tự báo lỗi giữ nguyên (người lập → người nhận → thiếu quyền).
--   Bước ghi sổ: quyền chi THEO CẢ CÔNG TY bằng app_private.authorized_scope_v3 (STABLE, KHÔNG khoá dòng, theo auth.uid()),
--   chỉ hỏi khi người ghi sổ là người nhận của phiếu OWNER — tới bước này RPC ghi sổ đã giữ hàng phiếu rồi hàng sổ quỹ,
--   khoá dòng công ty lúc đó là đảo thứ tự khoá so với các lệnh khoá công ty trước rồi mới khoá sổ quỹ.
--   Nhật ký: PAYOUT_APPROVED ghi thêm 'owner_self' {maker, payee} khi người lập / người nhận tự duyệt nhờ luật mới;
--   PAYOUT_POSTED ghi thêm 'owner_self' {payee: true} khi người nhận tự ghi sổ nhờ luật mới.
--   COMMENT của F1 viết lại theo luật mới.
--
-- KHÔNG LÀM
--   Không đổi kiểm nào khác của F1 (route CANONICAL, token FINANCE_V2_LIFECYCLE, phiếu còn sống, còn yêu cầu duyệt đang chờ,
--   quyền chi, người nhận còn hoạt động, thứ tự khoá, phiếu lương cần xem lại, lương điều hành vượt, khoá cột, sổ quỹ lúc
--   lập, ngữ cảnh lập / huỷ, cấm xoá). Phiếu tạm ứng (CUSTODIAN_ADVANCE / CUSTODIAN_FOR_PAYEE) giữ luật cũ: chủ khác duyệt;
--   người nhận không tự ghi sổ trừ người giữ sổ tự tạm ứng. Không đổi RPC nào (lệnh chốt, lương điều hành, RPC vòng đời V2,
--   lệnh huỷ E6 — người nhận vẫn không tự huỷ phiếu đã duyệt / đã chi cho mình), không nới rào "lập rồi mới duyệt"
--   (assert_committed_birth_boundary_v2) hay luật chứng từ khi ghi sổ, không sửa dữ liệu (phiếu cũ để nguyên; phiếu OWNER
--   đang chờ duyệt áp luật mới từ lúc này).
--
-- AN TOÀN CHẠY LẠI
--   Tiền kiểm: F1 phải có (đúng chữ ký) và đang gắn ở trigger a06_profit_ledger_payout_guard; authorize_tenant_action_v3
--   và authorized_scope_v3 (có cột org_wide) phải có; md5 thân F1 (prosrc, bỏ CR) phải là bản production 668c5e5c… (lượt
--   đầu) hoặc thân của chính file này (lượt chạy lại) — khác ⇒ 55000, không ghi gì (chống ghi đè một bản đã đổi ngoài
--   luồng). Không khẳng định dữ liệu; không so ACL với giá trị cố định (bản dựng lại của diễn tập khôi phục có ACL theo nền
--   dựng lại) — chụp ACL / chủ hàm / cấu hình lúc trước rồi hậu kiểm so tương đối. CREATE OR REPLACE / COMMENT ON chạy lại
--   không đổi gì; hậu kiểm đúng ở cả hai lượt.
--
-- LÙI (migration forward mới, không phá dữ liệu): CREATE OR REPLACE F1 bằng nguyên văn câu tạo hàm của 20261115084015
--   (md5 668c5e5c…) kèm COMMENT của file đó. Phiếu đã tự duyệt / tự chi theo luật mới vẫn là phiếu hợp lệ (nhật ký sổ tổng
--   có dấu 'owner_self').
-- MÃ LỖI: không thêm mã; không tự ném mã lớp 40.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Tiền kiểm: F1 đúng bản đã rà, đang gắn ở trigger; hai hàm quyền phải có. Chụp ACL / chủ hàm / cấu hình để hậu kiểm.
DO $truoc$
DECLARE
  c_f1  constant regprocedure := to_regprocedure('app_private.guard_profit_ledger_payout_v1()');
  v_md5 text;
BEGIN
  IF c_f1 IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.guard_profit_ledger_payout_v1() — 20261115084015 phải áp trước' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = to_regprocedure('app_private.authorized_scope_v3(text,uuid)')
          AND p.proretset AND 'org_wide' = ANY (p.proargnames)) THEN
    RAISE EXCEPTION 'Thiếu app_private.authorize_tenant_action_v3(uuid, uuid, text, uuid, uuid) hoặc app_private.authorized_scope_v3(text, uuid) có cột org_wide'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgname = 'a06_profit_ledger_payout_guard' AND t.tgrelid = to_regclass('public.income_expenses')
       AND t.tgfoid = c_f1 AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'Trigger a06_profit_ledger_payout_guard không gắn app_private.guard_profit_ledger_payout_v1() — DỪNG, đối chiếu chốt chặn đang chạy'
      USING ERRCODE = '55000';
  END IF;

  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = c_f1;
  -- 668c5e5c…: thân của 20261115084015 — bản đang chạy production (đo 19/11/2026). 126c1ddc…: thân của chính file này.
  IF v_md5 IS NULL OR v_md5 NOT IN ('668c5e5c0a1e2c7dda74f0bd7f5f6e3b', '126c1ddc4cdd6acf6b9af64561d87794') THEN
    RAISE EXCEPTION 'app_private.guard_profit_ledger_payout_v1() KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy rồi rà lại', v_md5
      USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('ihomecrm.chu_tu_duyet_chi.f1',
    (SELECT COALESCE(p.proacl::text, '<mặc định>') || ' | ' || p.proowner::regrole::text || ' | ' || p.prosecdef::text
            || ' | ' || p.provolatile::text || ' | ' || COALESCE(p.proconfig::text, '<không>')
       FROM pg_catalog.pg_proc p WHERE p.oid = c_f1),
    true);
END
$truoc$;

-- ── 1. F1: thân 20261115084015 nguyên văn, trừ ba luật tự duyệt / tự ghi sổ của phiếu chủ lập ───────────────────────
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_payout_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  -- Cột được đổi BẤT KỲ LÚC NÀO: đánh dấu đã kiểm, bàn giao tiền mặt, ảnh / ghi chú, cột máy tự tính.
  c_luc_nao constant text[] := ARRAY['verified_at', 'verified_by', 'verified_by_name', 'verified_note', 'handover_id',
                                     'attachments', 'notes', 'has_restricted_item', 'kqkd_amount',
                                     'counts_in_business_result', 'updated_at'];
  -- Bước DUYỆT (approve_income_expense_v2 / câu đầu của approve_and_post_income_expense_v2).
  c_duyet   constant text[] := ARRAY['approval_status', 'approved_by', 'approved_at', 'review_state', 'approval_version',
                                     'posting_id', 'posted_at_v2'];
  -- Bước GHI SỔ (post_approved_income_expense_v2 / câu sau của approve_and_post_income_expense_v2).
  -- account_id được có mặt trong SET nhưng phải giữ giá trị (kiểm riêng ở trên).
  c_ghi_so  constant text[] := ARRAY['active_posting_id_v2', 'posting_status', 'posting_id', 'posted_at_v2',
                                     'posting_version', 'posting_mode'];
  -- Ngữ cảnh HUỶ của E6: sang CANCELLED và các cột đảo bút toán.
  c_huy     constant text[] := ARRAY['approval_status', 'review_state', 'posting_status', 'cancellation_kind',
                                     'active_posting_id_v2', 'reversed_by_posting_id', 'approval_version', 'posting_version'];
  v_ctx     text;
  v_buoc    text;
  v_lech    text[];
  v_token   boolean;
  v_uid     uuid;
  v_p       app_private.profit_ledger_payouts%ROWTYPE;
  v_subject uuid;
  v_key     text;
  v_allowed boolean;
  v_req     record;
  v_bal     jsonb;
  v_before  numeric(15,2);
  v_within  numeric(15,2);
  v_advance numeric(15,2);
  v_payee_now uuid;
  -- 19/11/2026: phiếu CHỦ lập (maker_kind OWNER) + người thao tác có quyền chi của đúng loại chủ thể ⇒ tự duyệt / tự chi được.
  v_chu_tu  boolean := false;
  v_la_nhan boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_NO_DELETE: phiếu chi theo sổ tổng không xoá được — muốn bỏ phiếu thì dùng lệnh huỷ có lý do'
      USING ERRCODE = '55000';
  END IF;

  v_ctx := app_private.profit_ledger_write_context_v1(OLD.id);

  -- Ngữ cảnh LẬP phiếu (E5/E11): cho mọi đổi, trừ việc rời trạng thái chờ duyệt (phủ luật AUTO_POST).
  IF v_ctx = 'CREATE' THEN
    IF NEW.approval_status IS DISTINCT FROM 'UNAPPROVED' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_CONTEXT: trong lúc lập, phiếu chi theo sổ tổng phải giữ trạng thái chờ duyệt'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Ngữ cảnh HUỶ (chỉ E6 đặt): chỉ sang CANCELLED, chỉ đổi cột huỷ / đảo bút toán.
  IF v_ctx = 'CANCEL' THEN
    IF OLD.approval_status = 'CANCELLED' OR NEW.approval_status IS DISTINCT FROM 'CANCELLED' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_CONTEXT: lệnh huỷ chỉ được chuyển phiếu chi theo sổ tổng sang Đã huỷ'
        USING ERRCODE = '55000';
    END IF;
    v_lech := app_private.profit_ledger_chan_changed_columns_v1(to_jsonb(OLD), to_jsonb(NEW), c_huy || c_luc_nao);
    IF cardinality(v_lech) > 0 THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_LOCKED: lệnh huỷ không được đổi các cột khác của phiếu chi theo sổ tổng'
        USING ERRCODE = '55000', DETAIL = jsonb_build_object('columns', v_lech)::text;
    END IF;
    RETURN NEW;
  END IF;

  -- Ngoài ngữ cảnh. Sổ quỹ chốt lúc lập: được có mặt trong SET (bước ghi sổ V2) nhưng không đổi.
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ACCOUNT_LOCKED: phiếu chi theo sổ tổng chỉ chi từ đúng sổ quỹ đã chọn lúc lập — không đổi sổ quỹ được, kể cả lúc ghi sổ'
      USING ERRCODE = '55000';
  END IF;

  -- Đường vòng bị cấm tường minh: Huỷ duyệt, Khôi phục, Hoàn tác, xoá mềm, Yêu cầu sửa / Tranh chấp /
  -- Gửi lại, và mọi đường huỷ khác E6.
  IF (OLD.approval_status = 'APPROVED' AND NEW.approval_status = 'UNAPPROVED')
     OR (OLD.approval_status = 'CANCELLED' AND NEW.approval_status IS DISTINCT FROM 'CANCELLED')
     OR (NEW.approval_status = 'CANCELLED' AND OLD.approval_status IS DISTINCT FROM 'CANCELLED')
     OR (NEW.posting_status = 'REVERSED' AND OLD.posting_status IS DISTINCT FROM 'REVERSED')
     OR NEW.reversed_by_posting_id IS DISTINCT FROM OLD.reversed_by_posting_id
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR (NEW.review_state IN ('CHANGES_REQUESTED', 'DISPUTED', 'PENDING')
         AND NEW.review_state IS DISTINCT FROM OLD.review_state) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_CANCEL_ONLY: phiếu chi theo sổ tổng không huỷ duyệt / khôi phục / hoàn tác / yêu cầu sửa / tranh chấp / huỷ theo đường thường được — muốn bỏ phiếu thì dùng lệnh huỷ có lý do'
      USING ERRCODE = '55000';
  END IF;

  v_buoc := CASE
    WHEN OLD.approval_status = 'UNAPPROVED' AND NEW.approval_status = 'APPROVED' THEN 'DUYET'
    WHEN OLD.approval_status = 'APPROVED' AND NEW.approval_status = 'APPROVED'
         AND NEW.posting_status = 'POSTED' AND OLD.posting_status IS DISTINCT FROM 'POSTED' THEN 'GHI_SO'
  END;

  v_lech := app_private.profit_ledger_chan_changed_columns_v1(to_jsonb(OLD), to_jsonb(NEW),
              c_luc_nao || CASE v_buoc WHEN 'DUYET' THEN c_duyet WHEN 'GHI_SO' THEN c_ghi_so ELSE ARRAY[]::text[] END);
  IF cardinality(v_lech) > 0
     OR (v_buoc = 'DUYET' AND NEW.review_state IS DISTINCT FROM OLD.review_state AND NEW.review_state IS DISTINCT FROM 'RESOLVED') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_LOCKED: phiếu chi theo sổ tổng đã khoá — chỉ được duyệt, ghi sổ, gắn ảnh / ghi chú, đánh dấu đã kiểm hoặc bàn giao tiền mặt'
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('columns', v_lech, 'step', v_buoc)::text;
  END IF;

  IF v_buoc IS NULL THEN
    RETURN NEW;
  END IF;

  -- Hai bước tiền: cờ phải CANONICAL; chỉ qua RPC vòng đời V2 — token FINANCE_V2_LIFECYCLE của chính giao
  -- dịch, cũng là điều làm cầu a85 đứng ngoài, nên không có bút toán nào sinh ra sau lưng chốt chặn này.
  PERFORM app_private.profit_ledger_chan_assert_route_v1(OLD.organization_id,
            CASE v_buoc WHEN 'DUYET' THEN 'duyệt' ELSE 'ghi sổ' END);
  v_token := EXISTS (
    SELECT 1 FROM app_private.ie_transition_authorization t
     WHERE t.income_expense_id = OLD.id
       AND t.xid = pg_current_xact_id()
       AND t.purpose = 'FINANCE_V2_LIFECYCLE');

  SELECT * INTO v_p FROM app_private.profit_ledger_payouts p WHERE p.voucher_id = OLD.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_NO_PAYOUT_ROW: phiếu mang nguồn sổ tổng nhưng thiếu dòng sổ — không duyệt / ghi sổ được, báo quản trị'
      USING ERRCODE = '55000';
  END IF;
  IF v_p.organization_id IS DISTINCT FROM OLD.organization_id
     OR v_p.shareholder_id IS DISTINCT FROM OLD.shareholder_id
     OR v_p.manager_id IS DISTINCT FROM OLD.profit_manager_id
     OR v_p.amount IS DISTINCT FROM OLD.total_amount
     OR v_p.account_id IS DISTINCT FROM OLD.account_id
     OR OLD.type IS DISTINCT FROM 'EXPENSE' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_VOUCHER_MISMATCH: phiếu không còn khớp dòng sổ lúc lập (người nhận, số tiền, sổ quỹ) — không duyệt / ghi sổ được, báo quản trị'
      USING ERRCODE = '55000';
  END IF;
  v_subject := COALESCE(v_p.shareholder_id, v_p.manager_id);

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ACTOR_REQUIRED: phải đăng nhập để duyệt / ghi sổ phiếu chi theo sổ tổng'
      USING ERRCODE = '42501';
  END IF;
  -- Người nhận = đăng nhập lúc lập (C2.payee_user_id) HOẶC đăng nhập HIỆN TẠI của cổ đông / người nhận lương điều hành
  -- (người được gắn đăng nhập sau khi lập vẫn là người nhận).
  v_payee_now := CASE v_p.subject_kind
    WHEN 'SHAREHOLDER' THEN (SELECT s.auth_user_id FROM public.shareholders s WHERE s.id = v_subject)
    ELSE (SELECT m.auth_user_id FROM public.profit_managers m WHERE m.id = v_subject) END;

  IF v_buoc = 'GHI_SO' THEN
    IF COALESCE(OLD.posting_status, 'UNPOSTED') <> 'UNPOSTED' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_REPOST: phiếu chi theo sổ tổng đã đảo bút toán thì không ghi sổ lại được — lập phiếu mới'
        USING ERRCODE = '55000';
    END IF;
    IF NOT v_token THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_V2_ONLY: phiếu chi theo sổ tổng chỉ duyệt / ghi sổ ở màn Chờ duyệt (Duyệt, Duyệt và Chi, Ghi sổ)'
        USING ERRCODE = '55000';
    END IF;
    -- Người giữ sổ tự ghi sổ phiếu tạm ứng của chính mình (người lập) sau khi chủ đã duyệt là đường đúng.
    -- 19/11/2026 (chủ chốt "làm đúng luồng thu chi"): phiếu CHỦ lập (maker_kind OWNER — phiếu tiền của lần chốt chi theo
    -- tháng, lương điều hành, phiếu E5 cũ): người nhận có quyền chi của đúng loại chủ thể THEO CẢ CÔNG TY tự ghi sổ được.
    -- Phép kiểm KHÔNG khoá dòng (authorized_scope_v3, theo auth.uid()): tới đây RPC ghi sổ đã giữ hàng phiếu rồi hàng sổ
    -- quỹ; khoá dòng công ty lúc này (authorize_tenant_action_v3) là đảo thứ tự khoá so với các lệnh khoá công ty trước rồi
    -- mới khoá sổ quỹ (lập / huỷ phiếu sổ tổng) ⇒ có thể kẹt khoá chéo. Chỉ hỏi khi người ghi sổ là người nhận.
    v_la_nhan := COALESCE(v_uid = v_p.payee_user_id OR v_uid = v_payee_now, false);
    IF v_la_nhan AND v_p.maker_kind = 'OWNER' THEN
      v_key := CASE v_p.subject_kind WHEN 'SHAREHOLDER' THEN 'shareholder_profit.distribute' ELSE 'shareholder_profit.pay_manager' END;
      v_chu_tu := COALESCE((SELECT bool_or(s.org_wide)
                              FROM app_private.authorized_scope_v3(v_key, OLD.organization_id) s), false);
    END IF;
    IF v_la_nhan
       AND NOT (v_p.maker_kind = 'CUSTODIAN_ADVANCE' AND v_uid = v_p.maker_user_id)
       AND NOT v_chu_tu THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_PAYEE_SELF_POST: người nhận tiền không tự ghi sổ (chi) phiếu chi lợi nhuận cho mình — cần người giữ sổ khác'
        USING ERRCODE = '42501';
    END IF;
    INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id, manager_id,
      voucher_id, amount, actor_id, payload)
    VALUES (OLD.organization_id, 'PAYOUT_POSTED', v_p.subject_kind, v_p.shareholder_id, v_p.manager_id,
      OLD.id, OLD.total_amount, v_uid,
      jsonb_build_object('posting_id', NEW.active_posting_id_v2, 'account_id', OLD.account_id,
                         'maker_kind', v_p.maker_kind, 'posting_status_before', OLD.posting_status)
      || CASE WHEN v_chu_tu THEN jsonb_build_object('owner_self', jsonb_build_object('payee', true)) ELSE '{}'::jsonb END);
    RETURN NEW;
  END IF;

  -- Bước DUYỆT.
  IF NOT app_private.profit_ledger_voucher_live_v1(OLD.id) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_VOUCHER_DEAD: phiếu đã bị từ chối / rút / đóng yêu cầu duyệt — không duyệt lại được; muốn bỏ phiếu thì dùng lệnh huỷ có lý do'
      USING ERRCODE = '55000';
  END IF;
  SELECT ar.id, ar.state INTO v_req
    FROM public.approval_requests ar
   WHERE ar.organization_id = OLD.organization_id
     AND ar.subject_type = 'FINANCIAL_VOUCHER'
     AND ar.subject_id = OLD.id
   ORDER BY ar.submission_no DESC
   LIMIT 1;
  IF v_req.id IS NULL OR v_req.state IS DISTINCT FROM 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_NO_PENDING_REQUEST: phiếu chi theo sổ tổng không còn yêu cầu duyệt đang chờ — không duyệt được'
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_token THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_V2_ONLY: phiếu chi theo sổ tổng chỉ duyệt / ghi sổ ở màn Chờ duyệt (Duyệt, Duyệt và Chi, Ghi sổ)'
      USING ERRCODE = '55000';
  END IF;
  -- Quyền chi của đúng loại chủ thể: tính TRƯỚC hai luật tự duyệt (19/11/2026). Cùng lời gọi sẵn có, cùng chỗ trong thứ tự
  -- khoá: RPC duyệt V2 đã khoá chia sẻ dòng công ty bằng chính hàm này (quyền duyệt thu chi) trước câu UPDATE. Câu báo, mã
  -- lỗi và thứ tự báo lỗi giữ nguyên: người lập → người nhận → thiếu quyền.
  v_key := CASE v_p.subject_kind WHEN 'SHAREHOLDER' THEN 'shareholder_profit.distribute' ELSE 'shareholder_profit.pay_manager' END;
  SELECT a.allowed INTO v_allowed
    FROM app_private.authorize_tenant_action_v3(v_uid, OLD.organization_id, v_key, OLD.building_id, OLD.account_id) a;
  -- Phiếu CHỦ lập (maker_kind OWNER) và người duyệt có quyền chi ⇒ người lập / người nhận (nick chủ) tự duyệt được (chủ chốt
  -- 19/11/2026). Phiếu tạm ứng (CUSTODIAN_ADVANCE / CUSTODIAN_FOR_PAYEE) giữ luật cũ: một chủ khác duyệt.
  v_chu_tu := COALESCE(v_p.maker_kind = 'OWNER', false) AND COALESCE(v_allowed, false);
  v_la_nhan := COALESCE(v_uid = v_p.payee_user_id OR v_uid = v_payee_now, false);
  IF v_uid = v_p.maker_user_id AND NOT v_chu_tu THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_MAKER_SELF_APPROVE: người lập phiếu không tự duyệt phiếu chi lợi nhuận của mình — cần một chủ khác duyệt'
      USING ERRCODE = '42501';
  END IF;
  IF v_la_nhan AND NOT v_chu_tu THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_PAYEE_SELF_APPROVE: người nhận tiền không tự duyệt phiếu chi lợi nhuận cho mình — cần một chủ khác duyệt'
      USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_APPROVE_FORBIDDEN: cần quyền % để duyệt phiếu chi theo sổ tổng', v_key
      USING ERRCODE = '42501', DETAIL = jsonb_build_object('permission', v_key)::text;
  END IF;
  IF (v_p.subject_kind = 'SHAREHOLDER' AND NOT EXISTS (
        SELECT 1 FROM public.shareholders s
         WHERE s.id = v_subject AND s.organization_id = OLD.organization_id AND s.deleted_at IS NULL AND s.is_active))
     OR (v_p.subject_kind = 'MANAGER' AND NOT EXISTS (
        SELECT 1 FROM public.profit_managers m
         WHERE m.id = v_subject AND m.organization_id = OLD.organization_id AND m.deleted_at IS NULL AND m.is_active)) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SUBJECT_GONE: người nhận đã bị xoá hoặc ngưng — không duyệt được, chỉ còn huỷ'
      USING ERRCODE = '55000';
  END IF;

  -- Thứ tự khoá v2: (đã giữ hàng phiếu) → khoá công ty → khoá sổ → đọc số dư → ghi.
  PERFORM app_private.lock_org_for_decision_v1(OLD.organization_id);
  PERFORM app_private.profit_ledger_lock_v1(OLD.organization_id, v_p.subject_kind, v_subject);
  v_bal := app_private.profit_ledger_balance_v1(OLD.organization_id, v_p.subject_kind, v_subject, OLD.id);
  v_before := (v_bal ->> 'balance')::numeric;
  v_within := LEAST(OLD.total_amount, GREATEST(v_before, 0));
  v_advance := OLD.total_amount - v_within;
  -- Cổ đông còn phiếu lương "cần chủ xem lại" (C4 NEEDS_REVIEW, phiếu lương còn sống): số dư chưa chắc ⇒ không duyệt
  -- (cùng luật với lệnh lập E5).
  IF v_p.subject_kind = 'SHAREHOLDER' AND COALESCE((v_bal -> 'needs_review' ->> 'count')::int, 0) > 0 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xác nhận phần lợi nhuận — xử lý xong rồi mới duyệt chi lợi nhuận'
      USING ERRCODE = '55000', DETAIL = (v_bal -> 'needs_review')::text;
  END IF;
  IF v_p.subject_kind = 'MANAGER' AND v_advance > 0 THEN
    RAISE EXCEPTION 'PROFIT_MANAGER_LEDGER_OVERDRAW: lương điều hành vượt số còn lại của sổ — không duyệt được'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('balance', v_before, 'amount', OLD.total_amount, 'over', v_advance)::text;
  END IF;

  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id, manager_id,
    voucher_id, amount, balance_before, balance_after, actor_id, payload)
  VALUES (OLD.organization_id, 'PAYOUT_APPROVED', v_p.subject_kind, v_p.shareholder_id, v_p.manager_id,
    OLD.id, OLD.total_amount, v_before, v_before - OLD.total_amount, v_uid,
    jsonb_build_object('within_amount', v_within, 'advance_amount', v_advance, 'request_id', v_req.id,
                       'at_create', jsonb_build_object('balance_before', v_p.balance_before,
                                                       'within_amount', v_p.within_amount,
                                                       'advance_amount', v_p.advance_amount))
    || CASE WHEN v_chu_tu AND (v_uid = v_p.maker_user_id OR v_la_nhan)
            THEN jsonb_build_object('owner_self', jsonb_build_object('maker', v_uid = v_p.maker_user_id, 'payee', v_la_nhan))
            ELSE '{}'::jsonb END);
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION app_private.guard_profit_ledger_payout_v1() IS
  'F1 (trigger a06_profit_ledger_payout_guard): phiếu chi theo sổ tổng chỉ được DUYỆT (route CANONICAL, qua RPC vòng đời V2, phiếu còn sống, có quyền chi; người duyệt khác người lập và người nhận — TRỪ phiếu chủ lập (maker_kind OWNER) khi người duyệt có quyền chi của đúng loại chủ thể: người lập / người nhận tự duyệt được, nhật ký ghi owner_self; khoá công ty → khoá sổ → tính lại, ghi PAYOUT_APPROVED) và GHI SỔ (CANONICAL, V2, đúng sổ quỹ lúc lập; người ghi khác người nhận, trừ người giữ sổ tự tạm ứng và TRỪ phiếu chủ lập khi người nhận có quyền chi của đúng loại chủ thể theo cả công ty — kiểm không khoá dòng; ghi PAYOUT_POSTED); lúc nào cũng cho đã kiểm / bàn giao / ảnh-ghi chú / cột máy tính; ngữ cảnh lập giữ chờ duyệt; ngữ cảnh huỷ chỉ sang CANCELLED; không xoá.';

-- Z. Hậu kiểm. Đúng ở cả lượt một lẫn lượt chạy lại.
DO $sau$
DECLARE
  c_f1 constant regprocedure := to_regprocedure('app_private.guard_profit_ledger_payout_v1()');
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p WHERE p.oid = c_f1) IS DISTINCT FROM '126c1ddc4cdd6acf6b9af64561d87794' THEN
    RAISE EXCEPTION 'Hậu kiểm: thân app_private.guard_profit_ledger_payout_v1() không phải bản của file này' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = c_f1 AND p.prorettype = 'trigger'::regtype AND p.pronargs = 0 AND NOT p.proretset
       AND p.prolang = (SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname = 'plpgsql')) THEN
    RAISE EXCEPTION 'Hậu kiểm: app_private.guard_profit_ledger_payout_v1() phải còn là hàm trigger plpgsql không tham số'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT COALESCE(p.proacl::text, '<mặc định>') || ' | ' || p.proowner::regrole::text || ' | ' || p.prosecdef::text
             || ' | ' || p.provolatile::text || ' | ' || COALESCE(p.proconfig::text, '<không>')
        FROM pg_catalog.pg_proc p WHERE p.oid = c_f1)
     IS DISTINCT FROM current_setting('ihomecrm.chu_tu_duyet_chi.f1', true) THEN
    RAISE EXCEPTION 'Hậu kiểm: ACL / chủ hàm / SECURITY DEFINER / volatility / search_path của app_private.guard_profit_ledger_payout_v1() đổi so với trước khi chạy'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgname = 'a06_profit_ledger_payout_guard' AND t.tgrelid = to_regclass('public.income_expenses')
       AND t.tgfoid = c_f1 AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'Hậu kiểm: trigger a06_profit_ledger_payout_guard không còn gắn F1' USING ERRCODE = '55000';
  END IF;
  IF position('TRỪ phiếu chủ lập' IN COALESCE(obj_description(c_f1, 'pg_proc'), '')) = 0 THEN
    RAISE EXCEPTION 'Hậu kiểm: COMMENT của app_private.guard_profit_ledger_payout_v1() chưa nêu luật mới' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
