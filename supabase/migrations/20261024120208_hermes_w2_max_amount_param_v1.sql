-- Hermes Thu chi lượt 14 (24/10/2026; nghiệm thu vòng 1 bot thật trên TEST — docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 25): tham số W2 mới
-- maxAmount (số VND nguyên, 0–1.000.000.000.000) cho "duyệt hết phiếu chờ toà … dưới 1 triệu": bot gửi trần tiền vào expense_vouchers ⇒
-- invalid_request (khuôn chỉ có minAmount). Từ điển tham số là của NỀN đợt 2 ⇒ file tiền tố hermes_w2_. Thay thân hai hàm nền (cùng chữ ký,
-- cùng ACL), chép nguyên từ 20261022044126 (= production 24/10: tên e150d3aa…, kiểm 07e0083b…), thêm đúng một tên / một nhánh. Báo cáo cũ không
-- khai maxAmount ⇒ không đổi gì với chúng. Ghim chéo: 20261022044126 ghim hai thân đó ⇒ sau khi áp file này, chạy lại 044126 ngã đúng khối
-- $requires$ (cần ngoại lệ pinned). Không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2_param_names_v1()')),'')
      NOT IN ('e150d3aa96b7c7b934ade89454f8b089','d8ed5f064c3733ba2fac8e2b28d5915e') THEN
    RAISE EXCEPTION 'hermes_w2_max_amount_param_body_drift: app_private.hermes_w2_param_names_v1'; END IF;
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2_params_v1(jsonb,jsonb)')),'')
      NOT IN ('07e0083b0d1e02bf639eceb305b070bc','b22b3abf66f907f7980ddf8f6b700c01') THEN
    RAISE EXCEPTION 'hermes_w2_max_amount_param_body_drift: app_private.hermes_w2_params_v1'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_w2_param_names_v1()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT ARRAY['query','status','kind','month','year','fromDate','toDate','date','days','floor','basis','unreadOnly','lowStock','minAmount','maxAmount',
   'buildingId','areaId','roomId','customerId','contractId','invoiceId','cashbookId','staffId','categoryId','supplierId','materialId',
   'itemId','fromId','toId']::text[]
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_w2_params_v1(p_spec jsonb,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE v_names text[]; v_name text; v_value jsonb; v_text text; v_from date; v_to date;
BEGIN
  SELECT COALESCE(array_agg(value ORDER BY ordinality),'{}'::text[]) INTO v_names FROM jsonb_array_elements_text(p_spec->'params') WITH ORDINALITY;
  IF jsonb_typeof(p_params) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  IF cardinality(v_names)=0 THEN
    IF p_params<>'{}'::jsonb THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    RETURN p_params;
  END IF;
  PERFORM app_private.hermes_request_v1(p_params,v_names);
  FOREACH v_name IN ARRAY v_names LOOP
    v_value:=p_params->v_name; v_text:=p_params->>v_name;
    IF v_value='null'::jsonb THEN
      IF p_spec->'required' @> to_jsonb(ARRAY[v_name]) THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
      CONTINUE;
    END IF;
    IF v_name IN ('buildingId','areaId','roomId','customerId','contractId','invoiceId','cashbookId','staffId','categoryId','supplierId',
        'materialId','itemId','fromId','toId') THEN PERFORM app_private.hermes_uuid_v1(v_value);
    ELSIF v_name IN ('fromDate','toDate','date') THEN PERFORM app_private.hermes_domain_date_v2(v_value);
    ELSIF NOT (CASE v_name
      WHEN 'query' THEN jsonb_typeof(v_value)='string' AND char_length(v_text)<=200 AND v_text !~ '[[:cntrl:]]'
        AND position(chr(8232) IN v_text)=0 AND position(chr(8233) IN v_text)=0
      WHEN 'month' THEN jsonb_typeof(v_value)='string' AND v_text ~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$'
      WHEN 'year' THEN jsonb_typeof(v_value)='number' AND v_text ~ '^[0-9]{4}$' AND v_text::integer BETWEEN 2000 AND 2100
      WHEN 'days' THEN jsonb_typeof(v_value)='number' AND v_text ~ '^[0-9]{1,3}$' AND v_text::integer BETWEEN 1 AND 365
      WHEN 'floor' THEN jsonb_typeof(v_value)='number' AND v_text ~ '^-?[0-9]{1,3}$' AND v_text::integer BETWEEN -5 AND 200
      WHEN 'basis' THEN jsonb_typeof(v_value)='string' AND v_text IN ('accrual','cash')
      WHEN 'unreadOnly' THEN jsonb_typeof(v_value)='boolean'
      WHEN 'lowStock' THEN jsonb_typeof(v_value)='boolean'
      WHEN 'minAmount' THEN jsonb_typeof(v_value)='number' AND v_text ~ '^[0-9]{1,13}$' AND v_text::bigint BETWEEN 0 AND 1000000000000
      -- Thu chi lượt 14: trần tiền ("phiếu dưới 1 triệu"), cùng miền giá trị với minAmount.
      WHEN 'maxAmount' THEN jsonb_typeof(v_value)='number' AND v_text ~ '^[0-9]{1,13}$' AND v_text::bigint BETWEEN 0 AND 1000000000000
      WHEN 'status' THEN jsonb_typeof(v_value)='string' AND jsonb_typeof(p_spec->'statuses')='array' AND p_spec->'statuses' @> to_jsonb(ARRAY[v_text])
      WHEN 'kind' THEN jsonb_typeof(v_value)='string' AND jsonb_typeof(p_spec->'kinds')='array' AND p_spec->'kinds' @> to_jsonb(ARRAY[v_text])
      ELSE false END) THEN
      RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
    END IF;
  END LOOP;
  v_from:=app_private.hermes_domain_date_v2(p_params->'fromDate'); v_to:=app_private.hermes_domain_date_v2(p_params->'toDate');
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND (v_to<v_from OR v_to-v_from>366) THEN
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  RETURN p_params;
END $fn$;

DO $check$
BEGIN
  IF NOT ('maxAmount'=ANY(app_private.hermes_w2_param_names_v1())) OR NOT ('minAmount'=ANY(app_private.hermes_w2_param_names_v1()))
    OR app_private.hermes_w2_params_v1('{"params":["maxAmount"],"required":[]}'::jsonb,'{"maxAmount":1000000}'::jsonb)->>'maxAmount'<>'1000000'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_w2_params_v1(jsonb,jsonb)'::regprocedure)<>'b22b3abf66f907f7980ddf8f6b700c01' THEN
    RAISE EXCEPTION 'hermes_w2_max_amount_param_invalid'; END IF;
  BEGIN
    PERFORM app_private.hermes_w2_params_v1('{"params":["maxAmount"],"required":[]}'::jsonb,'{"maxAmount":-1}'::jsonb);
    RAISE EXCEPTION 'hermes_w2_max_amount_param_invalid: negative accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END $check$;
COMMIT;
