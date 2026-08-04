#!/usr/bin/env node
/**
 * BƯỚC 4 — copy file mẫu hợp đồng sang path của user test.
 *
 *   node scripts/clone-org/mask.mjs
 *
 * Làm nhiễu SĐT/email và xoá link đính kèm thu chi ĐÃ nằm trong
 * public.clone_org_sync_v1() (chạy cùng transaction chép), không còn ở đây.
 *
 * Còn lại đúng một việc storage phải làm ngoài SQL:
 *   Đường dẫn storage là `<user_id>/<tên>` — KHÔNG có org — và DB lưu URL đầy đủ,
 *   nên chép thô là bản sao trỏ thẳng vào file công ty thật (xoá bên test = mất
 *   file thật). Điều đó KHÔNG xảy ra: clone_org.map_text() đổi luôn đoạn uuid
 *   trong URL nên link của org TEST rơi vào thư mục CHÍNH user test — không dùng
 *   chung object nào, đổi lại link rỗng cho tới khi copy file sang.
 *   8 file mẫu hợp đồng copy ngay tại đây để in hợp đồng test được; ảnh khách,
 *   biên lai, ảnh phòng… copy bằng scripts/clone-org/copy-files.mjs (1,3 GB).
 */
import { runSql, getServiceKey, REF, TEST_ORG, log, die } from './lib.mjs'

const org = await runSql(`SELECT count(*) AS n FROM public.organizations WHERE id = '${TEST_ORG}';`)
if (!Number(org[0].n)) die('Chưa có org TEST.')

// ===== Nhân bản 8 file mẫu hợp đồng sang path của user test ================
const KEY = await getServiceKey()
const BUCKET = 'document-templates'
const marker = `/object/public/${BUCKET}/`

// Nguồn = file_url của bản GỐC (bản sao đã bị đổi uuid trong URL), đích = đúng
// file_url mà bản sao đang trỏ tới ⇒ copy xong không phải UPDATE gì.
const tpls = await runSql(`
  SELECT c.code, c.file_url AS dest_url, o.file_url AS src_url
  FROM public.document_templates c
  JOIN clone_org.idmap m ON m.new_id = c.id
  JOIN public.document_templates o ON o.id = m.old_id
  WHERE c.organization_id = '${TEST_ORG}';
`)
let copied = 0
for (const t of tpls) {
  const cut = (u) => (u.indexOf(marker) < 0 ? null : decodeURIComponent(u.slice(u.indexOf(marker) + marker.length)))
  const sourceKey = cut(t.src_url)
  const destinationKey = cut(t.dest_url)
  if (!sourceKey || !destinationKey) { log(`  • ${t.code}: file_url lạ, bỏ qua`); continue }

  const res = await fetch(`https://${REF}.supabase.co/storage/v1/object/copy`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: BUCKET, sourceKey, destinationKey }),
  })
  const body = await res.json().catch(() => null)
  if (res.ok || /already exists|Duplicate/i.test(JSON.stringify(body))) copied++
  else log(`  ✗ ${t.code}: copy HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`)
}
log(`✓ nhân bản ${copied}/${tpls.length} file mẫu hợp đồng sang path của user test`)

log('\n✓ Xong bước 4. Tiếp: node scripts/clone-org/verify.mjs')
