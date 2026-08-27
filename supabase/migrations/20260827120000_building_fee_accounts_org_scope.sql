BEGIN;
-- ============================================================
-- building_fee_accounts: vá dòng rò + đóng đường đẻ ra dòng rò
--
-- TRIỆU CHỨNG: gate đo rò rỉ xuyên tổ chức (scripts/measure-org-leak.mjs) đỏ
-- trên CI 27/08/2026:
--     ✗ building_fee_accounts — 1 dòng organization_id NULL
-- Công thức biên giới có nhánh `organization_id IS NULL`, nên dòng đó HIỆN CHO
-- MỌI TỔ CHỨC — đúng thứ 304 policy biên giới sinh ra để chặn.
--
-- ĐO ĐƯỢC (prod, 27/08/2026), và nó nói gốc rễ nằm ở ĐƯỜNG GHI chứ không ở dòng:
--   - bảng có 110 dòng: 109 có org, 1 không;
--   - dòng lỗi tạo 26/08 14:20 bởi nguyentamca165, toà d6610998… thuộc org
--     aaaa0000… ⇒ giá trị đúng không mơ hồ, bằng đúng thứ 109 dòng kia đang có;
--   - bảng CHỈ có trigger trg_bfa_updated_at — KHÔNG có trigger tự điền org.
--
-- Vì sao vá cả hai: chữa mỗi dòng thì đường ghi vẫn còn nguyên, và dòng hôm qua
-- chính là bằng chứng đường đó đang được người dùng đi. Lần sau sẽ lại rò, và
-- lần sau nữa gate lại đỏ ở đúng chỗ này.
--
-- Trigger dùng LẠI public._autofill_org() — hàm chung đã gắn trên 30 bảng khác,
-- BEFORE INSERT, suy org theo building_id (rồi room/contract/invoice/account/
-- customer/membership). building_fee_accounts có building_id NOT NULL nên nhánh
-- đầu tiên luôn ăn; không đẻ luật thứ hai, không chép công thức.
--
-- PHẠM VI CỐ Ý HẸP — và phần không làm phải nói ra. Đo cùng lúc: 13 bảng có
-- building_id + organization_id nullable đang THIẾU trigger này
-- (area_buildings, asset_warehouses, auto_debt_config, building_fee_accounts,
-- building_shareholders, building_utility_accounts, expenses,
-- inspection_sessions, issues, profit_manager_salary_buildings,
-- public_room_events, room_pass_listings, staff_assignments). Hôm nay CHỈ
-- building_fee_accounts có dòng NULL thật, nên 12 bảng kia là rủi ro cấu trúc
-- chứ chưa phải rò rỉ. Gắn trigger cho cả 13 là đổi hành vi insert của 12 tính
-- năng khác trong một migration sinh ra để chữa một dòng — việc đó phải đi
-- riêng, có người quyết, nhất là staff_assignments (bảng phân quyền).
--
-- Idempotent: backfill lọc `IS NULL`, trigger dùng DROP IF EXISTS + CREATE.
-- ============================================================

-- ---------- 1. Vá dòng đang rò ----------
UPDATE public.building_fee_accounts bfa
   SET organization_id = b.organization_id
  FROM public.buildings b
 WHERE bfa.building_id = b.id
   AND bfa.organization_id IS NULL
   AND b.organization_id IS NOT NULL;

DO $kiem$
DECLARE
  v_con integer;
BEGIN
  SELECT count(*) INTO v_con
  FROM public.building_fee_accounts
  WHERE organization_id IS NULL;

  IF v_con > 0 THEN
    RAISE EXCEPTION 'Còn % dòng building_fee_accounts thiếu organization_id sau backfill — toà của chúng cũng chưa có org, phải xử tay.', v_con;
  END IF;
END
$kiem$;

-- ---------- 2. Đóng đường ghi ----------
DROP TRIGGER IF EXISTS trg_autofill_org ON public.building_fee_accounts;
CREATE TRIGGER trg_autofill_org
  BEFORE INSERT ON public.building_fee_accounts
  FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- ---------- 3. Smoke: chèn THẬT một dòng thiếu org rồi rollback ----------
-- Không kiểm "trigger có tồn tại không" (câu đó luôn đúng sau CREATE) mà kiểm
-- ĐIỀU DUY NHẤT đáng giá: dòng chèn thiếu org có được điền không.
DO $smoke$
DECLARE
  v_bld  uuid;
  v_user uuid;
  v_org  uuid;
BEGIN
  SELECT b.id, b.user_id INTO v_bld, v_user
  FROM public.buildings b
  WHERE b.organization_id IS NOT NULL AND b.deleted_at IS NULL AND b.user_id IS NOT NULL
  LIMIT 1;

  IF v_bld IS NULL THEN
    RAISE EXCEPTION 'Smoke: không tìm được toà nhà có org để thử';
  END IF;

  BEGIN
    INSERT INTO public.building_fee_accounts (building_id, fee_category, user_id)
    VALUES (v_bld, 'smoke_org_autofill', v_user)
    RETURNING organization_id INTO v_org;

    IF v_org IS NULL THEN
      RAISE EXCEPTION 'SMOKE_HONG: trigger không điền organization_id';
    END IF;

    -- Ném để cuộn lại subtransaction — dòng thử KHÔNG được ở lại.
    RAISE EXCEPTION 'SMOKE_XONG';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'SMOKE_XONG' THEN RAISE; END IF;
  END;
END
$smoke$;

COMMIT;
