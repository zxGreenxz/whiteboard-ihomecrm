-- =============================================
-- Migration: Tạo domain Materials (kho vật tư tiêu hao gắn với phiếu công việc)
-- Created: 2026-05-29
-- Description:
--   - 5 bảng header + 3 bảng items: materials, material_categories,
--     material_purchases(+items), material_usages(+items), material_adjustments(+items)
--   - Trigger auto-cập-nhật on_hand và avg_unit_cost (MAC — moving average cost)
--   - Trigger auto-gen code (MP/MU/MA-YYYYMMDD-NNNN)
--   - RLS policies dùng can_access_org_entity('materials', ...)
--   - Audit user_id qua trigger set_user_id_from_auth (đã có)
--   - 1 kho chung cho cả chuỗi (không có building_id, không có warehouse_id)
-- =============================================

-- =============================================
-- 1. BẢNG CATALOG
-- =============================================

CREATE TABLE public.material_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) > 0),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.material_categories IS 'Danh mục vật tư tiêu hao (vd: Đèn, Vòi nước, Ống nước…).';
COMMENT ON COLUMN public.material_categories.user_id IS 'Audit-only: auth.uid() đã tạo row. RBAC dùng can_access_org_entity(materials,...).';

CREATE TABLE public.materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT,
  name TEXT NOT NULL CHECK (char_length(name) > 0),
  category_id UUID REFERENCES public.material_categories(id) ON DELETE SET NULL,
  unit TEXT NOT NULL DEFAULT 'cái',
  image_url TEXT,
  description TEXT,
  reorder_level NUMERIC(12,2) NOT NULL DEFAULT 0,
  on_hand NUMERIC(12,2) NOT NULL DEFAULT 0,
  avg_unit_cost NUMERIC(15,2) NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.materials IS 'Catalog vật tư tiêu hao. on_hand + avg_unit_cost là cache, được cập nhật qua trigger.';
COMMENT ON COLUMN public.materials.user_id IS 'Audit-only. RBAC dùng can_access_org_entity(materials,...).';
COMMENT ON COLUMN public.materials.on_hand IS 'Tồn kho hiện tại (cache). Tính = SUM(nhập) - SUM(xuất) + SUM(adj_in) - SUM(adj_out).';
COMMENT ON COLUMN public.materials.avg_unit_cost IS 'Giá vốn trung bình (MAC) = total_purchase_cost / total_purchase_qty.';
COMMENT ON COLUMN public.materials.reorder_level IS 'Ngưỡng cảnh báo: on_hand <= reorder_level thì UI hiện badge "Sắp hết".';

CREATE INDEX idx_materials_category_id ON public.materials(category_id);
CREATE INDEX idx_materials_deleted_at ON public.materials(deleted_at);
CREATE INDEX idx_materials_search ON public.materials USING GIN (
  to_tsvector('simple', coalesce(code,'') || ' ' || coalesce(name,'') || ' ' || coalesce(description,''))
);

-- =============================================
-- 2. BẢNG GIAO DỊCH — PHIẾU NHẬP
-- =============================================

CREATE TABLE public.material_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.material_purchases IS 'Phiếu nhập kho vật tư (header). total = cache sum line_total.';
COMMENT ON COLUMN public.material_purchases.code IS 'Auto-gen MP-YYYYMMDD-NNNN qua trigger set_material_purchase_code.';

CREATE INDEX idx_material_purchases_supplier ON public.material_purchases(supplier_id);
CREATE INDEX idx_material_purchases_date ON public.material_purchases(purchase_date DESC);

CREATE TABLE public.material_purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES public.material_purchases(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(15,2) NOT NULL CHECK (unit_price >= 0),
  line_total NUMERIC(15,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
);
COMMENT ON TABLE public.material_purchase_items IS 'Line items của phiếu nhập. Không có user_id (RLS qua parent).';

CREATE INDEX idx_material_purchase_items_purchase ON public.material_purchase_items(purchase_id);
CREATE INDEX idx_material_purchase_items_material ON public.material_purchase_items(material_id);

-- =============================================
-- 3. BẢNG GIAO DỊCH — PHIẾU XUẤT (GẮN JOB)
-- =============================================

CREATE TABLE public.material_usages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  job_id UUID REFERENCES public.jobs(id) ON DELETE CASCADE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.material_usages IS 'Phiếu xuất kho vật tư (header), gắn job_id (nullable).';
COMMENT ON COLUMN public.material_usages.job_id IS 'FK jobs.id (nullable cho xuất không gắn job). CASCADE xóa khi job bị xóa.';

CREATE UNIQUE INDEX uq_material_usages_job ON public.material_usages(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_material_usages_date ON public.material_usages(usage_date DESC);

CREATE TABLE public.material_usage_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_id UUID NOT NULL REFERENCES public.material_usages(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit_cost_at_usage NUMERIC(15,2) NOT NULL DEFAULT 0
);
COMMENT ON COLUMN public.material_usage_items.unit_cost_at_usage IS 'Snapshot materials.avg_unit_cost tại thời điểm xuất, để tính chi phí vật tư của job không phụ thuộc avg sau này.';

CREATE INDEX idx_material_usage_items_usage ON public.material_usage_items(usage_id);
CREATE INDEX idx_material_usage_items_material ON public.material_usage_items(material_id);

-- =============================================
-- 4. BẢNG GIAO DỊCH — KIỂM KÊ / ĐIỀU CHỈNH
-- =============================================

CREATE TABLE public.material_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.material_adjustments IS 'Phiếu điều chỉnh tồn (kiểm kê). type=IN/OUT delta. SET (kiểm đếm = X) thực hiện bằng cách insert 2 phiếu: 1 OUT bằng tồn hiện tại + 1 IN bằng số đếm.';

CREATE INDEX idx_material_adjustments_date ON public.material_adjustments(adjustment_date DESC);

CREATE TABLE public.material_adjustment_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id UUID NOT NULL REFERENCES public.material_adjustments(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity >= 0)
);
CREATE INDEX idx_material_adjustment_items_adjustment ON public.material_adjustment_items(adjustment_id);
CREATE INDEX idx_material_adjustment_items_material ON public.material_adjustment_items(material_id);

-- =============================================
-- 5. HÀM TÍNH LẠI TỒN + MAC + TRIGGER
-- =============================================

CREATE OR REPLACE FUNCTION public.recompute_material_stock(_material_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_in NUMERIC := 0;
  v_in_cost NUMERIC := 0;
  v_out NUMERIC := 0;
  v_adj_in NUMERIC := 0;
  v_adj_out NUMERIC := 0;
  v_avg NUMERIC := 0;
BEGIN
  SELECT COALESCE(SUM(quantity),0), COALESCE(SUM(line_total),0)
    INTO v_in, v_in_cost
    FROM material_purchase_items WHERE material_id = _material_id;

  SELECT COALESCE(SUM(quantity),0) INTO v_out
    FROM material_usage_items WHERE material_id = _material_id;

  SELECT COALESCE(SUM(ai.quantity),0) INTO v_adj_in
    FROM material_adjustment_items ai
    JOIN material_adjustments a ON a.id = ai.adjustment_id
    WHERE ai.material_id = _material_id AND a.type = 'IN';

  SELECT COALESCE(SUM(ai.quantity),0) INTO v_adj_out
    FROM material_adjustment_items ai
    JOIN material_adjustments a ON a.id = ai.adjustment_id
    WHERE ai.material_id = _material_id AND a.type = 'OUT';

  IF v_in > 0 THEN
    v_avg := v_in_cost / v_in;
  ELSE
    v_avg := 0;
  END IF;

  UPDATE materials
  SET on_hand = v_in - v_out + v_adj_in - v_adj_out,
      avg_unit_cost = v_avg,
      updated_at = now()
  WHERE id = _material_id;
END;
$$;

COMMENT ON FUNCTION public.recompute_material_stock(uuid) IS
  'Tính lại on_hand + avg_unit_cost (MAC) cho 1 material từ tất cả movement. Gọi bởi trigger AFTER trên *_items.';

CREATE OR REPLACE FUNCTION public.material_items_after_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM recompute_material_stock(COALESCE(NEW.material_id, OLD.material_id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_mpi_recompute AFTER INSERT OR UPDATE OR DELETE
  ON public.material_purchase_items
  FOR EACH ROW EXECUTE FUNCTION public.material_items_after_change();

CREATE TRIGGER trg_mui_recompute AFTER INSERT OR UPDATE OR DELETE
  ON public.material_usage_items
  FOR EACH ROW EXECUTE FUNCTION public.material_items_after_change();

CREATE TRIGGER trg_mai_recompute AFTER INSERT OR UPDATE OR DELETE
  ON public.material_adjustment_items
  FOR EACH ROW EXECUTE FUNCTION public.material_items_after_change();

-- =============================================
-- 6. CẬP NHẬT TOTAL CHO PHIẾU NHẬP
-- =============================================

CREATE OR REPLACE FUNCTION public.material_purchase_recompute_total()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_pid UUID;
BEGIN
  v_pid := COALESCE(NEW.purchase_id, OLD.purchase_id);
  UPDATE material_purchases
    SET total = COALESCE((SELECT SUM(line_total) FROM material_purchase_items WHERE purchase_id = v_pid), 0)
    WHERE id = v_pid;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_mpi_total AFTER INSERT OR UPDATE OR DELETE
  ON public.material_purchase_items
  FOR EACH ROW EXECUTE FUNCTION public.material_purchase_recompute_total();

-- =============================================
-- 7. AUTO-GEN CODE TRIGGERS (MP / MU / MA)
-- =============================================

CREATE OR REPLACE FUNCTION public.set_material_purchase_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := 'MP-' || to_char(now(),'YYYYMMDD') || '-' || LPAD(
      (SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'MP-\d{8}-(\d+)') AS INTEGER)), 0) + 1
       FROM public.material_purchases
       WHERE code LIKE 'MP-' || to_char(now(),'YYYYMMDD') || '-%')::TEXT,
      4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_material_usage_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := 'MU-' || to_char(now(),'YYYYMMDD') || '-' || LPAD(
      (SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'MU-\d{8}-(\d+)') AS INTEGER)), 0) + 1
       FROM public.material_usages
       WHERE code LIKE 'MU-' || to_char(now(),'YYYYMMDD') || '-%')::TEXT,
      4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_material_adjustment_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := 'MA-' || to_char(now(),'YYYYMMDD') || '-' || LPAD(
      (SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'MA-\d{8}-(\d+)') AS INTEGER)), 0) + 1
       FROM public.material_adjustments
       WHERE code LIKE 'MA-' || to_char(now(),'YYYYMMDD') || '-%')::TEXT,
      4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mp_code BEFORE INSERT ON public.material_purchases
  FOR EACH ROW EXECUTE FUNCTION public.set_material_purchase_code();
CREATE TRIGGER trg_mu_code BEFORE INSERT ON public.material_usages
  FOR EACH ROW EXECUTE FUNCTION public.set_material_usage_code();
CREATE TRIGGER trg_ma_code BEFORE INSERT ON public.material_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.set_material_adjustment_code();

-- =============================================
-- 8. AUDIT user_id + updated_at TRIGGERS
-- =============================================

CREATE TRIGGER material_categories_set_user_id_audit BEFORE INSERT
  ON public.material_categories FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER materials_set_user_id_audit BEFORE INSERT
  ON public.materials FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER material_purchases_set_user_id_audit BEFORE INSERT
  ON public.material_purchases FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER material_usages_set_user_id_audit BEFORE INSERT
  ON public.material_usages FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
CREATE TRIGGER material_adjustments_set_user_id_audit BEFORE INSERT
  ON public.material_adjustments FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

CREATE TRIGGER set_material_categories_updated_at BEFORE UPDATE
  ON public.material_categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_materials_updated_at BEFORE UPDATE
  ON public.materials FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_material_purchases_updated_at BEFORE UPDATE
  ON public.material_purchases FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_material_usages_updated_at BEFORE UPDATE
  ON public.material_usages FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- 9. RLS — DÙNG can_access_org_entity('materials',...)
-- =============================================

ALTER TABLE public.material_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_usage_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_adjustment_items ENABLE ROW LEVEL SECURITY;

-- ─── material_categories ────────────────────────────────────────────────
CREATE POLICY material_categories_select_rbac ON public.material_categories FOR SELECT
  USING (public.can_access_org_entity('materials','view'));
CREATE POLICY material_categories_insert_rbac ON public.material_categories FOR INSERT
  WITH CHECK (public.can_access_org_entity('materials','create'));
CREATE POLICY material_categories_update_rbac ON public.material_categories FOR UPDATE
  USING (public.can_access_org_entity('materials','edit'))
  WITH CHECK (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_categories_delete_rbac ON public.material_categories FOR DELETE
  USING (public.can_access_org_entity('materials','delete'));
CREATE POLICY material_categories_admin_all ON public.material_categories FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY material_categories_super_admin_all ON public.material_categories FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ─── materials ──────────────────────────────────────────────────────────
CREATE POLICY materials_select_rbac ON public.materials FOR SELECT
  USING (public.can_access_org_entity('materials','view'));
CREATE POLICY materials_insert_rbac ON public.materials FOR INSERT
  WITH CHECK (public.can_access_org_entity('materials','create'));
CREATE POLICY materials_update_rbac ON public.materials FOR UPDATE
  USING (public.can_access_org_entity('materials','edit'))
  WITH CHECK (public.can_access_org_entity('materials','edit'));
CREATE POLICY materials_delete_rbac ON public.materials FOR DELETE
  USING (public.can_access_org_entity('materials','delete'));
CREATE POLICY materials_admin_all ON public.materials FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY materials_super_admin_all ON public.materials FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ─── material_purchases ─────────────────────────────────────────────────
CREATE POLICY material_purchases_select_rbac ON public.material_purchases FOR SELECT
  USING (public.can_access_org_entity('materials','view'));
CREATE POLICY material_purchases_insert_rbac ON public.material_purchases FOR INSERT
  WITH CHECK (public.can_access_org_entity('materials','create'));
CREATE POLICY material_purchases_update_rbac ON public.material_purchases FOR UPDATE
  USING (public.can_access_org_entity('materials','edit'))
  WITH CHECK (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_purchases_delete_rbac ON public.material_purchases FOR DELETE
  USING (public.can_access_org_entity('materials','delete'));
CREATE POLICY material_purchases_admin_all ON public.material_purchases FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY material_purchases_super_admin_all ON public.material_purchases FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ─── material_purchase_items (RLS qua parent purchase) ───────────────────
CREATE POLICY material_purchase_items_select_rbac ON public.material_purchase_items FOR SELECT
  USING (public.can_access_org_entity('materials','view'));
CREATE POLICY material_purchase_items_insert_rbac ON public.material_purchase_items FOR INSERT
  WITH CHECK (public.can_access_org_entity('materials','create'));
CREATE POLICY material_purchase_items_update_rbac ON public.material_purchase_items FOR UPDATE
  USING (public.can_access_org_entity('materials','edit'))
  WITH CHECK (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_purchase_items_delete_rbac ON public.material_purchase_items FOR DELETE
  USING (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_purchase_items_admin_all ON public.material_purchase_items FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY material_purchase_items_super_admin_all ON public.material_purchase_items FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ─── material_usages ────────────────────────────────────────────────────
CREATE POLICY material_usages_select_rbac ON public.material_usages FOR SELECT
  USING (public.can_access_org_entity('materials','view'));
CREATE POLICY material_usages_insert_rbac ON public.material_usages FOR INSERT
  WITH CHECK (public.can_access_org_entity('materials','create'));
CREATE POLICY material_usages_update_rbac ON public.material_usages FOR UPDATE
  USING (public.can_access_org_entity('materials','edit'))
  WITH CHECK (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_usages_delete_rbac ON public.material_usages FOR DELETE
  USING (public.can_access_org_entity('materials','delete'));
CREATE POLICY material_usages_admin_all ON public.material_usages FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY material_usages_super_admin_all ON public.material_usages FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ─── material_usage_items ───────────────────────────────────────────────
CREATE POLICY material_usage_items_select_rbac ON public.material_usage_items FOR SELECT
  USING (public.can_access_org_entity('materials','view'));
CREATE POLICY material_usage_items_insert_rbac ON public.material_usage_items FOR INSERT
  WITH CHECK (public.can_access_org_entity('materials','create'));
CREATE POLICY material_usage_items_update_rbac ON public.material_usage_items FOR UPDATE
  USING (public.can_access_org_entity('materials','edit'))
  WITH CHECK (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_usage_items_delete_rbac ON public.material_usage_items FOR DELETE
  USING (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_usage_items_admin_all ON public.material_usage_items FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY material_usage_items_super_admin_all ON public.material_usage_items FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ─── material_adjustments ──────────────────────────────────────────────
CREATE POLICY material_adjustments_select_rbac ON public.material_adjustments FOR SELECT
  USING (public.can_access_org_entity('materials','view'));
CREATE POLICY material_adjustments_insert_rbac ON public.material_adjustments FOR INSERT
  WITH CHECK (public.can_access_org_entity('materials','create'));
CREATE POLICY material_adjustments_update_rbac ON public.material_adjustments FOR UPDATE
  USING (public.can_access_org_entity('materials','edit'))
  WITH CHECK (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_adjustments_delete_rbac ON public.material_adjustments FOR DELETE
  USING (public.can_access_org_entity('materials','delete'));
CREATE POLICY material_adjustments_admin_all ON public.material_adjustments FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY material_adjustments_super_admin_all ON public.material_adjustments FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ─── material_adjustment_items ─────────────────────────────────────────
CREATE POLICY material_adjustment_items_select_rbac ON public.material_adjustment_items FOR SELECT
  USING (public.can_access_org_entity('materials','view'));
CREATE POLICY material_adjustment_items_insert_rbac ON public.material_adjustment_items FOR INSERT
  WITH CHECK (public.can_access_org_entity('materials','create'));
CREATE POLICY material_adjustment_items_update_rbac ON public.material_adjustment_items FOR UPDATE
  USING (public.can_access_org_entity('materials','edit'))
  WITH CHECK (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_adjustment_items_delete_rbac ON public.material_adjustment_items FOR DELETE
  USING (public.can_access_org_entity('materials','edit'));
CREATE POLICY material_adjustment_items_admin_all ON public.material_adjustment_items FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY material_adjustment_items_super_admin_all ON public.material_adjustment_items FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- =============================================
-- Migration completed
-- 8 bảng + 7 trigger functions + 14 triggers + 48 RLS policies
-- =============================================
