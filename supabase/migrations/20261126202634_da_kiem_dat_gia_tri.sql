-- Đợt 10c (plan sửa khoá vĩnh viễn sau rớt mạng): «Đã kiểm» phiếu thu chi thành ĐẶT GIÁ TRỊ.
--
-- VÌ SAO
--   public.verify_income_expense_v1 là nút bật/tắt: đã kiểm thì bỏ kiểm, chưa kiểm thì đánh dấu. Lần bấm mất phản hồi
--   (rớt mạng) mà gửi lại thì có thể ĐẢO NGƯỢC kết quả của chính lần trước, nên trình duyệt phải đọc trạng thái rồi chờ
--   2 phút. Nhận GIÁ TRỊ MUỐN ĐẶT thì gửi lại luôn an toàn: máy chủ khoá phiếu, so, đúng giá trị rồi thì không ghi gì.
--
-- NỘI DUNG (dựng từ THÂN ĐANG CHẠY trên production, đọc 26/11/2026 bằng pg_get_functiondef, chỉ đọc)
--   public.verify_income_expense_v1(p_id, p_note, p_verified DEFAULT NULL) THAY hàm hai tham số (md5 prosrc 96dee08a…).
--   - p_verified NULL (lời gọi kiểu cũ: bundle trình duyệt cũ): chạy đúng từng câu của thân cũ, theo đúng thứ tự (kiểm
--     phiên → khoá phiếu FOR UPDATE → không thấy phiếu → phiếu đường cũ thì 55000 «dùng đường legacy» → quyền xem →
--     đảo). Chỉ khác: `return;` thành `return NULL` vì kiểu trả về nay là jsonb (xem «Kiểu trả về»).
--   - p_verified true/false: sau khi KHOÁ phiếu và kiểm quyền xem như cũ, phiếu đã đúng giá trị ⇒ trả
--     {changed:false, verified, verified_at, verified_by_name}, không UPDATE, không ghi nhật ký. Khác ⇒ chạy đúng nhánh
--     đảo của thân cũ (đảo lúc này chính là đặt về p_verified) rồi trả {changed:true, …}. Quyền bỏ kiểm (chủ kiểm hoặc
--     super admin) giữ nguyên.
--   - Phiếu đường cũ (chưa thuộc luồng canonical — 62% phiếu production, 23% phiếu 30 ngày qua) với p_verified: gọi
--     NGUYÊN thân public.verify_income_expense (hàm bật/tắt đường cũ, md5 prosrc 39fd5648…, KHÔNG bị thay) ngay dưới khoá
--     dòng của hàm này, sau khi đã so ⇒ đảo = đặt; đọc lại phải đúng p_verified, lệch ⇒ 55000 và lùi cả giao dịch. Nhờ
--     vậy trình duyệt mới chỉ gọi một hàm, không còn rơi về đường bật/tắt cũ.
--
-- KIỂU TRẢ VỀ void → jsonb: để trả «không đổi» kèm trạng thái hiện tại. Lời gọi kiểu cũ nhận NULL (PostgREST/supabase-js
--   trả data = null như với void). Không ai đọc giá trị trả về của hàm này: không hàm SQL nào gọi nó (pg_proc/pg_depend
--   rỗng), web các bản trước chỉ xét `error`, trợ lý Hermes không gọi.
--
-- TƯƠNG THÍCH NGƯỢC
--   Phải DROP rồi CREATE: CREATE OR REPLACE với danh sách tham số / kiểu trả về khác sẽ hỏng hoặc để lại hai bản trùng
--   tên. ACL cấp lại đúng như cũ (vai service_role và vai đăng nhập; không PUBLIC, không anon). SECURITY DEFINER, search_path
--   ghim như cũ, VOLATILE. Không đổi bảng, không thêm cột, không xoá dữ liệu. Phần không lùi được: không có.
--   LÙI (nếu cần): trong MỘT giao dịch, DROP FUNCTION public.verify_income_expense_v1(uuid, text, boolean); dựng lại bản
--   hai tham số từ bản dump của lane (thân md5 prosrc 96dee08a…, RETURNS void); REVOKE ALL … FROM PUBLIC, anon; GRANT
--   EXECUTE … cho service_role và vai đăng nhập. Chỉ dựng lại bản cũ mà không DROP bản ba tham số thì còn hai bản trùng tên
--   và lời gọi {p_id, p_note} của bundle cũ thành mơ hồ (PGRST203). Web của đợt này phải lùi TRƯỚC (nó gửi p_verified).
--
-- AN TOÀN CHẠY LẠI: khối $requires$ nhận đúng hai trạng thái của verify_income_expense_v1 (bản hai tham số của
-- production, hoặc bản ba tham số của chính tệp này ở lượt hai); DROP dùng IF EXISTS; CREATE OR REPLACE.

DO $requires$
DECLARE
  r record;
  v_md5 text;
BEGIN
  IF to_regclass('public.income_expenses') IS NULL
     OR to_regclass('app_private.ie_transition_authorization') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.can_access_building(uuid)') IS NULL
     OR to_regprocedure('app_private.my_possessed_cashbook_ids_v1()') IS NULL
     OR to_regprocedure('app_private.ie_actor_display_name_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.append_income_expense_event_v1(uuid,uuid,text,uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'da_kiem_dat_gia_tri: thiếu nền (bảng phiếu, bảng cấp phép chuyển trạng thái hoặc hàm quyền / nhật ký)' USING ERRCODE = '55000';
  END IF;

  -- Hai hàm KHÔNG bị thay nhưng được dựa vào — thân đổi thì dừng để rà lại:
  --   verify_income_expense: nhánh đặt giá trị của phiếu đường cũ gọi nguyên thân bật/tắt này dưới khoá dòng;
  --   is_income_expense_flow_owned: chọn nhánh canonical / đường cũ.
  FOR r IN SELECT * FROM (VALUES
      ('public.verify_income_expense(uuid,text)', '39fd56487277e0729900b861152d2c67'),
      ('app_private.is_income_expense_flow_owned(uuid)', '34e0496590c0c7a1d13ec67b1fe1611c')
    ) AS v(fn, base_md5) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.base_md5 THEN
      RAISE EXCEPTION '% KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- verify_income_expense_v1: [thân production hai tham số, thân của chính tệp này ba tham số (lượt hai)].
  IF to_regprocedure('public.verify_income_expense_v1(uuid,text)') IS NOT NULL THEN
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.verify_income_expense_v1(uuid,text)');
    IF v_md5 IS DISTINCT FROM '96dee08afc9c585680f15553350b4a04' THEN
      RAISE EXCEPTION 'verify_income_expense_v1 (hai tham số) KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy', v_md5 USING ERRCODE = '55000';
    END IF;
    IF to_regprocedure('public.verify_income_expense_v1(uuid,text,boolean)') IS NOT NULL THEN
      RAISE EXCEPTION 'verify_income_expense_v1 đang có cả bản hai lẫn ba tham số — DỪNG' USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.verify_income_expense_v1(uuid,text,boolean)');
    IF v_md5 IS DISTINCT FROM '5c6cc367eb9324083277f1b72061dbef' THEN
      RAISE EXCEPTION 'verify_income_expense_v1 không ở bản hai tham số đã rà, cũng không ở bản của tệp này (md5 %) — DỪNG', v_md5 USING ERRCODE = '55000';
    END IF;
  END IF;
END
$requires$;

DROP FUNCTION IF EXISTS public.verify_income_expense_v1(uuid, text);

CREATE OR REPLACE FUNCTION public.verify_income_expense_v1(p_id uuid, p_note text DEFAULT NULL::text, p_verified boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.income_expenses%rowtype;
  v_can_see boolean;
  v_full_name text;
  v_rows integer;
  -- Đợt 10c: p_verified = giá trị muốn đặt (true = đã kiểm, false = bỏ kiểm). NULL ⇒ nút bật/tắt như cũ.
  v_flow_owned boolean;
  v_after public.income_expenses%rowtype;
begin
  if v_actor is null then
    raise exception 'Phải đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_id
   for update;
  if not found then
    raise exception 'Không tìm thấy phiếu';
  end if;

  v_flow_owned := app_private.is_income_expense_flow_owned(v_row.id);
  if not v_flow_owned and p_verified is null then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  -- Parity verify legacy: caller phải có quyền xem phiếu.
  select (
    public.is_super_admin()
    or public.is_admin()
    or (v_row.building_id is not null and public.can_access_building(v_row.building_id))
    or (v_row.account_id is not null
        and v_row.account_id in (select app_private.my_possessed_cashbook_ids_v1()))
  ) into v_can_see;
  if not v_can_see then
    raise exception 'Không có quyền xem phiếu này' using errcode = '42501';
  end if;

  -- Đợt 10c: ĐẶT giá trị — phiếu đã khoá FOR UPDATE ở trên, so SAU khi khoá. Đúng giá trị rồi ⇒ không ghi, không nhật ký.
  if p_verified is not null then
    if (v_row.verified_at is not null) = p_verified then
      return jsonb_build_object('id', v_row.id, 'changed', false, 'verified', p_verified,
        'verified_at', v_row.verified_at, 'verified_by_name', v_row.verified_by_name);
    end if;
    if not v_flow_owned then
      -- Phiếu đường cũ: nguyên thân public.verify_income_expense (bật/tắt) dưới khoá dòng của hàm này, sau khi đã so ⇒
      -- đảo chính là đặt về p_verified. Quyền bỏ kiểm (chủ kiểm / super admin) do thân đó kiểm như trước.
      perform public.verify_income_expense(p_id, p_note);
      select * into v_after from public.income_expenses where id = v_row.id;
      if (v_after.verified_at is not null) is distinct from p_verified then
        raise exception 'verify set-value did not reach % for %', p_verified, v_row.id using errcode = '55000';
      end if;
      return jsonb_build_object('id', v_row.id, 'changed', true, 'verified', p_verified,
        'verified_at', v_after.verified_at, 'verified_by_name', v_after.verified_by_name);
    end if;
  end if;

  if v_row.verified_at is not null then
    -- toggle bỏ kiểm: chỉ chủ kiểm hoặc super admin (parity legacy).
    if v_row.verified_by = v_actor or public.is_super_admin() then
      insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
      values (v_row.id, pg_current_xact_id(), 'UNVERIFY');

      update public.income_expenses
         set verified_at = null, verified_by = null,
             verified_by_name = null, verified_note = null
       where id = v_row.id;
      get diagnostics v_rows = row_count;

      delete from app_private.ie_transition_authorization
       where income_expense_id = v_row.id and xid = pg_current_xact_id();

      if v_rows <> 1 then
        raise exception 'unverify affected % rows (expected 1)', v_rows using errcode = '55000';
      end if;

      perform app_private.append_income_expense_event_v1(
        v_row.organization_id, v_row.id, 'UNVERIFIED', v_actor,
        app_private.ie_actor_display_name_v1(v_actor),
        v_row.approval_status, v_row.approval_status, null);
      return case when p_verified is null then null
        else jsonb_build_object('id', v_row.id, 'changed', true, 'verified', false,
          'verified_at', null, 'verified_by_name', null) end;
    else
      raise exception 'Phiếu đã được % kiểm — chỉ super admin hoặc người kiểm mới bỏ được',
        coalesce(v_row.verified_by_name, 'người khác');
    end if;
  end if;

  select coalesce(full_name, email, 'Người dùng') into v_full_name
    from public.profiles where id = v_actor;

  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'VERIFY');

  update public.income_expenses
     set verified_at = now(), verified_by = v_actor,
         verified_by_name = v_full_name,
         verified_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'verify affected % rows (expected 1)', v_rows using errcode = '55000';
  end if;

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'VERIFIED', v_actor,
    coalesce(v_full_name, 'Người dùng'),
    v_row.approval_status, v_row.approval_status,
    nullif(btrim(coalesce(p_note, '')), ''));
  return case when p_verified is null then null
    else jsonb_build_object('id', v_row.id, 'changed', true, 'verified', true,
      'verified_at', now(), 'verified_by_name', v_full_name) end;
end;
$function$;

COMMENT ON FUNCTION public.verify_income_expense_v1(uuid, text, boolean) IS
  'Voucher "checked" flag. p_verified NULL toggles exactly as before (canonical vouchers only, returns NULL). p_verified true/false locks the voucher, then sets that value: already equal returns {changed:false} without writing or logging; legacy (non flow-owned) vouchers go through public.verify_income_expense under the same row lock.';
REVOKE ALL ON FUNCTION public.verify_income_expense_v1(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_income_expense_v1(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_income_expense_v1(uuid, text, boolean) TO service_role;

-- ── Hậu kiểm ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
DO $hau_kiem$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.verify_income_expense_v1(uuid,text,boolean)', '5c6cc367eb9324083277f1b72061dbef'),
      ('public.verify_income_expense(uuid,text)', '39fd56487277e0729900b861152d2c67')
    ) AS v(fn, file_md5) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.file_md5 THEN
      RAISE EXCEPTION 'da_kiem_dat_gia_tri: % sau áp khác thân của tệp (md5 %)', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.verify_income_expense_v1(uuid,text,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.verify_income_expense_v1(uuid,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.verify_income_expense_v1(uuid,text,boolean)', 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = to_regprocedure('public.verify_income_expense_v1(uuid,text,boolean)')
          AND p.prosecdef AND p.provolatile = 'v' AND p.prorettype = 'jsonb'::regtype
          AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
          AND p.proconfig @> ARRAY['search_path=pg_catalog, public, app_private']) THEN
    RAISE EXCEPTION 'da_kiem_dat_gia_tri: verify_income_expense_v1 sai ACL / chủ sở hữu, không còn SECURITY DEFINER / VOLATILE / search_path ghim' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'verify_income_expense_v1') <> 1 THEN
    RAISE EXCEPTION 'da_kiem_dat_gia_tri: verify_income_expense_v1 phải còn đúng một bản' USING ERRCODE = '55000';
  END IF;
END
$hau_kiem$;
