#!/usr/bin/env node
/**
 * Chạy 1 file SQL (UTF-8) trên live DB qua Supabase Management API.
 * Dùng cho seed/cleanup dữ liệu demo của trang docs (scripts/docs-demo/).
 *
 * Cách dùng:  node scripts/docs-demo/run-sql.mjs <file.sql> [--print-json]
 * PAT đọc từ env SUPABASE_PAT hoặc parse từ CLAUDE.local.md (không in ra).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const REF = JSON.parse(readFileSync(path.join(REPO, 'supabase', '.temp', 'linked-project.json'), 'utf8')).ref

function getPat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT
  const local = readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8')
  const m = local.match(/sbp_[a-f0-9]{40}/)
  if (!m) throw new Error('Không tìm thấy PAT (env SUPABASE_PAT hoặc CLAUDE.local.md)')
  return m[0]
}

const file = process.argv[2]
if (!file) {
  console.error('Cách dùng: node scripts/docs-demo/run-sql.mjs <file.sql>')
  process.exit(1)
}
const sql = readFileSync(path.resolve(file), 'utf8')

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${getPat()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
})
const body = await res.json().catch(() => null)
if (!res.ok) {
  console.error(`✗ HTTP ${res.status}:`, JSON.stringify(body, null, 2))
  process.exit(1)
}
if (process.argv.includes('--print-json')) console.log(JSON.stringify(body, null, 2))
else if (Array.isArray(body)) console.table(body.slice(0, 50))
else console.log(body === null ? 'OK (không có kết quả trả về)' : JSON.stringify(body).slice(0, 2000))
