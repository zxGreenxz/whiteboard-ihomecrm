-- Finance V2 — 7ad: set_cashbook_access_v2 nổ 22P02 khi actor TỰ GIỮ SỔ.
--
-- Fleet-agent writers-scope phát hiện: nhánh chống self-role-change (§2.5) dựng
-- v_after bằng `v_after || 'CUSTODIAN'` — Postgres resolve `text[] || unknown`
-- thành toán tử array‖array và parse chuỗi 'CUSTODIAN' như array literal →
-- `22P02 malformed array literal: "CUSTODIAN"`. Đây là CA BÌNH THƯỜNG NHẤT của
-- form quản trị sổ: người chia sẻ (đang là CUSTODIAN) thêm người khác mà vẫn
-- giữ mình trong danh sách → RPC chết ngay trước khi ghi gì.
--
-- Fix: ép kiểu ::text để `||` resolve array‖element. Def-replace marker '7ad'.

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'set_cashbook_access_v2';

  IF v_def IS NULL THEN
    RAISE EXCEPTION '7ad: set_cashbook_access_v2 không tồn tại';
  END IF;
  IF v_def LIKE '%7ad: array-element append%' THEN
    RETURN; -- đã vá
  END IF;

  v_def := replace(v_def,
    $$IF v_actor_membership = ANY (COALESCE(p_custodians, '{}')) THEN v_after := v_after || 'CUSTODIAN'; END IF;
  IF v_actor_membership = ANY (COALESCE(p_knowers, '{}')) THEN v_after := v_after || 'KNOWER'; END IF;$$,
    $$IF v_actor_membership = ANY (COALESCE(p_custodians, '{}')) THEN v_after := v_after || 'CUSTODIAN'::text; END IF; -- 7ad: array-element append (không ép ::text thì '||' thành array‖array → 22P02)
  IF v_actor_membership = ANY (COALESCE(p_knowers, '{}')) THEN v_after := v_after || 'KNOWER'::text; END IF;$$);

  IF v_def NOT LIKE '%7ad: array-element append%' THEN
    RAISE EXCEPTION '7ad: pattern v_after không khớp — kiểm tra thủ công';
  END IF;
  EXECUTE v_def;
END
$patch$;

-- Smoke (probe tự-rollback, JWT giả lập CHUNHA): giữ nguyên danh sách hiện tại
-- của 1 sổ CHUNHA đang CUSTODIAN (actor tự giữ) → RPC phải chạy (không 22P02);
-- no-op reapply cùng danh sách là hợp lệ.
DO $smoke$
DECLARE
  v_org uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_book uuid;
  v_mem uuid;
  v_rev bigint;
  v_cust uuid[];
  v_know uuid[];
  v_out jsonb;
BEGIN
  SELECT b.cashbook_id, b.membership_id INTO v_book, v_mem
  FROM public.cashbook_possession_bindings b
  JOIN public.organization_memberships m ON m.id = b.membership_id
  WHERE b.organization_id = v_org AND b.possession_kind = 'CUSTODIAN'
    AND b.valid_to IS NULL AND m.status = 'ACTIVE'
  LIMIT 1;
  IF v_book IS NULL THEN
    RAISE NOTICE '7ad smoke: DEMO không có binding CUSTODIAN — bỏ qua probe';
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(b.membership_id) FILTER (WHERE b.possession_kind = 'CUSTODIAN'), '{}'),
         COALESCE(array_agg(b.membership_id) FILTER (WHERE b.possession_kind = 'KNOWER'), '{}')
    INTO v_cust, v_know
  FROM public.cashbook_possession_bindings b
  WHERE b.organization_id = v_org AND b.cashbook_id = v_book AND b.valid_to IS NULL;

  SELECT COALESCE(s.revision, 0) INTO v_rev
  FROM app_private.cashbook_access_states s
  WHERE s.organization_id = v_org AND s.cashbook_id = v_book;

  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', (SELECT m.user_id FROM public.organization_memberships m WHERE m.id = v_mem),
                        'role', 'authenticated')::text, true);
    v_out := public.set_cashbook_access_v2(
      v_book, v_cust, v_know, COALESCE(v_rev, 0),
      'smoke-7ad-' || gen_random_uuid()::text);
    RAISE EXCEPTION 'SMOKE_ROLLBACK_7AD';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'SMOKE_ROLLBACK_7AD' THEN RAISE; END IF;
  END;
  RAISE NOTICE '7ad smoke PASS: actor tự giữ sổ reapply không 22P02; probe rollback';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
