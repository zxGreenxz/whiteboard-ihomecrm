-- =============================================
-- Migration: Mã công khai ngắn cho hợp đồng (rút gọn link QR).
-- Trước: link QR = /public/contract/<contract.id UUID 36 ký tự>.
-- Sau:   link QR = /c/<public_code 6 ký tự ngẫu nhiên>.
-- - Mỗi hợp đồng có 1 public_code duy nhất, sinh tự động (trigger) khi tạo HĐ.
-- - Mã ngẫu nhiên (entropy từ gen_random_uuid v4) → không đoán/đếm được,
--   giữ nguyên mô hình bảo mật "ai có link thì xem được" như UUID cũ.
--   6 ký tự base-57 ≈ 34 tỉ tổ hợp: đủ ngắn nhưng vẫn chống brute-force
--   (RPC public không rate-limit, payload có tên + SĐT khách).
-- - RPC mới tra hoá đơn theo mã, gọi lại RPC cũ (không nhân đôi logic).
-- =============================================

-- 1) Cột public_code.
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS public_code TEXT;

-- 2) Hàm sinh mã base-57 (bỏ ký tự dễ nhầm 0 O 1 l I).
--    Lấy byte ngẫu nhiên từ gen_random_uuid() (core PG13+, không cần pgcrypto).
CREATE OR REPLACE FUNCTION public.gen_contract_public_code(len int DEFAULT 6)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  alphabet text := '23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  alen int := length(alphabet);          -- 57
  raw text := '';
  bytes bytea;
  result text := '';
  i int;
BEGIN
  -- Gom đủ byte ngẫu nhiên: mỗi uuid = 16 byte = 32 ký tự hex.
  WHILE length(raw) < len * 2 LOOP
    raw := raw || replace(gen_random_uuid()::text, '-', '');
  END LOOP;
  bytes := decode(substr(raw, 1, len * 2), 'hex');
  FOR i IN 0..len - 1 LOOP
    result := result || substr(alphabet, (get_byte(bytes, i) % alen) + 1, 1);
  END LOOP;
  RETURN result;
END;
$$;

-- 3) Trigger tự gán mã (retry khi trùng; >10 lần thì tăng độ dài lên 8).
CREATE OR REPLACE FUNCTION public.set_contract_public_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate text;
  tries int := 0;
BEGIN
  IF NEW.public_code IS NOT NULL AND NEW.public_code <> '' THEN
    RETURN NEW;
  END IF;
  LOOP
    candidate := public.gen_contract_public_code(6);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.contracts WHERE public_code = candidate);
    tries := tries + 1;
    IF tries >= 10 THEN
      candidate := public.gen_contract_public_code(8);
      EXIT;
    END IF;
  END LOOP;
  NEW.public_code := candidate;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_contract_public_code ON public.contracts;
CREATE TRIGGER trg_set_contract_public_code
  BEFORE INSERT ON public.contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_contract_public_code();

-- 4) Backfill mọi HĐ hiện có (mã unique từng row).
DO $$
DECLARE
  r RECORD;
  candidate text;
BEGIN
  FOR r IN SELECT id FROM public.contracts WHERE public_code IS NULL LOOP
    LOOP
      candidate := public.gen_contract_public_code(6);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.contracts WHERE public_code = candidate);
    END LOOP;
    UPDATE public.contracts SET public_code = candidate WHERE id = r.id;
  END LOOP;
END $$;

-- 5) Mọi HĐ giờ đã có mã → ép NOT NULL + ràng buộc duy nhất.
ALTER TABLE public.contracts ALTER COLUMN public_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contracts_public_code_key
  ON public.contracts(public_code);

-- 6) RPC public tra hoá đơn mới nhất theo mã ngắn.
--    Resolve mã → contract.id rồi gọi lại RPC cũ (đã guard TERMINATED/deleted,
--    không expose notes/contract_id/user_id).
CREATE OR REPLACE FUNCTION public.get_public_latest_invoice_by_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_code IS NULL OR p_code = '' THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_id
  FROM public.contracts
  WHERE public_code = p_code
    AND deleted_at IS NULL;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN public.get_public_latest_invoice_by_contract(v_id);
END;
$$;

COMMENT ON FUNCTION public.get_public_latest_invoice_by_code(text) IS
'Public read API cho khách quét QR theo mã ngắn (contracts.public_code). Resolve mã → contract.id rồi gọi get_public_latest_invoice_by_contract. Trả NULL nếu mã sai / HĐ đã thanh lý / bị xoá.';

GRANT EXECUTE ON FUNCTION public.get_public_latest_invoice_by_code(text)
  TO anon, authenticated;

-- 7) Gỡ đường truy cập cũ: chỉ còn 1 cổng public duy nhất (theo mã).
--    Postgres mặc định GRANT EXECUTE cho PUBLIC trên mọi hàm, mà anon kế thừa
--    từ PUBLIC → phải REVOKE cả PUBLIC, không chỉ anon/authenticated.
--    Hàm cũ giữ lại làm logic dùng chung: by-code RPC gọi nội bộ vẫn chạy vì
--    SECURITY DEFINER → thực thi theo quyền owner (postgres) chứ không phải anon.
REVOKE EXECUTE ON FUNCTION public.get_public_latest_invoice_by_contract(uuid)
  FROM PUBLIC, anon, authenticated;
