#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'docs/engineering/PROJECT_CONTRACT.md';
const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md', 'AI_RULES.md'];
const REFERENCE_GUIDES = ['README.md', 'docs/engineering/MIGRATION_STRATEGY.md',
  'docs/engineering/DATA_ENVIRONMENTS.md', 'docs/decisions/ADR-0003-agent-pr-only.md'];

const FORBIDDEN = [
  {
    id: 'gen-types-redirect',
    re: /(gen:types|gen\s+types\s+typescript)[^\n]{0,120}?(?<!>)[012]?>(?!>)/,
    why: 'Redirect cắt trắng types.ts TRƯỚC khi generator chạy. Dùng `npm run gen:types` (script tự ghi atomic + tự chèn header).',
  },
  {
    id: 'push-equals-done',
    re: /chua push[^\n]{0,24}=\s*(viec\s*)?chua xong/i,
    why: '`main` không phải production. Phát hành là bước promote riêng sau khi gate xanh (PROJECT_CONTRACT §3).',
  },
  {
    id: 'git-add-all',
    re: /git add\s+(-A|--all|\.)(?![\w/\\.-])/i,
    why: 'Cây làm việc repo này thường có file dở dang từ phiên khác; phải stage tên file cụ thể.',
  },
];

const deaccent = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

const CANH_BAO = /(khong|dung(?=\s)|cam\b|tuyet doi|gotcha|footgun|pha file|thay bang|sai|loi|⚠|❌)/i;

function tieuDePhuDinh(cacDong, chiSo) {
  for (let i = chiSo; i >= 0; i -= 1) {
    const m = /^#{1,6}\s+(.*)$/.exec(cacDong[i]);
    if (m) return CANH_BAO.test(deaccent(m[1]));
  }
  return false;
}

export function findForbidden(text, file) {
  const ra = [];
  const cacDong = text.split(/\r?\n/);
  for (const { id, re, why } of FORBIDDEN) {
    for (let i = 0; i < cacDong.length; i += 1) {
      const dong = deaccent(cacDong[i]);
      const m = re.exec(dong);
      if (!m) continue;
      if (CANH_BAO.test(dong.slice(0, m.index))) continue; // "ĐỪNG chạy X"
      if (tieuDePhuDinh(cacDong, i)) continue; // nằm trong mục "KHÔNG được…"
      ra.push({ file, id, why, dong: cacDong[i].trim(), soDong: i + 1 });
      break;
    }
  }
  return ra;
}

const GUIDE_LIMITS = { 'CLAUDE.md': [60, 6000], 'AGENTS.md': [60, 6000],
  'AI_RULES.md': [10, 1000], [CONTRACT]: [260, 26000] };
const visibleMarkdown = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

export function checkGuide(raw, file, scripts, exists) {
  const text = visibleMarkdown(raw);
  const problems = findForbidden(text, file);
  const add = (id, why) => problems.push({ file, id, why });
  const limit = GUIDE_LIMITS[file];
  if (limit && (raw.trimEnd().split(/\r?\n/).length > limit[0] || Buffer.byteLength(raw) > limit[1])) {
    add('guide-too-long', 'Hướng dẫn vượt giới hạn; rút trùng lặp, liên kết nguồn chuyên đề thay vì chép lại.');
  }
  if (AGENT_FILES.includes(file) && !text.includes('PROJECT_CONTRACT.md')) {
    add('missing-contract-pointer', 'Adapter phải trỏ về Project Contract trong nội dung người đọc thấy.');
  }
  if (['CLAUDE.md', 'AGENTS.md'].includes(file)
      && !(text.includes('PROJECT_CONTRACT.md') && text.includes('§12'))) {
    add('missing-source-lookup-pointer', 'Adapter công cụ phải trỏ tới Project Contract §12.');
  }
  for (const match of text.matchAll(/\bnpm run ([\w:-]+)/g)) {
    if (!Object.hasOwn(scripts, match[1])) add('unknown-npm-script', 'Lệnh npm không tồn tại: ' + match[1]);
  }
  // Chỉ kiểm link file/thư mục Markdown nội bộ; URL và anchor cùng trang không phải đường dẫn.
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), target));
    if (!exists(resolved)) add('broken-guide-link', 'Không tìm thấy link: ' + target);
  }
  return problems;
}

const GITNEXUS_ALIASES = ['analyze', 'status', 'query', 'context', 'impact', 'trace'];
const GENERATED_GRAPH = /^(?:\.ua|\.gitnexus)\/|^\.(?:agents|claude)\/skills\/(?:generated|gitnexus)\//;

function shellCommandSegments(raw) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const finish = () => {
    if (current.trim()) segments.push(current.trim());
    current = '';
  };

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote) {
      current += char;
      if (char === '\\' && quote !== "'") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '#' && (!current || /\s/.test(current.at(-1)))) {
      while (i + 1 < raw.length && raw[i + 1] !== '\n') i += 1;
      finish();
      continue;
    }
    if (char === '\n' || char === '\r' || char === ';' || char === '|'
        || (char === '&' && raw[i + 1] === '&')) {
      if ((char === '|' || char === '&') && raw[i + 1] === char) i += 1;
      finish();
      continue;
    }
    current += char;
  }
  finish();
  return segments;
}

function isMandatoryGraphCommand(segment) {
  let command = segment.replace(/^(?:if|then|do)\s+/, '');
  command = command.replace(/^(?:[A-Za-z_][A-Za-z\d_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '');
  command = command.replace(/^(?:(?:sudo|command|env)\s+)*/, '');
  command = command.replace(/^(node(?:\.exe)?)\s+(["'])([^"']+)\2(?=\s|$)/i, '$1 $3');
  const graphCommand = [
    /^node(?:\.exe)?\s+(?:\.[\\/])?scripts[\\/]check-graph-(?:freshness|hygiene|secrets)\.mjs\b/i,
    /^node(?:\.exe)?\s+(?:\.[\\/])?scripts[\\/]run-pinned-gitnexus\.mjs\b/i,
    /^npm(?:\.cmd)?\s+run\s+(?:gate:graph[\w:-]*|graph:[\w-]+)\b/i,
    /^npx(?:\.cmd)?\s+(?:(?:--yes|-y)\s+)?gitnexus(?:@[^\s]+)?(?:\s|$)/i,
    /^(?:(?:\.[\\/])?node_modules[\\/]\.bin[\\/])?gitnexus(?:\.cmd)?(?:\s|$)/i,
  ].some((pattern) => pattern.test(command));
  if (graphCommand) return true;
  if (/^(?:echo|printf|write-(?:host|output))\b/i.test(command)) return false;
  return /(?:^|\s)\.(?:gitnexus|ua)[\\/]/i.test(command);
}

function runHasMandatoryGraphCommand(run) {
  const normalized = run.replace(/\\\r?\n[ \t]*/g, ' ');
  return shellCommandSegments(normalized).some(isMandatoryGraphCommand);
}

function hasGitNexusProjectMcp(projectMcp) {
  const servers = projectMcp?.mcpServers;
  if (!servers || typeof servers !== 'object') return false;
  return Object.entries(servers).some(([name, config]) =>
    /gitnexus/i.test(name) || /gitnexus/i.test(JSON.stringify(config)));
}

export function checkRepositoryContract({ scripts = {}, trackedFiles = [], existingFiles = new Set(), agentTools, projectMcp, workflowRuns = [] }) {
  const problems = [];
  const add = (id, why) => problems.push({ file: 'repository', id, why });
  if (!existingFiles.has('scripts/run-pinned-gitnexus.mjs')) {
    add('missing-gitnexus-wrapper', 'Thiếu wrapper GitNexus tùy chọn của repo.');
  }
  const pin = agentTools?.gitnexus;
  if (!/^\d+\.\d+\.\d+$/.test(pin?.version ?? '')
      || JSON.stringify(pin?.analyzeArgs) !== JSON.stringify(['--index-only', '--skip-agents-md', '--worker-timeout', '60'])) {
    add('invalid-gitnexus-pin', 'Pin GitNexus phải là semver exact và giữ chế độ index-only không sinh hướng dẫn agent.');
  }
  for (const sub of GITNEXUS_ALIASES) {
    const name = `graph:${sub}`;
    if (scripts[name] !== `node scripts/run-pinned-gitnexus.mjs ${sub}`) {
      add('invalid-gitnexus-alias', `Alias ${name} thiếu hoặc không đi qua wrapper.`);
    }
  }
  if (trackedFiles.some((file) => GENERATED_GRAPH.test(file))) {
    add('tracked-generated-graph', 'Không track artifact graph hoặc skill GitNexus sinh tự động.');
  }
  if (hasGitNexusProjectMcp(projectMcp)) {
    add('project-graph-integration', 'GitNexus tùy chọn không được đăng ký MCP ở cấp project.');
  }
  if (workflowRuns.some(runHasMandatoryGraphCommand)) {
    add('mandatory-graph-workflow', 'CI không được dựng hoặc bắt buộc graph; chỉ regression wrapper được chạy.');
  }
  return problems;
}

export function workflowRunsFromText(raw) {
  const runs = [];
  const jobs = yaml.load(raw)?.jobs ?? {};
  for (const job of Object.values(jobs)) {
    for (const step of job?.steps ?? []) if (typeof step?.run === 'string') runs.push(step.run);
  }
  return runs;
}

function workflowRuns(read, trackedFiles, problems) {
  const runs = [];
  for (const file of trackedFiles.filter((path) => path.startsWith('.github/workflows/') && /\.ya?ml$/.test(path))) {
    try {
      runs.push(...workflowRunsFromText(read(file)));
    } catch {
      problems.push({ file, id: 'workflow-unreadable', why: 'Không đọc được workflow để kiểm cấu hình graph.' });
    }
  }
  return runs;
}

function main() {
  const problems = [];
  const read = (f) => {
    try { return readFileSync(join(repoRoot, f), 'utf8'); } catch { return null; }
  };

  const contract = read(CONTRACT);
  if (contract === null) {
    console.error(`❌ Thiếu ${CONTRACT} — đây là nguồn luật chung, mọi file rule phải trỏ về nó.`);
    process.exitCode = 1;
    return;
  }
  const scripts = JSON.parse(read('package.json')).scripts;
  const exists = (path) => existsSync(join(repoRoot, path));
  problems.push(...checkGuide(contract, CONTRACT, scripts, exists));

  for (const file of [...AGENT_FILES, ...REFERENCE_GUIDES]) {
    const text = read(file);
    if (text === null) {
      problems.push({ file, id: 'missing-guide', why: 'Thiếu hướng dẫn đã đăng ký.' });
      continue;
    }
    problems.push(...checkGuide(text, file, scripts, exists));
  }

  problems.push(...checkContractInvariants(contract));

  let trackedFiles = [];
  try {
    trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\0').filter(Boolean).map((file) => file.replaceAll('\\', '/'))
      .filter((file) => exists(file));
  } catch {
    problems.push({ file: 'repository', id: 'git-files-unreadable', why: 'Không đọc được danh sách file tracked.' });
  }
  let agentTools = null;
  try { agentTools = JSON.parse(read('tooling/agent-tools.json')); } catch { /* reported by repository contract */ }
  let projectMcp = null;
  if (trackedFiles.includes('.mcp.json')) {
    try { projectMcp = JSON.parse(read('.mcp.json')); } catch {
      problems.push({ file: '.mcp.json', id: 'project-mcp-unreadable', why: 'Không đọc được cấu hình MCP dự án.' });
    }
  }
  problems.push(...checkRepositoryContract({
    scripts,
    trackedFiles,
    existingFiles: new Set(trackedFiles),
    agentTools,
    projectMcp,
    workflowRuns: workflowRuns(read, trackedFiles, problems),
  }));

  if (problems.length > 0) {
    console.error('❌ Hợp đồng agent có vấn đề:\n');
    for (const p of problems) console.error(`  - ${p.file} [${p.id}]\n      ${p.why}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${AGENT_FILES.length} file rule cùng trỏ về ${CONTRACT}; không có chỉ dẫn nguy hiểm tái xuất hiện.`);
}

const CONTRACT_INVARIANTS = [
    ['ts-baseline.json', 'ratchet TypeScript theo fingerprint'],
    ['tsconfig.app.json', 'typecheck THẬT — root `tsc --noEmit` không check gì'],
    ['check-view-invoker', 'gate view security_invoker'],
    ['security_invoker', 'CREATE OR REPLACE VIEW làm rớt cờ này'],
    ['check-stable-fn-locks', 'gate hàm STABLE lấy khoá dòng'],
    ['25006', 'mã lỗi khi hàm STABLE lấy khoá dòng qua PostgREST'],
    ['VOLATILE', 'hàm lấy khoá dòng phải khai VOLATILE'],
    ['reconcile-money', 'đối chiếu tiền'],
    ['cap-1000', 'bug tổng chỉ 1000 dòng đầu'],
    ['CLAUDE.local.md', 'credential vault'],
    ['IHOMECRM_PROMOTION_TOKEN', 'token cho đường bỏ backup; lane mặc định dùng biên nhận backup'],
    ['scripts/run-pinned-gitnexus.mjs', 'wrapper GitNexus được ghim'],
    ['tooling/agent-tools.json', 'nguồn pin GitNexus'],
    ['hide_sandbox_admin', 'policy chặn org TEST lọt vào org thật'],
    ['can_access_building', 'cách lọc toà đúng trong hàm SECURITY DEFINER'],
    ['aaaa0000', 'org THẬT — chỉ đọc khi test'],
    ['dddd0000', 'org DEMO — nơi ghi fixture E2E'],
    ['cccc0000', 'org TEST — bản sao dữ liệu thật'],
    ['clone-org', 'đồng bộ lại org TEST'],
    ['gate:sandbox-leak', 'kiểm rò sandbox; không ghim mẫu số cũ'],
    ['deadlock', 'await supabase.* trong callback auth gây treo im lặng'],
    ['FLEET_PASS', 'mật khẩu E2E không nằm trong repo'],
    ['headless', 'E2E mặc định chạy ẩn'],
    ['runtime-matrix.json', 'nguồn phiên bản runtime'],
    ['KHÔNG replay được', 'legacy history không dựng lại được từ đầu'],
    ['migrations-archive', 'thư mục TUYỆT ĐỐI không replay'],
    ['trùng version', 'lý do legacy không replay được'],
    ['test-matrix.json', 'runner và job đúng của từng test'],
    ['risk-map.json', 'gate và review theo phạm vi thay đổi'],
    ['promote:production', 'đường phát hành kiểm CI trước khi push'],
    ['bo-chu-thich', 'gate quét văn bản phải bỏ chú thích trước'],
    ['deno.lock', 'khoá version npm specifier của edge function'],
    ['gen:types', 'quy trình regen types (không redirect)'],
    ['types:normalize', 'bỏ partition ngày sau khi regen'],
    ['HEAD:main', 'push đúng nhánh, tránh đẩy nhánh main local cũ'],
    ['git add -A', 'điều bị cấm khi stage'],
    ['backup-before-schema', 'PITR tắt nên phải dump trước thao tác schema'],
    ['migration-policy.json', 'cutoff và luật forward-only'],
    ['git worktree', 'mỗi hạng mục song song một worktree riêng — cách ly WIP giữa các phiên'],
    ['tao-ten-migration', 'cấp timestamp migration bằng script, chống hai phiên đụng cùng mốc giờ'],
    ['lấy bản của main rồi chạy lại generator', 'cách giải conflict file máy-sinh khi rebase'],
];

export function checkContractInvariants(contract) {
  const text = visibleMarkdown(contract);
  return CONTRACT_INVARIANTS.flatMap(([needle, what]) => text.includes(needle) ? [] : [{
    file: CONTRACT,
    id: 'contract-lost-invariant',
    why: `Mất phần "${what}" (không còn nhắc \`${needle}\`).`,
  }]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
