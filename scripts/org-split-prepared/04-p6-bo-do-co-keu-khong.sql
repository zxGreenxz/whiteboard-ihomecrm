-- =============================================================================
-- P6 — chứng minh bộ đo rò KHÔNG đang kiểm chính nó
--
-- Chạy: node scripts/query-sql.mjs scripts/org-split-prepared/04-p6-bo-do-co-keu-khong.sql
--
-- measure-org-leak.mjs nay quét cả những bảng KHÔNG có cột organization_id, và
-- lần đo đầu (08/08/2026) cho ra 0 dòng lọt trên cả 12 bảng. Nhưng "0" chỉ có
-- nghĩa nếu bộ dò thật sự biết kêu — một phép đo luôn trả 0 cũng cho ra đúng
-- con số ấy, và trông y hệt thành công.
--
-- File này dựng một bảng RÒ THẬT bên trong BEGIN…ROLLBACK: không có cột
-- organization_id, có dữ liệu, và được GRANT SELECT cho authenticated. Rồi chạy
-- ĐÚNG phép quét mà bộ đo dùng, bằng vai một tổ chức vừa sinh ra.
--
-- ĐẠT = bắt được đúng bảng vừa dựng. HỎNG = dựng rò thật mà vẫn im.
-- Kết quả 08/08/2026: bắt đúng zz_thu_ro_khong_org(2), không bắt nhầm bảng nào.
--
-- Chỉ ghi trong transaction rồi ROLLBACK — production không giữ lại gì.
-- =============================================================================
BEGIN;
SET LOCAL statement_timeout='300s';
INSERT INTO auth.users (id) VALUES ('99999999-0000-4000-8000-000000000099');
INSERT INTO public.organizations (id, slug, name)
VALUES ('99990000-0000-4000-8000-000000000099','zz-do-ro-tong-hop','ZZ do ro');
INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status)
VALUES ('99990000-0000-4000-8000-000000000099','99999999-0000-4000-8000-000000000099','STAFF','ACTIVE');

CREATE TABLE public.zz_thu_ro_khong_org (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bi_mat text);
INSERT INTO public.zz_thu_ro_khong_org (bi_mat) VALUES ('dữ liệu của công ty khác'), ('dòng thứ hai');
GRANT SELECT ON public.zz_thu_ro_khong_org TO authenticated;

CREATE TEMP TABLE _kq(bang text, tong bigint, tu_choi boolean);
GRANT INSERT,SELECT ON _kq TO PUBLIC;
CREATE FUNCTION pg_temp._quet0() RETURNS void LANGUAGE plpgsql AS $q$
DECLARE b text; v bigint;
BEGIN
  FOR b IN SELECT c.relname FROM pg_class c
            WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
              AND NOT c.relispartition
              AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
                               AND a.attname='organization_id' AND a.attnum>0 AND NOT a.attisdropped)
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I', b) INTO v;
      INSERT INTO _kq VALUES (b, v, false);
    EXCEPTION WHEN insufficient_privilege THEN INSERT INTO _kq VALUES (b, 0, true);
             WHEN OTHERS THEN INSERT INTO _kq VALUES (b, NULL, false);
    END;
  END LOOP;
END $q$;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims='{"sub":"99999999-0000-4000-8000-000000000099","role":"authenticated"}';
SELECT pg_temp._quet0();
RESET ROLE;

SELECT count(*) FILTER (WHERE tong > 0)                                    AS so_bang_bi_bat,
       string_agg(bang||'('||tong||')', ', ') FILTER (WHERE tong > 0)      AS chi_tiet,
       CASE WHEN count(*) FILTER (WHERE tong > 0) > 0
            THEN 'ĐẠT — bộ dò kêu đúng lúc có rò'
            ELSE 'HỎNG — dựng rò thật mà bộ dò vẫn im' END                 AS phan_quyet
  FROM _kq;
ROLLBACK;
