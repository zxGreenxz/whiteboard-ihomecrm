-- Hermes Thu chi — lượt 15 (24/10/2026; nghiệm thu lượt cuối C3d trên TEST, connector 66df91e7, SOUL v4.23;
-- docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 26). Áp SAU 20261024094809_hermes_expense_system_flow_block_v1 (thân bộ phân luồng của
-- file đó là thân dựng từ; chưa áp production, đã áp TEST).
-- Lỗi: "Thu 200k giữ xe" ⇒ bot gọi expense.create, máy chủ hỏi hạng mục chi ⇒ khoản THU suýt thành phiếu CHI. Đúng: phiếu THU lập tay
-- không qua bot ⇒ web_only + link trang Thu chi (/income-expense), như cách lượt 13 chặn luồng hệ thống.
-- Sửa: bộ phân luồng hệ thống (thuần chữ, IMMUTABLE) thêm hai nhánh SAU mọi nhánh cũ: "thu (tiền) cọc" ⇒ luồng cọc (/deposits); khoản THU theo
-- cụm có ngữ cảnh (chú thích trong thân) ⇒ flow income, link /income-expense. Bộ chọn hạng mục, bước ghi (lượt 1 và lượt 2), kiểm lại hạng
-- mục đều gọi bộ phân luồng theo tên ⇒ không dựng lại hàm nào khác. Đo production (chỉ đọc): 1.309 phiếu CHI lập tay (690 trong 90 ngày),
-- 186 hạng mục chi — 0 dính luật mới (25 phiếu có chữ "thu" đều là chi thật: "thu chi điện lạnh …", "hoàn tác thu tiền", "phòng thu hộ"…).
-- Connector KHÔNG cần lên trước: web_only + link đã là lý do của expense.create (lượt 13). Ghim md5 thân đang chạy (thân 094809) hoặc thân
-- của chính file. Ghim chéo: không file nào ghim thân bộ phân luồng (094809 tạo mới; chạy lại 094809 đã ngã ở ghim bước ghi do 120211). Không
-- ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('public.hermes_expense_system_flow_v1(text,text)')),'')
      NOT IN ('8e827574e8909c98c66f2025ac4c3e46','ea545bc265ddddf221ba1abdeb55d814') THEN
    RAISE EXCEPTION 'hermes_expense_income_flow_body_drift: public.hermes_expense_system_flow_v1(text,text)'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION public.hermes_expense_system_flow_v1(p_text text,p_rule_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path='' AS $fn$
  -- Khoản CHI thuộc luồng hệ thống (nghiệm thu 24/10; lượt 15 thêm khoản THU): chỉ lập ở màn gốc trên web, không lập / sửa thành phiếu chi tay qua bot. Nhận theo
  -- rule_key của danh mục chuẩn (20261003151608) hoặc theo CỤM TỪ trên chữ đã bỏ dấu (hermes_name_fold_v1). Không dùng từ đơn bỏ dấu vì
  -- trùng nghĩa: "coc" = cọc / cốc, "luong" = lương / lượng (số lượng, chất lượng), "hoan tien" = hoàn cho khách / hoàn tạm ứng nhân viên;
  -- đặt cọc cho thợ / nhà cung cấp là khoản chi thật, không chặn. Trả {flow, link} (link = màn gốc) hoặc NULL.
  SELECT CASE WHEN x.flow IS NOT NULL THEN jsonb_build_object('flow',x.flow,'link',CASE x.flow WHEN 'commission' THEN '/contracts'
      WHEN 'liquidation' THEN '/contracts' WHEN 'deposit' THEN '/deposits' WHEN 'salary' THEN '/finance/salary'
      WHEN 'profit_share' THEN '/finance/shareholder-profit' WHEN 'income' THEN '/income-expense' ELSE '/finance/cashbooks' END) END
  FROM (SELECT CASE
      -- rule_key xét TRƯỚC chữ: tên / nhóm có thể mang chữ của luồng khác (nhóm "Trả lại khách" của "Bổ sung hoàn cọc").
      WHEN p_rule_key IN ('hoa_hong_moi_gioi','hhmg','thuong_nong_sale') THEN 'commission'
      WHEN p_rule_key='tra_tien_thua_khach' THEN 'liquidation'
      WHEN p_rule_key='bo_sung_hoan_coc' THEN 'deposit'
      WHEN p_rule_key IN ('luong_quan_ly','ung_luong','luong_dieu_hanh') THEN 'salary'
      WHEN p_rule_key='chia_loi_nhuan' THEN 'profit_share'
      WHEN p_rule_key='noi_bo' THEN 'internal'
      -- Hoa hồng / thưởng sale: phiếu tạo từ hợp đồng hoặc form cọc.
      WHEN s.f ~ '\m(hoa hong|hhmg|thuong nong|thuong sale|moi gioi)\M' THEN 'commission'
      -- Thanh lý, trả lại tiền thừa / tiền phòng cho khách (cặp phiếu thanh lý; "khách sạn" không phải khách thuê).
      WHEN s.f ~ '\m(thanh ly|tien thua|tien thoi|thoi tien|thoi lai|dong du|dong thua|hoan tien phong)\M'
        OR s.f ~ '\m(tra lai|hoan lai|hoan tra|hoan tien|tra tien|tra) (tien )?(lai )?(cho )?(khach|nguoi thue)\M(?! san)' THEN 'liquidation'
      -- Cọc của khách thuê: hoàn / trả / bỏ / mất / cấn / bổ sung cọc, cọc phòng / giữ chỗ.
      WHEN s.f ~ '\m(hoan|tra|tra lai|bo|mat|can|bo sung|bu|boi thuong|tach) (tien )?coc\M'
        OR s.f ~ '\mcoc (giu cho|phong|khach|hop dong|hd|nha)\M' OR s.f ~ '\mgiu cho\M' THEN 'deposit'
      -- Lương: chi qua bảng lương.
      WHEN s.f ~ '\m(tien|tra|ung|tam ung|chi|bang|phat|quy|tang|thanh toan) luong\M'
        OR s.f ~ '\mluong (thang|quan ly|nhan vien|dieu hanh|cung|co ban|sale|ky|nv|ql|t[0-9]+|[0-9]+)\M' THEN 'salary'
      WHEN s.f ~ '\m(chia loi nhuan|loi nhuan co dong|co tuc)\M' THEN 'profit_share'
      -- Chuyển tiền nội bộ / bàn giao tiền giữa các sổ.
      WHEN s.f ~ '\m(chuyen noi bo|chuyen tien noi bo|ban giao tien|chuyen quy)\M' THEN 'internal'
      -- Lượt 15 (nghiệm thu C3d: "thu 200k giữ xe" đi đường phiếu CHI): thu cọc là luồng cọc; khoản THU khác lập ở trang Thu chi (phiếu thu
      -- lập tay không qua bot). Chữ bỏ dấu "thu" trùng thứ / thử / thủ / thư / thù ⇒ chỉ cụm có ngữ cảnh: ĐẦU nội dung "tiền / khoản / phiếu
      -- thu" (trừ thủ tục, thù lao, thủ quỹ, thu hộ, thu gom, thu mua, thu âm…), "thu tiền", "thu <số tiền>" (có đơn vị hoặc ≥ 3 chữ số:
      -- "thứ 7" không dính), "thu phí / nợ / lãi / giữ xe / rác / điện / nước…"; hoặc "thu … giữ xe / rác / điện nước … của khách / phòng"
      -- (không sau "chi" / "phí", không phải thu gom / hộ / mua / âm / lao). "thu chi …", "hoàn tác thu tiền", "phí thu hộ" không dính.
      WHEN s.f ~ '\mthu (tien )?coc\M' THEN 'deposit'
      WHEN s.f ~ '^ (tien|khoan|phieu) thu (?!(tuc|cong|lao|quy|kho|ky|vien|y|nghiem|am|mua|gom|ho|thuat|tuong|cung|moi|tu|dong|ong|chi)( |$))'
        OR s.f ~ '^ thu tien ' OR s.f ~ '^ thu ([0-9]{3,}|[0-9]+ ?(k|tr|trieu|nghin|ngan|d|dong|vnd)|[0-9]+ [0-9]+ ?(k|tr|trieu)) '
        OR s.f ~ '^ thu (phi|no|lai|giu xe|gui xe|xe|rac|dien|nuoc|phong|internet|wifi|mang|dich vu|ve sinh|hoi tien) '
        OR (s.f ~ ' thu( [a-z0-9]+){0,3} (giu xe|gui xe|rac|dien nuoc|dien|nuoc|internet|wifi|phong|dich vu|ve sinh) (.* )?(cua|tu) (khach|nguoi thue|phong|p ?[0-9]+) '
          AND s.f !~ ' (chi|phi) thu | thu (gom|ho|mua|am|lao|chi) ') THEN 'income'
    END flow FROM (SELECT ' '||regexp_replace(public.hermes_name_fold_v1(p_text),'[^a-z0-9]+',' ','g')||' ' f) s) x
$fn$;

ALTER FUNCTION public.hermes_expense_system_flow_v1(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_expense_system_flow_v1(text,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_expense_system_flow_v1(text,text) TO authenticated;

DO $assert$
DECLARE v_fn pg_catalog.pg_proc; c record;
BEGIN
  SELECT * INTO v_fn FROM pg_catalog.pg_proc WHERE oid='public.hermes_expense_system_flow_v1(text,text)'::regprocedure;
  IF md5(replace(v_fn.prosrc,chr(13),''))<>'ea545bc265ddddf221ba1abdeb55d814' OR v_fn.prosecdef OR v_fn.provolatile<>'i'
    OR replace(COALESCE(array_to_string(v_fn.proconfig,','),''),'"','')<>'search_path='
    OR NOT has_function_privilege('authenticated','public.hermes_expense_system_flow_v1(text,text)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_expense_system_flow_v1(text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes_expense_income_flow_contract_violated'; END IF;
  FOR c IN SELECT * FROM (VALUES ('Thu 200k giữ xe','income'),('thu 200.000 giữ xe tháng 10','income'),('tiền thu giữ xe phòng 201','income'),('Khoản thu điện nước tháng 10','income'),('thu tiền rác tháng 10','income'),('thu phí giữ xe','income'),('thu 2tr tiền phòng','income'),('đã thu 150k giữ xe của khách P201','income'),('thu tiền cọc phòng 101','deposit'),('Phiếu thu tiền internet','income')) v(t,f) LOOP
    IF public.hermes_expense_system_flow_v1(c.t)->>'flow' IS DISTINCT FROM c.f
      OR public.hermes_expense_system_flow_v1(c.t)->>'link' IS DISTINCT FROM (CASE c.f WHEN 'income' THEN '/income-expense' ELSE '/deposits' END) THEN
      RAISE EXCEPTION 'hermes_expense_income_flow_miss: %',c.t; END IF;
  END LOOP;
  FOR c IN SELECT * FROM (VALUES ('chi thu gom rác'),('phí thu hộ tiền điện'),('tiền thuê nhà tháng 10'),('mua thuốc diệt côn trùng'),('mua thùng rác'),('thu âm quảng cáo'),('tiền thù lao CTV'),('tiền thủ tục tạm trú'),('thứ 7 mua nước uống'),('thử máy bơm nước'),('thu chi điện lạnh - vệ sinh máy lạnh'),('Hoàn tác thu tiền'),('anh A lấy lại tiền mặt 7 phòng thu hộ'),('Thưởng deal chương trình - deal thứ 3'),('thu gom rác tháng 10'),('thu mua phế liệu'),('Kết sổ quỹ chị Thu T5 + T6'),('nộp tiền điện nước đã thu của khách cho EVN'),('chi thu gom rác phòng của khách')) v(t) LOOP
    IF public.hermes_expense_system_flow_v1(c.t) IS NOT NULL THEN RAISE EXCEPTION 'hermes_expense_income_flow_false_hit: %',c.t; END IF;
  END LOOP;
  -- Nhánh cũ còn nguyên (mẫu của 094809).
  IF public.hermes_expense_system_flow_v1('hoàn cọc phòng 101')->>'flow' IS DISTINCT FROM 'deposit'
    OR public.hermes_expense_system_flow_v1('tra lai tien thua cho khach')->>'flow' IS DISTINCT FROM 'liquidation'
    OR public.hermes_expense_system_flow_v1('chi hoa hồng môi giới')->>'flow' IS DISTINCT FROM 'commission'
    OR public.hermes_expense_system_flow_v1('tiền lương tháng 10')->>'flow' IS DISTINCT FROM 'salary'
    OR public.hermes_expense_system_flow_v1('mua cốc nhựa') IS NOT NULL OR public.hermes_expense_system_flow_v1(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'hermes_expense_income_flow_old_branches_changed'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
