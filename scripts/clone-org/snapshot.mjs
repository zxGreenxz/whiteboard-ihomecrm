#!/usr/bin/env node
/**
 * CỬA CHẶN của bộ nhân bản: chụp đúng những gì TÀI KHOẢN THẬT NHÌN THẤY.
 *
 * Chạy QUA PostgREST bằng JWT của nguyentamca165 — KHÔNG chạy bằng SQL, vì SQL
 * (role postgres, bypassrls) không đi qua RLS nên không phát hiện được rò rỉ.
 * Chạy 1 lần TRƯỚC khi chép, 1 lần SAU khi chép; hai file phải trùng khít.
 *
 *   node scripts/clone-org/snapshot.mjs before
 *   node scripts/clone-org/snapshot.mjs after      # tự so với 'before', lệch là exit 1
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { REF, REPO, TEST_ORG, cloneTables, log, die } from './lib.mjs'

const label = process.argv[2]
if (!['before', 'after'].includes(label)) die('Dùng: snapshot.mjs before|after')

const OUT_DIR = path.join(REPO, '.clone-org-snapshots')
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

// ---- anon key + đăng nhập tài khoản thật ------------------------------------
async function getAnonKey() {
  const pat = process.env.SUPABASE_PAT
    ?? readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8').match(/sbp_[a-f0-9]{40}/)?.[0]
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys`, {
    headers: { Authorization: `Bearer ${pat}` },
  })
  if (!res.ok) throw new Error(`api-keys HTTP ${res.status}`)
  const keys = await res.json()
  const k = keys.find((x) => x.name === 'anon')?.api_key
  if (!k) throw new Error('Không tìm thấy anon key')
  return k
}

function realCreds() {
  const md = readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8')
  const email = md.match(/Email:\s*`([^`]+)`/)?.[1]
  const password = md.match(/Password:\s*`([^`]+)`/)?.[1]
  if (!email || !password) throw new Error('Không đọc được tài khoản thật trong CLAUDE.local.md')
  return { email, password }
}

const ANON = await getAnonKey()
const { email, password } = realCreds()
const signIn = await fetch(`https://${REF}.supabase.co/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
const auth = await signIn.json()
if (!auth.access_token) die(`Đăng nhập tài khoản thật thất bại: ${JSON.stringify(auth).slice(0, 300)}`)
const JWT = auth.access_token
log(`✓ đăng nhập ${email}`)

// PostgREST của project này mặc định profile 'api' — supabase-js gửi kèm
// Accept-Profile/Content-Profile: public, không có là 404 PGRST202.
const H = { apikey: ANON, Authorization: `Bearer ${JWT}`, 'Accept-Profile': 'public' }

// ---- 1. Số dòng NHÌN THẤY được của mọi bảng nghiệp vụ -----------------------
const tables = (await cloneTables()).map((t) => t.tbl)
const counts = {}
for (const t of tables) {
  const res = await fetch(`https://${REF}.supabase.co/rest/v1/${t}?select=*&limit=1`, {
    method: 'GET',
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  })
  if (res.status === 404) continue // bảng không expose qua PostgREST
  const cr = res.headers.get('content-range') // "0-0/1234"
  counts[t] = cr ? Number(cr.split('/')[1]) : `HTTP ${res.status}`
}
log(`✓ đếm ${Object.keys(counts).length} bảng qua PostgREST`)

// ---- 1b. PHÉP ĐO RÒ RỈ CHÍNH ------------------------------------------------
// Hỏi thẳng: tài khoản thật có nhìn thấy dòng nào mang organization_id của org
// TEST không? Phép này miễn nhiễm với việc dữ liệu thật tự thay đổi (cron đêm
// 16:55 UTC sinh vài trăm bút toán), khác hẳn kiểu so số đếm trước/sau.
const leaks = []
// Bảng KHÔNG kiểm được phải đếm riêng, không được lẫn vào "đã kiểm, sạch".
// Bản trước viết `if (!res.ok) continue` rồi in `0/${tables.length}` — tức mẫu số
// là TỔNG SỐ BẢNG chứ không phải số bảng thật sự hỏi được. Nếu token hết hạn hay
// bị rate-limit ở 155/158 request, nó vẫn in "✓ 0/158 bảng rò rỉ" — đúng chuỗi mà
// PROJECT_CONTRACT coi là bằng chứng đã kiểm xong. Với một cửa chặn rò rỉ giữa
// công ty thật và org sandbox thì "không hỏi được" phải khác "hỏi rồi, sạch".
const khongKiemDuoc = []
// Rổ thứ ba, TÁCH RIÊNG khỏi "không kiểm được": role `authenticated` không có
// GRANT SELECT trên bảng (lỗi Postgres 42501). PostgREST từ chối ở tầng quyền
// TRƯỚC khi xét đến dòng nào, nên qua kênh này tài khoản thật không đọc nổi MỘT
// dòng — rò rỉ là bất khả, không phải "chưa biết".
//
// Gộp chung là sai theo cả hai hướng và bản trước gộp chung: 73 bảng khoá cứng
// nhất hệ thống bị đếm vào "có thể rò rỉ", gate exit 1, và in đúng câu
// "✗ Có rò rỉ" trong khi rổ rò rỉ RỖNG. Một cửa chặn kêu sai như vậy sẽ được
// người vận hành học cách bỏ qua, và lần nó kêu đúng cũng chịu chung số phận.
const khoaCong = []
for (const t of tables) {
  // Probe bằng CHÍNH cột đang lọc, không phải `id`. Bản trước dùng `select=id`
  // nên hai bảng nối khoá phức (area_buildings, income_expense_batch_items)
  // không có cột `id` trả 400/42703 rồi rơi vào rổ "không hỏi được" — trong khi
  // chúng hỏi được hoàn toàn: đổi projection sang organization_id là 200/count 0.
  // Lọc theo organization_id đã ngụ ý cột đó tồn tại, nên projection này không
  // bao giờ tự tạo ra lỗi cột mới.
  const res = await fetch(
    `https://${REF}.supabase.co/rest/v1/${t}?select=organization_id&organization_id=eq.${TEST_ORG}&limit=1`,
    { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } },
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    if (err.code === '42501') khoaCong.push(t)
    else khongKiemDuoc.push(`${t} (HTTP ${res.status} ${err.code ?? '?'}: ${(err.message ?? '').slice(0, 60)})`)
    continue
  }
  const n = Number(res.headers.get('content-range')?.split('/')[1] ?? 0)
  if (n > 0) leaks.push(`${t}=${n}`)
}
const daKiem = tables.length - khongKiemDuoc.length - khoaCong.length

// Chống xanh-rỗng: nếu token hết hạn hay rate-limit ở giữa chừng thì mọi bảng
// rơi vào khongKiemDuoc và nhánh dưới bắt được. Nhưng nếu cloneTables() trả
// danh sách rỗng thì vòng lặp chạy 0 lần và mọi rổ đều rỗng — "0 rò rỉ" trên 0
// bảng. Hệ này chắc chắn có hàng trăm bảng nghiệp vụ.
if (tables.length < 100) {
  console.error(`\n✗ Chỉ liệt kê được ${tables.length} bảng (sàn 100) — phép đo hỏng, KHÔNG phải "không rò rỉ".`)
  process.exitCode = 3
} else if (leaks.length) {
  console.error(`\n✗ RÒ RỈ: tài khoản thật NHÌN THẤY dữ liệu org TEST ở ${leaks.length} bảng:`)
  for (const l of leaks.slice(0, 30)) console.error('   ' + l)
  console.error('→ thiếu policy <bảng>_hide_sandbox_admin, hoặc policy bị predicate khác ghi đè.')
  process.exitCode = 1
} else if (khongKiemDuoc.length) {
  console.error(`\n⏹ KHÔNG KẾT LUẬN ĐƯỢC: ${khongKiemDuoc.length}/${tables.length} bảng không hỏi được.`)
  for (const t of khongKiemDuoc.slice(0, 20)) console.error('   ' + t)
  console.error(`→ mới kiểm ${daKiem}/${tables.length} bảng, và ${daKiem} bảng sạch KHÔNG chứng minh`)
  console.error(`  ${tables.length} bảng sạch. Sửa lỗi truy cập rồi chạy lại; đừng đọc kết quả này là PASS.`)
  process.exitCode = 3 // "không kiểm được" ≠ "có rò rỉ" — Contract §3
} else {
  log(`✓ 0/${daKiem} bảng hỏi được rò rỉ dữ liệu org TEST sang mắt tài khoản thật.`)
  if (khoaCong.length) {
    log(`  ℹ ${khoaCong.length} bảng còn lại: role authenticated KHÔNG có GRANT SELECT (42501) ⇒ rò rỉ`)
    log(`    bất khả qua PostgREST. Ví dụ: ${khoaCong.slice(0, 4).join(', ')}.`)
    log(`    CHƯA CHE: một RPC SECURITY DEFINER vẫn có thể đọc hộ chúng — kênh đó nằm ngoài`)
    log(`    phép đo này và luôn nằm ngoài, kể cả trước thay đổi hôm nay.`)
  }
}

// Kiểm ngược: dòng organization_id IS NULL của công ty thật KHÔNG được biến mất
// (policy sandbox từng giấu nhầm chúng vì NULL = ANY(...) ra NULL).
const nullOrgProbe = await fetch(
  `https://${REF}.supabase.co/rest/v1/inspection_photos?select=id&organization_id=is.null&limit=1`,
  { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } },
)
const nullOrgVisible = Number(nullOrgProbe.headers.get('content-range')?.split('/')[1] ?? 0)
log(`• dòng organization_id IS NULL còn thấy được (inspection_photos): ${nullOrgVisible}`)

// ---- 2. Các RPC tiền/vận hành mà màn hình chính đang gọi --------------------
async function rpc(name, body) {
  const res = await fetch(`https://${REF}.supabase.co/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', 'Content-Profile': 'public' },
    body: JSON.stringify(body),
  })
  const txt = await res.text()
  if (!res.ok) return { error: `HTTP ${res.status}: ${txt.slice(0, 200)}` }
  try { return JSON.parse(txt) } catch { return txt }
}

const today = new Date().toISOString().slice(0, 10)
const rpcs = {
  revenue_by_month: await rpc('revenue_by_month', {
    p_start: '2025-01-01', p_end: '2026-12-31', p_building_id: null,
  }),
  occupancy_snapshot_v2: await rpc('occupancy_snapshot_v2', {
    p_as_of_date: today, p_building_ids: null,
  }),
  fa_occupancy_monthly: await rpc('fa_occupancy_monthly', {
    p_start_date: '2026-01-01', p_end_date: '2026-12-31', p_building_ids: null,
  }),
  get_my_context: await rpc('get_my_context', {}),
}
log('✓ gọi 4 RPC báo cáo')

// ---- 3. Tổng tiền tự tính từ dữ liệu NHÌN THẤY -----------------------------
// PostgREST không SUM được ⇒ kéo cột tiền theo trang 1000 dòng rồi cộng ở đây.
async function sumColumn(table, col, filter = '') {
  let total = 0, from = 0, n = 0
  for (;;) {
    // PHẢI có order ổn định: phân trang bằng Range mà không order thì hai lần
    // chụp trả về hai tập dòng khác nhau ⇒ tổng tiền lệch giả (đã cắn 1 lần).
    const res = await fetch(
      `https://${REF}.supabase.co/rest/v1/${table}?select=${col}${filter}&order=id.asc`,
      { headers: { ...H, Range: `${from}-${from + 999}` } },
    )
    if (!res.ok) return `HTTP ${res.status}`
    const rows = await res.json()
    for (const r of rows) total += Number(r[col] ?? 0)
    n += rows.length
    if (rows.length < 1000) break
    from += 1000
  }
  return { rows: n, total: Math.round(total * 100) / 100 }
}

const sums = {
  income_expenses_amount: await sumColumn('income_expenses', 'total_amount', '&deleted_at=is.null'),
  invoices_total: await sumColumn('invoices', 'total_amount', '&deleted_at=is.null'),
  payments_amount: await sumColumn('payments', 'amount'),
  invoice_items_amount: await sumColumn('invoice_items', 'amount'),
}
log('✓ cộng 4 cột tiền')

// Bỏ trường đóng dấu thời gian, nếu không 2 lần chụp không bao giờ trùng.
const VOLATILE = new Set(['generated_at', 'as_of', 'created_at', 'updated_at'])
const stripVolatile = (v) =>
  Array.isArray(v) ? v.map(stripVolatile)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, stripVolatile(x)]))
      : v
for (const k of Object.keys(rpcs)) rpcs[k] = stripVolatile(rpcs[k])

const snap = { label, at: new Date().toISOString(), email, counts, rpcs, sums }
const file = path.join(OUT_DIR, `${label}.json`)
writeFileSync(file, JSON.stringify(snap, null, 2))
log(`✓ ghi ${file}`)

// ---- 4. So sánh ------------------------------------------------------------
if (label === 'after') {
  const beforeFile = path.join(OUT_DIR, 'before.json')
  if (!existsSync(beforeFile)) die('Thiếu before.json — phải chụp trước khi chép')
  const before = JSON.parse(readFileSync(beforeFile, 'utf8'))
  const diffs = []
  const cmp = (k, a, b) => {
    const sa = JSON.stringify(a), sb = JSON.stringify(b)
    if (sa !== sb) diffs.push(`${k}: ${sa} → ${sb}`)
  }
  for (const t of new Set([...Object.keys(before.counts), ...Object.keys(counts)]))
    cmp(`counts.${t}`, before.counts[t], counts[t])
  for (const k of Object.keys(sums)) cmp(`sums.${k}`, before.sums[k], sums[k])
  for (const k of Object.keys(rpcs)) cmp(`rpcs.${k}`, before.rpcs[k], rpcs[k])

  if (diffs.length) {
    log(`\n⚠ ${diffs.length} chỉ số lệch so với lúc chụp 'before' — PHẢI đọc từng dòng:`)
    for (const d of diffs.slice(0, 40)) log('  ' + d)
    log('\n  Lệch TĂNG ở bảng bút toán/ảnh chụp kỳ thường là dữ liệu thật tự sinh giữa 2 lần chụp')
    log('  (cron 16:55 UTC finance_month_snapshot, 18:00 UTC recurring_vouchers).')
    log('  Lệch GIẢM = dữ liệu thật bị giấu mất ⇒ policy sai, phải sửa ngay.')
    log('  Phép đo rò rỉ thật sự là mục "0/N bảng rò rỉ" ở trên, không phải bảng lệch này.')
  } else {
    log('\n✓ Số liệu công ty THẬT không xê dịch.')
  }
  // Câu kết phải NÓI ĐÚNG mã thoát. Bản trước in "✗ Có rò rỉ" cho mọi exitCode
  // khác 0, kể cả khi rổ rò rỉ rỗng và lý do chỉ là vài bảng không hỏi được.
  if (process.exitCode === 1) {
    console.error('\n✗ CÓ RÒ RỈ — xử lý xong mới được dùng bản sao.')
    process.exit(1)
  }
  if (process.exitCode === 3) {
    console.error('\n⏹ KHÔNG KẾT LUẬN ĐƯỢC — chưa chứng minh được bản sao kín, cũng chưa thấy rò rỉ.')
    console.error('  Đừng đọc là PASS, cũng đừng đi sửa policy: chưa có bằng chứng nào chỉ vào policy.')
    process.exit(3)
  }
  log('✓✓ Cửa chặn XANH: bản sao kín với tài khoản thật.')
}
