-- =============================================================================
-- Lương: đọc nguồn hoa hồng KHÔNG ném cả lô khi một phiếu nằm ở toà ngoài phạm vi
-- (kiểm toàn bộ 11/10/2026: K11-34 = Q-01 = C-02, mẫu lỗi G7; Q12 mặc định chủ chốt)
--
-- VẤN ĐỀ (đọc thân hàm production = migration 20260930112705, md5 khớp TEST)
--   Màn lương gửi read_rent_support_salary_parts_v1 MỌI phiếu hoa hồng của tháng
--   mà RLS cho người xem thấy. RLS income_expenses có nhánh select_fund_member:
--   người GIỮ SỔ thấy phiếu của mọi toà đi qua sổ mình. Hàm lại RAISE 42501 cho
--   CẢ LÔ nếu MỘT phiếu không qua can_access_building ⇒ quản lý giữ sổ không mở
--   được bảng lương của chính mình (/finance/salary, /finance/my-salary).
--   Production (chỉ đọc): quản lý A tháng 9 thấy 49 phiếu, 23 ngoài phạm vi;
--   quản lý B tháng 9 43 phiếu, 19 ngoài phạm vi. Phiếu hoa hồng từ 08/2026: 0
--   phiếu có nguồn hỗ trợ tiền phòng (alias), 0 phiếu HĐ có kế hoạch mà thiếu
--   nguồn ⇒ hôm nay MỌI phiếu ngoài phạm vi đều là phiếu thường (không có phần
--   lương nào để đọc) — lỗi chỉ đến từ câu RAISE đặt TRƯỚC câu bỏ qua.
--
-- SỬA (chỉ thân hàm; chữ ký, kiểu trả về, ACL giữ nguyên)
--   • Vẫn RAISE 42501 khi phiếu không tồn tại / khác công ty / RLS không cho đọc
--     (ie_supplement_can_read_v1) — đó là id giả, không phải phiếu ngoài toà.
--   • Phiếu thấy được nhưng ngoài toà (can_access_building = false):
--       – không phải nguồn hỗ trợ tiền phòng ⇒ bỏ qua như phiếu trong toà
--         (không trả dòng, không lộ gì);
--       – là nguồn mà người xem được xem lương của người nhận (chính mình hoặc
--         salary.view toàn công ty — app_private.v5_can_view_salary_v1) hoặc có
--         salary.lock / salary.distribute trong công ty ⇒ trả phần tính lương như
--         phiếu trong toà (chỉ số tiền + mã chứng cứ, không tên toà/HĐ/khách) ⇒
--         số lương giữ đúng;
--       – còn lại ⇒ dòng NEEDS_REVIEW không có source_id/part, chỉ staff_id (người
--         nhận, vốn đã thấy qua payer_name của phiếu) để màn lương bỏ qua phiếu
--         của người không có trong bảng.
--
-- IDEMPOTENT: CREATE OR REPLACE cùng chữ ký; ACL khẳng định lại. Không ghi dữ liệu.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.read_rent_support_salary_parts_v1(p_voucher_ids uuid[],p_period_month date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE vid uuid;v public.income_expenses;s app_private.rent_support_payout_sources;profile uuid;f jsonb;rows jsonb:='[]';period date;issue text;
 in_scope boolean;admin_org uuid;admin_ok boolean:=false;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501';END IF;
 IF p_voucher_ids IS NULL OR cardinality(p_voucher_ids)>1000 THEN RAISE EXCEPTION 'Danh sách nguồn không hợp lệ' USING ERRCODE='22023';END IF;
 FOREACH vid IN ARRAY p_voucher_ids LOOP
 SELECT * INTO v FROM public.income_expenses WHERE id=vid;
 IF v.id IS NULL OR NOT COALESCE(v.organization_id=ANY(public.my_org_ids()),false) OR NOT COALESCE(app_private.ie_supplement_can_read_v1(vid),false) THEN RAISE EXCEPTION 'Không có quyền xem nguồn hoa hồng' USING ERRCODE='42501';END IF;
 in_scope:=COALESCE(public.can_access_building(v.building_id),false);
 SELECT x.* INTO s FROM app_private.rent_support_source_aliases a JOIN app_private.rent_support_payout_sources x ON x.organization_id=a.organization_id AND x.id=a.source_id WHERE a.organization_id=v.organization_id AND a.alias_kind='VOUCHER' AND a.alias_id=vid;
 IF s.id IS NULL AND NOT EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=v.organization_id AND contract_id=v.contract_id) THEN CONTINUE;END IF;
 SELECT profile_id INTO profile FROM app_private.rent_support_parties WHERE organization_id=v.organization_id AND id=s.party_id;
 IF NOT in_scope THEN
  IF admin_org IS DISTINCT FROM v.organization_id THEN
   admin_org:=v.organization_id;
   admin_ok:=EXISTS(SELECT 1 FROM unnest(ARRAY['salary.lock','salary.distribute']) k(key)
     CROSS JOIN LATERAL app_private.authorized_scope_v3(k.key,admin_org) sc
     WHERE COALESCE(sc.org_wide,false) OR COALESCE(cardinality(sc.building_ids),0)>0);
  END IF;
  IF NOT (admin_ok OR (profile IS NOT NULL AND COALESCE(app_private.v5_can_view_salary_v1(profile),false))) THEN
   rows:=rows||jsonb_build_array(jsonb_build_object('voucher_id',vid,'state','NEEDS_REVIEW','source_id',NULL,'staff_id',profile,'part',NULL,
     'issue','Phiếu ở toà ngoài phạm vi của bạn; người có quyền kỳ lương đối chiếu.'));
   CONTINUE;
  END IF;
 END IF;
 SELECT COALESCE(p_period_month,date_trunc('month',start_date)::date) INTO period FROM public.income_expense_items WHERE income_expense_id=vid ORDER BY id LIMIT 1;
 f:=NULL;issue:=NULL;
 BEGIN f:=app_private.rent_support_salary_part_v1(v.organization_id,vid,period,profile);
 EXCEPTION WHEN SQLSTATE 'PT409' THEN issue:='Cần đối chiếu quyền lợi, kỳ hoặc chứng cứ thanh toán.';END;
 rows:=rows||jsonb_build_array(jsonb_build_object('voucher_id',vid,'state',CASE WHEN f IS NOT NULL THEN 'READY' ELSE 'NEEDS_REVIEW' END,'source_id',s.id,'staff_id',profile,'part',f,'issue',issue));
 END LOOP;RETURN rows;
END $$;
ALTER FUNCTION public.read_rent_support_salary_parts_v1(uuid[],date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_rent_support_salary_parts_v1(uuid[],date) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_rent_support_salary_parts_v1(uuid[],date) TO authenticated;

-- Nghiệm thu (chỉ đọc catalog).
DO $nghiem_thu$
DECLARE fn oid:=to_regprocedure('public.read_rent_support_salary_parts_v1(uuid[],date)');def text;
BEGIN
 IF fn IS NULL THEN RAISE EXCEPTION 'Nghiệm thu K11-34 KHÔNG ĐẠT: thiếu read_rent_support_salary_parts_v1';END IF;
 def:=pg_get_functiondef(fn);
 IF NOT (SELECT prosecdef AND provolatile='s' FROM pg_proc WHERE oid=fn) THEN RAISE EXCEPTION 'Nghiệm thu K11-34 KHÔNG ĐẠT: phải SECURITY DEFINER + STABLE';END IF;
 IF position('in_scope:=COALESCE(public.can_access_building' IN def)=0 OR position('OR NOT public.can_access_building' IN def)>0 THEN
  RAISE EXCEPTION 'Nghiệm thu K11-34 KHÔNG ĐẠT: còn ném cả lô theo can_access_building';END IF;
 IF has_function_privilege('anon',fn,'EXECUTE') OR NOT has_function_privilege('authenticated',fn,'EXECUTE') THEN
  RAISE EXCEPTION 'Nghiệm thu K11-34 KHÔNG ĐẠT: ACL lệch (anon phải bị chặn, authenticated được gọi)';END IF;
END
$nghiem_thu$;

-- ROLLBACK (thủ công): CREATE OR REPLACE lại thân hàm ở 20260930112705 (dòng ~789).
-- Không có dữ liệu để lùi.
