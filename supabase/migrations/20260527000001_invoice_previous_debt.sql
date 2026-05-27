-- =============================================
-- Migration: Invoice Previous Debt (Nợ cũ) tracking + cascade
-- Date: 2026-05-27
--
-- Mục tiêu:
-- 1. Thêm previous_debt_sources (jsonb) trên invoices để track nguồn nợ cũ:
--    - {type:"invoice", id:<uuid>, amount:<num>, label:<text>}        — nợ HĐ cũ
--    - {type:"deposit",  contract_id:<uuid>, amount:<num>, label:<text>} — cọc còn thiếu
-- 2. Khi HĐ status chuyển sang PAID → trigger cascade:
--    - Đối với mỗi invoice source: mark paid (paid_amount = total_amount, status=PAID, append note)
--    - Đối với mỗi deposit source: cộng vào contracts.deposit_paid (clamp <= total_deposit)
-- 3. Cập nhật cài đặt invoice_config: bật mặc định include_previous_debt = true.
-- =============================================

-- 1) Add column
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS previous_debt_sources jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.invoices.previous_debt_sources IS
  'Danh sách nguồn của previous_debt. Mỗi item: {type:"invoice"|"deposit", id?:uuid, contract_id?:uuid, amount:number, label:text}. Khi HĐ PAID → trigger cascade tất toán nguồn.';

-- 2) Trigger function: cascade settle on PAID
CREATE OR REPLACE FUNCTION public.settle_previous_debt_sources()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  src       jsonb;
  src_type  text;
  src_id    uuid;
  src_amt   numeric;
  src_label text;
  c_id      uuid;
BEGIN
  -- Chỉ chạy khi status vừa chuyển sang PAID và có sources
  IF NEW.status <> 'PAID' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'PAID' THEN
    RETURN NEW;
  END IF;
  IF NEW.previous_debt_sources IS NULL
     OR jsonb_typeof(NEW.previous_debt_sources) <> 'array'
     OR jsonb_array_length(NEW.previous_debt_sources) = 0 THEN
    RETURN NEW;
  END IF;

  FOR src IN SELECT * FROM jsonb_array_elements(NEW.previous_debt_sources)
  LOOP
    src_type  := src->>'type';
    src_amt   := COALESCE((src->>'amount')::numeric, 0);
    src_label := COALESCE(src->>'label', '');

    IF src_amt <= 0 THEN
      CONTINUE;
    END IF;

    IF src_type = 'invoice' THEN
      src_id := NULLIF(src->>'id', '')::uuid;
      IF src_id IS NULL THEN CONTINUE; END IF;
      UPDATE public.invoices
        SET paid_amount = total_amount,
            status      = 'PAID',
            paid_date   = COALESCE(paid_date, NEW.paid_date, CURRENT_DATE),
            notes       = CASE
                            WHEN notes IS NULL OR notes = '' THEN
                              '[Tự động tất toán qua HĐ ' || COALESCE(NEW.invoice_number, NEW.id::text) || ']'
                            ELSE
                              notes || E'\n[Tự động tất toán qua HĐ ' || COALESCE(NEW.invoice_number, NEW.id::text) || ']'
                          END
      WHERE id = src_id
        AND status <> 'PAID'
        AND deleted_at IS NULL;

    ELSIF src_type = 'deposit' THEN
      c_id := NULLIF(src->>'contract_id', '')::uuid;
      IF c_id IS NULL THEN CONTINUE; END IF;
      UPDATE public.contracts
        SET deposit_paid = LEAST(
              COALESCE(total_deposit, 0),
              COALESCE(deposit_paid, 0) + src_amt
            )
      WHERE id = c_id;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_settle_previous_debt ON public.invoices;
CREATE TRIGGER trg_settle_previous_debt
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (NEW.status = 'PAID' AND OLD.status IS DISTINCT FROM 'PAID')
  EXECUTE FUNCTION public.settle_previous_debt_sources();

-- 3) Bật mặc định include_previous_debt trong setting invoice_config (nếu user đã có)
UPDATE public.settings
  SET value = jsonb_set(value, '{include_previous_debt}', 'true'::jsonb, true)
WHERE key = 'invoice_config';
