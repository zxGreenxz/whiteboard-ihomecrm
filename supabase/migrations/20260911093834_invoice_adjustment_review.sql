BEGIN;

CREATE TABLE IF NOT EXISTS public.invoice_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  revision bigint NOT NULL,
  idempotency_key text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  before_total numeric(15,2) NOT NULL,
  after_total numeric(15,2) NOT NULL,
  delta numeric(15,2) NOT NULL,
  adjusted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  adjusted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  review_status text NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','CHECKED')),
  checked_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  checked_at timestamptz,
  UNIQUE (invoice_id, revision),
  UNIQUE (invoice_id, idempotency_key),
  CHECK (delta = after_total - before_total),
  CHECK ((review_status = 'PENDING' AND checked_by IS NULL AND checked_at IS NULL)
      OR (review_status = 'CHECKED' AND checked_by IS NOT NULL AND checked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS invoice_adjustments_invoice_idx
  ON public.invoice_adjustments(invoice_id, revision DESC);

ALTER TABLE public.excess_amounts
  ADD COLUMN IF NOT EXISTS source_adjustment_id uuid REFERENCES public.invoice_adjustments(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS excess_amounts_source_adjustment_uq
  ON public.excess_amounts(source_adjustment_id) WHERE source_adjustment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_paid_invoice_direct_adjustment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated','anon') AND TG_TABLE_NAME='invoices' AND TG_OP='UPDATE'
     AND COALESCE(OLD.paid_amount,0) > 0
     AND (NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
       OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount OR NEW.previous_debt IS DISTINCT FROM OLD.previous_debt) THEN
    RAISE EXCEPTION 'Hoá đơn đã thu tiền chỉ được điều chỉnh qua RPC' USING ERRCODE='42501';
  END IF;
  IF current_user IN ('authenticated','anon') AND TG_TABLE_NAME='invoice_items'
     AND EXISTS (SELECT 1 FROM public.invoices i WHERE i.id=coalesce(NEW.invoice_id,OLD.invoice_id) AND COALESCE(i.paid_amount,0)>0) THEN
    RAISE EXCEPTION 'Dòng hoá đơn đã thu tiền là bất biến' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS guard_paid_invoice_direct_adjustment ON public.invoices;
CREATE TRIGGER guard_paid_invoice_direct_adjustment BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_paid_invoice_direct_adjustment();
DROP TRIGGER IF EXISTS guard_paid_invoice_item_direct_adjustment ON public.invoice_items;
CREATE TRIGGER guard_paid_invoice_item_direct_adjustment BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_paid_invoice_direct_adjustment();

ALTER TABLE public.invoice_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoice_adjustments_select_scope ON public.invoice_adjustments;
CREATE POLICY invoice_adjustments_select_scope ON public.invoice_adjustments
  FOR SELECT TO authenticated
  USING (public.can_do_on_building('invoices','view', public.building_of_invoice(invoice_id)));

CREATE OR REPLACE FUNCTION public.guard_invoice_adjustment_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR (NEW.review_status = OLD.review_status AND NEW.checked_by IS NOT DISTINCT FROM OLD.checked_by AND NEW.checked_at IS NOT DISTINCT FROM OLD.checked_at) THEN
    RAISE EXCEPTION 'Lịch sử điều chỉnh là bất biến' USING ERRCODE='42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.before_snapshot IS DISTINCT FROM OLD.before_snapshot
     OR NEW.after_snapshot IS DISTINCT FROM OLD.after_snapshot OR NEW.before_total IS DISTINCT FROM OLD.before_total
     OR NEW.after_total IS DISTINCT FROM OLD.after_total OR NEW.delta IS DISTINCT FROM OLD.delta
     OR NEW.adjusted_by IS DISTINCT FROM OLD.adjusted_by OR NEW.adjusted_at IS DISTINCT FROM OLD.adjusted_at
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'Không được sửa snapshot điều chỉnh' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS invoice_adjustments_immutable ON public.invoice_adjustments;
CREATE TRIGGER invoice_adjustments_immutable BEFORE UPDATE ON public.invoice_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_adjustment_immutable();

REVOKE ALL ON public.invoice_adjustments FROM anon, authenticated;
GRANT SELECT ON public.invoice_adjustments TO authenticated;

CREATE OR REPLACE FUNCTION public.adjust_invoice_v1(
  p_invoice_id uuid, p_after_items jsonb, p_reason text, p_idempotency_key text
) RETURNS public.invoice_adjustments
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','app_private'
AS $$
DECLARE
  v_actor uuid := auth.uid(); v_inv public.invoices%ROWTYPE; v_org uuid;
  v_before jsonb; v_after jsonb; v_subtotal numeric(15,2); v_total numeric(15,2);
  v_prev numeric(15,2); v_discount numeric(15,2); v_rev bigint; v_row public.invoice_adjustments%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR p_invoice_id IS NULL OR jsonb_typeof(p_after_items) IS DISTINCT FROM 'array'
     OR length(btrim(coalesce(p_reason,''))) < 3 OR length(btrim(coalesce(p_idempotency_key,''))) < 8 THEN
    RAISE EXCEPTION 'Dữ liệu điều chỉnh không hợp lệ' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_inv FROM public.invoices WHERE id=p_invoice_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_inv.status IN ('CANCELLED'::invoice_status) THEN
    RAISE EXCEPTION 'Hoá đơn không ở trạng thái điều chỉnh được' USING ERRCODE='55000';
  END IF;
  IF NOT public.can_do_on_building('invoices','edit',v_inv.building_id) THEN
    RAISE EXCEPTION 'Không có quyền điều chỉnh hoá đơn' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_row FROM public.invoice_adjustments WHERE invoice_id=p_invoice_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN v_row; END IF;
  IF EXISTS (SELECT 1 FROM public.invoice_adjustments a WHERE a.invoice_id=p_invoice_id) THEN
    RAISE EXCEPTION 'Hoá đơn chỉ được điều chỉnh một lần; lập biên bản điều chỉnh mới theo quy trình quản trị' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customer_credit_applications ca WHERE ca.invoice_id=p_invoice_id AND ca.reversed_at IS NULL) THEN
    RAISE EXCEPTION 'Hoá đơn đã cấn trừ credit, không thể điều chỉnh' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments p WHERE p.invoice_id=p_invoice_id AND p.reversed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Hoá đơn đã hoàn tiền, không thể điều chỉnh' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices later WHERE later.contract_id=v_inv.contract_id AND later.billing_month>v_inv.billing_month
      AND later.previous_debt_sources @> jsonb_build_array(jsonb_build_object('type','invoice','id',p_invoice_id::text))) THEN
    RAISE EXCEPTION 'Khoản nợ đã được chuyển sang hoá đơn sau; xử lý điều chỉnh ở hoá đơn đang mở' USING ERRCODE='55000';
  END IF;
  v_before := jsonb_build_object('total_amount',v_inv.total_amount,'subtotal',v_inv.subtotal,
    'discount_amount',v_inv.discount_amount,'previous_debt',v_inv.previous_debt,
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.sort_order,i.id),'[]'::jsonb) FROM public.invoice_items i WHERE i.invoice_id=p_invoice_id));
  SELECT coalesce(sum(coalesce((x->>'amount')::numeric,(x->>'unit_price')::numeric*coalesce((x->>'quantity')::numeric,1))),0)
    INTO v_subtotal FROM jsonb_array_elements(p_after_items) x
   WHERE jsonb_typeof(x)='object' AND coalesce((x->>'amount')::numeric,(x->>'unit_price')::numeric*coalesce((x->>'quantity')::numeric,1)) >= 0;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_after_items) x WHERE jsonb_typeof(x)<>'object'
      OR coalesce((x->>'amount')::numeric,(x->>'unit_price')::numeric*coalesce((x->>'quantity')::numeric,1)) < 0) THEN
    RAISE EXCEPTION 'Hạng mục điều chỉnh không hợp lệ' USING ERRCODE='22023';
  END IF;
  v_discount := coalesce(v_inv.discount_amount,0); v_prev := coalesce(v_inv.previous_debt,0);
  v_total := app_private.round_invoice_total_v1(v_subtotal-v_discount+v_prev);
  IF v_total = v_inv.total_amount THEN RAISE EXCEPTION 'Điều chỉnh không làm thay đổi tổng tiền' USING ERRCODE='22023'; END IF;
  v_after := jsonb_build_object('total_amount',v_total,'subtotal',v_subtotal,'discount_amount',v_discount,
    'previous_debt',v_prev,'items',p_after_items);
  SELECT coalesce(max(revision),0)+1 INTO v_rev FROM public.invoice_adjustments WHERE invoice_id=p_invoice_id;
  INSERT INTO public.invoice_adjustments(organization_id,invoice_id,revision,idempotency_key,reason,before_snapshot,after_snapshot,before_total,after_total,delta,adjusted_by)
  VALUES(v_inv.organization_id,p_invoice_id,v_rev,btrim(p_idempotency_key),btrim(p_reason),v_before,v_after,v_inv.total_amount,v_total,v_total-v_inv.total_amount,v_actor)
  RETURNING * INTO v_row;
  UPDATE public.invoices SET subtotal=v_subtotal,total_amount=v_total,
    notes=concat_ws(E'\n',notes,'[Điều chỉnh #',v_rev,'] ',btrim(p_reason)) WHERE id=p_invoice_id;
  PERFORM public.recompute_invoice_for_id(p_invoice_id);
  IF v_total < coalesce(v_inv.paid_amount,0) THEN
    INSERT INTO public.excess_amounts(user_id,contract_id,amount,description,source_invoice_id,source_adjustment_id)
    VALUES(v_inv.user_id,v_inv.contract_id,v_inv.paid_amount-v_total,'Tiền dư do điều chỉnh hoá đơn',p_invoice_id,v_row.id)
    ON CONFLICT (source_adjustment_id) WHERE source_adjustment_id IS NOT NULL DO NOTHING;
  END IF;
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.review_invoice_adjustment_v1(p_adjustment_id uuid)
RETURNS public.invoice_adjustments
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','app_private'
AS $$
DECLARE v_actor uuid := auth.uid(); v_row public.invoice_adjustments%ROWTYPE; v_building uuid;
BEGIN
  SELECT a.* INTO v_row FROM public.invoice_adjustments a WHERE a.id=p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy điều chỉnh' USING ERRCODE='42501'; END IF;
  SELECT building_id INTO v_building FROM public.invoices WHERE id=v_row.invoice_id AND deleted_at IS NULL;
  IF v_actor IS NULL OR NOT public.can_do_on_building('invoices','approve',v_building) THEN
    RAISE EXCEPTION 'Không có quyền xác nhận kiểm tra' USING ERRCODE='42501';
  END IF;
  IF v_row.review_status='CHECKED' THEN RETURN v_row; END IF;
  UPDATE public.invoice_adjustments SET review_status='CHECKED',checked_by=v_actor,checked_at=clock_timestamp() WHERE id=p_adjustment_id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.adjust_invoice_v1(uuid,jsonb,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_invoice_v1(uuid,jsonb,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.review_invoice_adjustment_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_invoice_adjustment_v1(uuid) TO authenticated;

COMMIT;
