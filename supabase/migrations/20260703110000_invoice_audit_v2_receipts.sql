-- =============================================
-- Migration: invoice audit log v2 — phủ phiếu thu + nợ khách (credit)
-- Bối cảnh: lịch sử hoá đơn (invoice_audit_log) mới có trigger trên
-- invoices / invoice_items / payments. Luồng tiền thật đi qua phiếu thu
-- income_expenses (invoice_id) và excess_amounts (source_invoice_id) thì
-- KHÔNG để lại vết: lập/duyệt/huỷ/sửa phiếu, đổi sổ quỹ, phiếu hoàn tiền
-- thanh lý, xoá credit trong super_admin_force_cancel_invoice.
-- Thay đổi:
-- 1. entity thêm 'receipt' (phiếu thu/chi gắn hoá đơn) + 'excess' (nợ khách).
-- 2. Bỏ FK ON DELETE CASCADE: bảng audit phải sống lâu hơn đối tượng nó ghi;
--    CASCADE xoá sạch lịch sử nếu hoá đơn bị hard-delete, đồng thời làm
--    branch DELETE của trigger invoices tự phá (INSERT tham chiếu id vừa xoá).
--    Giữ index invoice_id sẵn có; RLS SELECT vẫn join invoices nên dòng mồ côi
--    không lộ ra ngoài.
-- 3. Trigger AFTER I/U/D trên income_expenses (chỉ khi dính invoice_id) và
--    excess_amounts (chỉ khi dính source_invoice_id).
-- =============================================

-- 1. Mở rộng entity
ALTER TABLE public.invoice_audit_log
  DROP CONSTRAINT IF EXISTS invoice_audit_log_entity_check;
ALTER TABLE public.invoice_audit_log
  ADD CONSTRAINT invoice_audit_log_entity_check
  CHECK (entity IN ('invoice', 'item', 'payment', 'receipt', 'excess'));

-- 2. Audit phải sống lâu hơn hoá đơn
ALTER TABLE public.invoice_audit_log
  DROP CONSTRAINT IF EXISTS invoice_audit_log_invoice_id_fkey;

-- 3a. Trigger phiếu thu/chi gắn hoá đơn → entity 'receipt'
CREATE OR REPLACE FUNCTION public._invoice_audit_income_expenses()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  -- updated_at: đổi mỗi lần ghi; has_restricted_item/kqkd_amount: cột dẫn xuất
  -- do trigger khác tính lại khi items đổi — ghi riêng chỉ tạo nhiễu.
  v_ignore CONSTANT text[] := ARRAY[
    'updated_at',
    'has_restricted_item',
    'kqkd_amount'
  ];
BEGIN
  IF v_actor IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.invoice_id IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, after
    ) VALUES (
      NEW.invoice_id, 'receipt', NEW.id, 'INSERT',
      v_actor, COALESCE(v_actor_name, NEW.creator_name), to_jsonb(NEW)
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.invoice_id IS NULL AND OLD.invoice_id IS NULL THEN
      RETURN NEW;
    END IF;
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
    v_changed := public._diff_changed_fields(v_before, v_after, v_ignore);
    IF array_length(v_changed, 1) IS NULL THEN
      RETURN NEW;
    END IF;
    -- Phiếu đổi hoá đơn liên kết: ghi vào cả HĐ cũ lẫn HĐ mới.
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name,
      before, after, changed_fields
    )
    SELECT DISTINCT t.invoice_id, 'receipt', NEW.id, 'UPDATE',
      v_actor, COALESCE(v_actor_name, NEW.creator_name),
      v_before, v_after, v_changed
    FROM (VALUES (NEW.invoice_id), (OLD.invoice_id)) AS t(invoice_id)
    WHERE t.invoice_id IS NOT NULL;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.invoice_id IS NULL THEN
      RETURN OLD;
    END IF;
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, before
    ) VALUES (
      OLD.invoice_id, 'receipt', OLD.id, 'DELETE',
      v_actor, COALESCE(v_actor_name, OLD.creator_name), to_jsonb(OLD)
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS income_expenses_invoice_audit_trigger ON public.income_expenses;
CREATE TRIGGER income_expenses_invoice_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public._invoice_audit_income_expenses();

-- 3b. Trigger nợ khách (credit) → entity 'excess'
CREATE OR REPLACE FUNCTION public._invoice_audit_excess_amounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_changed text[];
BEGIN
  IF v_actor IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.source_invoice_id IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, after
    ) VALUES (
      NEW.source_invoice_id, 'excess', NEW.id, 'INSERT',
      v_actor, v_actor_name, to_jsonb(NEW)
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.source_invoice_id IS NULL AND OLD.source_invoice_id IS NULL THEN
      RETURN NEW;
    END IF;
    v_changed := public._diff_changed_fields(to_jsonb(OLD), to_jsonb(NEW));
    IF array_length(v_changed, 1) IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name,
      before, after, changed_fields
    )
    SELECT DISTINCT t.invoice_id, 'excess', NEW.id, 'UPDATE',
      v_actor, v_actor_name, to_jsonb(OLD), to_jsonb(NEW), v_changed
    FROM (VALUES (NEW.source_invoice_id), (OLD.source_invoice_id)) AS t(invoice_id)
    WHERE t.invoice_id IS NOT NULL;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.source_invoice_id IS NULL THEN
      RETURN OLD;
    END IF;
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, before
    ) VALUES (
      OLD.source_invoice_id, 'excess', OLD.id, 'DELETE',
      v_actor, v_actor_name, to_jsonb(OLD)
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS excess_amounts_invoice_audit_trigger ON public.excess_amounts;
CREATE TRIGGER excess_amounts_invoice_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.excess_amounts
  FOR EACH ROW EXECUTE FUNCTION public._invoice_audit_excess_amounts();
