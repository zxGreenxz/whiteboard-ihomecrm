-- t5_10_contract_termination_writers.sql — Duyệt/Từ chối thanh lý hợp đồng (P1)
--
-- BUG-FIX sản xuất kèm hardening: useApproveTermination legacy là cascade 5 bước
-- client-side, bước 4 insert vào public.cash_book — bảng ĐÃ KHÔNG TỒN TẠI → mọi
-- lần duyệt thanh lý có refund_amount ≠ 0 vỡ giữa chừng (terminations COMPLETED,
-- contracts TERMINATED nhưng KHÔNG có bút toán tiền + phòng kẹt OCCUPIED).
--
-- Thiết kế approve_contract_termination_v1 (atomic, all-or-nothing):
--  1. terminations → APPROVED (approved_by/at)
--  2. contracts → TERMINATED
--  3. terminations → COMPLETED (refund_date)
--  4. refund_amount ≠ 0 → ghi tiền qua PHIẾU THU/CHI hiện đại (thay cash_book):
--       >0: phiếu CHI hạng mục hoàn-thanh-lý;  <0: phiếu THU (khách trả thêm)
--     Phiếu tạo ở trạng thái NHÁP (UNAPPROVED, chưa gán sổ quỹ) — kế toán chọn
--     sổ quỹ rồi duyệt ở trang Thu chi (đúng rule "chưa có sổ quỹ không duyệt").
--     Hạng mục resolve theo danh sách ưu tiên trong org; KHÔNG có → ABORT toàn
--     bộ (không như legacy vỡ nửa chừng).
--  5. rooms → AVAILABLE
-- Idempotent: termination đã COMPLETED → no-op trả trạng thái hiện tại.
--
-- Permission PARITY policy contract_terminations_update_rbac:
--   is_super_admin() OR can_do_on_building('contracts','edit', building_of_contract(contract_id))
--
-- reject_contract_termination_v1: mirror legacy useRejectTermination —
--   status → 'DRAFT' + prefix notes '[Từ chối] <lý do>' (không phải REJECTED).

begin;

create or replace function public.approve_contract_termination_v1(
  p_termination_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_term public.contract_terminations%rowtype;
  v_contract public.contracts%rowtype;
  v_building uuid;
  v_refund numeric;
  v_type_id uuid;
  v_voucher_id uuid;
  v_voucher_kind text;
  v_type_names text[];
  v_desc text;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_term from public.contract_terminations
   where id = p_termination_id for update;
  if not found then
    raise exception 'Không tìm thấy yêu cầu thanh lý hoặc bạn không có quyền' using errcode = '42501';
  end if;

  select * into v_contract from public.contracts
   where id = v_term.contract_id for update;
  if not found then
    raise exception 'Hợp đồng của yêu cầu thanh lý không còn tồn tại';
  end if;

  -- contracts KHÔNG có cột building_id — toà suy qua phòng (helper chuẩn RLS).
  v_building := public.building_of_contract(v_contract.id);
  if not (public.is_super_admin()
          or public.can_do_on_building('contracts', 'edit', v_building)) then
    raise exception 'Không có quyền duyệt thanh lý hợp đồng này' using errcode = '42501';
  end if;

  if v_term.status = 'COMPLETED' then
    return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                              'voucher_id', null, 'noop', true);
  end if;

  select coalesce(nullif(btrim(full_name), ''), nullif(btrim(email), ''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  -- 1-3: chuỗi trạng thái (giữ nguyên thứ tự legacy, nay atomic trong 1 tx)
  update public.contract_terminations
     set status = 'APPROVED', approved_by = v_actor, approved_at = now()
   where id = v_term.id;

  update public.contracts
     set status = 'TERMINATED', updated_at = now()
   where id = v_contract.id;

  update public.contract_terminations
     set status = 'COMPLETED', refund_date = now()
   where id = v_term.id;

  -- 4: bút toán tiền (thay cash_book đã chết) — phiếu NHÁP chờ kế toán
  v_refund := coalesce(v_term.refund_amount, 0);
  if v_refund <> 0 then
    if v_refund > 0 then
      v_voucher_kind := 'EXPENSE';
      v_type_names := array['Hoàn cọc / tiền thừa khi thanh lý',
                            'Hoàn trả thanh lý',
                            'Hoàn cọc thanh lý',
                            'Hoàn tiền thừa thanh lý'];
      v_desc := 'Hoàn cọc thanh lý hợp đồng';
    else
      v_voucher_kind := 'INCOME';
      v_type_names := array['Thu thanh lý (khách trả thêm)',
                            'Doanh thu thanh lý'];
      v_desc := 'Thu thêm từ thanh lý hợp đồng';
    end if;

    -- Resolve hạng mục trong org theo thứ tự ưu tiên; trùng tên → bản cũ nhất.
    select t.id into v_type_id
      from public.income_expense_types t
     where t.organization_id = v_term.organization_id
       and lower(t.type) = lower(v_voucher_kind)
       and t.name = any (v_type_names)
     order by array_position(v_type_names, t.name), t.created_at
     limit 1;
    if v_type_id is null then
      raise exception 'Org chưa có hạng mục "%" cho bút toán thanh lý — tạo hạng mục rồi duyệt lại',
        v_type_names[1];
    end if;

    insert into public.income_expenses (
      user_id, creator_name, type, name,
      building_id, room_id, contract_id, account_id,
      payer_name, approval_status, voucher_date, attachments,
      notes, organization_id
    ) values (
      v_actor, coalesce(v_actor_name, 'Người dùng'), v_voucher_kind,
      v_desc || ' ' || coalesce(v_contract.contract_number, left(v_contract.id::text, 8)),
      v_building, v_contract.room_id, v_contract.id, null,
      null, 'UNAPPROVED', current_date, '[]'::jsonb,
      nullif(btrim(coalesce(p_note, '')), ''), v_term.organization_id
    ) returning id into v_voucher_id;

    insert into public.income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, start_date, end_date
    ) values (
      v_voucher_id, v_type_id,
      v_desc || ' (yêu cầu ' || left(v_term.id::text, 8) || ')',
      1, abs(v_refund), current_date, current_date
    );
  end if;

  -- 5: trả phòng
  if v_contract.room_id is not null then
    update public.rooms set status = 'AVAILABLE' where id = v_contract.room_id;
  end if;

  return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                            'voucher_id', v_voucher_id, 'room_id', v_contract.room_id);
end;
$$;

revoke all on function public.approve_contract_termination_v1(uuid, text) from public;
revoke all on function public.approve_contract_termination_v1(uuid, text) from anon;
grant execute on function public.approve_contract_termination_v1(uuid, text) to authenticated;

create or replace function public.reject_contract_termination_v1(
  p_termination_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_term public.contract_terminations%rowtype;
  v_building uuid;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_term from public.contract_terminations
   where id = p_termination_id for update;
  if not found then
    raise exception 'Không tìm thấy yêu cầu thanh lý hoặc bạn không có quyền' using errcode = '42501';
  end if;

  v_building := public.building_of_contract(v_term.contract_id);
  if not (public.is_super_admin()
          or public.can_do_on_building('contracts', 'edit', v_building)) then
    raise exception 'Không có quyền từ chối yêu cầu thanh lý này' using errcode = '42501';
  end if;

  if v_term.status = 'COMPLETED' then
    raise exception 'Yêu cầu đã hoàn tất thanh lý — không thể từ chối';
  end if;

  -- Mirror legacy: trả về DRAFT (không phải REJECTED) + prefix lý do vào notes.
  update public.contract_terminations
     set status = 'DRAFT',
         notes = case when nullif(btrim(coalesce(p_reason, '')), '') is not null
                      then '[Từ chối] ' || btrim(p_reason)
                      else notes end
   where id = v_term.id;
end;
$$;

revoke all on function public.reject_contract_termination_v1(uuid, text) from public;
revoke all on function public.reject_contract_termination_v1(uuid, text) from anon;
grant execute on function public.reject_contract_termination_v1(uuid, text) to authenticated;

commit;
