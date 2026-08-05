#!/usr/bin/env node
// Gate: AI Copilot chỉ đọc tài liệu được khai tường minh trong
// docs/he-thong/manifest.json.
//
// Vì sao cần gate thay vì chỉ có manifest: nếu manifest chỉ là danh sách "cho
// phép" mà không ai kiểm, thì một file .md mới thả vào docs/he-thong/ sẽ im
// lặng nằm ngoài manifest (Copilot không đọc — người viết tưởng đã đọc), hoặc
// tệ hơn, ai đó nới glob trở lại và mọi file lọt vào mà không ai thấy. Gate này
// bắt cả hai chiều.
//
//   node scripts/check-copilot-docs-manifest.mjs
//
// Không cần credential, không đọc database.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(repoRoot, 'docs', 'he-thong');
const MANIFEST_PATH = join(DOCS_DIR, 'manifest.json');
const REGISTRY_PATH = join(repoRoot, 'src', 'copilot', 'tools', 'registry.ts');

export function diffManifestAgainstDir(manifest, filesOnDisk) {
  const declared = new Set(manifest.entries.map((e) => e.file));
  const onDisk = new Set(filesOnDisk);
  return {
    undeclared: [...onDisk].filter((f) => !declared.has(f)).sort(),
    missing: [...declared].filter((f) => !onDisk.has(f)).sort(),
  };
}

export function findStaleEntries(manifest, today = new Date()) {
  const days = manifest.staleAfterDays;
  if (!days) return [];
  return manifest.entries
    .filter((e) => e.copilotIngest && e.reviewed)
    .map((e) => ({
      file: e.file,
      ageDays: Math.floor((today - new Date(e.reviewed)) / 86_400_000),
    }))
    .filter((e) => e.ageDays > days);
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const filesOnDisk = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'));
  const problems = [];

  const { undeclared, missing } = diffManifestAgainstDir(manifest, filesOnDisk);
  for (const f of undeclared) {
    problems.push(
      `Chưa khai trong manifest: docs/he-thong/${f}\n` +
      '    → thêm entry với copilotIngest true/false. Mặc định KHÔNG được là "cho đọc".',
    );
  }
  for (const f of missing) {
    problems.push(`Manifest trỏ file không tồn tại: docs/he-thong/${f}`);
  }

  for (const e of manifest.entries) {
    if (typeof e.copilotIngest !== 'boolean') {
      problems.push(`Entry "${e.file}" thiếu copilotIngest (boolean).`);
    }
    if (e.copilotIngest === false && !e.why) {
      problems.push(`Entry "${e.file}" bị loại khỏi Copilot nhưng không ghi lý do ("why").`);
    }
    if (e.requiredPermission && (!e.requiredPermission.module || !e.requiredPermission.action)) {
      problems.push(`Entry "${e.file}" có requiredPermission thiếu module/action.`);
    }
  }

  // Registry phải lọc qua manifest, không được quay lại glob mù.
  const registry = readFileSync(REGISTRY_PATH, 'utf8');
  if (!registry.includes('manifest.json')) {
    problems.push(
      'src/copilot/tools/registry.ts không còn tham chiếu manifest.json — ' +
      'Copilot có thể đã quay lại đọc mù toàn thư mục.',
    );
  }

  if (problems.length > 0) {
    console.error('❌ Copilot docs manifest có vấn đề:\n');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const ingested = manifest.entries.filter((e) => e.copilotIngest);
  const gated = ingested.filter((e) => e.requiredPermission);
  const stale = findStaleEntries(manifest);

  console.log(
    `✅ Copilot docs manifest khớp thư mục: ${ingested.length}/${manifest.entries.length} file được đọc, ` +
    `${gated.length} file gác quyền.`,
  );
  // Cảnh báo, KHÔNG fail: nếu quá hạn review làm đỏ CI thì người ta sẽ bump ngày
  // theo nghi thức và phá luôn tín hiệu.
  if (stale.length > 0) {
    console.warn(`⚠ ${stale.length} tài liệu quá hạn review ${manifest.staleAfterDays} ngày:`);
    for (const s of stale) console.warn(`   - ${s.file} (${s.ageDays} ngày)`);
  }
  const unreviewed = ingested.filter((e) => !e.reviewed);
  if (unreviewed.length > 0) {
    console.warn(`⚠ ${unreviewed.length} tài liệu được Copilot đọc nhưng chưa từng ghi ngày review.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
