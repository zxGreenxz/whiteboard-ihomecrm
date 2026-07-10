#!/usr/bin/env node
// Apply một file migration SQL lên DB live qua Management API (UTF-8 an toàn font Việt).
// Cách dùng: node scripts/apply-migration.mjs supabase/migrations/<file>.sql
// (schema_migrations của CLI đã stale từ 02/2026 — repo apply SQL trực tiếp, file
//  migration trong repo là source of truth. Xem memory/docs.)
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to-sql>');
  process.exit(1);
}
const sql = readFileSync(file, 'utf8');
const localMd = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
const pat = localMd.match(/sbp_[a-f0-9]+/)[0];
const configToml = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const ref = configToml.match(/project_id\s*=\s*"([^"]+)"/)[1];

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`APPLY FAILED ${res.status}: ${text}`);
  process.exit(1);
}
console.log(`Applied ${file} OK.`, text.slice(0, 200));
