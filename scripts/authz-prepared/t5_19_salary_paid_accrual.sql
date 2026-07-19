-- t5_19_salary_paid_accrual.sql — D1b: tự "gạch tên đã trả" khi phiếu lương duyệt
--
-- OWNER CHỐT D1b: sau khi phiếu chi lương được DUYỆT (APPROVED — dù qua engine
-- duyệt hay đường thường), tự cập nhật salary_monthly.paid + payout_voucher_id
-- cho đúng nhân viên/kỳ. Vá "khe hở accrual" đã ghi ở
-- FINDING-ENGINE-APPROVAL-PAYOUT-BLOCKER (post_financial_request_v1 KHÔNG đụng
-- salary_monthly; không hàm nào stamp payout_voucher_id).
--
-- CƠ CHẾ (phương án (a) trong finding): trigger AFTER UPDATE trên income_expenses
--   khi phiếu là phiếu CHI LƯƠNG (salary_staff_id NOT NULL) chuyển sang APPROVED.
--   • Cộng dồn paid += "tiền thực nhận" của phiếu (dòng item 'Tiền thực nhận' nếu
--     có — để KHÔNG cộng nhầm dòng "tiền phòng khấu trừ"; không có dòng đó thì lấy
--     total_amount của phiếu).
--   • Stamp payout_voucher_id = phiếu này (nếu cột đang trống).
--   • Kỳ (period_month) suy từ salary_monthly của staff GẦN NHẤT ≤ voucher_date,
--     ưu tiên đúng tháng voucher_date. Idempotent: nếu payout_voucher_id đã = phiếu
--     này thì bỏ qua (tránh cộng kép khi UPDATE lặp).
--   • Khi phiếu BỎ DUYỆT/HUỶ (APPROVED→khác) và payout_voucher_id đang trỏ phiếu
--     này: trừ lại paid + gỡ payout_voucher_id (đối xứng — mở khoá/huỷ trả sạch).
--
-- CHỈ đụng salary_monthly (bảng bookkeeping, không phải bảng tiền thật). An toàn
-- với mọi đường tạo phiếu lương (legacy salary_payout hiện tại + canonical tương lai).

begin;

create or replace function app_private.accrue_salary_paid_on_approve()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_take_home numeric;
  v_period date;
  v_sm_id uuid;
begin
  -- Chỉ quan tâm phiếu CHI LƯƠNG (gắn nhân viên hưởng lương).
  if new.salary_staff_id is null then
    return new;
  end if;

  -- ── Trở thành APPROVED ──────────────────────────────────────────────
  if new.approval_status = 'APPROVED'
     and coalesce(old.approval_status,'') is distinct from 'APPROVED' then

    -- "Tiền thực nhận": ưu tiên dòng item có tên đó (phiếu tách 2 dòng khi gạch
    -- nợ tiền phòng); không có → tổng phiếu.
    select coalesce(
             (select sum(it.amount) from public.income_expense_items it
               where it.income_expense_id = new.id
                 and it.description = 'Tiền thực nhận'),
             new.total_amount, 0)
      into v_take_home;

    -- KỲ LƯƠNG — nguồn đúng là DẤU payout_voucher_id do writer đóng lúc submit
    -- (chi-trước lương tháng sau: voucher_date KHÔNG suy ra được kỳ — bug bắt được
    -- test B2 2026-07-19: phiếu kỳ 08 trả ngày 19/07 bị gạch nhầm kỳ 06).
    -- Fallback heuristic theo voucher_date CHỈ cho phiếu legacy (không có dấu).
    select id into v_sm_id from public.salary_monthly
     where payout_voucher_id = new.id limit 1;
    if v_sm_id is null then
      select id into v_sm_id
        from public.salary_monthly
       where staff_id = new.salary_staff_id
         and period_month <= date_trunc('month', new.voucher_date)::date
       order by period_month desc
       limit 1;
    end if;

    if v_sm_id is not null then
      -- Chuyển-trạng-thái thuần: mỗi lần VÀO APPROVED cộng đúng 1 lần (WHEN đã
      -- chặn APPROVED→APPROVED). Stamp chỉ bổ sung khi trống (phiếu legacy).
      update public.salary_monthly
         set paid = coalesce(paid,0) + coalesce(v_take_home,0),
             payout_voucher_id = coalesce(payout_voucher_id, new.id)
       where id = v_sm_id;
    end if;
    return new;
  end if;

  -- ── Rời APPROVED (bỏ duyệt / huỷ): trừ lại — đối xứng với nhánh cộng ──
  if coalesce(old.approval_status,'') = 'APPROVED'
     and new.approval_status is distinct from 'APPROVED' then
    select coalesce(
             (select sum(it.amount) from public.income_expense_items it
               where it.income_expense_id = new.id
                 and it.description = 'Tiền thực nhận'),
             new.total_amount, 0)
      into v_take_home;
    -- Trừ trên CÙNG row nhánh cộng đã chọn: ưu tiên DẤU, fallback heuristic.
    -- KHÔNG xoá dấu (writer sở hữu linkage; trigger chỉ mirror tiền) — nhờ đó
    -- duyệt lại sau khi bỏ duyệt vẫn tìm đúng kỳ.
    select id into v_sm_id from public.salary_monthly
     where payout_voucher_id = new.id limit 1;
    if v_sm_id is null then
      select id into v_sm_id
        from public.salary_monthly
       where staff_id = new.salary_staff_id
         and period_month <= date_trunc('month', new.voucher_date)::date
       order by period_month desc
       limit 1;
    end if;
    if v_sm_id is not null then
      update public.salary_monthly
         set paid = greatest(coalesce(paid,0) - coalesce(v_take_home,0), 0)
       where id = v_sm_id;
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists a70_salary_paid_accrual on public.income_expenses;
create trigger a70_salary_paid_accrual
  after update on public.income_expenses
  for each row
  when (new.salary_staff_id is not null)
  execute function app_private.accrue_salary_paid_on_approve();

commit;
