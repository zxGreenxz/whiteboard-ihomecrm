-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.generate_contract_number() md5(prosrc)=88e5d773c61c860d12573f49b1d70c59
CREATE OR REPLACE FUNCTION public.generate_contract_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_prefix  text;
  v_org     uuid   := NEW.organization_id;
  v_year    integer := EXTRACT(YEAR FROM now())::integer;
  v_seed    bigint;
  v_counter bigint;
  v_new     text;
  v_lan     integer := 0;
BEGIN
  IF NEW.contract_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Tiền tố theo cài đặt của người tạo, mặc định 'HD' (giữ nguyên hành vi cũ).
  -- Đo 15/09/2026: bảng settings KHÔNG có dòng nào key='contract_number_format',
  -- nên hôm nay nhánh này luôn ra 'HD'.
  SELECT COALESCE(s.value->>'contract_prefix', 'HD')
    INTO v_prefix
    FROM public.settings s
   WHERE s.user_id = NEW.user_id
     AND s.key = 'contract_number_format';
  IF v_prefix IS NULL OR v_prefix = '' THEN
    v_prefix := 'HD';
  END IF;

  -- Đường lùi: không xác định được công ty thì giữ nguyên cách đếm cũ thay vì
  -- ngã. Trên production nhánh này không chạy — `trg_autofill_org` đứng trước
  -- và luôn điền organization_id (có cả fallback về org PROD), và
  -- contracts.organization_id đang 0 dòng NULL.
  IF v_org IS NULL THEN
    SELECT COUNT(*) + 1
      INTO v_counter
      FROM public.contracts c
     WHERE c.user_id = NEW.user_id
       AND EXTRACT(YEAR FROM c.created_at) = v_year;
    NEW.contract_number := v_prefix || '-' || v_year::text || '-' || lpad(v_counter::text, 5, '0');
    RETURN NEW;
  END IF;

  -- Seed chỉ chạy khi cặp (org, năm) chưa có dòng đếm — tức một lần mỗi công ty
  -- mỗi năm. Không đặt ngoài IF: câu SELECT dưới đây quét contracts theo org, và
  -- chạy nó ở MỌI lần tạo hợp đồng là trả giá mãi mãi cho một việc dùng một lần.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.contract_number_counters
     WHERE organization_id = v_org AND year = v_year
  ) THEN
    -- Seed CHỈ từ số đúng khuôn '<tiền tố>-<năm>-<số>'. Số nhập từ ngoài
    -- ('HĐT-045073/11102024') không khớp nên không kéo bộ đếm đi lung tung.
    -- KHÔNG lọc deleted_at: số của hợp đồng đã xoá mềm vẫn là số đã dùng.
    SELECT COALESCE(max((substring(c.contract_number from '([0-9]{1,9})$'))::bigint), 0)
      INTO v_seed
      FROM public.contracts c
     WHERE c.organization_id = v_org
       AND c.contract_number ~ ('-' || v_year::text || '-[0-9]{1,9}$');

    INSERT INTO app_private.contract_number_counters (organization_id, year, last_no)
    VALUES (v_org, v_year, v_seed)
    ON CONFLICT (organization_id, year) DO NOTHING;
  END IF;

  LOOP
    v_lan := v_lan + 1;

    -- ĐÂY là chỗ chống đua: UPDATE khoá đúng một dòng, transaction thứ hai đợi
    -- rồi đọc last_no đã tăng. Không dùng SELECT … FOR UPDATE rồi UPDATE riêng —
    -- một lệnh thì không có khe hở giữa đọc và ghi.
    UPDATE app_private.contract_number_counters
       SET last_no = last_no + 1,
           updated_at = now()
     WHERE organization_id = v_org
       AND year = v_year
    RETURNING last_no INTO v_counter;

    IF v_counter IS NULL THEN
      RAISE EXCEPTION 'generate_contract_number: khong co dong dem cho org % nam %', v_org, v_year;
    END IF;

    v_new := v_prefix || '-' || v_year::text || '-' || lpad(v_counter::text, 5, '0');

    -- Bộ đếm mới nên không biết các số trùng/lệch có từ trước. Nhảy qua số đã
    -- dùng thay vì đẻ thêm một cặp trùng nữa.
    EXIT WHEN NOT EXISTS (
      SELECT 1
        FROM public.contracts c
       WHERE c.organization_id = v_org
         AND c.contract_number = v_new
    );

    IF v_lan >= 1000 THEN
      RAISE EXCEPTION 'generate_contract_number: khong tim duoc so trong sau % lan (org %, nam %)',
        v_lan, v_org, v_year;
    END IF;
  END LOOP;

  NEW.contract_number := v_new;
  RETURN NEW;
END;
$function$

