-- Hermes đọc đầy đủ — ĐỢT 2, nền, sửa SAU phát hành (Đợt 2b Công việc — Mốc 4, 23/10/2026; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md
-- mục 4, 21): thêm khoá tasks.view (khoá đợt 1 ĐÃ BẬT, khoá đọc của trang /tasks) vào tập khoá dùng lại của báo cáo đợt 2 để báo cáo
-- tasks_board (gói C, 20261022180402) dùng đúng khoá đọc của trang Công việc. Khớp W2_REUSED_KEYS (infra/hermes-broker/wave2-kit.mjs; test
-- nền so khớp). Báo cáo dùng khoá dùng lại SỐNG NGAY khi phát hành SQL + connector (registry tasks.view đã bật).
-- Dựng từ thân ĐANG CHẠY production + TEST (đo 23/10: chuỗi file 20261018000500 + 'contracts.view' của 20261022043540 — #270 Hợp đồng, đã áp,
-- chưa vào main), chỉ thêm một phần tử. $requires$ nhận thân production, thân của chuỗi file khi chưa có 043540 (fixture đợt 2 trên nhánh
-- này), hoặc thân của file này (chạy lại); thân khác (một bản vá khác) ⇒ dừng. Cùng chữ ký, cùng ACL. Không DROP, không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2_reused_keys_v1()')),'')
      NOT IN ('4e304144c4c9cbc4af94f17c7411d261','465cf331b9cb90ae589b122d5e60e8b1','508230bfee9e23c07f5d928e96df83e0') THEN
    RAISE EXCEPTION 'hermes_w2_tasks_view_reused_body_drift'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_w2_reused_keys_v1()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT ARRAY['invoices.view','deposits.view','reports_finance.analysis','assets.view','services.view','rooms.view',
   'income_expenses.view','contracts.view','tasks.view']::text[]
$fn$;

ALTER FUNCTION app_private.hermes_w2_reused_keys_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_w2_reused_keys_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

DO $check$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_w2_reused_keys_v1()'::regprocedure AND p.prosecdef) IS DISTINCT FROM '508230bfee9e23c07f5d928e96df83e0'
    OR NOT ('tasks.view'=ANY(app_private.hermes_w2_reused_keys_v1())) OR NOT ('contracts.view'=ANY(app_private.hermes_w2_reused_keys_v1()))
    OR COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid='app_private.hermes_w2_reused_keys_v1()'::regprocedure),'') ~ '(^|[{,])(authenticated|anon|service_role)='
    THEN RAISE EXCEPTION 'hermes_w2_tasks_view_reused_check_failed'; END IF;
END $check$;
COMMIT;
NOTIFY pgrst,'reload schema';
