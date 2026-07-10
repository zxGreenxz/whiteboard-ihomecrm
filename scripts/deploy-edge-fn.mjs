#!/usr/bin/env node
// Deploy một edge function qua Supabase Management API (không cần CLI/Docker).
// Cách dùng: node scripts/deploy-edge-fn.mjs <slug> [--no-verify-jwt]
// PAT đọc từ CLAUDE.local.md (sbp_...), project ref từ supabase/config.toml.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: node scripts/deploy-edge-fn.mjs <slug> [--no-verify-jwt]');
  process.exit(1);
}
const verifyJwt = !process.argv.includes('--no-verify-jwt');

const localMd = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
const pat = localMd.match(/sbp_[a-f0-9]+/)?.[0];
if (!pat) throw new Error('Không tìm thấy PAT trong CLAUDE.local.md');

const configToml = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const ref = configToml.match(/project_id\s*=\s*"([^"]+)"/)?.[1];
if (!ref) throw new Error('Không tìm thấy project_id trong supabase/config.toml');

const fnDir = join(process.cwd(), 'supabase', 'functions', slug);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(fnDir);

const form = new FormData();
form.append(
  'metadata',
  JSON.stringify({
    name: slug,
    entrypoint_path: 'index.ts',
    verify_jwt: verifyJwt,
  }),
);
for (const p of files) {
  const rel = relative(fnDir, p).replace(/\\/g, '/');
  form.append('file', new Blob([readFileSync(p)], { type: 'application/typescript' }), rel);
}

const res = await fetch(
  `https://api.supabase.com/v1/projects/${ref}/functions/deploy?slug=${slug}`,
  { method: 'POST', headers: { Authorization: `Bearer ${pat}` }, body: form },
);
const text = await res.text();
if (!res.ok) {
  console.error(`Deploy FAILED ${res.status}: ${text}`);
  process.exit(1);
}
const info = JSON.parse(text);
console.log(`Deployed "${info.name}" (slug=${info.slug}) version=${info.version} verify_jwt=${info.verify_jwt}`);
