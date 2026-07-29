-- 20260729151000_notify_helpers.sql
-- PR-4b — §B.1: hai hàm dùng chung cho hệ thông báo. Một transaction, chạy lại nhiều lần không lỗi.
--   1) app_private.ie_approver_ids_v1   — bộ giải "ai duyệt được phiếu này" (§B.1a).
--   2) app_private.notif_actor_label_v1 — nhãn người thao tác cho nội dung thông báo (§B.1b).
--
-- 🔴 ĐÃ BỎ phần chèn `assert_no_engine_request_v1` vào approve_income_expense_v2 /
--    reject_invalid_income_expense_v2 mà §0.4(A) của plan đề xuất. LÝ DO — guard đó GÂY HẠI:
--
--    (a) `list_my_pending_approvals_v1()` theo cấu tạo CHỈ trả dòng
--        `state='PENDING_APPROVAL' AND subject_type='FINANCIAL_VOUCHER'` — tức ĐÚNG BẰNG điều kiện
--        guard raise. Sau khi chèn, bấm "Duyệt" trên chính màn Chờ duyệt (ApprovalsPage.tsx:114
--        chọn nhánh v2 vì flag income_expense.workflow.v2 = ON ở cả hai org) sẽ ăn 55000 với thông
--        điệp bảo người dùng "hãy xử lý tại màn hình Chờ duyệt" — đúng màn hình họ đang đứng.
--        ⇒ KHÔNG CÒN ĐƯỜNG NÀO duyệt yêu cầu engine từ UI. Hôm nay 0 dòng PENDING_APPROVAL nên nó
--        nổ ngầm, và sẽ nổ đúng lần đầu engine đẻ request mới (chi lương / chia lợi nhuận).
--    (b) `approve_and_post_income_expense_v2` — nút "Duyệt và Thu/Chi" NGAY CẠNH — không có guard
--        và vẫn nhảy cóc engine. Chèn guard = hỏng nút đúng, để hở nút sai ⇒ TỆ HƠN trước khi vá.
--
--    Bộ 5 sự kiện KHÔNG cần guard này: E1 đã loại trừ phiếu có approval_requests PENDING_APPROVAL
--    ngay trong CTE `pend` (§B.2 điểm 5), nên nó không lùa ai vào đường tắt.
--    Lỗ "duyệt tắt engine" là nợ CÓ SẴN, không do đợt thông báo tạo ra; muốn vá phải vá ĐỒNG BỘ cả
--    họ hàm (approve_and_post / cancel_unposted / withdraw / ie_compat_cancel / cancel_flex /
--    cancel_v1) trong một đợt riêng, kèm đường thoát cho màn Chờ duyệt.

begin;

-- =============================================================================
-- 1) §B.1a — app_private.ie_approver_ids_v1
-- =============================================================================
-- VOLATILE + language plpgsql, KHÔNG `sql stable`: authorize_tenant_action_v3 là VOLATILE
-- và chạy `SELECT … FOR SHARE` trên public.organizations (chứng minh: `begin read only;
-- select … atav3(…)` → ERROR 25006). Khai STABLE là ngược nghĩa, và một SQL function bị
-- inline có nguy cơ kéo rowMark trồi lên plan.
--
-- CỐ Ý KHÔNG gọi app_private.lock_org_for_decision_v1: hợp đồng đó dùng để tuần tự hoá
-- QUYẾT ĐỊNH uỷ quyền; đây chỉ là chọn người nhận thông báo. Đọc authorization_version hơi
-- cũ là chấp nhận được, đổi lại không kéo thêm điểm serialize vào mọi giao dịch ghi tiền.
-- Án lệ: reject_invalid_income_expense_v2 cũng gọi atav3 mà không lock.
--
-- CỐ Ý bỏ nhánh public.is_super_admin(): chủ dự án là super admin toàn cục kiêm thành viên
-- org DEMO — thêm nhánh này là kéo lại đúng loại nhiễu xuyên-tenant đang đi vá.
--
-- ĐO THẬT 29/07 (18 phiếu đang chờ, chạy trong begin…rollback): fan-out = ĐÚNG 1 người/phiếu ở
-- CẢ HAI org, không phải 4/7 như §B.1a ước lượng (4/7 là số THÀNH VIÊN, không phải số người có
-- quyền duyệt). Chỉ member_type=OWNER được ROLE_ALLOW; mọi member khác DEFAULT_DENY.
-- 3/18 phiếu có người duyệt duy nhất CHÍNH LÀ người lập (PC2607153 org thật; PC2607008, PC2607010
-- DEMO) ⇒ loại trừ maker sẽ ra mảng rỗng — nhánh notify_no_recipient_v1 ở §B.2 là có thật, không
-- phải phòng xa. Chi phí đo được ~17 ms/lượt gọi trên prod (spec ghi 6,4 ms).
drop function if exists app_private.ie_approver_ids_v1(uuid, uuid, uuid[]);

create function app_private.ie_approver_ids_v1(
  p_org uuid,
  p_building uuid,
  p_exclude uuid[] default '{}'::uuid[]
)
returns uuid[]
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v  uuid[];
  ex uuid[];
begin
  -- 🔴 LỌC PHẦN TỬ NULL khỏi p_exclude trước khi dùng.
  -- `coalesce(p_exclude,'{}')` chỉ chống MẢNG null, KHÔNG chống PHẦN TỬ null: với
  -- p_exclude = array[NULL, maker] thì `m.user_id = any(...)` trả NULL, `not NULL` = NULL,
  -- và WHERE loại sạch mọi dòng ⇒ hàm trả '{}' IM LẶNG, không lỗi. Đúng bẫy §0.3 điểm 2.
  -- Nơi gọi hôm nay dùng array_remove(...) nên may mắn an toàn, nhưng §B.4 của đặc tả viết
  -- nguyên văn `array[v_actor, v_maker]` — vá ở đây là chỗ rẻ nhất và chống được cả hai.
  ex := coalesce(
          array(select x from unnest(coalesce(p_exclude, '{}'::uuid[])) x where x is not null),
          '{}'::uuid[]);

  select coalesce(array_agg(distinct m.user_id), '{}'::uuid[]) into v
    from public.organization_memberships m
   where m.organization_id = p_org
     and m.status = 'ACTIVE'
     and not (m.user_id = any(ex))
     and (select a.allowed from app_private.authorize_tenant_action_v3(
            m.user_id, p_org, 'income_expenses.approve', p_building, null) a);
  return v;
end
$fn$;

comment on function app_private.ie_approver_ids_v1(uuid, uuid, uuid[]) is
  'Trả về user_id của những thành viên ACTIVE có income_expenses.approve trong phạm vi toà nhà. '
  'Dùng để chọn người nhận thông báo E1/E3. Không lock org, không nhánh super admin (§B.1a).';

revoke all on function app_private.ie_approver_ids_v1(uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;

-- =============================================================================
-- 2) §B.1b — app_private.notif_actor_label_v1
-- =============================================================================
-- p_uid IS NULL → trả NULL ⇒ nơi gọi phải bọc coalesce(…, 'hệ thống').
drop function if exists app_private.notif_actor_label_v1(uuid);

create function app_private.notif_actor_label_v1(p_uid uuid)
returns text
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
  select coalesce(nullif(u.raw_user_meta_data->>'full_name', ''),
                  split_part(u.email, '@', 1),
                  'hệ thống')
    from auth.users u
   where u.id = p_uid;
$fn$;

comment on function app_private.notif_actor_label_v1(uuid) is
  'Nhãn hiển thị của người thao tác cho nội dung thông báo. NULL uid → NULL (§B.1b).';

revoke all on function app_private.notif_actor_label_v1(uuid)
  from public, anon, authenticated, service_role;


commit;
