-- Chứng minh hai org cccc/dddd có TÁCH RỜI về tham chiếu khỏi org thật aaaa hay không.
--
-- Nếu có dòng của aaaa trỏ tới dòng của cccc/dddd thì xoá hai org kia sẽ để lại
-- tham chiếu treo trong dữ liệu công ty thật — và nếu lúc đó FK trigger đang bị
-- tắt (điều bắt buộc để vượt qua ~60 guard append-only) thì hỏng đó sẽ KHÔNG báo
-- lỗi, chỉ âm thầm ở lại.
--
-- ĐÂY LÀ ĐIỀU KIỆN TIÊN QUYẾT của việc xoá hai org: phải trả về
-- '(TACH ROI HOAN TOAN)' NGAY TRƯỚC khi mở transaction xoá, không phải một lần
-- rồi tin mãi — dữ liệu mới có thể sinh ra đường tham chiếu mới bất cứ lúc nào.
--
-- Chạy:  node scripts/query-sql.mjs scripts/org-split-prepared/01-chung-minh-tach-roi.sql
-- Chỉ đọc. Duyệt mọi khoá ngoại giữa hai bảng đều có organization_id.
BEGIN;

CREATE TEMP TABLE kq(con text, cot text, cha text, so_vi_pham bigint);

CREATE FUNCTION pg_temp.quet() RETURNS void LANGUAGE plpgsql AS $q$
DECLARE
  r record;
  v bigint;
BEGIN
  FOR r IN
    SELECT con.relname  AS bang_con,
           acon.attname AS cot_con,
           cha.relname  AS bang_cha,
           acha.attname AS cot_cha
      FROM pg_constraint k
      JOIN pg_class con  ON con.oid = k.conrelid
      JOIN pg_class cha  ON cha.oid = k.confrelid
      JOIN pg_attribute acon ON acon.attrelid = k.conrelid  AND acon.attnum = k.conkey[1]
      JOIN pg_attribute acha ON acha.attrelid = k.confrelid AND acha.attnum = k.confkey[1]
     WHERE k.contype = 'f'
       AND array_length(k.conkey, 1) = 1
       AND con.relnamespace = 'public'::regnamespace
       AND cha.relnamespace = 'public'::regnamespace
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = con.oid
                    AND x.attname = 'organization_id' AND x.attnum > 0 AND NOT x.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute y WHERE y.attrelid = cha.oid
                    AND y.attname = 'organization_id' AND y.attnum > 0 AND NOT y.attisdropped)
  LOOP
    BEGIN
      EXECUTE format(
        'SELECT count(*) FROM public.%I c JOIN public.%I p ON p.%I = c.%I '
        ' WHERE c.organization_id = ''aaaa0000-0000-4000-8000-000000000001'' '
        '   AND p.organization_id IN (''cccc0000-0000-4000-8000-000000000001'','
        '                             ''dddd0000-0000-4000-8000-000000000001'')',
        r.bang_con, r.bang_cha, r.cot_cha, r.cot_con) INTO v;
      IF v > 0 THEN
        INSERT INTO kq VALUES (r.bang_con, r.cot_con, r.bang_cha, v);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO kq VALUES (r.bang_con, r.cot_con || ' [LOI ' || SQLSTATE || ']', r.bang_cha, -1);
    END;
  END LOOP;
END $q$;

SELECT pg_temp.quet();

SELECT coalesce(count(*), 0)                                   AS so_duong_vi_pham,
       coalesce(sum(so_vi_pham) FILTER (WHERE so_vi_pham > 0), 0) AS tong_dong_vi_pham,
       coalesce(string_agg(con || '.' || cot || ' -> ' || cha || ' (' || so_vi_pham || ')', ' | '),
                '(TACH ROI HOAN TOAN)')                        AS chi_tiet
  FROM kq;

ROLLBACK;
