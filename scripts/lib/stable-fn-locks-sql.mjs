// Câu SQL của chốt "hàm STABLE/IMMUTABLE chạm khoá dòng" — MỘT nguồn cho mọi nơi chạy:
//   · scripts/check-stable-fn-locks.mjs          production, qua Management API (CI: security-gates)
//   · scripts/kiem-bao-mat-sau-khoi-phuc.mjs     đích diễn tập khôi phục, qua psql
//   · scripts/check-personal-finance-catalog.mjs project TEST, qua psql
// Trước 15/11/2026 hai script đầu giữ mỗi nơi một bản chép tay; nay cả ba import từ đây, nên đổi
// luật là đổi ở MỘT chỗ. Luật và án lệ của chốt: xem đầu scripts/check-stable-fn-locks.mjs.
//
// KHÔNG có dấu `;` cuối: hai đường psql bọc câu này trong `SELECT json_agg(t) FROM (…) t`.
//
// VÌ SAO CÓ CTE `calls` (đo 15/11/2026 trên production, chỉ đọc)
//   Bước đệ quy cũ nối `closure × fns` bằng regex động  f.def ~ ('\m' || c.nm || '\s*\(')  — số
//   phép regex = số dòng closure × số hàm (2.660 × 2.712), mỗi phép quét cả thân hàm. Câu chạy
//   114 giây, vượt statement timeout (57014), kéo các truy vấn cùng lượt rớt kết nối và làm CI của
//   main đỏ ngẫu nhiên. Nay tách lời gọi của mỗi hàm MỘT lần rồi nối bằng phép bằng: dưới 2 giây
//   (phía server 0,5 giây). Tập closure (oid, depth, via) trùng md5 với câu cũ trên production —
//   2.712 hàm, 503 hàm gốc, 796 hàm tới được, 2.660 dòng, 0 vi phạm.
//
// HAI CHI TIẾT GIỮ CHO KẾT QUẢ TRÙNG CÂU CŨ Ở MỌI ĐẦU VÀO, không chỉ ở dữ liệu hôm nay
//   1. COLLATE "C" khi tách lời gọi. Regex cũ ghép từ `c.nm` kiểu `name`, mà `name` mang collation
//      "C", nên nó chạy theo "C": chỉ chữ ASCII, số và `_` là ký tự từ. Tách theo collation mặc
//      định của database (production: en_US.UTF-8) thì chữ có dấu đứng liền trước tên hàm bị nhập
//      vào "từ" và lời gọi đó rơi mất — đo trên production và PGlite: với 'ềfoo(' câu cũ khớp
//      `foo`, còn tách mặc định ra `ềfoo`.
//   2. Nhánh UNION ALL cho tên hàm có ký tự ngoài [A-Za-z0-9_] (tên có `$`, tên đặt trong nháy
//      kép). Regex cũ coi các ký tự đó là cú pháp regex (`.` khớp mọi ký tự, `$` là cuối chuỗi)
//      nên phép bằng không tái hiện được; nhánh này chạy NGUYÊN VĂN regex cũ cho riêng các tên
//      đó. Production hiện không có tên nào như vậy nên nhánh không tốn gì. Khác duy nhất còn lại:
//      tên làm regex SAI CÚ PHÁP nay báo lỗi cả khi hàm đó nằm ngoài closure (đỏ sớm hơn, không
//      xanh nhầm).
//
// Tương đương được ghim bằng scripts/__tests__/stable-fn-locks-sql.test.mjs: PGlite chạy cả câu
// trước 15/11/2026 lẫn câu này trên cùng bộ hàm giả rồi so tập closure và danh sách vi phạm.

/** Phần `WITH RECURSIVE … closure` — test đọc thẳng `closure` để so từng dòng (oid, depth, via). */
export const CTE_STABLE_FN_LOCKS = `
  WITH RECURSIVE fns AS MATERIALIZED (
    SELECT p.oid, n.nspname AS ns, p.proname AS nm, p.provolatile AS vol,
           -- BỎ COMMENT trước khi dò. Không làm vậy thì gate khớp vào chính câu
           -- văn NÓI RẰNG hàm không khoá dòng — đo được thật:
           -- network_center_admin_list_access_ports_v1 có comment
           -- "No FOR UPDATE / FOR SHARE anywhere in this body: … a row lock
           -- raises 25006", và bị chấm vi phạm vì đúng câu đó. Cùng căn bệnh với
           -- guard grep cũ trong repo: cấm luôn việc VIẾT RA rằng điều đó bị cấm.
           -- (Bộ lọc ACL vô tình che ca này, nên nó sống cho tới khi bỏ lọc.)
           regexp_replace(
             regexp_replace(pg_get_functiondef(p.oid), '/\\*.*?\\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g') AS def,
           p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    -- Thêm 'api': PostgREST expose "api, public,graphql_public" và api đứng
    -- ĐẦU nên là profile mặc định. Hàm ở đó gọi được không cần header nào.
    WHERE p.prokind IN ('f','p') AND n.nspname IN ('public', 'app_private', 'api')
  ),
  -- Lời gọi của từng hàm, tách MỘT lần: mọi "tên(" trong thân đã bỏ comment.
  -- Nhánh sau UNION ALL giữ nguyên văn regex cũ cho tên hàm có ký tự ngoài
  -- chữ ASCII, số và gạch dưới (xem đầu file).
  calls AS MATERIALIZED (
    SELECT DISTINCT f.oid, m[1] AS callee
    FROM fns f, LATERAL regexp_matches(f.def COLLATE "C", '\\m(\\w+)\\s*\\(', 'g') AS m
    UNION ALL
    SELECT f.oid, w.nm
    FROM (SELECT DISTINCT nm FROM fns WHERE nm !~ '^\\w+$') w
    JOIN fns f ON f.def ~ ('\\m' || w.nm || '\\s*\\(')
  ),
  seed AS (
    SELECT oid, nm, 0 AS depth, nm AS via FROM fns
    -- LOCK TABLE cũng ném 25006 trong transaction read-only, y như FOR UPDATE.
    -- Bản đầu chỉ liệt kê họ FOR …, nên một hàm khoá bằng LOCK TABLE là vô hình.
    WHERE def ~* '\\mfor\\s+(share|update|no key update|key share)\\M'
       OR def ~* '\\mlock\\s+(table\\s+)?[a-z_.]'
  ),
  closure AS (
    SELECT oid, nm, depth, via FROM seed
    UNION
    SELECT f.oid, f.nm, c.depth + 1, c.via
    FROM closure c
    JOIN calls k ON k.callee = c.nm
    JOIN fns f ON f.oid = k.oid
    WHERE c.depth < 4 AND f.oid <> c.oid
  )`;

/** Câu đầy đủ của chốt: mỗi dòng trả về là một hàm đọc chạm khoá dòng (fn_name, volatility, lock_from). */
export const SQL_STABLE_FN_LOCKS = `${CTE_STABLE_FN_LOCKS}
  SELECT DISTINCT ON (f.nm)
         f.nm AS fn_name,
         CASE f.vol WHEN 's' THEN 'STABLE' ELSE 'IMMUTABLE' END AS volatility,
         c.via AS lock_from
  FROM closure c JOIN fns f ON f.oid = c.oid
  -- KHÔNG lọc theo ACL nữa.
  --
  -- Bộ lọc cũ proacl IS NULL OR proacl ILIKE '%authenticated%' loại bỏ hàm chỉ
  -- GRANT cho service_role hoặc anon. Nhưng PostgREST quyết định READ-ONLY
  -- theo VOLATILITY chứ không theo role: STABLE là read-only bất kể gọi bằng key
  -- nào, và khoá dòng trong transaction read-only ném 25006 y hệt.
  --
  -- Đo 07/08/2026: 22 trong 505 hàm public STABLE/IMMUTABLE bị bộ lọc này che
  -- khuất (toàn bộ họ network_center_admin_*, _profit_*, lucky_*, v5_*,
  -- authorize_v2, effective_perms_v2 …). Hiện KHÔNG hàm nào trong số đó vi phạm
  -- — kết quả trước và sau khi bỏ lọc đều là 0 — nên đây là lỗ tiềm ẩn, không
  -- phải sự cố đang xảy ra. Bịt lúc còn sạch thì rẻ.
  WHERE f.ns IN ('public', 'api') AND f.vol <> 'v'
  ORDER BY f.nm, c.depth`;
