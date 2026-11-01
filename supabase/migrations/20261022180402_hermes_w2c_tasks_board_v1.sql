-- Hermes đọc đầy đủ — ĐỢT 2, Gói C, sửa SAU phát hành (Đợt 2b Công việc — Mốc 4, 23/10/2026; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md
-- mục 4, 21): báo cáo tasks_board — bảng việc như trang /tasks: trạng thái (IN_PROGRESS / COMPLETED / OVERDUE), trục ngày (hạn / ngày tạo /
-- ngày xong) + fromDate/toDate, chữ tìm (mã, tiêu đề, TÊN NGƯỜI NHẬN bỏ dấu), toà/phòng, người nhận; mỗi hàng có loại, người nhận, người
-- giao, hạn (giờ công ty), số ngày quá hạn, tiến độ (300 ký tự đầu), ngày tạo/xong, link; summary đếm tổng / quá hạn / theo người nhận /
-- theo toà trên CẢ tập khớp. Câu hỏi đo được (ma trận Công việc CV-R09): "tuần này xong bao nhiêu việc, ai làm nhiều nhất" = status=COMPLETED
-- + kind=completed + fromDate thứ Hai.
-- Khoá tasks.view (khoá đợt 1 dùng lại — 20261022180359_hermes_w2_tasks_view_reused_v1); phạm vi rls_buildings (toà công ty ∩ phạm vi kết
-- nối, RLS jobs của người hỏi quyết từng việc — như web, kể cả Q35). Nguồn: hàm dùng chung public.jobs_board_v1 (20261022180400).
-- Thay thân hai hàm của gói (cùng chữ ký, cùng ACL): catalog = bản production 20261018030200 (md5 7f22e35e…), hàm đọc = bản production
-- 20261019040948 (md5 86935674…; chuỗi file của fixture đợt 2 dừng ở 20261018030600, md5 a0ad606e…, cũng nhận để test chạy
-- trên đúng thân này), thêm đúng một mục catalog và một nhánh đọc. Không DROP, không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_w2c_read_v1(text,jsonb,jsonb)') IS NULL OR to_regprocedure('app_private.hermes_w2c_catalog_v1()') IS NULL
    OR to_regprocedure('public.jobs_board_v1(uuid,uuid[],boolean,text,text,date,date,text,uuid,uuid)') IS NULL
    OR to_regprocedure('public.safe_text_v1(text,integer)') IS NULL
    OR NOT ('tasks.view'=ANY(app_private.hermes_w2_reused_keys_v1())) THEN
    RAISE EXCEPTION 'hermes_w2c_tasks_board_dependency_invalid'; END IF;
  -- Ghim thân đang chạy: thân production + TEST đo 23/10/2026 (hai môi trường trùng nhau), thân cuối của chuỗi file đợt 2 (fixture), hoặc
  -- chính thân của file này (chạy lại). Thân khác (một bản vá khác đã thay hàm) ⇒ dừng thay vì đè mất vá.
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2c_catalog_v1()')),'')
      NOT IN ('7f22e35e2fd496cb701d57c0be1f0a24','94fa8ed89e4f610f848503335aa725cd') THEN
    RAISE EXCEPTION 'hermes_w2c_tasks_board_body_drift: app_private.hermes_w2c_catalog_v1'; END IF;
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2c_read_v1(text,jsonb,jsonb)')),'')
      NOT IN ('869356745d14144b0cc92f1255f2871f','a0ad606e4ad20cdc0c647239f9fa9117','fa171ca8eb10cf7048b686b0f44b1c95') THEN
    RAISE EXCEPTION 'hermes_w2c_tasks_board_body_drift: app_private.hermes_w2c_read_v1'; END IF;
END $requires$;

-- 1. Bảng báo cáo gói C (khớp W2C_REPORTS của infra/hermes-broker/wave2-c-contract.mjs; test so khớp): bản production + tasks_board.
CREATE OR REPLACE FUNCTION app_private.hermes_w2c_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT jsonb_build_object(
  'vehicles',jsonb_build_object('permission','vehicles.view','source','crm.vehicles_list_v1','scope','rows',
    'params',jsonb_build_array('query','kind','buildingId','roomId','customerId'),'required','[]'::jsonb,'statuses',NULL,
    'kinds',jsonb_build_array('MOTORBIKE','ELECTRIC_BIKE','BICYCLE','CAR','OTHER'),'scopeKeys',jsonb_build_array('customers.view')),
  'materials',jsonb_build_object('permission','materials.view','source','crm.materials_items_v1','scope','organization',
    'params',jsonb_build_array('query','categoryId','lowStock'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'material_categories',jsonb_build_object('permission','materials.view','source','crm.materials_categories_v1','scope','organization',
    'params','[]'::jsonb,'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'material_purchases',jsonb_build_object('permission','materials.view','source','crm.materials_purchases_v1','scope','organization',
    'params',jsonb_build_array('fromDate','toDate','supplierId'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,
    'scopeKeys',jsonb_build_array('suppliers.view')),
  'material_usages',jsonb_build_object('permission','materials.view','source','crm.materials_usages_v1','scope','organization',
    'params',jsonb_build_array('fromDate','toDate'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys',jsonb_build_array('tasks.view')),
  'material_adjustments',jsonb_build_object('permission','materials.view','source','crm.materials_adjustments_v1','scope','organization',
    'params',jsonb_build_array('fromDate','toDate','kind'),'required','[]'::jsonb,'statuses',NULL,'kinds',jsonb_build_array('IN','OUT'),
    'scopeKeys','[]'::jsonb),
  'warehouses',jsonb_build_object('permission','warehouses.view','source','crm.warehouses_list_v1','scope','rows',
    'params',jsonb_build_array('query','buildingId'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'notifications',jsonb_build_object('permission','notifications.view','source','crm.notifications_inbox_v1','scope','self',
    'params',jsonb_build_array('unreadOnly','kind'),'required','[]'::jsonb,'statuses',NULL,
    'kinds',jsonb_build_array('NEW_INVOICE','PAYMENT_REMINDER','OVERDUE_INVOICE','CONTRACT_EXPIRING','ISSUE_RESOLVED','GENERAL_ANNOUNCEMENT',
      'CUSTOM','DEPOSIT_SHORTFALL','SALARY_BONUS','ACTION_REQUIRED','APPROVAL_RESULT'),'scopeKeys','[]'::jsonb),
  'my_salary',jsonb_build_object('permission','assistant.salary.self','source','crm.salary_locked_month_v1','scope','self',
    'params',jsonb_build_array('month','kind'),'required',jsonb_build_array('month'),'statuses',NULL,'kinds',jsonb_build_array('adjustments','ledger'),
    'scopeKeys','[]'::jsonb),
  'salary_month',jsonb_build_object('permission','salary.view','source','crm.salary_locked_month_v1','scope','organization',
    'params',jsonb_build_array('month','staffId'),'required',jsonb_build_array('month'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'network_fleet',jsonb_build_object('permission','network_center.view','source','crm.network_center_list_fleet_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required','[]'::jsonb,'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'network_building',jsonb_build_object('permission','network_center.view','source','crm.network_center_get_building_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required',jsonb_build_array('buildingId'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'network_ports',jsonb_build_object('permission','network_center.view','source','crm.network_center_get_building_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required',jsonb_build_array('buildingId'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'network_clients',jsonb_build_object('permission','network_center.view','source','crm.network_center_list_clients_v1','scope','rows',
    'params',jsonb_build_array('buildingId','query'),'required',jsonb_build_array('buildingId'),'statuses',NULL,'kinds',NULL,
    'scopeKeys',jsonb_build_array('customers.view')),
  'network_aruba',jsonb_build_object('permission','network_center.view','source','crm.network_center_list_aruba_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required',jsonb_build_array('buildingId'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'network_h196a',jsonb_build_object('permission','network_center.view','source','crm.network_center_list_h196a_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required',jsonb_build_array('buildingId'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'network_commands',jsonb_build_object('permission','network_center.view','source','crm.network_center_list_commands_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required',jsonb_build_array('buildingId'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'network_audit',jsonb_build_object('permission','network_center.view','source','crm.network_center_list_audit_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required',jsonb_build_array('buildingId'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'network_backups',jsonb_build_object('permission','network_center.view','source','crm.network_center_get_building_v1','scope','rows',
    'params',jsonb_build_array('buildingId'),'required',jsonb_build_array('buildingId'),'statuses',NULL,'kinds',NULL,'scopeKeys','[]'::jsonb),
  'network_config_diff',jsonb_build_object('permission','network_center.view','source','crm.network_center_compare_snapshots_v1','scope','rows',
    'params',jsonb_build_array('buildingId','fromId','toId'),'required',jsonb_build_array('buildingId','fromId','toId'),'statuses',NULL,'kinds',NULL,
    'scopeKeys','[]'::jsonb),
   'tasks_board',jsonb_build_object('permission','tasks.view','source','crm.jobs_board_v1','scope','rls_buildings',
     'params',jsonb_build_array('query','status','kind','fromDate','toDate','buildingId','roomId','staffId'),'required','[]'::jsonb,
     'statuses',jsonb_build_array('IN_PROGRESS','COMPLETED','OVERDUE'),'kinds',jsonb_build_array('deadline','created','completed'),'scopeKeys','[]'::jsonb))
$fn$;

-- 2. Hàm đọc gói C (INVOKER; GIỮ dòng đầu của khung): bản production + nhánh tasks_board.
CREATE OR REPLACE FUNCTION app_private.hermes_w2c_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_uid uuid:=auth.uid(); v_org uuid; v_buildings uuid[]; v_customers uuid[]; v_rows jsonb; v_total bigint; v_extra numeric;
  v_from date; v_to date; v_month date; v_ceiling date; v_overrides jsonb; v_value jsonb; v_row record; v_summary jsonb; v_staff uuid[];
  v_admin boolean; v_locked bigint; v_building uuid; v_payload jsonb; v_items jsonb:='[]'::jsonb; v_page jsonb; v_capped boolean:=false;
  v_query text; i integer; v_at timestamptz; v_id uuid; v_sort integer; v_building_org uuid;
BEGIN
  IF current_user<>'authenticated' OR v_uid IS NULL OR p_ctx->>'userId' IS DISTINCT FROM v_uid::text OR p_ctx->>'report' IS DISTINCT FROM p_report
    OR jsonb_typeof(p_ctx->'organizationId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_ctx->'buildings') IS DISTINCT FROM 'array'
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid;
  v_buildings:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_ctx->'buildings') x);
  v_from:=(p_params->>'fromDate')::date; v_to:=(p_params->>'toDate')::date;

  -- Mốc 4 Công việc (20261022180402; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 4, 21): bảng việc như /tasks, dưới RLS jobs của
  -- người hỏi qua hàm dùng chung public.jobs_board_v1 (phạm vi rls_buildings: toà công ty ∩ phạm vi kết nối; RLS quyết từng việc, kể cả
  -- việc giao cho chính người hỏi ở toà ngoài khoá tasks.view — Q35). Hàng tối đa 2000 theo thứ tự ổn định (đang làm trước, quá hạn
  -- trước, hạn sớm trước, rồi việc xong gần nhất); tóm tắt trên CẢ tập khớp: tổng, quá hạn, theo người nhận (≤20) và theo toà (≤50),
  -- nhiều việc trước — mô hình đọc số ở đây, không tự cộng các trang.
  IF p_report='tasks_board' THEN
    WITH b AS MATERIALIZED (SELECT * FROM public.jobs_board_v1(v_org,v_buildings,p_ctx->'orgWide'='true'::jsonb,p_params->>'status',
        p_params->>'kind',v_from,v_to,p_params->>'query',(p_params->>'roomId')::uuid,(p_params->>'staffId')::uuid)),
      o AS (SELECT b.*,row_number() OVER (ORDER BY (b.status='IN_PROGRESS') DESC,b.overdue DESC,b.deadline NULLS LAST,
        b.completion_time DESC NULLS LAST,b.job_id) rn FROM b)
    SELECT (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.job_id,'code',public.safe_text_v1(o.code,60),'title',public.safe_text_v1(o.title,200),
          'jobType',public.safe_text_v1(o.job_type,100),'buildingId',o.building_id,'buildingName',public.safe_text_v1(o.building_name,200),
          'roomId',o.room_id,'roomName',public.safe_text_v1(o.room_name,100),'assigneeId',o.assignee_id,
          'assigneeName',public.safe_text_v1(o.assignee_name,200),'assignerName',public.safe_text_v1(o.assigner_name,200),'status',o.status,
          'deadline',o.deadline_local,'overdueDays',o.overdue_days,'progress',public.safe_text_v1(o.progress,300),'createdOn',o.created_on,
          'completedOn',o.completed_on,'link','/tasks?job='||o.job_id::text,'organizationId',o.organization_id) ORDER BY o.rn),'[]'::jsonb)
        FROM o WHERE o.rn<=2000),
      (SELECT count(*) FROM b),
      jsonb_build_object('total',(SELECT count(*) FROM b),'overdue',(SELECT count(*) FROM b WHERE b.overdue),
        'byAssignee',(SELECT COALESCE(jsonb_agg(jsonb_build_object('assigneeName',g.name,'count',g.n,'overdue',g.late)
            ORDER BY g.n DESC,g.name COLLATE "C" NULLS LAST),'[]'::jsonb)
          FROM (SELECT public.safe_text_v1(b.assignee_name,200) name,count(*) n,count(*) FILTER (WHERE b.overdue) late FROM b
            GROUP BY public.safe_text_v1(b.assignee_name,200)
            ORDER BY count(*) DESC,public.safe_text_v1(b.assignee_name,200) COLLATE "C" NULLS LAST LIMIT 20) g),
        'byBuilding',(SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',g.building_id,'buildingName',g.name,'count',g.n,'overdue',g.late)
            ORDER BY g.n DESC,g.building_id NULLS LAST),'[]'::jsonb)
          FROM (SELECT b.building_id,public.safe_text_v1(min(b.building_name),200) name,count(*) n,count(*) FILTER (WHERE b.overdue) late FROM b
            GROUP BY b.building_id ORDER BY count(*) DESC,b.building_id NULLS LAST LIMIT 50) g))
      INTO v_rows,v_total,v_summary;
    RETURN jsonb_build_object('rows',v_rows,'summary',v_summary,'sourceCapped',v_total>2000,'unavailable',NULL);
  END IF;

  -- C1 xe (useVehicles.ts:39-130): toà ctx; tên/SĐT khách ở toà có customers.view của kết nối; xe không gắn toà
  -- chỉ khi toàn công ty.
  IF p_report='vehicles' THEN
    v_customers:=CASE WHEN jsonb_typeof(p_ctx#>'{scopes,customers.view}')='array'
      THEN ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_ctx#>'{scopes,customers.view}') x) ELSE '{}'::uuid[] END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.vehicle_type,'name',public.safe_text_v1(x.vehicle_name,100),
        'plate',public.safe_text_v1(x.license_plate,40),'color',public.safe_text_v1(x.color,60),
        'ownerName',public.safe_text_v1(x.owner_name,200),'ticketNumber',public.safe_text_v1(x.ticket_number,60),
        'parkingFee',COALESCE(x.parking_fee,0)::text,'buildingId',x.building_id,'buildingName',public.safe_text_v1(x.building_name,200),
        'roomId',x.room_id,'roomName',public.safe_text_v1(x.room_name,100),'customerId',x.customer_id,
        'customerName',public.safe_text_v1(x.customer_name,200),'customerPhone',public.safe_text_v1(x.customer_phone,40),
        'organizationId',x.organization_id)
        ORDER BY x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count)
      INTO v_rows,v_total
      FROM public.vehicles_list_core_v1(v_org,v_buildings,v_customers,p_ctx->'orgWide'='true'::jsonb,p_params->>'query',p_params->>'kind',
        (p_params->>'roomId')::uuid,(p_params->>'customerId')::uuid,2000,0,COALESCE(p_ctx->'allowCopiedCustomerText'='true'::jsonb,false)) x;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0)),'sourceCapped',COALESCE(v_total,0)>2000,
      'unavailable',NULL);
  END IF;

  -- C2–C5 kho vật tư (dữ liệu cấp công ty; cổng đã đòi CRM toàn công ty ∩ overlay Toàn tổ chức).
  IF p_report IN ('materials','material_categories','material_purchases','material_usages','material_adjustments') THEN
    IF p_ctx->'orgWide' IS DISTINCT FROM 'true'::jsonb THEN
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','organization_scope_required');
    END IF;
    IF p_report='materials' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'code',public.safe_text_v1(x.code,60),'name',public.safe_text_v1(x.name,200),
          'categoryId',x.category_id,'categoryName',public.safe_text_v1(x.category_name,200),'unit',public.safe_text_v1(x.unit,40),
          'onHand',x.on_hand::text,'reorderLevel',x.reorder_level::text,'lowStock',x.low_stock,'avgUnitCost',x.avg_unit_cost::text,
          'organizationId',x.organization_id)
          ORDER BY x.name,x.id),'[]'::jsonb),max(x.total_count),max(x.low_stock_count)
        INTO v_rows,v_total,v_extra
        FROM public.materials_items_v1(v_org,p_params->>'query',(p_params->>'categoryId')::uuid,COALESCE((p_params->>'lowStock')::boolean,false),2000,0) x;
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0),'lowStock',COALESCE(v_extra,0)::bigint),
        'sourceCapped',COALESCE(v_total,0)>2000,'unavailable',NULL);
    ELSIF p_report='material_categories' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'name',public.safe_text_v1(x.name,200),
          'description',public.safe_text_v1(x.description,500),'materialCount',x.material_count,'organizationId',x.organization_id) ORDER BY x.rn) FILTER (WHERE x.rn<=2000),'[]'::jsonb),
          count(*)
        INTO v_rows,v_total FROM (SELECT c.*,row_number() OVER (ORDER BY c.name,c.id) rn FROM public.materials_categories_v1(v_org) c) x;
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',v_total),'sourceCapped',v_total>2000,'unavailable',NULL);
    ELSIF p_report='material_purchases' THEN
      -- Tên NCC chỉ khi kết nối giữ suppliers.view (RLS suppliers vẫn quyết từng NCC).
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'code',public.safe_text_v1(x.code,60),'date',x.purchase_date,
          'supplierId',x.supplier_id,'supplierName',public.safe_text_v1(x.supplier_name,200),'total',x.total::text,
          'notes',public.safe_text_v1(x.notes,500),'itemCount',x.item_count,'organizationId',x.organization_id,
          'items',(SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l->'materialId','materialName',
              to_jsonb(public.safe_text_v1(l->>'materialName',200)),'unit',to_jsonb(public.safe_text_v1(l->>'unit',40)),
              'quantity',l->>'quantity','unitPrice',l->>'unitPrice','lineTotal',l->>'lineTotal') ORDER BY o),'[]'::jsonb)
            FROM jsonb_array_elements(x.items) WITH ORDINALITY e(l,o)))
          ORDER BY x.purchase_date DESC,x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count),max(x.total_amount)
        INTO v_rows,v_total,v_extra
        FROM public.materials_purchases_v1(v_org,v_from,v_to,(p_params->>'supplierId')::uuid,
          jsonb_typeof(p_ctx#>'{scopes,suppliers.view}')='array',2000,0) x;
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0),'amount',COALESCE(v_extra,0)::text),
        'sourceCapped',COALESCE(v_total,0)>2000,'unavailable',NULL);
    ELSIF p_report='material_usages' THEN
      -- Mã/tên việc chỉ khi việc thuộc toà có tasks.view của kết nối (RLS jobs vẫn quyết).
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'code',public.safe_text_v1(x.code,60),'date',x.usage_date,
          'jobId',x.job_id,'jobCode',public.safe_text_v1(x.job_code,60),'jobTitle',public.safe_text_v1(x.job_title,200),
          'creatorName',public.safe_text_v1(x.creator_name,200),'notes',public.safe_text_v1(x.notes,500),
          'itemCount',x.item_count,'totalQuantity',x.total_quantity::text,'totalCost',x.total_cost::text,'organizationId',x.organization_id,
          'items',(SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l->'materialId','materialName',
              to_jsonb(public.safe_text_v1(l->>'materialName',200)),'unit',to_jsonb(public.safe_text_v1(l->>'unit',40)),
              'quantity',l->>'quantity','unitCost',l->>'unitCost') ORDER BY o),'[]'::jsonb)
            FROM jsonb_array_elements(x.items) WITH ORDINALITY e(l,o)))
          ORDER BY x.usage_date DESC,x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count),max(x.total_cost_sum)
        INTO v_rows,v_total,v_extra
        FROM public.materials_usages_v1(v_org,v_from,v_to,CASE WHEN jsonb_typeof(p_ctx#>'{scopes,tasks.view}')='array'
          THEN ARRAY(SELECT y::uuid FROM jsonb_array_elements_text(p_ctx#>'{scopes,tasks.view}') y) ELSE '{}'::uuid[] END,2000,0) x;
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0),'cost',COALESCE(v_extra,0)::text),
        'sourceCapped',COALESCE(v_total,0)>2000,'unavailable',NULL);
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'code',public.safe_text_v1(x.code,60),'date',x.adjustment_date,
        'type',x.type,'reason',public.safe_text_v1(x.reason,500),'itemCount',x.item_count,'organizationId',x.organization_id,
        'items',(SELECT COALESCE(jsonb_agg(jsonb_build_object('materialId',l->'materialId','materialName',
            to_jsonb(public.safe_text_v1(l->>'materialName',200)),'unit',to_jsonb(public.safe_text_v1(l->>'unit',40)),
            'quantity',l->>'quantity') ORDER BY o),'[]'::jsonb)
          FROM jsonb_array_elements(x.items) WITH ORDINALITY e(l,o)))
        ORDER BY x.adjustment_date DESC,x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count)
      INTO v_rows,v_total
      FROM public.materials_adjustments_v1(v_org,v_from,v_to,p_params->>'kind',2000,0) x;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0)),
      'sourceCapped',COALESCE(v_total,0)>2000,'unavailable',NULL);
  END IF;

  -- C6 kho tài sản: toà ctx; kho không gắn toà chỉ khi toàn công ty.
  IF p_report='warehouses' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'name',public.safe_text_v1(x.name,200),'location',public.safe_text_v1(x.location,300),
        'buildingId',x.building_id,'buildingName',public.safe_text_v1(x.building_name,200),'organizationId',x.organization_id) ORDER BY x.rn) FILTER (WHERE x.rn<=2000),
        '[]'::jsonb),max(x.total_count)
      INTO v_rows,v_total
      FROM (SELECT w.*,row_number() OVER (ORDER BY w.name,w.id) rn
        FROM public.warehouses_list_v1(v_org,v_buildings,p_ctx->'orgWide'='true'::jsonb,p_params->>'query') w) x;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0)),'sourceCapped',COALESCE(v_total,0)>2000,
      'unavailable',NULL);
  END IF;

  -- C9 thông báo của CHÍNH người hỏi (self), công ty của kết nối, trần 200 như trang web.
  IF p_report='notifications' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'type',x.type,'subject',public.safe_text_v1(x.subject,300),
        'content',public.safe_text_v1(x.content,1000),'unread',x.status='PENDING','createdAt',public.utc_instant_v1(x.created_at))
        ORDER BY x.created_at DESC,x.id DESC),'[]'::jsonb),max(x.total_count),max(x.unread_count)
      INTO v_rows,v_total,v_extra
      FROM public.notifications_inbox_v1(v_org,COALESCE((p_params->>'unreadOnly')::boolean,false),p_params->>'kind',200) x;
    IF v_total IS NULL THEN
      -- Bộ lọc không khớp dòng nào: vẫn báo số chưa đọc của cả hộp (badge web).
      SELECT count(*) INTO v_extra FROM public.notifications_inbox_v1(v_org,true,NULL,2000) x;
    END IF;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',COALESCE(v_total,0),'unread',COALESCE(v_extra,0)::bigint),
      'sourceCapped',COALESCE(v_total,0)>200,'unavailable',NULL);
  END IF;

  -- C7/C8 lương: CHỈ tháng ĐÃ CHỐT. Trần tháng nhân viên tự xem (MySalaryPage.tsx:39-41,88; useManagerSalary.ts:639-665;
  -- managerSalary.ts:440-505): tháng hiện tại lùi tối đa 13 tháng, bỏ tháng admin tắt trong salary_staff_months();
  -- không tháng nào mở ⇒ tháng hiện tại.
  IF p_report IN ('my_salary','salary_month') THEN
    v_month:=((p_params->>'month')||'-01')::date;
    v_overrides:=public.salary_staff_months();
    IF jsonb_typeof(v_overrides) IS DISTINCT FROM 'object' THEN v_overrides:='{}'::jsonb; END IF;
    v_ceiling:=date_trunc('month',(p_ctx->>'today')::date)::date;
    FOR i IN 0..13 LOOP
      v_value:=v_overrides->to_char(v_ceiling,'YYYY-MM');
      -- isStaffMonthVisible: có khoá ⇒ !!giá trị (truthy của JS); không khoá ⇒ luôn thấy.
      EXIT WHEN v_value IS NULL OR (CASE jsonb_typeof(v_value) WHEN 'boolean' THEN v_value='true'::jsonb WHEN 'null' THEN false
        WHEN 'number' THEN (v_value#>>'{}')::numeric<>0 WHEN 'string' THEN (v_value#>>'{}')<>'' ELSE true END);
      v_ceiling:=(v_ceiling-interval '1 month')::date;
      IF i=13 THEN v_ceiling:=date_trunc('month',(p_ctx->>'today')::date)::date; END IF;
    END LOOP;
    IF p_report='my_salary' THEN
      -- MySalaryPage áp trần cho mọi người (kể cả admin); chỉ auth.uid().
      IF v_month>v_ceiling THEN
        RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
      END IF;
      SELECT * INTO v_row FROM public.salary_locked_month_v1(v_org,v_month,ARRAY[v_uid]) x WHERE x.staff_id=v_uid;
      IF v_row.staff_id IS NULL OR v_row.status IS DISTINCT FROM 'LOCKED' THEN
        -- Không là quản lý hưởng lương tháng đó, hoặc tháng chưa chốt: web tính ở trình duyệt ⇒ không đoán.
        RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
      END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',l.line_id,'type',l.line_type,'date',l.occurred_date,
          'label',public.safe_text_v1(l.label,300),'detail',public.safe_text_v1(l.detail,300),'amount',l.amount::text) ORDER BY o)
          FILTER (WHERE o<=2000),'[]'::jsonb),count(*)
        INTO v_rows,v_total FROM public.salary_locked_lines_v1(v_org,v_month,v_uid,COALESCE(p_params->>'kind','adjustments'))
          WITH ORDINALITY l(line_id,line_type,occurred_date,label,detail,amount,is_repair,is_contract,o);
      RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('month',p_params->>'month','status',v_row.status,
        'lockedAt',public.utc_instant_v1(v_row.locked_at),'roleTitle',public.safe_text_v1(v_row.role_title,100),
        'baseSalary',v_row.base_salary::text,'workBonus',v_row.work_bonus::text,'contractBonus',v_row.contract_bonus::text,
        'adjustmentsTotal',v_row.adjustments_total::text,'bonus',v_row.bonus_total::text,'investment',v_row.investment_profit::text,
        'commission',v_row.commission_total::text,'grossTotal',v_row.gross_total::text,'advances',v_row.advances_total::text,
        'roomRent',v_row.room_rent::text,'takeHome',v_row.take_home::text,'paid',v_row.paid::text,'remaining',v_row.remaining::text,'lineCount',v_total),
        'sourceCapped',v_total>2000,'unavailable',NULL);
    END IF;
    -- salary_month: dữ liệu cấp công ty (cổng đòi toàn công ty); người không là admin trang lương: chỉ mình, theo trần.
    IF p_ctx->'orgWide' IS DISTINCT FROM 'true'::jsonb THEN
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','organization_scope_required');
    END IF;
    v_admin:=public.salary_is_admin_v1(v_org);
    IF NOT v_admin AND v_month>v_ceiling THEN
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
    END IF;
    v_staff:=CASE WHEN p_params->>'staffId' IS NULL THEN NULL ELSE ARRAY[(p_params->>'staffId')::uuid] END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('staffId',x.staff_id,'name',public.safe_text_v1(x.staff_name,200),
        'roleTitle',public.safe_text_v1(x.role_title,100),'status',x.status,'lockedAt',public.utc_instant_v1(x.locked_at),
        'baseSalary',x.base_salary::text,'bonus',x.bonus_total::text,'investment',x.investment_profit::text,'commission',x.commission_total::text,
        'grossTotal',x.gross_total::text,'advances',x.advances_total::text,'roomRent',x.room_rent::text,'takeHome',x.take_home::text,
        'paid',x.paid::text,'remaining',x.remaining::text,'organizationId',x.organization_id) ORDER BY x.rn) FILTER (WHERE x.rn<=2000),'[]'::jsonb),
      count(*) FILTER (WHERE x.status='LOCKED'),
      jsonb_build_object('month',p_params->>'month','managers',count(*),'locked',count(*) FILTER (WHERE x.status='LOCKED'),
        'notLocked',count(*) FILTER (WHERE x.status<>'LOCKED'),'grossTotal',COALESCE(sum(x.gross_total),0)::text,
        'takeHomeTotal',COALESCE(sum(x.take_home),0)::text,'paidTotal',COALESCE(sum(x.paid),0)::text,
        'remainingTotal',COALESCE(sum(x.remaining),0)::text)
      INTO v_rows,v_locked,v_summary
      FROM (SELECT s.*,row_number() OVER (ORDER BY s.staff_name,s.staff_id) rn FROM public.salary_locked_month_v1(v_org,v_month,v_staff) s) x;
    IF v_locked=0 THEN
      -- Không người nào đã chốt: mọi số của tháng là số tính ở trình duyệt ⇒ không đoán.
      RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
    END IF;
    RETURN jsonb_build_object('rows',v_rows,'summary',v_summary,'sourceCapped',(v_summary->>'managers')::bigint>2000,'unavailable',NULL);
  END IF;

  -- C10–C14 Network Center: RPC của màn web gọi THẲNG (tự kiểm network_center.view theo toà), giữ đúng toà ctx.
  -- Mọi hàng nêu buildingId (báo cáo theo toà). Khách hotspot: RPC web JOIN customers KHÔNG kiểm customers.view; ở đây
-- tên/ID khách chỉ khi khách đọc được dưới
  -- RLS customers của người hỏi VÀ toà có customers.view của kết nối; ID hợp đồng chỉ khi đọc được dưới RLS contracts
  -- và toà đó. Người thực hiện lệnh/nhật ký: chỉ "chính tôi hay không"; không trả JSON result/parameters/target.
  IF p_report='network_fleet' THEN
    v_payload:=public.network_center_list_fleet_v1();
    SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',(item->>'buildingId')::uuid,
        'buildingName',public.safe_text_v1(item->>'buildingName',200),
        'routerIdentity',public.safe_text_v1(item->>'routerIdentity',200),'routerModel',public.safe_text_v1(item->>'routerModel',100),
        'routerosVersion',public.safe_text_v1(item->>'routerosVersion',60),'lifecycleStatus',public.safe_text_v1(item->>'lifecycleStatus',60),
        'healthStatus',public.safe_text_v1(item->>'healthStatus',60),'reachable',COALESCE((item->>'reachable')::boolean,false),
        'lastSeenAt',public.utc_instant_v1((item->>'lastSeenAt')::timestamptz),'cpuPercent',public.json_number_v1(item->'cpuPercent'),
        'memoryUsedBytes',public.json_number_v1(item->'memoryUsedBytes'),'memoryTotalBytes',public.json_number_v1(item->'memoryTotalBytes'),
        'pppoeState',public.safe_text_v1(item->>'pppoeState',60),'connectionCount',public.json_number_v1(item->'connectionCount'),
        'arubaCount',public.json_number_v1(item->'arubaCount'),'openIncidents',public.json_number_v1(item->'openIncidents'),
        'activeClients',public.json_number_v1(item->'activeClients'),'lastBackupAt',public.utc_instant_v1((item->>'lastBackupAt')::timestamptz),
        'uptimePercent',public.json_number_v1(item->'uptimePercent'),'maintenanceActive',COALESCE((item->>'maintenanceActive')::boolean,false),
        'rolloutState',public.safe_text_v1(item->>'rolloutState',60),'organizationId',bo.organization_id) ORDER BY o),'[]'::jsonb)
      INTO v_rows
      FROM jsonb_array_elements(COALESCE(v_payload->'items','[]'::jsonb)) WITH ORDINALITY e(item,o)
      LEFT JOIN public.buildings bo ON bo.id=(item->>'buildingId')::uuid
      WHERE (item->>'buildingId')::uuid=ANY(v_buildings);
    RETURN jsonb_build_object('rows',(SELECT COALESCE(jsonb_agg(t.r ORDER BY t.n),'[]'::jsonb) FROM jsonb_array_elements(v_rows) WITH ORDINALITY t(r,n) WHERE t.n<=2000),'summary',jsonb_build_object('buildings',jsonb_array_length(v_rows),
      'reachable',(SELECT count(*) FROM jsonb_array_elements(v_rows) r WHERE r->'reachable'='true'::jsonb),
      'openIncidents',(SELECT COALESCE(sum((r->>'openIncidents')::numeric),0) FROM jsonb_array_elements(v_rows) r),
      'activeClients',(SELECT COALESCE(sum((r->>'activeClients')::numeric),0) FROM jsonb_array_elements(v_rows) r)),
      'sourceCapped',jsonb_array_length(v_rows)>2000,'unavailable',NULL);
  END IF;
  IF p_report NOT IN ('network_building','network_ports','network_backups','network_clients','network_aruba','network_h196a',
      'network_commands','network_audit','network_config_diff') THEN
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  -- Báo cáo một toà: cổng đã đòi buildingId ∈ phạm vi; kiểm lại ở đây.
  v_building:=(p_params->>'buildingId')::uuid;
  IF v_building IS NULL OR NOT(v_building=ANY(v_buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  -- Công ty của toà từ CỘT buildings.organization_id dưới RLS của người hỏi (RPC Network Center không trả công ty);
  -- toà không đọc được ⇒ NULL ⇒ bước kết thúc từ chối mọi hàng (42501), không chép ctx.
  SELECT bo.organization_id INTO v_building_org FROM public.buildings bo WHERE bo.id=v_building;
  IF p_report IN ('network_building','network_ports','network_backups') THEN
    v_payload:=public.network_center_get_building_v1(v_building);
    IF p_report='network_building' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'title',public.safe_text_v1(item->>'title',300),
          'detail',public.safe_text_v1(item->>'detail',1000),'severity',public.safe_text_v1(item->>'severity',60),
          'status',public.safe_text_v1(item->>'status',60),'openedAt',public.utc_instant_v1((item->>'openedAt')::timestamptz),
          'acknowledgedAt',public.utc_instant_v1((item->>'acknowledgedAt')::timestamptz)) ORDER BY o),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_payload->'incidents','[]'::jsonb)) WITH ORDINALITY e(item,o);
      RETURN jsonb_build_object('rows',(SELECT COALESCE(jsonb_agg(t.r ORDER BY t.n),'[]'::jsonb) FROM jsonb_array_elements(v_rows) WITH ORDINALITY t(r,n) WHERE t.n<=2000),'summary',jsonb_build_object(
        'buildingName',public.safe_text_v1(v_payload->>'buildingName',200),'roomsCount',public.json_number_v1(v_payload->'roomsCount'),
        'rolloutState',public.safe_text_v1(v_payload->>'rolloutState',60),
        'router',CASE WHEN jsonb_typeof(v_payload->'router')='object' THEN jsonb_build_object(
          'identity',public.safe_text_v1(v_payload#>>'{router,identity}',200),'model',public.safe_text_v1(v_payload#>>'{router,model}',100),
          'firmware',public.safe_text_v1(v_payload#>>'{router,firmware}',60),
          'lifecycleStatus',public.safe_text_v1(v_payload#>>'{router,lifecycleStatus}',60),
          'reachable',COALESCE((v_payload#>>'{router,reachable}')::boolean,false),
          'healthStatus',public.safe_text_v1(v_payload#>>'{router,healthStatus}',60),
          'lastSeenAt',public.utc_instant_v1((v_payload#>>'{router,lastSeenAt}')::timestamptz),
          'cpuPercent',public.json_number_v1(v_payload#>'{router,cpuPercent}'),
          'memoryUsedBytes',public.json_number_v1(v_payload#>'{router,memoryUsedBytes}'),
          'memoryTotalBytes',public.json_number_v1(v_payload#>'{router,memoryTotalBytes}'),
          'temperatureC',public.json_number_v1(v_payload#>'{router,temperatureC}'),
          'pppoeState',public.safe_text_v1(v_payload#>>'{router,pppoeState}',60),
          'connectionCount',public.json_number_v1(v_payload#>'{router,connectionCount}')) END,
        'maintenance',CASE WHEN jsonb_typeof(v_payload->'maintenance')='object' THEN jsonb_build_object(
          'reason',public.safe_text_v1(v_payload#>>'{maintenance,reason}',300),
          'status',public.safe_text_v1(v_payload#>>'{maintenance,status}',60),
          'startsAt',public.utc_instant_v1((v_payload#>>'{maintenance,startsAt}')::timestamptz),
          'endsAt',public.utc_instant_v1((v_payload#>>'{maintenance,endsAt}')::timestamptz)) END,
        'changesPaused',CASE WHEN jsonb_typeof(v_payload#>'{settings,changesPaused}')='boolean' THEN v_payload#>'{settings,changesPaused}' END,
        'openIncidents',jsonb_array_length(v_rows),
        'ports',jsonb_array_length(COALESCE(v_payload->'interfaces','[]'::jsonb)),
        'backups',jsonb_array_length(COALESCE(v_payload->'revisions','[]'::jsonb))),
        'sourceCapped',jsonb_array_length(v_rows)>2000,'unavailable',NULL);
    ELSIF p_report='network_ports' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'name',public.safe_text_v1(item->>'name',200),
          'role',public.safe_text_v1(item->>'role',60),'enabled',COALESCE((item->>'enabled')::boolean,false),
          'protected',COALESCE((item->>'protected')::boolean,false),'linkState',public.safe_text_v1(item->>'linkState',60),
          'rxBps',public.json_number_v1(item->'rxBps'),'txBps',public.json_number_v1(item->'txBps'),
          'utilizationPercent',public.json_number_v1(item->'utilizationPercent'),'errors',public.json_number_v1(item->'errors'),
          'discards',public.json_number_v1(item->'discards')) ORDER BY o),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_payload->'interfaces','[]'::jsonb)) WITH ORDINALITY e(item,o);
    ELSE
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'at',public.utc_instant_v1((item->>'capturedAt')::timestamptz),
          'label',public.safe_text_v1(item->>'label',100),'source',public.safe_text_v1(item->>'source',60)) ORDER BY o),'[]'::jsonb)
        INTO v_rows FROM jsonb_array_elements(COALESCE(v_payload->'revisions','[]'::jsonb)) WITH ORDINALITY e(item,o);
    END IF;
    RETURN jsonb_build_object('rows',(SELECT COALESCE(jsonb_agg(t.r ORDER BY t.n),'[]'::jsonb) FROM jsonb_array_elements(v_rows) WITH ORDINALITY t(r,n) WHERE t.n<=2000),'summary',jsonb_build_object('total',jsonb_array_length(v_rows)),
      'sourceCapped',jsonb_array_length(v_rows)>2000,'unavailable',NULL);
  ELSIF p_report='network_clients' THEN
    -- Trang web chỉ xem 100 thiết bị mới nhất (ClientsTab.tsx:28); ở đây đọc tiếp theo con trỏ tới 2000.
    FOR i IN 1..20 LOOP
      v_page:=public.network_center_list_clients_v1(v_building,v_at,v_id,100);
      v_items:=v_items||COALESCE(v_page->'items','[]'::jsonb);
      EXIT WHEN jsonb_typeof(v_page->'nextCursor') IS DISTINCT FROM 'object';
      IF i=20 THEN v_capped:=true; EXIT; END IF;
      v_at:=(v_page#>>'{nextCursor,seenAt}')::timestamptz; v_id:=(v_page#>>'{nextCursor,id}')::uuid;
    END LOOP;
    v_customers:=CASE WHEN jsonb_typeof(p_ctx#>'{scopes,customers.view}')='array'
      THEN ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p_ctx#>'{scopes,customers.view}') x) ELSE '{}'::uuid[] END;
    v_query:=lower(NULLIF(btrim(p_params->>'query'),''));
    SELECT COALESCE(jsonb_agg(shown.r_json ORDER BY shown.o),'[]'::jsonb) INTO v_rows FROM (
      SELECT o,jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'hostname',public.safe_text_v1(item->>'hostname',200),
        'address',public.safe_text_v1(item->>'address',64),'macAddress',public.safe_text_v1(item->>'macAddress',40),
        'randomizedMac',COALESCE((item->>'randomizedMac')::boolean,false),'sessionType',public.safe_text_v1(item->>'sessionType',60),
        'connectionType',public.safe_text_v1(item->>'connectionType',60),'roomHint',public.safe_text_v1(item->>'roomHint',100),
        'roomId',room.id,'customerId',CASE WHEN gate.visible THEN cu.id END,
        'customerName',CASE WHEN gate.visible THEN public.safe_text_v1(cu.full_name,200) END,
        'contractId',CASE WHEN v_building=ANY(v_customers) THEN ct.id END,
        'rxBps',public.json_number_v1(item->'rxBps'),'txBps',public.json_number_v1(item->'txBps'),
        'lastSeenAt',public.utc_instant_v1((item->>'lastSeenAt')::timestamptz)) r_json,
        concat_ws(' ',item->>'hostname',item->>'address',item->>'macAddress',item->>'roomHint',CASE WHEN gate.visible THEN cu.full_name END) haystack
      FROM jsonb_array_elements(v_items) WITH ORDINALITY e(item,o)
      LEFT JOIN public.rooms room ON room.id=(item->>'roomId')::uuid AND room.organization_id=v_org AND room.building_id=v_building
      LEFT JOIN public.customers cu ON cu.id=(item->>'customerId')::uuid AND cu.organization_id=v_org AND cu.deleted_at IS NULL
      LEFT JOIN public.contracts ct ON ct.id=(item->>'contractId')::uuid AND ct.organization_id=v_org
      CROSS JOIN LATERAL (SELECT v_building=ANY(v_customers) AND cu.id IS NOT NULL AS visible) gate
    ) shown WHERE v_query IS NULL OR strpos(lower(shown.haystack),v_query)>0;
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',jsonb_array_length(v_rows),
      'customerNamesShown',v_building=ANY(v_customers)),'sourceCapped',v_capped,'unavailable',NULL);
  ELSIF p_report IN ('network_aruba','network_h196a') THEN
    FOR i IN 1..8 LOOP
      v_page:=CASE p_report WHEN 'network_aruba' THEN public.network_center_list_aruba_v1(v_building,v_sort,v_id,250)
        ELSE public.network_center_list_h196a_v1(v_building,v_sort,v_id,250) END;
      v_items:=v_items||COALESCE(v_page->'items','[]'::jsonb);
      EXIT WHEN jsonb_typeof(v_page->'nextCursor') IS DISTINCT FROM 'object';
      IF i=8 THEN v_capped:=true; EXIT; END IF;
      v_sort:=(v_page#>>'{nextCursor,sortOrder}')::integer; v_id:=(v_page#>>'{nextCursor,id}')::uuid;
    END LOOP;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,'name',public.safe_text_v1(item->>'name',200),
        'model',public.safe_text_v1(item->>'model',100),'lifecycleStatus',public.safe_text_v1(item->>'lifecycleStatus',60),
        'healthStatus',public.safe_text_v1(item->>'healthStatus',60),
        'reachable',CASE WHEN jsonb_typeof(item->'reachable')='boolean' THEN item->'reachable' END,
        'address',public.safe_text_v1(item->>'address',64),'lastSeenAt',public.utc_instant_v1((item->>'lastSeenAt')::timestamptz))
        ORDER BY o),'[]'::jsonb)
      INTO v_rows FROM jsonb_array_elements(v_items) WITH ORDINALITY e(item,o);
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',jsonb_array_length(v_rows)),'sourceCapped',v_capped,'unavailable',NULL);
  ELSIF p_report IN ('network_commands','network_audit') THEN
    FOR i IN 1..20 LOOP
      v_page:=CASE p_report WHEN 'network_commands' THEN public.network_center_list_commands_v1(v_building,v_at,v_id,100)
        ELSE public.network_center_list_audit_v1(v_building,v_at,v_id,100) END;
      v_items:=v_items||COALESCE(v_page->'items','[]'::jsonb);
      EXIT WHEN jsonb_typeof(v_page->'nextCursor') IS DISTINCT FROM 'object';
      IF i=20 THEN v_capped:=true; EXIT; END IF;
      v_at:=COALESCE(v_page#>>'{nextCursor,createdAt}',v_page#>>'{nextCursor,occurredAt}')::timestamptz; v_id:=(v_page#>>'{nextCursor,id}')::uuid;
    END LOOP;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',(item->>'id')::uuid,'buildingId',v_building,'organizationId',v_building_org,
        'at',public.utc_instant_v1(COALESCE(item->>'createdAt',item->>'at')::timestamptz),
        'action',public.safe_text_v1(COALESCE(item->>'actionType',item->>'action'),100),
        'status',public.safe_text_v1(COALESCE(item->>'status',item->>'outcome'),60),
        'reason',public.safe_text_v1(item->>'reason',300),'actorType',public.safe_text_v1(item->>'actorType',60),
        'byMe',COALESCE(COALESCE(item->>'requestedBy',item->>'actorId')=v_uid::text,false),
        'finishedAt',public.utc_instant_v1((item->>'finishedAt')::timestamptz)) ORDER BY o),'[]'::jsonb)
      INTO v_rows FROM jsonb_array_elements(v_items) WITH ORDINALITY e(item,o);
    RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('total',jsonb_array_length(v_rows)),'sourceCapped',v_capped,'unavailable',NULL);
  END IF;
  -- network_config_diff: hai bản sao lưu đã che bí mật; chỉ dòng thêm/bớt.
  BEGIN
    v_payload:=public.network_center_compare_snapshots_v1(v_building,(p_params->>'fromId')::uuid,(p_params->>'toId')::uuid);
  EXCEPTION WHEN no_data_found THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
  END;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('line',o,'buildingId',v_building,'organizationId',v_building_org,'kind',line->>'kind','text',public.safe_text_v1(line->>'text',500)) ORDER BY o),'[]'::jsonb)
    INTO v_rows FROM (SELECT line,o FROM jsonb_array_elements(COALESCE(v_payload->'lines','[]'::jsonb)) WITH ORDINALITY e(line,o)
      WHERE line->>'kind' IN ('added','removed') ORDER BY o LIMIT 2000) changed;
  RETURN jsonb_build_object('rows',v_rows,'summary',jsonb_build_object('changeCount',public.json_number_v1(v_payload->'changeCount')),
    'sourceCapped',(SELECT count(*) FROM jsonb_array_elements(COALESCE(v_payload->'lines','[]'::jsonb)) l WHERE l->>'kind' IN ('added','removed'))>2000,
    'unavailable',NULL);
END $fn$;

ALTER FUNCTION app_private.hermes_w2c_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2c_read_v1(text,jsonb,jsonb) OWNER TO postgres;
COMMIT;
NOTIFY pgrst,'reload schema';
