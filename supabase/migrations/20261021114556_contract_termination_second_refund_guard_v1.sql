-- ============================================================
-- Vá lỗ "phiếu hoàn cọc thứ hai" ở thanh lý hợp đồng (P0a, chủ duyệt 21/10/2026).
--
-- LỖ
--   Người có contracts.create ở một toà INSERT được một dòng contract_terminations DRAFT
--   qua REST: guard a00_contract_termination_settlement_guard chỉ chặn APPROVED/COMPLETED,
--   policy INSERT là contracts.create. Rồi người có contracts.edit gọi
--   approve_contract_termination_v1 với dòng đó. Hàm không hỏi hợp đồng đã trả phòng hay đã
--   thanh lý chưa ⇒ ghi thêm một phiếu hoàn (hoặc thu) nháp, system_source rỗng, cho hợp
--   đồng ĐÃ quyết toán hoặc đang chờ quyết toán. UNIQUE(contract_id) chỉ chặn khi hợp đồng
--   đã có dòng contract_terminations — ca "trả phòng, quyết toán sau" (contract_exit_cases
--   DEFERRED) chưa có dòng nào, và dòng DRAFT chen vào còn chiếm chỗ khiến
--   finalize_contract_exit_case_v1 kẹt 23505.
--   Đo production 21/10/2026 (chỉ đọc, chỉ đếm): 24 hợp đồng TERMINATED chưa có dòng
--   contract_terminations (1 đang chờ quyết toán DEFERRED); contract_terminations chỉ có
--   dòng COMPLETED; chưa phiếu nào từng sinh từ đường duyệt này; 0 hợp đồng ACTIVE có
--   actual_end_date. Web không còn gọi hàm (useApproveTermination không nơi dùng).
--
-- VÁ
--   (a) approve_contract_termination_v1: sau khi khoá hợp đồng và kiểm quyền, từ chối 55000
--       khi hợp đồng không còn ACTIVE/EXTENDED, đã có actual_end_date, đã xoá mềm, hoặc đã có
--       contract_exit_cases. Thân còn lại giữ NGUYÊN từng chữ bản đang chạy (20260915074638,
--       md5 production 750d2d72…). Chữ ký, kiểu trả về, ACL không đổi (CREATE OR REPLACE).
--   (b) Trigger mới a01_contract_termination_open_contract_guard, chỉ trên đường REST
--       (WHEN current_user IN ('authenticated','anon'), cùng ranh giới với guard a00): hồ sơ
--       mới, hoặc hồ sơ bị chuyển sang hợp đồng khác, phải trỏ tới hợp đồng còn hiệu lực và
--       chưa có ca trả phòng. Hàm trigger SECURITY DEFINER ở app_private vì authenticated
--       không có quyền đọc contract_exit_cases và RLS có thể che hợp đồng. Chỉ trả lời người
--       mà RLS sẽ cho ghi (super admin, hoặc cùng công ty và có contracts.create khi INSERT /
--       contracts.edit khi UPDATE ở toà đó — đúng vế policy); ngoài phạm vi để RLS từ chối,
--       không lộ trạng thái. Hàm khoá dòng hợp đồng FOR SHARE
--       để không chen được giữa lúc kiểm và lúc confirm_contract_return_v1 (khoá FOR UPDATE)
--       ghi trả phòng.
--       Tách trigger riêng thay vì sửa guard_contract_termination_settlement: guard cũ giữ
--       nguyên từng chữ, lùi chỉ cần một DROP TRIGGER.
--
-- KHÔNG ĐỔI
--   Policy INSERT của contract_terminations (vẫn contracts.create) — đề xuất đổi để riêng.
--   Writer SECURITY DEFINER (trả phòng, bỏ cọc, quyết toán ca trả phòng) chạy dưới chủ hàm ⇒
--   WHEN của (b) không khớp; (a) không nằm trên đường của chúng. Không sửa dữ liệu.
--
-- ĐƯỜNG LÙI (một forward migration khác, không phá dữ liệu)
--   DROP TRIGGER IF EXISTS a01_contract_termination_open_contract_guard ON public.contract_terminations;
--   DROP FUNCTION IF EXISTS app_private.guard_contract_termination_open_contract_v1();
--   CREATE OR REPLACE public.approve_contract_termination_v1 bằng thân ở mục 3 của
--   20260915074638_coc_thanh_ly_va_cap_hoan_coc.sql.
-- ============================================================

-- 0. Tiền kiểm — không vá mù lên một định nghĩa lạ.
DO $preflight$
DECLARE
  v_def text;
BEGIN
  IF to_regprocedure('public.approve_contract_termination_v1(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu approve_contract_termination_v1(uuid,text) — DỪNG.' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.has_contract_termination_write_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu has_contract_termination_write_v1(uuid) — DỪNG.' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.my_org_ids()') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('app_private.buildings_for_v3(text)') IS NULL
     OR to_regprocedure('public.building_of_contract(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu helper phạm vi (my_org_ids / is_super_admin / buildings_for_v3 / building_of_contract) — DỪNG.' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.contract_exit_cases') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng contract_exit_cases — DỪNG.' USING ERRCODE = '55000';
  END IF;

  -- Thân đọc bằng pg_get_functiondef trên production 21/10/2026 (chỉ đọc), khớp từng chữ
  -- mục 3 của 20260915074638; production không có CR trong thân.
  v_def := pg_get_functiondef('public.approve_contract_termination_v1(uuid, text)'::regprocedure);
  IF position('[TERMINATION_CONTRACT_CLOSED]' IN v_def) > 0 THEN
    RAISE NOTICE 'approve_contract_termination_v1 đã vá — replace lại bản y hệt.';
  ELSIF md5(v_def) <> '750d2d72248d9557713ff6c82eedfe51' THEN
    RAISE EXCEPTION 'approve_contract_termination_v1 KHÁC bản đã đối chiếu (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.', md5(v_def)
      USING ERRCODE = '55000';
  END IF;
END
$preflight$;

-- 1. (a) Duyệt thanh lý chỉ cho hợp đồng còn hiệu lực.
CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1(p_termination_id uuid, p_note text DEFAULT NULL::text)
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

  -- [P0a 21/10/2026] Chỉ duyệt hồ sơ của hợp đồng CÒN HIỆU LỰC. Hợp đồng đã trả
  -- phòng / đã thanh lý thì tiền đã (hoặc sẽ) quyết toán ở màn Trả phòng /
  -- Quyết toán; duyệt thêm ở đây là ghi phiếu hoàn/thu lần hai, và dòng hồ sơ
  -- chen vào còn chiếm UNIQUE(contract_id) của finalize_contract_exit_case_v1.
  -- Kiểm SAU khoá hợp đồng (FOR UPDATE ở trên): confirm_contract_return_v1 khoá
  -- cùng dòng trước khi ghi ca trả phòng, nên không chen được giữa hai bước.
  if coalesce(v_contract.status::text, '') not in ('ACTIVE', 'EXTENDED')
     or v_contract.actual_end_date is not null
     or v_contract.deleted_at is not null
     or exists (select 1 from public.contract_exit_cases e
                 where e.contract_id = v_contract.id) then
    raise exception '[TERMINATION_CONTRACT_CLOSED] Hợp đồng % đã trả phòng hoặc đã thanh lý (trạng thái %) — không duyệt thêm hồ sơ thanh lý, vì sẽ ghi phiếu hoàn/thu lần hai. Quyết toán làm ở màn Trả phòng / Quyết toán.',
      coalesce(v_contract.contract_number, left(v_contract.id::text, 8)), v_contract.status
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
$function$;

COMMENT ON FUNCTION public.approve_contract_termination_v1(uuid, text) IS
'Writer DUY NHẤT của việc duyệt thanh lý: duyệt hồ sơ → TERMINATED hợp đồng →
COMPLETED → phiếu thu/chi NHÁP → trả phòng, atomic trong một transaction.
Từ 15/09/2026 (H2.3): số hoàn KẸP theo contract_deposit_paid_derived (cọc thực
nhận) chứ không theo cột GENERATED refund_amount (dựng trên cọc thoả thuận), lý
do kẹp ghi vào notes phiếu; item truyền amount tường minh; trả phòng dùng đúng
predicate NOT EXISTS của update_room_status_on_contract_change rồi
recompute_room_reservation để giữ cờ RESERVED của khách kế.
Kết quả trả thêm refund_amount / refund_amount_requested / refund_capped.
Từ 21/10/2026 (P0a): từ chối 55000 [TERMINATION_CONTRACT_CLOSED] khi hợp đồng
không còn ACTIVE/EXTENDED, đã có actual_end_date, đã xoá mềm hoặc đã có
contract_exit_cases — chặn phiếu hoàn/thu lần hai cho hợp đồng đã trả phòng.';

-- 2. (b) Hồ sơ thanh lý tạo/chuyển từ REST phải trỏ tới hợp đồng còn hiệu lực.
CREATE OR REPLACE FUNCTION app_private.guard_contract_termination_open_contract_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_status  text;
  v_end     date;
  v_deleted timestamptz;
  v_number  text;
BEGIN
  -- UPDATE chỉ đáng soi khi hồ sơ bị chuyển sang hợp đồng khác.
  IF TG_OP = 'UPDATE' AND NEW.contract_id IS NOT DISTINCT FROM OLD.contract_id THEN
    RETURN NEW;
  END IF;

  -- Cửa writer của guard a00 (hôm nay chưa writer nào mở) — cùng ngữ nghĩa.
  IF public.has_contract_termination_write_v1(CASE WHEN TG_OP = 'UPDATE' THEN OLD.id ELSE NEW.id END) THEN
    RETURN NEW;
  END IF;

  -- Chỉ trả lời người mà RLS SẼ cho ghi dòng này — cùng vế với policy
  -- contract_terminations_insert_rbac (contracts.create) / _update_rbac
  -- (contracts.edit) và ranh giới công ty, hoặc super admin. Ngoài phạm vi thì để
  -- RLS/FK từ chối: trigger BEFORE chạy trước WITH CHECK, không lọc ở đây là lộ
  -- trạng thái hợp đồng qua mã lỗi. Đổi khoá quyền của policy thì đổi cả ở đây.
  -- FOR SHARE: confirm_contract_return_v1 khoá FOR UPDATE cùng dòng trước khi
  -- ghi trả phòng, nên hai bên không chen được giữa lúc kiểm và lúc ghi.
  SELECT c.status::text, c.actual_end_date, c.deleted_at, c.contract_number
    INTO v_status, v_end, v_deleted, v_number
    FROM public.contracts c
   WHERE c.id = NEW.contract_id
     AND (public.is_super_admin()
          OR (c.organization_id = ANY (public.my_org_ids())
              AND public.building_of_contract(c.id) = ANY (app_private.buildings_for_v3(
                    CASE WHEN TG_OP = 'INSERT' THEN 'contracts.create' ELSE 'contracts.edit' END))))
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_status, '') NOT IN ('ACTIVE', 'EXTENDED')
     OR v_end IS NOT NULL
     OR v_deleted IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.contract_exit_cases e
                 WHERE e.contract_id = NEW.contract_id) THEN
    RAISE EXCEPTION
      '[TERMINATION_CONTRACT_CLOSED] Hợp đồng % đã trả phòng hoặc đã thanh lý (trạng thái %) — không tạo hồ sơ thanh lý mới từ giao diện. Quyết toán làm ở màn Trả phòng / Quyết toán.',
      COALESCE(v_number, left(NEW.contract_id::text, 8)), v_status
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION app_private.guard_contract_termination_open_contract_v1() IS
  'Trigger a01 trên contract_terminations (chỉ đường REST): hồ sơ mới hoặc hồ sơ đổi contract_id phải trỏ tới hợp đồng ACTIVE/EXTENDED, chưa actual_end_date, chưa xoá mềm, chưa có contract_exit_cases. 55000 [TERMINATION_CONTRACT_CLOSED]. Người mà RLS không cho ghi (khác công ty / thiếu contracts.create hoặc contracts.edit ở toà, trừ super admin) thì để RLS từ chối. P0a 21/10/2026.';

REVOKE ALL ON FUNCTION app_private.guard_contract_termination_open_contract_v1() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a01_contract_termination_open_contract_guard ON public.contract_terminations;
CREATE TRIGGER a01_contract_termination_open_contract_guard
  BEFORE INSERT OR UPDATE OF contract_id ON public.contract_terminations
  FOR EACH ROW
  WHEN (current_user IN ('authenticated', 'anon'))
  EXECUTE FUNCTION app_private.guard_contract_termination_open_contract_v1();

-- 3. Tự kiểm (chỉ catalog — chạy được trên database rỗng).
DO $sau$
DECLARE
  v_n int;
BEGIN
  IF position('[TERMINATION_CONTRACT_CLOSED]' IN
       pg_get_functiondef('public.approve_contract_termination_v1(uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'approve_contract_termination_v1 chưa có rào hợp đồng đã đóng' USING ERRCODE = '55000';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.approve_contract_termination_v1(uuid, text)'::regprocedure) THEN
    RAISE EXCEPTION 'approve_contract_termination_v1 phải SECURITY DEFINER' USING ERRCODE = '55000';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'app_private.guard_contract_termination_open_contract_v1()'::regprocedure) THEN
    RAISE EXCEPTION 'guard_contract_termination_open_contract_v1 phải SECURITY DEFINER' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'app_private.guard_contract_termination_open_contract_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.guard_contract_termination_open_contract_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated còn EXECUTE trên guard_contract_termination_open_contract_v1' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgrelid = 'public.contract_terminations'::regclass
     AND t.tgname = 'a01_contract_termination_open_contract_guard'
     AND t.tgfoid = 'app_private.guard_contract_termination_open_contract_v1()'::regprocedure
     AND t.tgenabled = 'O'
     AND position('BEFORE INSERT OR UPDATE OF contract_id ON public.contract_terminations' IN pg_get_triggerdef(t.oid)) > 0
     AND position('WHEN ((CURRENT_USER = ANY (ARRAY[''authenticated''::name, ''anon''::name])))' IN pg_get_triggerdef(t.oid)) > 0;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Thiếu trigger a01_contract_termination_open_contract_guard (BEFORE INSERT OR UPDATE OF contract_id, WHEN chỉ authenticated/anon, đang bật)' USING ERRCODE = '55000';
  END IF;
END
$sau$;
