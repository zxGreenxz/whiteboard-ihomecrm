-- =============================================================================
-- Sort key tự nhiên cho buildings/rooms — phục vụ ORDER BY server-side của
-- trang Hoá đơn (phân trang server-side nên không sort client được).
-- Mirror đúng logic src/lib/roomSort.ts (compareBuildingThenRoom):
--   • Tòa: A→Z so khớp tự nhiên (15KV < 102LVT < 1392QT).
--   • Phòng: nhóm MB* → G* → L* → phòng số; trong nhóm so tự nhiên (L3 < L10).
-- Sửa roomSort.ts thì phải sửa cả 2 hàm này cho đồng bộ.
-- =============================================================================

-- Khoá sắp xếp tự nhiên: UPPER + mỗi cụm chữ số pad 12 ký tự.
CREATE OR REPLACE FUNCTION public.natural_sort_key(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT COALESCE(string_agg(
    CASE WHEN t.m[1] ~ '^\d' THEN lpad(t.m[1], 12, '0') ELSE t.m[1] END,
    '' ORDER BY t.ord), '')
  FROM regexp_matches(upper(trim(COALESCE(p_name, ''))), '\d+|\D+', 'g')
       WITH ORDINALITY AS t(m, ord);
$fn$;

-- Mirror của roomNameGroupRank + compareRoomNames (src/lib/roomSort.ts).
CREATE OR REPLACE FUNCTION public.room_sort_key(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT (CASE WHEN n LIKE 'MB%' THEN '0'
               WHEN n LIKE 'G%'  THEN '1'
               WHEN n LIKE 'L%'  THEN '2'
               ELSE '3' END) || '|' || public.natural_sort_key(n)
  FROM (SELECT upper(trim(COALESCE(p_name, ''))) AS n) s;
$fn$;

ALTER TABLE public.buildings ADD COLUMN name_sort text
  GENERATED ALWAYS AS (public.natural_sort_key(name)) STORED;

ALTER TABLE public.rooms ADD COLUMN name_sort text
  GENERATED ALWAYS AS (public.room_sort_key(name)) STORED;

NOTIFY pgrst, 'reload schema';
