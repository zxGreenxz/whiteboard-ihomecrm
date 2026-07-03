// Helper chung cho seed/cleanup dữ liệu demo trang docs.
// PAT đọc từ env SUPABASE_PAT hoặc CLAUDE.local.md — KHÔNG in ra console.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(__dirname, '..', '..')
export const REF = JSON.parse(
  readFileSync(path.join(REPO, 'supabase', '.temp', 'linked-project.json'), 'utf8')
).ref

export const OWNER_ID = '90450d5f-29b6-4897-bdef-cdb5fb53f339' // nguyentamca165@gmail.com (super admin)

export function getPat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT
  const local = readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8')
  const m = local.match(/sbp_[a-f0-9]{40}/)
  if (!m) throw new Error('Không tìm thấy PAT')
  return m[0]
}

export async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getPat()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`SQL HTTP ${res.status}: ${JSON.stringify(body).slice(0, 800)}`)
  return body
}

let _serviceKey = null
export async function getServiceKey() {
  if (_serviceKey) return _serviceKey
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys`, {
    headers: { Authorization: `Bearer ${getPat()}` },
  })
  if (!res.ok) throw new Error(`api-keys HTTP ${res.status}`)
  const keys = await res.json()
  _serviceKey = keys.find((k) => k.name === 'service_role')?.api_key
  if (!_serviceKey) throw new Error('Không tìm thấy service_role key')
  return _serviceKey
}

export async function gotrueAdmin(pathname, opts = {}) {
  const key = await getServiceKey()
  const res = await fetch(`https://${REF}.supabase.co/auth/v1${pathname}`, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

export const sqlLit = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)
