// Chốt chống hồi quy: quét mọi HÀM public khai STABLE/IMMUTABLE mà có lấy KHOÁ
// DÒNG — trực tiếp hoặc qua tối đa 4 tầng lời gọi.
//
// GOTCHA đã có án lệ (5 lần): PostgREST chạy hàm STABLE/IMMUTABLE trong
// transaction READ ONLY, nên mọi `SELECT … FOR SHARE` trong thân hàm (hay trong
// hàm nó gọi, ví dụ authorize_tenant_action_v3 / lock_org_for_decision_v1) ném
// 25006 "cannot execute SELECT FOR SHARE in a read-only transaction".
// Gọi bằng SQL thì XANH, gọi từ trình duyệt thì HỎNG — nên nó sống rất lâu mà
// không ai thấy. profit_close_state_v2 hỏng 10 ngày theo đúng kiểu này, kéo theo
// cả tab "Chốt LN tháng" mất mọi nút phụ thuộc trạng thái.
//
// CHẠY SAU MỌI MIGRATION TẠO/SỬA HÀM. Exit 1 nếu có hàm hở.
// Cách sửa: ALTER FUNCTION <sig> VOLATILE (an toàn khi FE gọi bằng supabase.rpc()
// — mặc định POST; chỉ hàm cần gọi qua GET mới buộc phải non-volatile).
//
// SQL này có bản psql chạy trên đích diễn tập ở kiem-bao-mat-sau-khoi-phuc.mjs
// — đổi luật ở đây thì đổi cả đó.
import { readFileSync } from 'node:fs';

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) pat = m[0];
  } catch {}
}
if (!pat) { console.error('Không tìm thấy PAT'); process.exit(1); }
const ref = 'tryymsxyyckgbrmmvozx';

const sql = `
  WITH RECURSIVE fns AS (
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
    FROM fns f JOIN closure c
      ON c.depth < 4 AND f.oid <> c.oid AND f.def ~ ('\\m' || c.nm || '\\s*\\(')
  )
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
  ORDER BY f.nm, c.depth;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const body = await res.text();
if (!res.ok) { console.error('FAILED', res.status, body.slice(0, 500)); process.exit(1); }
const bad = JSON.parse(body);

if (bad.length === 0) {
  console.log('OK — không hàm đọc nào chạm khoá dòng.');
  process.exit(0);
}
console.error(`HỞ ${bad.length} hàm — sẽ ném 25006 khi gọi từ trình duyệt:\n`);
for (const r of bad) {
  console.error(`  ${r.fn_name}  [${r.volatility}]  khoá đến từ: ${r.lock_from}`);
}
console.error('\nSửa bằng: ALTER FUNCTION public.<tên>(<đối số>) VOLATILE;');
process.exit(1);
