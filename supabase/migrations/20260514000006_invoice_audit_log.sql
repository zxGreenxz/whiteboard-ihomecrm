-- =============================================
-- Migration: invoice audit log (field-level diff)
-- - Bảng `invoice_audit_log` chứa lịch sử mọi thao tác trên invoice + items + payments.
-- - 3 trigger AFTER INSERT/UPDATE/DELETE trên invoices, invoice_items, payments.
-- - Trigger lấy actor từ auth.uid() và snapshot tên từ profiles.full_name.
-- - Bỏ qua các field auto-derived (updated_at, paid_amount, remaining_amount) khỏi
--   changed_fields trên bảng invoices để giảm nhiễu.
-- =============================================

CREATE TABLE IF NOT EXISTS public.invoice_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('invoice', 'item', 'payment')),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  actor_id uuid,
  actor_name text,
  before jsonb,
  after jsonb,
  changed_fields text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_audit_log_invoice_id_created_at_idx
  ON public.invoice_audit_log (invoice_id, created_at DESC);

ALTER TABLE public.invoice_audit_log ENABLE ROW LEVEL SECURITY;

-- RLS: cho phép user đọc audit log của các invoice mà họ có quyền đọc (theo user_id).
DROP POLICY IF EXISTS "invoice_audit_log_select_own"
  ON public.invoice_audit_log;
CREATE POLICY "invoice_audit_log_select_own"
  ON public.invoice_audit_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.id = invoice_audit_log.invoice_id
        AND i.user_id = auth.uid()
    )
  );

-- Hàm helper: tính danh sách field đã đổi giữa 2 jsonb.
CREATE OR REPLACE FUNCTION public._diff_changed_fields(
  p_before jsonb,
  p_after jsonb,
  p_ignore text[] DEFAULT ARRAY[]::text[]
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[])
  FROM (
    SELECT key
    FROM jsonb_each(p_after)
    WHERE NOT (key = ANY (p_ignore))
      AND COALESCE(p_before -> key, 'null'::jsonb) IS DISTINCT FROM (p_after -> key)
    UNION
    SELECT key
    FROM jsonb_each(p_before)
    WHERE NOT (key = ANY (p_ignore))
      AND COALESCE(p_after -> key, 'null'::jsonb) IS DISTINCT FROM (p_before -> key)
  ) AS keys;
$$;

-- Trigger function for invoices.
CREATE OR REPLACE FUNCTION public._invoice_audit_invoices()
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
  v_ignore CONSTANT text[] := ARRAY[
    'updated_at',
    'paid_amount',
    'remaining_amount'
  ];
BEGIN
  IF v_actor IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_after := to_jsonb(NEW);
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, after
    ) VALUES (
      NEW.id, 'invoice', NEW.id, 'INSERT', v_actor, v_actor_name, v_after
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
    v_changed := public._diff_changed_fields(v_before, v_after, v_ignore);
    -- Bỏ qua nếu chỉ các field bị ignore thay đổi (tránh ghi noise từ trigger recompute).
    IF array_length(v_changed, 1) IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name,
      before, after, changed_fields
    ) VALUES (
      NEW.id, 'invoice', NEW.id, 'UPDATE', v_actor, v_actor_name,
      v_before, v_after, v_changed
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD);
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, before
    ) VALUES (
      OLD.id, 'invoice', OLD.id, 'DELETE', v_actor, v_actor_name, v_before
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS invoices_audit_trigger ON public.invoices;
CREATE TRIGGER invoices_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._invoice_audit_invoices();

-- Trigger function for invoice_items.
CREATE OR REPLACE FUNCTION public._invoice_audit_invoice_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_invoice_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
BEGIN
  IF v_actor IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_invoice_id := NEW.invoice_id;
    v_after := to_jsonb(NEW);
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, after
    ) VALUES (
      v_invoice_id, 'item', NEW.id, 'INSERT', v_actor, v_actor_name, v_after
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    v_invoice_id := NEW.invoice_id;
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
    v_changed := public._diff_changed_fields(v_before, v_after);
    IF array_length(v_changed, 1) IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name,
      before, after, changed_fields
    ) VALUES (
      v_invoice_id, 'item', NEW.id, 'UPDATE', v_actor, v_actor_name,
      v_before, v_after, v_changed
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_invoice_id := OLD.invoice_id;
    v_before := to_jsonb(OLD);
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, before
    ) VALUES (
      v_invoice_id, 'item', OLD.id, 'DELETE', v_actor, v_actor_name, v_before
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS invoice_items_audit_trigger ON public.invoice_items;
CREATE TRIGGER invoice_items_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._invoice_audit_invoice_items();

-- Trigger function for payments.
CREATE OR REPLACE FUNCTION public._invoice_audit_payments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_invoice_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_ignore CONSTANT text[] := ARRAY['updated_at'];
BEGIN
  IF v_actor IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_invoice_id := NEW.invoice_id;
    v_after := to_jsonb(NEW);
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, after
    ) VALUES (
      v_invoice_id, 'payment', NEW.id, 'INSERT', v_actor, v_actor_name, v_after
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    v_invoice_id := NEW.invoice_id;
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
    v_changed := public._diff_changed_fields(v_before, v_after, v_ignore);
    IF array_length(v_changed, 1) IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name,
      before, after, changed_fields
    ) VALUES (
      v_invoice_id, 'payment', NEW.id, 'UPDATE', v_actor, v_actor_name,
      v_before, v_after, v_changed
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_invoice_id := OLD.invoice_id;
    v_before := to_jsonb(OLD);
    INSERT INTO public.invoice_audit_log (
      invoice_id, entity, entity_id, action, actor_id, actor_name, before
    ) VALUES (
      v_invoice_id, 'payment', OLD.id, 'DELETE', v_actor, v_actor_name, v_before
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS payments_audit_trigger ON public.payments;
CREATE TRIGGER payments_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public._invoice_audit_payments();
