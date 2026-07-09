-- =============================================================================
-- Kiểm soát triệt để phiếu chi Hoa hồng môi giới / Thưởng nóng Sale
-- Mỗi HĐ = tối đa 1 phiếu MỖI LOẠI (broker/sale), chặn cứng ở DB.
--
-- - commission_kind: cột suy diễn từ items (trigger, SECURITY DEFINER) —
--   client insert thẳng không lách được. 'broker' = Hoa hồng môi giới,
--   'sale' = Thưởng nóng Sale. Match type theo tên CHÍNH XÁC qua nrm_vn()
--   (không LIKE — không đụng "Hoa hồng đối tác" hay hạng mục khác).
-- - commission_legacy_dup: phiếu TRÙNG có sẵn trước migration (audit 09/07:
--   5 HĐ có 2-4 phiếu broker sống). KHÔNG xóa dữ liệu tiền thật — chỉ đánh
--   dấu để loại khỏi unique index; chủ tự rà và hủy phiếu thừa sau.
--   Giữ phiếu TẠO SỚM NHẤT trong index, cờ các phiếu sau.
-- - uq_ie_commission_per_contract: hàng rào cuối — phiếu SỐNG (chưa xóa,
--   chưa hủy) không legacy: unique (contract_id, commission_kind).
--   Hủy (CANCELLED) / xóa phiếu sai thì tạo lại được.
-- - Guard: phiếu hoa hồng BẮT BUỘC gắn HĐ (quyết định chủ dự án 09/07);
--   chi hoa hồng đối tác ngoài phải dùng hạng mục khác. Không gỡ được
--   contract_id khỏi phiếu HH đang sống. Phiếu cũ không HĐ (12 phiếu)
--   được giữ nguyên (guard chỉ chặn chuyển-thành-vi-phạm, không chặn
--   sửa cột khác trên phiếu cũ).
-- =============================================================================

BEGIN;

-- 1) Cột
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS commission_kind text
    CHECK (commission_kind IN ('broker','sale'));
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS commission_legacy_dup boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.income_expenses.commission_kind IS
  'Suy diễn từ items qua trigger: broker = Hoa hồng môi giới, sale = Thưởng nóng Sale. Unique per contract (uq_ie_commission_per_contract).';
COMMENT ON COLUMN public.income_expenses.commission_legacy_dup IS
  'Phiếu HH trùng tồn tại TRƯỚC migration 20260709110000 — nằm ngoài unique index, chờ chủ rà soát/hủy. Không set true cho phiếu mới.';

-- 2) Backfill commission_kind từ items (mọi phiếu EXPENSE, kể cả đã xóa/hủy —
--    để báo cáo lịch sử theo kind đúng). Trigger chưa tạo nên không bị guard chặn.
UPDATE public.income_expenses ie
   SET commission_kind = sub.kind
  FROM (
    SELECT it.income_expense_id,
           CASE WHEN bool_or(public.nrm_vn(tp.name) = 'thuong nong sale') THEN 'sale'
                ELSE 'broker' END AS kind
      FROM public.income_expense_items it
      JOIN public.income_expense_types tp ON tp.id = it.income_expense_type_id
     WHERE public.nrm_vn(tp.name) IN ('hoa hong moi gioi','thuong nong sale')
     GROUP BY it.income_expense_id
  ) sub
 WHERE ie.id = sub.income_expense_id
   AND ie.type = 'EXPENSE'
   AND ie.commission_kind IS DISTINCT FROM sub.kind;

-- 3) Cờ legacy cho phiếu trùng đang sống: giữ phiếu tạo sớm nhất, cờ phần còn lại
UPDATE public.income_expenses ie
   SET commission_legacy_dup = true
  FROM (
    SELECT id, row_number() OVER (
             PARTITION BY contract_id, commission_kind
             ORDER BY created_at ASC, id ASC
           ) AS rn
      FROM public.income_expenses
     WHERE contract_id IS NOT NULL
       AND commission_kind IS NOT NULL
       AND deleted_at IS NULL
       AND approval_status <> 'CANCELLED'
  ) d
 WHERE ie.id = d.id AND d.rn > 1
   AND ie.commission_legacy_dup = false;

-- 4) HARD CONSTRAINT
CREATE UNIQUE INDEX IF NOT EXISTS uq_ie_commission_per_contract
  ON public.income_expenses (contract_id, commission_kind)
  WHERE contract_id IS NOT NULL
    AND commission_kind IS NOT NULL
    AND deleted_at IS NULL
    AND approval_status <> 'CANCELLED'
    AND NOT commission_legacy_dup;

-- 5) Suy diễn commission_kind từ items (definer: types bị RLS chặn theo user)
CREATE OR REPLACE FUNCTION public.ie_recompute_commission_kind(p_ie_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row  record;
  v_kind text;
BEGIN
  IF p_ie_id IS NULL THEN RETURN; END IF;

  SELECT id, type, contract_id, deleted_at, approval_status, commission_kind
    INTO v_row
    FROM income_expenses WHERE id = p_ie_id;
  IF NOT FOUND OR v_row.type <> 'EXPENSE' THEN RETURN; END IF;

  SELECT CASE WHEN bool_or(public.nrm_vn(tp.name) = 'thuong nong sale') THEN 'sale'
              WHEN bool_or(public.nrm_vn(tp.name) = 'hoa hong moi gioi') THEN 'broker' END
    INTO v_kind
    FROM income_expense_items it
    JOIN income_expense_types tp ON tp.id = it.income_expense_type_id
   WHERE it.income_expense_id = p_ie_id
     AND public.nrm_vn(tp.name) IN ('hoa hong moi gioi','thuong nong sale');

  IF v_kind IS DISTINCT FROM v_row.commission_kind THEN
    -- Phiếu SỐNG chuyển thành phiếu hoa hồng mà không gắn HĐ → chặn ngay
    IF v_kind IS NOT NULL AND v_row.contract_id IS NULL
       AND v_row.deleted_at IS NULL AND v_row.approval_status <> 'CANCELLED' THEN
      RAISE EXCEPTION 'Hạng mục "Hoa hồng môi giới"/"Thưởng nóng Sale" chỉ dùng cho phiếu gắn hợp đồng (chi qua flow ký HĐ hoặc Thu tiền → Chi HH). Chi hoa hồng cho đối tác ngoài vui lòng dùng hạng mục khác, vd "Hoa hồng đối tác".'
        USING ERRCODE = 'P0001';
    END IF;
    -- UPDATE này đi qua uq_ie_commission_per_contract → phiếu tay gắn HĐ
    -- đã có phiếu HH sẽ fail 23505 tại đây (chống trùng đường nhập tay).
    UPDATE income_expenses SET commission_kind = v_kind WHERE id = p_ie_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_ie_items_commission_kind()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.ie_recompute_commission_kind(COALESCE(NEW.income_expense_id, OLD.income_expense_id));
  IF TG_OP = 'UPDATE' AND OLD.income_expense_id IS DISTINCT FROM NEW.income_expense_id THEN
    PERFORM public.ie_recompute_commission_kind(OLD.income_expense_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trigger_ie_items_commission_kind ON public.income_expense_items;
CREATE TRIGGER trigger_ie_items_commission_kind
  AFTER INSERT OR DELETE OR UPDATE OF income_expense_type_id, income_expense_id
  ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_ie_items_commission_kind();

-- 6) Guard trên income_expenses: phiếu HH sống phải gắn HĐ; không gỡ HĐ khỏi
--    phiếu HH; phiếu cũ đã vi phạm sẵn (12 phiếu không HĐ) sửa cột khác vẫn được.
CREATE OR REPLACE FUNCTION public.trg_ie_commission_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_new_violates boolean;
  v_old_violates boolean;
BEGIN
  v_new_violates := NEW.commission_kind IS NOT NULL AND NEW.type = 'EXPENSE'
                    AND NEW.contract_id IS NULL AND NEW.deleted_at IS NULL
                    AND NEW.approval_status <> 'CANCELLED';
  IF NOT v_new_violates THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old_violates := OLD.commission_kind IS NOT NULL AND OLD.type = 'EXPENSE'
                      AND OLD.contract_id IS NULL AND OLD.deleted_at IS NULL
                      AND OLD.approval_status <> 'CANCELLED';
    IF v_old_violates THEN RETURN NEW; END IF; -- legacy giữ nguyên hiện trạng
    IF OLD.contract_id IS NOT NULL THEN
      RAISE EXCEPTION 'Không thể gỡ hợp đồng khỏi phiếu hoa hồng/thưởng Sale. Nếu phiếu tạo sai, hãy hủy phiếu rồi tạo lại.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RAISE EXCEPTION 'Hạng mục "Hoa hồng môi giới"/"Thưởng nóng Sale" chỉ dùng cho phiếu gắn hợp đồng (chi qua flow ký HĐ hoặc Thu tiền → Chi HH). Chi hoa hồng cho đối tác ngoài vui lòng dùng hạng mục khác, vd "Hoa hồng đối tác".'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trigger_ie_commission_guard ON public.income_expenses;
CREATE TRIGGER trigger_ie_commission_guard
  BEFORE INSERT OR UPDATE
  ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_ie_commission_guard();

COMMIT;

NOTIFY pgrst, 'reload schema';
