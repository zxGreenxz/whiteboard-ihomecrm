-- Đọc báo cáo tài chính dùng chung (web + trợ lý AI, đợt 2 Gói B): sửa sau review độc lập PR #208 (head c1620645), 18/10/2026.
-- Chạy SAU 20261018020050_hermes_w2b_finance_shared_v1 (giữ nguyên — có thể đã áp TEST; file này thay bản định nghĩa) và TRƯỚC
-- 20261018020300_hermes_w2b_finance_read_fixes_v1 (hàm đọc của trợ lý gọi hàm mới ở đây). Thứ tự tên = thứ tự áp. Hàm CRM
-- thường, cùng mô hình INVOKER + RLS của 20261018020050:
--  1. [P2] Top khoản chi: phiếu hạn chế của người khác bị người gọi loại SAU khi hàm nguồn đã cắt 100 phiếu lớn nhất ⇒ có thể
--     trả rỗng sai. Bộ lọc vào hàm nguồn MỚI public.finance_analysis_top_expenses_v2, TRƯỚC ORDER BY/LIMIT; tham số
--     p_include_restricted chỉ THU HẸP quyền CRM (RLS income_expenses): false ⇒ bỏ phiếu hạn chế của người khác, NULL/true ⇒
--     như RLS. Bản _v1 (chữ ký giữ nguyên, web gọi được) = _v2 với p_include_restricted NULL — một công thức.
--  2. [P2] Tổng quan cổ đông: thêm điều kiện isManager của web (ProfitHubPage.tsx:46-51,67-68) — super admin, chốt/mở chốt LN
--     (profit_close_scopes_v2 như web, ở ĐÚNG công ty), shareholder_profit.distribute hoặc shareholder_profit.manage_shareholders
--     — cùng shareholder_profit.view. finance_my_scope_v1 nhận thêm hai khoá distribute/manage_shareholders.
--  3. [P3] public.report_text_v1: search_path='' và từ chối khi current_user<>'authenticated' như các hàm dùng chung khác.
--  4. public.finance_type_restricted_v1 (DEFINER, giữ có điều kiện): chỉ trả lời cho hạng mục thuộc công ty của CHÍNH người gọi
--     (my_org_ids()); id lạ/ngoài phạm vi ⇒ NULL (người gọi coi như hạn chế). Lý do DEFINER ghi ở COMMENT.
-- Chuỗi tổng hợp building_id NULL của cashbook_daily_v1 / cashbook_cash_flow_v1 / finance_analysis_type_breakdown_v1 giữ nguyên:
-- chỉ khi người gọi không truyền toà (trợ lý chỉ làm vậy khi kết nối Toàn tổ chức); organization_id = công ty hàm đã lọc tường minh.
-- Không DROP, không đổi chữ ký đã có, không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Đòi các hàm của 20261018020050 (file này chỉ thay định nghĩa / thêm _v2). RPC web profit_close_scopes_v2 có trên production
-- từ trước và được gọi lúc chạy (plpgsql), như các RPC web khác của 20261018020050.
DO $requires$
BEGIN
  IF to_regprocedure('public.finance_my_scope_v1(uuid,text)') IS NULL
    OR to_regprocedure('public.finance_type_restricted_v1(uuid,boolean)') IS NULL
    OR to_regprocedure('public.report_text_v1(text,integer)') IS NULL
    OR to_regprocedure('public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer)') IS NULL
    OR to_regprocedure('public.profit_shareholder_summary_v1(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'finance_shared_fixes_requires_020050';
  END IF;
END $requires$;

-- ===== Helper nhỏ =====

-- Như 20261018020050, thêm hai khoá của điều kiện isManager (tổng quan cổ đông): shareholder_profit.distribute,
-- shareholder_profit.manage_shareholders. 'allowed' = toàn công ty hoặc có ở toà/sổ nào đó — như canUse() của web khi không
-- hỏi toà (permissionPages.ts quyetDinhTheoPhamVi). Không nhận user khác: luôn auth.uid().
CREATE OR REPLACE FUNCTION public.finance_my_scope_v1(p_organization_id uuid,p_permission text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org_wide boolean; v_buildings uuid[]; v_cashbooks uuid[];
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR p_permission IS NULL OR NOT p_permission=ANY(ARRAY['reports_finance.daily_cashbook',
      'reports_finance.cash_flow','cashbooks.view','reports_finance.analysis','income_expenses.restricted_view',
      'reports_finance.profit_distribution','shareholder_profit.view','shareholder_profit.distribute',
      'shareholder_profit.manage_shareholders']) THEN
    RAISE EXCEPTION 'finance_scope_invalid' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(bool_or(s.org_wide),false) INTO v_org_wide FROM app_private.authorized_scope_v3(p_permission,p_organization_id) s;
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (v_org_wide OR EXISTS(
      SELECT 1 FROM app_private.authorized_scope_v3(p_permission,p_organization_id) s WHERE b.id=ANY(COALESCE(s.building_ids,'{}'::uuid[]))));
  SELECT COALESCE(array_agg(a.id ORDER BY a.id),'{}'::uuid[]) INTO v_cashbooks FROM public.accounts a
    WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL AND EXISTS(
      SELECT 1 FROM app_private.authorized_scope_v3(p_permission,p_organization_id) s WHERE a.id=ANY(COALESCE(s.cashbook_ids,'{}'::uuid[])));
  RETURN jsonb_build_object('allowed',v_org_wide OR cardinality(v_buildings)>0 OR cardinality(v_cashbooks)>0,'orgWide',v_org_wide,
    'buildingIds',to_jsonb(v_buildings),'cashbookIds',to_jsonb(v_cashbooks));
END $fn$;

-- Hạng mục p_type_id có phải hạn chế không: chính nó, hoặc (p_merged) một hạng mục gộp vào nó. CHỈ trả lời cho hạng mục thuộc
-- công ty của chính người gọi (my_org_ids()); id lạ hoặc của công ty khác ⇒ NULL — người gọi (WHERE … OR NOT f(…)) bỏ hàng.
CREATE OR REPLACE FUNCTION public.finance_type_restricted_v1(p_type_id uuid,p_merged boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid;
BEGIN
  SELECT t.organization_id INTO v_org FROM public.income_expense_types t WHERE t.id=p_type_id;
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT COALESCE(v_org=ANY(public.my_org_ids()),false) THEN RETURN NULL; END IF;
  RETURN EXISTS(SELECT 1 FROM public.income_expense_types r WHERE r.is_restricted
    AND (r.id=p_type_id OR COALESCE(p_merged,true) AND r.merged_into_id=p_type_id));
END $fn$;

-- Chữ an toàn cho đầu ra báo cáo (giữ xuống dòng, bỏ ký tự điều khiển, cắt theo ký tự) — cùng công thức 20261018020050, nay
-- search_path rỗng và chỉ chạy dưới vai authenticated như mọi hàm dùng chung của gói.
CREATE OR REPLACE FUNCTION public.report_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' THEN RAISE EXCEPTION 'report_text_denied' USING ERRCODE='42501'; END IF;
  IF p_text IS NULL THEN RETURN NULL; END IF;
  RETURN left(btrim(regexp_replace(
    translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
    '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0));
END $fn$;

-- ===== Hàm báo cáo dùng chung (INVOKER + RLS) =====

-- B7 — "Top 10 khoản chi" của Phân tích tài chính (ExpenseTab.tsx:61-83: income_expenses EXPENSE, APPROVED, kqkd_amount>0 trong kỳ,
-- đọc qua RLS — kể cả policy phiếu hạn chế) trên toà của khoá reports_finance.analysis ∩ p_building_ids. Xếp theo số tiền trên CẢ
-- kỳ. p_include_restricted chỉ THU HẸP RLS: false ⇒ bỏ phiếu hạn chế của người khác (phiếu của chính mình vẫn có, như RLS web);
-- lọc ngay trong WHERE, TRƯỚC khi xếp và cắt p_limit — không để người gọi lọc sau LIMIT (100 phiếu bị loại đứng trước ⇒ rỗng sai).
CREATE OR REPLACE FUNCTION public.finance_analysis_top_expenses_v2(p_organization_id uuid,p_start_date date,p_end_date date,
  p_building_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT NULL,p_include_restricted boolean DEFAULT NULL)
RETURNS TABLE(organization_id uuid,voucher_id uuid,voucher_date date,code text,name text,building_id uuid,building_name text,item_types text,
  total_amount numeric,has_restricted_item boolean,user_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_scope jsonb; v_buildings uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'top_expenses_denied' USING ERRCODE='42501';
  END IF;
  v_scope:=public.finance_my_scope_v1(p_organization_id,'reports_finance.analysis');
  IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'top_expenses_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x),'{}'::uuid[]) INTO v_buildings
    FROM unnest(COALESCE(p_building_ids,ARRAY(SELECT jsonb_array_elements_text(v_scope->'buildingIds')::uuid))) x WHERE v_scope->'buildingIds' ? x::text;
  RETURN QUERY
  SELECT ie.organization_id,ie.id,ie.voucher_date,ie.code,ie.name,ie.building_id,b.name,
    (SELECT string_agg(DISTINCT t.name,', ' ORDER BY t.name) FROM public.income_expense_items it
      JOIN public.income_expense_types t ON t.id=it.income_expense_type_id WHERE it.income_expense_id=ie.id),
    ie.total_amount,ie.has_restricted_item,ie.user_id
  FROM public.income_expenses ie
  LEFT JOIN public.buildings b ON b.id=ie.building_id
  WHERE ie.organization_id=p_organization_id AND ie.deleted_at IS NULL
    AND ie.type='EXPENSE' AND ie.approval_status='APPROVED' AND ie.kqkd_amount>0
    AND ie.voucher_date BETWEEN p_start_date AND p_end_date AND ie.building_id=ANY(v_buildings)
    AND (p_include_restricted IS NOT FALSE OR NOT ie.has_restricted_item OR ie.user_id=auth.uid())
  ORDER BY ie.total_amount DESC,ie.voucher_date DESC,ie.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit,10),1),100);
END $fn$;

-- Bản _v1 (20261018020050, chữ ký giữ nguyên): như _v2 khi không thu hẹp (RLS quyết phiếu hạn chế).
CREATE OR REPLACE FUNCTION public.finance_analysis_top_expenses_v1(p_organization_id uuid,p_start_date date,p_end_date date,
  p_building_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT NULL)
RETURNS TABLE(organization_id uuid,voucher_id uuid,voucher_date date,code text,name text,building_id uuid,building_name text,item_types text,
  total_amount numeric,has_restricted_item boolean,user_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'top_expenses_denied' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT * FROM public.finance_analysis_top_expenses_v2(p_organization_id,p_start_date,p_end_date,p_building_ids,p_limit,NULL);
END $fn$;

-- B10 (quản lý) — "Tổng quan" quản lý của Phân bổ lợi nhuận (ProfitOverviewTab.tsx:61-168). Web chỉ hiện tab khi isManager &&
-- shareholder_profit.view (ProfitHubPage.tsx:46-51,67-68); isManager = super admin ∨ chốt/mở chốt LN (profit_close_scopes_v2
-- can_lock/can_unlock — web xét mọi công ty, ở đây chỉ ĐÚNG công ty) ∨ shareholder_profit.distribute ∨
-- shareholder_profit.manage_shareholders. Thiếu ⇒ 42501, kể cả người tạo dòng cũ mà RLS (owner_all) vẫn cho đọc. Phần đọc như
-- 20261018020050: profit_*/shareholders/income_expenses dưới RLS (dòng nhìn thấy do policy quyết).
CREATE OR REPLACE FUNCTION public.profit_shareholder_summary_v1(p_organization_id uuid,p_year integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_locked numeric; v_rows jsonb; v_close jsonb;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'profit_summary_denied' USING ERRCODE='42501';
  END IF;
  IF public.finance_my_scope_v1(p_organization_id,'shareholder_profit.view')->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'profit_summary_denied' USING ERRCODE='42501';
  END IF;
  -- isManager: RPC chốt LN chỉ gọi khi ba điều kiện rẻ hơn đều không có.
  IF NOT (COALESCE(public.is_super_admin(),false)
      OR public.finance_my_scope_v1(p_organization_id,'shareholder_profit.distribute')->'allowed' IS NOT DISTINCT FROM 'true'::jsonb
      OR public.finance_my_scope_v1(p_organization_id,'shareholder_profit.manage_shareholders')->'allowed' IS NOT DISTINCT FROM 'true'::jsonb) THEN
    v_close:=public.profit_close_scopes_v2()->'organizations';
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_close)='array' THEN v_close ELSE '[]'::jsonb END) o
        WHERE o->>'organization_id'=p_organization_id::text
          AND (COALESCE((o->>'can_lock')::boolean,false) OR COALESCE((o->>'can_unlock')::boolean,false))) THEN
      RAISE EXCEPTION 'profit_summary_denied' USING ERRCODE='42501';
    END IF;
  END IF;
  SELECT COALESCE(sum(pm.adjusted_profit),0) INTO v_locked FROM public.profit_monthly pm
    WHERE pm.organization_id=p_organization_id AND pm.status='LOCKED';
  WITH sh AS (
    SELECT s.id,s.name,s.organization_id FROM public.shareholders s WHERE s.organization_id=p_organization_id AND s.deleted_at IS NULL
  ), alloc AS (
    SELECT pa.shareholder_id,sum(pa.amount) accrued,
      sum(pa.amount) FILTER (WHERE p_year IS NOT NULL AND extract(year FROM pm.period_month)=p_year) year_accrued
    FROM public.profit_allocations pa LEFT JOIN public.profit_monthly pm ON pm.id=pa.profit_monthly_id
    WHERE pa.organization_id=p_organization_id AND pa.shareholder_id IN (SELECT id FROM sh)
    GROUP BY pa.shareholder_id
  ), paid AS (
    SELECT ie.shareholder_id,sum(ie.total_amount) paid FROM public.income_expenses ie
    WHERE ie.organization_id=p_organization_id AND ie.shareholder_id IN (SELECT id FROM sh) AND ie.type='EXPENSE'
      AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL
    GROUP BY ie.shareholder_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('organization_id',sh.organization_id,'shareholder_id',sh.id,'name',sh.name,'accrued',COALESCE(alloc.accrued,0),
      'paid',COALESCE(paid.paid,0),'remaining',COALESCE(alloc.accrued,0)-COALESCE(paid.paid,0),
      'year_accrued',CASE WHEN p_year IS NOT NULL THEN COALESCE(alloc.year_accrued,0) END) ORDER BY sh.name,sh.id),'[]'::jsonb)
    INTO v_rows FROM sh LEFT JOIN alloc ON alloc.shareholder_id=sh.id LEFT JOIN paid ON paid.shareholder_id=sh.id;
  RETURN jsonb_build_object('locked_profit',v_locked,'shareholders',v_rows);
END $fn$;


ALTER FUNCTION public.finance_my_scope_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.finance_type_restricted_v1(uuid,boolean) OWNER TO postgres;
ALTER FUNCTION public.report_text_v1(text,integer) OWNER TO postgres;
ALTER FUNCTION public.finance_analysis_top_expenses_v2(uuid,date,date,uuid[],integer,boolean) OWNER TO postgres;
ALTER FUNCTION public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer) OWNER TO postgres;
ALTER FUNCTION public.profit_shareholder_summary_v1(uuid,integer) OWNER TO postgres;
COMMENT ON FUNCTION public.finance_type_restricted_v1(uuid,boolean) IS
  'SECURITY DEFINER có chủ ý: RLS RESTRICTIVE income_expense_types_restricted_select giấu chính hạng mục hạn chế với người thiếu quyền, nên bản INVOKER luôn thấy "không hạn chế" và làm lọt tổng hạng mục hạn chế (fa_type_breakdown / fa_type_breakdown_accrual). Chỉ trả một boolean cho hạng mục thuộc công ty của chính người gọi (my_org_ids()); id lạ hoặc của công ty khác ⇒ NULL. search_path cố định; chỉ authenticated.';
-- Chỉ vai authenticated (web và trợ lý dưới JWT người dùng); anon/service_role không gọi được.
REVOKE ALL ON FUNCTION public.finance_my_scope_v1(uuid,text),public.finance_type_restricted_v1(uuid,boolean),public.report_text_v1(text,integer),
  public.finance_analysis_top_expenses_v2(uuid,date,date,uuid[],integer,boolean),public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer),
  public.profit_shareholder_summary_v1(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.finance_my_scope_v1(uuid,text),public.finance_type_restricted_v1(uuid,boolean),public.report_text_v1(text,integer),
  public.finance_analysis_top_expenses_v2(uuid,date,date,uuid[],integer,boolean),public.finance_analysis_top_expenses_v1(uuid,date,date,uuid[],integer),
  public.profit_shareholder_summary_v1(uuid,integer) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
