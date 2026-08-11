-- =============================================================================
-- Chặn NULL organization_id — đợt hai: ba bảng nữa lộ ra ngay sau đợt một
--
-- 20260811010000 vá 6 bảng và gắn trigger. Chạy lại gate NGAY SAU ĐÓ thì lộ tiếp
-- ba bảng khác cũng đang chảy NULL với số lượng lớn hơn:
--
--   cash_handover_items 81 · public_room_events 48 · salary_award_errors 19
--
-- Đây không phải đợt một làm sót — đó là cách một điểm mù lộ dần: gate chỉ thấy
-- được bảng ĐANG có dòng NULL, mà mỗi lần vá xong lại có bảng khác kịp tích thêm
-- dòng mới. Ghi lại nhịp này vì nó là dữ kiện về TỐC ĐỘ phát sinh, không phải về
-- sự cẩu thả: 105 bảng nhận được NULL, và app ghi vào chúng liên tục.
--
-- HAI CHỖ SỬA:
--   1. app_private.autofill_org_strict() thiếu `owner_id`. public_room_events có
--      owner_id NOT NULL nhưng không có user_id, nên hàm đợt một không suy được
--      cho nó. Thêm vào danh sách cột-người.
--   2. Gắn trigger cho ba bảng này, và vá dòng đang có.
--
-- cash_handover_items suy qua handover_id → cash_handovers (đã có trong danh
-- sách cha từ đợt một), nên nó chỉ cần được GẮN trigger; và nó phải vá SAU
-- cash_handovers — dây chuyền, đúng mẫu GĐ6.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Bổ sung owner_id vào hàm suy. Phần còn lại giữ nguyên từ 20260811010000.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.autofill_org_strict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
DECLARE
  j     jsonb := to_jsonb(NEW);
  v_org uuid;
  v_n   int;
  cha   text[][] := ARRAY[
    ARRAY['session_id',  'inspection_sessions'],
    ARRAY['usage_id',    'material_usages'],
    ARRAY['handover_id', 'cash_handovers'],
    ARRAY['building_id', 'buildings'],
    ARRAY['room_id',     'rooms'],
    ARRAY['contract_id', 'contracts'],
    ARRAY['invoice_id',  'invoices']
  ];
  -- owner_id thêm ở đợt hai: public_room_events có owner_id NOT NULL nhưng
  -- KHÔNG có user_id, nên bản đợt một không suy được cho nó.
  nguoi text[] := ARRAY['user_id', 'owner_id', 'giver_id', 'staff_id'];
  i     int;
BEGIN
  IF NEW.organization_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  FOR i IN 1 .. array_length(cha, 1) LOOP
    CONTINUE WHEN NOT (j ? cha[i][1]) OR (j->>cha[i][1]) IS NULL;
    EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', cha[i][2])
      INTO v_org USING (j->>cha[i][1])::uuid;
    EXIT WHEN v_org IS NOT NULL;
  END LOOP;

  IF v_org IS NULL THEN
    FOR i IN 1 .. array_length(nguoi, 1) LOOP
      CONTINUE WHEN NOT (j ? nguoi[i]) OR (j->>nguoi[i]) IS NULL;
      SELECT (array_agg(DISTINCT m.organization_id))[1], count(DISTINCT m.organization_id)
        INTO v_org, v_n
        FROM public.organization_memberships m
       WHERE m.user_id = (j->>nguoi[i])::uuid AND m.status = 'ACTIVE';
      IF v_n IS DISTINCT FROM 1 THEN v_org := NULL; END IF;
      EXIT WHEN v_org IS NOT NULL;
    END LOOP;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION '% : không suy được organization_id cho dòng này. Đường ghi phải tự khai organization_id, hoặc dòng phải có cha/người thuộc đúng một tổ chức.',
      TG_TABLE_NAME USING ERRCODE = '23502';
  END IF;

  NEW.organization_id := v_org;
  RETURN NEW;
END;
$f$;

-- ---------------------------------------------------------------------------
-- 2. Vá dòng đang có. cash_handover_items đi SAU cash_handovers — dây chuyền.
-- ---------------------------------------------------------------------------
DO $va$
DECLARE v_n bigint; v_tong bigint := 0;
BEGIN
  UPDATE public.public_room_events t SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org FROM public.organization_memberships
           WHERE status='ACTIVE' GROUP BY user_id HAVING count(DISTINCT organization_id)=1) m
   WHERE m.user_id = t.owner_id AND t.organization_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.salary_award_errors t SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org FROM public.organization_memberships
           WHERE status='ACTIVE' GROUP BY user_id HAVING count(DISTINCT organization_id)=1) m
   WHERE m.user_id = t.staff_id AND t.organization_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.cash_handover_items t SET organization_id = p.organization_id
    FROM public.cash_handovers p
   WHERE p.id = t.handover_id AND t.organization_id IS NULL AND p.organization_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  RAISE NOTICE 'Đợt hai: điền organization_id cho % dòng.', v_tong;
END
$va$;

-- ---------------------------------------------------------------------------
-- 3. Gắn trigger.
-- ---------------------------------------------------------------------------
DO $gan$
DECLARE b text;
BEGIN
  FOREACH b IN ARRAY ARRAY['public_room_events','salary_award_errors','cash_handover_items'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_autofill_org_strict ON public.%I', b);
    EXECUTE format(
      'CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict()', b);
  END LOOP;
END
$gan$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — quét TOÀN BỘ, không chỉ ba bảng vừa gắn. Đợt một đã cho thấy
-- kiểm hẹp thì lần sau lại lộ bảng khác.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  r record; v_n bigint; v_con text := ''; v_tong bigint := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id'
                         AND a.attnum>0 AND NOT a.attisdropped AND NOT a.attnotnull
     WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
       AND NOT c.relispartition
       AND NOT EXISTS (SELECT 1 FROM app_private.org_null_is_global g WHERE g.table_name = c.relname)
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', r.relname) INTO v_n;
    IF v_n > 0 THEN v_tong := v_tong + v_n; v_con := v_con || format('%s(%s) ', r.relname, v_n); END IF;
  END LOOP;

  IF v_tong > 0 THEN
    RAISE EXCEPTION 'Còn % dòng NULL ở bảng chưa khai: %', v_tong, v_con;
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   WHERE t.tgname = 'trg_autofill_org_strict' AND NOT t.tgisinternal;
  RAISE NOTICE 'Sạch toàn bộ dòng NULL. Trigger chặn đang gác % bảng.', v_n;
END
$nghiem_thu$;

COMMIT;
