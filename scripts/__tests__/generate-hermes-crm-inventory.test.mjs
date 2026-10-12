import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTION_PATH, CAPABILITY_PATH, assertSnapshotMatches, buildInventory,
  readInventorySources, serializeInventory, withoutComments,
} from '../generate-hermes-crm-inventory.mjs';
import { docTool, phanLoai } from '../check-copilot-tool-inventory.mjs';

const sources = readInventorySources();
const inventory = buildInventory(sources);
const toolPath = 'src/copilot/tools/registry.ts';
const replaceSource = (path, before, after) => {
  assert.ok(sources[path].includes(before), `Mutation anchor thiếu: ${before}`);
  return { ...sources, [path]: sources[path].replace(before, after) };
};

test('reuses existing scanner/counts and keeps the snapshot non-authoritative', () => {
  const existing = docTool(Object.fromEntries(Object.entries(sources).filter(([path]) => path.startsWith('src/copilot/tools/') || path.startsWith('src/copilot/plan/')).map(([path, text]) => [path, withoutComments(text)])));
  assert.equal(inventory.summary.toolCount, existing.length);
  assert.deepEqual(inventory.tools.map((tool) => [tool.id, tool.legacyCategory, tool.permission]), existing.map((tool) => [tool.ten, phanLoai(tool), tool.quyen]));
  assert.equal(inventory.authority.grantsRuntimeAccess, false);
  assert.equal(inventory.authority.databaseReadPerformed, false);
  assert.ok(inventory.tools.every((tool) => tool.hermesExposure === 'not_implemented'));
});

test('separates proposal, orchestration and own-row memory from read/navigation', () => {
  const get = (id) => inventory.tools.find((tool) => tool.id === id);
  assert.equal(get('phong_trong').semanticCategory, 'read');
  assert.equal(get('mo_trang').disposition, 'retain_ui');
  assert.equal(get('ghi_nho').semanticCategory, 'memory_mutation');
  assert.match(get('ghi_nho').migrationNote, /chưa có Hermes tổng/);
  assert.equal(get('lap_ke_hoach').disposition, 'migrate_to_gateway');
  assert.equal(get('thuc_thi_buoc').disposition, 'retain_backend_executor');
  assert.equal(get('thuc_thi_buoc').flags.superAdminOnly, true);
  assert.equal(get('tao_phieu_thu_chi_nhap').actionId, 'income_expense.create_draft');
  assert.equal(get('tao_phieu_thu_chi_nhap').semanticCategory, 'write_proposal');
});

test('catalog captures retired actions, sensitive approval and external effects', () => {
  const get = (id) => inventory.actions.find((action) => action.id === id);
  assert.equal(get('termination.hoan_coc').disposition, 'retired');
  assert.equal(get('role.upsert').pinAlways, true);
  assert.equal(get('zalo.broadcast').externalEffect, true);
  assert.equal(get('zalo.broadcast').consentRequired, 'step_up');
  assert.equal(get('zalo.broadcast').permission, 'chat_zalo.send');
  assert.equal(get('invoice.duyet').externalEffect, false);
});

test('capability relationships are only source evidence, never a grant', () => {
  const room = inventory.tools.find((tool) => tool.id === 'phong_trong');
  assert.deepEqual(room.relatedCapabilities, [{ id: 'rooms', match: 'same_permission_only' }]);
  const knowledge = inventory.tools.find((tool) => tool.id === 'huong_dan');
  assert.equal(knowledge.permission, null);
  assert.equal(knowledge.permissionEvidence, 'unresolved_or_absent_review_required');
  assert.ok(inventory.capabilities.every((capability) => capability.disposition === 'retain_ui'));
});

test('deterministic regeneration ignores input order and checkout line endings', () => {
  const reordered = Object.fromEntries(Object.entries(sources).reverse().map(([path, text]) => [path, text.replace(/\r?\n/g, '\r\n')]));
  assert.equal(serializeInventory(buildInventory(reordered)), serializeInventory(inventory));
  assertSnapshotMatches(serializeInventory(inventory).replace(/\n/g, '\r\n'), serializeInventory(inventory));
});

test('MUTATION: missing catalog cannot silently become an empty report', () => {
  assert.throws(() => buildInventory({ ...sources, [ACTION_PATH]: '' }), /Không đo được/);
  assert.throws(() => buildInventory({ ...sources, [CAPABILITY_PATH]: 'export const CAPABILITIES = [];'}), /Không đo được/);
});

test('MUTATION: action permission drift from a tool fails generation', () => {
  const changed = replaceSource(ACTION_PATH, "permission: { module: 'income_expenses', action: 'create' }", "permission: { module: 'income_expenses', action: 'edit' }");
  assert.throws(() => buildInventory(changed), /Quyền tool\/action lệch/);
});

test('MUTATION: duplicate tool names fail instead of shrinking the inventory', () => {
  const changed = replaceSource(toolPath, "name: 'danh_sach_cong_to'", "name: 'danh_sach_khu_vuc'");
  assert.throws(() => buildInventory(changed), /Tool trùng/);
});

test('MUTATION: declaration syntax outside the reused scanner is rejected', () => {
  const changed = replaceSource(toolPath, "name: 'phong_trong'", 'name: "phong_trong"');
  assert.throws(() => buildInventory(changed), /Hình dạng khai báo tool lệch/);
});

test('MUTATION: removing all tools fails the measured-count floor', () => {
  const changed = Object.fromEntries(Object.entries(sources).map(([path, text]) => [path, path.startsWith('src/copilot/tools/') ? '' : text]));
  assert.throws(() => buildInventory(changed), /Không đo được tools/);
});

test('MUTATION: stale snapshot fails when a source permission changes', () => {
  const changed = replaceSource(toolPath, "requiredPermission: { module: 'rooms', action: 'view' }", "requiredPermission: { module: 'rooms', action: 'edit' }");
  const expected = serializeInventory(buildInventory(changed));
  assert.throws(() => assertSnapshotMatches(serializeInventory(inventory), expected), /Inventory lệch source/);
});

test('MUTATION: comment-only fake metadata does not add tools or permissions', () => {
  const comment = "\n// name: 'fake_tool', requiredPermission: { module: 'secret', action: 'view' }\n";
  const changed = buildInventory({ ...sources, [toolPath]: sources[toolPath] + comment });
  assert.deepEqual(changed.tools, inventory.tools);
  assert.notDeepEqual(changed.sources, inventory.sources, 'source digest still records comment changes');
  const preserved = 'const url = "https://example.test/path"; // comment';
  assert.ok(withoutComments(preserved).includes('"https://example.test/path"'));
});

test('MUTATION: newly discovered write tool requires a migration decision', () => {
  const changed = buildInventory({ ...sources, 'src/copilot/tools/extraAgentTool.ts': "const extra = { name: 'extra_agent_tool', chatOnly: true, requiredPermission: { module: 'rooms', action: 'edit' }, execute: () => null };" });
  const tool = changed.tools.find((entry) => entry.id === 'extra_agent_tool');
  assert.equal(tool.disposition, 'undecided');
  assert.equal(tool.semanticCategory, 'unclassified');
  assert.equal(tool.hermesExposure, 'not_implemented');
});

test('MUTATION: missing required action RPC fails closed', () => {
  const changed = replaceSource(ACTION_PATH, "previewRpc: 'copilot_preview_income_expense_v1'", "previewRpc: PREVIEW_FROM_DYNAMIC_SOURCE");
  assert.throws(() => buildInventory(changed), /Không đo được previewRpc/);
});

test('unresolved rollout expressions remain explicit instead of guessed', () => {
  const tool = inventory.tools.find((entry) => entry.id === 'lap_ke_hoach');
  assert.equal(tool.rollout.key, null);
  assert.equal(tool.rollout.symbol, 'KHOA_ROLLOUT_KE_HOACH');
  assert.equal(tool.rollout.resolution, 'expression_unresolved');
});

test('every capability has §07 metadata without claiming runtime acceptance', () => {
  const rows = [...inventory.tools, ...inventory.actions, ...inventory.capabilities, ...inventory.uiControl.pages, ...inventory.uiControl.controls, ...inventory.uiControl.semanticTools, ...inventory.uiControl.overrides];
  for (const row of rows) {
    for (const key of ['scope', 'input', 'output', 'consent', 'channels', 'disposition', 'acceptance', 'phase']) assert.ok(row[key], `${row.id}: thiếu ${key}`);
    assert.equal(row.acceptance.status, 'proposed_not_run', row.id);
    assert.ok(row.acceptance.requiredCases.length > 0, row.id);
    assert.deepEqual(row.acceptance.evidence, [], row.id);
  }
  assert.equal(inventory.authority.runtimeDispatch, 'not_verified');
  assert.equal(inventory.summary.toolInputGapCount, 0);
});

test('records declared PageAgent pages, safe controls, markers and disabled overrides', () => {
  const ui = inventory.uiControl;
  assert.ok(ui.pages.length > ui.controls.length);
  assert.deepEqual(ui.pages.filter((page) => page.declaredUiControlCandidate).map((page) => page.id), ['customers.list', 'invoices.list', 'rooms.list']);
  assert.deepEqual(ui.semanticTools.map((tool) => tool.id), ['safe_click', 'safe_input', 'safe_select']);
  assert.ok(ui.controls.every((control) => control.markers.length > 0));
  assert.ok(ui.overrides.every((entry) => entry.configuration === 'disabled_override'));
  assert.ok(ui.overrides.some((entry) => entry.id === 'execute_javascript'));
  assert.equal(ui.orphanMarkers.length, 0);
  assert.ok(ui.dynamicMarkers.some((entry) => entry.source.path === 'src/components/ui/searchable-select.tsx'));
  assert.equal(ui.domainAdapterCandidates.length, inventory.tools.filter((tool) => !tool.flags.chatOnly).length);
});

test('captures tool input fields and action preview fields from AST without running Zod', () => {
  const room = inventory.tools.find((tool) => tool.id === 'phong_trong');
  assert.deepEqual(room.input.fields.map((field) => field.name), ['toa_nha']);
  assert.equal(room.input.runtimeValidated, false);
  const proposal = inventory.tools.find((tool) => tool.id === 'ghi_chi_so_cong_to');
  assert.equal(proposal.input.inheritedFromAction, 'meter_reading.create');
  assert.ok(proposal.input.fields.length > 0);
  const extended = inventory.tools.find((tool) => tool.id === 'bao_cao_khuyen_mai');
  assert.equal(extended.input.fieldExtraction, 'outer_zod_object_with_extend');
  assert.ok(extended.input.fields.some((field) => field.name === 'toa_nha_id'));
  assert.ok(inventory.actions.find((action) => action.id === 'zalo.broadcast').output.previewFields.length > 0);
});

test('keeps plan superadmin constraints and distinct proposal/internal execution channels', () => {
  const proposal = inventory.tools.find((tool) => tool.id === 'lap_ke_hoach');
  const executor = inventory.tools.find((tool) => tool.id === 'thuc_thi_buoc');
  for (const tool of [proposal, executor]) {
    assert.equal(tool.flags.superAdminOnly, true);
    assert.equal(tool.consent.superAdminOnlyPreserved, true);
    assert.ok(tool.acceptance.requiredCases.some((text) => text.includes('superAdminOnly')));
  }
  assert.deepEqual(proposal.channels.proposed, ['hermes_via_crm_gateway']);
  assert.deepEqual(executor.channels.proposed, ['crm_internal_executor_after_consent']);
  assert.ok(executor.phase.includes('P11'));
});

test('RPC evidence covers typed wrappers, helpers and catalog while keeping unresolved calls explicit', () => {
  assert.ok(inventory.rpcReferences.length > inventory.actions.length * 2);
  assert.ok(inventory.rpcReferences.some((entry) => entry.role === 'literal_call' && entry.via?.helper === 'goiRpcCopilot'));
  assert.ok(inventory.rpcReferences.some((entry) => entry.source.path === 'src/copilot/memoryClient.ts' && entry.name));
  assert.ok(inventory.rpcReferences.some((entry) => entry.role === 'dynamic_call' && entry.expression === 'goiRpcHanhDong(entry.executeRpc)'));
  assert.ok(inventory.rpcReferences.every((entry) => entry.staticOnly));
  assert.ok(inventory.tools.find((entry) => entry.id === 'danh_sach_khu_vuc').rpcReferences.some((entry) => entry.via?.helper === 'callCopilotRpc'));
});

test('every generated source location names a loaded file and a real nonempty line', () => {
  const refs = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.source?.path && value.source?.line) refs.push(value.source);
    for (const child of Object.values(value)) visit(child);
  };
  visit(inventory);
  assert.ok(refs.length > inventory.tools.length + inventory.actions.length + inventory.uiControl.pages.length);
  for (const ref of refs) {
    assert.ok(sources[ref.path], `source not loaded: ${ref.path}`);
    const lines = sources[ref.path].replace(/\r\n/g, '\n').split('\n');
    assert.ok(Number.isInteger(ref.line) && ref.line >= 1 && ref.line <= lines.length, `${ref.path}:${ref.line}`);
    assert.ok(lines[ref.line - 1].trim(), `${ref.path}:${ref.line} empty`);
  }
});

test('MUTATION: changing input schema updates evidence and rejects old snapshot', () => {
  const changed = replaceSource(toolPath, "toa_nha: z.string().optional().describe('Lọc theo tên toà (khớp gần đúng), bỏ trống = tất cả')", "toa_nha: z.string().min(1)");
  const next = buildInventory(changed);
  assert.notDeepEqual(next.tools.find((entry) => entry.id === 'phong_trong').input, inventory.tools.find((entry) => entry.id === 'phong_trong').input);
  assert.throws(() => assertSnapshotMatches(serializeInventory(inventory), serializeInventory(next)), /Inventory lệch/);
});

test('MUTATION: missing safe marker remains a visible gap instead of a coverage pass', () => {
  const marker = 'data-ai-safe="rooms.list.room.status-filter"';
  const changed = replaceSource('src/components/rooms/RoomListFilters.tsx', marker, 'data-ai-safe="rooms.list.unknown-filter"');
  const next = buildInventory(changed);
  assert.equal(next.summary.safeControlMissingMarkerCount, 1);
  assert.ok(next.uiControl.orphanMarkers.some((entry) => entry.id === 'rooms.list.unknown-filter'));
});

test('MUTATION: duplicate declared controls are rejected', () => {
  const changed = replaceSource(CAPABILITY_PATH, 'safeControlIds: ["room.search", "room.status-filter"]', 'safeControlIds: ["room.search", "room.search"]');
  assert.throws(() => buildInventory(changed), /Safe control trùng/);
});

test('MUTATION: non-null arbitrary-code override is highlighted for review', () => {
  const changed = replaceSource('src/copilot/createAgent.ts', 'execute_javascript: null', 'execute_javascript: unsafeTool');
  const next = buildInventory(changed);
  const override = next.uiControl.overrides.find((entry) => entry.id === 'execute_javascript');
  assert.equal(override.configuration, 'non_null_override_requires_review');
  assert.equal(override.disposition, 'undecided');
});

test('MUTATION: RPC name added through an existing typed helper is captured with provenance', () => {
  const changed = { ...sources, [toolPath]: sources[toolPath] + "\nconst newRpcEvidence = () => callCopilotRpc('inventory_fixture_read_v1', {});\n" };
  const next = buildInventory(changed);
  const rpc = next.rpcReferences.find((entry) => entry.name === 'inventory_fixture_read_v1');
  assert.equal(rpc.role, 'literal_call');
  assert.equal(rpc.via.helper, 'callCopilotRpc');
  assert.equal(rpc.source.path, toolPath);
});

test('MUTATION: comments resembling RPC calls do not inflate evidence', () => {
  const changed = { ...sources, [toolPath]: sources[toolPath] + "\n// callCopilotRpc('fake_rpc_v1', {});\n" };
  assert.deepEqual(buildInventory(changed).rpcReferences, inventory.rpcReferences);
});

test('MUTATION: malformed TS cannot be reported as measured source', () => {
  const changed = { ...sources, 'src/copilot/safeControls.ts': sources['src/copilot/safeControls.ts'] + '\nconst invalid = {' };
  assert.throws(() => buildInventory(changed), /Không đo được TypeScript AST/);
});
