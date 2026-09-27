-- P1a.1: preserve legacy money/authority/replay and lock order; reject new effects
-- on deleted/ended contracts or inconsistent organization linkage.
-- Exact captured definition hashes and metadata fail closed on deployment drift.
DO $migration$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.approve_contract_termination_v1(uuid,text)')
    AND pg_get_userbyid(p.proowner) = 'postgres'
    AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
    AND p.prosecdef AND p.provolatile = 'v'
    AND p.proconfig = ARRAY['search_path=pg_catalog, public, app_private']::text[]
    AND pg_get_function_result(p.oid) = 'jsonb';
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'approve_contract_termination_v1 metadata drift';
  END IF;
  IF md5(v_definition) = 'e5bec0c847f543bb1df1213336cc75fa' THEN RETURN; END IF;
  IF md5(v_definition) <> '750d2d72248d9557713ff6c82eedfe51' THEN
    RAISE EXCEPTION 'approve_contract_termination_v1 definition drift';
  END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1(p_termination_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_term public.contract_terminations%rowtype;
  v_contract public.contracts%rowtype;
  v_building uuid;
  v_refund numeric;
  v_refund_raw numeric;
  v_deposit_real numeric;
  v_capped boolean := false;
  v_notes text;
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

  -- Validate the locked termination/contract against the room/building scope.
  -- Snapshot consistency only: this bounded patch adds no room/building locks.
  if v_term.organization_id is null
     or v_term.organization_id is distinct from v_contract.organization_id
     or not exists (
       select 1 from public.rooms r
       join public.buildings b on b.id = r.building_id
       where r.id = v_contract.room_id
         and r.organization_id = v_contract.organization_id
         and b.organization_id = v_contract.organization_id
     ) then
    raise exception 'Phạm vi yêu cầu thanh lý không khớp hợp đồng, phòng hoặc tòa nhà'
      using errcode = '42501';
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

  -- Authorized COMPLETED replay above remains an exact no-op.
  if v_contract.deleted_at is not null
     or v_contract.status not in ('ACTIVE', 'EXTENDED') then
    raise exception 'Hợp đồng không còn đủ điều kiện duyệt thanh lý'
      using errcode = '55000';
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
  --
  -- [H2.3a] contract_terminations.refund_amount là cột GENERATED:
  --     refund_amount = total_deposit − (công nợ + tiền thuê + phí + …)
  -- total_deposit là cọc GHI TRÊN HỒ SƠ, không phải cọc đã vào két. Ký cọc
  -- 10tr, mới đóng 4tr, không khấu trừ gì ⇒ cột ra 10tr và phiếu chi cũ ghi
  -- đúng 10tr: chi ra 6tr chưa từng thu. preview_termination_refund_v1 đã báo
  -- đúng việc này (VUOT_COC_THAT) nhưng chỉ là cảnh báo trên màn hình, writer
  -- vẫn ghi theo cột. Nay kẹp cứng ở writer theo cọc THỰC NHẬN.
  --
  -- Chỉ KẸP, không tính lại: kẹp là chặn trên đơn điệu, không bao giờ ghi
  -- nhiều hơn hôm nay. Phần chênh còn lại (khấu trừ vốn đã trừ trên cọc thoả
  -- thuận) là bài toán của đường thanh lý mới — đợt 4 plan 2 hoàn cọc đang tạm
  -- dừng theo quyết định chủ 28/08/2026.
  v_refund_raw := coalesce(v_term.refund_amount, 0);
  v_refund := v_refund_raw;
  if v_refund > 0 then
    v_deposit_real := coalesce(public.contract_deposit_paid_derived(v_contract.id), 0);
    if v_refund > v_deposit_real then
      v_refund := v_deposit_real;
      v_capped := true;
    end if;
  end if;

  v_notes := nullif(btrim(coalesce(p_note, '')), '');
  if v_capped then
    v_notes := coalesce(v_notes || E'\n', '')
      || '[Kẹp theo cọc thực nhận] Hồ sơ thanh lý tính hoàn '
      || round(v_refund_raw)::bigint || 'đ theo cọc thoả thuận, nhưng cọc THỰC NHẬN '
      || 'của hợp đồng chỉ có ' || round(v_deposit_real)::bigint
      || 'đ. Phiếu ghi theo cọc thực nhận. Chênh '
      || round(v_refund_raw - v_deposit_real)::bigint
      || 'đ là khoản chưa từng vào két — muốn hoàn thì phải có phiếu thu cọc đứng sau.';
  end if;

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
      null, 'UNAPPROVED', public.org_today_v1(NULL), '[]'::jsonb,
      v_notes, v_term.organization_id
    ) returning id into v_voucher_id;

    -- [H2.3b] Truyền `amount` tường minh. Hôm nay trigger auto_calc_item_amount
    -- ghi đè amount := quantity * unit_price nên giá trị này trùng khít; đó
    -- đúng là lý do phải viết ra — lúc H3.1 gỡ ghi đè, call-site đã sẵn sàng
    -- chứ không đẻ ra item amount NULL.
    insert into public.income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, amount, start_date, end_date
    ) values (
      v_voucher_id, v_type_id,
      v_desc || ' (yêu cầu ' || left(v_term.id::text, 8) || ')',
      1, abs(v_refund), abs(v_refund), public.org_today_v1(NULL), public.org_today_v1(NULL)
    );
  end if;

  -- 5: trả phòng
  --
  -- [H2.3c] Trước đây: update rooms set status='AVAILABLE' VÔ ĐIỀU KIỆN. Hai
  -- thứ bị cướp:
  --   · hợp đồng còn hiệu lực KHÁC trên cùng phòng (ở ghép / chồng kỳ) — phòng
  --     đang OCCUPIED bị trả trống dù còn người ở;
  --   · cờ RESERVED của khách kế đã đặt cọc giữ chỗ.
  -- Dòng dưới dùng ĐÚNG predicate NOT EXISTS của trigger
  -- update_room_status_on_contract_change (plan con F sở hữu trigger đó — ở đây
  -- chỉ chép predicate, không sửa trigger), rồi gọi helper chuẩn để dựng lại
  -- RESERVED. recompute_room_reservation tự bỏ qua MAINTENANCE/UNAVAILABLE và
  -- tự nhường phòng còn hợp đồng hiệu lực, nên gọi lại luôn an toàn.
  if v_contract.room_id is not null then
    update public.rooms
       set status = 'AVAILABLE', updated_at = now()
     where id = v_contract.room_id
       and not exists (
         select 1 from public.contracts c
          where c.room_id = v_contract.room_id
            and c.deleted_at is null
            and c.status in ('ACTIVE', 'EXTENDED')
            and c.id <> v_contract.id
       );

    perform public.recompute_room_reservation(v_contract.room_id);
  end if;

  return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                            'voucher_id', v_voucher_id, 'room_id', v_contract.room_id,
                            'refund_amount', v_refund,
                            'refund_amount_requested', v_refund_raw,
                            'refund_capped', v_capped);
end;
$function$
$definition$;
  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.approve_contract_termination_v1(uuid,text)')
    AND pg_get_userbyid(p.proowner) = 'postgres'
    AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
    AND p.prosecdef AND p.provolatile = 'v'
    AND p.proconfig = ARRAY['search_path=pg_catalog, public, app_private']::text[]
    AND pg_get_function_result(p.oid) = 'jsonb';
  IF v_definition IS NULL OR md5(v_definition) <> 'e5bec0c847f543bb1df1213336cc75fa' THEN
    RAISE EXCEPTION 'approve_contract_termination_v1 postcondition drift';
  END IF;
END
$migration$;
