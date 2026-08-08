-- Đo PHẠM VI của việc xoá hai org Test (cccc) / Demo (dddd): bảng nào dính,
-- mỗi bảng bao nhiêu dòng. Dùng để đối chiếu TRƯỚC/SAU transaction xoá — sau khi
-- xoá, chính câu này phải trả về so_bang_dinh = 0.
--
-- Chạy:  node scripts/query-sql.mjs scripts/org-split-prepared/02-pham-vi-xoa-hai-org.sql
-- Chỉ đọc. Duyệt mọi bảng public có cột organization_id (bỏ partition con).
BEGIN;
CREATE TEMP TABLE kq(bang text, cccc bigint, dddd bigint);
CREATE FUNCTION pg_temp.quet() RETURNS void LANGUAGE plpgsql AS $q$
DECLARE r record; a bigint; b bigint;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c
             JOIN pg_attribute x ON x.attrelid=c.oid AND x.attname='organization_id'
                                AND x.attnum>0 AND NOT x.attisdropped
            WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
              AND NOT c.relispartition ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FILTER (WHERE organization_id=''cccc0000-0000-4000-8000-000000000001''),
                           count(*) FILTER (WHERE organization_id=''dddd0000-0000-4000-8000-000000000001'')
                    FROM public.%I', r.relname) INTO a, b;
    IF a>0 OR b>0 THEN INSERT INTO kq VALUES (r.relname, a, b); END IF;
  END LOOP;
END $q$;
SELECT pg_temp.quet();
SELECT (SELECT count(*) FROM kq) AS so_bang_dinh,
       (SELECT sum(cccc) FROM kq) AS tong_dong_TEST,
       (SELECT sum(dddd) FROM kq) AS tong_dong_DEMO,
       (SELECT string_agg(bang||'('||cccc||'/'||dddd||')', ', ' ORDER BY cccc+dddd DESC)
          FROM (SELECT * FROM kq ORDER BY cccc+dddd DESC LIMIT 12) s) AS top12;
ROLLBACK;
