#!/usr/bin/env node
/**
 * P0 source inventory only. This snapshot NEVER grants runtime authority.
 * Reuses the Copilot inventory scanner; no browser/React import or DB access.
 * node scripts/generate-hermes-crm-inventory.mjs --write
 * node scripts/generate-hermes-crm-inventory.mjs --check (default)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCAN_ROOTS, collectCopilotSourceFiles } from './check-copilot-forbidden-actions.mjs';
import { docTool, phanLoai, SAN_TOOL } from './check-copilot-tool-inventory.mjs';

export const SNAPSHOT_PATH = 'tooling/hermes-crm-inventory.generated.json';
export const ACTION_PATH = 'src/copilot/plan/actionCatalog.ts';
export const CAPABILITY_PATH = 'src/app/capabilities/registry.ts';
export const FLAGS_PATH = 'src/copilot/featureFlags.ts';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalize = (text) => text.replace(/\r\n/g, '\n');
const sha256 = (text) => createHash('sha256').update(normalize(text)).digest('hex');
const sorted = (rows, key) => rows.sort((a, b) => a[key].localeCompare(b[key], 'en'));
const countBy = (rows, key) => Object.fromEntries([...new Set(rows.map((r) => r[key]))].sort().map((value) => [value, rows.filter((r) => r[key] === value).length]));

/** Preserve positions/newlines and strings while removing comment-only metadata. */
export function withoutComments(text) {
  return text.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
    (whole, literal) => literal ?? whole.replace(/[^\n]/g, ' '));
}

function property(text, key) {
  const match = text.match(new RegExp(`\\b${key}:\\s*(['"])([^'"\\n]*)\\1`));
  return match?.[2] ?? null;
}
function flag(text, key) { return new RegExp(`\\b${key}:\\s*true\\b`).test(text); }
function permission(text, key = 'requiredPermission') {
  const match = text.match(new RegExp(`\\b${key}:\\s*\\{\\s*module:\\s*['"]([^'"]+)['"]\\s*,\\s*action:\\s*['"]([^'"]+)['"]`));
  return match ? `${match[1]}.${match[2]}` : null;
}
function required(value, label) {
  if (value === null || value === undefined || value === '') throw new Error(`Không đo được ${label}; cập nhật bộ đọc trước khi sinh snapshot.`);
  return value;
}
function unique(rows, key, label) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row[key])) throw new Error(`${label} trùng: ${row[key]}`);
    seen.add(row[key]);
  }
}

/** Named declaration slices, matching the bounded scanner used by Copilot. */
function slices(text, key) {
  const matches = [...text.matchAll(new RegExp(`\\b${key}:\\s*(['"])([^'"\\n]+)\\1`, 'g'))];
  return matches.map((match, i) => ({
    id: match[2], index: match.index,
    line: text.slice(0, match.index).split('\n').length,
    text: text.slice(match.index, matches[i + 1]?.index ?? text.length),
  }));
}

export function readActions(text) {
  const clean = withoutComments(normalize(text));
  const declaration = required(clean.indexOf('export const ACTION_CATALOG =') >= 0 ? clean.indexOf('export const ACTION_CATALOG =') : null, 'ACTION_CATALOG');
  const actions = slices(clean.slice(declaration), 'actionId').map((entry) => {
    const version = entry.text.match(/\bversion:\s*(\d+)/)?.[1];
    const retired = flag(entry.text, 'daGo');
    return {
      id: entry.id,
      source: { path: ACTION_PATH, line: entry.line + clean.slice(0, declaration).split('\n').length - 1 },
      version: Number(required(version, `version ${entry.id}`)),
      label: required(property(entry.text, 'labelVi'), `label ${entry.id}`),
      permission: required(permission(entry.text, 'permission'), `permission ${entry.id}`),
      risk: required(property(entry.text, 'risk'), `risk ${entry.id}`),
      consentRequired: required(property(entry.text, 'consentRequired'), `consent ${entry.id}`),
      executorKind: required(property(entry.text, 'executorKind'), `executor ${entry.id}`),
      previewRpc: required(property(entry.text, 'previewRpc'), `previewRpc ${entry.id}`),
      executeRpc: required(property(entry.text, 'executeRpc'), `executeRpc ${entry.id}`),
      retired, pinAlways: flag(entry.text, 'pinAlways'), externalEffect: flag(entry.text, 'externalEffect'),
      disposition: retired ? 'retired' : 'migrate_to_gateway',
      migrationNote: retired ? 'Đã gỡ trong catalog; không mở lại qua Hermes.' : 'Tái sử dụng hợp đồng server sau khi kiểm connector, quyền và xác nhận; chưa cấp cho Hermes.',
    };
  });
  if (!actions.length) throw new Error('Không đo được action catalog; không coi danh sách rỗng là đạt.');
  unique(actions, 'id', 'Action');
  return sorted(actions, 'id');
}

export function readCapabilities(text) {
  const clean = withoutComments(normalize(text));
  const start = clean.indexOf('export const CAPABILITIES:');
  if (start < 0) throw new Error('Không đo được CAPABILITIES.');
  const end = clean.indexOf('export function capabilityById', start);
  if (end < 0) throw new Error('Không đo được ranh giới CAPABILITIES.');
  const section = clean.slice(start, end);
  const capabilities = slices(section, 'id').map((entry) => ({
    id: entry.id,
    source: { path: CAPABILITY_PATH, line: entry.line + clean.slice(0, start).split('\n').length - 1 },
    route: required(property(entry.text, 'primaryRoute'), `route capability ${entry.id}`),
    permission: permission(entry.text, 'permission'),
    superAdminOnly: flag(entry.text, 'superAdminOnly'),
    disposition: 'retain_ui',
    migrationNote: 'Bề mặt UI được giữ; trùng khóa quyền không chứng minh đã có công cụ Hermes.',
  }));
  if (!capabilities.length) throw new Error('Không đo được capability; không coi danh sách rỗng là đạt.');
  unique(capabilities, 'id', 'Capability');
  return sorted(capabilities, 'id');
}

function staticConstants(source) {
  const constants = {};
  for (const match of source.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*=\s*(['"])([^'"\n]+)\2/g)) constants[match[1]] = match[3];
  return constants;
}

function semanticCategory(tool) {
  if (tool.tep.endsWith('/memoryTools.ts')) return 'memory_mutation';
  if (tool.tep.endsWith('/planTools.ts')) return 'plan_orchestration';
  if (phanLoai(tool) === 'navigate') return 'navigation';
  if (tool.tep.endsWith('/writeTools.ts')) return 'write_proposal';
  if (phanLoai(tool) === 'read') return 'read';
  return 'unclassified';
}

function proposedDisposition(category) {
  if (category === 'navigation') return ['retain_ui', 'Giữ điều hướng/deep link ở UI; không tự chuyển quyền điều khiển DOM sang Hermes.'];
  if (category === 'plan_orchestration' || category === 'unclassified') return ['undecided', 'Chưa quyết định adapter; tái dùng nghiệp vụ nhưng không nhân đôi vòng điều phối AI.'];
  if (category === 'memory_mutation') return ['migrate_to_gateway', 'Cần tách memory riêng từng user và memory công việc có quyền CRM; tool hiện có chỉ là own-row, chưa có Hermes tổng.'];
  if (category === 'write_proposal') return ['migrate_to_gateway', 'Tái dùng đề xuất/xem trước; quyền ghi và xác nhận phải kiểm ở server.'];
  return ['migrate_to_gateway', 'Tách browser dependencies và kiểm projection/phạm vi trước khi cấp qua gateway.'];
}

export function buildInventory(sources) {
  const normalized = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, text]) => [path, normalize(text)]));
  for (const path of [ACTION_PATH, CAPABILITY_PATH, FLAGS_PATH]) required(normalized[path], path);
  const scanned = Object.fromEntries(Object.entries(normalized).filter(([path]) => SCAN_ROOTS.some((root) => path.startsWith(`${root.replace(/\\/g, '/')}/`))).map(([path, text]) => [path, withoutComments(text)]));
  const legacy = docTool(scanned);
  if (legacy.length < SAN_TOOL) throw new Error(`Không đo được tools: ${legacy.length}, sàn ${SAN_TOOL}.`);
  unique(legacy, 'ten', 'Tool');
  const actions = readActions(normalized[ACTION_PATH]);
  const capabilities = readCapabilities(normalized[CAPABILITY_PATH]);
  const constants = staticConstants(withoutComments(normalized[FLAGS_PATH]));
  const declarations = Object.entries(scanned).flatMap(([path, text]) => slices(text, 'name').map((entry) => ({ ...entry, path })));
  if (declarations.length !== legacy.length) throw new Error('Hình dạng khai báo tool lệch scanner Copilot; cần cập nhật cả hai bộ đọc.');
  const tools = legacy.map((tool) => {
    const declaration = required(declarations.find((entry) => entry.id === tool.ten && entry.path === tool.tep), tool.ten);
    // Metadata precedes execute. Do not inherit helper metadata after its body.
    const metadata = declaration.text.split(/\bexecute\s*:/, 1)[0];
    const semantic = semanticCategory(tool);
    const [disposition, migrationNote] = proposedDisposition(semantic);
    const directAction = property(metadata, 'actionId') ?? metadata.match(/khoaRolloutHanhDong\(['"]([^'"]+)['"]\)/)?.[1] ?? null;
    if (directAction && !actions.some((action) => action.id === directAction)) throw new Error(`Tool ${tool.ten} trỏ action không có: ${directAction}`);
    const action = actions.find((entry) => entry.id === directAction);
    if (action && action.permission !== tool.quyen) throw new Error(`Quyền tool/action lệch: ${tool.ten} (${tool.quyen} / ${action.permission}).`);
    const rolloutSymbol = metadata.match(/\brolloutKey:\s*([A-Z][A-Z0-9_]*)/)?.[1] ?? null;
    const rolloutKey = property(metadata, 'rolloutKey') ?? (directAction ? `action:${directAction}` : constants[rolloutSymbol] ?? null);
    const sourcePermission = permission(metadata);
    if (sourcePermission !== tool.quyen) throw new Error(`Quyền bị scanner lấy ngoài metadata: ${tool.ten}.`);
    return {
      id: tool.ten, source: { path: tool.tep, line: declaration.line },
      legacyCategory: phanLoai(tool), semanticCategory: semantic,
      permission: tool.quyen,
      permissionEvidence: tool.quyen ? 'literal_metadata_only' : 'unresolved_or_absent_review_required',
      actionId: directAction,
      rollout: { key: rolloutKey, symbol: rolloutSymbol, exempt: flag(metadata, 'rolloutExempt'), resolution: rolloutKey ? 'static' : rolloutSymbol ? 'expression_unresolved' : 'no_literal_key' },
      flags: { chatOnly: tool.chatOnly, navigationOnly: flag(metadata, 'navigationOnly'), uiControlOnly: flag(metadata, 'uiControlOnly'), superAdminOnly: flag(metadata, 'superAdminOnly') },
      relatedCapabilities: capabilities.filter((entry) => entry.permission && entry.permission === tool.quyen).map((entry) => ({ id: entry.id, match: 'same_permission_only' })),
      disposition, migrationNote, hermesExposure: 'not_implemented',
    };
  });
  return {
    schemaVersion: 1,
    purpose: 'P0 inventory chuyển Copilot sang nền công cụ CRM dùng chung cho Hermes; không phải cấu hình quyền.',
    authority: {
      grantsRuntimeAccess: false,
      databaseReadPerformed: false,
      runtimeDispatch: 'not_verified',
      dispositionStatus: 'migration_proposal_only',
      actionAuthority: 'app_private.copilot_action_registry và gate/RLS phía server; snapshot lấy từ TypeScript mirror.',
      capabilityAuthority: 'src/app/capabilities/registry.ts mô tả bề mặt UI; không tự cấp công cụ hay quyền.',
      userPermissionAuthority: 'Quyền user đang có hiệu lực tại CRM; snapshot không chứa quyền của user thật.',
    },
    generator: 'scripts/generate-hermes-crm-inventory.mjs',
    regenerate: 'node scripts/generate-hermes-crm-inventory.mjs --write',
    check: 'node scripts/generate-hermes-crm-inventory.mjs --check',
    sources: Object.entries(normalized).map(([path, text]) => ({ path, sha256: sha256(text) })),
    summary: {
      toolCount: tools.length, toolsByLegacyCategory: countBy(tools, 'legacyCategory'), toolsBySemanticCategory: countBy(tools, 'semanticCategory'),
      actionCount: actions.length, retiredActionCount: actions.filter((entry) => entry.retired).length,
      actionsByRisk: countBy(actions, 'risk'), capabilityCount: capabilities.length,
      toolDispositions: countBy(tools, 'disposition'),
    },
    limitations: [
      'Phân tích khai báo tĩnh, không import registry vào Node và không chứng minh tool được lắp/bật ở runtime.',
      'Không đối chiếu catalog/RLS/rollout trên database đang chạy; không phải bằng chứng production.',
      'Quyền literal chỉ là metadata: cần kiểm server RPC, phạm vi tổ chức/tòa và projection dữ liệu từng tool.',
      'Capability liên quan chỉ so cùng khóa quyền, không phải ánh xạ thực thi hoặc chứng cứ công cụ đã bao phủ UI.',
      'Disposition là đề xuất chuyển đổi P0; không tự bật quyền hoặc thay thế Copilot.',
      'Memory công việc dùng chung có quyền CRM, điều phối Hermes tổng và giao việc chưa có trong các tool memory hiện tại.',
      'Không liệt kê đầy đủ dependency/helper/RPC đọc và mọi điểm gọi trực tiếp DB; phải rà từng lát trước khi mở gateway.',
      'Mọi capability/handler mới vẫn cần kiểm quyền user giao với giới hạn kết nối; snapshot không thay cơ chế đó.',
    ],
    tools: sorted(tools, 'id'), actions, capabilities,
  };
}

export function readInventorySources(root = ROOT) {
  const paths = [...collectCopilotSourceFiles(SCAN_ROOTS.map((path) => join(root, path))).map((path) => relative(root, path).replace(/\\/g, '/')),
    CAPABILITY_PATH, FLAGS_PATH, 'scripts/check-copilot-tool-inventory.mjs', 'scripts/check-copilot-forbidden-actions.mjs', 'scripts/generate-hermes-crm-inventory.mjs'];
  return Object.fromEntries([...new Set(paths)].sort().map((path) => [path, readFileSync(join(root, path), 'utf8')]));
}
export const serializeInventory = (inventory) => `${JSON.stringify(inventory, null, 2)}\n`;
export function assertSnapshotMatches(actual, expected) {
  if (normalize(actual) !== normalize(expected)) throw new Error(`Inventory lệch source; chạy node scripts/generate-hermes-crm-inventory.mjs --write rồi review diff.`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--write', '--check'].includes(arg)) || (args.includes('--write') && args.includes('--check'))) throw new Error('Dùng --write hoặc --check.');
  const inventory = buildInventory(readInventorySources());
  const rendered = serializeInventory(inventory);
  const target = join(ROOT, SNAPSHOT_PATH);
  if (args.includes('--write')) writeFileSync(target, rendered, 'utf8');
  else assertSnapshotMatches(readFileSync(target, 'utf8'), rendered);
  console.log(`Hermes P0 inventory ${args.includes('--write') ? 'generated' : 'matches source'}: ${inventory.summary.toolCount} tools, ${inventory.summary.actionCount} actions, ${inventory.summary.capabilityCount} UI capabilities; runtime authority: none.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
