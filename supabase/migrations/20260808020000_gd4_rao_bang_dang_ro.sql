-- =============================================================================
-- GĐ4 — Rào 14 bảng ĐANG RÒ THẬT sang tổ chức khác
--
-- SINH BẰNG MÁY: node scripts/sinh-migration-org-boundary.mjs
-- Nguồn: docs/generated/org-boundary-inventory.json (chụp 2026-08-07T17:50:20.249Z)
-- Phân bố: LIVE_LEAK=14
--
-- ⚠ FILE NÀY LÀM NGƯỜI DÙNG MẤT DỮ LIỆU KHỎI TẦM NHÌN — VÀ ĐÓ LÀ MỤC ĐÍCH.
-- Khác hẳn giai đoạn trước (nơi số đo chứng minh không ai mất gì), mỗi bảng dưới
-- đây ĐANG phát dữ liệu của tổ chức khác cho người dùng, đo trên production bằng
-- vai thật. Số trong ngoặc là số dòng của tổ chức KHÁC mà một người dùng thường
-- đang đọc được:
--
--   asset_movements — 1 dòng
--   document_templates — 16 dòng
--   job_groups — 4 dòng
--   job_types — 22 dòng
--   material_adjustment_items — 2 dòng
--   material_adjustments — 2 dòng
--   material_categories — 12 dòng
--   material_purchase_items — 58 dòng
--   material_purchases — 58 dòng
--   material_usage_items — 92 dòng
--   material_usages — 80 dòng
--   materials — 60 dòng
--   public_room_events — 8137 dòng
--   sla_configs — 8 dòng
--
-- Sau khi chạy, đúng những dòng đó biến mất khỏi tầm nhìn của họ. Dòng của chính
-- tổ chức họ phải còn NGUYÊN — đó là mệnh đề bắt buộc phải đo trước/sau, không
-- được suy luận: bằng chứng "không hồi quy" ở đây là visible_own không đổi VÀ
-- visible_foreign về 0, đo trong cùng một transaction rồi rollback.
--
-- Nếu một màn hình nào đó đang DỰA vào chỗ hở này để hoạt động, nó sẽ hỏng sau
-- khi chạy. Đó không phải lý do để hoãn — đó là lý do phải sửa màn hình ấy.
--
-- Công thức nguyên văn Sprint 3b (20260713121000), RESTRICTIVE = chỉ siết:
--   organization_id IS NULL OR is_super_admin() OR organization_id IN my_org_ids()
-- Nhánh IS NULL giữ đúng parity với 32 bảng đã có; nó sẽ được đóng ở GĐ6 sau khi
-- backfill, không đóng ở đây kẻo lệch công thức giữa các bảng.
--
-- Idempotent: DROP POLICY IF EXISTS trước CREATE.
-- =============================================================================

BEGIN;

DO $preflight$
DECLARE v_thieu text;
BEGIN
  -- Mọi bảng trong file phải còn tồn tại và còn cột organization_id. Lệch là
  -- inventory đã cũ so với production — dừng chứ không đoán.
  SELECT string_agg(t, ', ') INTO v_thieu FROM unnest(ARRAY[
    'asset_movements',
    'document_templates',
    'job_groups',
    'job_types',
    'material_adjustment_items',
    'material_adjustments',
    'material_categories',
    'material_purchase_items',
    'material_purchases',
    'material_usage_items',
    'material_usages',
    'materials',
    'public_room_events',
    'sla_configs'
  ]) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id'
                         AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = t
  );
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Không thấy (hoặc mất cột organization_id): %. Inventory đã cũ so với production. DỪNG.', v_thieu;
  END IF;

  -- Không bảng nào trong file được nằm trong sổ miễn trừ.
  SELECT string_agg(e.table_name, ', ') INTO v_thieu
    FROM app_private.org_boundary_exemptions e
   WHERE e.table_name = ANY(ARRAY[
    'asset_movements',
    'document_templates',
    'job_groups',
    'job_types',
    'material_adjustment_items',
    'material_adjustments',
    'material_categories',
    'material_purchase_items',
    'material_purchases',
    'material_usage_items',
    'material_usages',
    'materials',
    'public_room_events',
    'sla_configs'
  ]);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Bảng vừa nằm trong sổ miễn trừ vừa bị rào ở đây: %. DỪNG.', v_thieu;
  END IF;
END
$preflight$;

-- ─── LIVE_LEAK: LIVE_LEAK (14 bảng) ───
DROP POLICY IF EXISTS asset_movements_org_boundary ON public.asset_movements;
CREATE POLICY asset_movements_org_boundary ON public.asset_movements
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS document_templates_org_boundary ON public.document_templates;
CREATE POLICY document_templates_org_boundary ON public.document_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS job_groups_org_boundary ON public.job_groups;
CREATE POLICY job_groups_org_boundary ON public.job_groups
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS job_types_org_boundary ON public.job_types;
CREATE POLICY job_types_org_boundary ON public.job_types
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS material_adjustment_items_org_boundary ON public.material_adjustment_items;
CREATE POLICY material_adjustment_items_org_boundary ON public.material_adjustment_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS material_adjustments_org_boundary ON public.material_adjustments;
CREATE POLICY material_adjustments_org_boundary ON public.material_adjustments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS material_categories_org_boundary ON public.material_categories;
CREATE POLICY material_categories_org_boundary ON public.material_categories
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS material_purchase_items_org_boundary ON public.material_purchase_items;
CREATE POLICY material_purchase_items_org_boundary ON public.material_purchase_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS material_purchases_org_boundary ON public.material_purchases;
CREATE POLICY material_purchases_org_boundary ON public.material_purchases
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS material_usage_items_org_boundary ON public.material_usage_items;
CREATE POLICY material_usage_items_org_boundary ON public.material_usage_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS material_usages_org_boundary ON public.material_usages;
CREATE POLICY material_usages_org_boundary ON public.material_usages
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS materials_org_boundary ON public.materials;
CREATE POLICY materials_org_boundary ON public.materials
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS public_room_events_org_boundary ON public.public_room_events;
CREATE POLICY public_room_events_org_boundary ON public.public_room_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
DROP POLICY IF EXISTS sla_configs_org_boundary ON public.sla_configs;
CREATE POLICY sla_configs_org_boundary ON public.sla_configs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));

DO $verify$
DECLARE v_thieu text; v_sai text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_thieu FROM unnest(ARRAY[
    'asset_movements',
    'document_templates',
    'job_groups',
    'job_types',
    'material_adjustment_items',
    'material_adjustments',
    'material_categories',
    'material_purchase_items',
    'material_purchases',
    'material_usage_items',
    'material_usages',
    'materials',
    'public_room_events',
    'sla_configs'
  ]) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = t AND p.polname = t || '_org_boundary'
  );
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu policy biên giới sau khi chạy: %. DỪNG.', v_thieu;
  END IF;

  -- Policy phải RESTRICTIVE. PERMISSIVE là NỚI quyền — hỏng ngược hoàn toàn.
  SELECT string_agg(c.relname, ', ') INTO v_sai
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE p.polname = c.relname || '_org_boundary' AND p.polpermissive;
  IF v_sai IS NOT NULL THEN
    RAISE EXCEPTION 'Policy biên giới ra PERMISSIVE (nới quyền) ở: %. DỪNG.', v_sai;
  END IF;
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK: sinh lại bằng
--   node -e "const i=require('./docs/generated/org-boundary-inventory.json');
--     i.rows.filter(r=>r.assigned_phase==='GĐ4'&&!r.boundary_policy_name)
--      .forEach(r=>console.log(`DROP POLICY IF EXISTS ${r.table_name}_org_boundary ON public.${r.table_name};`))"
-- =============================================================================
