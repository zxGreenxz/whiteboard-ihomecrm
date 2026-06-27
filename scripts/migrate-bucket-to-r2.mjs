// =============================================================================
// migrate-bucket-to-r2.mjs — copy 1 bucket Supabase Storage sang Cloudflare R2
// (object ihome-files/<bucket>/<path>) rồi VIẾT LẠI các URL đã lưu trong DB sang
// dạng R2 công khai (https://img.<domain>/<bucket>/<path>).
//
// Chạy:
//   source scratchpad/cf.env   (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...  (đọc từ .env.local)
//   node scripts/migrate-bucket-to-r2.mjs room-sale-images
//
// An toàn: KHÔNG xoá gì ở Supabase (giữ làm backup). Idempotent (chạy lại được).
// =============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
// Gọi wrangler qua `node <wrangler.js>` (tránh spawn .cmd EINVAL trên Windows).
const WRANGLER_JS = fileURLToPath(
  new URL('../infra/cloudflare-worker/node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const WORKER_DIR = fileURLToPath(new URL('../infra/cloudflare-worker/', import.meta.url));

const BUCKET = process.argv[2] || 'room-sale-images';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'ihome-files';
const R2_PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || 'https://img.chillhome.io.vn').replace(/\/$/, '');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (đọc .env.local).');
  process.exit(1);
}
if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error('Thiếu CLOUDFLARE_API_TOKEN (source scratchpad/cf.env).');
  process.exit(1);
}

const sb = (path, init = {}) =>
  fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      // PostgREST của project expose schema `api` mặc định → ép `public`.
      'Accept-Profile': 'public',
      'Content-Profile': 'public',
      ...(init.headers || {}),
    },
  });

// ---- 1. Liệt kê toàn bộ object trong bucket (đệ quy theo folder) -------------
async function listAll(prefix = '') {
  const out = [];
  let offset = 0;
  for (;;) {
    const res = await sb(`/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) throw new Error(`list ${prefix}: ${res.status} ${await res.text()}`);
    const items = await res.json();
    if (!items.length) break;
    for (const it of items) {
      const full = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id === null && it.metadata === null) {
        out.push(...(await listAll(full))); // folder → đệ quy
      } else {
        out.push({ path: full, size: it.metadata?.size ?? null, mime: it.metadata?.mimetype || null });
      }
    }
    if (items.length < 100) break;
    offset += items.length;
  }
  return out;
}

// ---- 2. Copy 1 object: download Supabase → wrangler r2 object put ------------
async function copyObject(tmp, obj, idx) {
  const dl = await sb(`/storage/v1/object/${BUCKET}/${encodeURI(obj.path)}`);
  if (!dl.ok) throw new Error(`download ${obj.path}: ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  const ct = dl.headers.get('content-type') || obj.mime || 'application/octet-stream';
  const local = join(tmp, `blob-${idx}`); // tên duy nhất/đối tượng (tránh đua khi chạy song song)
  await writeFile(local, buf);
  const key = `${R2_BUCKET}/${BUCKET}/${obj.path}`;
  await execFileP(
    process.execPath, // node
    [WRANGLER_JS, 'r2', 'object', 'put', key,
     '--file', local, '--content-type', ct,
     '--cache-control', 'public, max-age=31536000, immutable', '--remote'],
    { env: process.env, cwd: WORKER_DIR, maxBuffer: 1024 * 1024 * 64 },
  );
  return ct;
}

// ---- 3. Viết lại URL trong DB ------------------------------------------------
const supaPrefix = `${SUPABASE_URL}/storage/v1/object`;
function toR2(value) {
  if (typeof value !== 'string' || !value) return value;
  if (value.startsWith(R2_PUBLIC_BASE)) return value; // đã R2
  // URL Supabase trỏ đúng bucket?
  const m = value.match(/\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/);
  if (m) {
    if (m[1] !== BUCKET) return value; // bucket khác → giữ
    return `${R2_PUBLIC_BASE}/${BUCKET}/${decodeURIComponent(m[2])}`;
  }
  if (/^(https?:|blob:|data:)/i.test(value)) return value; // URL ngoài → giữ
  // path trần (vd "userid/file.png") → coi như thuộc BUCKET
  return `${R2_PUBLIC_BASE}/${BUCKET}/${value.replace(/^\/+/, '')}`;
}
function deepRewrite(node) {
  if (typeof node === 'string') return toR2(node);
  if (Array.isArray(node)) return node.map(deepRewrite);
  if (node && typeof node === 'object') {
    const o = {};
    for (const k of Object.keys(node)) o[k] = deepRewrite(node[k]);
    return o;
  }
  return node;
}

async function rewriteTable(table, columns) {
  const sel = `id,${columns.join(',')}`;
  const res = await sb(`/rest/v1/${table}?select=${sel}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    console.warn(`  [skip] ${table}: ${res.status} ${await res.text()}`);
    return 0;
  }
  const rows = await res.json();
  let changed = 0;
  for (const row of rows) {
    const patch = {};
    for (const col of columns) {
      const before = JSON.stringify(row[col] ?? null);
      const after = deepRewrite(row[col] ?? null);
      if (JSON.stringify(after) !== before && /room-sale-images|chillhome\.io\.vn/.test(JSON.stringify(after))) {
        // chỉ patch nếu thực sự có tham chiếu bucket này
        if (before.includes(BUCKET) || before.includes('chillhome')) patch[col] = after;
      }
    }
    if (Object.keys(patch).length) {
      const up = await sb(`/rest/v1/${table}?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      if (up.ok) changed++;
      else console.warn(`  patch ${table} ${row.id}: ${up.status} ${await up.text()}`);
    }
  }
  console.log(`  ${table}: rewrote ${changed} rows`);
  return changed;
}

// ---- main -------------------------------------------------------------------
const REWRITE = {
  'room-sale-images': [
    ['rooms', ['images']],
    ['buildings', ['images', 'floor_layouts']],
  ],
};

async function pool(items, n, fn) {
  let i = 0, done = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch (e) { console.error('  ERR', items[idx].path, e.message); }
      done++;
      if (done % 10 === 0 || done === items.length) console.log(`  ...${done}/${items.length}`);
    }
  });
  await Promise.all(workers);
}

(async () => {
  console.log(`== Migrate bucket "${BUCKET}" → R2 ${R2_BUCKET} ==`);
  console.log('1) Liệt kê object...');
  const objs = await listAll();
  console.log(`   ${objs.length} object.`);

  console.log('2) Copy lên R2 (download Supabase → wrangler put)...');
  const tmp = await mkdtemp(join(tmpdir(), 'r2mig-'));
  try {
    await pool(objs, 6, (o, idx) => copyObject(tmp, o, idx));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log('3) Viết lại URL trong DB...');
  const tables = REWRITE[BUCKET] || [];
  for (const [t, cols] of tables) await rewriteTable(t, cols);

  console.log('Xong. Supabase bucket giữ nguyên làm backup.');
})().catch((e) => { console.error(e); process.exit(1); });
