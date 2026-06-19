-- =============================================
-- Đội ngũ (Teams): nhóm nhân viên cùng đội thấy nhau + bàn giao tiền nội đội.
--  - teams / team_members (owner-scoped, soft-delete teams).
--  - same_team(target): SECURITY DEFINER — dùng trong RLS & RPC, chống đệ quy.
--  - profiles: thêm policy SELECT cho ĐỒNG ĐỘI (additive, permissive — KHÔNG đụng policy cũ).
--  - create_cash_handover: chặn bàn giao cho người KHÁC đội.
-- =============================================

-- ── Bảng teams ──
CREATE TABLE IF NOT EXISTS public.teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- chủ sở hữu đội
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS teams_user_idx ON public.teams(user_id);

-- ── Bảng team_members (N-N người ↔ đội) ──
CREATE TABLE IF NOT EXISTS public.team_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,    -- người trong đội
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,    -- chủ (denormalize → RLS khỏi join teams)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, member_id)
);
CREATE INDEX IF NOT EXISTS team_members_team_idx   ON public.team_members(team_id);
CREATE INDEX IF NOT EXISTS team_members_member_idx ON public.team_members(member_id);
CREATE INDEX IF NOT EXISTS team_members_user_idx   ON public.team_members(user_id);

-- ── Triggers: updated_at + auto user_id = auth.uid() (chủ) khi insert ──
DROP TRIGGER IF EXISTS set_teams_updated_at ON public.teams;
CREATE TRIGGER set_teams_updated_at BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS teams_set_user_id_audit ON public.teams;
CREATE TRIGGER teams_set_user_id_audit BEFORE INSERT ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

DROP TRIGGER IF EXISTS team_members_set_user_id_audit ON public.team_members;
CREATE TRIGGER team_members_set_user_id_audit BEFORE INSERT ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

-- ── Helper: hai user có CÙNG đội không (SECURITY DEFINER, bypass RLS) ──
CREATE OR REPLACE FUNCTION public.same_team(_target uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.team_members a
    JOIN public.team_members b ON a.team_id = b.team_id
    WHERE a.member_id = auth.uid()
      AND b.member_id = _target
  );
$$;
GRANT EXECUTE ON FUNCTION public.same_team(uuid) TO authenticated, service_role;

-- ── RLS ──
ALTER TABLE public.teams        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- teams: chủ/admin thấy & sửa; thành viên được xem đội mình thuộc.
DROP POLICY IF EXISTS teams_select ON public.teams;
CREATE POLICY teams_select ON public.teams
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_super_admin()
    OR public.is_admin()
    OR EXISTS (SELECT 1 FROM public.team_members tm
               WHERE tm.team_id = teams.id AND tm.member_id = auth.uid())
  );

DROP POLICY IF EXISTS teams_write ON public.teams;
CREATE POLICY teams_write ON public.teams
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_super_admin());

-- team_members: chủ + chính mình + đồng đội xem; chỉ chủ thêm/bớt.
DROP POLICY IF EXISTS team_members_select ON public.team_members;
CREATE POLICY team_members_select ON public.team_members
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR member_id = auth.uid()
    OR public.same_team(member_id)
    OR public.is_super_admin()
    OR public.is_admin()
  );

DROP POLICY IF EXISTS team_members_write ON public.team_members;
CREATE POLICY team_members_write ON public.team_members
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_super_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.teams        TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_members TO authenticated, service_role;
REVOKE ALL ON public.teams        FROM anon;
REVOKE ALL ON public.team_members FROM anon;

-- ── profiles: thêm policy SELECT cho ĐỒNG ĐỘI (additive) ──
DROP POLICY IF EXISTS profiles_select_same_team ON public.profiles;
CREATE POLICY profiles_select_same_team ON public.profiles
  FOR SELECT TO authenticated
  USING (public.same_team(id));

-- ── create_cash_handover: thêm guard "người nhận phải cùng đội" ──
-- (giữ nguyên thân hàm gốc, chỉ chèn 1 khối kiểm tra sau bước xác thực người nhận)
CREATE OR REPLACE FUNCTION public.create_cash_handover(p_receiver_id uuid, p_voucher_ids uuid[], p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids        uuid[];
  v_cnt        int;
  v_from_acc   uuid;
  v_acc_owner  uuid;
  v_sum        numeric;
  v_recv_name  text;
  v_recv_active boolean;
  v_giver_name text;
  v_month      text;
  v_seq        int;
  v_code       text;
  v_id         uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_receiver_id IS NULL OR p_receiver_id = auth.uid() THEN
    RAISE EXCEPTION 'Người nhận không hợp lệ (không thể tự bàn giao cho chính mình)';
  END IF;

  SELECT full_name, is_active INTO v_recv_name, v_recv_active
    FROM profiles WHERE id = p_receiver_id;
  IF NOT FOUND OR v_recv_active IS FALSE THEN
    RAISE EXCEPTION 'Người nhận không tồn tại hoặc đã bị khoá';
  END IF;

  -- Chặn bàn giao ngoài đội (trừ super admin)
  IF NOT (public.is_super_admin() OR public.same_team(p_receiver_id)) THEN
    RAISE EXCEPTION 'Người nhận không cùng đội với bạn';
  END IF;

  v_ids := ARRAY(SELECT DISTINCT unnest(p_voucher_ids));
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Chưa chọn phiếu thu nào để bàn giao';
  END IF;

  -- Khoá các phiếu chống race 2 phiên cùng lúc
  PERFORM 1 FROM income_expenses WHERE id = ANY(v_ids) FOR UPDATE;

  SELECT count(*) INTO v_cnt
    FROM income_expenses
   WHERE id = ANY(v_ids)
     AND type = 'INCOME' AND approval_status = 'APPROVED'
     AND deleted_at IS NULL AND handover_id IS NULL AND account_id IS NOT NULL;
  IF v_cnt <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'Có phiếu không hợp lệ (đã xoá / đã nằm trong phiên bàn giao khác / không phải phiếu thu đã duyệt)';
  END IF;

  SELECT count(DISTINCT account_id) INTO v_cnt FROM income_expenses WHERE id = ANY(v_ids);
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Các phiếu bàn giao phải cùng MỘT sổ quỹ';
  END IF;
  SELECT account_id, sum(total_amount) INTO v_from_acc, v_sum
    FROM income_expenses WHERE id = ANY(v_ids) GROUP BY account_id;

  SELECT user_id INTO v_acc_owner FROM accounts
   WHERE id = v_from_acc AND deleted_at IS NULL;
  IF v_acc_owner IS NULL OR v_acc_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ bàn giao được phiếu nằm trong sổ quỹ do chính bạn sở hữu';
  END IF;

  SELECT COALESCE(full_name, '') INTO v_giver_name FROM profiles WHERE id = auth.uid();

  -- Mã BG{YYMM}{seq3} — advisory lock chống trùng khi 2 phiên tạo song song
  PERFORM pg_advisory_xact_lock(hashtext('cash_handover_code'));
  v_month := to_char(CURRENT_DATE, 'YYMM');
  SELECT COALESCE(MAX(
           CASE WHEN code ~ ('^BG' || v_month || '\d+$')
                THEN substring(code FROM 7)::int ELSE 0 END
         ), 0) + 1
    INTO v_seq
    FROM cash_handovers WHERE code LIKE 'BG' || v_month || '%';
  v_code := 'BG' || v_month || lpad(v_seq::text, 3, '0');

  INSERT INTO cash_handovers
    (code, giver_id, receiver_id, giver_name, receiver_name,
     from_account_id, total_amount, voucher_count, note)
  VALUES
    (v_code, auth.uid(), p_receiver_id, v_giver_name, v_recv_name,
     v_from_acc, v_sum, array_length(v_ids, 1), NULLIF(btrim(p_note), ''))
  RETURNING id INTO v_id;

  INSERT INTO cash_handover_items
    (handover_id, voucher_id, amount, voucher_code, voucher_date, room_name, building_name)
  SELECT v_id, ie.id, ie.total_amount, ie.code, ie.voucher_date, r.name, b.name
    FROM income_expenses ie
    LEFT JOIN rooms r     ON r.id = ie.room_id
    LEFT JOIN buildings b ON b.id = ie.building_id
   WHERE ie.id = ANY(v_ids);

  UPDATE income_expenses SET handover_id = v_id WHERE id = ANY(v_ids);

  RETURN jsonb_build_object(
    'id', v_id, 'code', v_code,
    'total_amount', v_sum, 'voucher_count', array_length(v_ids, 1));
END;
$function$;
