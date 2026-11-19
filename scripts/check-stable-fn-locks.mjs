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
// Câu SQL (kèm chú thích từng luật) nằm ở lib/stable-fn-locks-sql.mjs. Bộ kiểm
// trên đích diễn tập (kiem-bao-mat-sau-khoi-phuc.mjs) và trên TEST
// (check-personal-finance-catalog.mjs) import CÙNG hằng đó — đổi luật ở một chỗ.
import { SQL_STABLE_FN_LOCKS } from './lib/stable-fn-locks-sql.mjs';
import { layPat } from './lib/vault.mjs';

let pat = layPat({ bien: ['SUPABASE_PAT'] });
if (!pat) { console.error('Không tìm thấy PAT'); process.exit(1); }
const ref = 'tryymsxyyckgbrmmvozx';

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: SQL_STABLE_FN_LOCKS }),
});
const body = await res.text();
// Let fetch and output handles drain naturally (forced exit can assert in
// Windows libuv). Preserve the gate's nonzero result on every failure branch.
if (!res.ok) {
  console.error('FAILED', res.status, body.slice(0, 500));
  process.exitCode = 1;
} else {
  const bad = JSON.parse(body);
  if (bad.length === 0) {
    console.log('OK — không hàm đọc nào chạm khoá dòng.');
  } else {
    console.error(`HỞ ${bad.length} hàm — sẽ ném 25006 khi gọi từ trình duyệt:\n`);
    for (const r of bad) {
      console.error(`  ${r.fn_name}  [${r.volatility}]  khoá đến từ: ${r.lock_from}`);
    }
    console.error('\nSửa bằng: ALTER FUNCTION public.<tên>(<đối số>) VOLATILE;');
    process.exitCode = 1;
  }
}
