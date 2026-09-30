/** Read-only inventory: call sites are evidence to review, never inferred defects. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root = process.cwd();
const outDir = path.resolve(root, process.argv[2] ?? 'docs/implementation/thong-bao');
const files = execFileSync('rg', ['--files', 'src'], { encoding: 'utf8' }).trim().split(/\r?\n/)
  .filter(file => /\.[jt]sx?$/.test(file) && !/(?:__tests__|\.(?:test|spec)\.|integrations[\\/]supabase[\\/]types\.ts)/.test(file));
const decisionsPath = path.join(outDir, 'feedback-decisions.json');
const decisions = fs.existsSync(decisionsPath) ? JSON.parse(fs.readFileSync(decisionsPath, 'utf8')) : {};
const sites = [];
const sourceSnapshot = crypto.createHash("sha256");
for (const file of [...files].sort()) {
  const source = fs.readFileSync(file, 'utf8');
  sourceSnapshot.update(file.replaceAll('\\', '/') + '\n').update(source).update('\n');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const normalizedPath = file.replaceAll('\\', '/');
  const occurrences = new Map();
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast);
      let kind;
      if (/^(?:toast(?:\.[\w]+)?|notifyActionError|copyTextWithFeedback)$/.test(callee)) kind = 'notification';
      else if (/^(?:console\.(?:error|warn))$/.test(callee)) kind = 'log';
      else if (/^(?:useQuery|useInfiniteQuery|useMutation)$/.test(callee)) kind = callee;
      if (kind) {
        const snippet = node.getText(ast);
        const base = normalizedPath + '\n' + snippet.replace(/\s+/g, ' ');
        const occurrence = occurrences.get(base) ?? 0; occurrences.set(base, occurrence + 1);
        const signature = crypto.createHash('sha256').update(base + (occurrence ? '\n#' + occurrence : '')).digest('hex').slice(0, 16);
        const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
        const decision = decisions[signature];
        sites.push({ id: signature, file: normalizedPath, line, kind,
          status: decision?.status ?? 'needs-review', evidence: decision?.evidence ?? '',
          flags: [ /(?:error|err|caught|cause|\be)\??\.message/.test(snippet) ? 'direct-error-message' : null,
            /Dữ liệu đã được|Có lỗi xảy ra|atomic|canonical|posting|Finalize/.test(snippet) ? 'review-copy' : null ].filter(Boolean),
          source: snippet });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'feedback-inventory.json'), JSON.stringify({
  note: 'Static call sites; needs-review is not a defect count. A decision must cite inspected source or test evidence. Rerun after edits.',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceSnapshotHash: sourceSnapshot.digest('hex'),
  noteCommit: 'commit là HEAD khi quét; sourceSnapshotHash ghi đúng nội dung nguồn đang đọc, kể cả cây đang sửa.',
  filesScanned: files.length, counts: Object.fromEntries([...new Set(sites.map(site => site.kind))].map(kind => [kind, sites.filter(site => site.kind === kind).length])), sites,
}, null, 2) + '\n');
const flagged = sites.filter(site => site.flags.length);
fs.writeFileSync(path.join(outDir, 'feedback-review-queue.md'),
  '# Điểm thông báo cần đối chiếu\n\nDanh sách tự động, không phải kết luận mỗi dòng là lỗi. Mã ổn định theo nội dung lời gọi; quyết định và bằng chứng nằm trong `feedback-decisions.json`.\n\n' +
  '| Mã | Tệp:dòng | Loại | Dấu hiệu cần xem | Trạng thái |\n|---|---|---|---|---|\n' +
  flagged.map(site => `| ${site.id} | ${site.file}:${site.line} | ${site.kind} | ${site.flags.join(', ')} | ${site.status} |`).join('\n') + '\n');
console.log(JSON.stringify({ filesScanned: files.length, callSites: sites.length, flagged: flagged.length, pending: sites.filter(site => site.status === 'needs-review').length }));
