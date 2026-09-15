-- =============================================================================
-- Cọc & thanh lý — plan con H2 (rà soát 15/09/2026)
--
-- Bốn lỗi, cùng MỘT gốc: các đường thanh lý tin vào con số "cọc thoả thuận"
-- (contracts.total_deposit / contracts.deposit_paid ghi tay) thay vì cọc THỰC
-- NHẬN suy từ phiếu (public.contract_deposit_paid_derived).
--
-- H2.1 settle_previous_debt_sources
--      Nhánh src_type='deposit' UPDATE thẳng contracts.deposit_paid. Hàm này
--      SECURITY DEFINER nên trigger a00_guard_contract_deposit_paid KHÔNG chặn
--      được — guard chỉ bắt current_user IN ('authenticated','anon'). Kết quả:
--      một số cọc không có phiếu nào đứng sau, và lần recompute kế tiếp xoá nó
--      đi trong im lặng. Nay bỏ nhánh: nợ cọc kéo sang hoá đơn phải là một
--      voucher DEPOSIT thật thì mới được tính.
--      Kèm theo: nhánh 'invoice' chỉ được đụng hoá đơn CÙNG TỔ CHỨC.
--      previous_debt_sources là jsonb do client dựng, không chặn org thì một
--      payload trỏ sang id hoá đơn công ty khác vẫn ghi chú + recompute được.
--
-- H2.2 recompute_contract_deposit_paid
--      Early-return khi không đếm được phiếu cọc nào (v_count_any = 0). Gỡ liên
--      kết phiếu cọc CUỐI CÙNG ⇒ hàm về sớm, deposit_paid cũ ở lại vĩnh viễn và
--      thành tiền hoàn THẬT ở màn thanh lý. Nay luôn ghi lại theo hàm dẫn xuất
--      (nó đã GREATEST(...,0) nên không âm).
--
-- H2.3 approve_contract_termination_v1  (UI gọi — src/hooks/useContracts.ts)
--      (a) Ghi phiếu theo contract_terminations.refund_amount, là cột GENERATED
--          = total_deposit − khấu trừ. total_deposit là cọc GHI TRÊN HỢP ĐỒNG,
--          không phải cọc đã vào két. Ký cọc 10tr, đóng 4tr, không khấu trừ gì
--          ⇒ phiếu chi 10tr, tức chi ra 6tr chưa từng thu.
--          preview_termination_refund_v1 ĐÃ phát hiện (VUOT_COC_THAT) nhưng đó
--          chỉ là cảnh báo hiển thị; writer vẫn ghi theo cột. Nay kẹp tại
--          writer và ghi lý do vào notes của phiếu.
--      (b) Item phiếu không truyền `amount`, sống nhờ trigger
--          auto_calc_item_amount ghi đè. Trigger đó là việc của H3.1; call-site
--          phải đúng TRƯỚC để lúc trigger thôi ghi đè thì không phiếu nào
--          amount NULL.
--      (c) Trả phòng AVAILABLE VÔ ĐIỀU KIỆN — cướp cả OCCUPIED của hợp đồng còn
--          hiệu lực khác trên cùng phòng lẫn RESERVED (cọc giữ chỗ khách kế).
--          Nay dùng đúng predicate NOT EXISTS của trigger
--          update_room_status_on_contract_change, rồi gọi
--          recompute_room_reservation để dựng lại cờ RESERVED.
--
-- H2.4 terminate_contract_move_out_impl
--      INSERT contract_terminations (bản audit quyết toán) bọc
--      EXCEPTION WHEN OTHERS ⇒ hợp đồng ĐÃ TERMINATED, phiếu tiền ĐÃ ghi, mà
--      không một dòng nào ghi lại việc đó. Đúng lớp lỗi đã vá cho transfer_room
--      ở 20260731050000 ("audit ghi trước, không bọc EXCEPTION, lỗi audit ⇒
--      rollback toàn bộ"). Nay bỏ khối bắt lỗi; thân hàm chép NGUYÊN KHỐI từ
--      bản đang chạy (20260902104355), chỉ gỡ đúng 3 dòng đó.
--
-- KHÔNG LÀM
--   · KHÔNG khoá đường thanh lý cũ — đợt 4 của plan 2 hoàn cọc CHỦ ĐÃ TẠM DỪNG
--     28/08/2026. File này chỉ vá an toàn trên đường đang chạy.
--   · KHÔNG đụng update_room_status_on_contract_change (plan con F sở hữu).
--   · KHÔNG đụng auto_calc_item_amount (plan con H3 sở hữu).
--   · KHÔNG đổi chữ ký hàm nào ⇒ CREATE OR REPLACE thay tại chỗ, GRANT giữ
--     nguyên (cùng nếp với 20260728160000). Không thêm/bớt ACL.
--   · KHÔNG backfill dữ liệu. Đây là forward-guard, không dọn số cũ.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 0. Tiền kiểm — không vá mù
-- ─────────────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF to_regprocedure('public.settle_previous_debt_sources()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu settle_previous_debt_sources() — DỪNG.';
  END IF;
  IF to_regprocedure('public.recompute_contract_deposit_paid(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu recompute_contract_deposit_paid(uuid) — DỪNG.';
  END IF;
  IF to_regprocedure('public.approve_contract_termination_v1(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu approve_contract_termination_v1(uuid,text) — DỪNG.';
  END IF;
  IF to_regprocedure('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu terminate_contract_move_out_impl/11 — chữ ký đã đổi? DỪNG.';
  END IF;

  -- Hai helper mà H2.3 dựa vào.
  IF to_regprocedure('public.contract_deposit_paid_derived(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu contract_deposit_paid_derived(uuid) — không kẹp được số hoàn. DỪNG.';
  END IF;
  IF to_regprocedure('public.recompute_room_reservation(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu recompute_room_reservation(uuid) — không dựng lại được cờ RESERVED. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 0b. GHIM BẢN ĐANG CHẠY — không vá mù lên một định nghĩa lạ
--
-- Ba hàm ở mục 1-3 được VIẾT LẠI bằng tay, nên ghim theo DẤU của bản cũ (đọc
-- được bằng mắt, không phụ thuộc cách PostgreSQL format lại định nghĩa).
-- Hàm ở mục 4 là CHÉP NGUYÊN KHỐI 20k ký tự, nên ghim bằng md5 — đúng thứ md5
-- sinh ra để canh, và cùng nếp với 20260902104355.
--
-- Mỗi khối có lối thoát idempotent: thấy dấu của BẢN MỚI thì chỉ ghi chú rồi
-- replace lại bản y hệt.
--
-- Số đo lấy từ pg_get_functiondef trên production 15/09/2026 (truy vấn CHỈ ĐỌC):
--   settle_previous_debt_sources      md5 70a8036ad39798d6ef00acce00d0e5de
--   recompute_contract_deposit_paid   md5 5120ab9693f4f5b9cf9fcf62c8c0742d
--   approve_contract_termination_v1   md5 3f997d7d7c151a91d2e70f7e126a1431
--   terminate_contract_move_out_impl  md5 6b5d7e0ce200868ee63dacfb53c1e9a6
-- ─────────────────────────────────────────────────────────────────────
DO $pin$
DECLARE
  v_def text;
BEGIN
  -- (1) settle_previous_debt_sources — dấu cũ: nhánh cọc ghi cột dẫn xuất.
  v_def := pg_get_functiondef('public.settle_previous_debt_sources()'::regprocedure);
  IF position('[H2.1]' IN v_def) > 0 THEN
    RAISE NOTICE 'settle_previous_debt_sources đã vá — replace lại bản y hệt.';
  ELSIF position('LEAST(COALESCE(total_deposit, 0),' IN v_def) = 0 THEN
    RAISE EXCEPTION 'settle_previous_debt_sources KHÁC bản đã đối chiếu (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.', md5(v_def);
  END IF;

  -- (2) recompute_contract_deposit_paid — dấu cũ: biến đếm của early-return.
  v_def := pg_get_functiondef('public.recompute_contract_deposit_paid(uuid)'::regprocedure);
  IF position('[H2.2]' IN v_def) > 0 THEN
    RAISE NOTICE 'recompute_contract_deposit_paid đã vá — replace lại bản y hệt.';
  ELSIF position('v_count_any' IN v_def) = 0 THEN
    RAISE EXCEPTION 'recompute_contract_deposit_paid KHÁC bản đã đối chiếu (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.', md5(v_def);
  END IF;

  -- (3) approve_contract_termination_v1 — dấu cũ: lấy thẳng cột GENERATED.
  v_def := pg_get_functiondef('public.approve_contract_termination_v1(uuid, text)'::regprocedure);
  IF position('[H2.3a]' IN v_def) > 0 THEN
    RAISE NOTICE 'approve_contract_termination_v1 đã vá — replace lại bản y hệt.';
  ELSIF position('v_refund := coalesce(v_term.refund_amount, 0);' IN v_def) = 0 THEN
    RAISE EXCEPTION 'approve_contract_termination_v1 KHÁC bản đã đối chiếu (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.', md5(v_def);
  END IF;

  -- (4) terminate_contract_move_out_impl — CHÉP NGUYÊN KHỐI, ghim md5 tuyệt đối.
  v_def := pg_get_functiondef('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)'::regprocedure);
  IF position('[H2.4 - 15/09/2026]' IN v_def) > 0 THEN
    RAISE NOTICE 'terminate_contract_move_out_impl đã vá — replace lại bản y hệt.';
  ELSIF md5(v_def) <> '6b5d7e0ce200868ee63dacfb53c1e9a6' THEN
    RAISE EXCEPTION 'terminate_contract_move_out_impl trên DB này KHÁC bản đã đối chiếu (md5 %) — DỪNG, đối chiếu pg_get_functiondef trước khi replace.', md5(v_def);
  END IF;
END
$pin$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. H2.1 — tất toán nợ cũ: bỏ đường ghi tay cột cọc, chặn org cho hoá đơn
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_previous_debt_sources()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  src       jsonb;
  src_type  text;
  src_id    uuid;
  src_amt   numeric;
  v_marker  text;
BEGIN
  IF NEW.status <> 'PAID' THEN RETURN NEW; END IF;
  IF OLD.status = 'PAID' THEN RETURN NEW; END IF;
  IF NEW.previous_debt_sources IS NULL
     OR jsonb_typeof(NEW.previous_debt_sources) <> 'array'
     OR jsonb_array_length(NEW.previous_debt_sources) = 0 THEN
    RETURN NEW;
  END IF;

  v_marker := '[Tự động tất toán qua HĐ '
              || COALESCE(NEW.invoice_number, NEW.id::text) || ']';

  FOR src IN SELECT * FROM jsonb_array_elements(NEW.previous_debt_sources) LOOP
    src_type := src->>'type';
    src_amt  := COALESCE((src->>'amount')::numeric, 0);
    IF src_amt <= 0 THEN CONTINUE; END IF;

    IF src_type = 'invoice' THEN
      src_id := NULLIF(src->>'id', '')::uuid;
      IF src_id IS NULL THEN CONTINUE; END IF;

      -- [B1] CHỈ ghi chú. KHÔNG còn ghi paid_amount/status/paid_date — số tiền
      -- do recompute_invoice_for_id suy ra, nên nó bền trước mọi lần tính lại.
      -- Phải chạy TRƯỚC recompute vì điều kiện là status <> 'PAID'.
      --
      -- [H2.1] Thêm chặn TỔ CHỨC: previous_debt_sources do client dựng, id ở
      -- đó không phải thứ đáng tin. Không có dòng này thì một payload trỏ sang
      -- hoá đơn công ty khác vẫn được ghi chú và recompute — hàm SECURITY
      -- DEFINER nên RLS không đỡ hộ.
      UPDATE public.invoices
         SET notes = CASE
                       WHEN notes IS NULL OR notes = '' THEN v_marker
                       ELSE notes || E'\n' || v_marker
                     END
       WHERE id = src_id
         AND organization_id = NEW.organization_id
         AND status <> 'PAID'
         AND deleted_at IS NULL
         AND COALESCE(notes, '') NOT LIKE '%' || v_marker || '%';

      PERFORM public.recompute_invoice_for_id(src_id);

    ELSIF src_type = 'deposit' THEN
      -- [H2.1] BỎ HẲN đường cũ. Trước đây nhánh này UPDATE thẳng cột cọc của
      -- hợp đồng (LEAST(total_deposit, cũ + src_amt)) — ba cái sai cùng lúc:
      --   · cột đó là số DẪN XUẤT từ phiếu (contract_deposit_paid_derived),
      --     ghi tay vào nó sẽ bị lần recompute kế tiếp xoá đi không dấu vết;
      --   · không kiểm tổ chức, nên contract_id trong payload trỏ đâu ghi đó;
      --   · trần LEAST theo cọc THOẢ THUẬN, không theo tiền thật vào két.
      -- Nợ cọc kéo sang hoá đơn muốn được tính thì phải có phiếu DEPOSIT thật
      -- (item accounting_class = 'DEPOSIT', phiếu đã duyệt) gắn hợp đồng —
      -- đường duy nhất mà cả recompute lẫn hậu kiểm writer cùng nhìn thấy.
      CONTINUE;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.settle_previous_debt_sources() IS
'Trigger tất toán "nợ kỳ trước" khi hoá đơn chuyển sang PAID. Chỉ ghi CHÚ vào
hoá đơn nguồn rồi recompute nó (B1), và chỉ trong CÙNG tổ chức. Nguồn kiểu
"deposit" bị BỎ QUA có chủ ý từ 15/09/2026 (H2.1): cột cọc của hợp đồng là số
dẫn xuất từ phiếu, không có đường ghi tay nào hợp lệ.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. H2.2 — recompute cọc: luôn ghi lại, kể cả khi đã hết phiếu
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recompute_contract_deposit_paid(p_contract_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric(15,2) := 0;
BEGIN
  IF p_contract_id IS NULL THEN
    RETURN;
  END IF;

  -- [H2.2] ĐÃ BỎ early-return "không đếm được phiếu cọc nào thì thôi".
  -- Cái đếm đó biến hàm thành một chiều: thêm phiếu thì cột đi lên, gỡ phiếu
  -- CUỐI CÙNG thì cột đứng im ở số cũ. Số đứng im đó là tiền hoàn THẬT ở màn
  -- thanh lý. Hàm dẫn xuất đã GREATEST(...,0) nên trường hợp rỗng ra đúng 0 —
  -- không cần bảo vệ gì thêm.
  v_total := public.contract_deposit_paid_derived(p_contract_id);

  UPDATE public.contracts
     SET deposit_paid = v_total,
         updated_at = now()
   WHERE id = p_contract_id
     AND deleted_at IS NULL
     AND deposit_paid IS DISTINCT FROM v_total;
END;
$function$;

COMMENT ON FUNCTION public.recompute_contract_deposit_paid(uuid) IS
'Ghi cột contracts.deposit_paid = contract_deposit_paid_derived(id). LUÔN ghi,
kể cả khi hợp đồng không còn phiếu cọc nào (ra 0) — early-return theo số phiếu
đã bỏ 15/09/2026 (H2.2) vì nó để lại cọc ma sau khi gỡ phiếu cuối.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. H2.3 — duyệt thanh lý: kẹp theo cọc thật, truyền amount, trả phòng đúng
-- ─────────────────────────────────────────────────────────────────────
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
Kết quả trả thêm refund_amount / refund_amount_requested / refund_capped.';

-- ---------------------------------------------------------------------
-- 4. H2.4 - thanh ly tra phong: audit khong duoc nuot loi
--
-- Than ham chep NGUYEN KHOI tu ban dang chay (20260902104355; md5 cua khoi
-- CREATE luc chep: 509e2ba0caf3440bec8dd7ad421eabcb). Thay doi DUY NHAT: go
-- BEGIN / EXCEPTION WHEN OTHERS / END quanh INSERT contract_terminations o
-- buoc 7. Khong dung tien, so, trang thai, ten phieu hay chu ky.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '[]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành (fallback nhận tiền thật)
  v_acc_int   uuid;   -- sổ bút toán nội bộ (cả 2 chân cấn cọc)
  v_acc_rcpt  uuid;   -- sổ NHẬN "khách trả thêm" (tiền thật)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_extra     numeric(15,2) := 0;
  v_owed      numeric(15,2) := 0;   -- tổng "Hoàn lại khách" (mình nợ khách)
  v_charges_left numeric(15,2);
  v_owed_applied numeric(15,2);
  v_refund_owed  numeric(15,2);
  v_type_rentref uuid;
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_applied_dep numeric(15,2);
  v_refund_dep  numeric(15,2);
  v_refund_exc  numeric(15,2);
  v_S         numeric(15,2);
  v_budget    numeric(15,2);
  v_pay       numeric(15,2);
  v_settle_inv uuid;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_type_excr uuid;
  v_voucher   uuid;
  v_refund_voucher uuid;
  v_breakdown text;
  rec         RECORD;
BEGIN
  IF p_shortfall_mode NOT IN ('PAID', 'DEBT') THEN
    RAISE EXCEPTION 'p_shortfall_mode phải là PAID hoặc DEBT';
  END IF;

  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  IF p_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_move_out_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng'; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, public.org_today_v1(NULL)), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  -- Sổ NHẬN "khách trả thêm" (tiền thật): form chọn > sổ %Thu của người bấm > sổ vận hành toà.
  v_acc_rcpt := COALESCE(p_receipt_account_id, public._collector_thu_account(auth.uid()), v_acc_op);
  IF p_receipt_account_id IS NOT NULL THEN
    PERFORM 1 FROM accounts a WHERE a.id = p_receipt_account_id AND a.deleted_at IS NULL AND a.is_virtual = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền không hợp lệ (không tồn tại hoặc là sổ ảo)';
    END IF;
  END IF;

  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid).
  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  IF jsonb_typeof(COALESCE(p_refund_items, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_owed
      FROM jsonb_array_elements(p_refund_items) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  v_charges     := v_debt + v_penalty + v_extra;
  v_pool        := v_deposit + v_excess;
  v_applied     := LEAST(v_pool + v_owed, v_charges);
  v_applied_dep := LEAST(v_deposit, v_charges);
  v_refund_dep  := v_deposit - v_applied_dep;
  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));
  -- "Hoàn lại khách" CHỈ được cấn vào phần công nợ CÒN LẠI sau khi cọc và credit
  -- đã cấn xong. Cấn sớm hơn sẽ làm v_refund_dep xê dịch — mà con số đó phải
  -- khớp cột GENERATED contract_terminations.refund_amount, nền của cảnh báo
  -- VUOT_COC_THAT trong nghĩa vụ hoàn cọc (preview_termination_refund_v1).
  v_charges_left := GREATEST(v_charges - v_deposit - v_excess, 0);
  v_owed_applied := LEAST(v_owed, v_charges_left);
  v_refund_owed  := v_owed - v_owed_applied;
  v_S           := v_pool + v_owed - v_charges;

  v_breakdown :=
       'QUYẾT TOÁN THANH LÝ ' || to_char(p_move_out_date,'DD/MM/YYYY') || ' — HĐ ' || v_cnumber
    || E'\n• Cọc đã thu: ' || to_char(v_deposit, 'FM999G999G999G990') || 'đ'
    || E'\n• Khấu trừ: công nợ ' || to_char(v_debt, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_penalty > 0 THEN ' + phí phạt ' || to_char(v_penalty, 'FM999G999G999G990') || 'đ' ELSE '' END
    || CASE WHEN v_extra   > 0 THEN ' + thu thêm ' || to_char(v_extra, 'FM999G999G999G990') || 'đ' ELSE '' END
    || ' = ' || to_char(v_charges, 'FM999G999G999G990') || 'đ'
    || E'\n• Cọc cấn vào khấu trừ: ' || to_char(v_applied_dep, 'FM999G999G999G990') || 'đ (bút toán nội bộ, không đụng sổ tiền thật)'
    || CASE WHEN v_excess > 0 THEN E'\n• Tiền thừa (credit) áp dụng: ' || to_char(v_excess, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_excess - v_refund_exc, 'FM999G999G999G990') || 'đ, hoàn ' || to_char(v_refund_exc, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || CASE WHEN v_owed > 0 THEN E'\n• Hoàn lại khách (tiền phòng ngày không ở…): ' || to_char(v_owed, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_owed_applied, 'FM999G999G999G990') || 'đ, chi ' || to_char(v_refund_owed, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || E'\n• Hoàn cọc lại khách: ' || to_char(v_refund_dep, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_S < 0 THEN E'\n• Khách còn phải trả: ' || to_char(-v_S, 'FM999G999G999G990') || 'đ ('
         || CASE WHEN p_shortfall_mode = 'PAID' THEN 'đã thu ngay khi thanh lý' ELSE 'GHI NỢ — chờ thu' END || ')'
       ELSE '' END
    || CASE WHEN v_refund_dep + v_refund_exc + v_refund_owed > 0 THEN E'\n• Tổng chi hoàn khách: ' || to_char(v_refund_dep + v_refund_exc + v_refund_owed, 'FM999G999G999G990') || 'đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)' ELSE '' END;

  -- 1. HOÁ ĐƠN THANH LÝ RIÊNG (kind='SETTLEMENT', ĐÚNG kỳ tháng trả phòng).
  --    v4: KHÔNG đụng hoá đơn tháng nữa — dù nó chưa/đã PAID. Công nợ của nó
  --    vẫn được gạch ở bước 2 bằng payments 'CT' (không sửa nội dung hoá đơn).
  IF v_penalty > 0 OR v_extra > 0 THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, 'SETTLEMENT',
      v_billing, p_move_out_date, p_move_out_date, 'APPROVED'::invoice_status, 0, 0,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY') || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_settle_inv;
  END IF;

  IF v_penalty > 0 THEN
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  IF v_extra > 0 THEN
    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);
  END IF;

  IF v_settle_inv IS NOT NULL THEN
    UPDATE invoices
       SET notes = COALESCE(notes || E'\n\n', '') || v_breakdown,
           updated_at = NOW()
     WHERE id = v_settle_inv;
  END IF;

  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ 'CT' (PAID: gạch hết; DEBT: trong pool).
  v_budget := CASE WHEN p_shortfall_mode = 'DEBT' THEN v_applied ELSE NULL END;
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> 'CANCELLED'
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    v_pay := rec.remaining;
    IF v_budget IS NOT NULL THEN
      EXIT WHEN v_budget <= 0;
      v_pay := LEAST(v_pay, v_budget);
      v_budget := v_budget - v_pay;
    END IF;
    IF v_pay > 0 THEN
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      VALUES (v_contract.user_id, rec.id, v_pay, 'CT'::payment_method, p_move_out_date,
              'Quyết toán khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY'));
    END IF;
  END LOOP;

  -- 3. CẶP BÚT TOÁN NỘI BỘ (cấn cọc → doanh thu) — CẢ 2 CHÂN trên sổ nội bộ,
  --    net 0/thương vụ; KHÔNG đụng sổ tiền thật (mô hình chốt 04/07).
  IF v_applied_dep > 0 THEN
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc → chuyển doanh thu — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: cọc cấn công nợ/phạt (không phải tiền thật).' || E'\n\n' || v_breakdown,
      'termination.offset')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, 'Cấn cọc chuyển doanh thu', 1, v_applied_dep, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu thanh lý từ cọc cấn nợ/phạt (KQKD đếm theo hạng mục).',
      'termination.revenue')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied_dep, p_move_out_date, p_move_out_date);
  END IF;

  -- 3b. KHOẢN HOÀN BỊ CẤN VÀO CÔNG NỢ — cặp bút toán nội bộ, net 0 trên sổ nội
  --     bộ, KHÔNG đụng sổ tiền thật. Gương của cặp cấn cọc ở bước 3, khác ở chỗ
  --     chân chi mang loại is_deposit=FALSE: tiền phòng đã ghi doanh thu rồi nên
  --     trả lại là GIẢM LÃI THẬT, còn cọc là tiền giữ hộ nên nằm ngoài KQKD.
  IF v_owed_applied > 0 THEN
    v_type_rentref := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Hoàn tiền phòng cấn công nợ — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_owed_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: khoản hoàn cho khách được cấn vào công nợ còn lại (không phải tiền thật).' || E'\n\n' || v_breakdown,
      'termination.rent_refund_offset')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_rentref, 'Hoàn tiền phòng (cấn công nợ)', 1, v_owed_applied, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý (khoản hoàn cấn nợ) — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_owed_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu từ phần công nợ được khoản hoàn cấn trừ.',
      'termination.rent_refund_revenue')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (khoản hoàn cấn nợ)', 1, v_owed_applied, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).
  IF v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', COALESCE(app_private.termination_refund_name_v1(p_contract_id, p_move_out_date), 'Trả khách thanh lý — HĐ ' || v_cnumber), v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc + v_refund_owed, 'UNAPPROVED',
      '[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.' || E'\n\n' || v_breakdown || COALESCE(E'\n' || p_notes, ''),
      'termination.refund')
    RETURNING id INTO v_refund_voucher;

    IF v_refund_dep > 0 THEN
      v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_dep, 'Trả lại khách (cọc sau khấu trừ)', 1, v_refund_dep, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_exc > 0 THEN
      v_type_excr := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền thừa thanh lý');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_excr, 'Hoàn tiền thừa khi thanh lý', 1, v_refund_exc, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_owed > 0 THEN
      v_type_rentref := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thanh lý');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_rentref, 'Hoàn tiền phòng ngày khách không ở', 1, v_refund_owed, p_move_out_date, p_move_out_date);
    END IF;
  END IF;

  -- 4c. Khách trả thêm (TIỀN THẬT) — chế độ PAID: vào SỔ NHẬN đã chọn.
  IF v_S < 0 AND p_shortfall_mode = 'PAID' THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khách trả thêm)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Khách trả thêm khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_rcpt, v_settle_inv, p_move_out_date, -v_S, 'APPROVED',
      'Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý (tiền thật vào sổ nhận).' || COALESCE(E'\n' || p_notes, ''),
      'termination.extra_receipt')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Khách trả thêm khi thanh lý', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Recompute hoá đơn quyết toán.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng (ghi chú kèm bản quyết toán đầy đủ).
  UPDATE contracts
     SET status = 'TERMINATED', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown
                        ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  --
  -- [H2.4 - 15/09/2026] DA GO khoi bat loi trum (BEGIN ... WHEN OTHERS ... END)
  -- bao quanh INSERT nay. Audit "best-effort" o day nghia la: hop dong DA
  -- TERMINATED, hoa don quyet toan DA dung, phieu tien DA ghi - ma bang
  -- contract_terminations khong co mot dong nao. Sau do khong ai tra loi duoc
  -- "khach tra phong ngay nao, quyet toan ra sao", va moi read model dung tren
  -- bang do thieu doan trong im lang (man /deposits, KPI hoan coc, preview
  -- nghia vu hoan). Dung lop loi da va cho transfer_room o 20260731050000:
  -- loi audit => rollback toan bo, vi mot cu thanh ly khong ghi duoc vet thi
  -- tha dung xay ra.
  INSERT INTO contract_terminations (
    user_id, contract_id, termination_date, actual_move_out_date, termination_type,
    outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
    total_deposit, rent_refund_amount, refund_method, status, approved_by, approved_at, notes)
  VALUES (
    v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, 'NORMAL',
    v_debt, v_penalty + v_extra, 0, 0, 0,
    v_deposit, v_owed,
    CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN 'TM'::payment_method ELSE NULL END,
    'COMPLETED', auth.uid(), NOW(),
    COALESCE(p_notes || E'\n', '') || v_breakdown);

  RETURN jsonb_build_object(
    'contract_id', p_contract_id, 'settlement_invoice_id', v_settle_inv,
    'charges', v_charges, 'extra_charges_total', v_extra,
    'applied', v_applied, 'applied_deposit', v_applied_dep,
    'refund_deposit', v_refund_dep, 'refund_excess', v_refund_exc,
    'customer_refund_total', v_owed, 'customer_refund_applied', v_owed_applied,
    'refund_customer', v_refund_owed,
    'refund_voucher_id', v_refund_voucher,
    'net_settlement', v_S, 'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', CASE WHEN v_S < 0 AND p_shortfall_mode = 'PAID' THEN v_acc_rcpt END,
    'acc_op', v_acc_op, 'acc_internal', v_acc_int
  );
END $function$;

-- ---------------------------------------------------------------------
-- 5. Tu kiem - tam khang dinh, do tren dinh nghia VUA ghi
-- ---------------------------------------------------------------------
DO $selfcheck$
DECLARE
  d_settle text := pg_get_functiondef('public.settle_previous_debt_sources()'::regprocedure);
  d_recomp text := pg_get_functiondef('public.recompute_contract_deposit_paid(uuid)'::regprocedure);
  d_appr   text := pg_get_functiondef('public.approve_contract_termination_v1(uuid,text)'::regprocedure);
  d_impl   text := pg_get_functiondef('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)'::regprocedure);
BEGIN
  IF d_settle ~* 'UPDATE[[:space:]]+public[.]contracts' THEN
    RAISE EXCEPTION 'H2.1 hong: settle_previous_debt_sources van ghi vao contracts. DUNG.';
  END IF;
  IF position('organization_id = NEW.organization_id' in d_settle) = 0 THEN
    RAISE EXCEPTION 'H2.1 hong: nhanh invoice chua chan to chuc. DUNG.';
  END IF;

  IF position('v_count_any' in d_recomp) > 0 THEN
    RAISE EXCEPTION 'H2.2 hong: recompute van con early-return theo so phieu. DUNG.';
  END IF;
  IF position('deposit_paid = v_total' in d_recomp) = 0 THEN
    RAISE EXCEPTION 'H2.2 hong: recompute khong con ghi deposit_paid. DUNG.';
  END IF;

  IF position('contract_deposit_paid_derived' in d_appr) = 0 THEN
    RAISE EXCEPTION 'H2.3a hong: duyet thanh ly chua kep theo coc thuc nhan. DUNG.';
  END IF;
  IF position('quantity, unit_price, amount' in d_appr) = 0 THEN
    RAISE EXCEPTION 'H2.3b hong: item phieu hoan chua truyen amount. DUNG.';
  END IF;
  IF position('recompute_room_reservation' in d_appr) = 0
     OR position('not exists' in lower(d_appr)) = 0 THEN
    RAISE EXCEPTION 'H2.3c hong: tra phong chua dung predicate/chua dung lai co RESERVED. DUNG.';
  END IF;

  IF d_impl ~* 'EXCEPTION[[:space:]]+WHEN[[:space:]]+OTHERS' THEN
    RAISE EXCEPTION 'H2.4 hong: terminate_contract_move_out_impl van nuot loi audit. DUNG.';
  END IF;
  IF position('INSERT INTO contract_terminations' in d_impl) = 0 THEN
    RAISE EXCEPTION 'H2.4 hong: roi mat INSERT audit khi chep. DUNG.';
  END IF;
END
$selfcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';
