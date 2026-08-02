#!/usr/bin/env node
/**
 * BƯỚC 4b (tuỳ chọn) — nhân bản file storage sang thư mục của user test.
 *
 *   node scripts/clone-org/copy-files.mjs --dry     # chỉ đếm, không copy
 *   node scripts/clone-org/copy-files.mjs
 *
 * Vì sao chạy được đơn giản thế: đường dẫn mọi bucket (trừ evidence Finance V2)
 * là `<user_id>/<tên file>`, và bản sao đã đổi uuid trong URL sang user test,
 * nên ánh xạ là 1-1 theo thư mục gốc: <user thật>/x → <user test>/x.
 *
 * Copy phía server (storage/v1/object/copy) — không tải file về máy. Dung lượng
 * tăng thêm đúng bằng phần đang dùng của 4 user gốc (~1,4 GB).
 * Chạy lại được: object đã tồn tại thì bỏ qua.
 */
import { runSql, getServiceKey, REF, USERS, testEmail, sqlLit as L, log } from './lib.mjs'

const DRY = process.argv.includes('--dry')

const pairs = await runSql(`
  SELECT ru.id AS old_id, tu.id AS new_id, ru.email
  FROM (VALUES ${USERS.map((u) => `(${L(u.realEmail)}, ${L(testEmail(u))})`).join(',')}) m(re, te)
  JOIN auth.users ru ON ru.email = m.re
  JOIN auth.users tu ON tu.email = m.te;
`)
const mapById = Object.fromEntries(pairs.map((p) => [p.old_id, p.new_id]))
log(`• ${pairs.length} cặp user`)

const objects = await runSql(`
  SELECT bucket_id, name, coalesce((metadata->>'size')::bigint, 0) AS size
  FROM storage.objects
  WHERE split_part(name, '/', 1) IN (${pairs.map((p) => `'${p.old_id}'`).join(',')})
  ORDER BY bucket_id, name;
`)
const bytes = objects.reduce((s, o) => s + Number(o.size), 0)
log(`• ${objects.length} object / ${(bytes / 1e6).toFixed(0)} MB sẽ được nhân bản`)
const byBucket = {}
for (const o of objects) byBucket[o.bucket_id] = (byBucket[o.bucket_id] ?? 0) + 1
for (const [b, n] of Object.entries(byBucket)) log(`    ${b.padEnd(30)} ${n}`)
if (DRY) process.exit(0)

const KEY = await getServiceKey()
let ok = 0, skip = 0, err = 0
const CONC = 8
for (let i = 0; i < objects.length; i += CONC) {
  await Promise.all(objects.slice(i, i + CONC).map(async (o) => {
    const [owner, ...rest] = o.name.split('/')
    const destinationKey = [mapById[owner], ...rest].join('/')
    const res = await fetch(`https://${REF}.supabase.co/storage/v1/object/copy`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucketId: o.bucket_id, sourceKey: o.name, destinationKey }),
    })
    if (res.ok) { ok++; return }
    const body = await res.text()
    if (/already exists|Duplicate/i.test(body)) { skip++; return }
    err++
    if (err <= 5) log(`  ✗ ${o.bucket_id}/${o.name}: HTTP ${res.status} ${body.slice(0, 140)}`)
  }))
  if ((i / CONC) % 25 === 0) log(`  … ${Math.min(i + CONC, objects.length)}/${objects.length}`)
}
log(`\n✓ copy ${ok}, đã có ${skip}, lỗi ${err}`)
if (err) process.exitCode = 1
