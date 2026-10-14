#!/usr/bin/env node
/**
 * P0 source inventory only. This snapshot NEVER grants runtime authority.
 * Reuses the Copilot inventory scanner; no browser/React import or DB access.
 * node scripts/generate-hermes-crm-inventory.mjs --write
 * node scripts/generate-hermes-crm-inventory.mjs --check (default)
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCAN_ROOTS, collectCopilotSourceFiles } from './check-copilot-forbidden-actions.mjs';
import { docTool, phanLoai, SAN_TOOL } from './check-copilot-tool-inventory.mjs';
import ts from 'typescript';

export const SNAPSHOT_PATH = 'tooling/hermes-crm-inventory.generated.json';
export const ACTION_PATH = 'src/copilot/plan/actionCatalog.ts';
export const CAPABILITY_PATH = 'src/app/capabilities/registry.ts';
export const FLAGS_PATH = 'src/copilot/featureFlags.ts';
export const UI_SOURCE_PATHS = Object.freeze([
  'src/copilot/createAgent.ts', 'src/copilot/safeControls.ts', 'src/copilot/pageScope.ts',
  'src/copilot/uiControlAvailability.ts', 'src/copilot/safetyGuard.ts', 'src/copilot/pageAgentCompatibility.ts',
  'src/copilot/useHangDoiSauDuyet.ts', 'src/copilot/confirmationStore.ts',
]);
export const RPC_HELPER_PATHS = Object.freeze(['src/copilot/memoryClient.ts']);
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

function proposedDisposition(category, id) {
  if (category === 'navigation') return ['retain_ui', 'Giữ điều hướng/deep link ở UI; không tự chuyển quyền điều khiển DOM sang Hermes.'];
  if (id === 'lap_ke_hoach') return ['migrate_to_gateway', 'P3/P5: Hermes upstream điều phối theo ý định user; connector cung cấp schema/RPC và quyền CRM hiện tại giao Read/Action. Chỉ soạn khi được yêu cầu; không sao chép vòng duyệt hoặc cờ superAdminOnly của engine cũ thành quyền Hermes.'];
  if (id === 'thuc_thi_buoc') return ['retain_backend_executor', 'P5/P8: tái dùng executor/queue và điều kiện nghiệp vụ CRM, thực hiện yêu cầu rõ trong quyền hiệu lực; không gọi engine, giả approve/PIN hoặc sao chép cờ superAdminOnly Copilot. Ngừng wrapper cũ sau khi có luồng thay thế ở P11.'];
  if (category === 'plan_orchestration' || category === 'unclassified') return ['undecided', 'Chưa quyết định adapter; tái dùng nghiệp vụ nhưng không nhân đôi vòng điều phối AI.'];
  if (category === 'memory_mutation') return ['migrate_to_gateway', 'Cần tách memory riêng từng user và memory công việc có quyền CRM; tool hiện có chỉ là own-row, chưa có Hermes tổng.'];
  if (category === 'write_proposal') return ['migrate_to_gateway', 'Tái dùng schema/validation/nghiệp vụ; yêu cầu rõ được thực hiện trong quyền user giao Action Hermes. Giữ phê duyệt nghiệp vụ mà user trực tiếp cũng phải đáp ứng.'];
  return ['migrate_to_gateway', 'Tách browser dependencies và kiểm projection/phạm vi trước khi cấp qua gateway.'];
}

// TypeScript AST reads declarations only; no eval/import of application runtime.
const unwrapped = (node) => {
  while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
  return node;
};
const nodeName = (node) => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
const propNode = (node, name) => node && ts.isObjectLiteralExpression(node) ? node.properties.find((entry) => nodeName(entry.name) === name) : null;
const propValue = (node, name) => {
  const property = propNode(node, name);
  return property && ts.isPropertyAssignment(property) ? property.initializer : property && ts.isShorthandPropertyAssignment(property) ? property.name : null;
};
const literalString = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
function walk(node, visit) { visit(node); ts.forEachChild(node, (child) => walk(child, visit)); }
function location(node) {
  const file = node.getSourceFile();
  return { path: file.fileName, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 };
}
function expressionEvidence(node) {
  return node ? { source: location(node), expression: normalize(node.getText()) } : null;
}
function astSources(sources) {
  return new Map(Object.entries(sources).filter(([path]) => /\.tsx?$/.test(path)).map(([path, text]) => {
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (ast.parseDiagnostics.length) throw new Error(`Không đo được TypeScript AST: ${path}.`);
    return [path, ast];
  }));
}
function namedObjects(ast, property) {
  const objects = [];
  walk(ast, (node) => {
    if (ts.isObjectLiteralExpression(node) && literalString(propValue(node, property))) objects.push(node);
  });
  return objects;
}
function variable(ast, name) {
  let value = null;
  walk(ast, (node) => { if (!value && ts.isVariableDeclaration(node) && nodeName(node.name) === name) value = node.initializer; });
  return value ? unwrapped(value) : null;
}
function declaredArray(ast, name) {
  const value = required(variable(ast, name), `mảng ${name}`);
  if (!ts.isArrayLiteralExpression(value)) throw new Error(`Không đo được mảng literal ${name}.`);
  return value;
}
function stringArray(node, label) {
  node = unwrapped(node);
  if (!node || !ts.isArrayLiteralExpression(node)) throw new Error(`Không đo được mảng literal ${label}.`);
  return node.elements.map((entry) => required(literalString(entry), label));
}
function schemaEvidence(node, ast, allAsts, depth = 0) {
  if (depth > 12) throw new Error('Schema tham chiếu quá sâu hoặc có vòng lặp; cần review thủ công.');
  const root = node;
  const definitions = [];
  const seen = new Set();
  while (node && ts.isIdentifier(node) && !seen.has(node.text)) {
    seen.add(node.text);
    let definition = variable(ast, node.text);
    if (!definition) {
      const candidates = [...allAsts.values()].map((file) => variable(file, node.text)).filter(Boolean);
      if (candidates.length === 1) definition = candidates[0];
    }
    if (!definition) break;
    definitions.push(expressionEvidence(definition));
    node = definition;
    ast = definition.getSourceFile();
  }
  const fields = [];
  let fieldExtraction = 'expression_only_requires_review';
  // Only z.object for the outer input. A union/record is kept as source evidence.
  if (node && ts.isCallExpression(node) && node.expression.getText().endsWith('.object') && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
    fieldExtraction = 'outer_zod_object';
    for (const entry of node.arguments[0].properties) {
      if (!ts.isPropertyAssignment(entry)) continue;
      fields.push({ name: required(nodeName(entry.name), 'schema field'), ...expressionEvidence(entry.initializer) });
    }
  }
  if (node && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'extend' && ts.isIdentifier(node.expression.expression) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
    const base = schemaEvidence(node.expression.expression, ast, allAsts, depth + 1);
    definitions.push(...base.definitions);
    fields.push(...base.fields);
    for (const entry of node.arguments[0].properties) {
      if (!ts.isPropertyAssignment(entry)) continue;
      const name = required(nodeName(entry.name), 'extended schema field');
      const old = fields.findIndex((field) => field.name === name);
      if (old >= 0) fields.splice(old, 1);
      fields.push({ name, ...expressionEvidence(entry.initializer) });
    }
    fieldExtraction = base.fieldExtraction === 'outer_zod_object' ? 'outer_zod_object_with_extend' : 'partial_extend_requires_review';
  }
  return { evidence: 'source_schema_expression', declaration: expressionEvidence(root), definitions, fields, fieldExtraction, runtimeValidated: false };
}
function executorEvidence(node) {
  const calls = [], returns = [];
  if (node) walk(node, (child) => {
    if (ts.isCallExpression(child)) {
      const name = child.expression.getText();
      if (name === 'supabase.rpc' || name === 'sb.rpc') {
        calls.push({ kind: 'rpc', name: literalString(child.arguments[0]), ...expressionEvidence(child) });
      } else if (/chotToChuc|Scope|scope|Organization|organization|Quyen|quyen|canUse/.test(name)) {
        calls.push({ kind: 'scope_or_permission_call_candidate', name, source: location(child) });
      }
    }
    if (ts.isReturnStatement(child) && child.expression) returns.push(expressionEvidence(child.expression));
  });
  return { source: node ? location(node) : null, calls, returnExpressions: returns, coverage: 'direct_body_only_helpers_and_nested_semantics_require_review' };
}
function rpcCallee(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = unwrapped(node.expression);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'rpc' ? callee : null;
}
/** Find first-argument forwarding wrappers by source, including type assertions. */
export function readRpcReferences(asts, scannedPaths) {
  const result = [];
  for (const path of scannedPaths) {
    const ast = required(asts.get(path), path);
    const wrappers = new Map();
    walk(ast, (node) => {
      const fn = ts.isFunctionDeclaration(node) ? node : ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer) ? node.initializer : null;
      const name = fn ? nodeName(node.name) : null;
      const firstParameter = fn?.parameters?.[0]?.name;
      if (!fn?.body || !name || !firstParameter || !ts.isIdentifier(firstParameter)) return;
      walk(fn.body, (call) => {
        if (rpcCallee(call) && call.arguments[0] && ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === firstParameter.text) wrappers.set(name, location(node));
      });
    });
    walk(ast, (node) => {
      if (!ts.isCallExpression(node)) return;
      const direct = rpcCallee(node);
      const expression = unwrapped(node.expression);
      const wrapperName = ts.isIdentifier(expression) && wrappers.has(expression.text) ? expression.text : null;
      if (!direct && !wrapperName) return;
      const name = literalString(node.arguments[0]);
      result.push({ name, source: location(node), expression: (direct?.getText() ?? wrapperName) + '(' + (node.arguments[0]?.getText() ?? '') + ')', role: name ? 'literal_call' : 'dynamic_call', via: wrapperName ? { helper: wrapperName, source: wrappers.get(wrapperName) } : null, staticOnly: true });
    });
  }
  return result;
}
function acceptance(id, permissionKey, kind, extra = []) {
  const requiredCases = [
    `${id}: đúng user/org và phạm vi được cấp trả kết quả đúng nguồn nghiệp vụ.`,
    `${id}: thiếu quyền ${permissionKey ?? 'được nguồn khai báo'} hoặc sai org/phạm vi bị từ chối tại server/guard phù hợp.`,
    `${id}: restriction kết nối tắt hoặc bị thu hồi không được thực hiện dù caller giữ danh sách tool cũ.`,
    `${id}: input sai schema bị từ chối; output/projection không lộ trường ngoài phạm vi.`,
    ...extra,
  ];
  if (kind === 'write' || kind === 'action') requiredCases.push(`${id}: lệnh rõ thực hiện trong quyền user giao Action; yêu cầu chỉ soạn không ghi. Payload/version/grant bị sửa bị chặn; giữ phê duyệt nghiệp vụ thật, idempotency và đối soát kết quả chưa rõ.`);
  return { status: 'proposed_not_run', requiredCases, evidence: [] };
}
function contractForTool(tool, object, ast, asts, action) {
  const schema = propValue(object, 'inputSchema');
  const execute = propValue(object, 'execute');
  const observed = executorEvidence(execute);
  const actionObject = action ? namedObjects(asts.get(ACTION_PATH), 'actionId').find((entry) => literalString(propValue(entry, 'actionId')) === action.id) : null;
  const actionSchema = actionObject ? propValue(actionObject, 'inputSchema') : null;
  const input = schema ? schemaEvidence(schema, ast, asts) : actionSchema ? { ...schemaEvidence(actionSchema, asts.get(ACTION_PATH), asts), inheritedFromAction: action.id } : { evidence: 'missing_requires_review', declaration: null, definitions: [], fields: [], runtimeValidated: false };
  const memory = tool.semanticCategory === 'memory_mutation';
  const plan = tool.semanticCategory === 'plan_orchestration';
  const proposal = tool.semanticCategory === 'write_proposal';
  return {
    scope: {
      evidence: 'source_declarations_not_authority', requiredPermission: tool.permission,
      applicationContext: memory ? ['user', 'organization', 'own_row_memory'] : ['user', 'organization', 'permission_specific_resource_scope'],
      observed: observed.calls, verification: 'server_scope_projection_and_revocation_not_verified',
      note: memory ? 'Memory công việc/Hermes tổng là adapter mới, không suy từ own-row memory hiện có.' : 'Phải kiểm executor/RPC của từng năng lực; metadata quyền không thay RLS.',
    },
    input,
    output: { evidence: 'source_return_expressions', body: observed, format: 'DomainTool Promise<string>; helpers/structured server receipts require adapter contract', runtimeValidated: false },
    consent: {
      evidence: action ? 'action_catalog_declaration' : 'source_category_and_migration_proposal',
      current: action?.consentRequired ?? (memory ? 'explicit_user_memory_request_in_description' : plan ? 'per_action_approval_or_standing_grant' : 'no_write_consent_declared'),
      proposed: proposal || plan ? 'Clear user intent executes through current CRM rights intersected with Hermes Action; preserve domain business approvals, without Copilot engine consent/PIN prerequisites' : memory ? 'Own work memory and explicit sharing through CRM; personal Hermes memory stays independent' : 'Read/navigation still requires current permission and connection restriction',
      legacySuperAdminOnly: tool.flags.superAdminOnly,
    },
    channels: {
      declaredAdapters: [!tool.flags.uiControlOnly && 'copilot_chat', !tool.flags.chatOnly && 'page_agent_domain_adapter'].filter(Boolean),
      proposed: tool.id === 'thuc_thi_buoc' ? ['crm_executor_with_current_user_and_hermes_action'] : tool.disposition === 'retain_ui' ? ['crm_browser_or_deep_link'] : ['hermes_via_crm_gateway'],
      groupProjection: 'not_approved_for_direct_group_output', runtime: 'not_verified',
    },
    phase: plan ? ['P3', 'P5', 'P8', 'P11'] : memory ? ['P1', 'P3', 'P7'] : proposal ? ['P5', 'P8'] : tool.semanticCategory === 'navigation' ? ['P7', 'P8'] : ['P3', 'P8'],
    acceptance: acceptance(tool.id, tool.permission, proposal || plan ? 'write' : 'read', tool.flags.superAdminOnly ? [`${tool.id}: phân biệt cờ superAdminOnly legacy với quyền nghiệp vụ server; chưa map/xác minh thì không mở capability Hermes.`] : []),
    completeness: { declarationMetadata: input.declaration ? 'captured' : 'gap', runtimeDispatch: 'not_verified', parity: 'not_run' },
  };
}

export function readUiControlInventory(sources, tools, asts = astSources(sources)) {
  const ast = required(asts.get(CAPABILITY_PATH), CAPABILITY_PATH);
  const pages = declaredArray(ast, 'COPILOT_PAGE_CONTRACTS').elements.map((call) => {
    if (!ts.isCallExpression(call) || call.expression.getText() !== 'page' || !call.arguments[0] || !ts.isObjectLiteralExpression(call.arguments[0])) throw new Error('Page contract không còn là page({...}); cần cập nhật inventory.');
    const object = call.arguments[0];
    const id = required(literalString(propValue(object, 'key')), 'page key');
    const route = required(literalString(propValue(object, 'route')), `${id} route`);
    const permissionKey = required(permission(object.getText(), 'permission'), `${id} permission`);
    const controls = stringArray(propValue(object, 'safeControlIds'), `${id} safeControlIds`);
    return {
      id, source: location(object), route, canonicalRoute: literalString(propValue(object, 'canonicalRoute')) ?? route,
      mode: required(literalString(propValue(object, 'mode')), `${id} mode`),
      dataClass: required(literalString(propValue(object, 'dataClass')), `${id} dataClass`),
      permission: permissionKey, rolloutKey: literalString(propValue(object, 'rolloutKey')) ?? id,
      safeControlIds: controls, markerFileHint: literalString(propValue(object, 'markerFileHint')),
      declaredUiControlCandidate: controls.length > 0, disposition: 'retain_ui',
      scope: { currentPage: id, userOrganizationPermissionRequired: true, evidence: 'page_contract_and_guard_source_only' },
      input: { route, controls, evidence: 'declaration' },
      output: { kind: 'browser_page_or_filtered_view', projection: 'not_runtime_verified' },
      consent: { declared: 'semantic_controls_do_not_grant_domain_write_consent', submit: 'blocked_by_existing_guard' },
      channels: { current: ['crm_browser_page_agent'], proposed: ['retain_crm_ui_or_deep_link'], runtime: 'not_verified' },
      phase: ['P7', 'P8'], acceptance: acceptance(`page:${id}`, permissionKey, 'read', [`${id}: route/rollout đổi trước DOM dispatch phải dừng; control không khai báo hoặc submit không được tác động.`]),
    };
  });
  unique(pages, 'id', 'Page contract');
  const markers = [], dynamicMarkers = [];
  for (const [path, file] of asts) {
    if (!path.endsWith('.tsx')) continue;
    walk(file, (node) => {
      if (!ts.isJsxAttribute(node) || node.name.getText() !== 'data-ai-safe') return;
      const value = literalString(node.initializer);
      const evidence = { source: location(node), element: node.parent.parent.tagName?.getText() ?? null };
      if (value) markers.push({ id: value, ...evidence });
      else dynamicMarkers.push({ expression: node.initializer?.getText() ?? null, ...evidence });
    });
  }
  const controls = pages.flatMap((page) => page.safeControlIds.map((id) => {
    const scopedId = `${page.id}.${id}`;
    const matched = markers.filter((marker) => marker.id === scopedId || marker.id === id);
    return {
      id: scopedId, controlId: id, pageId: page.id, source: page.source, markers: matched,
      markerCoverage: matched.length ? 'literal_source_markers_found_not_dom_verified' : 'missing_source_marker',
      disposition: 'retain_ui', scope: page.scope,
      input: { control_id: id, text: 'required for safe_input/safe_select; absent for safe_click', allowedOperation: 'determined from live element type, not inferred from control name' },
      output: { kind: 'DOM event and tool acknowledgement; not a business write receipt' },
      consent: page.consent, channels: page.channels, phase: ['P7', 'P8'],
      acceptance: acceptance(scopedId, page.permission, 'read', [`${scopedId}: đúng một phần tử hiện hành, đúng loại; đổi DOM/disconnect/duplicate id và submit phải bị chặn; kiểm desktop/mobile nơi marker tồn tại.`]),
    };
  }));
  unique(controls, 'id', 'Safe control');
  const safeAst = required(asts.get('src/copilot/safeControls.ts'), 'safeControls');
  const semanticTools = [];
  walk(safeAst, (node) => {
    if (!ts.isPropertyAssignment(node) || !/^safe_(click|input|select)$/.test(nodeName(node.name) ?? '')) return;
    const call = node.initializer;
    if (!ts.isCallExpression(call) || call.expression.getText() !== 'make') throw new Error('Safe-control factory shape changed.');
    const id = nodeName(node.name);
    semanticTools.push({
      id, source: location(node), operation: literalString(call.arguments[0]), disposition: 'retain_ui',
      scope: { pageContractAndAllowlistedControl: true, evidence: 'safeControls source' },
      input: schemaEvidence(call.arguments[2], safeAst, asts), output: { kind: 'DOM mutation acknowledgement', source: location(call) },
      consent: { current: 'no_domain_write_authorization', noSubmit: true },
      channels: { current: ['crm_browser_page_agent'], proposed: ['retain_ui_only'], runtime: 'not_verified' },
      phase: ['P8'], acceptance: acceptance(id, 'current page permission', 'read', [`${id}: re-resolve element and run beforeDispatch guard; unknown control, wrong type, duplicate, disconnected node and submit are rejected.`]),
    });
  });
  if (semanticTools.length !== 3) throw new Error(`Không đo đủ semantic tools: ${semanticTools.length}.`);
  const agentAst = required(asts.get('src/copilot/createAgent.ts'), 'createAgent');
  let customTools = null;
  walk(agentAst, (node) => {
    if (ts.isNewExpression(node) && node.expression.getText() === 'PageAgent') customTools = propValue(node.arguments?.[0], 'customTools');
  });
  if (!customTools || !ts.isObjectLiteralExpression(customTools)) throw new Error('Không đo được customTools PageAgent.');
  const overrides = customTools.properties.filter(ts.isPropertyAssignment).map((node) => ({
    id: nodeName(node.name), source: location(node), configuration: node.initializer.kind === ts.SyntaxKind.NullKeyword ? 'disabled_override' : 'non_null_override_requires_review',
    disposition: node.initializer.kind === ts.SyntaxKind.NullKeyword ? 'keep_disabled' : 'undecided',
    input: { evidence: 'library_contract_not_exposed_here' }, output: { evidence: 'not_called_when_disabled' },
    scope: { proposed: 'never bypass CRM gateway with arbitrary browser/code tool' }, consent: { authorization: 'none_granted_by_inventory' },
    channels: { current: ['page_agent_override'], proposed: ['not_exposed_to_hermes'], runtime: 'not_verified' }, phase: ['P8', 'P11'],
    acceptance: acceptance(`override:${nodeName(node.name)}`, null, 'read', ['Source override remains disabled; installed bundle compatibility must be checked separately.']),
  }));
  const excerpts = (path, symbols) => {
    const file = required(asts.get(path), path);
    return symbols.map((symbol) => {
      let found = null;
      walk(file, (node) => { if (!found && (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && nodeName(node.name) === symbol) found = node; });
      return { symbol, source: location(required(found, symbol)) };
    });
  };
  return {
    evidence: 'declared_application_controls_not_installed_library_or_live_DOM',
    pages: sorted(pages, 'id'), controls: sorted(controls, 'id'), semanticTools: sorted(semanticTools, 'id'), overrides: sorted(overrides, 'id'),
    dynamicMarkers, orphanMarkers: markers.filter((marker) => !controls.some((control) => control.markers.includes(marker))),
    domainAdapterCandidates: tools.filter((tool) => !tool.flags.chatOnly).map((tool) => ({ id: tool.id, permission: tool.permission, superAdminOnly: tool.flags.superAdminOnly, runtime: 'subject_to_org_rollout_permission_checks_not_verified' })),
    guardSources: [
      ...excerpts('src/copilot/uiControlAvailability.ts', ['uiControlGuard', 'makeUiControlStepGuard', 'assertUiControlPageContract']),
      ...excerpts('src/copilot/safeControls.ts', ['giaiSafeControl', 'hopLoai', 'assertLive', 'taoCongCuDieuKhienAnToan']),
      ...excerpts('src/copilot/safetyGuard.ts', ['DANGER_RE', 'SUBMIT_RE', 'attachDangerStamping']),
    ],
    limitations: ['Literal JSX markers can render in multiple viewports; no live DOM uniqueness or event effectiveness was tested.', 'Dynamic marker forwarding is recorded, not resolved as runtime proof.', 'PageAgent built-in tools other than explicit overrides require installed-library audit; this is application-surface inventory.'],
  };
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
    const [disposition, migrationNote] = proposedDisposition(semantic, tool.ten);
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
  const asts = astSources(normalized);
  const actionObjects = namedObjects(asts.get(ACTION_PATH), 'actionId');
  for (const tool of tools) {
    const ast = required(asts.get(tool.source.path), tool.source.path);
    const object = required(namedObjects(ast, 'name').find((entry) => literalString(propValue(entry, 'name')) === tool.id), `AST tool ${tool.id}`);
    Object.assign(tool, contractForTool(tool, object, ast, asts, actions.find((entry) => entry.id === tool.actionId)));
  }
  for (const action of actions) {
    const object = required(actionObjects.find((entry) => literalString(propValue(entry, 'actionId')) === action.id), `AST action ${action.id}`);
    Object.assign(action, {
      scope: { permission: action.permission, evidence: 'catalog_permission_only', verification: 'server_RPC_scope_not_verified' },
      input: schemaEvidence(required(propValue(object, 'inputSchema'), `${action.id} inputSchema`), asts.get(ACTION_PATH), asts),
      output: { previewFields: stringArray(propValue(object, 'previewFields'), `${action.id} previewFields`), executionReceipt: 'RPC-specific; runtime shape not verified', externalEffectReconcileRequired: action.externalEffect },
      consent: { evidence: 'legacy_catalog_declaration', required: action.consentRequired, pinAlways: action.pinAlways, neverApproveFromModel: true,
        proposed: 'Current user rights intersected with Hermes Action; preserve genuine domain approvals and never manufacture legacy approval/PIN state' },
      channels: { current: ['CRM_preview_consent_executor'], proposed: action.retired ? [] : ['hermes_intent_through_authorized_CRM_executor'], runtime: 'not_verified' },
      phase: action.retired ? ['P0', 'P11'] : ['P5', 'P8'],
      acceptance: acceptance(`action:${action.id}`, action.permission, 'action', action.retired ? ['Retired action remains unavailable in schema/tool list/executor.'] : action.externalEffect ? ['Provider timeout/crash must retain UNKNOWN_EFFECT until authoritative reconciliation; no blind re-send.'] : []),
      completeness: { declarationMetadata: 'captured', serverScope: 'not_verified', parity: 'not_run' },
    });
  }
  const uiControl = readUiControlInventory(normalized, tools, asts);
  for (const capability of capabilities) Object.assign(capability, {
    scope: { permission: capability.permission, superAdminOnly: capability.superAdminOnly, evidence: 'UI_registry_metadata_only' },
    input: { route: capability.route, evidence: 'route_declaration' },
    output: { kind: 'UI_surface', runtimeRender: 'not_verified' },
    consent: { current: 'each_domain_action_keeps_own_consent', agentRestrictionDoesNotRemoveHumanPermission: true },
    channels: { current: ['crm_browser'], proposed: ['retain_human_UI_or_deep_link'], runtime: 'not_verified' },
    phase: ['P7', 'P8'],
    pageContractIds: uiControl.pages.filter((page) => page.canonicalRoute === capability.route || page.route === capability.route).map((page) => page.id),
    acceptance: { status: 'proposed_not_run', requiredCases: [`${capability.id}: đúng quyền user vẫn mở được ${capability.route}; tắt Hermes không tắt quyền UI của user.`, `${capability.id}: route và controls có trong contract được rà parity; không suy API ghi từ capability metadata.`], evidence: [] },
  });
  const rpcReferences = readRpcReferences(asts, [...Object.keys(scanned), ...RPC_HELPER_PATHS]);
  for (const action of actions) {
    const object = actionObjects.find((entry) => literalString(propValue(entry, 'actionId')) === action.id);
    for (const field of ['previewRpc', 'executeRpc']) {
      const value = propValue(object, field);
      rpcReferences.push({ name: action[field], source: location(value), expression: value.getText(), role: field === 'previewRpc' ? 'catalog_preview' : 'catalog_execute', actionId: action.id, retired: action.retired, staticOnly: true });
    }
  }
  if (!rpcReferences.some((entry) => entry.role === 'literal_call')) throw new Error('Không đo được RPC call references; không coi danh sách rỗng là đạt.');
  rpcReferences.sort((a, b) => a.source.path.localeCompare(b.source.path, 'en') || a.source.line - b.source.line || a.role.localeCompare(b.role, 'en'));
  for (const tool of tools) {
    const ast = asts.get(tool.source.path);
    const object = namedObjects(ast, 'name').find((entry) => literalString(propValue(entry, 'name')) === tool.id);
    const execute = propValue(object, 'execute');
    const start = execute ? location(execute).line : null;
    const end = execute ? ast.getLineAndCharacterOfPosition(execute.end).line + 1 : null;
    tool.rpcReferences = rpcReferences.filter((entry) => entry.source.path === tool.source.path && start !== null && entry.source.line >= start && entry.source.line <= end)
      .map((entry) => ({ name: entry.name, source: entry.source, role: entry.role, via: entry.via }));
  }
  return {
    schemaVersion: 2,
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
      pageContractCount: uiControl.pages.length, uiControlPageCount: uiControl.pages.filter((page) => page.declaredUiControlCandidate).length,
      safeControlCount: uiControl.controls.length, semanticControlToolCount: uiControl.semanticTools.length,
      safeControlMissingMarkerCount: uiControl.controls.filter((entry) => entry.markerCoverage === 'missing_source_marker').length,
      explicitPageAgentOverrideCount: uiControl.overrides.length,
      rpcReferenceCount: rpcReferences.length, literalRpcNameCount: new Set(rpcReferences.filter((entry) => entry.name).map((entry) => entry.name)).size,
      unresolvedRpcCallCount: rpcReferences.filter((entry) => entry.role === 'dynamic_call').length,
      toolInputGapCount: tools.filter((tool) => tool.completeness.declarationMetadata === 'gap').length,
    },
    limitations: [
      'Phân tích khai báo tĩnh, không import registry vào Node và không chứng minh tool được lắp/bật ở runtime.',
      'Không đối chiếu catalog/RLS/rollout trên database đang chạy; không phải bằng chứng production.',
      'Quyền literal chỉ là metadata: cần kiểm server RPC, phạm vi tổ chức/tòa và projection dữ liệu từng tool.',
      'Capability liên quan chỉ so cùng khóa quyền, không phải ánh xạ thực thi hoặc chứng cứ công cụ đã bao phủ UI.',
      'Disposition là đề xuất chuyển đổi P0; không tự bật quyền hoặc thay thế Copilot.',
      'Memory công việc dùng chung có quyền CRM, điều phối Hermes tổng và giao việc chưa có trong các tool memory hiện tại.',
      'Không liệt kê đầy đủ dependency/helper/RPC đọc và mọi điểm gọi trực tiếp DB; phải rà từng lát trước khi mở gateway.',
      'Input/output/consent/channel/scope là metadata source hoặc đề xuất được gắn nhãn; acceptance chưa chạy không phải đạt.',
      'RPC references gồm literal calls trong tools/plan và action mapping; dynamic calls còn chưa resolve, không chứng minh dispatch hoặc ACL live.',
      'PageAgent inventory bao phủ app contracts, literal markers, semantic controls và explicit overrides; chưa kiểm toàn bộ builtin của thư viện hoặc DOM live.',
      'Mọi capability/handler mới vẫn cần kiểm quyền user giao với giới hạn kết nối; snapshot không thay cơ chế đó.',
    ],
    tools: sorted(tools, 'id'), actions, capabilities, uiControl, rpcReferences,
  };
}

export function readInventorySources(root = ROOT) {
  const markerPaths = [];
  const scanMarkers = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '__tests__') scanMarkers(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.tsx') && !/\.(test|spec)\./.test(entry.name) && readFileSync(fullPath, 'utf8').includes('data-ai-safe')) markerPaths.push(relative(root, fullPath).replace(/\\/g, '/'));
    }
  };
  scanMarkers(join(root, 'src'));
  const paths = [...collectCopilotSourceFiles(SCAN_ROOTS.map((path) => join(root, path))).map((path) => relative(root, path).replace(/\\/g, '/')),
    CAPABILITY_PATH, FLAGS_PATH, ...UI_SOURCE_PATHS, ...RPC_HELPER_PATHS, ...markerPaths, 'scripts/check-copilot-tool-inventory.mjs', 'scripts/check-copilot-forbidden-actions.mjs', 'scripts/generate-hermes-crm-inventory.mjs'];
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
