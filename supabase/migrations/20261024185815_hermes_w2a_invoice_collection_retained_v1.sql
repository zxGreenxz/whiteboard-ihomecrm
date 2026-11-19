-- Đợt 3 trang HOÁ ĐƠN — lượt 14 (25/10/2026, nghiệm thu lượt cuối C3c): hàm đọc DÙNG CHUNG public.invoice_collection_by_method_v1 (gói A,
-- 20261022051118; chỉ báo cáo collection_by_method dùng) tính tiền theo hình thức bằng số GIỮ LẠI collected_amount của
-- public.active_payment_receipts (dòng thu đang hiệu lực: áp vào hoá đơn + tiền dư khách để lại, trừ tiền thối) — đúng nguồn thẻ
-- "Đã thu" / TM / TK / TT / Cấn trừ của trang Hoá đơn (invoice_statistics_money_v1), vẫn theo NGÀY THU. Trước đây cộng payments.amount
-- (chỉ phần áp vào hoá đơn) nên TM thiếu tiền dư khách để lại, và cộng cấn trừ CT (không phải tiền thu: số giữ lại = 0). TEST tháng
-- 10/2026: trước TK 716.666.000 + TM 439.256.000 + TT 126.266.000 + CT 18.591.779 = 1.300.779.779; sau TM 444.941.000, CT 0, tổng
-- 1.287.873.000 (= truth của bộ chấm).
-- Dựng từ thân ĐANG CHẠY: production = TEST = file 20261022051118 (md5 bỏ CR 7a752b9fbe407c2b5ea880310d3baa38, đọc 25/10); chỉ đổi bảng
-- nguồn + cột tiền, mọi dòng khác giữ nguyên từng chữ (INVOKER, STABLE, search_path rỗng, tự kiểm khoá web thu_tien.view). Cùng chữ ký,
-- cùng kiểu trả về; không DROP, không GRANT/REVOKE (CREATE OR REPLACE giữ quyền), không ghi dữ liệu. Không chứa hàm của trợ lý. Áp được
-- trước hoặc sau connector (khuôn kết quả báo cáo không đổi). Idempotent; khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.active_payment_receipts') IS NULL OR to_regclass('public.invoices') IS NULL
    OR to_regprocedure('public.can_do_on_building(text,text,uuid)') IS NULL OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.active_payment_receipts') AND attname='collected_amount' AND NOT attisdropped)
    -- Thân đang chạy phải đúng thân 20261022051118 (hoặc thân của file này khi chạy lại).
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='public.invoice_collection_by_method_v1(uuid,uuid[],date,date)'::regprocedure)
      NOT IN ('7a752b9fbe407c2b5ea880310d3baa38','62b547b7b20e01246327b7f7dee1409b') THEN
    RAISE EXCEPTION 'invoice_collection_by_method_retained_dependency_invalid'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION public.invoice_collection_by_method_v1(p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
  p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS TABLE(building_id uuid,organization_id uuid,payment_method text,payment_count integer,invoice_count integer,amount numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[]; v_today date; v_from date; v_to date;
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('thu_tien','view',b.id);
  v_today:=public.org_today_v1(p_organization_id);
  v_from:=COALESCE(p_from,date_trunc('month',v_today)::date);
  v_to:=COALESCE(p_to,(date_trunc('month',v_today)+interval '1 month - 1 day')::date);
  RETURN QUERY
  SELECT i.building_id,i.organization_id,p.payment_method::text,count(*)::integer,count(DISTINCT i.id)::integer,COALESCE(sum(p.collected_amount),0)
  FROM public.active_payment_receipts p JOIN public.invoices i ON i.id=p.invoice_id
  WHERE p.payment_date BETWEEN v_from AND v_to AND p.organization_id=p_organization_id
    AND i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND i.building_id=ANY(v_b)
  GROUP BY i.building_id,i.organization_id,p.payment_method::text
  ORDER BY i.building_id,p.payment_method::text;
END $fn$;

DO $check$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid='public.invoice_collection_by_method_v1(uuid,uuid[],date,date)'::regprocedure;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.invoice_collection_by_method_v1(uuid,uuid[],date,date)'::regprocedure AND NOT prosecdef AND provolatile='s'
      AND replace(COALESCE(array_to_string(proconfig,','),''),'"','')='search_path=')
    -- Quyền giữ nguyên (CREATE OR REPLACE); hàng rào gói W2 cấm chữ EXECUTE trong khối DO nên không kiểm lại ở đây (test gói A kiểm ACL).
    OR position('public.active_payment_receipts' IN v_src)=0 OR position('collected_amount' IN v_src)=0 OR position('public.payments' IN v_src)>0 THEN
    RAISE EXCEPTION 'invoice_collection_by_method_retained_catalog_invalid'; END IF;
END $check$;
COMMIT;
