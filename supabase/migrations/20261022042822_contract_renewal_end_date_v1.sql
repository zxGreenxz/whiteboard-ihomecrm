-- Hàm dùng chung tính NGÀY KẾT THÚC KHI GIA HẠN hợp đồng thêm N tháng (22/10/2026; luật 17/10: công thức dùng ở ≥ 2 nơi đặt
-- trong database). Web (hộp Gia hạn, nút "+6 / +12 tháng") và trợ lý gia hạn qua chat cùng gọi; không nơi nào tự cộng tháng.
-- Luật (đo trên 112 lần gia hạn thật: khớp 82, phép cộng tháng thuần chỉ khớp 49):
--   ngày kết thúc là NGÀY CUỐI THÁNG ⇒ ngày cuối của tháng đích (28/02 + 6 = 31/08; 30/09 + 1 = 31/10);
--   còn lại ⇒ cùng số ngày, kẹp về cuối tháng khi tháng đích ngắn hơn (15/03 + 6 = 15/09; 30/01 + 1 = 28/02 hoặc 29/02).
-- NULL hoặc số tháng ngoài 1–120 ⇒ NULL (bên gọi từ chối). IMMUTABLE: không phụ thuộc múi giờ (tính trên timestamp không múi giờ).
-- Bộ vector dùng chung: infra/hermes-broker/contract-renewal-vectors.json. Chỉ tạo hàm mới; không DROP, không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION public.contract_renewal_end_date_v1(p_end_date date,p_months integer)
RETURNS date LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT CASE WHEN p_end_date IS NULL OR p_months IS NULL OR p_months<1 OR p_months>120 THEN NULL
    WHEN p_end_date=(date_trunc('month',p_end_date::timestamp)+interval '1 month - 1 day')::date
      THEN (date_trunc('month',p_end_date::timestamp)+make_interval(months=>p_months+1)-interval '1 day')::date
    ELSE (p_end_date::timestamp+make_interval(months=>p_months))::date END
$fn$;

ALTER FUNCTION public.contract_renewal_end_date_v1(date,integer) OWNER TO postgres;
-- Chỉ người đăng nhập (web gọi qua RPC); không anon/PUBLIC/service_role.
REVOKE ALL ON FUNCTION public.contract_renewal_end_date_v1(date,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.contract_renewal_end_date_v1(date,integer) TO authenticated;

DO $check$
BEGIN
  IF public.contract_renewal_end_date_v1(DATE '2027-02-28',6)<>DATE '2027-08-31'
    OR public.contract_renewal_end_date_v1(DATE '2026-09-30',1)<>DATE '2026-10-31'
    OR public.contract_renewal_end_date_v1(DATE '2027-03-15',6)<>DATE '2027-09-15'
    OR public.contract_renewal_end_date_v1(DATE '2027-01-30',1)<>DATE '2027-02-28'
    OR public.contract_renewal_end_date_v1(DATE '2028-01-30',1)<>DATE '2028-02-29'
    OR public.contract_renewal_end_date_v1(DATE '2027-01-31',1)<>DATE '2027-02-28'
    OR public.contract_renewal_end_date_v1(DATE '2027-02-28',0) IS NOT NULL
    OR has_function_privilege('anon','public.contract_renewal_end_date_v1(date,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'contract_renewal_end_date_check_failed'; END IF;
END $check$;
COMMIT;
NOTIFY pgrst,'reload schema';
