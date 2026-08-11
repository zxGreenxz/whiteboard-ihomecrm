-- =============================================================================
-- ai_chat_threads / ai_chat_messages — bắt buộc có tổ chức, rồi rào.
-- Đây là HAI DÒNG CUỐI CÙNG trong sổ miễn trừ.
--
-- Lý do miễn trừ ghi trong sổ (hạn 30/09): "không có DEFAULT, không có trigger
-- autofill, và chatEngine.ts insert không set organization_id → gắn boundary
-- lúc này là chặn chính đường ghi của mình. Phải vá đường ghi trước."
--
-- Đo 09/08/2026: cả hai bảng hiện có 0 dòng NULL (GĐ6 đã vá phần cũ). Nên rủi
-- ro không nằm ở dữ liệu đang có mà ở INSERT TƯƠNG LAI — và nhánh
-- `organization_id IS NULL` của biên giới nghĩa là dòng như vậy lộ cho MỌI tổ
-- chức, im lặng.
--
-- ---------------------- VÌ SAO VÁ Ở DATABASE, KHÔNG Ở CLIENT ----------------
-- Sửa chatEngine.ts chỉ chặn được ĐÚNG MỘT đường ghi. Trigger chặn mọi đường:
-- client hiện tại, client sau này, script, RPC, người gõ tay qua PostgREST.
-- Client vẫn được sửa (cùng commit) nhưng là để CUNG CẤP thông tin, không phải
-- để làm hàng rào.
--
-- ------------------- VÌ SAO KHÔNG DÙNG app_private._autofill_org ------------
-- Hàm dùng chung đó có nhánh cuối rơi về HẰNG SỐ 'aaaa…' khi không suy được.
-- Với 30 bảng nghiệp vụ cũ thì đó là lựa chọn đã rồi; với bảng mới thì không —
-- nó biến "không biết thuộc về ai" thành "thuộc về công ty thật" mà không ai
-- hay. Hàm dưới đây FAIL-CLOSED: suy được thì điền, không suy được thì NỔ.
--
-- Nổ tốt hơn đoán ở đúng chỗ này vì hậu quả không đối xứng: một tin nhắn Copilot
-- không lưu được là phiền, còn một tin nhắn dán nhầm nhãn công ty là dữ liệu sai
-- vĩnh viễn trong một bảng chỉ-ghi-thêm.
--
-- BA NGUỒN, theo thứ tự tin cậy giảm dần:
--   1. Giá trị client TỰ KHAI. Người thuộc nhiều tổ chức thì chỉ client mới biết
--      đang chat trong ngữ cảnh tổ chức nào — database không có cách nào đoán.
--      Vẫn kiểm: tổ chức khai ra phải là tổ chức người đó THẬT SỰ thuộc về.
--   2. Với ai_chat_messages: tổ chức của LUỒNG cha. Chính xác hơn suy qua người.
--   3. Membership ACTIVE, và CHỈ khi người đó thuộc đúng MỘT tổ chức.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION app_private.autofill_org_chat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
DECLARE
  j        jsonb := to_jsonb(NEW);
  v_org    uuid;
  v_n      int;
  v_thuoc  boolean;
BEGIN
  -- (1) Client tự khai — nhưng phải CHỨNG MINH được, không tin suông.
  IF NEW.organization_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.organization_memberships m
                    WHERE m.user_id = NEW.user_id
                      AND m.organization_id = NEW.organization_id
                      AND m.status = 'ACTIVE')
      INTO v_thuoc;
    IF NOT v_thuoc THEN
      RAISE EXCEPTION '% : người dùng % không có membership ACTIVE ở tổ chức % — không được ghi dữ liệu chat vào tổ chức mình không thuộc.',
        TG_TABLE_NAME, NEW.user_id, NEW.organization_id
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- (2) Tin nhắn thì lấy theo LUỒNG cha — chính xác hơn suy qua người, và giữ
  --     cho mọi tin trong một luồng luôn cùng một tổ chức.
  IF (j ? 'thread_id') AND (j->>'thread_id') IS NOT NULL THEN
    SELECT t.organization_id INTO v_org
      FROM public.ai_chat_threads t WHERE t.id = (j->>'thread_id')::uuid;
  END IF;

  -- (3) Membership, CHỈ khi không mập mờ.
  IF v_org IS NULL AND NEW.user_id IS NOT NULL THEN
    SELECT (array_agg(DISTINCT m.organization_id))[1], count(DISTINCT m.organization_id)
      INTO v_org, v_n
      FROM public.organization_memberships m
     WHERE m.user_id = NEW.user_id AND m.status = 'ACTIVE';
    IF v_n IS DISTINCT FROM 1 THEN
      v_org := NULL;
    END IF;
  END IF;

  -- FAIL-CLOSED. Xem đầu file vì sao nổ tốt hơn đoán ở đúng chỗ này.
  IF v_org IS NULL THEN
    RAISE EXCEPTION '% : không xác định được tổ chức cho dòng chat của người dùng %. Client phải gửi kèm organization_id (người thuộc nhiều tổ chức thì chỉ client mới biết đang chat trong ngữ cảnh nào).',
      TG_TABLE_NAME, NEW.user_id
      USING ERRCODE = '23502';
  END IF;

  NEW.organization_id := v_org;
  RETURN NEW;
END;
$f$;

COMMENT ON FUNCTION app_private.autofill_org_chat() IS
  'Điền organization_id cho ai_chat_*. FAIL-CLOSED: không suy được thì NỔ, khác app_private._autofill_org vốn rơi về hằng số tổ chức thật.';

DROP TRIGGER IF EXISTS trg_autofill_org_chat ON public.ai_chat_threads;
CREATE TRIGGER trg_autofill_org_chat
  BEFORE INSERT ON public.ai_chat_threads
  FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_chat();

DROP TRIGGER IF EXISTS trg_autofill_org_chat ON public.ai_chat_messages;
CREATE TRIGGER trg_autofill_org_chat
  BEFORE INSERT ON public.ai_chat_messages
  FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_chat();

-- ---------------------------------------------------------------------------
-- Đường ghi đã kín thì mới rào được — đúng thứ tự mà sổ miễn trừ đòi.
-- ---------------------------------------------------------------------------
DO $rao$
DECLARE b text;
BEGIN
  FOREACH b IN ARRAY ARRAY['ai_chat_threads','ai_chat_messages'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', b || '_org_boundary', b);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (organization_id IS NULL OR (SELECT public.is_super_admin()) '
      '       OR organization_id IN (SELECT unnest(public.my_org_ids()))) '
      'WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) '
      '       OR organization_id IN (SELECT unnest(public.my_org_ids())))',
      b || '_org_boundary', b);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', b);
  END LOOP;
END
$rao$;

DELETE FROM app_private.org_boundary_exemptions
 WHERE table_name IN ('ai_chat_threads','ai_chat_messages');

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chạy thật cả bốn nhánh, không suy từ mã.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_uid   uuid;
  v_org   uuid;
  v_tid   uuid;
  v_n     bigint;
  v_code  text;
BEGIN
  SELECT m.user_id, m.organization_id INTO v_uid, v_org
    FROM public.organization_memberships m
   WHERE m.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = m.user_id)
   ORDER BY m.user_id LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Không có người dùng thường nào để nghiệm thu. DỪNG.';
  END IF;

  -- (a) Không khai org → trigger phải suy ra được từ membership.
  INSERT INTO public.ai_chat_threads (user_id, title)
  VALUES (v_uid, 'ZZ nghiệm thu') RETURNING id INTO v_tid;
  IF (SELECT organization_id FROM public.ai_chat_threads WHERE id = v_tid) IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Luồng chat không được điền đúng tổ chức. DỪNG.';
  END IF;

  -- (b) Tin nhắn phải lấy theo LUỒNG CHA.
  INSERT INTO public.ai_chat_messages (thread_id, user_id, role, content, metadata)
  VALUES (v_tid, v_uid, 'user', 'nghiệm thu', '{}'::jsonb);
  IF (SELECT organization_id FROM public.ai_chat_messages
       WHERE thread_id = v_tid ORDER BY seq DESC LIMIT 1) IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Tin nhắn không kế thừa tổ chức của luồng cha. DỪNG.';
  END IF;

  -- (c) Khai một tổ chức mà người đó KHÔNG thuộc → phải bị từ chối.
  BEGIN
    INSERT INTO public.ai_chat_threads (user_id, title, organization_id)
    VALUES (v_uid, 'ZZ tổ chức lạ', '99990000-0000-4000-8000-00000000ffff');
    RAISE EXCEPTION 'Ghi được vào tổ chức mình KHÔNG thuộc. DỪNG.';
  EXCEPTION WHEN sqlstate '42501' THEN
    NULL;
  END;

  -- (d) Người không có membership nào → phải NỔ, không được lặng lẽ để NULL.
  BEGIN
    INSERT INTO public.ai_chat_threads (user_id, title)
    VALUES ('11111111-2222-4333-8444-555555555555', 'ZZ mồ côi');
    RAISE EXCEPTION 'Người không membership vẫn ghi được — trigger không fail-closed. DỪNG.';
  EXCEPTION WHEN sqlstate '23502' THEN
    NULL;
  END;

  -- Dọn sạch dấu vết nghiệm thu.
  DELETE FROM public.ai_chat_messages WHERE thread_id = v_tid;
  DELETE FROM public.ai_chat_threads  WHERE id = v_tid;

  -- Sổ miễn trừ phải RỖNG sau file này.
  SELECT count(*) INTO v_n FROM app_private.org_boundary_exemptions;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Sổ miễn trừ còn % dòng. DỪNG.', v_n;
  END IF;

  RAISE NOTICE 'Nghiệm thu đạt cả 4 nhánh. Sổ miễn trừ đã RỖNG.';
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK: DROP TRIGGER trg_autofill_org_chat trên hai bảng, DROP FUNCTION
-- app_private.autofill_org_chat(), DROP hai policy *_org_boundary, và INSERT
-- lại hai dòng miễn trừ.
-- =============================================================================
