-- Đợt 2, Gói Z (tích hợp, 18/10/2026): bản cuối của bốn hàm dùng chung CRM (public.*, INVOKER, search_path rỗng) sau soát
-- lại và theo web main #209. File riêng, nội dung không nhắc trợ lý (như hàm dùng chung của các gói: B 20261018020050/020250,
-- D 20261018040200). Áp SAU mọi file gói (2026101801xxxx … 2026101804xxxx), TRƯỚC hàm đọc sửa tích hợp (080100 … 080300) và
-- công tắc 20261018090000. CREATE OR REPLACE giữ chữ ký, kiểu trả về và ACL (các gói đã REVOKE PUBLIC/anon/service_role, GRANT
-- authenticated); không DROP, không GRANT/REVOKE, không ghi dữ liệu. Thân = bản trước của gói + chỗ đổi nêu ở từng hàm.
-- Kiểm: wave2-z-a/c/d.test.mjs (đột biến về thân cũ), wave2-z.test.mjs (khuôn), check-hermes-web-parity.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- 1. Thu tiền theo kỳ (thân = 20261018010000): theo web #209 (useCollectionReport.ts lọc reversed_at ngay sau khi tải) — khoản
--    thu đã hoàn tác không còn là tiền đã thu: bỏ khỏi đã thu theo ngày/khoảng, paidUpTo, paidAsOf (payments reversed_at IS NULL).
CREATE OR REPLACE FUNCTION public.thu_tien_collection_v1(p_organization_id uuid,p_billing_month text,p_from date,p_to date,p_today date,
  p_building_ids uuid[] DEFAULT NULL)
RETURNS TABLE(invoice_id uuid,invoice_number text,invoice_status text,building_id uuid,building_name text,building_sort text,room_id uuid,
  room_name text,room_sort text,contract_id uuid,customer_id uuid,customer_name text,total_amount numeric,paid_amount numeric,
  remaining_amount numeric,collect_status text,time_mode text,collected_in_range numeric,in_scope boolean,status_paid boolean,
  status_unpaid boolean,summary_collected numeric,summary_paid boolean,summary_due boolean,summary_remaining numeric,collectors text[])
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
DECLARE v_b uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('thu_tien','view',b.id);
  RETURN QUERY
  WITH win AS (SELECT CASE WHEN p_from IS NULL AND p_to IS NULL THEN 'all'
      WHEN COALESCE(p_from,p_to)=p_today AND COALESCE(p_to,p_from)=p_today THEN 'today' ELSE 'date' END mode,
    LEAST(COALESCE(p_from,p_to),COALESCE(p_to,p_from)) lo,GREATEST(COALESCE(p_from,p_to),COALESCE(p_to,p_from)) hi),
  base AS (
    SELECT i.id,i.invoice_number,i.status::text status,i.building_id,i.room_id,i.contract_id,COALESCE(i.total_amount,0) total,
      COALESCE(i.paid_amount,0) paid,COALESCE(i.remaining_amount,COALESCE(i.total_amount,0)-COALESCE(i.paid_amount,0)) rem,
      w.mode,w.lo,w.hi,pay.sum_range,pay.has_range,pay.paid_upto,pay.all_before
    FROM public.invoices i CROSS JOIN win w
    CROSS JOIN LATERAL (SELECT COALESCE(sum(p.amount) FILTER (WHERE p.payment_date BETWEEN w.lo AND w.hi),0) sum_range,
        count(*) FILTER (WHERE p.payment_date BETWEEN w.lo AND w.hi)>0 has_range,
        COALESCE(sum(p.amount) FILTER (WHERE p.payment_date<=w.hi),0) paid_upto,
        COALESCE(bool_and(COALESCE(p.payment_date<=w.hi,false)),true) all_before
      FROM public.payments p WHERE p.invoice_id=i.id AND p.reversed_at IS NULL) pay
    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND i.billing_month=p_billing_month
      AND i.building_id=ANY(v_b)),
  flags AS (
    SELECT b.*,(b.status='PAID' OR b.rem<=0) is_paid,
      (b.paid_upto>=b.total OR ((b.status='PAID' OR b.rem<=0) AND b.all_before)) paid_as_of
    FROM base b),
  scoped AS (
    SELECT f.*,CASE WHEN f.mode='today' THEN NOT f.is_paid ELSE NOT f.paid_as_of END owes FROM flags f)
  SELECT s.id,s.invoice_number,s.status,s.building_id,bd.name,bd.name_sort,s.room_id,r.name,r.name_sort,s.contract_id,cu.id,cu.full_name,
    s.total,s.paid,s.rem,
    CASE WHEN s.is_paid THEN 'paid' WHEN s.status='PARTIAL_PAID' OR s.paid>0 THEN 'partial' ELSE 'unpaid' END,
    s.mode,CASE WHEN s.mode='all' THEN NULL ELSE s.sum_range END,
    s.mode='all' OR s.has_range OR s.owes,
    CASE WHEN s.mode='all' THEN s.is_paid ELSE s.has_range END,
    CASE WHEN s.mode='all' THEN NOT s.is_paid ELSE s.owes AND NOT s.has_range END,
    CASE WHEN s.mode='all' THEN s.paid ELSE s.sum_range END,
    CASE WHEN s.mode='all' THEN s.is_paid ELSE s.has_range END,
    CASE WHEN s.mode='all' THEN NOT s.is_paid ELSE NOT s.has_range AND s.owes END,
    CASE WHEN s.mode='all' THEN CASE WHEN s.is_paid THEN 0 ELSE GREATEST(0,s.rem) END
      WHEN s.has_range OR NOT s.owes THEN 0
      WHEN s.mode='today' THEN GREATEST(0,s.rem)
      WHEN s.paid_as_of THEN 0 ELSE GREATEST(0,s.total-s.paid_upto) END,
    (SELECT array_agg(n.name ORDER BY n.first_at,n.name) FROM (
       SELECT DISTINCT ON (lower(btrim(ie.creator_name))) btrim(ie.creator_name) name,ie.created_at first_at
       FROM public.income_expenses ie
       WHERE ie.invoice_id=s.id AND ie.organization_id=p_organization_id AND ie.type='INCOME' AND ie.approval_status='APPROVED'
         AND ie.deleted_at IS NULL AND ie.payment_id IS NOT NULL AND btrim(COALESCE(ie.creator_name,''))<>''
       ORDER BY lower(btrim(ie.creator_name)),ie.created_at) n)
  FROM scoped s
  LEFT JOIN public.buildings bd ON bd.id=s.building_id
  LEFT JOIN public.rooms r ON r.id=s.room_id
  LEFT JOIN LATERAL (SELECT cc.customer_id FROM public.contract_customers cc WHERE cc.contract_id=s.contract_id
    ORDER BY cc.is_representative DESC,cc.created_at,cc.id LIMIT 1) rep ON true
  LEFT JOIN public.customers cu ON cu.id=rep.customer_id AND cu.organization_id=p_organization_id;
END $fn$;

-- 2. Hộp thông báo (thân = 20261018030100): theo web #209 (useNotifications.ts inboxScope) — đã chọn công ty thì chỉ thông báo
--    của ĐÚNG công ty đó (mọi dòng mang organization_id, trigger autofill_org_strict); bỏ nhánh "dòng chưa gắn công ty".
CREATE OR REPLACE FUNCTION public.notifications_inbox_v1(p_organization_id uuid,p_unread_only boolean DEFAULT false,
  p_type text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS TABLE(id uuid,type text,subject text,content text,status text,created_at timestamptz,total_count bigint,unread_count bigint)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR NOT public.can_access_org_entity('notifications','view')
    THEN RAISE EXCEPTION 'notifications_inbox_denied' USING ERRCODE='42501'; END IF;
  IF p_organization_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 2000
    THEN RAISE EXCEPTION 'notifications_inbox_invalid' USING ERRCODE='22023'; END IF;
  RETURN QUERY
  SELECT n.id,n.type::text,n.subject,n.content,n.status::text,n.created_at,count(*) OVER (),
    count(*) FILTER (WHERE n.status::text='PENDING') OVER ()
  FROM public.notifications n
  WHERE n.user_id=auth.uid() AND n.channel::text='IN_APP'
    AND n.organization_id=p_organization_id
    AND (NOT COALESCE(p_unread_only,false) OR n.status::text='PENDING')
    AND (p_type IS NULL OR n.type::text=p_type)
  ORDER BY n.created_at DESC,n.id DESC
  LIMIT p_limit;
END $fn$;

-- 3. Loại thu chi (thân = 20261018040000), thứ tự khử trùng trong mỗi (loại, tên): hàng của công ty thắng hàng dùng chung
--    (organization_id NULL — lớp đọc bỏ hàng dùng chung và đếm riêng, nên hàng dùng chung cũ hơn từng làm mất hạng mục cùng tên
--    của công ty); rồi dòng của CHÍNH người gọi so bằng IS TRUE ("= auth.uid()" ra NULL với user_id NULL và DESC xếp NULL lên
--    đầu; web: ownershipRank). Khác web có chủ ý ở điểm đầu (web-parity w2d-ie-types).
CREATE OR REPLACE FUNCTION public.income_expense_types_list_v1(p_organization_id uuid,p_type text DEFAULT NULL)
RETURNS TABLE(type_id uuid,type text,name text,category text,description text,is_default boolean,system_only boolean,manual_hidden boolean,
  quick_entry_hidden boolean,archived boolean,sort_order integer,is_restricted boolean,rule_key text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;
  -- Khoá web của màn (RequirePermission categories) khi web gọi thẳng; Hermes đã qua cổng.
  IF NOT COALESCE(public.can_access_org_entity('categories','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT x.id,x.type,x.name,x.category,x.description,x.is_default,x.system_only,x.manual_hidden,x.quick_entry_hidden,x.archived,x.sort_order,
    x.is_restricted,x.rule_key,x.organization_id
  FROM (SELECT DISTINCT ON (t.type,lower(btrim(t.name))) t.id,t.type,t.name,t.category,t.description,t.is_default,t.system_only,t.manual_hidden,
      t.quick_entry_hidden,t.archived_at IS NOT NULL archived,t.sort_order,t.is_restricted,t.rule_key,t.organization_id
    FROM public.income_expense_types t
    WHERE (t.organization_id IS NULL OR t.organization_id=p_organization_id) AND (p_type IS NULL OR t.type=p_type)
    ORDER BY t.type,lower(btrim(t.name)),(t.organization_id IS NOT NULL) DESC,(t.user_id=auth.uid()) IS TRUE DESC,t.created_at,t.id) x
  ORDER BY x.archived,x.type='income',x.category NULLS LAST,x.sort_order NULLS LAST,x.name,x.id;
END $fn$;

-- 4. Làm sạch chữ (B 20261018020050 → 020250 và D 20261018040000 → 040200 cùng tạo, thân khác nhau ở điều kiện vai; theo thứ tự
--    áp bản D đè bản B): chốt MỘT bản — điều kiện chặt hơn của D (current_user = authenticated VÀ có auth.uid()), thông báo lỗi
--    trung tính; phép làm sạch giữ nguyên từng chữ. Hàng rào gói chỉ nhận hàm hai gói cùng định nghĩa khi bản cuối ở dải Z.
CREATE OR REPLACE FUNCTION public.report_text_v1(p_text text,p_max integer)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'report_text_denied' USING ERRCODE='42501'; END IF;
  IF p_text IS NULL THEN RETURN NULL; END IF;
  RETURN left(btrim(regexp_replace(
    translate(replace(p_text,chr(13)||chr(10),chr(10)),chr(13)||chr(8232)||chr(8233),chr(10)||chr(10)||chr(10)),
    '[\x01-\x09\x0b-\x1f\x7f-\x9f]','','g'),' '||chr(10)),GREATEST(COALESCE(p_max,0),0));
END $fn$;

ALTER FUNCTION public.thu_tien_collection_v1(uuid,text,date,date,date,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.notifications_inbox_v1(uuid,boolean,text,integer) OWNER TO postgres;
ALTER FUNCTION public.income_expense_types_list_v1(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.report_text_v1(text,integer) OWNER TO postgres;
COMMIT;
NOTIFY pgrst,'reload schema';
