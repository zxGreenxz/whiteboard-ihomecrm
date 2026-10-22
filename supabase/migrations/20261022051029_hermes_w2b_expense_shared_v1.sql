-- Thu chi — hai hàm đọc dùng chung CRM (22/10/2026; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 17): phiếu CHI theo số tiền và tổng
-- CHI theo hạng mục, lọc như trang Thu chi web (src/hooks/income-expenses/queries.ts:298-413: income_expenses dưới RLS người gọi, chưa xoá,
-- PHIẾU CHI, ngày phiếu, approval_status mặc định ALL_ACTIVE = APPROVED + UNAPPROVED). Toà do người gọi truyền tường minh (kể cả toà ảo —
-- chi phí chung). Chữ tìm bỏ dấu bằng public.ie_quick_text_v1 (20261022024045, công thức Báo chi nhanh) ⇒ áp SAU file đó (thứ tự tên;
-- plpgsql tra hàm lúc chạy, nên khối kiểm dưới không đòi nó — mọi fixture đợt 2 nạp file này).
-- INVOKER, search_path rỗng, tự từ chối ngoài vai authenticated; chỉ authenticated được gọi. Không DROP, không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.income_expenses') IS NULL OR to_regclass('public.income_expense_items') IS NULL THEN
    RAISE EXCEPTION 'ie_expense_reads_dependency_invalid'; END IF;
END $requires$;

-- 1. Hàm dùng chung CRM (INVOKER, search_path rỗng, tự từ chối ngoài vai authenticated; NHẬN công ty + toà tường minh như mọi hàm dùng
-- chung của gói). Lọc như trang Thu chi web: công ty, toà ∈ p_building_ids, chưa xoá, PHIẾU CHI, ngày phiếu trong khoảng, trạng thái (NULL =
-- APPROVED+UNAPPROVED như mặc định ALL_ACTIVE), ngưỡng tiền ≥ p_min_amount, chữ tìm (bỏ dấu; tên/mã phiếu hoặc tên hạng mục). Phiếu có dòng
-- hạn chế của NGƯỜI KHÁC chỉ khi p_include_restricted (NULL = không; phiếu của chính mình vẫn thấy như RLS web); RLS của người gọi quyết phần còn lại.
CREATE OR REPLACE FUNCTION public.ie_expense_vouchers_v1(p_organization_id uuid,p_building_ids uuid[],p_from date,p_to date,
  p_status text DEFAULT NULL,p_min_amount numeric DEFAULT NULL,p_query text DEFAULT NULL,p_include_restricted boolean DEFAULT NULL)
RETURNS TABLE(organization_id uuid,voucher_id uuid,code text,voucher_date date,name text,building_id uuid,building_name text,room_name text,
  categories text,total_amount numeric,approval_status text,posting_status text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_query text;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'ie_expense_vouchers_denied' USING ERRCODE='42501'; END IF;
  IF p_building_ids IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>366 OR p_min_amount<0
    OR (p_status IS NOT NULL AND p_status NOT IN ('APPROVED','UNAPPROVED','CANCELLED')) THEN
    RAISE EXCEPTION 'ie_expense_vouchers_invalid' USING ERRCODE='22023'; END IF;
  p_include_restricted:=COALESCE(p_include_restricted,false);
  v_query:=NULLIF(btrim(public.ie_quick_text_v1(p_query,true)),'');
  RETURN QUERY
  SELECT ie.organization_id,ie.id,ie.code::text,ie.voucher_date,ie.name::text,ie.building_id,b.name::text,r.name::text,
    (SELECT string_agg(DISTINCT t.name::text,', ' ORDER BY t.name::text) FROM public.income_expense_items it
      JOIN public.income_expense_types t ON t.id=it.income_expense_type_id WHERE it.income_expense_id=ie.id),
    ie.total_amount::numeric,ie.approval_status::text,ie.posting_status::text,ie.created_at
  FROM public.income_expenses ie
  LEFT JOIN public.buildings b ON b.id=ie.building_id
  LEFT JOIN public.rooms r ON r.id=ie.room_id
  WHERE ie.organization_id=p_organization_id AND ie.deleted_at IS NULL AND ie.type='EXPENSE' AND ie.building_id=ANY(p_building_ids)
    AND ie.voucher_date BETWEEN p_from AND p_to
    AND CASE WHEN p_status IS NULL THEN ie.approval_status IN ('APPROVED','UNAPPROVED') ELSE ie.approval_status=p_status END
    AND (p_min_amount IS NULL OR ie.total_amount>=p_min_amount)
    AND (p_include_restricted OR NOT COALESCE(ie.has_restricted_item,false) OR ie.user_id=auth.uid())
    AND (v_query IS NULL OR strpos(public.ie_quick_text_v1(concat_ws(' ',ie.name,ie.code),true),v_query)>0
      OR EXISTS(SELECT 1 FROM public.income_expense_items it JOIN public.income_expense_types t ON t.id=it.income_expense_type_id
        WHERE it.income_expense_id=ie.id AND strpos(public.ie_quick_text_v1(t.name,true),v_query)>0));
END $fn$;

-- Tổng chi theo hạng mục × toà: cùng bộ lọc phiếu như trên; tiền = dòng hạng mục (amount, thiếu thì quantity × unit_price), số phiếu đếm
-- phiếu phân biệt. Tên hạng mục RLS giấu (hạng mục hạn chế) ⇒ NULL, tiền vẫn tính vào đúng typeId.
CREATE OR REPLACE FUNCTION public.ie_expense_categories_v1(p_organization_id uuid,p_building_ids uuid[],p_from date,p_to date,
  p_status text DEFAULT NULL,p_include_restricted boolean DEFAULT NULL)
RETURNS TABLE(organization_id uuid,building_id uuid,building_name text,type_id uuid,type_name text,voucher_count bigint,total_amount numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'ie_expense_categories_denied' USING ERRCODE='42501'; END IF;
  IF p_building_ids IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>366
    OR (p_status IS NOT NULL AND p_status NOT IN ('APPROVED','UNAPPROVED','CANCELLED')) THEN
    RAISE EXCEPTION 'ie_expense_categories_invalid' USING ERRCODE='22023'; END IF;
  p_include_restricted:=COALESCE(p_include_restricted,false);
  RETURN QUERY
  SELECT ie.organization_id,ie.building_id,max(b.name::text),it.income_expense_type_id,max(t.name::text),count(DISTINCT ie.id),
    sum(COALESCE(it.amount,it.quantity*it.unit_price))::numeric
  FROM public.income_expenses ie
  JOIN public.income_expense_items it ON it.income_expense_id=ie.id
  LEFT JOIN public.income_expense_types t ON t.id=it.income_expense_type_id
  LEFT JOIN public.buildings b ON b.id=ie.building_id
  WHERE ie.organization_id=p_organization_id AND ie.deleted_at IS NULL AND ie.type='EXPENSE' AND ie.building_id=ANY(p_building_ids)
    AND ie.voucher_date BETWEEN p_from AND p_to
    AND CASE WHEN p_status IS NULL THEN ie.approval_status IN ('APPROVED','UNAPPROVED') ELSE ie.approval_status=p_status END
    AND (p_include_restricted OR NOT COALESCE(ie.has_restricted_item,false) OR ie.user_id=auth.uid())
  GROUP BY ie.organization_id,ie.building_id,it.income_expense_type_id;
END $fn$;

ALTER FUNCTION public.ie_expense_vouchers_v1(uuid,uuid[],date,date,text,numeric,text,boolean) OWNER TO postgres;
ALTER FUNCTION public.ie_expense_categories_v1(uuid,uuid[],date,date,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ie_expense_vouchers_v1(uuid,uuid[],date,date,text,numeric,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ie_expense_categories_v1(uuid,uuid[],date,date,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ie_expense_vouchers_v1(uuid,uuid[],date,date,text,numeric,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ie_expense_categories_v1(uuid,uuid[],date,date,text,boolean) TO authenticated;

-- Khối kiểm chỉ đọc catalog (quyền gọi kiểm ở test PGlite gói B: khối DO của dải gói không được nêu từ khoá thực thi động).
DO $check$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE oid IN ('public.ie_expense_vouchers_v1(uuid,uuid[],date,date,text,numeric,text,boolean)'::regprocedure,
      'public.ie_expense_categories_v1(uuid,uuid[],date,date,text,boolean)'::regprocedure) AND NOT prosecdef AND provolatile='s'
      AND 'search_path=""'=ANY(proconfig))<>2 THEN
    RAISE EXCEPTION 'ie_expense_reads_catalog_invalid'; END IF;
END $check$;
COMMIT;
NOTIFY pgrst,'reload schema';
